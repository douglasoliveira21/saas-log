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

describe('Fase 2 — catálogo, estoque, reservas, inventário e importação', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const agent = () => request.agent(app.getHttpServer());

  interface Tenant { owner: ReturnType<typeof agent>; tenantId: string; wh1: string; wh2: string; roles: Record<string, string> }

  async function setup(label: string): Promise<Tenant> {
    const owner = agent();
    const res = await owner.post('/api/auth/register').set(H)
      .send({ companyName: `Co ${label} ${run}`, name: `Dono ${label}`, email: `${label}-${run}@teste.local`, password: PASSWORD }).expect(201);
    const company = await owner.post('/api/companies').set(H).send({ legalName: `${label} LTDA` }).expect(201);
    const est = await owner.post('/api/establishments').set(H).send({ companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz' }).expect(201);
    const w1 = await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito 1' }).expect(201);
    const w2 = await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD02', name: 'Depósito 2' }).expect(201);
    const roles = Object.fromEntries((await owner.get('/api/roles').expect(200)).body.map((r: any) => [r.key, r.id]));
    return { owner, tenantId: res.body.tenantId, wh1: w1.body.id, wh2: w2.body.id, roles };
  }

  async function loginAs(t: Tenant, roleKey: string) {
    const email = `${roleKey}-${uid()}@teste.local`;
    await t.owner.post('/api/users').set(H).send({ name: `User ${roleKey}`, email, password: PASSWORD, roleId: t.roles[roleKey] }).expect(201);
    const a = agent();
    await a.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200);
    return a;
  }

  const newProduct = async (t: Tenant, extra: object = {}) =>
    (await t.owner.post('/api/products').set(H).send({ sku: `SKU-${uid()}`, name: 'Produto Teste', ...extra }).expect(201)).body.id as string;

  const entry = (t: Tenant, productId: string, quantity: number, warehouseId = t.wh1, extra: object = {}) =>
    t.owner.post('/api/stock/movements').set(H).send({ productId, warehouseId, type: 'PURCHASE_ENTRY', quantity, ...extra });

  const balance = async (t: Tenant, productId: string, warehouseId = t.wh1) => {
    const rows = (await t.owner.get(`/api/stock/balances/${productId}`).expect(200)).body as any[];
    return rows.find((r) => r.warehouseId === warehouseId) ?? { onHand: 0, reserved: 0, blocked: 0, available: 0 };
  };

  let A: Tenant;
  let B: Tenant;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0); // servidor fixo: evita corrida de listen/close do supertest com requisições paralelas
    prisma = app.get(PrismaService);
    // o plano de avaliação limita usuários; o teste cria vários papéis
    const { PrismaClient } = await import('@prisma/client');
    const admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    await admin.plan.update({ where: { code: 'trial' }, data: { limits: { users: 100, establishments: 20, warehouses: 20 } } });
    await admin.$disconnect();
    A = await setup('stockA');
    B = await setup('stockB');
  });

  afterAll(async () => {
    await app.close();
  });

  describe('concorrência e integridade', () => {
    it('15 reservas simultâneas de 1 unidade com 10 em estoque: exatamente 10 passam', async () => {
      const p = await newProduct(A);
      await entry(A, p, 10).expect(201);
      const results = await Promise.all(
        Array.from({ length: 15 }, (_, i) =>
          A.owner.post('/api/stock/reservations').set(H).send({ productId: p, warehouseId: A.wh1, quantity: 1, idempotencyKey: `res-${uid()}-${i}` }),
        ),
      );
      const ok = results.filter((r) => r.status === 201).length;
      expect(ok).toBe(10);
      expect(results.filter((r) => r.status === 409)).toHaveLength(5);
      expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
      expect(await balance(A, p)).toMatchObject({ onHand: 10, reserved: 10, available: 0 });
    });

    it('15 saídas simultâneas com 10 em estoque nunca negativam', async () => {
      const p = await newProduct(A);
      await entry(A, p, 10).expect(201);
      const results = await Promise.all(
        Array.from({ length: 15 }, () => A.owner.post('/api/stock/movements').set(H).send({ productId: p, warehouseId: A.wh1, type: 'SALE_EXIT', quantity: 1 })),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(10);
      expect(await balance(A, p)).toMatchObject({ onHand: 0, available: 0 });
    });

    it('mesmo evento repetido (chave idempotente) não duplica movimento nem saldo', async () => {
      const p = await newProduct(A);
      const key = `evt-${uid()}`;
      const rs = await Promise.all([1, 2, 3, 4].map(() => entry(A, p, 5, A.wh1, { idempotencyKey: key })));
      expect(rs.every((r) => r.status === 201)).toBe(true);
      expect(rs.filter((r) => r.body.replayed === false)).toHaveLength(1);
      expect(await balance(A, p)).toMatchObject({ onHand: 5 });
      const mv = (await A.owner.get(`/api/stock/movements?productId=${p}`).expect(200)).body.items;
      expect(mv).toHaveLength(1);
    });

    it('reserva repetida com a mesma chave é replay e não reserva duas vezes', async () => {
      const p = await newProduct(A);
      await entry(A, p, 10).expect(201);
      const body = { productId: p, warehouseId: A.wh1, quantity: 4, idempotencyKey: `res-${uid()}` };
      const rs = await Promise.all([1, 2, 3].map(() => A.owner.post('/api/stock/reservations').set(H).send(body)));
      expect(rs.every((r) => r.status === 201)).toBe(true);
      expect(new Set(rs.map((r) => r.body.reservation.id)).size).toBe(1);
      expect(await balance(A, p)).toMatchObject({ reserved: 4, available: 6 });
    });

    it('saída acima do disponível (considerando reservas) é recusada com 409', async () => {
      const p = await newProduct(A);
      await entry(A, p, 5).expect(201);
      await A.owner.post('/api/stock/reservations').set(H).send({ productId: p, warehouseId: A.wh1, quantity: 3, idempotencyKey: `r-${uid()}` }).expect(201);
      await A.owner.post('/api/stock/movements').set(H).send({ productId: p, warehouseId: A.wh1, type: 'SALE_EXIT', quantity: 3 }).expect(409);
      await A.owner.post('/api/stock/movements').set(H).send({ productId: p, warehouseId: A.wh1, type: 'SALE_EXIT', quantity: 2 }).expect(201);
    });

    it('liberar, consumir e repetir: reserva muda de estado uma única vez', async () => {
      const p = await newProduct(A);
      await entry(A, p, 10).expect(201);
      const r1 = (await A.owner.post('/api/stock/reservations').set(H).send({ productId: p, warehouseId: A.wh1, quantity: 3, idempotencyKey: `r-${uid()}` }).expect(201)).body.reservation.id;
      const r2 = (await A.owner.post('/api/stock/reservations').set(H).send({ productId: p, warehouseId: A.wh1, quantity: 2, idempotencyKey: `r-${uid()}` }).expect(201)).body.reservation.id;
      await A.owner.post(`/api/stock/reservations/${r1}/release`).set(H).expect(201);
      expect((await A.owner.post(`/api/stock/reservations/${r1}/release`).set(H).expect(201)).body.replayed).toBe(true);
      await A.owner.post(`/api/stock/reservations/${r1}/consume`).set(H).expect(409);
      await Promise.all([1, 2].map(() => A.owner.post(`/api/stock/reservations/${r2}/consume`).set(H)));
      expect(await balance(A, p)).toMatchObject({ onHand: 8, reserved: 0, available: 8 });
      const mv = (await A.owner.get(`/api/stock/movements?productId=${p}`).expect(200)).body.items;
      expect(mv.filter((m: any) => m.type === 'SALE_EXIT')).toHaveLength(1);
    });

    it('estorno cria movimento inverso, só uma vez, e exige permissão', async () => {
      const p = await newProduct(A);
      const mv = (await entry(A, p, 7).expect(201)).body.movement ?? (await A.owner.get(`/api/stock/movements?productId=${p}`)).body.items[0];
      const id = mv.id;
      const operator = await loginAs(A, 'stock_operator');
      await operator.post(`/api/stock/movements/${id}/reverse`).set(H).send({ reason: 'x' }).expect(403);
      await A.owner.post(`/api/stock/movements/${id}/reverse`).set(H).send({ reason: 'lançamento errado' }).expect(201);
      await A.owner.post(`/api/stock/movements/${id}/reverse`).set(H).send({ reason: 'de novo' }).expect(409);
      expect(await balance(A, p)).toMatchObject({ onHand: 0 });
    });

    it('transferência move o saldo entre depósitos e transferências opostas simultâneas não geram erro 500', async () => {
      const p = await newProduct(A);
      await entry(A, p, 10, A.wh1).expect(201);
      await entry(A, p, 10, A.wh2).expect(201);
      const mk = (from: string, to: string) => A.owner.post('/api/stock/transfers').set(H).send({ productId: p, fromWarehouseId: from, toWarehouseId: to, quantity: 4 });
      const rs = await Promise.all([mk(A.wh1, A.wh2), mk(A.wh2, A.wh1), mk(A.wh1, A.wh2), mk(A.wh2, A.wh1)]);
      expect(rs.every((r) => r.status === 201)).toBe(true);
      const total = (await balance(A, p, A.wh1)).onHand + (await balance(A, p, A.wh2)).onHand;
      expect(total).toBe(20);
    });

    it('razão é imutável e o banco impede disponível negativo', async () => {
      const p = await newProduct(A);
      await entry(A, p, 3).expect(201);
      await expect(prisma.withContext({ tenantId: A.tenantId }, (tx) => tx.stockMovement.deleteMany({}))).rejects.toThrow();
      await expect(prisma.withContext({ tenantId: A.tenantId }, (tx) => tx.stockMovement.updateMany({ data: { quantity: 99 } }))).rejects.toThrow();
      await expect(
        prisma.withContext({ tenantId: A.tenantId }, (tx) => tx.$executeRaw`UPDATE stock_balances SET reserved = on_hand + 1 WHERE product_id = ${p}::uuid`),
      ).rejects.toThrow();
    });

    it('bloqueio reduz o disponível sem mexer no físico', async () => {
      const p = await newProduct(A);
      await entry(A, p, 10).expect(201);
      await A.owner.post('/api/stock/blocks').set(H).send({ productId: p, warehouseId: A.wh1, quantity: 4, reason: 'qualidade' }).expect(201);
      expect(await balance(A, p)).toMatchObject({ onHand: 10, blocked: 4, available: 6 });
      await A.owner.post('/api/stock/blocks').set(H).send({ productId: p, warehouseId: A.wh1, quantity: 7, reason: 'demais' }).expect(409);
    });
  });

  describe('inventário', () => {
    it('contagem por código de barras → envio → aprovação gera ajustes auditáveis', async () => {
      const barcode = `789${Date.now().toString().slice(-10)}`;
      const p1 = await newProduct(A, { barcode });
      const p2 = await newProduct(A);
      await entry(A, p1, 10).expect(201);
      await entry(A, p2, 5).expect(201);
      const operator = await loginAs(A, 'stock_operator');
      const manager = await loginAs(A, 'ops_manager');
      const c = (await operator.post('/api/inventory/counts').set(H).send({ warehouseId: A.wh1, name: `Ciclo ${uid()}` }).expect(201)).body;
      await operator.put(`/api/inventory/counts/${c.id}/items`).set(H).send({ entries: [{ code: barcode, countedQty: 8 }, { productId: p2, countedQty: 5 }] }).expect(200);
      await operator.post(`/api/inventory/counts/${c.id}/submit`).set(H).expect(201);
      await operator.post(`/api/inventory/counts/${c.id}/approve`).set(H).expect(403);
      const report = (await operator.get(`/api/inventory/counts/${c.id}`).expect(200)).body;
      expect(report.items.find((i: any) => i.productId === p1).divergence).toBe(-2);
      expect((await manager.post(`/api/inventory/counts/${c.id}/approve`).set(H).expect(201)).body.adjusted).toBe(1);
      await manager.post(`/api/inventory/counts/${c.id}/approve`).set(H).expect(409);
      expect(await balance(A, p1)).toMatchObject({ onHand: 8 });
      expect(await balance(A, p2)).toMatchObject({ onHand: 5 });
      const mv = (await A.owner.get(`/api/stock/movements?productId=${p1}`).expect(200)).body.items;
      expect(mv[0]).toMatchObject({ type: 'ADJUSTMENT', quantity: -2, balanceBefore: 10, balanceAfter: 8 });
    });

    it('aprovação é recusada (e nada é aplicado) se a contagem conflita com reservas', async () => {
      const p = await newProduct(A);
      await entry(A, p, 10).expect(201);
      await A.owner.post('/api/stock/reservations').set(H).send({ productId: p, warehouseId: A.wh1, quantity: 8, idempotencyKey: `r-${uid()}` }).expect(201);
      const c = (await A.owner.post('/api/inventory/counts').set(H).send({ warehouseId: A.wh1, name: `Conf ${uid()}`, productIds: [p] }).expect(201)).body;
      await A.owner.put(`/api/inventory/counts/${c.id}/items`).set(H).send({ entries: [{ productId: p, countedQty: 3 }] }).expect(200);
      await A.owner.post(`/api/inventory/counts/${c.id}/submit`).set(H).expect(201);
      await A.owner.post(`/api/inventory/counts/${c.id}/approve`).set(H).expect(409);
      expect(await balance(A, p)).toMatchObject({ onHand: 10 });
    });
  });

  describe('importação por planilha', () => {
    const csv = (lines: string[]) => ['sku;nome;codigo_barras;categoria;custo;preco_venda;estoque_minimo;ncm;deposito;saldo_inicial', ...lines].join('\n');

    it('simulação lista erros por linha sem gravar; confirmação com erros é recusada', async () => {
      const s = uid();
      const text = csv([`I-${s}-1;Parafuso;;Ferragens;1,50;3,90;10;73181500;CD01;100`, `;Sem sku;;;;;;;;`, `I-${s}-3;Porca;;Ferragens;abc;;;;;`]);
      const dry = await A.owner.post('/api/products/import').set(H).send({ csv: text, dryRun: true }).expect(200);
      expect(dry.body).toMatchObject({ committed: false, created: 1 });
      expect(dry.body.errors.map((e: any) => e.line).sort()).toEqual([3, 4]);
      const res = await A.owner.post('/api/products/import').set(H).send({ csv: text }).expect(422);
      expect(res.body.errors).toHaveLength(2);
      expect((await A.owner.get(`/api/products?search=I-${s}`).expect(200)).body.total).toBe(0);
    });

    it('importa linhas válidas, cria categoria e saldo inicial auditável; reimportar atualiza', async () => {
      const s = uid();
      const text = csv([`I-${s}-1;Parafuso;7891234567895;Ferragens;1,50;3,90;10;73181500;CD01;100`, `I-${s}-2;Porca;;Ferragens;0,80;1.200,00;;;;`]);
      const r = await A.owner.post('/api/products/import').set(H).send({ csv: text }).expect(200);
      expect(r.body).toMatchObject({ committed: true, created: 2, initialized: 1 });
      const list = (await A.owner.get(`/api/products?search=I-${s}`).expect(200)).body;
      expect(list.total).toBe(2);
      const parafuso = list.items.find((i: any) => i.sku === `I-${s}-1`);
      expect(parafuso).toMatchObject({ fiscalPending: false, costPrice: '1.5' });
      expect(list.items.find((i: any) => i.sku === `I-${s}-2`)).toMatchObject({ fiscalPending: true, suggestedPrice: '1200' });
      expect(await balance(A, parafuso.id)).toMatchObject({ onHand: 100 });
      const again = await A.owner.post('/api/products/import').set(H).send({ csv: text }).expect(200);
      expect(again.body).toMatchObject({ created: 0, updated: 2, initialized: 0 });
      expect(await balance(A, parafuso.id)).toMatchObject({ onHand: 100 });
    });

    it('saldo inicial exige permissão de ajuste', async () => {
      const commercial = await loginAs(A, 'commercial_manager');
      const text = csv([`I-${uid()};Item;;;;;;;CD01;5`]);
      const r = await commercial.post('/api/products/import').set(H).send({ csv: text, dryRun: true }).expect(200);
      expect(r.body.errors[0].message).toMatch(/permissão/);
    });
  });

  describe('permissões e isolamento', () => {
    it('vendedor consulta produtos e estoque, mas não cria produto nem movimenta', async () => {
      const seller = await loginAs(A, 'salesperson');
      await seller.get('/api/products').expect(200);
      await seller.get('/api/stock/overview').expect(200);
      await seller.post('/api/products').set(H).send({ sku: `X-${uid()}`, name: 'Nope' }).expect(403);
      await seller.post('/api/stock/movements').set(H).send({ productId: '00000000-0000-4000-8000-000000000000', warehouseId: A.wh1, type: 'PURCHASE_ENTRY', quantity: 1 }).expect(403);
      await seller.get('/api/suppliers').expect(403);
    });

    it('tenant B não vê nem movimenta produtos, reservas ou movimentos do tenant A', async () => {
      const p = await newProduct(A);
      const mv = (await entry(A, p, 5).expect(201)).body.movement;
      const key = `r-${uid()}`;
      const rsv = (await A.owner.post('/api/stock/reservations').set(H).send({ productId: p, warehouseId: A.wh1, quantity: 1, idempotencyKey: key }).expect(201)).body.reservation.id;
      await B.owner.get(`/api/products/${p}`).expect(404);
      await B.owner.patch(`/api/products/${p}`).set(H).send({ name: 'Invadido' }).expect(404);
      expect((await B.owner.get(`/api/products?search=${encodeURIComponent('Produto Teste')}`).expect(200)).body.total).toBe(0);
      expect((await B.owner.get(`/api/stock/movements?productId=${p}`).expect(200)).body.items).toHaveLength(0);
      await B.owner.post('/api/stock/movements').set(H).send({ productId: p, warehouseId: B.wh1, type: 'PURCHASE_ENTRY', quantity: 1 }).expect(404);
      await B.owner.post('/api/stock/movements').set(H).send({ productId: await newProduct(B), warehouseId: A.wh1, type: 'PURCHASE_ENTRY', quantity: 1 }).expect(404);
      await B.owner.post(`/api/stock/reservations/${rsv}/release`).set(H).expect(404);
      await B.owner.post(`/api/stock/movements/${mv?.id ?? '00000000-0000-4000-8000-000000000000'}/reverse`).set(H).send({ reason: 'x' }).expect(404);
      // mesma chave idempotente em outro tenant não colide
      const pb = await newProduct(B);
      await entry(B, pb, 2, B.wh1, { idempotencyKey: key }).expect(201);
    });

    it('fornecedores: CNPJ/CPF validados, duplicidade negada e vínculo com produto', async () => {
      const p = await newProduct(A);
      await A.owner.post('/api/suppliers').set(H).send({ legalName: 'Forn Ruim', document: '11.222.333/0001-82' }).expect(400);
      const s = (await A.owner.post('/api/suppliers').set(H).send({ legalName: 'Fornecedor SA', document: '11.222.333/0001-81', leadTimeDays: 7 }).expect(201)).body;
      await A.owner.post('/api/suppliers').set(H).send({ legalName: 'Outro', document: '11222333000181' }).expect(409);
      await A.owner.post(`/api/products/${p}/suppliers`).set(H).send({ supplierId: s.id, lastPrice: 2.5, isMain: true }).expect(200);
      const detail = (await A.owner.get(`/api/products/${p}`).expect(200)).body;
      expect(detail.suppliers[0]).toMatchObject({ isMain: true, supplier: { legalName: 'Fornecedor SA' } });
      await B.owner.post(`/api/products/${await newProduct(B)}/suppliers`).set(H).send({ supplierId: s.id }).expect(404);
    });

    it('dados fiscais ausentes são sinalizados e alterações sensíveis são auditadas', async () => {
      const p = await newProduct(A);
      expect((await A.owner.get(`/api/products/${p}`).expect(200)).body.fiscalPending).toBe(true);
      await A.owner.patch(`/api/products/${p}`).set(H).send({ ncm: '1234' }).expect(400);
      await A.owner.patch(`/api/products/${p}`).set(H).send({ ncm: '73181500', costPrice: 9.9 }).expect(200);
      const audit = (await A.owner.get('/api/audit?action=product.sensitive_updated').expect(200)).body.items;
      expect(audit[0].metadata.changes.map((c: any) => c.field).sort()).toEqual(['costPrice', 'ncm']);
      const m = (await A.owner.get('/api/stock/metrics').expect(200)).body;
      expect(m.products).toBeGreaterThan(0);
      expect(m.fiscalPending).toBeGreaterThan(0);
    });
  });
});
