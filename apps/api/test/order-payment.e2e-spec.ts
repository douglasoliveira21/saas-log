import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';
import { boletoPlan } from '../src/sales/payment';

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);
let seq = 0;
const uid = () => `${run}${++seq}`;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe('Forma de pagamento da venda (boleto: parcelas e vencimento)', () => {
  let app: INestApplication;
  let owner: ReturnType<typeof request.agent>;
  let wh: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    owner = request.agent(app.getHttpServer());
    await owner.post('/api/auth/register').set(H).send({ companyName: `Co pay ${run}`, name: 'Dono', email: `pay-${run}@teste.local`, password: PASSWORD }).expect(201);
    const company = await owner.post('/api/companies').set(H).send({ legalName: 'Pay LTDA' }).expect(201);
    const est = await owner.post('/api/establishments').set(H).send({ companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz' }).expect(201);
    wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
  });
  afterAll(async () => { await app.close(); });

  async function draft(pay: object, qty = 3, price = 100) {
    const p = (await owner.post('/api/products').set(H).send({ sku: `PG-${uid()}`, name: 'Item', suggestedPrice: price, costPrice: 1 }).expect(201)).body.id;
    await owner.post('/api/stock/movements').set(H).send({ productId: p, warehouseId: wh, type: 'PURCHASE_ENTRY', quantity: qty }).expect(201);
    const c = (await owner.post('/api/customers').set(H).send({ kind: 'PF', name: `Cli ${uid()}` }).expect(201)).body.id;
    return owner.post('/api/sales/orders').set(H).send({ customerId: c, warehouseId: wh, items: [{ productId: p, quantity: qty, unitPrice: price }], ...pay });
  }
  const titles = async (orderId: string) => (await owner.get(`/api/sales/orders/${orderId}`).expect(200)).body.installments as any[];

  it('regras do boleto na criação', async () => {
    await draft({ paymentMethod: 'BOLETO' }).then((r) => expect(r.status).toBe(400)); // sem vencimento
    await draft({ paymentMethod: 'BOLETO', firstDueDate: day(-2), installments: 1 }).then((r) => expect(r.status).toBe(400)); // vencimento no passado
    await draft({ paymentMethod: 'BOLETO', firstDueDate: day(10), installments: 37 }).then((r) => expect(r.status).toBe(400));
    await draft({ paymentMethod: 'FIADO' }).then((r) => expect(r.status).toBe(400)); // forma desconhecida
    await draft({ paymentMethod: 'PIX' }).then((r) => expect(r.status).toBe(201));
  });

  it('boleto em 3 parcelas: guarda a condição e, ao confirmar, gera as contas a receber com vencimentos e soma exata', async () => {
    const o = (await draft({ paymentMethod: 'BOLETO', installments: 3, firstDueDate: day(10), intervalDays: 30 }, 1, 100.01).then((r) => { expect(r.status).toBe(201); return r; })).body.id;
    const d = (await owner.get(`/api/sales/orders/${o}`).expect(200)).body;
    expect(d).toMatchObject({ paymentMethod: 'BOLETO', installmentCount: 3, installmentIntervalDays: 30 });
    expect(String(d.firstDueDate).slice(0, 10)).toBe(day(10));
    expect(await titles(o)).toHaveLength(0); // rascunho não gera nada

    await owner.post(`/api/sales/orders/${o}/submit`).set(H).expect(200);
    const t = await titles(o);
    expect(t.map((x) => x.installmentNo)).toEqual([1, 2, 3]);
    expect(t.map((x) => String(x.dueDate).slice(0, 10))).toEqual([day(10), day(40), day(70)]);
    expect(t.reduce((s, x) => s + Math.round(Number(x.amount) * 100), 0)).toBe(10001);
    expect(t.every((x) => x.status === 'OPEN' && x.installmentTotal === 3)).toBe(true);
    // o Financeiro enxerga as contas e a geração manual não duplica
    await owner.post(`/api/finance/from-order/${o}`).set(H).send({ count: 1, firstDueDate: day(5) }).expect(409);
  });

  it('pagamento à vista (PIX) não gera contas e não guarda vencimento', async () => {
    const o = (await draft({ paymentMethod: 'PIX', installments: 5, firstDueDate: day(10) })).body.id;
    const d = (await owner.get(`/api/sales/orders/${o}`).expect(200)).body;
    expect(d).toMatchObject({ paymentMethod: 'PIX', installmentCount: 1, firstDueDate: null });
    await owner.post(`/api/sales/orders/${o}/submit`).set(H).expect(200);
    expect(await titles(o)).toHaveLength(0);
  });

  it('editar o rascunho troca a forma de pagamento', async () => {
    const created = await draft({ paymentMethod: 'PIX' });
    const id = created.body.id;
    const d = (await owner.get(`/api/sales/orders/${id}`).expect(200)).body;
    await owner.put(`/api/sales/orders/${id}`).set(H).send({ customerId: d.customerId, warehouseId: d.warehouseId, paymentMethod: 'BOLETO', installments: 2, firstDueDate: day(7), items: d.items.map((i: any) => ({ productId: i.productId, quantity: i.quantity, unitPrice: Number(i.unitPrice) })) }).expect(200);
    expect((await owner.get(`/api/sales/orders/${id}`).expect(200)).body).toMatchObject({ paymentMethod: 'BOLETO', installmentCount: 2 });
  });

  it('cancelar o pedido cancela as parcelas em aberto; parcela já paga impede o cancelamento', async () => {
    const a = (await draft({ paymentMethod: 'BOLETO', installments: 2, firstDueDate: day(10) })).body.id;
    await owner.post(`/api/sales/orders/${a}/submit`).set(H).expect(200);
    expect(await titles(a)).toHaveLength(2);
    await owner.post(`/api/sales/orders/${a}/cancel`).set(H).send({ reason: 'cliente desistiu' }).expect(200);
    expect((await titles(a)).every((x) => x.status === 'CANCELLED')).toBe(true);

    const b = (await draft({ paymentMethod: 'BOLETO', installments: 1, firstDueDate: day(10) })).body.id;
    await owner.post(`/api/sales/orders/${b}/submit`).set(H).expect(200);
    const tb = (await titles(b))[0];
    const acc = (await owner.post('/api/finance/accounts').set(H).send({ name: `Conta ${uid()}`, kind: 'BANK', openingBalance: 0, openingDate: day(-30) }).expect(201)).body.id;
    await owner.post(`/api/finance/titles/${tb.id}/settle`).set(H).send({ accountId: acc, amount: Number(tb.amount), paidAt: day(0) }).expect(200);
    await owner.post(`/api/sales/orders/${b}/cancel`).set(H).send({ reason: 'x' }).expect(409);
  });

  it('divisão em centavos: a última parcela absorve a diferença', () => {
    const p = boletoPlan(10001, 3, new Date('2030-01-10T00:00:00Z'), 30);
    expect(p.map((x) => x.cents)).toEqual([3333, 3333, 3335]);
    expect(p[2].due.toISOString().slice(0, 10)).toBe('2030-03-11');
  });
});
