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

describe('Venda: tabela varejo/atacado, vendedor automático, carteira de clientes, gráficos, impressão e impostos federais', () => {
  let app: INestApplication; let admin: PrismaClient;
  const agent = () => request.agent(app.getHttpServer());
  type Agent = ReturnType<typeof agent>;
  let owner: Agent; let ana: Agent; let beto: Agent; let accountant: Agent; let tenantId: string; let wh: string; let companyId: string;
  const P: Record<string, string> = {};

  async function user(roleKey: string, name: string) {
    const roles = Object.fromEntries((await owner.get('/api/roles').expect(200)).body.map((r: any) => [r.key, r.id]));
    const email = `${name.toLowerCase()}-${uid()}@teste.local`;
    await owner.post('/api/users').set(H).send({ name, email, password: PASSWORD, roleId: roles[roleKey] }).expect(201);
    const a = agent(); await a.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200);
    return a;
  }
  async function product(key: string, retail: number, wholesale: number | null, stock = 500) {
    P[key] = (await owner.post('/api/products').set(H).send({ sku: `SX-${key}-${uid()}`, name: `Produto ${key}`, costPrice: 1, suggestedPrice: retail, ...(wholesale !== null ? { wholesalePrice: wholesale } : {}) }).expect(201)).body.id;
    await owner.post('/api/stock/movements').set(H).send({ productId: P[key], warehouseId: wh, type: 'PURCHASE_ENTRY', quantity: stock }).expect(201);
  }
  const customer = async (a: Agent, name: string, extra: object = {}) => (await a.post('/api/customers').set(H).send({ kind: 'PF', name: `${name} ${uid()}`, ...extra }).expect(201)).body;
  const order = async (a: Agent, customerId: string, items: object[], extra: object = {}) => (await a.post('/api/sales/orders').set(H).send({ customerId, warehouseId: wh, items, ...extra }).expect(201)).body.id as string;
  const detail = async (a: Agent, id: string) => (await a.get(`/api/sales/orders/${id}`).expect(200)).body;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication(); configureApp(app); await app.listen(0);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    owner = agent();
    const r = await owner.post('/api/auth/register').set(H).send({ companyName: `Co sx ${run}`, name: 'Dona Maria', email: `sx-${run}@teste.local`, password: PASSWORD }).expect(201);
    tenantId = r.body.tenantId;
    await admin.plan.update({ where: { code: 'trial' }, data: { limits: { users: 100, establishments: 20, warehouses: 20 } } });
    companyId = (await owner.post('/api/companies').set(H).send({ legalName: 'SX LTDA', tradeName: 'SX Distribuidora', taxRegime: 'SIMPLES_NACIONAL' }).expect(201)).body.id;
    const est = await owner.post('/api/establishments').set(H).send({ companyId, kind: 'MATRIZ', name: 'Matriz', city: 'Belo Horizonte', state: 'MG', street: 'Rua A', number: '1', district: 'Centro' }).expect(201);
    wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
    await product('a', 10, 8); await product('b', 20, null);
    ana = await user('salesperson', 'Ana'); beto = await user('salesperson', 'Beto'); accountant = await user('accountant', 'Contador');
  }, 90_000);
  afterAll(async () => { await admin.$disconnect(); await app.close(); });

  it('preço de varejo e de atacado no produto; a venda usa a tabela do cliente ou a escolhida, e cai no varejo se o produto não tem atacado', async () => {
    const p = (await owner.get(`/api/products/${P.a}`).expect(200)).body;
    expect(Number(p.wholesalePrice)).toBe(8);
    await owner.patch(`/api/products/${P.a}`).set(H).send({ wholesalePrice: 7.5 }).expect(200);
    await owner.patch(`/api/products/${P.a}`).set(H).send({ wholesalePrice: -1 }).expect(400);
    const retail = await customer(owner, 'Varejista');
    const wholesaler = await customer(owner, 'Atacadista', { priceTable: 'WHOLESALE' });
    await owner.patch(`/api/customers/${wholesaler.id}`).set(H).send({ priceTable: 'OUTRA' }).expect(400);

    const o1 = await detail(owner, await order(owner, retail.id, [{ productId: P.a, quantity: 2 }]));
    expect([o1.priceTable, Number(o1.items[0].unitPrice)]).toEqual(['RETAIL', 10]);
    const o2 = await detail(owner, await order(owner, wholesaler.id, [{ productId: P.a, quantity: 2 }, { productId: P.b, quantity: 1 }]));
    expect(o2.priceTable).toBe('WHOLESALE'); // padrão do cliente
    expect(Object.fromEntries(o2.items.map((i: any) => [i.product.sku.split('-')[1], Number(i.unitPrice)]))).toEqual({ a: 7.5, b: 20 }); // b sem atacado → varejo
    const o3 = await detail(owner, await order(owner, wholesaler.id, [{ productId: P.a, quantity: 1 }], { priceTable: 'RETAIL' })); // escolhida na venda
    expect([o3.priceTable, Number(o3.items[0].unitPrice)]).toEqual(['RETAIL', 10]);
    const o4 = await detail(owner, await order(owner, retail.id, [{ productId: P.a, quantity: 1 }], { priceTable: 'WHOLESALE' }));
    expect(Number(o4.items[0].unitPrice)).toBe(7.5);
    const o5 = await detail(owner, await order(owner, retail.id, [{ productId: P.a, quantity: 1, unitPrice: 9.1 }], { priceTable: 'WHOLESALE' }));
    expect(Number(o5.items[0].unitPrice)).toBe(9.1); // preço digitado manda
    await owner.post('/api/sales/orders').set(H).send({ customerId: retail.id, warehouseId: wh, priceTable: 'X', items: [{ productId: P.a, quantity: 1 }] }).expect(400);
  });

  it('o vendedor da venda é o usuário logado: cria o cadastro de vendedor com o nome dele e reaproveita nas próximas', async () => {
    expect((await owner.get('/api/salespeople').expect(200)).body.some((s: any) => s.name === 'Ana')).toBe(false);
    const c = await customer(ana, 'Cliente da Ana');
    const o = await detail(ana, await order(ana, c.id, [{ productId: P.a, quantity: 1 }]));
    expect(o.salesperson.name).toBe('Ana');
    const o2 = await detail(ana, await order(ana, c.id, [{ productId: P.b, quantity: 1 }]));
    expect(o2.salesperson.id).toBe(o.salesperson.id);
    expect((await owner.get('/api/salespeople').expect(200)).body.filter((s: any) => s.name === 'Ana')).toHaveLength(1);
    // quem enxerga todas as vendas também entra como vendedor, e pode indicar outro
    const od = await detail(owner, await order(owner, c.id, [{ productId: P.a, quantity: 1 }]));
    expect(od.salesperson.name).toBe('Dona Maria');
    const ob = await detail(owner, await order(owner, c.id, [{ productId: P.a, quantity: 1 }], { salespersonId: o.salesperson.id }));
    expect(ob.salesperson.name).toBe('Ana');
    // vendedor comum não vende em nome de outro
    const spOwner = od.salesperson.id;
    expect((await detail(ana, await order(ana, c.id, [{ productId: P.a, quantity: 1 }], { salespersonId: spOwner }))).salesperson.name).toBe('Ana');
  });

  it('carteira de clientes: cliente cadastrado por vendedor entra na carteira dele; primeira venda adota cliente sem dono; cada um vê a sua; admin vê todas e transfere', async () => {
    const mineA = await customer(ana, 'Carteira A');
    const semDono = await customer(owner, 'Sem dono');
    await admin.customer.update({ where: { id: semDono.id }, data: { salespersonId: null } }); // (o administrador também é vendedor: o cliente dele entra na carteira dele)
    const delBeto = await customer(beto, 'Carteira B');
    expect((await admin.customer.findUniqueOrThrow({ where: { id: semDono.id } })).salespersonId).toBeNull();
    await order(beto, semDono.id, [{ productId: P.a, quantity: 1 }]); // adota
    const listA = (await ana.get('/api/portfolio').expect(200)).body.items.map((x: any) => x.id);
    expect(listA).toContain(mineA.id); expect(listA).not.toContain(delBeto.id); expect(listA).not.toContain(semDono.id);
    const listB = (await beto.get('/api/portfolio').expect(200)).body.items.map((x: any) => x.id);
    expect(listB).toEqual(expect.arrayContaining([delBeto.id, semDono.id]));
    // vendedor não escolhe a carteira de outro nem consulta a de outro
    const spBeto = (await ana.get('/api/portfolio/summary').expect(200)).body;
    expect(spBeto.canSeeAll).toBe(false); expect(spBeto.salespeople).toHaveLength(1);
    const betoId = (await beto.get('/api/portfolio/summary').expect(200)).body.mineId;
    expect((await ana.get(`/api/portfolio?salespersonId=${betoId}`).expect(200)).body.items.map((x: any) => x.id)).not.toContain(delBeto.id); // o parâmetro é ignorado
    await ana.patch(`/api/customers/${mineA.id}`).set(H).send({ salespersonId: betoId }).expect(403);
    await ana.put('/api/portfolio/transfer').set(H).send({ customerIds: [mineA.id], salespersonId: betoId }).expect(403);
    // administrador
    const sum = (await owner.get('/api/portfolio/summary').expect(200)).body;
    expect(sum.canSeeAll).toBe(true); expect(sum.salespeople.length).toBeGreaterThanOrEqual(2);
    const allB = (await owner.get(`/api/portfolio?salespersonId=${betoId}`).expect(200)).body.items;
    expect(allB.map((x: any) => x.name)).toEqual(expect.arrayContaining([delBeto.name]));
    expect(allB[0]).toHaveProperty('sold12m'); expect(allB[0]).toHaveProperty('openBalance');
    const none = (await owner.get('/api/portfolio?salespersonId=none').expect(200)).body.items.map((x: any) => x.id);
    expect(none).not.toContain(delBeto.id);
    await owner.get('/api/portfolio?salespersonId=lixo').expect(400);
    expect((await owner.put('/api/portfolio/transfer').set(H).send({ customerIds: [mineA.id], salespersonId: betoId }).expect(200)).body.moved).toBe(1);
    expect((await beto.get('/api/portfolio').expect(200)).body.items.map((x: any) => x.id)).toContain(mineA.id);
    expect((await owner.put('/api/portfolio/transfer').set(H).send({ customerIds: [mineA.id], salespersonId: null }).expect(200)).body.moved).toBe(1);
    await owner.put('/api/portfolio/transfer').set(H).send({ customerIds: [mineA.id], salespersonId: '00000000-0000-4000-8000-000000000000' }).expect(400);
  });

  it('gráficos do dashboard: clientes, produtos (com "Outros") e vendedores; vendedor só vê as próprias vendas', async () => {
    for (let i = 0; i < 8; i++) await product(`g${i}`, 10 + i, null);
    const big = await customer(owner, 'Cliente Grande'); const small = await customer(owner, 'Cliente Pequeno');
    await order(owner, big.id, [{ productId: P.g7, quantity: 50 }, { productId: P.g6, quantity: 20 }, ...[0, 1, 2, 3, 4, 5].map((i) => ({ productId: P[`g${i}`], quantity: 1 }))]);
    await order(owner, small.id, [{ productId: P.g0, quantity: 1 }]);
    for (const o of (await owner.get('/api/sales/orders?limit=200').expect(200)).body.items) if (o.status === 'DRAFT') await owner.post(`/api/sales/orders/${o.id}/submit`).set(H).expect(200);
    const c = (await owner.get('/api/dashboard/sales-charts?days=30').expect(200)).body;
    expect(c.topCustomers[0].name).toMatch(/Cliente Grande/);
    expect(c.topCustomers[0].total).toBeGreaterThan(c.topCustomers[c.topCustomers.length - 1].total - 0.01);
    expect(c.topProducts.length).toBeLessThanOrEqual(8);
    expect(c.topProducts[0].total).toBeGreaterThanOrEqual(c.topProducts[1].total);
    expect(c.topProducts.some((p: any) => /^Outros/.test(p.name))).toBe(true);
    expect(c.bySalesperson.map((s: any) => s.name)).toEqual(expect.arrayContaining(['Dona Maria']));
    expect(c.bySalesperson.every((s: any, i: number, a: any[]) => i === 0 || a[i - 1].total >= s.total)).toBe(true);
    const mine = (await ana.get('/api/dashboard/sales-charts?days=30').expect(200)).body;
    expect(mine.bySalesperson.every((s: any) => s.name === 'Ana')).toBe(true);
    expect(mine.topCustomers.map((x: any) => x.name).join()).not.toMatch(/Cliente Grande/);
    await owner.get('/api/dashboard/sales-charts?days=999').expect(400);
  });

  it('impressão da venda e notas na venda: dados da empresa, logotipo, escopo do vendedor e documento de outra venda', async () => {
    const c = await customer(ana, 'Cliente Print');
    const o = await order(ana, c.id, [{ productId: P.a, quantity: 3 }], { paymentMethod: 'PIX' });
    const pr = (await ana.get(`/api/sales/orders/${o}/print`).expect(200)).body;
    expect(pr.company).toMatchObject({ name: 'SX Distribuidora', legalName: 'SX LTDA' });
    expect(pr.company.address).toContain('Belo Horizonte');
    expect(pr.logo).toBeNull();
    expect(pr.order.items[0]).toMatchObject({ quantity: 3 });
    expect(pr.order.fiscalDocuments).toEqual([]);
    const fake = Buffer.alloc(400, 7); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(fake, 0); fake.writeUInt32BE(13, 8); fake.write('IHDR', 12, 'latin1'); fake.writeUInt32BE(200, 16); fake.writeUInt32BE(80, 20);
    const png = fake.toString('base64');
    await owner.put('/api/branding/logo').set(H).send({ contentType: 'image/png', contentBase64: png }).expect(200);
    expect((await ana.get(`/api/sales/orders/${o}/print`).expect(200)).body.logo).toMatch(/^data:image\/png;base64,/);
    await beto.get(`/api/sales/orders/${o}/print`).expect(404); // venda de outro vendedor
    await ana.get(`/api/sales/orders/${o}/documents/00000000-0000-4000-8000-000000000000/file`).expect(404);
  });

  it('impostos federais: grava por empresa, valida UF/CST/alíquotas, só quem tem permissão altera e outra empresa não vê', async () => {
    const ok = { regime: 'LUCRO_REAL', pisRate: 1.65, cofinsRate: 7.6, scArticle: 'Art. 1º', showTotalTaxes: true, presumedCredit: false, exceededSublimit: false, icmsByUf: [{ uf: 'MG', cst: '00', ratePct: 18 }, { uf: 'SP', cst: '102' }], ibsCbsByUf: [{ uf: 'MG', cst: '000', classification: '000001' }] };
    const before = (await owner.get('/api/fiscal/federal-taxes').expect(200)).body;
    expect(before.find((x: any) => x.company.id === companyId).config).toBeNull();
    await owner.put(`/api/fiscal/federal-taxes/${companyId}`).set(H).send(ok).expect(200);
    const got = (await accountant.get('/api/fiscal/federal-taxes').expect(200)).body.find((x: any) => x.company.id === companyId).config;
    expect(got).toMatchObject({ regime: 'LUCRO_REAL', pisRate: 1.65, cofinsRate: 7.6, showTotalTaxes: true });
    expect(got.icmsByUf).toHaveLength(2);
    await owner.put(`/api/fiscal/federal-taxes/${companyId}`).set(H).send({ ...ok, pisRate: 101 }).expect(400);
    await owner.put(`/api/fiscal/federal-taxes/${companyId}`).set(H).send({ ...ok, regime: 'OUTRO' }).expect(400);
    await owner.put(`/api/fiscal/federal-taxes/${companyId}`).set(H).send({ ...ok, icmsByUf: [{ uf: 'XX', cst: '00' }] }).expect(400);
    await owner.put(`/api/fiscal/federal-taxes/${companyId}`).set(H).send({ ...ok, icmsByUf: [{ uf: 'MG', cst: '00' }, { uf: 'mg', cst: '10' }] }).expect(400);
    await owner.put(`/api/fiscal/federal-taxes/${companyId}`).set(H).send({ ...ok, ibsCbsByUf: [{ uf: 'MG', cst: '0', classification: '1' }] }).expect(400);
    await accountant.put(`/api/fiscal/federal-taxes/${companyId}`).set(H).send(ok).expect(403);
    await ana.get('/api/fiscal/federal-taxes').expect(403);
    const other = agent();
    await other.post('/api/auth/register').set(H).send({ companyName: `Co sx2 ${run}`, name: 'Outro', email: `sx2-${run}@teste.local`, password: PASSWORD }).expect(201);
    await other.put(`/api/fiscal/federal-taxes/${companyId}`).set(H).send(ok).expect(404);
    expect((await other.get('/api/fiscal/federal-taxes').expect(200)).body).toEqual([]);
    void tenantId;
  });
});
