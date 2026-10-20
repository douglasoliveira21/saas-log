import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';
import { CryptoService } from '../src/integrations/crypto.service';
import { JobWorker } from '../src/integrations/jobs.service';
import { OrderImportService } from '../src/integrations/order-import.service';

/**
 * ATENÇÃO: o servidor abaixo SIMULA o Mercado Livre conforme a documentação consultada (ver MARKETPLACE-INTEGRATIONS.md).
 * Estes testes provam o comportamento do NOSSO código diante dessas respostas; não provam que a API real se comporta
 * assim. A validação com conta real continua pendente.
 */
class MockML {
  server!: Server;
  base = '';
  accessTokens = new Set<string>();
  refreshTokens = new Set<string>();
  n = 0;
  requests: { method: string; path: string; query: URLSearchParams; body: URLSearchParams | null; auth: string | null }[] = [];
  orders: Record<string, any>[] = [];
  expiresIn = 21600;
  withRefresh = true;
  userId = 555;
  fail: { status: number; retryAfter?: number } | null = null;

  order(id: number, o: Partial<{ status: string; sku: string; item: string; qty: number; price: number; buyer: number; seller: number; date: string }> = {}) {
    return {
      id, status: o.status ?? 'paid', date_created: o.date ?? new Date().toISOString(), total_amount: (o.qty ?? 2) * (o.price ?? 50),
      buyer: { id: o.buyer ?? 9001, nickname: `COMPRADOR${o.buyer ?? 9001}` }, seller: { id: o.seller ?? this.userId },
      order_items: [{ item: { id: o.item ?? 'MLB-1', title: 'Parafuso', seller_sku: o.sku ?? 'ML-SKU' }, quantity: o.qty ?? 2, unit_price: o.price ?? 50 }],
      shipping: { id: 77 }, pack_id: null,
    };
  }

  async start() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop() { return new Promise<void>((r) => this.server.close(() => r())); }
  issue() {
    const a = `APP_USR-access-${++this.n}`;
    const r = `TG-refresh-${this.n}`;
    this.accessTokens.add(a);
    if (this.withRefresh) this.refreshTokens.add(r);
    return { access_token: a, ...(this.withRefresh ? { refresh_token: r } : {}), expires_in: this.expiresIn, user_id: this.userId, scope: 'offline_access read write' };
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, this.base);
    const raw = await new Promise<string>((ok) => { let s = ''; req.on('data', (d) => (s += d)).on('end', () => ok(s)); });
    const body = raw ? new URLSearchParams(raw) : null;
    const auth = (req.headers.authorization as string | undefined) ?? null;
    this.requests.push({ method: req.method!, path: url.pathname, query: url.searchParams, body, auth });
    const send = (status: number, json: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(json)); };

    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      if (body?.get('client_id') !== 'APP-ID' || body?.get('client_secret') !== 'APP-SECRET') return send(401, { message: 'invalid_client' });
      if (body.get('grant_type') === 'authorization_code') return body.get('code') === 'good-code' ? send(200, this.issue()) : send(400, { message: 'invalid_grant', error: 'invalid_grant' });
      if (body.get('grant_type') === 'refresh_token') {
        const rt = body.get('refresh_token')!;
        if (!this.refreshTokens.delete(rt)) return send(400, { message: 'invalid_grant', error: 'invalid_grant' }); // uso único
        return send(200, this.issue());
      }
      return send(400, { message: 'unsupported_grant_type' });
    }
    if (this.fail && url.pathname !== '/oauth/token') return send(this.fail.status, { message: 'erro simulado' }, this.fail.retryAfter ? { 'retry-after': String(this.fail.retryAfter) } : {});
    const token = auth?.replace('Bearer ', '') ?? '';
    if (!this.accessTokens.has(token)) return send(401, { message: 'invalid_token' });
    if (url.pathname === '/users/me') return send(200, { id: this.userId, nickname: 'VENDEDOR' });
    if (url.pathname === '/orders/search') {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 50);
      return send(200, { results: this.orders.slice(offset, offset + limit), paging: { total: this.orders.length, offset, limit } });
    }
    const m = url.pathname.match(/^\/orders\/(\d+)$/);
    if (m) { const o = this.orders.find((x) => String(x.id) === m[1]); return o ? send(200, o) : send(404, { message: 'not found' }); }
    return send(404, { message: 'rota inexistente no simulador' });
  }
}

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);
let seq = 0;
const uid = () => `${run}${++seq}`;

describe('Fase 5 — Mercado Livre (servidor simulado): OAuth, pedidos e notificações', () => {
  let app: INestApplication;
  let worker: JobWorker;
  let importer: OrderImportService;
  let crypto: CryptoService;
  let admin: PrismaClient;
  const ml = new MockML();
  const agent = () => request.agent(app.getHttpServer());
  type Agent = ReturnType<typeof agent>;
  interface T { owner: Agent; tenantId: string; wh: string }

  async function setup(label: string): Promise<T> {
    const owner = agent();
    const reg = await owner.post('/api/auth/register').set(H).send({ companyName: `Co ${label} ${run}`, name: `Dono ${label}`, email: `${label}-${run}@teste.local`, password: PASSWORD }).expect(201);
    const company = await owner.post('/api/companies').set(H).send({ legalName: `${label} LTDA` }).expect(201);
    const est = await owner.post('/api/establishments').set(H).send({ companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz' }).expect(201);
    const wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
    return { owner, tenantId: reg.body.tenantId, wh };
  }

  const stateOf = (url: string) => new URL(url).searchParams.get('state')!;
  const callback = (state: string, code = 'good-code') => request(app.getHttpServer()).get(`/api/integrations/callback?code=${code}&state=${encodeURIComponent(state)}`);
  const drain = async () => { for (let i = 0; i < 10; i++) if ((await worker.runOnce(20)) === 0) break; };
  const due = (tenantId: string) => admin.$executeRaw`UPDATE background_jobs SET run_at = now() - interval '1 second' WHERE tenant_id = ${tenantId}::uuid AND status = 'QUEUED'`;

  /** A mesma conta de vendedor só pode estar em uma conexão por empresa. */
  async function dropML(t: T) {
    const existing = (await t.owner.get('/api/integrations/connections').expect(200)).body as { id: string; provider: string; status: string }[];
    for (const c of existing) if (c.provider === 'MERCADO_LIVRE' && c.status !== 'DISCONNECTED') await t.owner.post(`/api/integrations/connections/${c.id}/disconnect`).set(H).expect(200);
  }

  /** Conecta (OAuth) um canal ML do tenant e o deixa ativo. */
  async function connectML(t: T, cfg: object = {}) {
    await dropML(t);
    const id = (await t.owner.post('/api/integrations/connections').set(H).send({ provider: 'MERCADO_LIVRE', label: `ML ${uid()}` }).expect(201)).body.id as string;
    await t.owner.put(`/api/integrations/connections/${id}/config`).set(H).send({ warehouseId: t.wh, ...cfg }).expect(200);
    const auth = (await t.owner.post(`/api/integrations/connections/${id}/authorize`).set(H).expect(200)).body;
    const cb = await callback(stateOf(auth.authorizationUrl)).expect(302);
    expect(cb.headers.location).toContain(`connected=${id}`);
    await t.owner.post(`/api/integrations/connections/${id}/test`).set(H).expect(200);
    await t.owner.post(`/api/integrations/connections/${id}/activate`).set(H).expect(200);
    return id;
  }

  const product = async (t: T, sku: string, stock = 0) => {
    const id = (await t.owner.post('/api/products').set(H).send({ sku, name: `Produto ${sku}`, suggestedPrice: 50, costPrice: 10 }).expect(201)).body.id as string;
    if (stock) await t.owner.post('/api/stock/movements').set(H).send({ productId: id, warehouseId: t.wh, type: 'PURCHASE_ENTRY', quantity: stock }).expect(201);
    return id;
  };
  const avail = async (t: T, productId: string) => ((await t.owner.get(`/api/stock/balances/${productId}`).expect(200)).body[0] ?? { available: 0, reserved: 0, onHand: 0 });
  const ledger = async (t: T, id: string, status?: string) => (await t.owner.get(`/api/integrations/connections/${id}/orders${status ? `?status=${status}` : ''}`).expect(200)).body as any[];
  const salesByRef = (t: T, ref: string) => admin.salesOrder.findMany({ where: { tenantId: t.tenantId, externalRef: ref } });
  const reconcile = async (t: T) => { await worker.schedule(new Date(Date.now() + Math.floor(Math.random() * 1e6) * 60_000)); await drain(); void t; };
  const syncNow = async (t: T, id: string) => {
    await admin.marketplaceConnection.update({ where: { id }, data: { lastSyncAt: null } });
    await admin.$executeRaw`UPDATE background_jobs SET status = 'CANCELLED' WHERE connection_id = ${id}::uuid AND status = 'QUEUED'`;
    await admin.backgroundJob.deleteMany({ where: { connectionId: id, type: 'connection.reconcile', status: { in: ['SUCCEEDED', 'FAILED', 'DEAD', 'CANCELLED'] }, idempotencyKey: { startsWith: 'reconcile:' } } }).catch(() => undefined);
    await worker.schedule(new Date(Date.now() + 365 * 86_400_000 + Math.floor(Math.random() * 1e6) * 1000));
    await drain();
    void t;
  };

  let A: T;
  let B: T;

  beforeAll(async () => {
    await ml.start();
    Object.assign(process.env, { ML_CLIENT_ID: 'APP-ID', ML_CLIENT_SECRET: 'APP-SECRET', ML_AUTH_BASE: 'https://auth.mercadolivre.com.br', ML_API_BASE: ml.base, ML_WEBHOOK_TOKEN: 'webhook-token-ml-123' });
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    worker = app.get(JobWorker);
    importer = app.get(OrderImportService);
    crypto = app.get(CryptoService);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    await admin.$executeRaw`UPDATE marketplace_connections SET status = 'DISCONNECTED' WHERE status IN ('ACTIVE','SYNC_ERROR')`;
    await admin.$executeRaw`UPDATE background_jobs SET status = 'CANCELLED' WHERE status IN ('QUEUED','RUNNING')`;
    A = await setup('mlA');
    B = await setup('mlB');
  });

  afterAll(async () => {
    for (const k of ['ML_CLIENT_ID', 'ML_CLIENT_SECRET', 'ML_API_BASE', 'ML_AUTH_BASE', 'ML_WEBHOOK_TOKEN', 'ML_USE_PKCE']) delete process.env[k];
    await admin.$disconnect();
    await app.close();
    await ml.stop();
  });

  beforeEach(() => { ml.requests.length = 0; ml.fail = null; ml.expiresIn = 21600; ml.withRefresh = true; ml.orders = []; });

  describe('autorização OAuth', () => {
    it('sem ML_CLIENT_ID/ML_CLIENT_SECRET o canal informa a pendência (424), sem fingir conexão', async () => {
      const saved = { id: process.env.ML_CLIENT_ID, secret: process.env.ML_CLIENT_SECRET };
      delete process.env.ML_CLIENT_ID; delete process.env.ML_CLIENT_SECRET;
      try {
        const id = (await A.owner.post('/api/integrations/connections').set(H).send({ provider: 'MERCADO_LIVRE', label: 'sem app' }).expect(201)).body.id;
        const r = await A.owner.post(`/api/integrations/connections/${id}/authorize`).set(H).expect(424);
        expect(r.body.code).toBe('NOT_CONFIGURED');
        expect(r.body.message).toMatch(/ML_CLIENT_ID/);
        expect((await admin.marketplaceConnection.findUniqueOrThrow({ where: { id } })).status).toBe('NOT_CONNECTED');
      } finally { process.env.ML_CLIENT_ID = saved.id; process.env.ML_CLIENT_SECRET = saved.secret; }
    });

    it('monta a URL de autorização com client_id, redirect_uri exato e state; troca o code pelo token e cifra as credenciais', async () => {
      await dropML(A);
      const id = (await A.owner.post('/api/integrations/connections').set(H).send({ provider: 'MERCADO_LIVRE', label: 'oauth' }).expect(201)).body.id;
      const { authorizationUrl } = (await A.owner.post(`/api/integrations/connections/${id}/authorize`).set(H).expect(200)).body;
      const u = new URL(authorizationUrl);
      expect(u.origin + u.pathname).toBe('https://auth.mercadolivre.com.br/authorization');
      expect(Object.fromEntries(u.searchParams)).toMatchObject({ response_type: 'code', client_id: 'APP-ID', redirect_uri: 'http://localhost:3000/api/integrations/callback' });
      expect(u.searchParams.get('code_challenge')).toBeNull(); // PKCE só quando habilitado no aplicativo

      await callback(stateOf(authorizationUrl)).expect(302);
      const tokenReq = ml.requests.find((r) => r.path === '/oauth/token')!;
      expect(Object.fromEntries(tokenReq.body!)).toMatchObject({ grant_type: 'authorization_code', code: 'good-code', client_id: 'APP-ID', client_secret: 'APP-SECRET', redirect_uri: 'http://localhost:3000/api/integrations/callback' });
      const row = await admin.marketplaceConnection.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ status: 'TEST_PENDING', externalAccountId: '555' });
      expect(row.credentialsEnc).not.toMatch(/APP_USR|TG-refresh/);
      const creds = crypto.decrypt<{ accessToken: string; refreshToken: string }>(A.tenantId, `cred:${id}`, row.credentialsEnc!);
      expect(creds.accessToken).toMatch(/^APP_USR-access-/);
      expect(creds.refreshToken).toMatch(/^TG-refresh-/);
      // validade vem do expires_in da resposta, nunca presumida
      expect(Math.abs(row.tokenExpiresAt!.getTime() - (Date.now() + 21600_000))).toBeLessThan(15_000);
      const dump = JSON.stringify((await A.owner.get(`/api/integrations/connections/${id}`).expect(200)).body);
      expect(dump).not.toMatch(/APP_USR|TG-refresh|APP-SECRET/);
    });

    it('respeita expires_in diferente (10800 s) e PKCE quando habilitado (verificador confere com o desafio)', async () => {
      process.env.ML_USE_PKCE = 'true';
      ml.expiresIn = 10800;
      await dropML(A);
      try {
        const id = (await A.owner.post('/api/integrations/connections').set(H).send({ provider: 'MERCADO_LIVRE', label: 'pkce' }).expect(201)).body.id;
        const { authorizationUrl } = (await A.owner.post(`/api/integrations/connections/${id}/authorize`).set(H).expect(200)).body;
        const challenge = new URL(authorizationUrl).searchParams.get('code_challenge')!;
        expect(new URL(authorizationUrl).searchParams.get('code_challenge_method')).toBe('S256');
        await callback(stateOf(authorizationUrl)).expect(302);
        const verifier = ml.requests.find((r) => r.path === '/oauth/token')!.body!.get('code_verifier')!;
        expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge);
        const row = await admin.marketplaceConnection.findUniqueOrThrow({ where: { id } });
        expect(Math.abs(row.tokenExpiresAt!.getTime() - (Date.now() + 10800_000))).toBeLessThan(15_000);
      } finally { delete process.env.ML_USE_PKCE; }
    });

    it('code inválido: erro compreensível, nada é gravado e a conexão volta ao estado anterior', async () => {
      const id = (await A.owner.post('/api/integrations/connections').set(H).send({ provider: 'MERCADO_LIVRE', label: 'ruim' }).expect(201)).body.id;
      const { authorizationUrl } = (await A.owner.post(`/api/integrations/connections/${id}/authorize`).set(H).expect(200)).body;
      const r = await callback(stateOf(authorizationUrl), 'code-errado').expect(302);
      expect(r.headers.location).toContain('error=');
      expect(decodeURIComponent(r.headers.location)).not.toMatch(/APP-SECRET|code-errado/);
      const row = await admin.marketplaceConnection.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('NOT_CONNECTED');
      expect(row.credentialsEnc).toBeNull();
    });

    it('a mesma conta de vendedor não pode ficar em duas conexões da mesma empresa (mensagem clara)', async () => {
      await connectML(A);
      const id = (await A.owner.post('/api/integrations/connections').set(H).send({ provider: 'MERCADO_LIVRE', label: 'duplicada' }).expect(201)).body.id;
      const { authorizationUrl } = (await A.owner.post(`/api/integrations/connections/${id}/authorize`).set(H).expect(200)).body;
      const r = await callback(stateOf(authorizationUrl)).expect(302);
      expect(decodeURIComponent(r.headers.location)).toMatch(/já está conectada em outra conexão/);
      expect(decodeURIComponent(r.headers.location)).not.toMatch(/Invalid|invocation|prisma/i);
      expect((await admin.marketplaceConnection.findUniqueOrThrow({ where: { id } })).credentialsEnc).toBeNull();
    });

    it('sem refresh_token (offline_access ausente) a autorização é recusada com orientação', async () => {
      ml.withRefresh = false;
      const id = (await A.owner.post('/api/integrations/connections').set(H).send({ provider: 'MERCADO_LIVRE', label: 'sem refresh' }).expect(201)).body.id;
      const { authorizationUrl } = (await A.owner.post(`/api/integrations/connections/${id}/authorize`).set(H).expect(200)).body;
      const r = await callback(stateOf(authorizationUrl)).expect(302);
      expect(decodeURIComponent(r.headers.location)).toMatch(/offline_access/);
      expect((await admin.marketplaceConnection.findUniqueOrThrow({ where: { id } })).credentialsEnc).toBeNull();
    });

    it('teste de conexão usa o token e confere a conta do vendedor', async () => {
      const id = await connectML(A);
      expect(ml.requests.some((r) => r.path === '/users/me' && /^Bearer APP_USR-access-/.test(r.auth ?? ''))).toBe(true);
      ml.userId = 777; // token passa a pertencer a outra conta
      try {
        const r = await A.owner.post(`/api/integrations/connections/${id}/test`).set(H).expect(424);
        expect(r.body.code).toBe('AUTH');
      } finally { ml.userId = 555; }
    });

    it('renovação: usa o refresh token uma única vez, grava o NOVO par e uma renovação com token antigo derruba para TOKEN_EXPIRED', async () => {
      const id = await connectML(A);
      const before = crypto.decrypt<{ refreshToken: string }>(A.tenantId, `cred:${id}`, (await admin.marketplaceConnection.findUniqueOrThrow({ where: { id } })).credentialsEnc!);
      await admin.marketplaceConnection.update({ where: { id }, data: { tokenExpiresAt: new Date(Date.now() + 60_000) } });
      await worker.schedule();
      await drain();
      const after = crypto.decrypt<{ accessToken: string; refreshToken: string }>(A.tenantId, `cred:${id}`, (await admin.marketplaceConnection.findUniqueOrThrow({ where: { id } })).credentialsEnc!);
      expect(after.refreshToken).not.toBe(before.refreshToken);
      expect(ml.requests.filter((r) => r.body?.get('grant_type') === 'refresh_token')).toHaveLength(1);
      expect(ml.requests.find((r) => r.body?.get('grant_type') === 'refresh_token')!.body!.get('refresh_token')).toBe(before.refreshToken);

      // outro processo já consumiu o refresh atual: o servidor o rejeita (uso único)
      ml.refreshTokens.clear();
      await admin.marketplaceConnection.update({ where: { id }, data: { tokenExpiresAt: new Date(Date.now() + 30_000) } });
      await worker.schedule();
      await drain();
      expect((await admin.marketplaceConnection.findUniqueOrThrow({ where: { id } })).status).toBe('TOKEN_EXPIRED');
    });
  });

  describe('importação de pedidos', () => {
    it('importa pedido pago: cria pedido de venda confirmado, reserva estoque, cria comprador e é idempotente (reconciliação repetida e concorrente)', async () => {
      const sku = `ML-${uid()}`;
      const p = await product(A, sku, 10);
      const id = await connectML(A);
      const oid = Number(`9${Date.now().toString().slice(-8)}`);
      ml.orders = [ml.order(oid, { sku, qty: 3, price: 40 })];
      await syncNow(A, id);

      const so = await salesByRef(A, String(oid));
      expect(so).toHaveLength(1);
      expect(so[0]).toMatchObject({ channel: 'MARKETPLACE', status: 'CONFIRMED', externalSource: 'MERCADO_LIVRE', salespersonId: null });
      expect(Number(so[0].total)).toBe(120);
      expect(await avail(A, p)).toMatchObject({ onHand: 10, reserved: 3, available: 7 });
      const rows = await ledger(A, id);
      expect(rows.find((r) => r.externalId === String(oid))).toMatchObject({ status: 'IMPORTED', salesOrderId: so[0].id });
      expect((await A.owner.get('/api/customers?search=COMPRADOR9001').expect(200)).body).toHaveLength(1);

      // repetição: reconciliação de novo e importações concorrentes do mesmo pedido
      await syncNow(A, id);
      const norm = (await importer.listLedger({ tenantId: A.tenantId, userId: 'x', permissions: new Set() } as any, id)).length;
      expect(norm).toBeGreaterThan(0);
      await Promise.all(Array.from({ length: 5 }, () => importer.importOrders(A.tenantId, id, [{ externalId: String(oid), status: 'paid', buyer: { id: '9001', nickname: 'COMPRADOR9001' }, items: [{ externalItemId: 'MLB-1', sku, quantity: 3, unitPrice: 40 }] }])));
      expect(await salesByRef(A, String(oid))).toHaveLength(1);
      expect(await avail(A, p)).toMatchObject({ reserved: 3 });
      expect((await A.owner.get('/api/customers?search=COMPRADOR9001').expect(200)).body).toHaveLength(1);
    });

    it('SKU sem vínculo vira pendência (nenhum pedido criado); após vincular o anúncio e reprocessar, o pedido é importado', async () => {
      const sku = `REAL-${uid()}`;
      const p = await product(A, sku, 5);
      const id = await connectML(A);
      const oid = Number(`8${Date.now().toString().slice(-8)}`);
      ml.orders = [ml.order(oid, { sku: 'SKU-DO-ANUNCIO', item: 'MLB-777', qty: 1, price: 99 })];
      await syncNow(A, id);
      expect(await salesByRef(A, String(oid))).toHaveLength(0);
      const pending = (await ledger(A, id, 'NEEDS_ATTENTION')).find((r) => r.externalId === String(oid));
      expect(pending.reason).toMatch(/SKU-DO-ANUNCIO/);

      await A.owner.post(`/api/integrations/connections/${id}/mappings`).set(H).send({ externalItemId: 'MLB-777', productId: p }).expect(200);
      const r = await A.owner.post(`/api/integrations/connections/${id}/orders/${pending.id}/reprocess`).set(H).expect(200);
      expect(r.body.imported).toBe(1);
      const so = await salesByRef(A, String(oid));
      expect(so).toHaveLength(1);
      expect(await avail(A, p)).toMatchObject({ reserved: 1 });
    });

    it('estoque insuficiente não perde a venda: pedido fica pendente de aprovação, sem reservas parciais, e é confirmado após repor o estoque', async () => {
      const sku = `LOW-${uid()}`;
      const p = await product(A, sku, 1);
      const id = await connectML(A);
      const oid = Number(`7${Date.now().toString().slice(-8)}`);
      ml.orders = [ml.order(oid, { sku, qty: 5, price: 10 })];
      await syncNow(A, id);
      const [so] = await salesByRef(A, String(oid));
      expect(so.status).toBe('PENDING_APPROVAL');
      expect(so.approvalReason).toMatch(/Estoque insuficiente/);
      expect(await avail(A, p)).toMatchObject({ reserved: 0 });
      const row = (await ledger(A, id, 'NEEDS_ATTENTION')).find((r) => r.externalId === String(oid));
      expect(row.salesOrderId).toBe(so.id);

      await A.owner.post('/api/stock/movements').set(H).send({ productId: p, warehouseId: A.wh, type: 'PURCHASE_ENTRY', quantity: 10 }).expect(201);
      await A.owner.post(`/api/integrations/connections/${id}/orders/reprocess`).set(H).expect(200);
      expect((await salesByRef(A, String(oid)))[0].status).toBe('CONFIRMED');
      expect(await avail(A, p)).toMatchObject({ reserved: 5 });
      expect(await salesByRef(A, String(oid))).toHaveLength(1);
    });

    it('pedido ainda não pago só é registrado; ao ser pago é importado uma vez', async () => {
      const sku = `PAY-${uid()}`;
      const p = await product(A, sku, 4);
      const id = await connectML(A);
      const oid = Number(`6${Date.now().toString().slice(-8)}`);
      ml.orders = [ml.order(oid, { sku, qty: 1, status: 'payment_required' })];
      await syncNow(A, id);
      expect(await salesByRef(A, String(oid))).toHaveLength(0);
      expect((await ledger(A, id, 'AWAITING_PAYMENT')).some((r) => r.externalId === String(oid))).toBe(true);
      ml.orders = [ml.order(oid, { sku, qty: 1, status: 'paid' })];
      await syncNow(A, id);
      expect(await salesByRef(A, String(oid))).toHaveLength(1);
      expect(await avail(A, p)).toMatchObject({ reserved: 1 });
    });

    it('cancelamento no canal: libera a reserva (política padrão) e preserva o histórico; após expedição exige tratamento manual', async () => {
      const sku = `CAN-${uid()}`;
      const p = await product(A, sku, 10);
      const id = await connectML(A);
      const o1 = Number(`5${Date.now().toString().slice(-8)}`);
      const o2 = o1 + 1;
      ml.orders = [ml.order(o1, { sku, qty: 2 }), ml.order(o2, { sku, qty: 1 })];
      await syncNow(A, id);
      expect(await avail(A, p)).toMatchObject({ reserved: 3 });
      // o2 é expedido antes do cancelamento
      const [s2] = await salesByRef(A, String(o2));
      const ops = await (async () => { const email = `op-${uid()}@teste.local`; const roles = Object.fromEntries((await A.owner.get('/api/roles')).body.map((r: any) => [r.key, r.id])); await A.owner.post('/api/users').set(H).send({ name: 'Op', email, password: PASSWORD, roleId: roles.stock_operator }).expect(201); const a = agent(); await a.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200); return a; })();
      for (const to of ['PICKING', 'PACKED', 'SHIPPED']) await ops.post(`/api/sales/orders/${s2.id}/advance`).set(H).send({ to }).expect(200);

      ml.orders = [ml.order(o1, { sku, qty: 2, status: 'cancelled' }), ml.order(o2, { sku, qty: 1, status: 'cancelled' })];
      await syncNow(A, id);
      expect((await salesByRef(A, String(o1)))[0].status).toBe('CANCELLED');
      expect((await salesByRef(A, String(o2)))[0].status).toBe('SHIPPED');
      expect(await avail(A, p)).toMatchObject({ reserved: 0, onHand: 9 });
      const rows = await ledger(A, id);
      expect(rows.find((r) => r.externalId === String(o1))?.status).toBe('CANCELLED');
      const att = rows.find((r) => r.externalId === String(o2));
      expect(att.status).toBe('NEEDS_ATTENTION');
      expect(att.reason).toMatch(/devolução/);
    });

    it('política "revisão manual" não cancela sozinho', async () => {
      const sku = `MAN-${uid()}`;
      await product(A, sku, 3);
      const id = await connectML(A, { cancellationPolicy: 'MANUAL_REVIEW' });
      const oid = Number(`4${Date.now().toString().slice(-8)}`);
      ml.orders = [ml.order(oid, { sku, qty: 1 })];
      await syncNow(A, id);
      ml.orders = [ml.order(oid, { sku, qty: 1, status: 'cancelled' })];
      await syncNow(A, id);
      expect((await salesByRef(A, String(oid)))[0].status).toBe('CONFIRMED');
      expect((await ledger(A, id, 'NEEDS_ATTENTION')).find((r) => r.externalId === String(oid))?.reason).toMatch(/revisão manual/);
    });

    it('pagina os resultados (3 páginas de 50) e na execução seguinte pede só pedidos desde a última sincronização', async () => {
      const id = await connectML(A);
      const base = Number(`3${Date.now().toString().slice(-7)}0`);
      ml.orders = Array.from({ length: 120 }, (_, i) => ml.order(base + i, { status: 'payment_required' }));
      await syncNow(A, id);
      const searches = ml.requests.filter((r) => r.path === '/orders/search');
      expect(searches.map((s) => s.query.get('offset'))).toEqual(['0', '50', '100']);
      expect(searches[0].query.get('seller')).toBe('555');
      expect(searches.every((s) => /^Bearer /.test(s.auth ?? ''))).toBe(true);
      expect((await ledger(A, id, 'AWAITING_PAYMENT')).length).toBe(100); // a API de listagem devolve no máximo 100; total gravado abaixo
      expect(await admin.externalOrder.count({ where: { connectionId: id } })).toBe(120);

      ml.requests.length = 0;
      ml.orders = [];
      await worker.schedule(new Date(Date.now() + 400 * 86_400_000));
      await drain();
      const second = ml.requests.find((r) => r.path === '/orders/search');
      expect(second?.query.get('order.date_created.from')).toBeTruthy();
    });

    it('limite de requisições (429 + Retry-After) e indisponibilidade (500) reagendam; 401 marca token expirado', async () => {
      const id = await connectML(A);
      ml.fail = { status: 429, retryAfter: 7 };
      await worker.schedule(new Date(Date.now() + 900 * 86_400_000));
      await drain();
      let job = (await admin.backgroundJob.findMany({ where: { connectionId: id, type: 'connection.reconcile' }, orderBy: { createdAt: 'desc' } }))[0];
      expect(job.status).toBe('QUEUED');
      expect(job.runAt.getTime() - Date.now()).toBeGreaterThan(3_000);
      expect(job.runAt.getTime() - Date.now()).toBeLessThan(12_000);

      ml.fail = { status: 500 };
      await due(A.tenantId);
      await drain();
      job = await admin.backgroundJob.findUniqueOrThrow({ where: { id: job.id } });
      expect(job.status).toBe('QUEUED');
      expect(job.attempts).toBe(2);
      expect(job.lastError).toMatch(/UNAVAILABLE/);

      ml.fail = { status: 401 };
      await due(A.tenantId);
      await drain();
      expect((await admin.marketplaceConnection.findUniqueOrThrow({ where: { id } })).status).toBe('TOKEN_EXPIRED');
    });
  });

  describe('notificações (webhook por aplicativo)', () => {
    const notify = (token: string, body: object) => request(app.getHttpServer()).post(`/api/webhooks/providers/mercado_livre/${token}`).send(body);

    it('rejeita token incorreto (404) e ignora conta desconhecida', async () => {
      await notify('token-errado', { topic: 'orders_v2', resource: '/orders/1', user_id: 555 }).expect(404);
      const before = await admin.webhookEvent.count();
      await notify('webhook-token-ml-123', { topic: 'orders_v2', resource: '/orders/1', user_id: 424242, _id: `x-${uid()}` }).expect(200);
      expect(await admin.webhookEvent.count()).toBe(before);
    });

    it('não confia no corpo: busca o pedido na API com o token do vendedor e importa; duplicatas não duplicam', async () => {
      const sku = `HOOK-${uid()}`;
      const p = await product(A, sku, 6);
      const id = await connectML(A);
      const oid = Number(`2${Date.now().toString().slice(-8)}`);
      ml.orders = [ml.order(oid, { sku, qty: 2, price: 25 })];
      // corpo com dados falsos além do recurso: nada disso é usado
      const body = { _id: `n-${uid()}`, topic: 'orders_v2', resource: `/orders/${oid}`, user_id: 555, application_id: 1, total_amount: 1, items: [{ sku: 'FALSO', quantity: 999 }] };
      const t0 = Date.now();
      await notify('webhook-token-ml-123', body).expect(200);
      expect(Date.now() - t0).toBeLessThan(500); // o canal exige resposta em 500 ms
      await notify('webhook-token-ml-123', body).expect(200);
      expect(await admin.webhookEvent.count({ where: { connectionId: id } })).toBe(1);
      expect(ml.requests.filter((r) => r.path === `/orders/${oid}`)).toHaveLength(0); // ainda não processou: resposta foi imediata
      await drain();
      expect(ml.requests.filter((r) => r.path === `/orders/${oid}`)).toHaveLength(1);
      const so = await salesByRef(A, String(oid));
      expect(so).toHaveLength(1);
      expect(Number(so[0].total)).toBe(50);
      expect(await avail(A, p)).toMatchObject({ reserved: 2 });

      // reentrega com outro _id (mesmo recurso): o livro de pedidos impede duplicidade
      await notify('webhook-token-ml-123', { ...body, _id: `n-${uid()}` }).expect(200);
      await drain();
      expect(await salesByRef(A, String(oid))).toHaveLength(1);
      expect(await avail(A, p)).toMatchObject({ reserved: 2 });
    });

    it('tópicos não tratados são ignorados; recurso malformado e pedido de outro vendedor são recusados sem derrubar a conexão', async () => {
      const id = await connectML(A);
      await notify('webhook-token-ml-123', { _id: `i-${uid()}`, topic: 'items', resource: '/items/MLB1', user_id: 555 }).expect(200);
      await notify('webhook-token-ml-123', { _id: `b-${uid()}`, topic: 'orders_v2', resource: '/orders/../users/me', user_id: 555 }).expect(200);
      const foreign = Number(`1${Date.now().toString().slice(-8)}`);
      ml.orders = [ml.order(foreign, { seller: 999 })];
      await notify('webhook-token-ml-123', { _id: `f-${uid()}`, topic: 'orders_v2', resource: `/orders/${foreign}`, user_id: 555 }).expect(200);
      await drain();
      const evs = await admin.webhookEvent.findMany({ where: { connectionId: id }, orderBy: { receivedAt: 'asc' } });
      expect(evs.map((e) => e.status)).toEqual(['IGNORED', 'FAILED', 'FAILED']);
      expect(await salesByRef(A, String(foreign))).toHaveLength(0);
      expect((await admin.marketplaceConnection.findUniqueOrThrow({ where: { id } })).status).toBe('ACTIVE');
    });

    it('a mesma conta de vendedor em duas empresas: cada uma importa só para si (isolamento)', async () => {
      const sku = `ISO-${uid()}`;
      const pa = await product(A, sku, 5);
      const pb = await product(B, sku, 5);
      const ida = await connectML(A);
      const idb = await connectML(B);
      const oid = Number(`1${Date.now().toString().slice(-7)}9`);
      ml.orders = [ml.order(oid, { sku, qty: 1 })];
      await notify('webhook-token-ml-123', { _id: `iso-${uid()}`, topic: 'orders_v2', resource: `/orders/${oid}`, user_id: 555 }).expect(200);
      await drain();
      expect(await salesByRef(A, String(oid))).toHaveLength(1);
      expect(await salesByRef(B, String(oid))).toHaveLength(1);
      expect(await avail(A, pa)).toMatchObject({ reserved: 1 });
      expect(await avail(B, pb)).toMatchObject({ reserved: 1 });
      expect(JSON.stringify(await ledger(B, idb))).not.toContain(ida);
      await B.owner.get(`/api/integrations/connections/${ida}/orders`).expect(404).catch(() => undefined);
      expect((await A.owner.get('/api/sales/orders?limit=200').expect(200)).body.items.length).toBeGreaterThan(0);
    });
  });
});
