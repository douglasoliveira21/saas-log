import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);
let seq = 0;
const uid = () => `${run}${++seq}`;
const day = (n = 0) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe('Compras inteligentes, cotação entre fornecedores e frota', () => {
  let app: INestApplication;
  type Agent = ReturnType<typeof request.agent>;
  let owner: Agent; let other: Agent; let wh: string; let s1: string; let s2: string; let s3: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    owner = request.agent(app.getHttpServer());
    await owner.post('/api/auth/register').set(H).send({ companyName: `Co pf ${run}`, name: 'Dono', email: `pf-${run}@teste.local`, password: PASSWORD }).expect(201);
    const company = await owner.post('/api/companies').set(H).send({ legalName: 'PF LTDA' }).expect(201);
    const est = await owner.post('/api/establishments').set(H).send({ companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz' }).expect(201);
    wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
    const sup = async (n: string) => (await owner.post('/api/suppliers').set(H).send({ legalName: `Forn ${n} ${uid()}` }).expect(201)).body.id as string;
    s1 = await sup('A'); s2 = await sup('B'); s3 = await sup('C');
    other = request.agent(app.getHttpServer());
    await other.post('/api/auth/register').set(H).send({ companyName: `Co pfB ${run}`, name: 'Outro', email: `pfb-${run}@teste.local`, password: PASSWORD }).expect(201);
  });
  afterAll(async () => { await app.close(); });

  const product = async (extra: object = {}) => (await owner.post('/api/products').set(H).send({ sku: `PF-${uid()}`, name: `Item ${seq}`, suggestedPrice: 20, costPrice: 8, grossWeightG: 2000, ...extra }).expect(201)).body.id as string;
  const link = (p: string, s: string, lastPrice: number, isMain = true) => owner.post(`/api/products/${p}/suppliers`).set(H).send({ supplierId: s, lastPrice, isMain }).expect(200);
  const stock = (p: string, qty: number) => owner.post('/api/stock/movements').set(H).send({ productId: p, warehouseId: wh, type: 'PURCHASE_ENTRY', quantity: qty }).expect(201);
  const sell = async (p: string, qty: number, to: 'SHIPPED' | 'PACKED' = 'SHIPPED') => {
    const c = (await owner.post('/api/customers').set(H).send({ kind: 'PF', name: `Cli ${uid()}`, city: 'Campinas', state: 'SP', street: 'Rua A' }).expect(201)).body.id;
    const o = (await owner.post('/api/sales/orders').set(H).send({ customerId: c, warehouseId: wh, paymentMethod: 'PIX', items: [{ productId: p, quantity: qty, unitPrice: 20 }] }).expect(201)).body.id;
    await owner.post(`/api/sales/orders/${o}/submit`).set(H).expect(200);
    for (const st of ['PICKING', 'PACKED', 'SHIPPED']) { await owner.post(`/api/sales/orders/${o}/advance`).set(H).send({ to: st }).expect(200); if (st === to) break; }
    return o as string;
  };

  describe('sugestão de compra', () => {
    it('sugere pelo giro, descontando o que já está em compra, e classifica ruptura/crítico', async () => {
      const fast = await product({ minStock: 5, leadTimeDays: 10 }); await link(fast, s1, 7.5);
      const slow = await product({ minStock: 0 }); await link(slow, s1, 6);
      const out = await product({ leadTimeDays: 5 }); await link(out, s2, 9);
      await stock(fast, 100); await stock(slow, 100); await stock(out, 30);
      await sell(fast, 90); // ritmo alto, sobram 10
      await sell(out, 30); // zera
      const r = (await owner.get('/api/purchases/smart-suggestions?days=30&coverDays=30').expect(200)).body;
      const f = r.items.find((i: any) => i.productId === fast); const o = r.items.find((i: any) => i.productId === out);
      expect(r.items.some((i: any) => i.productId === slow)).toBe(false); // sem giro e com estoque: não sugere
      expect(f).toMatchObject({ supplierId: s1, unitCost: 7.5, sold: 90, leadDays: 10 });
      expect(f.suggestedQty).toBeGreaterThan(50);
      expect(['CRITICO', 'RUPTURA', 'REPOR']).toContain(f.status);
      expect(o.status).toBe('RUPTURA');
      expect(o.supplierId).toBe(s2);
      expect(r.summary.ruptura).toBeGreaterThanOrEqual(1);
      expect(f.abc).toBe('A');
      // o que já foi comprado reduz a sugestão
      const po = (await owner.post('/api/purchases').set(H).send({ supplierId: s1, warehouseId: wh, items: [{ productId: fast, quantity: f.suggestedQty, unitCost: 7.5 }] }).expect(201)).body;
      await owner.post(`/api/purchases/${po.id}/submit`).set(H).expect(200).catch(() => undefined);
      const after = (await owner.get('/api/purchases/smart-suggestions?days=30&coverDays=30').expect(200)).body;
      const f2 = after.items.find((i: any) => i.productId === fast);
      expect(f2 === undefined || f2.suggestedQty < f.suggestedQty).toBe(true);
    });

    it('gera uma ordem por fornecedor, tudo ou nada, e recusa item sem fornecedor ou custo', async () => {
      const a = await product(); const b = await product(); const c = await product(); const d = await product({ costPrice: undefined });
      await link(a, s1, 10); await link(b, s2, 20); await link(c, s1, 5);
      const r = (await owner.post('/api/purchases/from-suggestions').set(H).send({ warehouseId: wh, items: [{ productId: a, quantity: 10 }, { productId: b, quantity: 5 }, { productId: c, quantity: 2 }] }).expect(200)).body;
      expect(r.orders).toHaveLength(2); // fornecedores 1 e 2
      const list = (await owner.get('/api/purchases?limit=100').expect(200)).body.items;
      const po1 = list.find((p: any) => p.id === r.orders.find((o: any) => o.supplierId === s1).id);
      expect(Number(po1.total)).toBe(110); // 10×10 + 2×5
      // sem fornecedor: recusa e não cria nenhuma
      const before = (await owner.get('/api/purchases?limit=100').expect(200)).body.total;
      await owner.post('/api/purchases/from-suggestions').set(H).send({ warehouseId: wh, items: [{ productId: a, quantity: 1 }, { productId: d, quantity: 1 }] }).expect(400);
      expect((await owner.get('/api/purchases?limit=100').expect(200)).body.total).toBe(before);
      await other.post('/api/purchases/from-suggestions').set(H).send({ warehouseId: wh, items: [{ productId: a, quantity: 1 }] }).expect(400);
    });
  });

  describe('cotação entre fornecedores', () => {
    it('compara propostas, mostra o melhor total e o melhor preço por item e gera as ordens', async () => {
      const p1 = await product(); const p2 = await product();
      const rfq = (await owner.post('/api/purchases/rfq').set(H).send({ warehouseId: wh, neededBy: day(15), notes: 'reposição', items: [{ productId: p1, quantity: 100 }, { productId: p2, quantity: 50 }], supplierIds: [s1, s2, s3] }).expect(201)).body;
      const prop = (s: string, body: object) => owner.put(`/api/purchases/rfq/${rfq.id}/suppliers/${s}`).set(H).send(body);
      await prop(s1, { leadTimeDays: 5, freight: 50, paymentTerms: '30 dias', prices: [{ productId: p1, unitCost: 10 }, { productId: p2, unitCost: 20 }] }).expect(200); // 1000+1000+50 = 2050
      await prop(s2, { leadTimeDays: 10, freight: 0, prices: [{ productId: p1, unitCost: 9 }, { productId: p2, unitCost: 22 }] }).expect(200); // 900+1100 = 2000
      await prop(s3, { leadTimeDays: 2, freight: 20, prices: [{ productId: p1, unitCost: 9.5 }] }).expect(200); // incompleto
      const c = (await owner.get(`/api/purchases/rfq/${rfq.id}`).expect(200)).body;
      expect(c.status).toBe('OPEN');
      const t = (id: string) => c.suppliers.find((x: any) => x.supplierId === id);
      expect([Number(t(s1).total), Number(t(s2).total)]).toEqual([2050, 2000]);
      expect(t(s3).complete).toBe(false);
      expect(c.bestSingleSupplierId).toBe(s2); // menor total entre os completos
      expect(c.items.find((i: any) => i.productId === p1)).toMatchObject({ bestSupplierId: s2, bestUnitCost: 9 });
      expect(c.items.find((i: any) => i.productId === p2)).toMatchObject({ bestSupplierId: s1, bestUnitCost: 20 });
      expect(Number(c.bestPerItem.total)).toBe(900 + 1000 + 50); // p1 em s2 + p2 em s1 + frete de s1 (s2 sem frete)
      await prop(s1, { prices: [{ productId: p1, unitCost: 10 }, { productId: '00000000-0000-0000-0000-000000000000', unitCost: 1 }] }).expect(400); // item fora da cotação
      // fornecedor incompleto não pode ganhar sozinho
      await owner.post(`/api/purchases/rfq/${rfq.id}/award`).set(H).send({ mode: 'SINGLE', supplierId: s3 }).expect(409);
      const won = (await owner.post(`/api/purchases/rfq/${rfq.id}/award`).set(H).send({ mode: 'BEST_PER_ITEM' }).expect(200)).body;
      expect(won.orders).toHaveLength(2);
      const list = (await owner.get('/api/purchases?limit=100').expect(200)).body.items;
      const o2 = list.find((p: any) => p.id === won.orders.find((o: any) => o.supplierId === s2).id);
      expect(Number(o2.total)).toBe(900);
      const closed = (await owner.get(`/api/purchases/rfq/${rfq.id}`).expect(200)).body;
      expect(closed.status).toBe('CLOSED');
      expect(closed.orderIds).toHaveLength(2);
      await owner.post(`/api/purchases/rfq/${rfq.id}/award`).set(H).send({ mode: 'BEST_PER_ITEM' }).expect(409);
      await prop(s1, { prices: [{ productId: p1, unitCost: 1 }] }).expect(409); // encerrada
    });

    it('vencedor único, cancelamento, validações e isolamento entre empresas', async () => {
      const p = await product();
      await owner.post('/api/purchases/rfq').set(H).send({ warehouseId: wh, items: [{ productId: p, quantity: 1 }, { productId: p, quantity: 2 }], supplierIds: [s1] }).expect(400); // produto repetido
      await owner.post('/api/purchases/rfq').set(H).send({ warehouseId: wh, items: [{ productId: p, quantity: 1 }], supplierIds: [] }).expect(400);
      const rfq = (await owner.post('/api/purchases/rfq').set(H).send({ warehouseId: wh, items: [{ productId: p, quantity: 10 }], supplierIds: [s1, s2] }).expect(201)).body;
      await owner.put(`/api/purchases/rfq/${rfq.id}/suppliers/${s1}`).set(H).send({ leadTimeDays: 3, prices: [{ productId: p, unitCost: 4 }] }).expect(200);
      await owner.put(`/api/purchases/rfq/${rfq.id}/suppliers/${s3}`).set(H).send({ prices: [] }).expect(404); // s3 não participa
      await other.get(`/api/purchases/rfq/${rfq.id}`).expect(404);
      const w = (await owner.post(`/api/purchases/rfq/${rfq.id}/award`).set(H).send({ mode: 'SINGLE' }).expect(200)).body;
      expect(w.orders).toHaveLength(1);
      expect(w.orders[0].supplierId).toBe(s1);
      const r2 = (await owner.post('/api/purchases/rfq').set(H).send({ warehouseId: wh, items: [{ productId: p, quantity: 1 }], supplierIds: [s1] }).expect(201)).body;
      await owner.post(`/api/purchases/rfq/${r2.id}/cancel`).set(H).send({ reason: 'desistiu' }).expect(200);
      expect((await owner.get(`/api/purchases/rfq/${r2.id}`).expect(200)).body.status).toBe('CANCELLED');
    });
  });

  describe('frota e carga', () => {
    const vehicle = (extra: object = {}) => owner.post('/api/fleet/vehicles').set(H).send({ plate: `ABC${Math.floor(1000 + Math.random() * 8999)}`, description: 'Furgão', kind: 'VAN', capacityKg: 300, ...extra });
    let driverId: string;
    beforeAll(async () => {
      const email = `mot-${uid()}@teste.local`;
      driverId = (await owner.post('/api/delivery/drivers').set(H).send({ name: 'João', email, password: PASSWORD }).expect(201)).body.id;
    });

    it('cadastra veículos (placa única), edita e valida a placa', async () => {
      const v = (await vehicle({ plate: 'qwe1d23' }).expect(201)).body;
      expect(v.plate).toBe('QWE1D23');
      await vehicle({ plate: 'QWE-1D23' }).expect(409);
      await vehicle({ plate: '123' }).expect(400);
      await owner.put(`/api/fleet/vehicles/${v.id}`).set(H).send({ description: 'Furgão 2', capacityKg: 500 }).expect(200);
      expect((await owner.get('/api/fleet/vehicles').expect(200)).body.find((x: any) => x.id === v.id)).toMatchObject({ description: 'Furgão 2', capacityKg: 500 });
    });

    it('viagem com veículo: peso x capacidade, custos, resumo e manifesto', async () => {
      const heavy = await product({ grossWeightG: 5000 }); await stock(heavy, 200);
      const o1 = await sell(heavy, 40, 'PACKED'); // 40 × 5 kg = 200 kg
      const o2 = await sell(heavy, 30, 'PACKED'); // +150 kg → 350 kg
      const route = (await owner.post('/api/delivery/routes').set(H).send({ routeDate: day(0), driverId, orderIds: [o1, o2] }).expect(201)).body;
      const small = (await vehicle({ capacityKg: 300 }).expect(201)).body;
      const r1 = (await owner.put(`/api/fleet/routes/${route.id}/vehicle`).set(H).send({ vehicleId: small.id }).expect(200)).body;
      expect(r1).toMatchObject({ weightKg: 350, capacityKg: 300, overCapacity: true });
      const big = (await vehicle({ capacityKg: 1000 }).expect(201)).body;
      const r2 = (await owner.put(`/api/fleet/routes/${route.id}/vehicle`).set(H).send({ vehicleId: big.id }).expect(200)).body;
      expect(r2.overCapacity).toBe(false);
      await owner.put(`/api/fleet/routes/${route.id}/vehicle`).set(H).send({ vehicleId: '00000000-0000-0000-0000-000000000000' }).expect(400);
      const load = (await owner.get(`/api/fleet/routes/${route.id}/load`).expect(200)).body;
      expect(load).toMatchObject({ weightKg: 350, capacityKg: 1000, usedPct: 35 });
      // outro veículo não pode estar em duas viagens no mesmo dia
      const o3 = await sell(heavy, 1, 'PACKED');
      const route2 = (await owner.post('/api/delivery/routes').set(H).send({ routeDate: day(0), driverId, orderIds: [o3] }).expect(201)).body;
      await owner.put(`/api/fleet/routes/${route2.id}/vehicle`).set(H).send({ vehicleId: big.id }).expect(409);

      // custos
      await owner.post('/api/fleet/costs').set(H).send({ vehicleId: big.id, routeId: route.id, kind: 'FUEL', amount: 120.5, date: day(0) }).expect(200);
      await owner.post('/api/fleet/costs').set(H).send({ vehicleId: big.id, routeId: route.id, kind: 'TOLL', amount: 30, date: day(0), note: 'Anhanguera' }).expect(200);
      await owner.post('/api/fleet/costs').set(H).send({ vehicleId: small.id, routeId: route.id, kind: 'FUEL', amount: 10, date: day(0) }).expect(409); // viagem não usa este veículo
      await owner.post('/api/fleet/costs').set(H).send({ vehicleId: big.id, kind: 'FUEL', amount: 10, date: day(5) }).expect(400); // futuro
      await owner.post('/api/fleet/costs').set(H).send({ vehicleId: big.id, kind: 'FUEL', amount: -3, date: day(0) }).expect(400);
      expect((await owner.get(`/api/fleet/routes/${route.id}/load`).expect(200)).body.cost).toBe('150.50');
      const sum = (await owner.get(`/api/fleet/summary?from=${day(-1)}&to=${day(1)}`).expect(200)).body;
      const row = sum.rows.find((r: any) => r.vehicleId === big.id);
      expect(row).toMatchObject({ routes: 1, cost: '150.50' });
      expect(row.byKind).toMatchObject({ FUEL: '120.50', TOLL: '30.00' });
      expect(sum.totals.cost).toBe('150.50');

      // manifesto
      const m = (await owner.get(`/api/fleet/routes/${route.id}/manifest`).expect(200)).body;
      expect(m.vehicle.plate).toBe(big.plate);
      expect(m.stops).toHaveLength(2);
      expect(m.weightKg).toBe(350);
      expect(m.warnings.join(' ')).toMatch(/sem NF-e autorizada/);
      expect(m.notice).toMatch(/Não é o MDF-e/);
      expect(m.states).toEqual(['SP']);
      expect(m.company).toMatchObject({ name: expect.any(String), legalName: expect.any(String) }); // cabeçalho do documento impresso
      expect(m).toHaveProperty('logo');
      expect(m.stops.every((x: any) => Array.isArray(x.items) && x.items.length > 0 && x.items[0].quantity > 0)).toBe(true); // itens de cada parada (romaneio)
      expect(m.generatedAt).toEqual(expect.any(String));
    });

    it('permissões e isolamento', async () => {
      const roles = Object.fromEntries((await owner.get('/api/roles').expect(200)).body.map((r: any) => [r.key, r.id]));
      const email = `v-${uid()}@teste.local`;
      await owner.post('/api/users').set(H).send({ name: 'Vend', email, password: PASSWORD, roleId: roles.salesperson }).expect(201);
      const v = request.agent(app.getHttpServer());
      await v.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200);
      await v.get('/api/fleet/vehicles').expect(403);
      await v.post('/api/purchases/rfq').set(H).send({}).expect(403);
      expect((await other.get('/api/fleet/vehicles').expect(200)).body).toHaveLength(0);
    });
  });
});
