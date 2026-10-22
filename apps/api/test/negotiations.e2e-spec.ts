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
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe('Negociação de dívida de cliente inadimplente', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  type Agent = ReturnType<typeof request.agent>;
  let A: { owner: Agent; wh: string; account: string };
  let B: { owner: Agent };

  async function tenant(label: string) {
    const owner = request.agent(app.getHttpServer());
    await owner.post('/api/auth/register').set(H).send({ companyName: `Co ${label} ${run}`, name: 'Dono', email: `${label}-${run}@teste.local`, password: PASSWORD }).expect(201);
    return owner;
  }
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    const owner = await tenant('negA');
    const company = await owner.post('/api/companies').set(H).send({ legalName: 'Neg LTDA' }).expect(201);
    const est = await owner.post('/api/establishments').set(H).send({ companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz' }).expect(201);
    const wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
    const account = (await owner.post('/api/finance/accounts').set(H).send({ name: 'Banco', kind: 'BANK', openingBalance: 0, openingDate: day(-60) }).expect(201)).body.id;
    A = { owner, wh, account };
    B = { owner: await tenant('negB') };
  });
  afterAll(async () => { await admin.$disconnect(); await app.close(); });

  const customer = async () => (await A.owner.post('/api/customers').set(H).send({ kind: 'PF', name: `Cli ${uid()}` }).expect(201)).body.id as string;
  const title = async (customerId: string, amount: number, due: number, extra: object = {}) =>
    (await A.owner.post('/api/finance/titles').set(H).send({ direction: 'RECEIVABLE', description: `Venda ${uid()}`, amount, dueDate: day(due), customerId, ...extra }).expect(201)).body;
  const idOf = (b: any) => (Array.isArray(b) ? b[0].id : b.id ?? b.ids?.[0]);
  const neg = (body: object) => A.owner.post('/api/finance/negotiations').set(H).send(body);

  it('negocia dois títulos vencidos com juros, multa e desconto: novas parcelas e originais renegociados', async () => {
    const c = await customer();
    const t1 = idOf(await title(c, 100, -40)); const t2 = idOf(await title(c, 200.5, -10));
    await A.owner.put('/api/settings').set(H).send({ 'finance.blockAfterDays': 5 }).expect(200);
    const open = (await A.owner.get(`/api/finance/negotiations/open-titles/${c}`).expect(200)).body;
    expect(open.map((t: any) => t.id).sort()).toEqual([t1, t2].sort());
    expect(open.every((t: any) => t.eligible && t.daysLate > 0)).toBe(true);

    const r = (await neg({ customerId: c, titleIds: [t1, t2], interest: 10, fine: 6.01, discount: 6.5, installments: 3, firstDueDate: day(5), intervalDays: 30 }).expect(201)).body;
    expect(r.total).toBe('310.01'); // 300,50 + 10 + 6,01 − 6,50
    const d = (await A.owner.get(`/api/finance/negotiations/${r.id}`).expect(200)).body;
    expect(d).toMatchObject({ status: 'ACTIVE', installments: 3 });
    expect(d.installmentsList.map((p: any) => String(p.dueDate).slice(0, 10))).toEqual([day(5), day(35), day(65)]);
    expect(d.installmentsList.reduce((s: number, p: any) => s + Math.round(Number(p.amount) * 100), 0)).toBe(31001);
    expect(d.titles.every((x: any) => x.title.status === 'CANCELLED')).toBe(true);
    // o cliente deixou de ser inadimplente (os títulos vencidos saíram)
    const dq = (await A.owner.get('/api/finance/delinquency').expect(200)).body;
    expect(JSON.stringify(dq)).not.toContain(c);
    // não dá para negociar o mesmo título duas vezes
    await neg({ customerId: c, titleIds: [t1], installments: 1, firstDueDate: day(5) }).expect(409);
    await A.owner.put('/api/settings').set(H).send({ 'finance.blockAfterDays': 0 }).expect(200);
  });

  it('regras: vencimento no passado, desconto maior que a dívida, título de outro cliente, parcial e outro tenant', async () => {
    const c = await customer(); const other = await customer();
    const t = idOf(await title(c, 100, -5));
    const tOther = idOf(await title(other, 50, -5));
    await neg({ customerId: c, titleIds: [t], installments: 1, firstDueDate: day(-1) }).expect(400);
    await neg({ customerId: c, titleIds: [t], discount: 500, installments: 1, firstDueDate: day(1) }).expect(400);
    await neg({ customerId: c, titleIds: [t, tOther], installments: 1, firstDueDate: day(1) }).expect(400); // título de outro cliente
    await neg({ customerId: c, titleIds: [t], installments: 40, firstDueDate: day(1) }).expect(400);
    // pagamento parcial impede
    await A.owner.post(`/api/finance/titles/${t}/settle`).set(H).send({ accountId: A.account, amount: 30, paidAt: day(0) }).expect(200);
    await neg({ customerId: c, titleIds: [t], installments: 1, firstDueDate: day(1) }).expect(409);
    const open = (await A.owner.get(`/api/finance/negotiations/open-titles/${c}`).expect(200)).body;
    expect(open[0]).toMatchObject({ eligible: false });
    // outra empresa não enxerga nem usa
    await B.owner.post('/api/finance/negotiations').set(H).send({ customerId: c, titleIds: [t], installments: 1, firstDueDate: day(1) }).expect(400);
    expect((await B.owner.get('/api/finance/negotiations').expect(200)).body).toHaveLength(0);
  });

  it('desfazer: cancela as parcelas novas e reabre os originais; parcela paga impede', async () => {
    const c = await customer();
    const t = idOf(await title(c, 120, -20));
    const n = (await neg({ customerId: c, titleIds: [t], installments: 2, firstDueDate: day(3) }).expect(201)).body;
    await A.owner.post(`/api/finance/negotiations/${n.id}/cancel`).set(H).send({ reason: 'cliente não pagou entrada' }).expect(200);
    const d = (await A.owner.get(`/api/finance/negotiations/${n.id}`).expect(200)).body;
    expect(d.status).toBe('CANCELLED');
    expect(d.installmentsList.every((p: any) => p.status === 'CANCELLED')).toBe(true);
    expect(d.titles[0].title.status).toBe('OPEN');
    await A.owner.post(`/api/finance/negotiations/${n.id}/cancel`).set(H).send({ reason: 'x' }).expect(409); // já desfeita
    // pode renegociar de novo e então pagar uma parcela bloqueia o desfazer
    const n2 = (await neg({ customerId: c, titleIds: [t], installments: 2, firstDueDate: day(3) }).expect(201)).body;
    const d2 = (await A.owner.get(`/api/finance/negotiations/${n2.id}`).expect(200)).body;
    await A.owner.post(`/api/finance/titles/${d2.installmentsList[0].id}/settle`).set(H).send({ accountId: A.account, amount: Number(d2.installmentsList[0].amount), paidAt: day(0) }).expect(200);
    await A.owner.post(`/api/finance/negotiations/${n2.id}/cancel`).set(H).send({ reason: 'y' }).expect(409);
  });

  it('o detalhe mostra as notas das vendas de origem (emitida ou ainda por emitir)', async () => {
    const c = await customer();
    const p = (await A.owner.post('/api/products').set(H).send({ sku: `NG-${uid()}`, name: 'Item', suggestedPrice: 50, costPrice: 1 }).expect(201)).body.id;
    await A.owner.post('/api/stock/movements').set(H).send({ productId: p, warehouseId: A.wh, type: 'PURCHASE_ENTRY', quantity: 5 }).expect(201);
    const o = (await A.owner.post('/api/sales/orders').set(H).send({ customerId: c, warehouseId: A.wh, paymentMethod: 'PIX', fiscalDocType: 'NFE', items: [{ productId: p, quantity: 2, unitPrice: 50 }] }).expect(201)).body.id;
    await A.owner.post(`/api/sales/orders/${o}/submit`).set(H).expect(200);
    // a venda gerou a conta à vista; vence hoje: vira atraso no dia seguinte, então simulamos
    const tid = (await admin.financialTitle.findFirstOrThrow({ where: { origin: 'SALES_ORDER', originRef: { startsWith: `${o}:` } } })).id;
    await admin.financialTitle.update({ where: { id: tid }, data: { dueDate: new Date(Date.now() - 7 * 86_400_000) } });
    const n = (await neg({ customerId: c, titleIds: [tid], installments: 1, firstDueDate: day(2) }).expect(201)).body;
    let d = (await A.owner.get(`/api/finance/negotiations/${n.id}`).expect(200)).body;
    expect(d.orders).toHaveLength(1);
    expect(d.orders[0]).toMatchObject({ id: o, fiscalDocType: 'NFE', fiscalDocuments: [] });
    await A.owner.post('/api/fiscal/outgoing/prepare').set(H).send({ salesOrderId: o }).expect(200);
    d = (await A.owner.get(`/api/finance/negotiations/${n.id}`).expect(200)).body;
    expect(d.orders[0].fiscalDocuments).toHaveLength(1);
  });
});
