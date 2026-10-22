import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';
import { localToday } from '../src/sales/cutoff';

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);
let seq = 0;
const uid = () => `${run}${++seq}`;
const DAY = 86_400_000;

describe('Horário de corte das vendas e perfil do cliente na compra', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  const agent = () => request.agent(app.getHttpServer());
  type Agent = ReturnType<typeof agent>;
  interface T { owner: Agent; tenantId: string; wh: string; viewer: Agent }

  async function setup(label: string): Promise<T> {
    const owner = agent();
    const reg = await owner.post('/api/auth/register').set(H).send({ companyName: `Co ${label} ${run}`, name: `Dono ${label}`, email: `${label}-${run}@teste.local`, password: PASSWORD }).expect(201);
    const company = await owner.post('/api/companies').set(H).send({ legalName: `${label} LTDA` }).expect(201);
    const est = await owner.post('/api/establishments').set(H).send({ companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz' }).expect(201);
    const wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
    const roles = Object.fromEntries((await owner.get('/api/roles').expect(200)).body.map((r: any) => [r.key, r.id]));
    const email = `aud-${uid()}@teste.local`;
    await owner.post('/api/users').set(H).send({ name: 'Auditor', email, password: PASSWORD, roleId: roles.auditor }).expect(201);
    const viewer = agent();
    await viewer.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200);
    return { owner, tenantId: reg.body.tenantId, wh, viewer };
  }

  const customer = async (t: T) => (await t.owner.post('/api/customers').set(H).send({ kind: 'PF', name: `Cliente ${uid()}` }).expect(201)).body.id as string;
  const product = async (t: T) => {
    const id = (await t.owner.post('/api/products').set(H).send({ sku: `CP-${uid()}`, name: 'Produto', suggestedPrice: 50, costPrice: 10 }).expect(201)).body.id as string;
    await t.owner.post('/api/stock/movements').set(H).send({ productId: id, warehouseId: t.wh, type: 'PURCHASE_ENTRY', quantity: 500 }).expect(201);
    return id;
  };
  const confirmed = async (t: T, customerId: string, productId: string, extra: object = {}) => {
    const o = (await t.owner.post('/api/sales/orders').set(H).send({ customerId, warehouseId: t.wh, items: [{ productId, quantity: 1, unitPrice: 50 }], ...extra }).expect(201)).body;
    await t.owner.post(`/api/sales/orders/${o.id}/submit`).set(H).expect(200);
    return o.id as string;
  };
  const detail = async (t: T, id: string) => (await t.owner.get(`/api/sales/orders/${id}`).expect(200)).body;
  const profile = async (t: T, customerId: string) => (await t.owner.get(`/api/customers/${customerId}/purchase-profile`).expect(200)).body;
  const settings = (t: T, patch: object) => t.owner.put('/api/settings').set(H).send(patch);

  let A: T;
  let B: T;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    await admin.plan.update({ where: { code: 'trial' }, data: { limits: { users: 100, establishments: 20, warehouses: 20 } } });
    A = await setup('cpA');
    B = await setup('cpB');
  });
  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  describe('perfil do cliente na compra', () => {
    it('primeira compra = novo; depois de comprar passa a ativo', async () => {
      const c = await customer(A); const p = await product(A);
      expect(await profile(A, c)).toMatchObject({ type: 'NEW', orders: 0, lastPurchaseAt: null, daysSince: null, inactiveAfterDays: 60 });
      const first = await confirmed(A, c, p);
      expect((await detail(A, first)).customerType).toBe('NEW');
      expect(await profile(A, c)).toMatchObject({ type: 'ACTIVE', orders: 1, daysSince: 0, totalSpent: '50.00' });
      const second = await confirmed(A, c, p);
      expect((await detail(A, second)).customerType).toBe('ACTIVE'); // o pedido anterior não conta contra si mesmo
    });

    it('cliente parado há mais de 60 dias volta como "voltou a comprar"; o prazo é configurável', async () => {
      const c = await customer(A); const p = await product(A);
      const old = await confirmed(A, c, p);
      await admin.salesOrder.update({ where: { id: old }, data: { confirmedAt: new Date(Date.now() - 61 * DAY) } });
      expect(await profile(A, c)).toMatchObject({ type: 'RETURNING', daysSince: 61 });
      const back = await confirmed(A, c, p);
      expect((await detail(A, back)).customerType).toBe('RETURNING');

      const d = await customer(A);
      const o = await confirmed(A, d, p);
      await admin.salesOrder.update({ where: { id: o }, data: { confirmedAt: new Date(Date.now() - 40 * DAY) } });
      expect((await profile(A, d)).type).toBe('ACTIVE');
      await settings(A, { 'customers.inactiveAfterDays': 30 }).expect(200);
      expect(await profile(A, d)).toMatchObject({ type: 'RETURNING', inactiveAfterDays: 30 });
      await settings(A, { 'customers.inactiveAfterDays': 60 }).expect(200);
    });

    it('rascunho, cancelado e aguardando aprovação não contam como compra', async () => {
      const c = await customer(A); const p = await product(A);
      const draft = (await A.owner.post('/api/sales/orders').set(H).send({ customerId: c, warehouseId: A.wh, items: [{ productId: p, quantity: 1, unitPrice: 50 }] }).expect(201)).body.id;
      expect(await profile(A, c)).toMatchObject({ type: 'NEW', orders: 0 });
      await A.owner.post(`/api/sales/orders/${draft}/submit`).set(H).expect(200);
      await A.owner.post(`/api/sales/orders/${draft}/cancel`).set(H).send({ reason: 'Desistiu' }).expect(200);
      expect(await profile(A, c)).toMatchObject({ type: 'NEW', orders: 0 });
    });

    it('lista de clientes traz o perfil; valida o prazo; isola empresas e exige permissão', async () => {
      const c = await customer(A);
      const list = (await A.owner.get('/api/customers').expect(200)).body as any[];
      expect(list.find((x) => x.id === c).purchase).toMatchObject({ type: 'NEW', orders: 0 });
      await settings(A, { 'customers.inactiveAfterDays': 0 }).expect(400);
      await settings(A, { 'customers.inactiveAfterDays': 731 }).expect(400);
      await B.owner.get(`/api/customers/${c}/purchase-profile`).expect(404);
      await request(app.getHttpServer()).get(`/api/customers/${c}/purchase-profile`).expect(401);
    });
  });

  describe('horário de corte', () => {
    it('vem desligado: o pedido não ganha data de saída', async () => {
      const info = (await A.owner.get('/api/sales/cutoff').expect(200)).body;
      expect(info).toMatchObject({ enabled: false, cutoffTime: null, dispatchDate: null });
      const id = await confirmed(A, await customer(A), await product(A));
      expect(await detail(A, id)).toMatchObject({ dispatchDate: null, dispatchDeferred: false });
    });

    it('valida o horário e as opções', async () => {
      await settings(A, { 'sales.cutoffTime': '25:00' }).expect(400);
      await settings(A, { 'sales.cutoffTime': '16h' }).expect(400);
      await settings(A, { 'sales.cutoffTime': 1600 }).expect(400);
      await settings(A, { 'sales.cutoffBusinessDaysOnly': 'sim' }).expect(400);
      await A.viewer.put('/api/settings').set(H).send({ 'sales.cutoffTime': '16:00' }).expect(403);
    });

    it('com corte às 23:59 o pedido de agora sai hoje (dia útil) ou na segunda (fim de semana)', async () => {
      await settings(A, { 'sales.cutoffTime': '23:59', 'sales.cutoffBusinessDaysOnly': false }).expect(200);
      const info = (await A.owner.get('/api/sales/cutoff').expect(200)).body;
      expect(info).toMatchObject({ enabled: true, cutoffTime: '23:59', businessDaysOnly: false, dispatchDate: localToday(), deferred: false });
      const id = await confirmed(A, await customer(A), await product(A));
      const o = await detail(A, id);
      expect(o.dispatchDate.slice(0, 10)).toBe(localToday());
      expect(o.dispatchDeferred).toBe(false);
    });

    it('com corte às 00:00 todo pedido de hoje já passou do corte e fica para depois', async () => {
      await settings(A, { 'sales.cutoffTime': '00:00', 'sales.cutoffBusinessDaysOnly': false }).expect(200);
      const info = (await A.owner.get('/api/sales/cutoff').expect(200)).body;
      const tomorrow = new Date(Date.parse(`${localToday()}T12:00:00Z`) + DAY).toISOString().slice(0, 10);
      expect(info).toMatchObject({ dispatchDate: tomorrow, deferred: true });
      const id = await confirmed(A, await customer(A), await product(A));
      const o = await detail(A, id);
      expect(o.dispatchDate.slice(0, 10)).toBe(tomorrow);
      expect(o.dispatchDeferred).toBe(true);
    });

    it('pedido de marketplace não recebe corte (usa o prazo em horas)', async () => {
      const id = await confirmed(A, await customer(A), await product(A), { channel: 'MARKETPLACE' });
      expect(await detail(A, id)).toMatchObject({ dispatchDate: null, dispatchDeferred: false });
    });

    it('o painel de pedidos usa a data de saída: vencida = atrasada; hoje = "saem hoje"', async () => {
      await settings(A, { 'sales.cutoffTime': '23:59', 'sales.cutoffBusinessDaysOnly': false }).expect(200);
      const before = (await A.owner.get('/api/dashboard/orders').expect(200)).body.cards;
      const late = await confirmed(A, await customer(A), await product(A));
      const today = await confirmed(A, await customer(A), await product(A));
      const yesterday = new Date(Date.parse(`${localToday()}T00:00:00Z`) - DAY);
      await admin.salesOrder.update({ where: { id: late }, data: { dispatchDate: yesterday } });
      const after = (await A.owner.get('/api/dashboard/orders').expect(200)).body;
      expect(after.cards.lateShipping).toBe(before.lateShipping + 1);
      expect(after.cards.dispatchToday).toBe(before.dispatchToday + 1);
      expect(after.late.shipping.map((x: any) => x.id)).toContain(late);
      expect(after.late.shipping.map((x: any) => x.id)).not.toContain(today);
    });

    it('desligar (vazio) volta ao comportamento anterior e a outra empresa não é afetada', async () => {
      await settings(A, { 'sales.cutoffTime': '' }).expect(200);
      expect((await A.owner.get('/api/sales/cutoff').expect(200)).body.enabled).toBe(false);
      expect((await B.owner.get('/api/sales/cutoff').expect(200)).body.enabled).toBe(false);
      await A.viewer.get('/api/sales/cutoff').expect(200); // quem vê vendas vê a regra
    });
  });
});
