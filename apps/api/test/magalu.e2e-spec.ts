import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';
import { JobWorker } from '../src/integrations/jobs.service';
import { ConnectorRegistry } from '../src/integrations/providers';

/**
 * ATENÇÃO: o servidor abaixo SIMULA o Magalu conforme as páginas de developers.magalu.com lidas em 21/10/2026. As páginas públicas
 * não trazem o formato das respostas de pedidos/SKUs; os campos simulados aqui são o que o conector aceita (leitura tolerante).
 * Estes testes provam o comportamento do NOSSO código; não provam que a API real responde assim. Falta validar com conta de seller.
 */
class MockMagalu {
  server!: Server;
  base = '';
  access = new Set<string>();
  refresh = new Set<string>();
  n = 0;
  requests: { method: string; path: string; body: any; contentType: string; auth: string | null }[] = [];
  orders: Record<string, any>[] = [];
  skus: Record<string, any>[] = [];
  pageSize = 2;

  order(code: string, o: Partial<{ status: string; sku: string; qty: number; price: number }> = {}) {
    return {
      code, status: o.status ?? 'new', created_at: new Date().toISOString(), amount: (o.qty ?? 2) * (o.price ?? 50),
      customer: { id: 'C-77', name: 'Comprador Magalu' },
      items: [{ id: `I-${code}`, sku: o.sku ?? 'MG-SKU', title: 'Parafuso', quantity: o.qty ?? 2, unit_price: o.price ?? 50 }],
    };
  }

  async start() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop() { return new Promise<void>((r) => this.server.close(() => r())); }
  issue() {
    const a = `mg-access-${++this.n}`; const r = `mg-refresh-${this.n}`;
    this.access.add(a); this.refresh.add(r);
    return { access_token: a, refresh_token: r, expires_in: 7200, token_type: 'Bearer', scope: 'open:order-order-seller:read' };
  }

  private page(list: Record<string, any>[], url: URL, path: string) {
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const slice = list.slice(offset, offset + this.pageSize);
    const next = offset + this.pageSize < list.length ? { next: `${this.base}${path}?offset=${offset + this.pageSize}` } : {};
    return { meta: { links: next }, results: slice };
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, this.base);
    const raw = await new Promise<string>((ok) => { let s = ''; req.on('data', (d) => (s += d)).on('end', () => ok(s)); });
    const contentType = String(req.headers['content-type'] ?? '');
    let body: any = null;
    if (raw) body = contentType.includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    const auth = (req.headers.authorization as string | undefined) ?? null;
    this.requests.push({ method: req.method!, path: url.pathname, body, contentType, auth });
    const send = (status: number, json: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };

    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      if (body?.client_id !== 'MG-ID' || body?.client_secret !== 'MG-SECRET') return send(401, { error: 'invalid_client' });
      if (body.grant_type === 'authorization_code') return body.code === 'good-code' ? send(200, this.issue()) : send(400, { error: 'invalid_grant' });
      if (body.grant_type === 'refresh_token') return this.refresh.delete(body.refresh_token) ? send(200, this.issue()) : send(400, { error: 'invalid_grant' });
      return send(400, { error: 'unsupported_grant_type' });
    }
    if (!this.access.has(auth?.replace('Bearer ', '') ?? '')) return send(401, { detail: 'invalid_token' });
    if (url.pathname === '/seller/v1/orders') return send(200, this.page(this.orders, url, '/seller/v1/orders'));
    if (url.pathname === '/seller/v1/portfolios/skus') return send(200, this.page(this.skus, url, '/seller/v1/portfolios/skus'));
    return send(404, { detail: 'rota inexistente no simulador' });
  }
}

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);
let seq = 0;
const uid = () => `${run}${++seq}`;

describe('Magalu (servidor simulado): OAuth, pedidos e catálogo', () => {
  let app: INestApplication;
  let worker: JobWorker;
  let admin: PrismaClient;
  const mg = new MockMagalu();
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

  async function connect(t: T) {
    const id = (await t.owner.post('/api/integrations/connections').set(H).send({ provider: 'MAGALU', label: `MG ${uid()}` }).expect(201)).body.id as string;
    await t.owner.put(`/api/integrations/connections/${id}/config`).set(H).send({ warehouseId: t.wh }).expect(200);
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
  const ledger = async (t: T, id: string, status?: string) => (await t.owner.get(`/api/integrations/connections/${id}/orders${status ? `?status=${status}` : ''}`).expect(200)).body as any[];
  const syncNow = async (id: string) => {
    await admin.marketplaceConnection.update({ where: { id }, data: { lastSyncAt: null } });
    await admin.$executeRaw`UPDATE background_jobs SET status = 'CANCELLED' WHERE connection_id = ${id}::uuid AND status = 'QUEUED'`;
    await admin.backgroundJob.deleteMany({ where: { connectionId: id, type: 'connection.reconcile', status: { in: ['SUCCEEDED', 'FAILED', 'DEAD', 'CANCELLED'] }, idempotencyKey: { startsWith: 'reconcile:' } } }).catch(() => undefined);
    await worker.schedule(new Date(Date.now() + 365 * 86_400_000 + Math.floor(Math.random() * 1e6) * 1000));
    await drain();
  };

  let A: T;
  beforeAll(async () => {
    await mg.start();
    Object.assign(process.env, { MAGALU_CLIENT_ID: 'MG-ID', MAGALU_CLIENT_SECRET: 'MG-SECRET', MAGALU_AUTH_BASE: mg.base, MAGALU_API_BASE: mg.base, MAGALU_PAID_STATUSES: 'approved' });
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    worker = app.get(JobWorker);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    await admin.$executeRaw`UPDATE marketplace_connections SET status = 'DISCONNECTED' WHERE status IN ('ACTIVE','SYNC_ERROR')`;
    await admin.$executeRaw`UPDATE background_jobs SET status = 'CANCELLED' WHERE status IN ('QUEUED','RUNNING')`;
    A = await setup('mgA');
  });
  afterAll(async () => {
    for (const k of ['MAGALU_CLIENT_ID', 'MAGALU_CLIENT_SECRET', 'MAGALU_AUTH_BASE', 'MAGALU_API_BASE', 'MAGALU_PAID_STATUSES']) delete process.env[k];
    await admin.$disconnect();
    await app.close();
    await mg.stop();
  });
  beforeEach(() => { mg.requests.length = 0; mg.orders = []; mg.skus = []; });

  describe('autorização', () => {
    it('aparece como disponível sem validação real e, sem o aplicativo configurado, informa a pendência (424)', async () => {
      const list = (await A.owner.get('/api/integrations/providers').expect(200)).body as { provider: string; capabilities: Record<string, string> }[];
      const m = list.find((p) => p.provider === 'MAGALU')!;
      expect(m.capabilities).toMatchObject({ authorization: 'IMPLEMENTED_UNVERIFIED', orders: 'IMPLEMENTED_UNVERIFIED', catalog: 'IMPLEMENTED_UNVERIFIED', publishing: 'PLANNED', price: 'PLANNED', inventory: 'PLANNED' });
      const saved = { id: process.env.MAGALU_CLIENT_ID, secret: process.env.MAGALU_CLIENT_SECRET };
      delete process.env.MAGALU_CLIENT_ID; delete process.env.MAGALU_CLIENT_SECRET;
      try {
        const id = (await A.owner.post('/api/integrations/connections').set(H).send({ provider: 'MAGALU', label: 'sem app' }).expect(201)).body.id;
        const r = await A.owner.post(`/api/integrations/connections/${id}/authorize`).set(H).expect(424);
        expect(r.body.code).toBe('NOT_CONFIGURED');
        expect(r.body.message).toMatch(/MAGALU_CLIENT_ID/);
      } finally { process.env.MAGALU_CLIENT_ID = saved.id; process.env.MAGALU_CLIENT_SECRET = saved.secret; }
    });

    it('monta a URL de login com choose_tenants, escopos e redirect exato; troca o code por JSON e conecta', async () => {
      const id = (await A.owner.post('/api/integrations/connections').set(H).send({ provider: 'MAGALU', label: 'oauth' }).expect(201)).body.id;
      const { authorizationUrl } = (await A.owner.post(`/api/integrations/connections/${id}/authorize`).set(H).expect(200)).body;
      const u = new URL(authorizationUrl);
      expect(u.origin).toBe(mg.base);
      expect(u.pathname).toBe('/login');
      expect(u.searchParams.get('client_id')).toBe('MG-ID');
      expect(u.searchParams.get('response_type')).toBe('code');
      expect(u.searchParams.get('choose_tenants')).toBe('true');
      expect(u.searchParams.get('redirect_uri')).toMatch(/\/api\/integrations\/callback$/);
      expect(u.searchParams.get('scope')).toContain('open:order-order-seller:read');
      expect(u.searchParams.get('scope')).not.toMatch(/write/);

      await callback(stateOf(authorizationUrl), 'bad-code').expect(302); // código inválido não conecta
      expect((await admin.marketplaceConnection.findUniqueOrThrow({ where: { id } })).credentialsEnc).toBeNull();

      const fresh = (await A.owner.post(`/api/integrations/connections/${id}/authorize`).set(H).expect(200)).body;
      mg.requests.length = 0;
      await callback(stateOf(fresh.authorizationUrl)).expect(302);
      const exchange = mg.requests.find((r) => r.path === '/oauth/token')!;
      expect(exchange.contentType).toContain('json');
      expect(exchange.body).toMatchObject({ grant_type: 'authorization_code', code: 'good-code' });
      const row = await admin.marketplaceConnection.findUniqueOrThrow({ where: { id } });
      expect(row.credentialsEnc).not.toBeNull();
      expect(JSON.stringify(row)).not.toContain('mg-access-');
      expect(row.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 7000_000);
    });

    it('renova com refresh_token em formulário e o token antigo não vale mais', async () => {
      const connector = app.get(ConnectorRegistry).get('MAGALU')!;
      const first = mg.issue();
      const r = await connector.refreshAuthorization({ connectionId: 'x', tenantId: 'x', credentials: { refreshToken: first.refresh_token }, config: {}, externalAccountId: null });
      expect(r.ok).toBe(true);
      expect(mg.requests.find((q) => q.body?.grant_type === 'refresh_token')!.contentType).toContain('x-www-form-urlencoded');
      const again = await connector.refreshAuthorization({ connectionId: 'x', tenantId: 'x', credentials: { refreshToken: first.refresh_token }, config: {}, externalAccountId: null });
      expect(again).toMatchObject({ ok: false, code: 'AUTH' });
    });
  });

  describe('pedidos', () => {
    it('lê todas as páginas, deixa aguardando o que não está pago e importa só o que o status configurado marca como pago', async () => {
      const id = await connect(A);
      await product(A, 'MG-OK', 20);
      mg.orders = [mg.order('M1', { status: 'new', sku: 'MG-OK' }), mg.order('M2', { status: 'approved', sku: 'MG-OK', qty: 3 }), mg.order('M3', { status: 'paid', sku: 'MG-OK' })];
      await syncNow(id);
      const all = await ledger(A, id);
      expect(all.map((o) => o.externalId).sort()).toEqual(['M1', 'M2', 'M3']); // 3 pedidos, 2 páginas
      expect((await ledger(A, id, 'IMPORTED')).map((o) => o.externalId)).toEqual(['M2']);
      // 'paid' não listado NÃO é tratado como pago por engano; 'new' segue aguardando
      expect((await ledger(A, id, 'AWAITING_PAYMENT')).map((o) => o.externalId).sort()).toEqual(['M1', 'M3']);
      expect(all.find((o) => o.externalId === 'M1').reason).toMatch(/new/);
      const sales = await admin.salesOrder.findMany({ where: { tenantId: A.tenantId, externalSource: 'MAGALU' } });
      expect(sales).toHaveLength(1);
      await syncNow(id); // repetir não duplica
      expect(await admin.salesOrder.count({ where: { tenantId: A.tenantId, externalSource: 'MAGALU' } })).toBe(1);
    });

    it('pedido pago sem produto com o SKU pede atenção; cancelado no canal é registrado', async () => {
      const id = await connect(A);
      mg.orders = [mg.order('M10', { status: 'approved', sku: 'SEM-PRODUTO' }), mg.order('M11', { status: 'canceled' })];
      await syncNow(id);
      const att = await ledger(A, id, 'NEEDS_ATTENTION');
      expect(att.find((o) => o.externalId === 'M10').reason).toMatch(/SEM-PRODUTO/);
      expect((await ledger(A, id, 'CANCELLED')).map((o) => o.externalId)).toEqual(['M11']);
    });
  });

  describe('catálogo (importar para a base)', () => {
    it('varre os SKUs paginados e lista como novos, sem inventar o que a resposta não traz', async () => {
      const id = await connect(A);
      mg.skus = [
        { sku: 'MG-A', title: 'Anel de vedação', brand: 'Acme', ean: '7891000100103', price: 12.5, stock: 8 },
        { sku: 'MG-B', title: 'Bucha', ean: 'não-é-gtin' },
        { sku: 'MG-C' }, // sem título: descartado
      ];
      let cursor: string | null = null; let created = 0;
      for (let i = 0; i < 5; i++) {
        const r: any = (await A.owner.post(`/api/integrations/connections/${id}/catalog/scan`).set(H).send(cursor ? { cursor } : {}).expect(201)).body;
        created += r.created; cursor = r.nextCursor;
        if (!cursor) break;
      }
      expect(created).toBe(2);
      const items = (await A.owner.get(`/api/integrations/connections/${id}/catalog/items?status=NEW`).expect(200)).body.items as any[];
      expect(items.map((i) => i.sku).sort()).toEqual(['MG-A', 'MG-B']);
      expect(items.find((i) => i.sku === 'MG-A')).toMatchObject({ title: 'Anel de vedação', gtin: '7891000100103' });
      expect(items.find((i) => i.sku === 'MG-B').gtin).toBeNull();
    });

    it('operações de escrita continuam não implementadas (nada é enviado ao Magalu)', async () => {
      const connector = app.get(ConnectorRegistry).get('MAGALU')!;
      const ctx = { connectionId: 'x', tenantId: 'x', credentials: { accessToken: 'mg-access-1' }, config: {}, externalAccountId: null };
      for (const r of [await connector.updatePrice(ctx, { externalId: 'S', price: 1 }), await connector.updateInventory(ctx, { externalId: 'S', quantity: 1 }), await connector.publishProduct(ctx, { productId: 'p', payload: {}, idempotencyKey: 'k' })]) {
        expect(r).toMatchObject({ ok: false, code: 'NOT_IMPLEMENTED' });
      }
      expect(mg.requests.filter((q) => q.method !== 'GET' && q.path.startsWith('/seller'))).toHaveLength(0);
    });
  });
});
