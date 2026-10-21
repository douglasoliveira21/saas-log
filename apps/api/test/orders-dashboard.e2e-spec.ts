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
const CNPJ = '45723174000110';
const HOUR = 3_600_000;

describe('Visão geral de pedidos e edição de estoque', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  const agent = () => request.agent(app.getHttpServer());
  type Agent = ReturnType<typeof agent>;
  interface T { owner: Agent; tenantId: string; wh: string; customer: string; users: Record<string, Agent>; userIds: Record<string, string>; salespersonId: string }

  async function setup(label: string): Promise<T> {
    const owner = agent();
    const reg = await owner.post('/api/auth/register').set(H).send({ companyName: `Co ${label} ${run}`, name: `Dono ${label}`, email: `${label}-${run}@teste.local`, password: PASSWORD }).expect(201);
    const company = await owner.post('/api/companies').set(H).send({ legalName: `${label} LTDA`, taxRegime: 'SIMPLES_NACIONAL' }).expect(201);
    const est = await owner.post('/api/establishments').set(H).send({ companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz', cnpj: CNPJ, stateRegistration: '111222333444', cnae: '4744-0/99', zipCode: '13000-000', city: 'Campinas', state: 'SP', street: 'Rua A', number: '1' }).expect(201);
    const wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
    const roles = Object.fromEntries((await owner.get('/api/roles').expect(200)).body.map((r: any) => [r.key, r.id]));
    const customer = (await owner.post('/api/customers').set(H).send({ kind: 'PJ', name: 'Cliente Padrão', document: '11.222.333/0001-81' }).expect(201)).body.id;
    const t: T = { owner, tenantId: reg.body.tenantId, wh, customer, users: {}, userIds: {}, salespersonId: '' };
    for (const k of ['salesperson', 'stock_operator', 'auditor']) {
      const email = `${k}-${uid()}@teste.local`;
      const created = await owner.post('/api/users').set(H).send({ name: `U ${k}`, email, password: PASSWORD, roleId: roles[k] }).expect(201);
      const a = agent();
      await a.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200);
      t.users[k] = a; t.userIds[k] = created.body.userId;
    }
    t.salespersonId = (await owner.post('/api/salespeople').set(H).send({ name: 'Vera Vendedora', userId: t.userIds.salesperson }).expect(201)).body.id;
    return t;
  }

  const product = async (t: T, stock = 0) => {
    const id = (await t.owner.post('/api/products').set(H).send({ sku: `OD-${uid()}`, name: 'Produto', suggestedPrice: 100, costPrice: 40, ncm: '73181500', taxOrigin: 0 }).expect(201)).body.id as string;
    if (stock) await t.owner.post('/api/stock/movements').set(H).send({ productId: id, warehouseId: t.wh, type: 'PURCHASE_ENTRY', quantity: stock }).expect(201);
    return id;
  };
  const order = async (t: T, productId: string, who: Agent = t.owner, to: string[] = []) => {
    const o = (await who.post('/api/sales/orders').set(H).send({ customerId: t.customer, warehouseId: t.wh, ...(who === t.owner ? {} : { salespersonId: t.salespersonId }), items: [{ productId, quantity: 1, unitPrice: 100 }] }).expect(201)).body;
    await who.post(`/api/sales/orders/${o.id}/submit`).set(H).expect(200);
    for (const s of to) await t.owner.post(`/api/sales/orders/${o.id}/advance`).set(H).send({ to: s }).expect(200);
    return o as { id: string; number: number };
  };
  const dash = async (t: T, who: Agent = t.owner, q = '') => (await who.get(`/api/dashboard/orders${q}`).expect(200)).body;
  const balance = async (t: T, productId: string) => ((await t.owner.get(`/api/stock/balances/${productId}`).expect(200)).body as any[]).find((b) => b.warehouseId === t.wh);

  let A: T;
  let B: T;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    await admin.plan.update({ where: { code: 'trial' }, data: { limits: { users: 100, establishments: 20, warehouses: 20 } } });
    A = await setup('odA');
    B = await setup('odB');
  });
  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  describe('dashboard de pedidos', () => {
    it('começa zerado e exige permissão de vendas', async () => {
      const d = await dash(A);
      expect(d.cards).toMatchObject({ newToday: 0, open: 0, late: 0, toShip: 0, inTransit: 0 });
      expect(d.series).toHaveLength(30);
      expect(d.sla).toEqual({ shippingHours: 24, deliveryDays: 7 });
      await request(app.getHttpServer()).get('/api/dashboard/orders').expect(401);
    });

    it('conta novos, a enviar, em trânsito, entregues e identifica atrasos pelo prazo', async () => {
      const p = await product(A, 50);
      const fresh = await order(A, p); // aprovado agora → a enviar, sem atraso
      const lateShip = await order(A, p);
      const lateDel = await order(A, p, A.owner, ['PICKING', 'PACKED', 'SHIPPED']);
      const done = await order(A, p, A.owner, ['PICKING', 'PACKED', 'SHIPPED', 'DELIVERED']);
      await admin.salesOrder.update({ where: { id: lateShip.id }, data: { confirmedAt: new Date(Date.now() - 48 * HOUR) } });
      await admin.salesOrder.update({ where: { id: lateDel.id }, data: { shippedAt: new Date(Date.now() - 10 * 24 * HOUR) } });

      const d = await dash(A);
      expect(d.cards.toShip).toBe(2);
      expect(d.cards.inTransit).toBe(1);
      expect(d.cards.lateShipping).toBe(1);
      expect(d.cards.lateDelivery).toBe(1);
      expect(d.cards.late).toBe(2);
      expect(d.status.DELIVERED).toBe(1);
      expect(d.late.shipping.map((x: any) => x.number)).toEqual([lateShip.number]);
      expect(d.late.shipping[0].hoursLate).toBeGreaterThanOrEqual(47);
      expect(d.late.delivery.map((x: any) => x.number)).toEqual([lateDel.number]);
      expect(d.period.created).toBe(4);
      expect(d.period.delivered).toBe(1);
      expect(d.period.shipped).toBe(2);
      expect(Number(d.period.revenue)).toBe(400);
      expect(d.series.reduce((n: number, x: any) => n + x.created, 0)).toBe(4);
      expect(d.byChannel[0]).toMatchObject({ channel: 'DIRECT', orders: 4 });
      expect(fresh.number).toBeGreaterThan(0);
      expect(done.number).toBeGreaterThan(0);
    });

    it('o prazo configurado muda o que é atraso', async () => {
      await A.owner.put('/api/settings').set(H).send({ 'orders.shippingSlaHours': 100, 'orders.deliverySlaDays': 30 }).expect(200);
      const d = await dash(A);
      expect(d.sla).toEqual({ shippingHours: 100, deliveryDays: 30 });
      expect(d.cards.late).toBe(0);
      await A.owner.put('/api/settings').set(H).send({ 'orders.shippingSlaHours': 0 }).expect(400);
      await A.owner.put('/api/settings').set(H).send({ 'orders.deliverySlaDays': 91 }).expect(400);
      await A.owner.put('/api/settings').set(H).send({ 'orders.shippingSlaHours': 24, 'orders.deliverySlaDays': 7 }).expect(200);
    });

    it('vendedor vê só os próprios pedidos e outra empresa não vê nada de A', async () => {
      const p = await product(B, 10);
      await order(B, p);
      const p2 = await product(B, 10);
      await order(B, p2, B.users.salesperson);
      const owner = await dash(B);
      const seller = await dash(B, B.users.salesperson);
      expect(owner.cards.open).toBe(2);
      expect(seller.cards.open).toBe(1);
      expect((await dash(A)).cards.open).toBeGreaterThan(0);
      expect((await dash(A)).period.created).toBe(4); // pedidos de B não vazam para A
    });

    it('aceita período e recusa valores inválidos', async () => {
      expect((await dash(A, A.owner, '?days=7')).series).toHaveLength(7);
      await A.owner.get('/api/dashboard/orders?days=0').expect(400);
      await A.owner.get('/api/dashboard/orders?days=500').expect(400);
    });
  });

  describe('editar estoque (definir quantidade física)', () => {
    it('ajusta para mais e para menos registrando o histórico e o motivo', async () => {
      const p = await product(A, 10);
      const up = await A.owner.post('/api/stock/set-on-hand').set(H).send({ productId: p, warehouseId: A.wh, newOnHand: 25, reason: 'Contagem física' }).expect(201);
      expect(up.body).toMatchObject({ from: 10, to: 25, delta: 15 });
      expect((await balance(A, p)).onHand).toBe(25);
      const down = await A.owner.post('/api/stock/set-on-hand').set(H).send({ productId: p, warehouseId: A.wh, newOnHand: 0, reason: 'Excluir estoque' }).expect(201);
      expect(down.body).toMatchObject({ from: 25, to: 0, delta: -25 });
      expect((await balance(A, p)).onHand).toBe(0);
      const mv = (await A.owner.get(`/api/stock/movements?productId=${p}`).expect(200)).body;
      const list = Array.isArray(mv) ? mv : mv.items;
      expect(list.filter((m: any) => m.type === 'ADJUSTMENT').length).toBeGreaterThanOrEqual(2);
    });

    it('recusa igual ao atual, sem motivo, negativo e abaixo do reservado', async () => {
      const p = await product(A, 10);
      await A.owner.post('/api/stock/set-on-hand').set(H).send({ productId: p, warehouseId: A.wh, newOnHand: 10, reason: 'x' }).expect(400);
      await A.owner.post('/api/stock/set-on-hand').set(H).send({ productId: p, warehouseId: A.wh, newOnHand: 5 }).expect(400);
      await A.owner.post('/api/stock/set-on-hand').set(H).send({ productId: p, warehouseId: A.wh, newOnHand: -1, reason: 'x' }).expect(400);
      await order(A, p); // reserva 1 unidade
      const r = await A.owner.post('/api/stock/set-on-hand').set(H).send({ productId: p, warehouseId: A.wh, newOnHand: 0, reason: 'Zerar' }).expect(409);
      expect(JSON.stringify(r.body)).toMatch(/reservado/);
      expect((await balance(A, p)).onHand).toBe(10);
    });

    it('exige permissão de ajuste e respeita o isolamento entre empresas', async () => {
      const p = await product(A, 5);
      await A.users.auditor.post('/api/stock/set-on-hand').set(H).send({ productId: p, warehouseId: A.wh, newOnHand: 1, reason: 'x' }).expect(403);
      await B.owner.post('/api/stock/set-on-hand').set(H).send({ productId: p, warehouseId: B.wh, newOnHand: 1, reason: 'x' }).expect(404);
      expect((await balance(A, p)).onHand).toBe(5);
    });

    it('é idempotente e, em edições simultâneas para o mesmo valor, só uma é aplicada', async () => {
      const p = await product(A, 10);
      const body = { productId: p, warehouseId: A.wh, newOnHand: 30, reason: 'Contagem', idempotencyKey: `k-${uid()}` };
      await A.owner.post('/api/stock/set-on-hand').set(H).send(body).expect(201);
      await A.owner.post('/api/stock/set-on-hand').set(H).send(body).expect(201); // repetição devolve o mesmo resultado
      expect((await balance(A, p)).onHand).toBe(30);

      const q = await product(A, 10);
      const res = await Promise.all([1, 2, 3, 4].map((i) => A.owner.post('/api/stock/set-on-hand').set(H).send({ productId: q, warehouseId: A.wh, newOnHand: 7, reason: `c${i}`, idempotencyKey: `k-${uid()}` })));
      expect(res.filter((r) => r.status === 201)).toHaveLength(1);
      expect(res.filter((r) => r.status === 400)).toHaveLength(3);
      expect((await balance(A, q)).onHand).toBe(7);
    });
  });
});
