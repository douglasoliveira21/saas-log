import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { createHmac } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';
import { JobWorker } from '../src/integrations/jobs.service';

/**
 * ATENÇÃO: o servidor abaixo SIMULA a Open API do TikTok Shop (versão 202309) conforme o SDK da comunidade e a referência de webhooks
 * lidos em 23/11/2026; os nomes dos campos das respostas vêm da memória e estão marcados [A VALIDAR] no conector. Estes testes provam o
 * comportamento do NOSSO código (inclusive a assinatura, que o simulador RECALCULA de forma independente); não provam que a API real
 * responde assim. Falta validar com uma loja autorizada.
 */
const APP_KEY = 'app-key-teste';
const APP_SECRET = 'app-secret-teste';
const HOOK_TOKEN = 'token-do-webhook-123';

class MockTikTok {
  server!: Server;
  base = '';
  n = 0;
  access = new Set<string>();
  refresh = new Set<string>();
  requests: { method: string; path: string; query: URLSearchParams; headers: IncomingMessage['headers']; body: string; signOk: boolean }[] = [];
  orders: Record<string, any>[] = [];
  products: Record<string, any>[] = [];
  shops = [{ id: '7000000001', name: 'Loja Teste', region: 'BR', cipher: 'CIFRA-1', code: 'BR1' }];
  pageSize = 2;
  pushes: { op: string; body: any; signOk: boolean }[] = [];
  detail = { id: '555', title: 'Anel', status: 'ACTIVATE', skus: [{ id: '901', seller_sku: 'TT-LINK', price: { currency: 'BRL', sale_price: '10.00' }, inventory: [{ warehouse_id: 'W1', quantity: 0 }] }] };

  order(id: string, o: Partial<{ status: string; sku: string; qty: number; price: number }> = {}) {
    const qty = o.qty ?? 2;
    return {
      id, status: o.status ?? 'AWAITING_SHIPMENT', create_time: Math.floor(Date.now() / 1000), update_time: Math.floor(Date.now() / 1000), user_id: 'U-77',
      payment: { currency: 'BRL', total_amount: String(qty * (o.price ?? 50)) }, recipient_address: { name: 'Comprador TikTok' },
      line_items: Array.from({ length: qty }, (_, i) => ({ id: `${id}-${i}`, product_id: '111', sku_id: '222', seller_sku: o.sku ?? 'TT-SKU', product_name: 'Parafuso', sku_name: 'M8', sale_price: String(o.price ?? 50) })),
    };
  }

  async start() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop() { return new Promise<void>((r) => this.server.close(() => r())); }
  issue() {
    const a = `tt-access-${++this.n}`; const r = `tt-refresh-${this.n}`;
    this.access.add(a); this.refresh.add(r);
    return { code: 0, message: 'success', data: { access_token: a, access_token_expire_in: Math.floor(Date.now() / 1000) + 604_800, refresh_token: r, refresh_token_expire_in: Math.floor(Date.now() / 1000) + 31_536_000, seller_name: 'Vendedor Teste' } };
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, this.base);
    const raw = await new Promise<string>((ok) => { let s = ''; req.on('data', (d) => (s += d)).on('end', () => ok(s)); });
    // recalcula a assinatura do jeito documentado (independente do conector)
    const entries = [...url.searchParams.entries()].filter(([k]) => !['sign', 'access_token', 'x-tts-access-token'].includes(k)).sort(([a], [b]) => (a < b ? -1 : 1));
    const expected = createHmac('sha256', APP_SECRET).update(APP_SECRET + url.pathname + entries.map(([k, v]) => k + v).join('') + (req.method !== 'GET' ? raw : '') + APP_SECRET).digest('hex');
    const signOk = url.searchParams.get('sign') === expected;
    this.requests.push({ method: req.method!, path: url.pathname, query: url.searchParams, headers: req.headers, body: raw, signOk });
    const send = (status: number, json: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    const data = (d: unknown) => send(200, { code: 0, message: 'Success', request_id: 'r', data: d });

    if (url.pathname === '/api/v2/token/get') {
      if (url.searchParams.get('app_key') !== APP_KEY || url.searchParams.get('app_secret') !== APP_SECRET) return send(200, { code: 105001, message: 'invalid app credentials' });
      return url.searchParams.get('auth_code') === 'codigo-bom' ? send(200, this.issue()) : send(200, { code: 36004004, message: 'auth_code invalid or expired' });
    }
    if (url.pathname === '/api/v2/token/refresh') {
      return this.refresh.delete(url.searchParams.get('refresh_token') ?? '') ? send(200, this.issue()) : send(200, { code: 105002, message: 'refresh token expired' });
    }
    if (!this.access.has(String(req.headers['x-tts-access-token'] ?? ''))) return send(401, { code: 105002, message: 'access token invalid or expired' });
    if (!signOk) return send(200, { code: 106001, message: 'sign check failed' });
    if (url.pathname === '/authorization/202309/shops') return data({ shops: this.shops });
    if (url.searchParams.get('shop_cipher') !== 'CIFRA-1') return send(200, { code: 106002, message: 'shop_cipher invalid' });
    if (url.pathname === '/order/202309/orders/search') {
      const offset = Number(url.searchParams.get('page_token') ?? 0);
      const slice = this.orders.slice(offset, offset + this.pageSize);
      return data({ orders: slice, next_page_token: offset + this.pageSize < this.orders.length ? String(offset + this.pageSize) : '', total_count: this.orders.length });
    }
    if (url.pathname === '/order/202309/orders' && req.method === 'GET') {
      const ids = (url.searchParams.get('ids') ?? '').split(',');
      return data({ orders: this.orders.filter((o) => ids.includes(o.id)) });
    }
    if (url.pathname === '/product/202309/products/search') {
      const offset = Number(url.searchParams.get('page_token') ?? 0);
      return data({ products: this.products.slice(offset, offset + this.pageSize), next_page_token: offset + this.pageSize < this.products.length ? String(offset + this.pageSize) : '' });
    }
    if (url.pathname === '/product/202309/products/555' && req.method === 'GET') return data(this.detail);
    const push = /^\/product\/202309\/products\/555\/(prices|inventory)\/update$/.exec(url.pathname);
    if (push && req.method === 'POST') { this.pushes.push({ op: push[1], body: JSON.parse(raw), signOk }); return data({}); }
    return send(404, { code: 404, message: 'rota inexistente no simulador' });
  }
}

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);
let seq = 0;
const uid = () => `${run}${++seq}`;

describe('TikTok Shop (servidor simulado): OAuth por loja, pedidos, catálogo e notificações assinadas', () => {
  let app: INestApplication;
  let worker: JobWorker;
  let admin: PrismaClient;
  const tt = new MockTikTok();
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
  const callback = (state: string, code = 'codigo-bom') => request(app.getHttpServer()).get(`/api/integrations/callback?code=${code}&state=${encodeURIComponent(state)}`);
  const drain = async () => { for (let i = 0; i < 10; i++) if ((await worker.runOnce(20)) === 0) break; };
  let shopSeq = 7_000_000_100;
  /** Cada conexão usa uma loja diferente (a mesma loja só pode estar em uma conexão por empresa). */
  async function connect(t: T) {
    const shopId = String(++shopSeq);
    tt.shops = [{ id: shopId, name: `Loja ${shopId}`, region: 'BR', cipher: 'CIFRA-1', code: 'BR1' }];
    const id = (await t.owner.post('/api/integrations/connections').set(H).send({ provider: 'TIKTOK_SHOP', label: `TT ${uid()}` }).expect(201)).body.id as string;
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
    await admin.backgroundJob.deleteMany({ where: { connectionId: id, type: 'connection.reconcile', status: { in: ['SUCCEEDED', 'FAILED', 'DEAD', 'CANCELLED'] }, idempotencyKey: { startsWith: 'reconcile:' } } });
    await worker.schedule(new Date(Date.now() + 365 * 86_400_000 + Math.floor(Math.random() * 1e6) * 1000));
    await drain();
  };
  const hook = (body: object, opts: { token?: string; signature?: string | null } = {}) => {
    const raw = JSON.stringify(body);
    const sig = opts.signature === undefined ? createHmac('sha256', APP_SECRET).update(APP_KEY + raw).digest('hex') : opts.signature;
    const r = request(app.getHttpServer()).post(`/api/webhooks/providers/TIKTOK_SHOP/${opts.token ?? HOOK_TOKEN}`).set('content-type', 'application/json');
    return (sig === null ? r : r.set('authorization', sig)).send(raw);
  };

  let A: T;
  beforeAll(async () => {
    await tt.start();
    Object.assign(process.env, { TIKTOK_APP_KEY: APP_KEY, TIKTOK_APP_SECRET: APP_SECRET, TIKTOK_API_BASE: tt.base, TIKTOK_AUTH_BASE: tt.base, TIKTOK_WEBHOOK_TOKEN: HOOK_TOKEN });
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    worker = app.get(JobWorker);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    await admin.$executeRaw`UPDATE marketplace_connections SET status = 'DISCONNECTED' WHERE status IN ('ACTIVE','SYNC_ERROR')`;
    await admin.$executeRaw`UPDATE background_jobs SET status = 'CANCELLED' WHERE status IN ('QUEUED','RUNNING')`;
    A = await setup('ttA');
  });
  afterAll(async () => {
    for (const k of ['TIKTOK_APP_KEY', 'TIKTOK_APP_SECRET', 'TIKTOK_API_BASE', 'TIKTOK_AUTH_BASE', 'TIKTOK_WEBHOOK_TOKEN']) delete process.env[k];
    await admin.$disconnect();
    await app.close();
    await tt.stop();
  });
  beforeEach(() => { tt.pushes.length = 0; tt.requests.length = 0; tt.orders = []; tt.products = []; tt.shops = [{ id: '7000000001', name: 'Loja Teste', region: 'BR', cipher: 'CIFRA-1', code: 'BR1' }]; });

  describe('autorização', () => {
    it('aparece com todas as capacidades sem validação real e uma única vez no catálogo', async () => {
      const list = (await A.owner.get('/api/integrations/providers').expect(200)).body as { provider: string; capabilities: Record<string, string> }[];
      const t = list.filter((p) => p.provider === 'TIKTOK_SHOP');
      expect(t).toHaveLength(1);
      expect(Object.values(t[0].capabilities)).toEqual(Array(8).fill('IMPLEMENTED_UNVERIFIED'));
    });

    it('sem App Key/Secret informa a pendência (424); com eles monta o endereço de autorização com app_key e state', async () => {
      const saved = { k: process.env.TIKTOK_APP_KEY, s: process.env.TIKTOK_APP_SECRET };
      delete process.env.TIKTOK_APP_KEY; delete process.env.TIKTOK_APP_SECRET;
      try {
        const id = (await A.owner.post('/api/integrations/connections').set(H).send({ provider: 'TIKTOK_SHOP', label: 'sem app' }).expect(201)).body.id;
        const r = await A.owner.post(`/api/integrations/connections/${id}/authorize`).set(H).expect(424);
        expect(r.body.message).toMatch(/TIKTOK_APP_KEY/);
      } finally { process.env.TIKTOK_APP_KEY = saved.k; process.env.TIKTOK_APP_SECRET = saved.s; }
      const id = (await A.owner.post('/api/integrations/connections').set(H).send({ provider: 'TIKTOK_SHOP', label: 'url' }).expect(201)).body.id;
      const { authorizationUrl } = (await A.owner.post(`/api/integrations/connections/${id}/authorize`).set(H).expect(200)).body;
      const u = new URL(authorizationUrl);
      expect(u.origin + u.pathname).toBe(`${tt.base}/oauth/authorize`);
      expect(u.searchParams.get('app_key')).toBe(APP_KEY);
      expect(u.searchParams.get('state')).toBeTruthy();
    });

    it('troca o código, guarda tokens e shop_cipher cifrados; código ruim e repetido não conectam', async () => {
      const id = (await A.owner.post('/api/integrations/connections').set(H).send({ provider: 'TIKTOK_SHOP', label: 'oauth' }).expect(201)).body.id;
      const first = (await A.owner.post(`/api/integrations/connections/${id}/authorize`).set(H).expect(200)).body;
      await callback(stateOf(first.authorizationUrl), 'codigo-ruim').expect(302);
      expect((await admin.marketplaceConnection.findUniqueOrThrow({ where: { id } })).credentialsEnc).toBeNull();

      const second = (await A.owner.post(`/api/integrations/connections/${id}/authorize`).set(H).expect(200)).body;
      tt.requests.length = 0;
      const ok = await callback(stateOf(second.authorizationUrl)).expect(302);
      expect(ok.headers.location).toContain(`connected=${id}`);
      const shops = tt.requests.find((r) => r.path === '/authorization/202309/shops')!;
      expect(shops.signOk).toBe(true);
      expect(shops.headers['x-tts-access-token']).toMatch(/^tt-access-/);
      const row = await admin.marketplaceConnection.findUniqueOrThrow({ where: { id } });
      expect(row.externalAccountId).toBe('7000000001');
      expect(row.credentialsEnc).not.toBeNull();
      expect(JSON.stringify(row)).not.toMatch(/tt-access|tt-refresh|CIFRA-1|app-secret/);
      expect(row.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 500_000_000);
      expect((await callback(stateOf(second.authorizationUrl)).expect(302)).headers.location).toContain('error='); // o mesmo retorno não vale duas vezes
    });

    it('o teste de conexão confere a loja e recusa conta que não é do Brasil', async () => {
      const id = (await A.owner.post('/api/integrations/connections').set(H).send({ provider: 'TIKTOK_SHOP', label: 'teste' }).expect(201)).body.id;
      const { authorizationUrl } = (await A.owner.post(`/api/integrations/connections/${id}/authorize`).set(H).expect(200)).body;
      tt.shops = [{ id: '1', name: 'Loja US', region: 'US', cipher: 'x', code: 'US1' }];
      await callback(stateOf(authorizationUrl)).expect(302);
      expect((await admin.marketplaceConnection.findUniqueOrThrow({ where: { id } })).credentialsEnc).toBeNull(); // nem chega a guardar
    });
  });

  describe('pedidos', () => {
    it('lê as páginas assinadas, importa o que está pago, deixa aguardando o não pago e registra o cancelado', async () => {
      const id = await connect(A);
      await product(A, 'TT-OK', 30);
      tt.orders = [tt.order('T1', { status: 'AWAITING_SHIPMENT', sku: 'TT-OK', qty: 3 }), tt.order('T2', { status: 'UNPAID', sku: 'TT-OK' }), tt.order('T3', { status: 'CANCELLED', sku: 'TT-OK' }), tt.order('T4', { status: 'COMPLETED', sku: 'TT-OK' })];
      tt.requests.length = 0;
      await syncNow(id);
      expect(tt.requests.length).toBeGreaterThan(0);
      expect(tt.requests.filter((r) => !r.path.startsWith('/api/v2/token')).every((r) => r.signOk)).toBe(true); // toda chamada da API saiu com assinatura válida (a troca de token não é assinada)
      const all = await ledger(A, id);
      expect(all.map((o) => o.externalId).sort()).toEqual(['T1', 'T2', 'T3', 'T4']);
      expect((await ledger(A, id, 'IMPORTED')).map((o) => o.externalId).sort()).toEqual(['T1', 'T4']);
      expect((await ledger(A, id, 'AWAITING_PAYMENT')).map((o) => o.externalId)).toEqual(['T2']);
      expect((await ledger(A, id, 'CANCELLED')).map((o) => o.externalId)).toEqual(['T3']);
      const sale = await admin.salesOrder.findFirstOrThrow({ where: { tenantId: A.tenantId, externalSource: 'TIKTOK_SHOP', externalRef: 'T1' }, include: { items: true } });
      expect(sale.items).toHaveLength(1);
      expect(sale.items[0].quantity).toBe(3); // 3 linhas de 1 unidade viram um item de 3
      expect(Number(sale.items[0].unitPrice)).toBe(50);
      await syncNow(id);
      expect(await admin.salesOrder.count({ where: { tenantId: A.tenantId, externalSource: 'TIKTOK_SHOP' } })).toBe(2); // repetir não duplica
    });

    it('pedido pago sem produto com o SKU pede atenção', async () => {
      const id = await connect(A);
      tt.orders = [tt.order('T10', { sku: 'SEM-PRODUTO' })];
      await syncNow(id);
      expect((await ledger(A, id, 'NEEDS_ATTENTION')).find((o) => o.externalId === 'T10').reason).toMatch(/SEM-PRODUTO/);
    });
  });

  describe('catálogo (importar para a base)', () => {
    it('varre os anúncios paginados, um por SKU', async () => {
      const id = await connect(A);
      tt.products = [
        { id: '501', title: 'Anel de vedação', status: 'ACTIVATE', skus: [{ id: '1', seller_sku: 'TT-A', price: { currency: 'BRL', sale_price: '12.50' }, inventory: [{ warehouse_id: 'W', quantity: 8 }] }] },
        { id: '502', title: 'Bucha', status: 'ACTIVATE', skus: [{ id: '2', seller_sku: 'TT-B', price: { currency: 'BRL', sale_price: '3.00' }, inventory: [{ warehouse_id: 'W', quantity: 1 }] }, { id: '3', seller_sku: 'TT-C', price: { currency: 'BRL', sale_price: '3.50' }, inventory: [] }] },
      ];
      let cursor: string | null = null; let created = 0;
      for (let i = 0; i < 5; i++) {
        const r: any = (await A.owner.post(`/api/integrations/connections/${id}/catalog/scan`).set(H).send(cursor ? { cursor } : {}).expect(201)).body;
        created += r.created; cursor = r.nextCursor;
        if (!cursor) break;
      }
      expect(created).toBe(3);
      const items = (await A.owner.get(`/api/integrations/connections/${id}/catalog/items?status=NEW`).expect(200)).body.items as any[];
      expect(items.map((i) => i.sku).sort()).toEqual(['TT-A', 'TT-B', 'TT-C']);
      expect(items.find((i) => i.sku === 'TT-A')).toMatchObject({ title: 'Anel de vedação' });
    });
  });

  describe('preço e estoque pelo vínculo do anúncio', () => {
    it('envia ao canal o estoque publicável e o preço aprovado, no SKU certo, com assinatura válida, e só reenvia o que mudou', async () => {
      const id = await connect(A);
      await A.owner.put(`/api/integrations/connections/${id}/config`).set(H).send({ warehouseId: A.wh, stockSync: true, priceSync: true }).expect(200);
      await A.owner.put(`/api/integrations/connections/${id}/fees`).set(H).send({ commissionPct: 16, paymentPct: 4, taxPct: 6, fixedFee: 6, shippingSubsidy: 10, packaging: 2, minMarginPct: 10 }).expect(200);
      const p = (await A.owner.post('/api/products').set(H).send({ sku: 'TT-LINK', name: 'Produto vinculado', costPrice: 50, extraCost: 2 }).expect(201)).body.id as string;
      await A.owner.post('/api/stock/movements').set(H).send({ productId: p, warehouseId: A.wh, type: 'PURCHASE_ENTRY', quantity: 40 }).expect(201);
      await A.owner.post(`/api/integrations/connections/${id}/listings`).set(H).send({ productId: p, externalItemId: '555:901' }).expect(200);
      await A.owner.put(`/api/integrations/connections/${id}/listings/${p}/price`).set(H).send({ price: 129.9, reason: 'preço de lançamento' }).expect(200);
      const sync = async () => {
        await admin.$executeRaw`UPDATE background_jobs SET status = 'CANCELLED' WHERE connection_id = ${id}::uuid AND status = 'QUEUED'`;
        await admin.$executeRaw`DELETE FROM background_jobs WHERE connection_id = ${id}::uuid AND idempotency_key LIKE 'sync-manual:%'`;
        await A.owner.post(`/api/integrations/connections/${id}/sync`).set(H).expect(200);
        await drain();
      };
      await sync();
      expect(tt.pushes.every((x) => x.signOk)).toBe(true);
      expect(tt.pushes.find((x) => x.op === 'inventory')!.body).toEqual({ skus: [{ id: '901', inventory: [{ warehouse_id: 'W1', quantity: 40 }] }] });
      expect(tt.pushes.find((x) => x.op === 'prices')!.body).toEqual({ skus: [{ id: '901', price: { amount: '129.90', currency: 'BRL' } }] });
      const l = ((await A.owner.get(`/api/integrations/connections/${id}/listings`).expect(200)).body as any[]).find((x) => x.productId === p);
      expect(l).toMatchObject({ lastPublishedQty: 40, lastPublishedPrice: 129.9, syncStatus: 'OK' });
      tt.pushes.length = 0;
      await sync(); // nada mudou
      expect(tt.pushes).toHaveLength(0);
    });
  });

  describe('notificações assinadas', () => {
    it('recusa token errado (404), assinatura ausente/errada/de outro corpo (401) e corpo alterado', async () => {
      const body = { type: 1, tts_notification_id: 'N-x', shop_id: '7000000001', timestamp: 1, data: { order_id: 'W1' } };
      await hook(body, { token: 'token-errado' }).expect(404);
      await hook(body, { signature: null }).expect(401);
      await hook(body, { signature: 'a'.repeat(64) }).expect(401);
      const good = createHmac('sha256', APP_SECRET).update(APP_KEY + JSON.stringify(body)).digest('hex');
      await hook({ ...body, shop_id: '999' }, { signature: good }).expect(401); // assinatura de outro corpo
      await hook(body).expect(200);
    });

    it('mudança de status do pedido importa o pedido relendo a API; o mesmo aviso repetido não duplica', async () => {
      const id = await connect(A);
      await product(A, 'TT-HOOK', 10);
      tt.orders = [tt.order('580000000009', { status: 'AWAITING_SHIPMENT', sku: 'TT-HOOK', qty: 1 })];
      const shop = (await admin.marketplaceConnection.findUniqueOrThrow({ where: { id } })).externalAccountId;
      const body = { type: 1, tts_notification_id: `N-${uid()}`, shop_id: shop, timestamp: Math.floor(Date.now() / 1000), data: { order_id: '580000000009', order_status: 'AWAITING_SHIPMENT' } };
      tt.requests.length = 0;
      await hook(body).expect(200);
      await hook(body).expect(200);
      await drain();
      expect(tt.requests.filter((r) => r.path === '/order/202309/orders' && r.signOk)).toHaveLength(1); // dedupe por tts_notification_id
      expect((await ledger(A, id, 'IMPORTED')).map((o) => o.externalId)).toContain('580000000009');
      expect(await admin.salesOrder.count({ where: { tenantId: A.tenantId, externalSource: 'TIKTOK_SHOP', externalRef: '580000000009' } })).toBe(1);
    });

    it('a notificação de outra loja não toca nesta conexão', async () => {
      const before = await admin.webhookEvent.count();
      await hook({ type: 1, tts_notification_id: `N-${uid()}`, shop_id: '123456789', data: { order_id: 'Z' } }).expect(200);
      expect(await admin.webhookEvent.count()).toBe(before);
    });

    it('desautorização pelo vendedor marca a conexão como autorização expirada', async () => {
      const id = await connect(A);
      const conn = await admin.marketplaceConnection.findUniqueOrThrow({ where: { id } });
      await admin.marketplaceConnection.updateMany({ where: { provider: 'TIKTOK_SHOP', id: { not: id } }, data: { status: 'DISCONNECTED' } });
      await hook({ type: 6, tts_notification_id: `N-${uid()}`, shop_id: conn.externalAccountId, timestamp: 1, data: {} }).expect(200);
      await drain();
      expect((await admin.marketplaceConnection.findUniqueOrThrow({ where: { id } })).status).toBe('TOKEN_EXPIRED');
    });
  });
});
