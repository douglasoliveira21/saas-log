import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';
import { JobWorker } from '../src/integrations/jobs.service';
import { SandboxConnector } from '../src/integrations/providers';
import { PrismaService } from '../src/prisma/prisma.service';

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);
let seq = 0;
const uid = () => `${run}${++seq}`;

describe('Fase 5b — anúncios, preço, estoque publicável, categorias e sincronização por canal', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let worker: JobWorker;
  let admin: PrismaClient;
  const agent = () => request.agent(app.getHttpServer());
  type Agent = ReturnType<typeof agent>;
  interface T { owner: Agent; tenantId: string; wh: string; roles: Record<string, string>; users: Record<string, Agent> }

  async function setup(label: string): Promise<T> {
    const owner = agent();
    const reg = await owner.post('/api/auth/register').set(H).send({ companyName: `Co ${label} ${run}`, name: `Dono ${label}`, email: `${label}-${run}@teste.local`, password: PASSWORD }).expect(201);
    const company = await owner.post('/api/companies').set(H).send({ legalName: `${label} LTDA` }).expect(201);
    const est = await owner.post('/api/establishments').set(H).send({ companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz' }).expect(201);
    const wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
    const roles = Object.fromEntries((await owner.get('/api/roles').expect(200)).body.map((r: any) => [r.key, r.id]));
    const t: T = { owner, tenantId: reg.body.tenantId, wh, roles, users: {} };
    for (const k of ['commercial_manager', 'ops_manager', 'stock_operator']) t.users[k] = await addUser(t, roles[k]);
    return t;
  }
  async function addUser(t: T, roleId: string) {
    const email = `u-${uid()}@teste.local`;
    await t.owner.post('/api/users').set(H).send({ name: 'Usuario', email, password: PASSWORD, roleId }).expect(201);
    const a = agent();
    await a.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200);
    return a;
  }

  const stateOf = (url: string) => new URL(url).searchParams.get('state')!;
  const drain = async () => { for (let i = 0; i < 10; i++) if ((await worker.runOnce(20)) === 0) break; };
  const product = async (t: T, extra: object = {}, stock = 0) => {
    const id = (await t.owner.post('/api/products').set(H).send({ sku: `CH-${uid()}`, name: 'Produto canal', costPrice: 50, extraCost: 2, ...extra }).expect(201)).body.id as string;
    if (stock) await t.owner.post('/api/stock/movements').set(H).send({ productId: id, warehouseId: t.wh, type: 'PURCHASE_ENTRY', quantity: stock }).expect(201);
    return id;
  };

  async function sandbox(t: T, cfg: object = {}) {
    const id = (await t.owner.post('/api/integrations/connections').set(H).send({ provider: 'SANDBOX', label: `sbx ${uid()}` }).expect(201)).body.id as string;
    await t.owner.put(`/api/integrations/connections/${id}/config`).set(H).send({ warehouseId: t.wh, stockSync: true, priceSync: true, ...cfg }).expect(200);
    const auth = (await t.owner.post(`/api/integrations/connections/${id}/authorize`).set(H).expect(200)).body;
    await request(app.getHttpServer()).get(`/api/integrations/callback?code=sandbox-code&state=${encodeURIComponent(stateOf(auth.authorizationUrl))}`).expect(302);
    await t.owner.post(`/api/integrations/connections/${id}/test`).set(H).expect(200);
    await t.owner.post(`/api/integrations/connections/${id}/activate`).set(H).expect(200);
    return id;
  }
  const listing = (t: T, id: string, productId: string, externalItemId?: string) =>
    t.owner.post(`/api/integrations/connections/${id}/listings`).set(H).send({ productId, ...(externalItemId ? { externalItemId } : {}) });
  const listings = async (t: T, id: string) => (await t.owner.get(`/api/integrations/connections/${id}/listings`).expect(200)).body as any[];
  const fees = { commissionPct: 16, paymentPct: 4, taxPct: 6, fixedFee: 6, shippingSubsidy: 10, packaging: 2, minMarginPct: 10 };
  const syncNow = async (t: T, id: string) => {
    await admin.$executeRaw`UPDATE background_jobs SET status = 'CANCELLED' WHERE connection_id = ${id}::uuid AND status = 'QUEUED'`;
    await admin.$executeRaw`DELETE FROM background_jobs WHERE connection_id = ${id}::uuid AND idempotency_key LIKE 'sync-manual:%'`;
    await t.owner.post(`/api/integrations/connections/${id}/sync`).set(H).expect(200);
    await drain();
  };

  let A: T;
  let B: T;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    prisma = app.get(PrismaService);
    worker = app.get(JobWorker);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    await admin.$executeRaw`UPDATE marketplace_connections SET status = 'DISCONNECTED' WHERE status IN ('ACTIVE','SYNC_ERROR')`;
    await admin.$executeRaw`UPDATE background_jobs SET status = 'CANCELLED' WHERE status IN ('QUEUED','RUNNING')`;
    await admin.plan.update({ where: { code: 'trial' }, data: { limits: { users: 100, establishments: 20, warehouses: 20 } } });
    A = await setup('chA');
    B = await setup('chB');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(() => { SandboxConnector.pushed.length = 0; });

  describe('simulador de preços e perfil de tarifas', () => {
    it('calcula equilíbrio, preço recomendado (margem sobre a venda) e avaliações; tributos são estimativa informada', async () => {
      const conn = await sandbox(A);
      await A.users.commercial_manager.put(`/api/integrations/connections/${conn}/fees`).set(H).send(fees).expect(200);
      const p = await product(A, { minPrice: 100 });
      const r = (await A.users.commercial_manager.post('/api/integrations/pricing/simulate').set(H).send({ productId: p, connectionId: conn, prices: [90, 150], targetMarginPct: 20 }).expect(200)).body;
      expect(r.breakEvenPrice).toBe(94.6);
      expect(r.recommendedPrice).toBe(129.63);
      expect(r.evaluations[1]).toMatchObject({ price: 150, contribution: 41, marginPct: 27.33, markupPct: 78.85 });
      expect(r.evaluations[0].check).toMatchObject({ ok: false });
      expect(r.note).toMatch(/ESTIMATIVA/);
      // meta impossível
      const imp = (await A.owner.post('/api/integrations/pricing/simulate').set(H).send({ productId: p, connectionId: conn, targetMarginPct: 80 }).expect(200)).body;
      expect(imp.recommendedPrice).toBeNull();
      // sobrescrita pontual do perfil não altera o salvo
      const alt = (await A.owner.post('/api/integrations/pricing/simulate').set(H).send({ productId: p, connectionId: conn, fees: { commissionPct: 0, paymentPct: 0, taxPct: 0, fixedFee: 0, shippingSubsidy: 0, packaging: 0 }, prices: [100] }).expect(200)).body;
      expect(alt.evaluations[0].contribution).toBe(48);
      expect((await A.owner.get(`/api/integrations/connections/${conn}/fees`).expect(200)).body.commissionPct).toBe(16);
    });

    it('produto sem custo não é simulado; permissões e validação das tarifas', async () => {
      const conn = await sandbox(A);
      const semCusto = (await A.owner.post('/api/products').set(H).send({ sku: `SC-${uid()}`, name: 'Sem custo' }).expect(201)).body.id;
      await A.owner.post('/api/integrations/pricing/simulate').set(H).send({ productId: semCusto, prices: [10] }).expect(422);
      await A.users.stock_operator.post('/api/integrations/pricing/simulate').set(H).send({ productId: semCusto }).expect(403);
      await A.users.ops_manager.put(`/api/integrations/connections/${conn}/fees`).set(H).send(fees).expect(403); // só consulta preços
      await A.owner.put(`/api/integrations/connections/${conn}/fees`).set(H).send({ ...fees, commissionPct: -1 }).expect(400);
      await A.owner.put(`/api/integrations/connections/${conn}/fees`).set(H).send({ ...fees, taxPct: 101 }).expect(400);
      await A.owner.put(`/api/integrations/connections/${conn}/fees`).set(H).send(fees).expect(200);
      const audit = (await A.owner.get('/api/audit?action=pricing.fees_changed').expect(200)).body.items[0];
      expect(audit.metadata.after.commissionPct).toBe(16);
    });
  });

  describe('anúncios e preço aprovado do canal', () => {
    it('vincula anúncio ao produto (alimenta a importação de pedidos), impede duplicidade e isola tenants', async () => {
      const conn = await sandbox(A);
      const p1 = await product(A); const p2 = await product(A);
      await listing(A, conn, p1).expect(200);
      expect((await listings(A, conn))[0]).toMatchObject({ status: 'DRAFT', externalItemId: null });
      await listing(A, conn, p1, 'MLB-100').expect(200);
      await listing(A, conn, p2, 'MLB-100').expect(409);
      expect((await listings(A, conn)).find((l) => l.productId === p1)).toMatchObject({ status: 'LINKED', externalItemId: 'MLB-100' });
      const map = await admin.externalEntityMapping.findUnique({ where: { connectionId_entityType_externalId: { connectionId: conn, entityType: 'LISTING', externalId: 'MLB-100' } } });
      expect(map?.internalId).toBe(p1);
      // religar a outro anúncio desfaz o vínculo antigo
      await listing(A, conn, p1, 'MLB-200').expect(200);
      expect((await admin.externalEntityMapping.findUnique({ where: { connectionId_entityType_externalId: { connectionId: conn, entityType: 'LISTING', externalId: 'MLB-100' } } }))?.internalId).toBeNull();

      const pb = await product(B);
      await listing(A, conn, pb).expect(400); // produto de outro tenant
      await B.owner.get(`/api/integrations/connections/${conn}/listings`).expect(404);
      await B.owner.post(`/api/integrations/connections/${conn}/listings`).set(H).send({ productId: pb }).expect(404);
      await A.users.stock_operator.get(`/api/integrations/connections/${conn}/listings`).expect(403);
    });

    it('preço: valida piso do produto e margem mínima, exige confirmação para variação > 20%, registra histórico e auditoria', async () => {
      const conn = await sandbox(A);
      await A.owner.put(`/api/integrations/connections/${conn}/fees`).set(H).send(fees).expect(200);
      const p = await product(A, { minPrice: 100 });
      const cm = A.users.commercial_manager;
      await cm.put(`/api/integrations/connections/${conn}/listings/${p}/price`).set(H).send({ price: 150, reason: 'inicial' }).expect(404); // sem anúncio
      await listing(A, conn, p, 'MLB-1').expect(200);
      const put = (price: number, extra: object = {}) => cm.put(`/api/integrations/connections/${conn}/listings/${p}/price`).set(H).send({ price, reason: 'ajuste de teste', ...extra });
      expect((await put(90).expect(422)).body.message).toMatch(/mínimo autorizado/);
      const low = await put(105).expect(422);
      expect(low.body.message).toMatch(/margem mínima/);
      expect(low.body.evaluation.marginPct).toBeLessThan(10);
      await A.users.ops_manager.put(`/api/integrations/connections/${conn}/listings/${p}/price`).set(H).send({ price: 150, reason: 'sem permissão' }).expect(403);

      const ok = (await put(150).expect(200)).body;
      expect(ok.evaluation.marginPct).toBe(27.33);
      expect(ok.appliesAt).toMatch(/próxima sincronização/);
      const big = await put(200).expect(409);
      expect(big.body.requiresConfirmation).toBe(true);
      await put(200, { confirmLargeChange: true }).expect(200);
      await put(205).expect(200);

      const hist = (await cm.get(`/api/integrations/connections/${conn}/price-history?productId=${p}`).expect(200)).body;
      expect(hist.map((h: any) => [h.oldPrice, h.newPrice])).toEqual([['200', '205'], ['150', '200'], [null, '150']]);
      expect(hist[2].marginPct).toBe('27.33');
      await expect(prisma.withContext({ tenantId: A.tenantId }, (tx) => tx.priceHistory.deleteMany({}))).rejects.toThrow(); // imutável
      expect((await B.owner.get(`/api/integrations/connections/${conn}/price-history`).expect(404)).status).toBe(404);
      const audit = (await A.owner.get('/api/audit?action=pricing.channel_price_set').expect(200)).body.items;
      expect(audit.length).toBeGreaterThanOrEqual(3);
    });

    it('margem e custos só aparecem para quem tem permissão de preços', async () => {
      const conn = await sandbox(A);
      const p = await product(A, { minPrice: 80 });
      await listing(A, conn, p, 'MLB-9').expect(200);
      await A.owner.put(`/api/integrations/connections/${conn}/listings/${p}/price`).set(H).send({ price: 150, reason: 'x1x' }).expect(200);
      const role = (await A.owner.post('/api/roles').set(H).send({ name: `So integracoes ${uid()}`, permissions: ['integrations.view'] }).expect(201)).body.id;
      const viewer = await addUser(A, role);
      const row = ((await viewer.get(`/api/integrations/connections/${conn}/listings`).expect(200)).body as any[])[0];
      expect(row.price).toBe(150);
      expect(row).not.toHaveProperty('margin');
      expect(row).not.toHaveProperty('minPrice');
      await viewer.get(`/api/integrations/connections/${conn}/price-history`).expect(403);
      expect(((await A.owner.get(`/api/integrations/connections/${conn}/listings`)).body as any[])[0]).toHaveProperty('margin');
    });
  });

  describe('estoque publicável e sincronização', () => {
    it('publica estoque = disponível − segurança (exemplo: 100 físico, 8 reservado, 2 bloqueado, 5 segurança → 85) e só reenvia o que mudou', async () => {
      const conn = await sandbox(A, { safetyStock: 5 });
      await A.owner.put(`/api/integrations/connections/${conn}/fees`).set(H).send(fees).expect(200);
      const p = await product(A, {}, 100);
      await A.owner.post('/api/stock/reservations').set(H).send({ productId: p, warehouseId: A.wh, quantity: 8, idempotencyKey: `r-${uid()}` }).expect(201);
      await A.owner.post('/api/stock/blocks').set(H).send({ productId: p, warehouseId: A.wh, quantity: 2, reason: 'qualidade' }).expect(201);
      await listing(A, conn, p, 'SBX-A').expect(200);
      await A.owner.put(`/api/integrations/connections/${conn}/listings/${p}/price`).set(H).send({ price: 150, reason: 'preço de lançamento' }).expect(200);

      expect((await listings(A, conn))[0]).toMatchObject({ availableQty: 90, publishableQty: 85 });
      await syncNow(A, conn);
      expect(SandboxConnector.pushed).toEqual([{ op: 'updateInventory', externalId: 'SBX-A', value: 85 }, { op: 'updatePrice', externalId: 'SBX-A', value: 150 }]);
      expect((await listings(A, conn))[0]).toMatchObject({ lastPublishedQty: 85, lastPublishedPrice: 150, syncStatus: 'OK', syncError: null });

      // nada mudou → nada é enviado
      SandboxConnector.pushed.length = 0;
      await syncNow(A, conn);
      expect(SandboxConnector.pushed).toHaveLength(0);

      // uma venda reduz o disponível → só o estoque é enviado
      await A.owner.post('/api/stock/reservations').set(H).send({ productId: p, warehouseId: A.wh, quantity: 10, idempotencyKey: `r-${uid()}` }).expect(201);
      await syncNow(A, conn);
      expect(SandboxConnector.pushed).toEqual([{ op: 'updateInventory', externalId: 'SBX-A', value: 75 }]);

      // teto de publicação
      await A.owner.put(`/api/integrations/connections/${conn}/config`).set(H).send({ maxPublished: 20 }).expect(200);
      SandboxConnector.pushed.length = 0;
      await syncNow(A, conn);
      expect(SandboxConnector.pushed).toEqual([{ op: 'updateInventory', externalId: 'SBX-A', value: 20 }]);
      // estoque nunca é publicado negativo
      await A.owner.put(`/api/integrations/connections/${conn}/config`).set(H).send({ safetyStock: 999, maxPublished: 20 }).expect(200);
      SandboxConnector.pushed.length = 0;
      await syncNow(A, conn);
      expect(SandboxConnector.pushed).toEqual([{ op: 'updateInventory', externalId: 'SBX-A', value: 0 }]);
    });

    it('preço aprovado é revalidado no envio: se o custo subiu e a margem caiu, o preço NÃO é enviado e o motivo fica registrado', async () => {
      const conn = await sandbox(A);
      await A.owner.put(`/api/integrations/connections/${conn}/fees`).set(H).send(fees).expect(200);
      const p = await product(A, {}, 10);
      await listing(A, conn, p, 'SBX-B').expect(200);
      await A.owner.put(`/api/integrations/connections/${conn}/listings/${p}/price`).set(H).send({ price: 110, reason: 'preço base' }).expect(200);
      await A.owner.patch(`/api/products/${p}`).set(H).send({ costPrice: 80 }).expect(200); // margem cai abaixo de 10%
      await syncNow(A, conn);
      expect(SandboxConnector.pushed).toEqual([{ op: 'updateInventory', externalId: 'SBX-B', value: 10 }]);
      const l = (await listings(A, conn))[0];
      expect(l.syncStatus).toBe('ERROR');
      expect(l.syncError).toMatch(/preço não enviado.*margem mínima/);
      expect(l.lastPublishedPrice).toBeNull();
    });

    it('desligar envio de estoque/preço na conexão não envia nada', async () => {
      const conn = await sandbox(A, { stockSync: false, priceSync: false });
      const p = await product(A, {}, 5);
      await listing(A, conn, p, 'SBX-C').expect(200);
      await syncNow(A, conn);
      expect(SandboxConnector.pushed).toHaveLength(0);
      const job = (await admin.backgroundJob.findMany({ where: { connectionId: conn, type: 'channel.sync' } }))[0];
      expect(job.result).toMatchObject({ skipped: expect.stringMatching(/desligado/) });
    });

    it('falha temporária: progresso parcial é mantido, o job é reagendado e conclui sem reenviar o que já foi', async () => {
      const conn = await sandbox(A);
      await A.owner.put(`/api/integrations/connections/${conn}/fees`).set(H).send(fees).expect(200);
      const p1 = await product(A, {}, 10); const p2 = await product(A, {}, 20);
      await listing(A, conn, p1, 'SBX-D1').expect(200);
      await listing(A, conn, p2, 'SBX-D2').expect(200);
      await A.owner.put(`/api/integrations/connections/${conn}/config`).set(H).send({ sandbox: { push: 'unavailable' } }).expect(200);
      await syncNow(A, conn);
      const job = (await admin.backgroundJob.findMany({ where: { connectionId: conn, type: 'channel.sync' }, orderBy: { createdAt: 'desc' } }))[0];
      expect(job.status).toBe('QUEUED');
      expect(job.lastError).toMatch(/UNAVAILABLE/);
      await A.owner.put(`/api/integrations/connections/${conn}/config`).set(H).send({ sandbox: { push: 'ok' } }).expect(200);
      await admin.$executeRaw`UPDATE background_jobs SET run_at = now() - interval '1 second' WHERE id = ${job.id}::uuid`;
      await drain();
      expect(SandboxConnector.pushed.map((x) => `${x.externalId}:${x.value}`).sort()).toEqual(['SBX-D1:10', 'SBX-D2:20']);
      expect((await admin.backgroundJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SUCCEEDED');
    });

    it('recusa do canal (validação) marca só aquele anúncio com erro e segue com os demais', async () => {
      const conn = await sandbox(A);
      const p1 = await product(A, {}, 10); const p2 = await product(A, {}, 20);
      await listing(A, conn, p1, 'SBX-E1').expect(200);
      await listing(A, conn, p2, 'SBX-E2').expect(200);
      await A.owner.put(`/api/integrations/connections/${conn}/config`).set(H).send({ sandbox: { push: 'validation' } }).expect(200);
      await syncNow(A, conn);
      const ls = await listings(A, conn);
      expect(ls.every((l) => l.syncStatus === 'ERROR' && /recusou/.test(l.syncError))).toBe(true);
      expect((await admin.backgroundJob.findMany({ where: { connectionId: conn, type: 'channel.sync' } }))[0].status).toBe('SUCCEEDED');
    });

    it('Mercado Livre (conector sem envio implementado): anúncio fica BLOQUEADO com motivo, nunca "sincronizado"; sem repetição infinita', async () => {
      const id = (await A.owner.post('/api/integrations/connections').set(H).send({ provider: 'MERCADO_LIVRE', label: 'ML bloqueado' }).expect(201)).body.id as string;
      await admin.marketplaceConnection.update({ where: { id }, data: { status: 'ACTIVE', warehouseId: A.wh, config: { stockSync: true, priceSync: true } } });
      const p = await product(A, {}, 7);
      await listing(A, id, p, 'MLB-X').expect(200);
      await syncNow(A, id);
      const l = (await listings(A, id))[0];
      expect(l.syncStatus).toBe('BLOCKED');
      expect(l.syncError).toMatch(/ainda não foi implementada/);
      expect(l.lastPublishedQty).toBeNull();
      const job = (await admin.backgroundJob.findMany({ where: { connectionId: id, type: 'channel.sync' } }))[0];
      expect(job.status).toBe('SUCCEEDED');
      expect(job.result).toMatchObject({ blocked: 1, stockSent: 0 });
      expect((await admin.marketplaceConnection.findUniqueOrThrow({ where: { id } })).status).toBe('ACTIVE');
    });

    it('agendador enfileira a sincronização uma vez por janela, só para conexões com envio ligado; sincronização manual exige conexão ativa', async () => {
      const on = await sandbox(A);
      const off = await sandbox(A, { stockSync: false, priceSync: false });
      const when = new Date(Date.now() + 777 * 86_400_000);
      await worker.schedule(when);
      expect(await worker.schedule(when)).toBe(0);
      expect((await admin.backgroundJob.count({ where: { connectionId: on, type: 'channel.sync' } }))).toBe(1);
      expect((await admin.backgroundJob.count({ where: { connectionId: off, type: 'channel.sync' } }))).toBe(0);
      await drain();
      const pending = (await A.owner.post('/api/integrations/connections').set(H).send({ provider: 'SANDBOX', label: 'inativa' }).expect(201)).body.id;
      await A.owner.post(`/api/integrations/connections/${pending}/sync`).set(H).expect(409);
      await A.users.ops_manager.post(`/api/integrations/connections/${on}/sync`).set(H).expect(403);
    });
  });

  describe('mapeamento de categorias', () => {
    it('mapeia, atualiza e remove; valida categoria; isolamento e permissão', async () => {
      const conn = await sandbox(A);
      const cat = (await A.owner.post('/api/categories').set(H).send({ name: `Cat ${uid()}` }).expect(201)).body.id;
      const catB = (await B.owner.post('/api/categories').set(H).send({ name: `Cat ${uid()}` }).expect(201)).body.id;
      const put = (categoryId: string, extId: string) => A.owner.put(`/api/integrations/connections/${conn}/category-map`).set(H).send({ categoryId, externalCategoryId: extId, externalCategoryName: 'Ferramentas' });
      await put(catB, 'MLB1').expect(400);
      await put(cat, 'MLB1648').expect(200);
      await put(cat, 'MLB1649').expect(200);
      const rows = (await A.owner.get(`/api/integrations/connections/${conn}/category-map`).expect(200)).body;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ externalCategoryId: 'MLB1649', externalCategoryName: 'Ferramentas' });
      await A.users.ops_manager.put(`/api/integrations/connections/${conn}/category-map`).set(H).send({ categoryId: cat, externalCategoryId: 'X' }).expect(403);
      await B.owner.get(`/api/integrations/connections/${conn}/category-map`).expect(404);
      await B.owner.delete(`/api/integrations/connections/${conn}/category-map/${cat}`).set(H).expect(404);
      await A.owner.delete(`/api/integrations/connections/${conn}/category-map/${cat}`).set(H).expect(200);
      await A.owner.delete(`/api/integrations/connections/${conn}/category-map/${cat}`).set(H).expect(404);
    });
  });
});
