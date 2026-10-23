import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as forge from 'node-forge';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';
import { resetCaCache } from '../src/fiscal/sefaz/soap';
import { MockSefaz, startMockIbge } from './fixtures/mock-sefaz';

/**
 * ATENÇÃO: o servidor de teste IMITA a forma dos serviços do MDF-e (SOAP 1.2 + TLS mútuo) mas NÃO é a SEFAZ/SVRS. Valida o XML contra o XSD e a assinatura;
 * as respostas são as do simulador. Prova o NOSSO código, não que a SVRS real autorize o manifesto. Nenhuma comunicação real foi feita.
 */
const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);
let seq = 0;
const uid = () => `${run}${++seq}`;
const EST_CNPJ = '45723174000110';
const CPF = '52998224725';

function makePfx(cn: string, password = 'p'): string {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey; cert.serialNumber = '0' + Math.floor(Math.random() * 1e9).toString(16);
  cert.validity.notBefore = new Date(Date.now() - 86_400_000); cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
  const attrs = [{ name: 'commonName', value: cn }, { name: 'countryName', value: 'BR' }];
  cert.setSubject(attrs); cert.setIssuer(attrs); cert.sign(keys.privateKey, forge.md.sha256.create());
  return Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' })).getBytes(), 'binary').toString('base64');
}
function cnpj(): string {
  const base = Array.from({ length: 12 }, () => Math.floor(Math.random() * 10));
  const dv = (n: number[]) => { const w = n.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const s = n.reduce((a, x, i) => a + x * w[i], 0) % 11; return s < 2 ? 0 : 11 - s; };
  const d1 = dv(base); return [...base, d1, dv([...base, d1])].join('');
}
const day = () => new Date().toISOString().slice(0, 10);

describe('MDF-e rodoviário (carga própria) com servidor de teste', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  const sefaz = new MockSefaz();
  let ibge: Awaited<ReturnType<typeof startMockIbge>>;
  const agent = () => request.agent(app.getHttpServer());
  type Agent = ReturnType<typeof agent>;
  let owner: Agent; let fiscal: Agent; let accountant: Agent; let wh: string; let est: string;
  let driverId: string; let vehicleId: string;

  async function newOrder(withNfe = true): Promise<string> {
    const customerId = (await owner.post('/api/customers').set(H).send({ kind: 'PJ', name: 'Cliente PJ', document: cnpj(), zipCode: '20000-000', street: 'Rua B', number: '2', district: 'Centro', city: 'Rio de Janeiro', state: 'RJ', email: 'c@teste.com' }).expect(201)).body.id;
    const p = (await owner.post('/api/products').set(H).send({ sku: `MD-${uid()}`, name: 'Parafuso M8', costPrice: 10, suggestedPrice: 50, ncm: '73181500', taxOrigin: 0, grossWeightG: 500 }).expect(201)).body.id as string;
    await owner.post('/api/stock/movements').set(H).send({ productId: p, warehouseId: wh, type: 'PURCHASE_ENTRY', quantity: 500 }).expect(201);
    const o = (await owner.post('/api/sales/orders').set(H).send({ customerId, warehouseId: wh, fiscalDocType: 'NFE', shipping: 10, items: [{ productId: p, quantity: 3, unitPrice: 33.33 }] }).expect(201)).body.id as string;
    await owner.post(`/api/sales/orders/${o}/submit`).set(H).expect(200);
    if (withNfe) {
      const d = (await fiscal.post('/api/fiscal/outgoing/prepare').set(H).send({ salesOrderId: o, paymentMethod: 'PIX' }).expect(200)).body;
      await fiscal.post(`/api/fiscal/outgoing/${d.id}/transmit`).set(H).expect(200);
    }
    for (const to of ['PICKING', 'PACKED']) await owner.post(`/api/sales/orders/${o}/advance`).set(H).send({ to }).expect(200);
    return o;
  }
  let plateN = 0;
  /** Cada viagem usa um veículo novo (o mesmo veículo não faz duas viagens no mesmo dia). `vid` reaproveita o veículo incompleto do primeiro teste. */
  const newRoute = async (orderIds: string[], vid?: string) => {
    const r = (await owner.post('/api/delivery/routes').set(H).send({ routeDate: day(), driverId, orderIds }).expect(201)).body;
    const v = vid ?? (await owner.post('/api/fleet/vehicles').set(H).send({ plate: `TST${1 + (plateN % 9)}${'ABCDEFGHJ'[Math.floor(plateN / 9) % 9]}${String(++plateN % 100).padStart(2, '0')}`, description: 'Caminhão baú', kind: 'TRUCK', capacityKg: 3000, tareKg: 4200, plateUf: 'MG', renavam: '12345678901', bodyCode: '02' }).expect(201)).body.id;
    await owner.put(`/api/fleet/routes/${r.id}/vehicle`).set(H).send({ vehicleId: v }).expect(200);
    return r.id as string;
  };
  const prepare = (routeId: string) => fiscal.post('/api/fiscal/mdfe/prepare').set(H).send({ routeId });
  const act = (id: string, a: string, body: object = {}) => fiscal.post(`/api/fiscal/mdfe/${id}/${a}`).set(H).send(body);
  const mdfeCalls = (op: string) => sefaz.calls.filter((c) => c.path.includes(op));

  beforeAll(async () => {
    await sefaz.start();
    ibge = await startMockIbge();
    Object.assign(process.env, { FISCAL_SEFAZ_URL_OVERRIDE: JSON.stringify({ base: sefaz.base }), FISCAL_SEFAZ_CA_FILE: sefaz.caFile, IBGE_API_BASE: ibge.base, FISCAL_SEFAZ_POLL_ATTEMPTS: '2', FISCAL_SEFAZ_POLL_DELAY_MS: '5' });
    resetCaCache();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    await admin.plan.update({ where: { code: 'trial' }, data: { limits: { users: 100, establishments: 20, warehouses: 20 } } });

    owner = agent();
    await owner.post('/api/auth/register').set(H).send({ companyName: `Co md ${run}`, name: 'Dono', email: `md-${run}@teste.local`, password: PASSWORD }).expect(201);
    const company = await owner.post('/api/companies').set(H).send({ legalName: 'MD LTDA', tradeName: 'MD', taxRegime: 'SIMPLES_NACIONAL' }).expect(201);
    est = (await owner.post('/api/establishments').set(H).send({ companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz', cnpj: EST_CNPJ, stateRegistration: '0623079040081', cnae: '4744-0/99', zipCode: '30110-000', city: 'Belo Horizonte', state: 'MG', street: 'Rua A', number: '1', district: 'Centro' }).expect(201)).body.id;
    wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
    const roles = Object.fromEntries((await owner.get('/api/roles').expect(200)).body.map((r: any) => [r.key, r.id]));
    const user = async (k: string) => { const email = `${k}-${uid()}@teste.local`; await owner.post('/api/users').set(H).send({ name: `U ${k}`, email, password: PASSWORD, roleId: roles[k] }).expect(201); const a = agent(); await a.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200); return a; };
    fiscal = await user('fiscal'); accountant = await user('accountant');
    for (const dest of ['RJ']) {
      const c = (await fiscal.post('/api/fiscal/rules').set(H).send({ rule: { name: `Venda MG→${dest} ${uid()}`, operation: 'SALE', originUf: 'MG', destUf: dest }, version: { validFrom: '2026-01-01T00:00:00Z', sourceReference: 'Parecer contábil 12/2026 – simulado', config: { cfop: '6102', taxes: { ICMS: { csosn: '102', ratePct: 0 }, PIS: { cst: '49', ratePct: 0 }, COFINS: { cst: '49', ratePct: 0 } } } } }).expect(201)).body;
      await fiscal.post(`/api/fiscal/rules/versions/${c.versionId}/submit`).set(H).expect(200);
      await accountant.post(`/api/fiscal/rules/versions/${c.versionId}/approve`).set(H).expect(200);
    }
    await fiscal.post(`/api/fiscal/establishments/${est}/certificate`).set(H).send({ pfxBase64: makePfx(`EMPRESA TESTE:${EST_CNPJ}`), password: 'p' }).expect(201);
    await fiscal.put(`/api/fiscal/establishments/${est}/provider`).set(H).send({ provider: 'SEFAZ_DIRECT' }).expect(200);
    driverId = (await owner.post('/api/delivery/drivers').set(H).send({ name: 'José Motorista', email: `drv-${uid()}@teste.local`, password: PASSWORD }).expect(201)).body.id;
    vehicleId = (await owner.post('/api/fleet/vehicles').set(H).send({ plate: 'ABC1D23', description: 'Caminhão baú', kind: 'TRUCK', capacityKg: 3000 }).expect(201)).body.id;
  }, 90_000);
  afterAll(async () => {
    for (const k of ['FISCAL_SEFAZ_URL_OVERRIDE', 'FISCAL_SEFAZ_CA_FILE', 'IBGE_API_BASE', 'FISCAL_SEFAZ_POLL_ATTEMPTS', 'FISCAL_SEFAZ_POLL_DELAY_MS']) delete process.env[k];
    resetCaCache();
    await admin.$disconnect();
    await app.close();
    await sefaz.stop();
    ibge.server.close();
  });
  beforeEach(() => { sefaz.mode = 'authorize'; sefaz.calls.length = 0; });

  it('aponta o que falta (tara, UF, RENAVAM opcional, CPF do motorista) e recusa dados inválidos', async () => {
    const o = await newOrder();
    const route = await newRoute([o], vehicleId);
    const p = (await prepare(route).expect(200)).body;
    expect(p.ready).toBe(false);
    expect(p.issues.map((i: any) => i.code)).toEqual(expect.arrayContaining(['VEHICLE_TARE', 'VEHICLE_UF', 'DRIVER_CPF']));
    await owner.put(`/api/fleet/vehicles/${vehicleId}`).set(H).send({ tareKg: 0 }).expect(400);
    await owner.put(`/api/fleet/vehicles/${vehicleId}`).set(H).send({ plateUf: 'M' }).expect(400);
    await owner.put(`/api/delivery/drivers/${driverId}`).set(H).send({ cpf: '11111111111' }).expect(400);
    await owner.put(`/api/fleet/vehicles/${vehicleId}`).set(H).send({ tareKg: 4200, plateUf: 'mg', renavam: '12345678901', bodyCode: '02' }).expect(200);
    await owner.put(`/api/delivery/drivers/${driverId}`).set(H).send({ cpf: CPF }).expect(200);
    const again = (await prepare(route).expect(200)).body;
    expect(again.id).toBe(p.id); // refaz o mesmo rascunho
    expect([again.ready, again.issues.filter((i: any) => i.severity === 'BLOCKING')]).toEqual([true, []]);
    await fiscal.post('/api/fiscal/mdfe/prepare').set(H).send({ routeId: 'x' }).expect(400);
    await accountant.post('/api/fiscal/mdfe/prepare').set(H).send({ routeId: route }).expect(403); // contador só consulta
  });

  it('pedido sem NF-e autorizada bloqueia o manifesto', async () => {
    const o = await newOrder(false);
    const route = await newRoute([o]);
    const p = (await prepare(route).expect(200)).body;
    expect(p.ready).toBe(false);
    expect(p.issues.map((i: any) => i.code)).toEqual(expect.arrayContaining(['NFE_MISSING', 'NO_NFE']));
  });

  it('transmite pelo serviço síncrono: XML no leiaute, assinado, com as NF-e da viagem; autoriza só com o protocolo e guarda o mdfeProc', async () => {
    const o = await newOrder();
    const route = await newRoute([o]);
    const p = (await prepare(route).expect(200)).body;
    expect(p.ready).toBe(true);
    sefaz.calls.length = 0;
    const r = (await act(p.id, 'transmit').expect(200)).body;
    expect(r.status).toBe('AUTHORIZED');
    const calls = mdfeCalls('MDFeRecepcaoSinc');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ xmlValid: true, sigValid: true, clientCn: expect.stringContaining('EMPRESA TESTE') });
    expect(calls[0].body).toContain('<tpEmit>2</tpEmit>');
    expect(calls[0].body).toMatch(/<placa>TST\d[A-Z]\d{2}<\/placa>/);
    expect(calls[0].body).toContain(`<CPF>${CPF}</CPF>`);
    expect(calls[0].body).toContain('<tara>4200</tara>');
    expect(calls[0].body).toContain('<qCarga>1.5000</qCarga>');
    expect(calls[0].body).toMatch(/<chNFe>\d{44}<\/chNFe>/);
    const d = (await fiscal.get(`/api/fiscal/mdfe/${p.id}`).expect(200)).body;
    expect(d).toMatchObject({ status: 'AUTHORIZED', series: 1, hasXml: true });
    expect(d.accessKey).toMatch(/^\d{44}$/);
    expect(d.accessKey.slice(20, 22)).toBe('58');
    const xml = (await fiscal.get(`/api/fiscal/mdfe/${p.id}/xml`).expect(200)).body.xml as string;
    expect(xml).toMatch(/^<mdfeProc[\s\S]*<MDFe[\s\S]*<protMDFe[\s\S]*<\/mdfeProc>$/);
    await act(p.id, 'transmit').expect(409); // já autorizado
    await prepare(route).expect(409); // viagem já tem MDF-e
    expect((await fiscal.get('/api/fiscal/mdfe').expect(200)).body.find((x: any) => x.id === p.id)).toMatchObject({ status: 'AUTHORIZED', routeNumber: expect.any(Number) });
    expect((await fiscal.get('/api/fiscal/mdfe/routes').expect(200)).body.find((x: any) => x.id === route)).toBeUndefined();
  });

  it('rejeição volta com o motivo oficial e libera refazer; a numeração não é reaproveitada', async () => {
    const o = await newOrder();
    const route = await newRoute([o]);
    const p = (await prepare(route).expect(200)).body;
    sefaz.mode = 'reject';
    const r = await act(p.id, 'transmit').expect(409);
    expect(r.body.message).toContain('539');
    const d = (await fiscal.get(`/api/fiscal/mdfe/${p.id}`).expect(200)).body;
    expect(d).toMatchObject({ status: 'REJECTED', statusCode: '539' });
    const p2 = (await prepare(route).expect(200)).body; // nova tentativa = novo rascunho
    expect(p2.id).not.toBe(p.id);
    sefaz.mode = 'authorize';
    await act(p2.id, 'transmit').expect(200);
    const d2 = (await fiscal.get(`/api/fiscal/mdfe/${p2.id}`).expect(200)).body;
    expect(d2.number).toBeGreaterThan(d.number);
  });

  it('sem resposta depois do envio: não reenvia; a consulta pela chave autoriza e monta o mdfeProc', async () => {
    const o = await newOrder();
    const route = await newRoute([o]);
    const p = (await prepare(route).expect(200)).body;
    sefaz.mode = 'stuck';
    await act(p.id, 'transmit').expect(409);
    expect((await fiscal.get(`/api/fiscal/mdfe/${p.id}`).expect(200)).body.status).toBe('PENDING_CONSULT');
    await act(p.id, 'transmit').expect(409); // proibido reenviar
    // a SEFAZ "recebeu" de fato: o simulador registra a chave antes de cortar a conexão
    const sent = mdfeCalls('MDFeRecepcaoSinc')[0];
    const chave = (await fiscal.get(`/api/fiscal/mdfe/${p.id}`).expect(200)).body.accessKey as string;
    expect(sent.body).toContain(`Id="MDFe${chave}"`);
    sefaz.mdfe.set(chave, { protocol: '131260000000321', prot: `<protMDFe xmlns="http://www.portalfiscal.inf.br/mdfe" versao="3.00"><infProt><tpAmb>2</tpAmb><verAplic>SVRS</verAplic><chMDFe>${chave}</chMDFe><dhRecbto>2026-10-23T10:00:00-03:00</dhRecbto><nProt>131260000000321</nProt><digVal>AAAAAAAAAAAAAAAAAAAAAAAAAAA=</digVal><cStat>100</cStat><xMotivo>Autorizado o uso do MDF-e</xMotivo></infProt></protMDFe>` });
    sefaz.mode = 'authorize';
    const c = (await act(p.id, 'consult').expect(200)).body;
    expect(c).toMatchObject({ status: 'AUTHORIZED', statusCode: '100' });
    const d = (await fiscal.get(`/api/fiscal/mdfe/${p.id}`).expect(200)).body;
    expect([d.protocol, d.hasXml]).toEqual(['131260000000321', true]);
  });

  it('falha de conexão antes do envio volta ao rascunho com a MESMA numeração', async () => {
    const o = await newOrder();
    const route = await newRoute([o]);
    const p = (await prepare(route).expect(200)).body;
    sefaz.mode = 'down';
    await act(p.id, 'transmit').expect((res) => { if (![424, 502].includes(res.status) && res.status !== 409) throw new Error(`status ${res.status}`); });
    const d1 = (await fiscal.get(`/api/fiscal/mdfe/${p.id}`).expect(200)).body;
    sefaz.mode = 'authorize';
    if (d1.status === 'DRAFT') {
      await act(p.id, 'transmit').expect(200);
      const d2 = (await fiscal.get(`/api/fiscal/mdfe/${p.id}`).expect(200)).body;
      expect([d2.status, d2.number]).toEqual(['AUTHORIZED', d1.number]);
    } else {
      expect(d1.status).toBe('PENDING_CONSULT'); // a conexão caiu depois de enviar: só a consulta resolve
    }
  });

  it('encerra (110112) com o município do último destino; depois não cancela nem encerra de novo', async () => {
    const o = await newOrder();
    const route = await newRoute([o]);
    const p = (await prepare(route).expect(200)).body;
    await act(p.id, 'transmit').expect(200);
    sefaz.calls.length = 0;
    const r = (await act(p.id, 'close').expect(200)).body;
    expect(r.status).toBe('CLOSED');
    const ev = mdfeCalls('MDFeRecepcaoEvento')[0] as any;
    expect(ev).toMatchObject({ xmlValid: true, sigValid: true, tpEvento: '110112' });
    expect(ev.body).toContain('<cMun>3304557</cMun>');
    const d = (await fiscal.get(`/api/fiscal/mdfe/${p.id}`).expect(200)).body;
    expect([d.status, d.closeProtocol]).toEqual(['CLOSED', '131260000000555']);
    await act(p.id, 'close').expect(409);
    await act(p.id, 'cancel', { reason: 'Cancelamento depois de encerrado' }).expect(409);
  });

  it('cancela (110111) só autorizado, com justificativa de 15+ caracteres, e libera nova viagem fiscal', async () => {
    const o = await newOrder();
    const route = await newRoute([o]);
    const p = (await prepare(route).expect(200)).body;
    await act(p.id, 'cancel', { reason: 'Motivo qualquer do cancelamento' }).expect(409); // ainda rascunho
    await act(p.id, 'transmit').expect(200);
    await act(p.id, 'cancel', { reason: 'curto' }).expect(400);
    sefaz.calls.length = 0;
    expect((await act(p.id, 'cancel', { reason: 'Veículo não saiu para a viagem' }).expect(200)).body.status).toBe('CANCELLED');
    expect(mdfeCalls('MDFeRecepcaoEvento')[0]).toMatchObject({ xmlValid: true, sigValid: true, tpEvento: '110111' });
    const c = (await act(p.id, 'consult').expect(200)).body;
    expect(c).toMatchObject({ status: 'CANCELLED', statusCode: '101' });
    expect((await prepare(route).expect(200)).body.id).not.toBe(p.id); // viagem liberada para um novo MDF-e
  });

  it('isola por empresa: outro tenant não vê nem opera o MDF-e', async () => {
    const o = await newOrder();
    const route = await newRoute([o]);
    const p = (await prepare(route).expect(200)).body;
    const other = agent();
    await other.post('/api/auth/register').set(H).send({ companyName: `Co md2 ${run}`, name: 'Outro', email: `md2-${run}@teste.local`, password: PASSWORD }).expect(201);
    await other.get(`/api/fiscal/mdfe/${p.id}`).expect(404);
    await other.post(`/api/fiscal/mdfe/${p.id}/transmit`).set(H).expect(404);
    expect((await other.get('/api/fiscal/mdfe').expect(200)).body).toEqual([]);
  });
});
