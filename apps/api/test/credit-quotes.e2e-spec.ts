import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);
let seq = 0;
const uid = () => `${run}${++seq}`;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe('Crédito do cliente e orçamentos', () => {
  let app: INestApplication;
  type Agent = ReturnType<typeof request.agent>;
  let owner: Agent; let other: Agent; let wh: string; let prod: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    owner = request.agent(app.getHttpServer());
    await owner.post('/api/auth/register').set(H).send({ companyName: `Co cq ${run}`, name: 'Dono', email: `cq-${run}@teste.local`, password: PASSWORD }).expect(201);
    const company = await owner.post('/api/companies').set(H).send({ legalName: 'CQ LTDA' }).expect(201);
    const est = await owner.post('/api/establishments').set(H).send({ companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz' }).expect(201);
    wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
    prod = (await owner.post('/api/products').set(H).send({ sku: `CQ-${uid()}`, name: 'Item', suggestedPrice: 100, costPrice: 40 }).expect(201)).body.id;
    await owner.post('/api/stock/movements').set(H).send({ productId: prod, warehouseId: wh, type: 'PURCHASE_ENTRY', quantity: 500 }).expect(201);
    other = request.agent(app.getHttpServer());
    await other.post('/api/auth/register').set(H).send({ companyName: `Co cqB ${run}`, name: 'Outro', email: `cqb-${run}@teste.local`, password: PASSWORD }).expect(201);
  });
  afterAll(async () => { await app.close(); });

  const customer = async () => (await owner.post('/api/customers').set(H).send({ kind: 'PF', name: `Cli ${uid()}` }).expect(201)).body.id as string;
  const order = (c: string, qty: number, pay: object = { paymentMethod: 'BOLETO', installments: 1, firstDueDate: day(10) }, extra: object = {}) =>
    owner.post('/api/sales/orders').set(H).send({ customerId: c, warehouseId: wh, items: [{ productId: prod, quantity: qty, unitPrice: 100 }], ...pay, ...extra });

  describe('crédito', () => {
    it('sem limite cadastrado não há controle; limite pode ser definido e removido', async () => {
      const c = await customer();
      expect((await owner.get(`/api/customers/${c}/credit`).expect(200)).body).toMatchObject({ limit: null, available: null });
      const o = (await order(c, 50).expect(201)).body.id; // R$ 5.000 a prazo
      await owner.post(`/api/sales/orders/${o}/submit`).set(H).expect(200); // confirma direto
      await owner.put(`/api/customers/${c}/credit-limit`).set(H).send({ creditLimit: 6000 }).expect(200);
      const info = (await owner.get(`/api/customers/${c}/credit`).expect(200)).body;
      expect(info).toMatchObject({ limit: '6000.00', exposure: '5000.00', available: '1000.00' });
      await owner.put(`/api/customers/${c}/credit-limit`).set(H).send({ creditLimit: -5 }).expect(400);
      await owner.put(`/api/customers/${c}/credit-limit`).set(H).send({ creditLimit: null }).expect(200);
      expect((await owner.get(`/api/customers/${c}/credit`).expect(200)).body.limit).toBeNull();
    });

    it('venda a prazo acima do limite vai para aprovação; dentro do limite, Pix e dinheiro confirmam direto', async () => {
      const c = await customer();
      await owner.put(`/api/customers/${c}/credit-limit`).set(H).send({ creditLimit: 1000 }).expect(200);
      const ok = (await order(c, 5).expect(201)).body.id; // R$ 500
      expect((await owner.post(`/api/sales/orders/${ok}/submit`).set(H).expect(200)).body.status).toBe('CONFIRMED');
      const big = (await order(c, 8).expect(201)).body.id; // + R$ 800 → passa de 1.000
      const r = (await owner.post(`/api/sales/orders/${big}/submit`).set(H).expect(200)).body;
      expect(r.status).toBe('PENDING_APPROVAL');
      expect(r.reasons.join(' ')).toMatch(/Limite de crédito excedido/);
      // Pix não consome limite
      const pix = (await order(c, 20, { paymentMethod: 'PIX' }).expect(201)).body.id;
      expect((await owner.post(`/api/sales/orders/${pix}/submit`).set(H).expect(200)).body.status).toBe('CONFIRMED');
      // quem aprova libera o pedido
      await owner.post(`/api/sales/orders/${big}/approve`).set(H).expect(200);
      expect((await owner.get(`/api/sales/orders/${big}`).expect(200)).body.status).toBe('CONFIRMED');
    });

    it('limite 0 exige aprovação em toda venda a prazo; outra empresa e vendedor não alteram limite', async () => {
      const c = await customer();
      await owner.put(`/api/customers/${c}/credit-limit`).set(H).send({ creditLimit: 0 }).expect(200);
      const o = (await order(c, 1).expect(201)).body.id;
      expect((await owner.post(`/api/sales/orders/${o}/submit`).set(H).expect(200)).body.status).toBe('PENDING_APPROVAL');
      await other.put(`/api/customers/${c}/credit-limit`).set(H).send({ creditLimit: 99999 }).expect(404);
      const roles = Object.fromEntries((await owner.get('/api/roles').expect(200)).body.map((r: any) => [r.key, r.id]));
      const email = `v-${uid()}@teste.local`;
      await owner.post('/api/users').set(H).send({ name: 'Vend', email, password: PASSWORD, roleId: roles.salesperson }).expect(201);
      const v = request.agent(app.getHttpServer());
      await v.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200);
      await v.put(`/api/customers/${c}/credit-limit`).set(H).send({ creditLimit: 99999 }).expect(403);
      await v.get(`/api/customers/${c}/credit`).expect(200); // pode consultar
    });
  });

  describe('orçamentos', () => {
    const quote = (c: string, extra: object = {}) => owner.post('/api/quotes').set(H).send({ customerId: c, warehouseId: wh, validDays: 5, items: [{ productId: prod, quantity: 4, unitPrice: 90, discountPct: 10 }], ...extra });

    it('cria, calcula totais, edita e lista; não reserva estoque', async () => {
      const c = await customer();
      const q = (await quote(c, { shipping: 20 }).expect(201)).body;
      const d = (await owner.get(`/api/quotes/${q.id}`).expect(200)).body;
      expect(d).toMatchObject({ status: 'OPEN', expired: false });
      expect([Number(d.subtotal), Number(d.discountTotal), Number(d.total)]).toEqual([360, 36, 344]); // 4×90 − 10% + frete 20
      expect(String(d.validUntil).slice(0, 10)).toBe(day(5));
      await owner.put(`/api/quotes/${q.id}`).set(H).send({ customerId: c, warehouseId: wh, validDays: 10, items: [{ productId: prod, quantity: 2, unitPrice: 100 }] }).expect(200);
      expect(Number((await owner.get(`/api/quotes/${q.id}`).expect(200)).body.total)).toBe(200);
      expect((await owner.get('/api/quotes?status=OPEN').expect(200)).body.some((x: any) => x.id === q.id)).toBe(true);
      await quote(c, { validUntil: day(-1) }).expect(400);
      await quote(c, { items: [] }).expect(400);
    });

    it('converte em pedido com os mesmos preços, confirmando se pedido; não converte duas vezes', async () => {
      const c = await customer();
      const q = (await quote(c).expect(201)).body.id;
      const r = (await owner.post(`/api/quotes/${q}/convert`).set(H).send({ paymentMethod: 'PIX', confirm: true }).expect(200)).body;
      expect(r.orderStatus).toBe('CONFIRMED');
      const o = (await owner.get(`/api/sales/orders/${r.orderId}`).expect(200)).body;
      expect(o.items[0].quantity).toBe(4);
      expect([Number(o.items[0].unitPrice), Number(o.total)]).toEqual([90, 324]);
      expect((await owner.get(`/api/quotes/${q}`).expect(200)).body).toMatchObject({ status: 'CONVERTED', order: { id: r.orderId } });
      await owner.post(`/api/quotes/${q}/convert`).set(H).send({ paymentMethod: 'PIX' }).expect(409);
      await owner.put(`/api/quotes/${q}`).set(H).send({ customerId: c, warehouseId: wh, items: [{ productId: prod, quantity: 1, unitPrice: 1 }] }).expect(409);
    });

    it('conversão em rascunho e boleto com data; orçamento perdido não converte; vencido não converte', async () => {
      const c = await customer();
      const a = (await quote(c).expect(201)).body.id;
      const r = (await owner.post(`/api/quotes/${a}/convert`).set(H).send({ paymentMethod: 'BOLETO', installments: 2, firstDueDate: day(15) }).expect(200)).body;
      expect(r.orderStatus).toBe('DRAFT');
      expect((await owner.get(`/api/sales/orders/${r.orderId}`).expect(200)).body).toMatchObject({ status: 'DRAFT', paymentMethod: 'BOLETO', installmentCount: 2 });
      await owner.post(`/api/quotes/${(await quote(c).expect(201)).body.id}/convert`).set(H).send({ paymentMethod: 'BOLETO' }).expect(400); // boleto sem vencimento: nada é criado

      const b = (await quote(c).expect(201)).body.id;
      await owner.post(`/api/quotes/${b}/lost`).set(H).send({ reason: 'fechou com concorrente' }).expect(200);
      await owner.post(`/api/quotes/${b}/convert`).set(H).send({ paymentMethod: 'PIX' }).expect(409);

      const e = (await quote(c).expect(201)).body.id;
      const { PrismaClient } = await import('@prisma/client');
      const admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
      await admin.quote.update({ where: { id: e }, data: { validUntil: new Date(Date.now() - 3 * 86_400_000) } });
      await admin.$disconnect();
      expect((await owner.get(`/api/quotes/${e}`).expect(200)).body).toMatchObject({ expired: true, displayStatus: 'EXPIRED' });
      await owner.post(`/api/quotes/${e}/convert`).set(H).send({ paymentMethod: 'PIX' }).expect(409);
      expect((await owner.get('/api/quotes?status=EXPIRED').expect(200)).body.some((x: any) => x.id === e)).toBe(true);
    });

    it('outra empresa não enxerga nem converte', async () => {
      const q = (await quote(await customer()).expect(201)).body.id;
      await other.get(`/api/quotes/${q}`).expect(404);
      await other.post(`/api/quotes/${q}/convert`).set(H).send({ paymentMethod: 'PIX' }).expect(404);
    });
  });
});
