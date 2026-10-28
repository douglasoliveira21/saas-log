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

describe('Expedição: fila por etapa, alertas, painel, urgência e responsáveis', () => {
  let app: INestApplication; let admin: PrismaClient;
  const agent = () => request.agent(app.getHttpServer());
  type Agent = ReturnType<typeof agent>;
  let owner: Agent; let seller: Agent; let shipper: Agent; let tenantId: string; let wh: string; let product: string;

  async function user(roleKey: string, name: string) {
    const roles = Object.fromEntries((await owner.get('/api/roles').expect(200)).body.map((r: any) => [r.key, r.id]));
    const email = `${name.toLowerCase()}-${run}-${++seq}@teste.local`;
    await owner.post('/api/users').set(H).send({ name, email, password: PASSWORD, roleId: roles[roleKey] }).expect(201);
    const a = agent(); await a.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200);
    return a;
  }
  async function newOrder(a: Agent = owner) {
    const c = (await owner.post('/api/customers').set(H).send({ kind: 'PF', name: `Cli ${run}${++seq}`, city: 'Campinas', state: 'SP' }).expect(201)).body.id;
    const o = (await a.post('/api/sales/orders').set(H).send({ customerId: c, warehouseId: wh, paymentMethod: 'PIX', items: [{ productId: product, quantity: 2, unitPrice: 30 }] }).expect(201)).body.id as string;
    await a.post(`/api/sales/orders/${o}/submit`).set(H).expect(200);
    return o;
  }
  const adv = (a: Agent, id: string, to: string) => a.post(`/api/sales/orders/${id}/advance`).set(H).send({ to });
  const queue = async (a: Agent = shipper) => (await a.get('/api/dispatch/queue').expect(200)).body as any[];
  const find = async (id: string) => (await queue()).find((x) => x.id === id);
  const overview = async () => (await shipper.get('/api/dispatch/overview').expect(200)).body;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication(); configureApp(app); await app.listen(0);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    owner = agent();
    const r = await owner.post('/api/auth/register').set(H).send({ companyName: `Co dp ${run}`, name: 'Dono', email: `dp-${run}@teste.local`, password: PASSWORD }).expect(201);
    tenantId = r.body.tenantId;
    await admin.plan.update({ where: { code: 'trial' }, data: { limits: { users: 100, establishments: 20, warehouses: 20 } } });
    const company = await owner.post('/api/companies').set(H).send({ legalName: 'DP LTDA' }).expect(201);
    const est = await owner.post('/api/establishments').set(H).send({ companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz' }).expect(201);
    wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
    product = (await owner.post('/api/products').set(H).send({ sku: `DP-${run}`, name: 'Produto', costPrice: 1, suggestedPrice: 30, grossWeightG: 500 }).expect(201)).body.id;
    await owner.post('/api/stock/movements').set(H).send({ productId: product, warehouseId: wh, type: 'PURCHASE_ENTRY', quantity: 500 }).expect(201);
    seller = await user('salesperson', 'Vendedora'); shipper = await user('shipper', 'Expedidor');
  }, 90_000);
  afterAll(async () => { await admin.$disconnect(); await app.close(); });

  it('só quem separa/expede acessa; o pedido confirmado em Vendas chega à fila como "aguardando separação" com os dados da expedição', async () => {
    await seller.get('/api/dispatch/queue').expect(403);
    await seller.get('/api/dispatch/overview').expect(403);
    const o = await newOrder(seller);
    const it = await find(o);
    expect(it).toMatchObject({ status: 'CONFIRMED', stage: 'WAITING', customer: expect.stringContaining('Cli'), city: 'Campinas', state: 'SP', warehouse: 'CD01', items: 1, units: 2, weightKg: 1, rush: false, flags: [] });
    expect(it.pickingBy).toBeNull();
    expect((await overview()).stages.waiting).toBeGreaterThanOrEqual(1);
  });

  it('cada etapa grava quem fez e quando; a fila mostra o responsável e as etapas seguintes até a entrega', async () => {
    const o = await newOrder();
    await adv(shipper, o, 'PICKING').expect(200);
    let it = await find(o);
    expect(it).toMatchObject({ stage: 'PICKING', pickingBy: 'Expedidor' });
    expect(it.stageSince).toBeTruthy();
    await adv(shipper, o, 'PACKED').expect(200);
    it = await find(o);
    expect(it).toMatchObject({ stage: 'PACKED', pickingBy: 'Expedidor', packedBy: 'Expedidor' });
    await adv(shipper, o, 'SHIPPED').expect(200);
    expect(await find(o)).toMatchObject({ stage: 'SHIPPED' });
    await adv(shipper, o, 'DELIVERED').expect(200);
    expect(await find(o)).toMatchObject({ stage: 'DELIVERED' });
    const d = (await owner.get(`/api/sales/orders/${o}`).expect(200)).body;
    expect(d.fulfillment).toEqual({ pickingBy: 'Expedidor', packedBy: 'Expedidor' });
    expect(d.pickingStartedAt).toBeTruthy(); expect(d.packedAt).toBeTruthy();
    await adv(shipper, o, 'PACKED').expect(409); // etapa fora de ordem continua recusada
    const ov = await overview();
    expect(ov.shippedToday).toBeGreaterThanOrEqual(1);
    expect(ov.avgHoursToShip).not.toBeNull();
    expect(ov.series).toHaveLength(7);
    expect(ov.series[6].shipped).toBeGreaterThanOrEqual(1);
  });

  it('alertas: atrasado (saída vencida), saem hoje, parado na etapa e divergência na conferência, com os pedidos envolvidos', async () => {
    const late = await newOrder(); const today = await newOrder(); const stuck = await newOrder(); const div = await newOrder();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await admin.$executeRaw`UPDATE sales_orders SET dispatch_date = ${yesterday}::date WHERE id = ${late}::uuid`;
    await admin.$executeRaw`UPDATE sales_orders SET dispatch_date = ${localToday()}::date WHERE id = ${today}::uuid`;
    await adv(shipper, stuck, 'PICKING').expect(200);
    await admin.$executeRaw`UPDATE sales_orders SET picking_started_at = now() - interval '5 hours' WHERE id = ${stuck}::uuid`;
    await admin.orderCheck.create({ data: { tenantId, orderId: div, status: 'DIVERGENT', items: [] } });

    expect((await find(late)).flags).toContain('LATE');
    expect((await find(today)).flags).toEqual(expect.arrayContaining(['DUE_TODAY']));
    expect((await find(stuck)).flags).toContain('STUCK');
    expect((await find(div)).flags).toContain('DIVERGENT');

    const ov = await overview();
    const by = Object.fromEntries(ov.alerts.map((a: any) => [a.key, a]));
    expect(by.LATE.severity).toBe('danger');
    expect(by.LATE.orders.map((x: any) => x.id)).toContain(late);
    expect(by.DUE_TODAY.orders.map((x: any) => x.id)).toContain(today);
    expect(by.STUCK.orders.map((x: any) => x.id)).toContain(stuck);
    expect(by.DIVERGENT.orders.map((x: any) => x.id)).toContain(div);
    expect(ov.late).toBeGreaterThanOrEqual(1); expect(ov.stuck).toBeGreaterThanOrEqual(1); expect(ov.divergent).toBeGreaterThanOrEqual(1);
    // expedir o atrasado tira o alerta dele
    await adv(shipper, late, 'PICKING').expect(200); await adv(shipper, late, 'PACKED').expect(200); await adv(shipper, late, 'SHIPPED').expect(200);
    expect((await find(late)).flags).toEqual([]);
  });

  it('urgência e observação da expedição: marcam, aparecem primeiro na fila, exigem pedido em aberto e ficam auditadas', async () => {
    const a = await newOrder(); const b = await newOrder();
    await shipper.put(`/api/dispatch/orders/${b}/rush`).set(H).send({ rush: true, reason: 'Cliente retira hoje' }).expect(200);
    await shipper.put(`/api/dispatch/orders/${b}/note`).set(H).send({ note: 'Frágil: embalar com plástico bolha' }).expect(200);
    const q = await queue();
    const open = q.filter((x) => x.stage === 'WAITING');
    expect(open[0].id).toBe(b); // urgente primeiro
    expect(q.find((x) => x.id === b)).toMatchObject({ rush: true, rushReason: 'Cliente retira hoje', note: 'Frágil: embalar com plástico bolha' });
    expect(q.find((x) => x.id === b).flags).toContain('RUSH');
    expect((await overview()).alerts.some((x: any) => x.key === 'RUSH')).toBe(true);
    await shipper.put(`/api/dispatch/orders/${b}/rush`).set(H).send({ rush: false }).expect(200);
    expect((await find(b)).rush).toBe(false);
    await seller.put(`/api/dispatch/orders/${a}/rush`).set(H).send({ rush: true }).expect(403);
    await shipper.put(`/api/dispatch/orders/${a}/rush`).set(H).send({ rush: 'sim' }).expect(400);
    await shipper.put(`/api/dispatch/orders/00000000-0000-4000-8000-000000000000/rush`).set(H).send({ rush: true }).expect(404);
    // pedido já expedido não vira urgente
    await adv(shipper, a, 'PICKING').expect(200); await adv(shipper, a, 'PACKED').expect(200); await adv(shipper, a, 'SHIPPED').expect(200);
    await shipper.put(`/api/dispatch/orders/${a}/rush`).set(H).send({ rush: true }).expect(404);
    const log = await admin.auditLog.findMany({ where: { tenantId, action: { in: ['dispatch.rush_set', 'dispatch.note_set'] } } });
    expect(log.length).toBeGreaterThanOrEqual(2);
  });

  it('conferência obrigatória continua valendo ao embalar pela expedição, e outra empresa não vê nada', async () => {
    await owner.put('/api/settings').set(H).send({ 'warehouse.requireCheck': true }).then((r) => { if (r.status >= 400) throw new Error(`settings ${r.status}`); });
    const o = await newOrder();
    await adv(shipper, o, 'PICKING').expect(200);
    await adv(shipper, o, 'PACKED').expect(409);
    await owner.put('/api/settings').set(H).send({ 'warehouse.requireCheck': false }).expect(200);
    await adv(shipper, o, 'PACKED').expect(200);
    const other = agent();
    await other.post('/api/auth/register').set(H).send({ companyName: `Co dp2 ${run}`, name: 'Outro', email: `dp2-${run}@teste.local`, password: PASSWORD }).expect(201);
    expect((await other.get('/api/dispatch/queue').expect(200)).body).toEqual([]);
    const ov = (await other.get('/api/dispatch/overview').expect(200)).body;
    expect(ov.stages).toEqual({ waiting: 0, picking: 0, packed: 0, shipped: 0, delivered: 0 });
    expect(ov.alerts).toEqual([]);
  });
});
