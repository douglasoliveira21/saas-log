import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';
import { Mailer } from '../src/notify/mailer';
import { NotificationWorker } from '../src/notify/notifications';
import { waNumber } from '../src/notify/whatsapp';
import { localToday } from '../src/sales/cutoff';
import { MockEvolution } from './fixtures/mock-evolution';

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);
const DAY = 86_400_000;
const dayFromToday = (n: number) => new Date(new Date(`${localToday()}T00:00:00.000Z`).getTime() + n * DAY);

describe('Avisos por e-mail e WhatsApp (Evolution API): vencimento, pedido e cobrança', () => {
  let app: INestApplication; let admin: PrismaClient;
  const evo = new MockEvolution();
  const agent = () => request.agent(app.getHttpServer());
  type Agent = ReturnType<typeof agent>;
  let owner: Agent; let seller: Agent; let tenantId: string; let wh: string; let product: string;
  let custA: string; let custB: string; let custC: string;
  const mailTo = (to: string) => Mailer.outbox.filter((m) => m.to === to);
  const rule = (type: string, body: object) => owner.put(`/api/notifications/rules/${type}`).set(H).send(body);
  const runNow = async () => (await owner.post('/api/notifications/run').set(H).expect(200)).body;
  const logs = async (q = '') => (await owner.get(`/api/notifications/logs${q}`).expect(200)).body;

  async function newCustomer(name: string, email: string | null, phone: string | null) {
    return (await owner.post('/api/customers').set(H).send({ kind: 'PJ', name, document: cnpj(), ...(email ? { email } : {}), ...(phone ? { phone } : {}), zipCode: '20000-000', street: 'Rua B', number: '2', district: 'Centro', city: 'Rio de Janeiro', state: 'RJ' }).expect(201)).body.id as string;
  }
  async function newOrder(customerId: string) {
    const o = (await owner.post('/api/sales/orders').set(H).send({ customerId, warehouseId: wh, items: [{ productId: product, quantity: 1, unitPrice: 50 }] }).expect(201)).body.id as string;
    await owner.post(`/api/sales/orders/${o}/submit`).set(H).expect(200);
    return o;
  }
  const advance = (o: string, to: string) => owner.post(`/api/sales/orders/${o}/advance`).set(H).send({ to }).expect(200);
  async function title(customerId: string, dueOffset: number, amount: number, status = 'OPEN') {
    return admin.financialTitle.create({ data: { tenantId, direction: 'RECEIVABLE', counterpartyKind: 'CUSTOMER', customerId, description: 'Venda teste', dueDate: dayFromToday(dueOffset), amount, status } });
  }

  beforeAll(async () => {
    await evo.start();
    Object.assign(process.env, { EVOLUTION_API_URL: evo.base, EVOLUTION_API_KEY: evo.apikey });
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication(); configureApp(app); await app.listen(0);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    owner = agent();
    const r = await owner.post('/api/auth/register').set(H).send({ companyName: `Distribuidora Aviso ${run}`, name: 'Dono', email: `nt-${run}@teste.local`, password: PASSWORD }).expect(201);
    tenantId = r.body.tenantId;
    const company = await owner.post('/api/companies').set(H).send({ legalName: 'NT LTDA', tradeName: 'NT', taxRegime: 'SIMPLES_NACIONAL' }).expect(201);
    const est = await owner.post('/api/establishments').set(H).send({ companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz', cnpj: cnpj(), zipCode: '30110-000', city: 'Belo Horizonte', state: 'MG', street: 'Rua A', number: '1', district: 'Centro' }).expect(201);
    wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
    product = (await owner.post('/api/products').set(H).send({ sku: `NT-${run}`, name: 'Parafuso', costPrice: 10, suggestedPrice: 50 }).expect(201)).body.id;
    await owner.post('/api/stock/movements').set(H).send({ productId: product, warehouseId: wh, type: 'PURCHASE_ENTRY', quantity: 500 }).expect(201);
    const roles = Object.fromEntries((await owner.get('/api/roles').expect(200)).body.map((x: any) => [x.key, x.id]));
    const email = `vend-${run}@teste.local`;
    await owner.post('/api/users').set(H).send({ name: 'Vend', email, password: PASSWORD, roleId: roles.salesperson }).expect(201);
    seller = agent(); await seller.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200);
    custA = await newCustomer('Cliente A', `a-${run}@cliente.local`, '(11) 98888-7777');
    custB = await newCustomer('Cliente B', null, '11977776666');
    custC = await newCustomer('Cliente C', `c-${run}@cliente.local`, '11966665555');
  }, 60_000);
  afterAll(async () => { delete process.env.EVOLUTION_API_URL; delete process.env.EVOLUTION_API_KEY; await admin.$disconnect(); await app.close(); await evo.stop(); });
  beforeEach(() => { Mailer.outbox.length = 0; Mailer.failNext = null; evo.sent.length = 0; evo.failSend = null; });

  it('tudo começa desligado, só quem tem permissão configura e variáveis desconhecidas são recusadas', async () => {
    const r = (await owner.get('/api/notifications/rules').expect(200)).body;
    expect(r.rules.map((x: any) => [x.type, x.emailEnabled, x.whatsappEnabled])).toEqual([['INVOICE_DUE', false, false], ['ORDER_STATUS', false, false], ['COLLECTION', false, false]]);
    expect(r.rules[0].variables).toContain('vencimento');
    await seller.get('/api/notifications/rules').expect(403);
    await seller.put('/api/notifications/rules/ORDER_STATUS').set(H).send({ emailEnabled: true }).expect(403);
    await rule('ORDER_STATUS', { body: 'Olá {cliente}, {inexistente}' }).expect(400);
    await rule('NADA', { emailEnabled: true }).expect(404);
    await rule('COLLECTION', { repeatEveryDays: 0 }).expect(400);
    const o = await newOrder(custA);
    expect((await logs()).items).toHaveLength(0); // desligado: nada na fila
    await advance(o, 'PICKING');
  });

  it('status do pedido por e-mail: só os status escolhidos, texto com as variáveis, sem duplicar; cliente sem e-mail e cliente que saiu não recebem', async () => {
    await rule('ORDER_STATUS', { emailEnabled: true, orderStatuses: ['CONFIRMED', 'SHIPPED'], subject: 'Pedido {pedido} {status}' }).expect(200);
    const o = await newOrder(custA);
    for (const to of ['PICKING', 'PACKED', 'SHIPPED']) await advance(o, to);
    const l = (await logs()).items.filter((x: any) => x.recipient === `a-${run}@cliente.local`);
    expect(l.map((x: any) => x.status).sort()).toEqual(['QUEUED', 'QUEUED']); // CONFIRMED + SHIPPED (PICKING/PACKED não)
    const res = await runNow();
    expect(res.sent).toBe(2);
    expect(mailTo(`a-${run}@cliente.local`).map((m) => m.subject).sort()).toEqual([expect.stringMatching(/^Pedido #\d+ confirmado$/), expect.stringMatching(/^Pedido #\d+ enviado$/)]);
    const sent = mailTo(`a-${run}@cliente.local`);
    expect(sent).toHaveLength(2);
    expect(sent[0].text).toContain('Olá, Cliente A!');
    expect(sent[0].text).toContain(`Distribuidora Aviso ${run}`);
    await runNow(); expect(mailTo(`a-${run}@cliente.local`)).toHaveLength(2); // nada a mais
    // cliente sem e-mail: com só o canal e-mail ligado, nada na fila
    const ob = await newOrder(custB);
    expect((await logs()).items.some((x: any) => x.type === 'ORDER_STATUS' && x.recipient.includes('11977776666'))).toBe(false);
    void ob;
    // cliente que pediu para sair
    await seller.put(`/api/notifications/customers/${custC}/opt-out`).set(H).send({ optOut: true }).expect(200);
    await owner.put(`/api/notifications/customers/${custC}/opt-out`).set(H).send({ optOut: true }).expect(200);
    await newOrder(custC);
    expect((await logs()).items.some((x: any) => x.recipient === `c-${run}@cliente.local`)).toBe(false);
    await owner.put(`/api/notifications/customers/${custC}/opt-out`).set(H).send({ optOut: false }).expect(200);
  });

  it('WhatsApp pela Evolution: QR code, conectado só depois de ler, envio com 55, desconectar', async () => {
    const s0 = (await owner.get('/api/notifications/whatsapp').expect(200)).body;
    expect(s0).toMatchObject({ configured: true, status: 'DISCONNECTED' });
    const c = (await owner.post('/api/notifications/whatsapp/connect').set(H).expect(200)).body;
    expect(c.status).toBe('CONNECTING');
    expect(c.qr).toMatch(/^data:image\/png;base64,/);
    expect(evo.instances.has(`dh-${tenantId}`)).toBe(true);
    expect((await owner.get('/api/notifications/whatsapp').expect(200)).body.status).toBe('CONNECTING'); // ainda não leu
    // gerar o QR de novo na mesma instância não falha ("já existe")
    expect((await owner.post('/api/notifications/whatsapp/connect').set(H).expect(200)).body.qr).toMatch(/^data:/);
    evo.instances.get(`dh-${tenantId}`)!.state = 'open'; // o celular leu o QR
    const s1 = (await owner.get('/api/notifications/whatsapp').expect(200)).body;
    expect(s1).toMatchObject({ status: 'CONNECTED', phone: '5511999990000' });
    await owner.post('/api/notifications/whatsapp/connect').set(H).expect(409);
    await seller.get('/api/notifications/whatsapp').expect(403);

    await rule('ORDER_STATUS', { emailEnabled: false, whatsappEnabled: true, orderStatuses: ['CONFIRMED'], body: 'Pedido {pedido} da {empresa} está {status}, {cliente}.' }).expect(200);
    await newOrder(custB); // só telefone
    const res = await runNow();
    expect(res.sent).toBe(1);
    expect(evo.sent).toEqual([{ instance: `dh-${tenantId}`, number: '5511977776666', text: expect.stringMatching(/^Pedido #\d+ da Distribuidora Aviso .* está confirmado, Cliente B\.$/) }]);
    expect(waNumber('(11) 98888-7777')).toBe('5511988887777');
    expect(waNumber('5511988887777')).toBe('5511988887777');
    expect(waNumber('123')).toBeNull();

    // falha temporária do servidor: tenta de novo e fica registrada
    await newOrder(custB);
    evo.failSend = 500;
    const f1 = await runNow(); expect(f1.failed).toBe(1);
    const q = (await logs('?status=QUEUED')).items;
    expect(q).toHaveLength(1); expect(q[0].error).toContain('500'); expect(q[0].attempts).toBe(1);
    evo.failSend = null;
    expect((await runNow()).sent).toBe(1);

    await owner.post('/api/notifications/whatsapp/disconnect').set(H).expect(200);
    expect((await owner.get('/api/notifications/whatsapp').expect(200)).body.status).toBe('DISCONNECTED');
    // sem WhatsApp conectado o aviso falha com o motivo claro (não finge que enviou)
    await newOrder(custB);
    const f2 = await runNow(); expect(f2.failed).toBe(1);
    const failed = (await logs('?status=FAILED')).items;
    expect(failed.some((x: any) => /não está conectado/.test(x.error))).toBe(true);
  });

  it('lembrete de vencimento: títulos a vencer em N dias, agrupados por cliente, sem duplicar, ignorando pagos e quem saiu', async () => {
    await rule('INVOICE_DUE', { emailEnabled: true, whatsappEnabled: false, daysBefore: 2 }).expect(200);
    await title(custA, 2, 120.5); await title(custA, 2, 30);
    await title(custA, 3, 999); // outro dia
    await title(custA, 2, 77, 'PAID');
    const tc = await title(custC, 2, 10);
    await owner.put(`/api/notifications/customers/${custC}/opt-out`).set(H).send({ optOut: true }).expect(200);
    const r1 = await runNow();
    expect(r1.generated).toBe(1);
    const m = mailTo(`a-${run}@cliente.local`).filter((x) => /vencimento/i.test(x.subject));
    expect(m).toHaveLength(1);
    expect(m[0].text).toContain('2 títulos');
    expect(m[0].text).toMatch(/R\$\s?150,50/);
    expect(mailTo(`c-${run}@cliente.local`)).toHaveLength(0);
    Mailer.outbox.length = 0;
    expect((await runNow()).generated).toBe(0); // mesmo dia: não repete
    expect(Mailer.outbox).toHaveLength(0);
    void tc;
    await owner.put(`/api/notifications/customers/${custC}/opt-out`).set(H).send({ optOut: false }).expect(200);
  });

  it('cobrança: títulos vencidos agrupados, repete só a cada N dias e para quando paga', async () => {
    await rule('COLLECTION', { emailEnabled: true, minOverdueDays: 3, repeatEveryDays: 7 }).expect(200);
    const t1 = await title(custB, -10, 200); // B só tem telefone e o canal ligado é o e-mail → ninguém a avisar
    await admin.customer.update({ where: { id: custB }, data: { email: `b-${run}@cliente.local` } });
    await title(custB, -5, 50); await title(custB, -1, 400); // este ainda não passou de 3 dias
    await runNow(); // (o cliente C voltou a receber e entra no lembrete de vencimento: aqui só importa a cobrança)
    expect((await logs('?type=COLLECTION')).items.map((x: any) => x.recipient)).toEqual([`b-${run}@cliente.local`]);
    const mails = mailTo(`b-${run}@cliente.local`).filter((x) => /Pendência/.test(x.subject));
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toContain('2 título(s) vencido(s)');
    expect(mails[0].text).toMatch(/R\$\s?250,00/);
    expect(mails[0].text).not.toMatch(/ameaça|protesto|SPC|Serasa/i);
    Mailer.outbox.length = 0;
    Mailer.outbox.length = 0; await runNow();
    expect(Mailer.outbox).toHaveLength(0);
    // uma semana depois cobra de novo, e paga não cobra
    await admin.financialTitle.update({ where: { id: t1.id }, data: { paidPrincipal: 200, status: 'PAID' } });
    const svc = app.get(require('../src/notify/notifications').NotificationsService);
    const later = new Date(Date.now() + 8 * DAY);
    const scan = await svc.scanTenant(tenantId, later);
    expect(scan.collection).toBeGreaterThanOrEqual(1); // outros clientes também ficaram em atraso depois de 8 dias
    await svc.dispatchTenant(tenantId);
    expect(mailTo(`b-${run}@cliente.local`).filter((x) => /Pendência/.test(x.subject))).toHaveLength(1);
    expect(mailTo(`b-${run}@cliente.local`)[0].text).toMatch(/R\$\s?650,00/); // 450 dos títulos de teste + 4 pedidos de R$ 50; o título pago (200) saiu da conta
  });

  it('falha de e-mail repete até 3 vezes e depois fica como FALHOU com o motivo; teste de canal e janela de horário', async () => {
    await rule('ORDER_STATUS', { emailEnabled: true, whatsappEnabled: false, orderStatuses: ['CONFIRMED'] }).expect(200);
    const before = (await logs()).counts.FAILED ?? 0;
    await newOrder(custA);
    for (let i = 0; i < 3; i++) { Mailer.failNext = 'servidor de e-mail fora do ar'; await runNow(); }
    const after = await logs();
    expect(after.counts.FAILED).toBe(before + 1);
    const f = after.items.find((x: any) => x.status === 'FAILED' && /fora do ar/.test(x.error));
    expect(f.attempts).toBe(3);
    await owner.post('/api/notifications/test').set(H).send({ channel: 'EMAIL', to: `dono-${run}@teste.local` }).expect(200);
    expect(mailTo(`dono-${run}@teste.local`)[0].text).toContain('Teste de aviso');
    await owner.post('/api/notifications/test').set(H).send({ channel: 'WHATSAPP', to: '11999998888' }).expect(400); // desconectado
    expect(NotificationWorker.inWindow(new Date('2026-10-23T15:00:00Z'))).toBe(true); // 12h em Brasília
    expect(NotificationWorker.inWindow(new Date('2026-10-23T02:00:00Z'))).toBe(false); // 23h
    expect(NotificationWorker.inWindow(new Date('2026-10-23T10:30:00Z'))).toBe(false); // 7h30
  });

  it('QR code com tempo de validade e vigia da sessão: reconecta sozinho, conta tentativas e avisa o dono quando só um QR novo resolve', async () => {
    process.env.WA_RECHECK_MS = '5';
    const wa = app.get(require('../src/notify/whatsapp').WhatsappService);
    const name = `dh-${tenantId}`;
    await owner.post('/api/notifications/whatsapp/disconnect').set(H).expect(200);
    expect(await wa.keepAlive(tenantId)).toBe('SKIPPED'); // desconectou de propósito: o vigia não interfere
    const c = (await owner.post('/api/notifications/whatsapp/connect').set(H).expect(200)).body;
    expect(c.expiresInSeconds).toBe(45);
    expect(new Date(c.issuedAt).getTime()).toBeLessThanOrEqual(Date.now());
    evo.instances.get(name)!.state = 'open'; // celular leu o QR
    const s1 = (await owner.get('/api/notifications/whatsapp').expect(200)).body;
    expect(s1).toMatchObject({ status: 'CONNECTED', wantConnected: true, reconnectAttempts: 0 });
    expect(await wa.keepAlive(tenantId)).toBe('OK');

    // a sessão cai (queda de rede/reinício do servidor), mas as credenciais continuam salvas: reconecta sozinho, sem QR
    evo.instances.get(name)!.state = 'close';
    expect(await wa.keepAlive(tenantId)).toBe('RECONNECTED');
    expect((await owner.get('/api/notifications/whatsapp').expect(200)).body).toMatchObject({ status: 'CONNECTED', reconnectAttempts: 0 });
    expect(evo.calls.filter((x) => x.startsWith('PUT /instance/restart')).length).toBeGreaterThanOrEqual(1);

    // servidor de WhatsApp fora do ar não gasta tentativas da sessão
    const realBase = process.env.EVOLUTION_API_URL; process.env.EVOLUTION_API_URL = 'http://127.0.0.1:1';
    expect(await wa.keepAlive(tenantId)).toBe('UNREACHABLE');
    process.env.EVOLUTION_API_URL = realBase;
    expect((await admin.whatsappConnection.findUniqueOrThrow({ where: { tenantId } })).reconnectAttempts).toBe(0);

    // aparelho desconectado no celular: reiniciar não adianta; após 5 tentativas considera perdida e avisa o proprietário
    evo.restartRecovers = false; evo.instances.get(name)!.state = 'close'; Mailer.outbox.length = 0;
    for (let i = 1; i <= 5; i++) expect(await wa.keepAlive(tenantId)).toBe('RETRYING');
    expect((await owner.get('/api/notifications/whatsapp').expect(200)).body.reconnectAttempts).toBe(5);
    expect(await wa.keepAlive(tenantId)).toBe('LOST');
    const lost = await admin.whatsappConnection.findUniqueOrThrow({ where: { tenantId } });
    expect(lost).toMatchObject({ status: 'DISCONNECTED', wantConnected: false });
    expect(lost.lastError).toContain('QR code');
    expect(mailTo(`nt-${run}@teste.local`).filter((m) => /WhatsApp desconectado/.test(m.subject))).toHaveLength(1);
    expect(await wa.keepAlive(tenantId)).toBe('SKIPPED'); // não insiste nem reenvia o aviso
    expect(mailTo(`nt-${run}@teste.local`).filter((m) => /WhatsApp desconectado/.test(m.subject))).toHaveLength(1);
    evo.restartRecovers = true;
    delete process.env.WA_RECHECK_MS;
  });

  it('isola por empresa: outra empresa não vê o histórico nem a conexão', async () => {
    const other = agent();
    await other.post('/api/auth/register').set(H).send({ companyName: `Outra ${run}`, name: 'Outro', email: `ot-${run}@teste.local`, password: PASSWORD }).expect(201);
    expect((await other.get('/api/notifications/logs').expect(200)).body.items).toEqual([]);
    expect((await other.get('/api/notifications/whatsapp').expect(200)).body.status).toBe('DISCONNECTED');
    const rules = (await other.get('/api/notifications/rules').expect(200)).body.rules;
    expect(rules.every((x: any) => !x.emailEnabled && !x.whatsappEnabled)).toBe(true);
  });
});

function cnpj(): string {
  const base = Array.from({ length: 12 }, () => Math.floor(Math.random() * 10));
  const dv = (n: number[]) => { const w = n.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const s = n.reduce((a, x, i) => a + x * w[i], 0) % 11; return s < 2 ? 0 : 11 - s; };
  const d1 = dv(base); return [...base, d1, dv([...base, d1])].join('');
}
