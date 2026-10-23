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

describe('Lote e validade (PEPS/FEFO) e armazém (endereços, separação e conferência)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  type Agent = ReturnType<typeof request.agent>;
  let owner: Agent; let other: Agent; let wh: string; let wh2: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    await admin.plan.update({ where: { code: 'trial' }, data: { limits: { users: 100, establishments: 20, warehouses: 20 } } });
    owner = request.agent(app.getHttpServer());
    await owner.post('/api/auth/register').set(H).send({ companyName: `Co lt ${run}`, name: 'Dono', email: `lt-${run}@teste.local`, password: PASSWORD }).expect(201);
    const company = await owner.post('/api/companies').set(H).send({ legalName: 'LT LTDA' }).expect(201);
    const est = await owner.post('/api/establishments').set(H).send({ companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz' }).expect(201);
    wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito 1' }).expect(201)).body.id;
    wh2 = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD02', name: 'Depósito 2' }).expect(201)).body.id;
    other = request.agent(app.getHttpServer());
    await other.post('/api/auth/register').set(H).send({ companyName: `Co ltB ${run}`, name: 'Outro', email: `ltb-${run}@teste.local`, password: PASSWORD }).expect(201);
  });
  afterAll(async () => { await admin.$disconnect(); await app.close(); });

  const product = async (extra: object = {}) => (await owner.post('/api/products').set(H).send({ sku: `LT-${uid()}`, name: 'Leite', barcode: `789${Date.now().toString().slice(-9)}${seq}`, suggestedPrice: 10, costPrice: 4, ...extra }).expect(201)).body.id as string;
  const entry = (p: string, qty: number, lot?: { lotCode: string; expiresAt?: string; locationCode?: string }, warehouseId = wh) =>
    owner.post('/api/stock/movements').set(H).send({ productId: p, warehouseId, type: 'PURCHASE_ENTRY', quantity: qty, ...lot });
  const track = (p: string, enabled = true) => owner.put(`/api/stock/lots/tracking/${p}`).set(H).send({ enabled });
  const lots = async (p: string, warehouseId = wh) => ((await owner.get(`/api/stock/lots?productId=${p}&warehouseId=${warehouseId}`).expect(200)).body.items as any[]);
  const lotQty = async (p: string, code: string, warehouseId = wh) => (await lots(p, warehouseId)).find((l) => l.code === code)?.onHand ?? 0;
  const sell = async (p: string, qty: number, ship = true) => {
    const c = (await owner.post('/api/customers').set(H).send({ kind: 'PF', name: `Cli ${uid()}` }).expect(201)).body.id;
    const o = (await owner.post('/api/sales/orders').set(H).send({ customerId: c, warehouseId: wh, paymentMethod: 'PIX', items: [{ productId: p, quantity: qty, unitPrice: 10 }] }).expect(201)).body.id;
    await owner.post(`/api/sales/orders/${o}/submit`).set(H).expect(200);
    if (ship) for (const to of ['PICKING', 'PACKED', 'SHIPPED']) await owner.post(`/api/sales/orders/${o}/advance`).set(H).send({ to }).expect(200);
    return o as string;
  };

  describe('lote e validade', () => {
    it('ao ligar o controle o saldo vira lote LEGADO; entrada sem lote é recusada', async () => {
      const p = await product();
      await entry(p, 100).expect(201);
      const r = (await track(p).expect(200)).body;
      expect(r).toMatchObject({ trackLots: true, legacyLots: 1 });
      expect(await lotQty(p, 'LEGADO')).toBe(100);
      await entry(p, 10).expect(400); // sem lote
      await entry(p, 10, { lotCode: 'a1', expiresAt: '2026-13-40' }).expect(400); // validade inválida
      await entry(p, 10, { lotCode: 'a1', expiresAt: day(30) }).expect(201);
      expect(await lotQty(p, 'A1')).toBe(10); // código padronizado em maiúsculas
      await entry(p, 5, { lotCode: 'A1', expiresAt: day(31) }).expect(409); // mesmo lote, outra validade
      await entry(p, 5, { lotCode: 'A1' }).expect(201);
      expect(await lotQty(p, 'A1')).toBe(15);
    });

    it('a venda sai do lote que vence primeiro (FEFO) e o rastro fica registrado', async () => {
      const p = await product();
      await track(p).expect(200);
      await entry(p, 10, { lotCode: 'LONGO', expiresAt: day(90) }).expect(201);
      await entry(p, 10, { lotCode: 'CURTO', expiresAt: day(10) }).expect(201);
      await entry(p, 10, { lotCode: 'SEMVAL' }).expect(201);
      await sell(p, 14);
      expect(await lotQty(p, 'CURTO')).toBe(0); // vence primeiro: esvaziou
      expect(await lotQty(p, 'LONGO')).toBe(6); // depois o seguinte
      expect(await lotQty(p, 'SEMVAL')).toBe(10); // sem validade fica por último
      const mv = (await owner.get(`/api/stock/movements?productId=${p}`).expect(200)).body.items.find((m: any) => m.type === 'SALE_EXIT');
      const rows = await admin.stockLotMovement.findMany({ where: { movementId: mv.id } });
      expect(rows.reduce((s, r) => s + r.quantity, 0)).toBe(-14);
      expect(rows).toHaveLength(2);
    });

    it('lote vencido não é vendido; só sai como perda; devolução volta ao lote de origem', async () => {
      const p = await product();
      await track(p).expect(200);
      await entry(p, 5, { lotCode: 'VELHO', expiresAt: day(20) }).expect(201);
      await entry(p, 5, { lotCode: 'NOVO', expiresAt: day(120) }).expect(201);
      await admin.stockLot.updateMany({ where: { productId: p, code: 'VELHO' }, data: { expiresAt: new Date(`${day(-3)}T00:00:00Z`) } }); // venceu
      const expired = (await owner.get(`/api/stock/lots?productId=${p}&status=VENCIDO`).expect(200)).body;
      expect(expired.items).toHaveLength(1);
      expect(expired.summary.expiredUnits).toBe(5);
      // só o lote NOVO é vendável
      const o = await sell(p, 3);
      expect(await lotQty(p, 'NOVO')).toBe(2);
      expect(await lotQty(p, 'VELHO')).toBe(5);
      // pedir mais do que há em lote válido: bloqueia com explicação
      const c = (await owner.post('/api/customers').set(H).send({ kind: 'PF', name: `Cli ${uid()}` }).expect(201)).body.id;
      const big = (await owner.post('/api/sales/orders').set(H).send({ customerId: c, warehouseId: wh, paymentMethod: 'PIX', items: [{ productId: p, quantity: 6, unitPrice: 10 }] }).expect(201)).body.id;
      await owner.post(`/api/sales/orders/${big}/submit`).set(H).expect(200);
      for (const to of ['PICKING', 'PACKED']) await owner.post(`/api/sales/orders/${big}/advance`).set(H).send({ to }).expect(200);
      const blocked = await owner.post(`/api/sales/orders/${big}/advance`).set(H).send({ to: 'SHIPPED' }).expect(409);
      expect(JSON.stringify(blocked.body)).toMatch(/lote vencido|dentro da validade/);
      await owner.post(`/api/sales/orders/${big}/cancel`).set(H).send({ reason: 'sem lote válido' }).expect(200); // libera a reserva
      // dar baixa do vencido como perda
      const velho = (await lots(p)).find((l) => l.code === 'VELHO');
      await owner.post('/api/stock/movements').set(H).send({ productId: p, warehouseId: wh, type: 'LOSS', quantity: 5, reason: 'vencido', lotId: velho.id }).expect(201);
      expect(await lotQty(p, 'VELHO')).toBe(0);
      // devolução de 2 do primeiro pedido volta para o lote NOVO
      const d = (await owner.get(`/api/sales/orders/${o}`).expect(200)).body;
      await owner.post(`/api/sales/orders/${o}/returns`).set(H).send({ reason: 'avaria leve', restock: true, items: [{ orderItemId: d.items[0].id, quantity: 2 }] }).expect(201);
      expect(await lotQty(p, 'NOVO')).toBe(4);
    });

    it('transferência leva o lote e a validade; ajuste positivo exige lote; desligar exige saldo zerado', async () => {
      const p = await product();
      await track(p).expect(200);
      await entry(p, 10, { lotCode: 'T1', expiresAt: day(40) }).expect(201);
      await owner.post('/api/stock/transfers').set(H).send({ productId: p, fromWarehouseId: wh, toWarehouseId: wh2, quantity: 4, reason: 'reforço' }).expect(201);
      expect(await lotQty(p, 'T1', wh)).toBe(6);
      const dest = (await lots(p, wh2)).find((l) => l.code === 'T1');
      expect(dest).toMatchObject({ onHand: 4, expiresAt: day(40) });
      await owner.post('/api/stock/set-on-hand').set(H).send({ productId: p, warehouseId: wh, newOnHand: 9, reason: 'contagem' }).expect(400);
      await owner.post('/api/stock/set-on-hand').set(H).send({ productId: p, warehouseId: wh, newOnHand: 9, reason: 'contagem', lotCode: 'T1' }).expect(201);
      expect(await lotQty(p, 'T1', wh)).toBe(9);
      await track(p, false).expect(409);
    });

    it('validade mínima do cliente: pula lote curto na expedição e recusa confirmar sem lote que atenda', async () => {
      const p = await product();
      await track(p).expect(200);
      await entry(p, 10, { lotCode: 'CURTO', expiresAt: day(10) }).expect(201);
      await entry(p, 10, { lotCode: 'LONGO', expiresAt: day(100) }).expect(201);
      const c = (await owner.post('/api/customers').set(H).send({ kind: 'PF', name: `Exigente ${uid()}` }).expect(201)).body.id;
      await owner.put(`/api/customers/${c}/min-shelf-life`).set(H).send({ days: 30 }).expect(200);
      expect((await owner.get(`/api/customers/${c}/credit`).expect(200)).body.minShelfLifeDays).toBe(30);
      const mk = async (qty: number) => (await owner.post('/api/sales/orders').set(H).send({ customerId: c, warehouseId: wh, paymentMethod: 'PIX', items: [{ productId: p, quantity: qty, unitPrice: 10 }] }).expect(201)).body.id as string;
      const o = await mk(4);
      await owner.post(`/api/sales/orders/${o}/submit`).set(H).expect(200);
      for (const to of ['PICKING', 'PACKED', 'SHIPPED']) await owner.post(`/api/sales/orders/${o}/advance`).set(H).send({ to }).expect(200);
      expect(await lotQty(p, 'CURTO')).toBe(10); // não serve a este cliente
      expect(await lotQty(p, 'LONGO')).toBe(6);
      // sobram 6 em lote longo: pedir 8 não confirma, mesmo havendo 16 no total
      const big = await mk(8);
      const r = await owner.post(`/api/sales/orders/${big}/submit`).set(H).expect(409);
      expect(JSON.stringify(r.body)).toMatch(/pelo menos 30 dia/);
      // cliente sem exigência leva o lote curto (FEFO)
      const c2 = (await owner.post('/api/customers').set(H).send({ kind: 'PF', name: `Normal ${uid()}` }).expect(201)).body.id;
      await owner.put(`/api/customers/${c2}/min-shelf-life`).set(H).send({ days: 30 }).expect(200);
      await owner.put(`/api/customers/${c2}/min-shelf-life`).set(H).send({ days: null }).expect(200);
      expect((await owner.get(`/api/customers/${c2}/credit`).expect(200)).body.minShelfLifeDays).toBeNull();
      await owner.put(`/api/customers/${c}/min-shelf-life`).set(H).send({ days: -1 }).expect(400);
      await owner.put('/api/settings').set(H).send({ 'lots.marketplaceMinShelfLifeDays': 15 }).expect(200);
      await owner.put('/api/settings').set(H).send({ 'lots.marketplaceMinShelfLifeDays': -2 }).expect(400);
      await owner.put('/api/settings').set(H).send({ 'lots.marketplaceMinShelfLifeDays': 0 }).expect(200);
    });

    it('outra empresa não vê os lotes', async () => {
      const p = await product();
      await track(p).expect(200);
      await entry(p, 3, { lotCode: 'ISO', expiresAt: day(30) }).expect(201);
      expect((await other.get('/api/stock/lots').expect(200)).body.items).toHaveLength(0);
      await other.put(`/api/stock/lots/tracking/${p}`).set(H).send({ enabled: false }).expect(404);
    });
  });

  describe('armazém', () => {
    it('cria endereços, guarda a mercadoria sem passar do saldo e baixa do endereço ao vender', async () => {
      const p = await product();
      await entry(p, 20).expect(201);
      await owner.post('/api/warehouse/locations').set(H).send({ warehouseId: wh, code: 'a-01-01', description: 'Rua A' }).expect(201);
      await owner.post('/api/warehouse/locations').set(H).send({ warehouseId: wh, code: 'A-01-01' }).expect(409); // duplicado (maiúsculas)
      await owner.post('/api/warehouse/locations').set(H).send({ warehouseId: wh, code: '!!' }).expect(400);
      await owner.post('/api/warehouse/locations').set(H).send({ warehouseId: wh, code: 'B-02-01' }).expect(201);
      const un = (await owner.get(`/api/warehouse/unaddressed?warehouseId=${wh}`).expect(200)).body.find((x: any) => x.productId === p);
      expect(un.pending).toBe(20);
      await owner.post('/api/warehouse/putaway').set(H).send({ warehouseId: wh, productId: p, locationCode: 'A-01-01', quantity: 12 }).expect(200);
      await owner.post('/api/warehouse/putaway').set(H).send({ warehouseId: wh, productId: p, locationCode: 'B-02-01', quantity: 9 }).expect(409); // só restam 8
      await owner.post('/api/warehouse/putaway').set(H).send({ warehouseId: wh, productId: p, locationCode: 'B-02-01', quantity: 8 }).expect(200);
      await owner.post('/api/warehouse/putaway').set(H).send({ warehouseId: wh, productId: p, locationCode: 'XX', quantity: 1, fromLocationCode: 'B-02-01' }).expect(400);
      await owner.post('/api/warehouse/putaway').set(H).send({ warehouseId: wh, productId: p, locationCode: 'B-02-01', quantity: 3, fromLocationCode: 'A-01-01' }).expect(200); // move entre endereços
      const locs = (await owner.get(`/api/warehouse/locations?warehouseId=${wh}`).expect(200)).body;
      expect(locs.find((l: any) => l.code === 'A-01-01').units).toBe(9);
      expect(locs.find((l: any) => l.code === 'B-02-01').units).toBe(11);
      await sell(p, 10); // sai do A-01-01 primeiro (ordem de caminho)
      const after = (await owner.get(`/api/warehouse/locations?warehouseId=${wh}`).expect(200)).body;
      expect(after.find((l: any) => l.code === 'A-01-01').units).toBe(0);
      expect(after.find((l: any) => l.code === 'B-02-01').units).toBe(10);
      // endereço com mercadoria não desativa
      const b = after.find((l: any) => l.code === 'B-02-01');
      await owner.put(`/api/warehouse/locations/${b.id}`).set(H).send({ active: false }).expect(409);
    });

    it('lista de separação: lote FEFO, endereços em ordem de caminho, consolidando pedidos', async () => {
      const p = await product();
      await track(p).expect(200);
      await entry(p, 6, { lotCode: 'L-NOVO', expiresAt: day(100), locationCode: 'B-02-01' }).expect(201).catch(() => undefined);
      await owner.post('/api/warehouse/locations').set(H).send({ warehouseId: wh, code: 'C-03-01' }).expect((r) => { if (![201, 409].includes(r.status)) throw new Error(`status ${r.status}`); });
      await entry(p, 6, { lotCode: 'L-NOVO', expiresAt: day(100), locationCode: 'C-03-01' }).expect(201);
      await entry(p, 4, { lotCode: 'L-CURTO', expiresAt: day(15), locationCode: 'C-03-01' }).expect(201);
      await entry(p, 3, { lotCode: 'L-CURTO' }).expect(201); // 3 sem endereço
      const o1 = await sell(p, 5, false); const o2 = await sell(p, 4, false);
      const list = (await owner.get(`/api/warehouse/picking?orderIds=${o1},${o2}`).expect(200)).body;
      expect(list.orders).toHaveLength(2);
      const line = list.lines.find((l: any) => l.productId === p);
      expect(line.quantity).toBe(9);
      expect(line.shortage).toBe(0);
      expect(line.picks[0]).toMatchObject({ lotCode: 'L-CURTO', location: 'C-03-01', qty: 4 }); // vence primeiro, no endereço
      expect(line.picks[1]).toMatchObject({ lotCode: 'L-CURTO', location: null, qty: 3 }); // sobra do mesmo lote, sem endereço
      expect(line.picks[2]).toMatchObject({ lotCode: 'L-NOVO', qty: 2 });
      expect(line.orders.map((x: any) => x.qty)).toEqual([5, 4]);
      await owner.get(`/api/warehouse/picking?orderIds=`).expect(400);
      const orders = (await owner.get('/api/warehouse/picking/orders').expect(200)).body;
      expect(orders.some((o: any) => o.id === o1)).toBe(true);
    });

    it('conferência por código de barras e obrigatoriedade antes de embalar', async () => {
      const p1 = await product(); const p2 = await product();
      await entry(p1, 10).expect(201); await entry(p2, 10).expect(201);
      const c = (await owner.post('/api/customers').set(H).send({ kind: 'PF', name: `Cli ${uid()}` }).expect(201)).body.id;
      const o = (await owner.post('/api/sales/orders').set(H).send({ customerId: c, warehouseId: wh, paymentMethod: 'PIX', items: [{ productId: p1, quantity: 3, unitPrice: 10 }, { productId: p2, quantity: 2, unitPrice: 10 }] }).expect(201)).body.id;
      await owner.post(`/api/sales/orders/${o}/submit`).set(H).expect(200);
      const info = (await owner.get(`/api/warehouse/check/${o}`).expect(200)).body;
      expect(info.items).toHaveLength(2);
      expect(info.items.every((i: any) => i.barcode)).toBe(true);

      await owner.put('/api/settings').set(H).send({ 'warehouse.requireCheck': true }).expect(200);
      await owner.post(`/api/sales/orders/${o}/advance`).set(H).send({ to: 'PICKING' }).expect(200);
      await owner.post(`/api/sales/orders/${o}/advance`).set(H).send({ to: 'PACKED' }).expect(409); // sem conferência
      const bad = (await owner.post(`/api/warehouse/check/${o}`).set(H).send({ items: [{ productId: p1, counted: 3 }, { productId: p2, counted: 1 }] }).expect(200)).body;
      expect(bad.status).toBe('DIVERGENT');
      await owner.post(`/api/sales/orders/${o}/advance`).set(H).send({ to: 'PACKED' }).expect(409); // divergente
      const unk = (await owner.post(`/api/warehouse/check/${o}`).set(H).send({ items: [{ productId: p1, counted: 3 }, { productId: p2, counted: 2 }], unknown: ['0000'] }).expect(200)).body;
      expect(unk.status).toBe('DIVERGENT'); // código que não é do pedido
      const ok = (await owner.post(`/api/warehouse/check/${o}`).set(H).send({ items: [{ productId: p1, counted: 3 }, { productId: p2, counted: 2 }] }).expect(200)).body;
      expect(ok.status).toBe('OK');
      await owner.post(`/api/sales/orders/${o}/advance`).set(H).send({ to: 'PACKED' }).expect(200);
      await owner.put('/api/settings').set(H).send({ 'warehouse.requireCheck': false }).expect(200);
    });
  });
});
