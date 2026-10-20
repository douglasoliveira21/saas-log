import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);
let seq = 0;
const uid = () => `${run}-${++seq}`;

describe('Fase 3 — compras, vendas, devoluções e comissões', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const agent = () => request.agent(app.getHttpServer());
  type Agent = ReturnType<typeof agent>;

  interface T {
    owner: Agent; tenantId: string; wh: string; customer: string;
    roles: Record<string, string>; users: Record<string, { agent: Agent; userId: string }>; salespersonId: string;
  }

  async function setup(label: string): Promise<T> {
    const owner = agent();
    const reg = await owner.post('/api/auth/register').set(H).send({ companyName: `Co ${label} ${run}`, name: `Dono ${label}`, email: `${label}-${run}@teste.local`, password: PASSWORD }).expect(201);
    const company = await owner.post('/api/companies').set(H).send({ legalName: `${label} LTDA` }).expect(201);
    const est = await owner.post('/api/establishments').set(H).send({ companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz' }).expect(201);
    const wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
    const roles = Object.fromEntries((await owner.get('/api/roles').expect(200)).body.map((r: any) => [r.key, r.id]));
    const customer = (await owner.post('/api/customers').set(H).send({ kind: 'PJ', name: 'Cliente Padrão', document: '11.222.333/0001-81' }).expect(201)).body.id;
    const t: T = { owner, tenantId: reg.body.tenantId, wh, customer, roles, users: {}, salespersonId: '' };
    for (const key of ['salesperson', 'commercial_manager', 'buyer', 'ops_manager', 'stock_operator']) await addUser(t, key);
    t.salespersonId = (await owner.post('/api/salespeople').set(H).send({ name: 'Vera Vendedora', userId: t.users.salesperson.userId }).expect(201)).body.id;
    return t;
  }

  async function addUser(t: T, roleKey: string, tag = '') {
    const email = `${roleKey}${tag}-${uid()}@teste.local`;
    const created = await t.owner.post('/api/users').set(H).send({ name: `U ${roleKey}`, email, password: PASSWORD, roleId: t.roles[roleKey] }).expect(201);
    const a = agent();
    await a.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200);
    t.users[roleKey + tag] = { agent: a, userId: created.body.userId };
    return t.users[roleKey + tag];
  }

  const product = async (t: T, extra: object = {}) =>
    (await t.owner.post('/api/products').set(H).send({ sku: `P-${uid()}`, name: 'Produto', suggestedPrice: 100, costPrice: 10, ...extra }).expect(201)).body.id as string;
  const stock = (t: T, productId: string, quantity: number) =>
    t.owner.post('/api/stock/movements').set(H).send({ productId, warehouseId: t.wh, type: 'PURCHASE_ENTRY', quantity }).expect(201);
  const balance = async (t: T, productId: string) =>
    ((await t.owner.get(`/api/stock/balances/${productId}`).expect(200)).body as any[])[0] ?? { onHand: 0, reserved: 0, available: 0 };
  const order = async (t: T, who: Agent, items: object[], extra: object = {}) =>
    (await who.post('/api/sales/orders').set(H).send({ customerId: t.customer, warehouseId: t.wh, items, ...extra }).expect(201)).body as { id: string; number: number };
  const submit = (who: Agent, id: string) => who.post(`/api/sales/orders/${id}/submit`).set(H);
  const advance = (who: Agent, id: string, to: string) => who.post(`/api/sales/orders/${id}/advance`).set(H).send({ to });
  const ship = async (t: T, id: string) => {
    for (const to of ['PICKING', 'PACKED', 'SHIPPED']) await advance(t.users.stock_operator.agent, id, to).expect(200);
  };
  const commissions = async (t: T, id: string) => (await t.owner.get(`/api/commissions?orderId=${id}`).expect(200)).body.entries as any[];
  const net = (rows: any[]) => Math.round(rows.reduce((s, r) => s + Number(r.amount) * 100, 0));

  let A: T;
  let B: T;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    prisma = app.get(PrismaService);
    const { PrismaClient } = await import('@prisma/client');
    const admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    await admin.plan.update({ where: { code: 'trial' }, data: { limits: { users: 100, establishments: 20, warehouses: 20 } } });
    await admin.$disconnect();
    A = await setup('comA');
    B = await setup('comB');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('clientes', () => {
    it('valida CPF/CNPJ, impede duplicidade e permite ao vendedor cadastrar', async () => {
      await A.owner.post('/api/customers').set(H).send({ kind: 'PF', name: 'Maria', document: '529.982.247-24' }).expect(400);
      await A.users.salesperson.agent.post('/api/customers').set(H).send({ kind: 'PF', name: 'Maria', document: '529.982.247-25' }).expect(201);
      await A.owner.post('/api/customers').set(H).send({ kind: 'PF', name: 'Maria 2', document: '52998224725' }).expect(409);
    });
  });

  describe('pedido de venda', () => {
    it('calcula totais em centavos, confirma reservando estoque e expede baixando o físico', async () => {
      const p1 = await product(A, { suggestedPrice: 33.33 });
      const p2 = await product(A);
      await stock(A, p1, 10); await stock(A, p2, 10);
      const o = await order(A, A.users.salesperson.agent, [{ productId: p1, quantity: 3 }, { productId: p2, quantity: 2, unitPrice: 50, discountPct: 10 }], { shipping: 5 });
      const draft = (await A.owner.get(`/api/sales/orders/${o.id}`).expect(200)).body;
      expect(draft).toMatchObject({ status: 'DRAFT', subtotal: '199.99', discountTotal: '10', shipping: '5', total: '194.99' });
      expect((await submit(A.users.salesperson.agent, o.id).expect(200)).body.status).toBe('CONFIRMED');
      expect(await balance(A, p1)).toMatchObject({ onHand: 10, reserved: 3, available: 7 });
      await advance(A.users.salesperson.agent, o.id, 'PICKING').expect(403);
      await advance(A.users.stock_operator.agent, o.id, 'SHIPPED').expect(409);
      await ship(A, o.id);
      expect(await balance(A, p1)).toMatchObject({ onHand: 7, reserved: 0, available: 7 });
      const mv = (await A.owner.get(`/api/stock/movements?productId=${p1}`).expect(200)).body.items;
      expect(mv[0]).toMatchObject({ type: 'SALE_EXIT', quantity: -3 });
      await advance(A.users.stock_operator.agent, o.id, 'DELIVERED').expect(200);
      await advance(A.users.stock_operator.agent, o.id, 'CLOSED').expect(200);
      await A.owner.put(`/api/sales/orders/${o.id}`).set(H).send({ customerId: A.customer, warehouseId: A.wh, items: [{ productId: p1, quantity: 1 }] }).expect(409);
    });

    it('estoque insuficiente recusa a confirmação e não deixa reservas parciais', async () => {
      const ok = await product(A); const scarce = await product(A);
      await stock(A, ok, 10); await stock(A, scarce, 1);
      const o = await order(A, A.owner, [{ productId: ok, quantity: 2 }, { productId: scarce, quantity: 5 }]);
      const r = await submit(A.owner, o.id).expect(409);
      expect(r.body.message).toMatch(/insuficiente/i);
      expect(await balance(A, ok)).toMatchObject({ reserved: 0 });
      expect((await A.owner.get(`/api/sales/orders/${o.id}`).expect(200)).body.status).toBe('DRAFT');
    });

    it('dois pedidos concorrentes pela última unidade: apenas um é confirmado', async () => {
      const p = await product(A);
      await stock(A, p, 5);
      const [o1, o2] = await Promise.all([order(A, A.owner, [{ productId: p, quantity: 5 }]), order(A, A.owner, [{ productId: p, quantity: 5 }])]);
      const rs = await Promise.all([submit(A.owner, o1.id), submit(A.owner, o2.id)]);
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await balance(A, p)).toMatchObject({ reserved: 5, available: 0 });
    });

    it('confirmar duas vezes em paralelo não reserva em duplicidade', async () => {
      const p = await product(A);
      await stock(A, p, 10);
      const o = await order(A, A.owner, [{ productId: p, quantity: 4 }]);
      const rs = await Promise.all([submit(A.owner, o.id), submit(A.owner, o.id), submit(A.owner, o.id)]);
      expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
      expect(await balance(A, p)).toMatchObject({ reserved: 4 });
    });

    it('desconto acima do limite ou preço abaixo do mínimo exige aprovação de outro usuário com alçada', async () => {
      const p = await product(A, { minPrice: 90 });
      await stock(A, p, 20);
      const sp = A.users.salesperson.agent;
      const o = await order(A, sp, [{ productId: p, quantity: 2, discountPct: 15 }]);
      const s = (await submit(sp, o.id).expect(200)).body;
      expect(s.status).toBe('PENDING_APPROVAL');
      expect(s.reasons.length).toBe(2);
      expect(await balance(A, p)).toMatchObject({ reserved: 0 });
      await sp.post(`/api/sales/orders/${o.id}/approve`).set(H).expect(403);
      const mgr = A.users.commercial_manager.agent;
      await mgr.post(`/api/sales/orders/${o.id}/approve`).set(H).expect(200);
      expect(await balance(A, p)).toMatchObject({ reserved: 2 });

      // gerente não aprova o próprio pedido; proprietário pode
      const o2 = await order(A, mgr, [{ productId: p, quantity: 1, discountPct: 50 }]);
      await submit(mgr, o2.id).expect(200);
      await mgr.post(`/api/sales/orders/${o2.id}/approve`).set(H).expect(403);
      await A.owner.post(`/api/sales/orders/${o2.id}/approve`).set(H).expect(200);

      // rejeição devolve a rascunho
      const o3 = await order(A, sp, [{ productId: p, quantity: 1, discountPct: 30 }]);
      await submit(sp, o3.id).expect(200);
      await mgr.post(`/api/sales/orders/${o3.id}/reject`).set(H).send({ reason: 'margem' }).expect(200);
      expect((await A.owner.get(`/api/sales/orders/${o3.id}`)).body.status).toBe('DRAFT');
    });

    it('cancelamento libera reservas, estorna comissão e não pode ser repetido nem feito após expedição', async () => {
      const p = await product(A);
      await stock(A, p, 10);
      await A.owner.post('/api/commission-rules').set(H).send({ name: `cancel-${uid()}`, kind: 'PERCENT', percent: 5, priority: 1, productId: p }).expect(201);
      const o = await order(A, A.users.salesperson.agent, [{ productId: p, quantity: 4 }]);
      await submit(A.users.salesperson.agent, o.id).expect(200);
      expect(net(await commissions(A, o.id))).toBe(2000);
      await A.users.salesperson.agent.post(`/api/sales/orders/${o.id}/cancel`).set(H).send({ reason: 'cliente desistiu' }).expect(200);
      await A.users.salesperson.agent.post(`/api/sales/orders/${o.id}/cancel`).set(H).send({ reason: 'de novo' }).expect(409);
      expect(await balance(A, p)).toMatchObject({ reserved: 0, available: 10 });
      const entries = await commissions(A, o.id);
      expect(entries.map((e) => e.kind).sort()).toEqual(['ACCRUAL', 'REVERSAL']); // histórico preservado
      expect(net(entries)).toBe(0);

      const o2 = await order(A, A.users.salesperson.agent, [{ productId: p, quantity: 1 }]);
      await submit(A.users.salesperson.agent, o2.id).expect(200);
      await ship(A, o2.id);
      await A.owner.post(`/api/sales/orders/${o2.id}/cancel`).set(H).send({ reason: 'tarde demais' }).expect(409);
    });
  });

  describe('devoluções', () => {
    it('devolução parcial e total: repõe estoque, valida limites e estorna a comissão sem deriva de arredondamento', async () => {
      const p = await product(A, { suggestedPrice: 33.33 });
      await A.owner.post('/api/commission-rules').set(H).send({ name: `ret-${uid()}`, kind: 'PERCENT', percent: 5, priority: 5, productId: p }).expect(201);
      await stock(A, p, 10);
      const o = await order(A, A.users.salesperson.agent, [{ productId: p, quantity: 3 }]);
      await submit(A.users.salesperson.agent, o.id).expect(200);
      const detail = (await A.owner.get(`/api/sales/orders/${o.id}`).expect(200)).body;
      const itemId = detail.items[0].id;
      const ret = (qty: number) => A.owner.post(`/api/sales/orders/${o.id}/returns`).set(H).send({ reason: 'defeito', items: [{ orderItemId: itemId, quantity: qty }] });
      await ret(1).expect(409); // ainda não expedido
      await ship(A, o.id);
      expect(Number((await commissions(A, o.id))[0].amount)).toBe(5); // 5% de 99,99 = 5,00 (arredondado)
      await ret(1).expect(201);
      await ret(1).expect(201);
      await ret(2).expect(409); // excede o vendido
      await ret(1).expect(201);
      expect(net(await commissions(A, o.id))).toBe(0);
      expect(await balance(A, p)).toMatchObject({ onHand: 10 });
      const after = (await A.owner.get(`/api/sales/orders/${o.id}`).expect(200)).body;
      expect(after.items[0].returnedQty).toBe(3);
    });

    it('devolução sem reposição (avaria) não altera o estoque', async () => {
      const p = await product(A);
      await stock(A, p, 5);
      const o = await order(A, A.owner, [{ productId: p, quantity: 2 }]);
      await submit(A.owner, o.id).expect(200);
      await ship(A, o.id);
      const itemId = (await A.owner.get(`/api/sales/orders/${o.id}`)).body.items[0].id;
      await A.owner.post(`/api/sales/orders/${o.id}/returns`).set(H).send({ reason: 'avariado', restock: false, items: [{ orderItemId: itemId, quantity: 2 }] }).expect(201);
      expect(await balance(A, p)).toMatchObject({ onHand: 3 });
    });
  });

  describe('comissões', () => {
    let C: T;
    beforeAll(async () => { C = await setup('comC'); });

    it('escolhe uma única regra por prioridade/especificidade, respeita o evento configurado e paga uma vez', async () => {
      const cat = (await C.owner.post('/api/categories').set(H).send({ name: 'Cat X' }).expect(201)).body.id;
      const p = await product(C, { categoryId: cat, suggestedPrice: 200 });
      const q = await product(C, { suggestedPrice: 200 });
      await stock(C, p, 20); await stock(C, q, 20);
      const rule = (body: object) => C.owner.post('/api/commission-rules').set(H).send(body).expect(201);
      await rule({ name: 'Geral 2%', kind: 'PERCENT', percent: 2, priority: 0 });
      await rule({ name: 'Categoria 4%', kind: 'PERCENT', percent: 4, priority: 0, categoryId: cat });
      await rule({ name: 'Vendedora+categoria 6%', kind: 'PERCENT', percent: 6, priority: 0, categoryId: cat, salespersonId: C.salespersonId });
      await rule({ name: 'Fixo por unidade (prioridade)', kind: 'FIXED_PER_UNIT', fixedAmount: 1.5, priority: 9, productId: q });
      await C.owner.post('/api/commission-rules').set(H).send({ name: 'x', kind: 'PERCENT' }).expect(400);
      await C.owner.post('/api/commission-rules').set(H).send({ name: 'x', kind: 'PERCENT', percent: 5, productId: A.customer }).expect(400);

      const sp = C.users.salesperson.agent;
      const o = await order(C, sp, [{ productId: p, quantity: 2 }, { productId: q, quantity: 4 }]); // 400 + 800
      await submit(sp, o.id).expect(200);
      const entries = (await commissions(C, o.id)).filter((e) => e.kind === 'ACCRUAL');
      expect(entries).toHaveLength(2); // uma regra por item
      expect(entries.map((e) => Number(e.amount)).sort((a, b) => a - b)).toEqual([6, 24]); // 6 (4×1,50) e 24 (6% de 400)
      expect(entries.every((e) => e.status === 'EARNED')).toBe(true); // evento padrão: pedido aprovado

      // política "entregue": novo pedido fica previsto até a entrega
      await C.owner.put('/api/settings').set(H).send({ 'commission.event': 'DELIVERED' }).expect(200);
      await C.owner.put('/api/settings').set(H).send({ 'commission.event': 'FATURADO' }).expect(400);
      const o2 = await order(C, sp, [{ productId: p, quantity: 1 }]);
      await submit(sp, o2.id).expect(200);
      expect((await commissions(C, o2.id))[0].status).toBe('FORECAST');
      await ship(C, o2.id);
      expect((await commissions(C, o2.id))[0].status).toBe('FORECAST');
      await advance(C.users.stock_operator.agent, o2.id, 'DELIVERED').expect(200);
      expect((await commissions(C, o2.id))[0].status).toBe('EARNED');
      await C.owner.put('/api/settings').set(H).send({ 'commission.event': 'CONFIRMED' }).expect(200);

      const before = (await C.owner.get('/api/commissions').expect(200)).body.summary[C.salespersonId];
      expect(Number(before.EARNED)).toBe(42); // 6 + 24 + 12 (6% de 200)
      const paid = await C.owner.post('/api/commissions/pay').set(H).send({ salespersonId: C.salespersonId }).expect(200);
      expect(paid.body.paid).toBe('42.00');
      await C.owner.post('/api/commissions/pay').set(H).send({ salespersonId: C.salespersonId }).expect(409);
      const after = (await C.owner.get('/api/commissions').expect(200)).body.summary[C.salespersonId];
      expect(after).toMatchObject({ EARNED: '0.00', PAID: '42.00' });
      await C.users.salesperson.agent.post('/api/commissions/pay').set(H).send({ salespersonId: C.salespersonId }).expect(403);
    });

    it('devolução após o pagamento gera saldo negativo a descontar (nada é apagado)', async () => {
      const p = await product(C, { suggestedPrice: 100 });
      await stock(C, p, 10);
      await C.owner.post('/api/commission-rules').set(H).send({ name: `solo-${uid()}`, kind: 'PERCENT', percent: 10, priority: 50, productId: p }).expect(201);
      const sp = C.users.salesperson.agent;
      const o = await order(C, sp, [{ productId: p, quantity: 2 }]);
      await submit(sp, o.id).expect(200);
      await ship(C, o.id);
      await C.owner.post('/api/commissions/pay').set(H).send({ salespersonId: C.salespersonId }).expect(200);
      const itemId = (await C.owner.get(`/api/sales/orders/${o.id}`)).body.items[0].id;
      await C.owner.post(`/api/sales/orders/${o.id}/returns`).set(H).send({ reason: 'troca', items: [{ orderItemId: itemId, quantity: 2 }] }).expect(201);
      const entries = await commissions(C, o.id);
      expect(entries.map((e) => e.status).sort()).toEqual(['EARNED', 'PAID']);
      expect(net(entries)).toBe(0);
      await C.owner.post('/api/commissions/pay').set(H).send({ salespersonId: C.salespersonId }).expect(409); // saldo negativo não é pago
    });

    it('vendedor enxerga apenas seus pedidos e comissões; gestor vê tudo', async () => {
      const second = await addUser(C, 'salesperson', 'B');
      await C.owner.post('/api/salespeople').set(H).send({ name: 'Outro', userId: second.userId }).expect(201);
      const p = await product(C);
      await stock(C, p, 10);
      const mine = await order(C, C.users.salesperson.agent, [{ productId: p, quantity: 1 }]);
      const theirs = await order(C, second.agent, [{ productId: p, quantity: 1 }]);
      await C.users.salesperson.agent.get(`/api/sales/orders/${theirs.id}`).expect(404);
      await second.agent.get(`/api/sales/orders/${mine.id}`).expect(404);
      await C.users.salesperson.agent.post(`/api/sales/orders/${theirs.id}/cancel`).set(H).send({ reason: 'x' }).expect(404);
      const list = (await C.users.salesperson.agent.get('/api/sales/orders').expect(200)).body.items.map((i: any) => i.number);
      expect(list).toContain(mine.number);
      expect(list).not.toContain(theirs.number);
      const all = (await C.users.commercial_manager.agent.get('/api/sales/orders?limit=200').expect(200)).body.items.map((i: any) => i.number);
      expect(all).toEqual(expect.arrayContaining([mine.number, theirs.number]));
      // vendedor só vende em seu próprio nome
      const forged = await C.users.salesperson.agent.post('/api/sales/orders').set(H).send({ customerId: C.customer, warehouseId: C.wh, salespersonId: C.salespersonId, items: [{ productId: p, quantity: 1 }] }).expect(201);
      const d = (await C.owner.get(`/api/sales/orders/${forged.body.id}`)).body;
      expect(d.salesperson.name).toBe('Vera Vendedora');
      const d2 = (await C.owner.get(`/api/sales/orders/${theirs.id}`)).body;
      expect(d2.salesperson.name).toBe('Outro');
    });
  });

  describe('compras e recebimento', () => {
    const po = (t: T, body: object) => t.users.buyer.agent.post('/api/purchases').set(H).send(body);
    let supplier: string;

    beforeAll(async () => {
      supplier = (await A.owner.post('/api/suppliers').set(H).send({ legalName: 'Fornecedor Compras SA' }).expect(201)).body.id;
    });

    it('até o limite aprova automaticamente; acima exige alçada de outro usuário; recebimento parcial e total', async () => {
      const p = await product(A, { costPrice: 10 });
      await stock(A, p, 10);
      const small = (await po(A, { supplierId: supplier, warehouseId: A.wh, items: [{ productId: p, quantity: 10, unitCost: 20 }], freight: 10 }).expect(201)).body;
      expect((await A.users.buyer.agent.get(`/api/purchases/${small.id}`).expect(200)).body.total).toBe('210');
      expect((await A.users.buyer.agent.post(`/api/purchases/${small.id}/submit`).set(H).expect(200)).body.status).toBe('APPROVED');

      const big = (await po(A, { supplierId: supplier, warehouseId: A.wh, items: [{ productId: p, quantity: 1000, unitCost: 20 }] }).expect(201)).body;
      expect((await A.users.buyer.agent.post(`/api/purchases/${big.id}/submit`).set(H).expect(200)).body.status).toBe('PENDING_APPROVAL');
      await A.users.buyer.agent.post(`/api/purchases/${big.id}/approve`).set(H).expect(403);
      await A.users.buyer.agent.post(`/api/purchases/${big.id}/receipts`).set(H).send({ items: [{ productId: p, quantity: 1 }] }).expect(403);
      await A.users.ops_manager.agent.post(`/api/purchases/${big.id}/receipts`).set(H).send({ items: [{ productId: p, quantity: 1 }] }).expect(409); // ainda não aprovada
      await A.users.ops_manager.agent.post(`/api/purchases/${big.id}/approve`).set(H).expect(200);
      await A.users.ops_manager.agent.post(`/api/purchases/${big.id}/cancel`).set(H).send({ reason: 'teste' }).expect(200);

      const ops = A.users.ops_manager.agent;
      const r1 = await ops.post(`/api/purchases/${small.id}/receipts`).set(H).send({ items: [{ productId: p, quantity: 6 }] }).expect(201);
      await ops.post(`/api/purchases/${small.id}/receipts`).set(H).send({ items: [{ productId: p, quantity: 5 }] }).expect(409); // pendente 4
      expect((await ops.get(`/api/purchases/${small.id}`)).body.status).toBe('PARTIALLY_RECEIVED');
      expect(await balance(A, p)).toMatchObject({ onHand: 16 });
      await ops.post(`/api/purchases/${small.id}/receipts`).set(H).send({ items: [{ productId: p, quantity: 4 }] }).expect(201);
      expect((await ops.get(`/api/purchases/${small.id}`)).body.status).toBe('RECEIVED');
      // custo médio ponderado: (10×10 + 10×20) / 20 = 15
      expect(Number((await A.owner.get(`/api/products/${p}`)).body.costPrice)).toBe(15);

      await ops.post(`/api/purchases/receipts/${r1.body.receipt.id}/reverse`).set(H).send({ reason: 'nota errada' }).expect(200);
      await ops.post(`/api/purchases/receipts/${r1.body.receipt.id}/reverse`).set(H).send({ reason: 'de novo' }).expect(409);
      expect(await balance(A, p)).toMatchObject({ onHand: 14 });
      const d = (await ops.get(`/api/purchases/${small.id}`)).body;
      expect(d.status).toBe('PARTIALLY_RECEIVED');
      expect(d.items[0].qtyReceived).toBe(4);
      const closed = await ops.post(`/api/purchases/${small.id}/close`).set(H).send({ reason: 'fornecedor não enviou o restante' }).expect(200);
      expect(closed.body.missing[0].missing).toBe(6);
    });

    it('recebimento repetido com a mesma chave (inclusive em paralelo) tem um único efeito', async () => {
      const p = await product(A);
      const o = (await po(A, { supplierId: supplier, warehouseId: A.wh, items: [{ productId: p, quantity: 10, unitCost: 5 }] }).expect(201)).body;
      await A.users.buyer.agent.post(`/api/purchases/${o.id}/submit`).set(H).expect(200);
      const body = { idempotencyKey: `rcpt-${uid()}`, items: [{ productId: p, quantity: 10 }] };
      const rs = await Promise.all([1, 2, 3].map(() => A.users.ops_manager.agent.post(`/api/purchases/${o.id}/receipts`).set(H).send(body)));
      expect(rs.every((r) => r.status === 201)).toBe(true);
      expect(new Set(rs.map((r) => r.body.receipt.id)).size).toBe(1);
      expect(await balance(A, p)).toMatchObject({ onHand: 10 });
    });

    it('sugestão de reposição traz justificativa e considera ordens em andamento', async () => {
      const p = await product(A, { minStock: 20, maxStock: 50 });
      await stock(A, p, 5);
      let s = (await A.users.buyer.agent.get('/api/purchases/suggestions').expect(200)).body.find((x: any) => x.productId === p);
      expect(s).toMatchObject({ suggestedQty: 45 });
      expect(s.reason).toMatch(/ponto de reposição/);
      const o = (await po(A, { supplierId: supplier, warehouseId: A.wh, items: [{ productId: p, quantity: 45, unitCost: 1 }] }).expect(201)).body;
      await A.users.buyer.agent.post(`/api/purchases/${o.id}/submit`).set(H).expect(200);
      s = (await A.users.buyer.agent.get('/api/purchases/suggestions').expect(200)).body.find((x: any) => x.productId === p);
      expect(s).toBeUndefined();
    });
  });

  describe('isolamento e auditoria', () => {
    it('tenant B não acessa nem referencia pedidos, compras, clientes, vendedores ou regras do tenant A', async () => {
      const p = await product(A);
      await stock(A, p, 5);
      const o = await order(A, A.owner, [{ productId: p, quantity: 1 }]);
      const supplier = (await A.owner.post('/api/suppliers').set(H).send({ legalName: 'Forn Iso' }).expect(201)).body.id;
      const pur = (await A.owner.post('/api/purchases').set(H).send({ supplierId: supplier, warehouseId: A.wh, items: [{ productId: p, quantity: 1, unitCost: 1 }] }).expect(201)).body;
      await B.owner.get(`/api/sales/orders/${o.id}`).expect(404);
      await B.owner.post(`/api/sales/orders/${o.id}/cancel`).set(H).send({ reason: 'x' }).expect(404);
      await B.owner.get(`/api/purchases/${pur.id}`).expect(404);
      await B.owner.post(`/api/purchases/${pur.id}/submit`).set(H).expect(404);
      const pb = await product(B); await stock(B, pb, 3);
      await B.owner.post('/api/sales/orders').set(H).send({ customerId: A.customer, warehouseId: B.wh, items: [{ productId: pb, quantity: 1 }] }).expect(400);
      await B.owner.post('/api/sales/orders').set(H).send({ customerId: B.customer, warehouseId: A.wh, items: [{ productId: pb, quantity: 1 }] }).expect(400);
      await B.owner.post('/api/sales/orders').set(H).send({ customerId: B.customer, warehouseId: B.wh, items: [{ productId: p, quantity: 1 }] }).expect(400);
      await B.owner.post('/api/commission-rules').set(H).send({ name: 'x', kind: 'PERCENT', percent: 1, salespersonId: A.salespersonId }).expect(400);
      expect((await B.owner.get('/api/customers').expect(200)).body.map((c: any) => c.id)).not.toContain(A.customer);
      expect(JSON.stringify((await B.owner.get('/api/commissions').expect(200)).body)).not.toContain(A.salespersonId);
    });

    it('numeração por tenant é sequencial e a auditoria registra o fluxo; livro de comissões não aceita DELETE', async () => {
      const p = await product(B); await stock(B, p, 5);
      const a = await order(B, B.owner, [{ productId: p, quantity: 1 }]);
      const b = await order(B, B.owner, [{ productId: p, quantity: 1 }]);
      expect(b.number).toBe(a.number + 1);
      await submit(B.owner, a.id).expect(200);
      const actions = (await B.owner.get('/api/audit?limit=100').expect(200)).body.items.map((i: any) => i.action);
      expect(actions).toEqual(expect.arrayContaining(['sales.created', 'sales.confirmed', 'customer.created', 'salesperson.created']));
      await expect(prisma.withContext({ tenantId: B.tenantId }, (tx) => tx.salesCommission.deleteMany({}))).rejects.toThrow();
    });
  });
});
