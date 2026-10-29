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
 * ATENÇÃO: o servidor abaixo SIMULA a SP-API da Amazon conforme a documentação pesquisada em 29/10/2026 (Login with Amazon, cabeçalho
 * x-amz-access-token, Orders API v0). Estes testes provam o comportamento do NOSSO código; não provam que a API real responde assim.
 * Falta validar com uma conta de vendedor real.
 */
class MockAmazon {
  server!: Server;
  base = '';
  access = new Set<string>();
  n = 0;
  requests: { method: string; path: string; query: URLSearchParams; headers: IncomingMessage['headers']; body: any; contentType: string }[] = [];
  orders: Record<string, any>[] = [];
  participates = true;
  pageSize = 2;

  order(id: string, o: Partial<{ status: string; sku: string; qty: number; price: number; channel: string }> = {}) {
    return {
      AmazonOrderId: id, PurchaseDate: new Date().toISOString(), LastUpdateDate: new Date().toISOString(), OrderStatus: o.status ?? 'Unshipped',
      FulfillmentChannel: o.channel ?? 'MFN', OrderTotal: { CurrencyCode: 'BRL', Amount: String((o.qty ?? 2) * (o.price ?? 50)) },
      BuyerInfo: { BuyerEmail: `${id}@marketplace.amazon.com.br` },
      _items: [{ OrderItemId: `OI-${id}`, SellerSKU: o.sku ?? 'AZ-SKU', Title: 'Parafuso', QuantityOrdered: o.qty ?? 2, ItemPrice: { CurrencyCode: 'BRL', Amount: String((o.qty ?? 2) * (o.price ?? 50)) } }],
    };
  }

  async start() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop() { return new Promise<void>((r) => this.server.close(() => r())); }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, this.base);
    const raw = await new Promise<string>((ok) => { let s = ''; req.on('data', (d) => (s += d)).on('end', () => ok(s)); });
    const contentType = String(req.headers['content-type'] ?? '');
    const body = raw ? Object.fromEntries(new URLSearchParams(raw)) : null;
    this.requests.push({ method: req.method!, path: url.pathname, query: url.searchParams, headers: req.headers, body, contentType });
    const send = (status: number, json: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };

    if (url.pathname === '/auth/o2/token') {
      if (body?.client_id !== 'amzn1.application-oa2-client.TESTE' || body?.client_secret !== 'SEGREDO') return send(400, { error: 'invalid_client', error_description: 'Client authentication failed' });
      if (body.grant_type !== 'refresh_token' || body.refresh_token !== 'Atzr|BOM') return send(400, { error: 'invalid_grant', error_description: 'The provided refresh token is invalid' });
      const a = `Atza|access-${++this.n}`; this.access.add(a);
      return send(200, { access_token: a, token_type: 'bearer', expires_in: 3600 });
    }
    if (req.headers.authorization) return send(403, { errors: [{ code: 'Unauthorized', message: 'Authorization não deve ser enviado' }] }); // SP-API usa x-amz-access-token
    if (!this.access.has(String(req.headers['x-amz-access-token'] ?? ''))) return send(403, { errors: [{ code: 'Unauthorized', message: 'Access to requested resource is denied.' }] });
    if (url.pathname === '/sellers/v1/marketplaceParticipations') {
      return send(200, { payload: this.participates ? [{ marketplace: { id: 'A2Q3Y263D00KWC', countryCode: 'BR' }, participation: { isParticipating: true } }] : [{ marketplace: { id: 'ATVPDKIKX0DER', countryCode: 'US' }, participation: { isParticipating: true } }] });
    }
    if (url.pathname === '/orders/v0/orders') {
      const token = url.searchParams.get('NextToken');
      if (!token && (!url.searchParams.get('LastUpdatedAfter') || url.searchParams.get('MarketplaceIds') !== 'A2Q3Y263D00KWC')) return send(400, { errors: [{ code: 'InvalidInput', message: 'LastUpdatedAfter e MarketplaceIds são obrigatórios' }] });
      if (token && [...url.searchParams.keys()].length > 1) return send(400, { errors: [{ code: 'InvalidInput', message: 'Com NextToken só o próprio NextToken é aceito' }] });
      const offset = token ? Number(token.replace('T', '')) : 0;
      const slice = this.orders.slice(offset, offset + this.pageSize).map(({ _items, ...o }) => o);
      const next = offset + this.pageSize < this.orders.length ? { NextToken: `T${offset + this.pageSize}` } : {};
      return send(200, { payload: { Orders: slice, ...next } });
    }
    const m = /^\/orders\/v0\/orders\/([^/]+)\/orderItems$/.exec(url.pathname);
    if (m) {
      const o = this.orders.find((x) => x.AmazonOrderId === decodeURIComponent(m[1]));
      return o ? send(200, { payload: { AmazonOrderId: o.AmazonOrderId, OrderItems: o._items } }) : send(404, { errors: [{ code: 'NotFound', message: 'pedido inexistente' }] });
    }
    return send(404, { errors: [{ code: 'NotFound', message: 'rota inexistente no simulador' }] });
  }
}

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);
let seq = 0;
const uid = () => `${run}${++seq}`;
const GOOD = { lwaClientId: 'amzn1.application-oa2-client.TESTE', lwaClientSecret: 'SEGREDO', refreshToken: 'Atzr|BOM', sellerId: 'A1B2C3D4E5F6G7' };

describe('Amazon (servidor simulado): autorização própria e pedidos', () => {
  let app: INestApplication;
  let worker: JobWorker;
  let admin: PrismaClient;
  const az = new MockAmazon();
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

  const drain = async () => { for (let i = 0; i < 10; i++) if ((await worker.runOnce(20)) === 0) break; };
  const create = async (t: T, label = `AZ ${uid()}`) => {
    const id = (await t.owner.post('/api/integrations/connections').set(H).send({ provider: 'AMAZON', label }).expect(201)).body.id as string;
    await t.owner.put(`/api/integrations/connections/${id}/config`).set(H).send({ warehouseId: t.wh }).expect(200);
    return id;
  };
  async function connect(t: T, sellerId = 'A1B2C3D4E5F6G7') {
    const id = await create(t);
    await t.owner.post(`/api/integrations/connections/${id}/credentials`).set(H).send({ fields: { ...GOOD, sellerId } }).expect(200);
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

  let A: T;
  beforeAll(async () => {
    await az.start();
    Object.assign(process.env, { AMAZON_LWA_URL: `${az.base}/auth/o2/token`, AMAZON_SPAPI_BASE: az.base, AMAZON_ITEM_GAP_MS: '0' });
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    worker = app.get(JobWorker);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    await admin.$executeRaw`UPDATE marketplace_connections SET status = 'DISCONNECTED' WHERE status IN ('ACTIVE','SYNC_ERROR')`;
    await admin.$executeRaw`UPDATE background_jobs SET status = 'CANCELLED' WHERE status IN ('QUEUED','RUNNING')`;
    A = await setup('azA');
  });
  afterAll(async () => {
    for (const k of ['AMAZON_LWA_URL', 'AMAZON_SPAPI_BASE', 'AMAZON_ITEM_GAP_MS']) delete process.env[k];
    await admin.$disconnect();
    await app.close();
    await az.stop();
  });
  beforeEach(() => { az.requests.length = 0; az.orders = []; az.participates = true; });

  describe('autorização própria', () => {
    it('aparece com os campos que o vendedor informa e sem validação real', async () => {
      const list = (await A.owner.get('/api/integrations/providers').expect(200)).body as any[];
      const a = list.find((p) => p.provider === 'AMAZON');
      expect(a.capabilities).toMatchObject({ authorization: 'IMPLEMENTED_UNVERIFIED', orders: 'IMPLEMENTED_UNVERIFIED', catalog: 'PLANNED', publishing: 'PLANNED', price: 'PLANNED', inventory: 'PLANNED' });
      expect(a.credentialFields.map((f: any) => f.name)).toEqual(['lwaClientId', 'lwaClientSecret', 'refreshToken', 'sellerId']);
      expect(a.credentialFields.filter((f: any) => f.secret).map((f: any) => f.name)).toEqual(['lwaClientSecret', 'refreshToken']);
      expect(list.filter((p) => p.provider === 'AMAZON')).toHaveLength(1);
    });

    it('não tem tela de autorização por redirecionamento', async () => {
      const id = await create(A);
      const r = await A.owner.post(`/api/integrations/connections/${id}/authorize`).set(H);
      expect(r.status).toBe(501); // "não suportado": não há redirecionamento neste canal
    });

    it('recusa campos faltando, ID de vendedor inválido, credenciais erradas e só guarda cifrado quando a Amazon aceita', async () => {
      const id = await create(A);
      const url = `/api/integrations/connections/${id}/credentials`;
      await A.owner.post(url).set(H).send({ fields: { ...GOOD, refreshToken: '' } }).expect(400);
      await A.owner.post(url).set(H).send({ fields: { ...GOOD, sellerId: 'abc' } }).expect(400);
      const bad = await A.owner.post(url).set(H).send({ fields: { ...GOOD, refreshToken: 'Atzr|RUIM' } });
      expect(bad.status).toBeGreaterThanOrEqual(400);
      expect((await admin.marketplaceConnection.findUniqueOrThrow({ where: { id } })).credentialsEnc).toBeNull();

      az.requests.length = 0;
      await A.owner.post(url).set(H).send({ fields: GOOD }).expect(200);
      const tok = az.requests.find((q) => q.path === '/auth/o2/token')!;
      expect(tok.contentType).toContain('x-www-form-urlencoded');
      expect(tok.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'Atzr|BOM', client_id: GOOD.lwaClientId });
      const row = await admin.marketplaceConnection.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('TEST_PENDING');
      expect(row.externalAccountId).toBe(GOOD.sellerId);
      expect(row.credentialsEnc).not.toBeNull();
      expect(JSON.stringify(row)).not.toMatch(/SEGREDO|Atzr\||Atza\|/); // nada em texto puro no banco
      expect(JSON.stringify((await A.owner.get(`/api/integrations/connections/${id}`).expect(200)).body)).not.toMatch(/SEGREDO|Atzr\||Atza\|/); // nem na resposta
    });

    it('o teste usa x-amz-access-token (sem Authorization) e exige participação no marketplace do Brasil', async () => {
      const id = await create(A);
      await A.owner.post(`/api/integrations/connections/${id}/credentials`).set(H).send({ fields: { ...GOOD, sellerId: 'ZZZZZZZZZZZZZ1' } }).expect(200);
      az.participates = false;
      const fail = await A.owner.post(`/api/integrations/connections/${id}/test`).set(H);
      expect(fail.status).toBeGreaterThanOrEqual(400);
      az.participates = true;
      az.requests.length = 0;
      await A.owner.post(`/api/integrations/connections/${id}/test`).set(H).expect(200);
      const q = az.requests.find((r) => r.path === '/sellers/v1/marketplaceParticipations')!;
      expect(q.headers['x-amz-access-token']).toMatch(/^Atza\|/);
      expect(q.headers.authorization).toBeUndefined();
    });

    it('renova o token com o refresh token guardado', async () => {
      const connector = app.get(ConnectorRegistry).get('AMAZON')!;
      const r = await connector.refreshAuthorization({ connectionId: 'x', tenantId: 'x', credentials: { ...GOOD }, config: {}, externalAccountId: null });
      expect(r).toMatchObject({ ok: true });
      expect((r as any).data.credentials.accessToken).toMatch(/^Atza\|/);
      expect(await connector.refreshAuthorization({ connectionId: 'x', tenantId: 'x', credentials: { ...GOOD, refreshToken: 'Atzr|RUIM' }, config: {}, externalAccountId: null })).toMatchObject({ ok: false, code: 'AUTH' });
      expect(await connector.refreshAuthorization({ connectionId: 'x', tenantId: 'x', credentials: null, config: {}, externalAccountId: null })).toMatchObject({ ok: false, code: 'AUTH' });
    });
  });

  describe('pedidos', () => {
    it('lê todas as páginas com NextToken, importa só os enviados por você, deixa pendente o não pago e registra o cancelado', async () => {
      const id = await connect(A, 'A1B2C3D4E5F6G8');
      await product(A, 'AZ-OK', 30);
      az.orders = [
        az.order('111-0000001-0000001', { status: 'Unshipped', sku: 'AZ-OK', qty: 3, price: 40 }),
        az.order('111-0000002-0000002', { status: 'Pending', sku: 'AZ-OK' }),
        az.order('111-0000003-0000003', { status: 'Canceled', sku: 'AZ-OK' }),
        az.order('111-0000004-0000004', { status: 'Unshipped', sku: 'AZ-OK', channel: 'AFN' }), // FBA: fora
        az.order('111-0000005-0000005', { status: 'Shipped', sku: 'AZ-OK' }),
      ];
      az.requests.length = 0;
      await syncNow(id);
      const listCalls = az.requests.filter((q) => q.path === '/orders/v0/orders');
      expect(listCalls.length).toBeGreaterThanOrEqual(3); // 5 pedidos, páginas de 2
      expect(listCalls[0].query.get('MarketplaceIds')).toBe('A2Q3Y263D00KWC');
      expect(listCalls[0].query.get('LastUpdatedAfter')).toBeTruthy();
      expect(listCalls.slice(1).every((c) => c.query.get('NextToken') && [...c.query.keys()].length === 1)).toBe(true);
      // itens só dos pedidos pagos
      const itemCalls = az.requests.filter((q) => q.path.endsWith('/orderItems')).map((q) => q.path);
      expect(itemCalls.some((p) => p.includes('111-0000002-0000002') || p.includes('111-0000003-0000003'))).toBe(false);

      const all = await ledger(A, id);
      expect(all.map((o) => o.externalId).sort()).toEqual(['111-0000001-0000001', '111-0000002-0000002', '111-0000003-0000003', '111-0000005-0000005']); // FBA não aparece
      expect((await ledger(A, id, 'IMPORTED')).map((o) => o.externalId).sort()).toEqual(['111-0000001-0000001', '111-0000005-0000005']);
      expect((await ledger(A, id, 'AWAITING_PAYMENT')).map((o) => o.externalId)).toEqual(['111-0000002-0000002']);
      expect((await ledger(A, id, 'CANCELLED')).map((o) => o.externalId)).toEqual(['111-0000003-0000003']);

      const sale = await admin.salesOrder.findFirstOrThrow({ where: { tenantId: A.tenantId, externalSource: 'AMAZON', externalRef: '111-0000001-0000001' }, include: { items: true } });
      expect(sale.items).toHaveLength(1);
      expect(sale.items[0].quantity).toBe(3);
      expect(Number(sale.items[0].unitPrice)).toBe(40); // ItemPrice é o total da linha: 120 / 3
      await syncNow(id); // repetir não duplica
      expect(await admin.salesOrder.count({ where: { tenantId: A.tenantId, externalSource: 'AMAZON' } })).toBe(2);
    });

    it('pedido pago sem produto com o SKU pede atenção', async () => {
      const id = await connect(A, 'A1B2C3D4E5F6G9');
      az.orders = [az.order('111-0000010-0000010', { sku: 'SEM-PRODUTO' })];
      await syncNow(id);
      const att = await ledger(A, id, 'NEEDS_ATTENTION');
      expect(att.find((o) => o.externalId === '111-0000010-0000010').reason).toMatch(/SEM-PRODUTO/);
    });

    it('operações de escrita continuam não implementadas (nada é enviado à Amazon)', async () => {
      const connector = app.get(ConnectorRegistry).get('AMAZON')!;
      const ctx = { connectionId: 'x', tenantId: 'x', credentials: { accessToken: 'x' }, config: {}, externalAccountId: null };
      for (const r of [await connector.updatePrice(ctx, { externalId: 'S', price: 1 }), await connector.updateInventory(ctx, { externalId: 'S', quantity: 1 }), await connector.publishProduct(ctx, { productId: 'p', payload: {}, idempotencyKey: 'k' })]) {
        expect(r).toMatchObject({ ok: false, code: 'NOT_IMPLEMENTED' });
      }
      expect(az.requests.filter((q) => q.method !== 'GET' && q.path.startsWith('/orders'))).toHaveLength(0);
    });
  });
});
