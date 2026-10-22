import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);
let seq = 0;
const uid = () => `${run}${++seq}`;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe('Inadimplência de clientes: configuração, bloqueio de vendas e liberação', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  const agent = () => request.agent(app.getHttpServer());
  type Agent = ReturnType<typeof agent>;
  interface T { owner: Agent; tenantId: string; wh: string; account: string; users: Record<string, Agent> }

  async function setup(label: string): Promise<T> {
    const owner = agent();
    const reg = await owner.post('/api/auth/register').set(H).send({ companyName: `Co ${label} ${run}`, name: `Dono ${label}`, email: `${label}-${run}@teste.local`, password: PASSWORD }).expect(201);
    const company = await owner.post('/api/companies').set(H).send({ legalName: `${label} LTDA` }).expect(201);
    const est = await owner.post('/api/establishments').set(H).send({ companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz' }).expect(201);
    const wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
    const roles = Object.fromEntries((await owner.get('/api/roles').expect(200)).body.map((r: any) => [r.key, r.id]));
    const account = (await owner.post('/api/finance/accounts').set(H).send({ name: 'Banco', kind: 'BANK', openingBalance: 0, openingDate: day(-90) }).expect(201)).body.id;
    const users: Record<string, Agent> = {};
    for (const k of ['salesperson', 'finance']) {
      const email = `${k}-${uid()}@teste.local`;
      await owner.post('/api/users').set(H).send({ name: `U ${k}`, email, password: PASSWORD, roleId: roles[k] }).expect(201);
      const a = agent();
      await a.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200);
      users[k] = a;
    }
    return { owner, tenantId: reg.body.tenantId, wh, account, users };
  }

  const customer = async (t: T, name = 'Cliente') => (await t.owner.post('/api/customers').set(H).send({ kind: 'PF', name: `${name} ${uid()}` }).expect(201)).body.id as string;
  const product = async (t: T) => {
    const id = (await t.owner.post('/api/products').set(H).send({ sku: `DL-${uid()}`, name: 'Produto', suggestedPrice: 100, costPrice: 40 }).expect(201)).body.id as string;
    await t.owner.post('/api/stock/movements').set(H).send({ productId: id, warehouseId: t.wh, type: 'PURCHASE_ENTRY', quantity: 100 }).expect(201);
    return id;
  };
  const receivable = async (t: T, customerId: string, daysLate: number, amount = 100) =>
    (await t.owner.post('/api/finance/titles').set(H).send({ direction: 'RECEIVABLE', customerId, description: 'Venda a prazo', amount, dueDate: day(-daysLate) }).expect(201)).body.ids[0] as string;
  const draft = (t: T, customerId: string, productId: string) =>
    t.owner.post('/api/sales/orders').set(H).send({ customerId, warehouseId: t.wh, items: [{ productId, quantity: 1, unitPrice: 100 }] });
  const config = (t: T, blockAfterDays: number, who: Agent = t.owner) => who.put('/api/finance/delinquency/config').set(H).send({ blockAfterDays });
  const row = async (t: T, customerId: string) => ((await t.owner.get('/api/finance/delinquency').expect(200)).body.items as any[]).find((i) => i.customerId === customerId);

  let A: T;
  let B: T;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    await admin.plan.update({ where: { code: 'trial' }, data: { limits: { users: 100, establishments: 20, warehouses: 20 } } });
    A = await setup('dlA');
    B = await setup('dlB');
  });
  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  it('vem desligado: cliente com atraso grande ainda pode comprar', async () => {
    const c = await customer(A); const p = await product(A);
    await receivable(A, c, 200);
    const s = (await A.owner.get('/api/finance/delinquency').expect(200)).body;
    expect(s.blockAfterDays).toBe(0);
    expect((await row(A, c)).state).toBe('ATTENTION');
    await draft(A, c, p).expect(201);
  });

  it('valida a configuração e exige permissão para alterá-la', async () => {
    await config(A, -1).expect(400);
    await config(A, 366).expect(400);
    await config(A, 1.5).expect(400);
    await config(A, 10, A.users.salesperson).expect(403);
    await config(A, 10, A.users.finance).expect(200); // financeiro gerencia
    const s = (await A.users.finance.get('/api/finance/delinquency').expect(200)).body;
    expect(s.blockAfterDays).toBe(10);
    await A.users.salesperson.get('/api/finance/delinquency').expect(403);
  });

  it('abaixo do prazo é só atenção; no prazo ou além bloqueia criar, editar e enviar pedidos', async () => {
    await config(A, 10).expect(200);
    const c = await customer(A); const p = await product(A);
    const t = await receivable(A, c, 9);
    expect((await row(A, c)).state).toBe('ATTENTION');
    const okOrder = (await draft(A, c, p).expect(201)).body.id;

    await admin.financialTitle.update({ where: { id: t }, data: { dueDate: new Date(`${day(-10)}T00:00:00Z`) } });
    const r = await row(A, c);
    expect(r).toMatchObject({ state: 'BLOCKED', maxDaysOverdue: 10, titles: 1, overdueAmount: '100.00' });
    const denied = await draft(A, c, p).expect(422);
    expect(denied.body.message).toMatch(/bloqueado por inadimplência/);
    expect(denied.body.message).toMatch(/100\.00/);
    await A.owner.put(`/api/sales/orders/${okOrder}`).set(H).send({ customerId: c, warehouseId: A.wh, items: [{ productId: p, quantity: 2, unitPrice: 100 }] }).expect(422);
    await A.owner.post(`/api/sales/orders/${okOrder}/submit`).set(H).expect(422); // rascunho criado antes do bloqueio também não segue
    // outro cliente em dia não é afetado
    await draft(A, await customer(A), p).expect(201);
  });

  it('pagamento (inclusive parcial) reduz o valor em atraso e o pagamento total remove o bloqueio', async () => {
    const c = await customer(A); const p = await product(A);
    const t1 = await receivable(A, c, 30, 100);
    await receivable(A, c, 3, 50);
    expect((await row(A, c)).state).toBe('BLOCKED');
    await A.owner.post(`/api/finance/titles/${t1}/settle`).set(H).send({ accountId: A.account, amount: 40 }).expect(200);
    expect(await row(A, c)).toMatchObject({ state: 'BLOCKED', overdueAmount: '110.00', titles: 2 });
    await A.owner.post(`/api/finance/titles/${t1}/settle`).set(H).send({ accountId: A.account, amount: 60 }).expect(200);
    const after = await row(A, c);
    expect(after).toMatchObject({ state: 'ATTENTION', titles: 1, overdueAmount: '50.00', maxDaysOverdue: 3 });
    await draft(A, c, p).expect(201);
  });

  it('título cancelado e título a pagar não contam como atraso do cliente', async () => {
    const c = await customer(A); const p = await product(A);
    const t = await receivable(A, c, 60);
    await A.owner.post(`/api/finance/titles/${t}/cancel`).set(H).send({ reason: 'Erro de lançamento' }).expect(200);
    await A.owner.post('/api/finance/titles').set(H).send({ direction: 'PAYABLE', customerId: c, description: 'Estorno', amount: 10, dueDate: day(-90) }).expect(201);
    expect(await row(A, c)).toBeUndefined();
    await draft(A, c, p).expect(201);
  });

  it('liberação manual por prazo (com motivo e permissão), depois expira ou é revogada', async () => {
    const c = await customer(A); const p = await product(A);
    await receivable(A, c, 45);
    await draft(A, c, p).expect(422);
    await A.owner.post(`/api/finance/delinquency/customers/${c}/release`).set(H).send({ days: 7 }).expect(400); // motivo obrigatório
    await A.owner.post(`/api/finance/delinquency/customers/${c}/release`).set(H).send({ days: 0, reason: 'x' }).expect(400);
    await A.users.salesperson.post(`/api/finance/delinquency/customers/${c}/release`).set(H).send({ days: 7, reason: 'vendedor tentando' }).expect(403);
    await B.owner.post(`/api/finance/delinquency/customers/${c}/release`).set(H).send({ days: 7, reason: 'outra empresa' }).expect(404);

    await A.owner.post(`/api/finance/delinquency/customers/${c}/release`).set(H).send({ days: 7, reason: 'Pagamento prometido para sexta' }).expect(201);
    const r = await row(A, c);
    expect(r).toMatchObject({ state: 'RELEASED', releaseReason: 'Pagamento prometido para sexta' });
    expect(new Date(r.releasedUntil).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    await draft(A, c, p).expect(201);

    await A.owner.post(`/api/finance/delinquency/customers/${c}/revoke-release`).set(H).expect(201);
    expect((await row(A, c)).state).toBe('BLOCKED');
    await draft(A, c, p).expect(422);

    // liberação vencida volta a bloquear
    await A.owner.post(`/api/finance/delinquency/customers/${c}/release`).set(H).send({ days: 1, reason: 'curta' }).expect(201);
    await admin.customer.update({ where: { id: c }, data: { blockReleasedUntil: new Date(Date.now() - 1000) } });
    expect((await row(A, c)).state).toBe('BLOCKED');
    // a liberação fica registrada na auditoria
    const audits = await admin.auditLog.count({ where: { tenantId: A.tenantId, action: 'finance.delinquency_released', entityId: c } });
    expect(audits).toBe(2);
  });

  it('desligar (0) libera todos e a lista é isolada por empresa', async () => {
    const c = await customer(A); const p = await product(A);
    await receivable(A, c, 400);
    await draft(A, c, p).expect(422);
    await config(A, 0).expect(200);
    await draft(A, c, p).expect(201);
    expect((await row(A, c)).state).toBe('ATTENTION');
    expect((await B.owner.get('/api/finance/delinquency').expect(200)).body.items).toEqual([]);
    await config(A, 10).expect(200);
  });

  it('resumo traz totais de clientes, bloqueados, liberados e valor em atraso', async () => {
    const s = (await A.owner.get('/api/finance/delinquency').expect(200)).body;
    expect(s.totals.customers).toBe(s.items.length);
    expect(s.totals.blocked).toBe(s.items.filter((i: any) => i.state === 'BLOCKED').length);
    expect(Number(s.totals.overdueAmount)).toBeCloseTo(s.items.reduce((n: number, i: any) => n + Number(i.overdueAmount), 0), 2);
    const days = s.items.map((i: any) => i.maxDaysOverdue);
    expect(days).toEqual([...days].sort((a: number, b: number) => b - a)); // mais atrasados primeiro
  });
});
