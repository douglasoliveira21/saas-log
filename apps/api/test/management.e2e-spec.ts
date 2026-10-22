import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { unzipSync, strFromU8 } from 'fflate';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';
import { monthRange } from '../src/management/management';

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);
let seq = 0;
const uid = () => `${run}${++seq}`;
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const thisMonth = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 7);

describe('Gestão: metas, margem, giro/ruptura/previsão, orçamento e pacote do contador', () => {
  let app: INestApplication;
  type Agent = ReturnType<typeof request.agent>;
  let owner: Agent; let other: Agent; let wh: string;
  let spA: string; let spB: string;
  const P: Record<string, string> = {};

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    owner = request.agent(app.getHttpServer());
    await owner.post('/api/auth/register').set(H).send({ companyName: `Co mg ${run}`, name: 'Dono', email: `mg-${run}@teste.local`, password: PASSWORD }).expect(201);
    const company = await owner.post('/api/companies').set(H).send({ legalName: 'MG LTDA' }).expect(201);
    const est = await owner.post('/api/establishments').set(H).send({ companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz' }).expect(201);
    wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
    spA = (await owner.post('/api/salespeople').set(H).send({ name: 'Ana' }).expect(201)).body.id;
    spB = (await owner.post('/api/salespeople').set(H).send({ name: 'Beto' }).expect(201)).body.id;
    other = request.agent(app.getHttpServer());
    await other.post('/api/auth/register').set(H).send({ companyName: `Co mgB ${run}`, name: 'Outro', email: `mgb-${run}@teste.local`, password: PASSWORD }).expect(201);

    const product = async (key: string, cost: number | null, price: number, stock: number) => {
      P[key] = (await owner.post('/api/products').set(H).send({ sku: `MG-${key}-${uid()}`, name: `Produto ${key}`, suggestedPrice: price, ...(cost !== null ? { costPrice: cost } : {}) }).expect(201)).body.id;
      if (stock) await owner.post('/api/stock/movements').set(H).send({ productId: P[key], warehouseId: wh, type: 'PURCHASE_ENTRY', quantity: stock }).expect(201);
    };
    await product('a', 6, 10, 100); // vende bem
    await product('b', null, 20, 50); // sem custo
    await product('c', 5, 9, 30); // sem giro
    await product('d', 4, 8, 0); // sem estoque, mas vende → ruptura (vende e zera)
  });
  afterAll(async () => { await app.close(); });

  async function sell(salespersonId: string, items: { p: string; qty: number; price: number }[], ship = true) {
    const c = (await owner.post('/api/customers').set(H).send({ kind: 'PF', name: `Cli ${uid()}` }).expect(201)).body.id;
    const o = (await owner.post('/api/sales/orders').set(H).send({ customerId: c, warehouseId: wh, salespersonId, paymentMethod: 'PIX', items: items.map((i) => ({ productId: P[i.p], quantity: i.qty, unitPrice: i.price })) }).expect(201)).body.id;
    await owner.post(`/api/sales/orders/${o}/submit`).set(H).expect(200);
    if (ship) for (const to of ['PICKING', 'PACKED', 'SHIPPED']) await owner.post(`/api/sales/orders/${o}/advance`).set(H).send({ to }).expect(200);
    return o as string;
  }

  it('monthRange usa o fuso de Brasília e conta os dias do mês', () => {
    const r = monthRange('2026-02');
    expect(r.days).toBe(28);
    expect(r.start.toISOString()).toBe('2026-02-01T03:00:00.000Z');
    expect(() => monthRange('2026-13')).toThrow();
  });

  it('metas: define por vendedor, soma o vendido (líquido de devolução) e ordena o ranking', async () => {
    await sell(spA, [{ p: 'a', qty: 10, price: 10 }]); // R$ 100
    const o2 = await sell(spA, [{ p: 'a', qty: 5, price: 10 }]); // R$ 50
    await sell(spB, [{ p: 'a', qty: 3, price: 10 }]); // R$ 30
    await sell(spB, [{ p: 'b', qty: 1, price: 20 }], false); // confirmado e não expedido: conta na meta
    // devolve 1 un (R$ 10) do pedido de Ana
    const d = (await owner.get(`/api/sales/orders/${o2}`).expect(200)).body;
    await owner.post(`/api/sales/orders/${o2}/returns`).set(H).send({ reason: 'avaria', restock: true, items: [{ orderItemId: d.items[0].id, quantity: 1 }] }).expect(201);

    await owner.put('/api/management/goals').set(H).send({ period: thisMonth, items: [{ salespersonId: spA, amount: 500 }, { salespersonId: spB, amount: 40 }] }).expect(200);
    const g = (await owner.get(`/api/management/goals?period=${thisMonth}`).expect(200)).body;
    const a = g.rows.find((r: any) => r.salespersonId === spA); const b = g.rows.find((r: any) => r.salespersonId === spB);
    expect(a).toMatchObject({ goal: '500.00', achieved: '140.00', returns: '10.00', orders: 2, rank: 1 });
    expect(a.pct).toBe(28);
    expect(b).toMatchObject({ achieved: '50.00', rank: 2 });
    expect(b.pct).toBe(125); // passou da meta
    expect(g.totals).toMatchObject({ goal: '540.00', achieved: '190.00' });
    await owner.put('/api/management/goals').set(H).send({ period: '2026-13', items: [] }).expect(400);
    await owner.put('/api/management/goals').set(H).send({ period: thisMonth, items: [{ salespersonId: spA, amount: -1 }] }).expect(400);
    // outra empresa não vê nada
    expect((await other.get(`/api/management/goals?period=${thisMonth}`).expect(200)).body.rows).toHaveLength(0);
  });

  it('margem real por produto, cliente e pedido, com aviso de item sem custo', async () => {
    await sell(spA, [{ p: 'b', qty: 2, price: 20 }]); // sem custo cadastrado
    const byP = (await owner.get(`/api/management/margin?from=${day(-1)}&to=${day(1)}&by=product`).expect(200)).body;
    const a = byP.items.find((i: any) => i.key === P.a); const b = byP.items.find((i: any) => i.key === P.b);
    // produto a: 10+5+3 = 18 un, 1 devolvida → 17 un × R$ 10 = 170; custo 17 × 6 = 102
    expect(a).toMatchObject({ quantity: 17, revenue: '170.00', cost: '102.00', margin: '68.00', marginPct: 40 });
    expect(b).toMatchObject({ quantity: 2, revenue: '40.00', cost: '0.00', itemsWithoutCost: 1 });
    expect(byP.totals.itemsWithoutCost).toBeGreaterThanOrEqual(1);
    expect(Number(byP.totals.revenue)).toBe(210);
    const byC = (await owner.get(`/api/management/margin?from=${day(-1)}&to=${day(1)}&by=customer`).expect(200)).body;
    expect(byC.items.length).toBeGreaterThanOrEqual(4);
    const byO = (await owner.get(`/api/management/margin?from=${day(-1)}&to=${day(1)}&by=order`).expect(200)).body;
    expect(byO.items[0].label).toMatch(/^Pedido #/);
    await owner.get('/api/management/margin?from=2026-05-01&to=2026-04-01').expect(400);
    // pedido não expedido não entra
    expect(byO.items.length).toBe(4);
  });

  it('giro, ruptura e previsão: classifica o estoque e sugere compra', async () => {
    await sell(spA, [{ p: 'a', qty: 80, price: 10 }]); // a: sobra pouco estoque
    const h = (await owner.get('/api/management/stock-health?days=30&leadDays=7').expect(200)).body;
    const by = (id: string) => h.items.find((i: any) => i.productId === id);
    const a = by(P.a); const c = by(P.c);
    expect(a.sold).toBe(97); // 18−1 + 80
    expect(a.abc).toBe('A');
    expect(a.forecast30).toBeGreaterThan(0);
    expect(a.suggestedPurchase).toBeGreaterThan(0);
    expect(['CRITICO', 'ATENCAO', 'RUPTURA']).toContain(a.status);
    expect(c).toMatchObject({ status: 'SEM_GIRO', sold: 0, onHand: 30, suggestedPurchase: 0 });
    expect(h.summary.semGiro).toBeGreaterThanOrEqual(1);
    expect(h.summary.stockValue).toBeGreaterThan(0);
    // zera o estoque de b: com venda recente vira ruptura
    const bal = (await owner.get(`/api/stock/balances/${P.b}`).expect(200)).body[0];
    await owner.post('/api/stock/movements').set(H).send({ productId: P.b, warehouseId: wh, type: 'ADJUSTMENT', quantity: -(bal.available), reason: 'zerar' }).expect(201);
    const h2 = (await owner.get('/api/management/stock-health?days=30').expect(200)).body;
    expect(h2.items.find((i: any) => i.productId === P.b).status).toBe('RUPTURA');
  });

  it('orçamento: orça por categoria e mês e compara com o realizado', async () => {
    const cat = (await owner.post('/api/finance/categories').set(H).send({ name: `Aluguel ${uid()}`, kind: 'OPERATING_EXPENSE' }).expect(201)).body.id;
    await owner.post('/api/finance/titles').set(H).send({ direction: 'PAYABLE', description: 'Aluguel', amount: 1200, dueDate: `${thisMonth}-15`, categoryId: cat }).expect(201);
    await owner.put('/api/management/budget').set(H).send({ lines: [{ lineKey: cat, period: thisMonth, amount: 1000 }, { lineKey: 'SALES', period: thisMonth, amount: 5000 }] }).expect(200);
    const b = (await owner.get(`/api/management/budget?year=${thisMonth.slice(0, 4)}`).expect(200)).body;
    const m = (row: any) => row.months.find((x: any) => x.period === thisMonth);
    const rent = b.rows.find((r: any) => r.lineKey === cat);
    expect(m(rent)).toMatchObject({ budget: '1000.00', realized: '1200.00', variance: '200.00' });
    expect(rent.expense).toBe(true);
    const sales = b.rows.find((r: any) => r.lineKey === 'SALES');
    expect(m(sales).budget).toBe('5000.00');
    expect(Number(m(sales).realized)).toBeGreaterThan(0);
    await owner.put('/api/management/budget').set(H).send({ lines: [{ lineKey: 'not-a-category', period: thisMonth, amount: 1 }] }).expect(400);
    await owner.put('/api/management/budget').set(H).send({ lines: [{ lineKey: '11111111-1111-1111-1111-111111111111', period: thisMonth, amount: 1 }] }).expect(400);
    await other.put('/api/management/budget').set(H).send({ lines: [{ lineKey: cat, period: thisMonth, amount: 1 }] }).expect(400); // categoria de outra empresa
  });

  it('pacote do contador: ZIP com planilhas e LEIA-ME deixando claro que não é SPED', async () => {
    const res = await owner.get(`/api/management/accountant-package?from=${day(-30)}&to=${day(1)}`).buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); }).expect(200);
    expect(res.headers['content-type']).toMatch(/zip/);
    const files = unzipSync(new Uint8Array(res.body as Buffer));
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['LEIA-ME.txt', 'notas_saida.csv', 'notas_entrada.csv', 'lancamentos_financeiros.csv', 'baixas.csv', 'plano_de_contas.csv', 'dre_gerencial.csv']));
    expect(strFromU8(files['LEIA-ME.txt'])).toMatch(/NÃO é o arquivo SPED/);
    expect(strFromU8(files['lancamentos_financeiros.csv'])).toMatch(/Aluguel/);
    expect(strFromU8(files['plano_de_contas.csv'])).toMatch(/Categoria/);
    await owner.get('/api/management/accountant-package?from=2026-05-01&to=2026-04-01').expect(400);
  });

  it('sem a permissão de gestão a API responde 403', async () => {
    const roles = Object.fromEntries((await owner.get('/api/roles').expect(200)).body.map((r: any) => [r.key, r.id]));
    const email = `sp-${uid()}@teste.local`;
    await owner.post('/api/users').set(H).send({ name: 'Vend', email, password: PASSWORD, roleId: roles.salesperson }).expect(201);
    const sp = request.agent(app.getHttpServer());
    await sp.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200);
    await sp.get('/api/management/margin').expect(403);
    await sp.get('/api/management/goals').expect(403);
    await sp.put('/api/management/goals').set(H).send({ period: thisMonth, items: [] }).expect(403);
    await sp.get('/api/management/accountant-package').expect(403);
  });
});
