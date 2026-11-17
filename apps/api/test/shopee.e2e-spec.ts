import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { createHmac } from 'node:crypto';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';
import { ConnectionsService } from '../src/integrations/connections.service';
import { CryptoService } from '../src/integrations/crypto.service';
import { JobQueue } from '../src/integrations/job-queue';
import { JobWorker } from '../src/integrations/jobs.service';
import { PrismaService } from '../src/prisma/prisma.service';

const H = { 'x-dh-csrf': '1' };

describe('Shopee com API simulada e credenciais isoladas', () => {
  let app: INestApplication;
  let server: Server;
  let admin: PrismaClient;
  let owner: ReturnType<typeof request.agent>;
  let tenantId: string;
  let connectionId: string;
  let warehouseId: string;
  let exchangeCount = 0;
  let refreshCount = 0;
  let orderPages = 0;
  const run = Date.now().toString(36);
  const original = { ...process.env };

  beforeAll(async () => {
    process.env.SHOPEE_PARTNER_ID = '123';
    process.env.SHOPEE_PARTNER_KEY = 'partner-test-secret';
    process.env.SHOPEE_SANDBOX = 'true';
    server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://127.0.0.1');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const timestamp = url.searchParams.get('timestamp');
      const token = url.searchParams.get('access_token') ?? '';
      const shop = url.searchParams.get('shop_id') ?? '';
      const sign = createHmac('sha256', 'partner-test-secret').update('123' + url.pathname + timestamp + token + shop).digest('hex');
      const send = (data: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (url.searchParams.get('sign') !== sign) return send({ error: 'error_sign' });
      if (url.pathname.endsWith('/auth/token/get')) {
        exchangeCount++;
        if (body.code !== 'one-use-code' || body.shop_id !== 234) return send({ error: 'error_auth' });
        return send({ access_token: 'access-secret-test', refresh_token: 'refresh-secret-test', expire_in: 14400, shop_id_list: [234] });
      }
      if (url.pathname.endsWith('/auth/access_token/get')) {
        refreshCount++;
        if (body.refresh_token !== 'refresh-secret-test') return send({ error: 'error_token' });
        await new Promise((resolve) => setTimeout(resolve, 80));
        return send({ access_token: 'rotated-access-test', refresh_token: 'rotated-refresh-test', expire_in: 14400, shop_id: 234 });
      }
      if (shop !== '234') return send({ error: 'error_auth' });
      if (url.pathname.endsWith('/shop/get_shop_info')) return send({ shop_name: 'Loja teste', region: 'BR', status: 'NORMAL' });
      if (url.pathname.endsWith('/order/get_order_list')) {
        const page = Number(url.searchParams.get('cursor') || 0);
        orderPages++;
        return send({ response: { order_list: [{ order_sn: 'ORDER-' + page }], more: page < 11, next_cursor: String(page + 1) } });
      }
      if (url.pathname.endsWith('/order/get_order_detail')) {
        return send({ response: { order_list: [{
          order_sn: url.searchParams.get('order_sn_list'), order_status: 'READY_TO_SHIP', currency: 'BRL',
          create_time: 1700000000, update_time: Math.floor(Date.now() / 1000), buyer_user_id: 456, buyer_username: 'Comprador',
          total_amount: 12, item_list: [{ item_id: 100, model_id: 7, model_sku: 'SHOPEE-' + run, model_quantity_purchased: 1, model_discounted_price: 12 }],
        }] } });
      }
      return send({ error: 'not_found' }, 404);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.SHOPEE_API_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    owner = request.agent(app.getHttpServer());
    const reg = await owner.post('/api/auth/register').set(H).send({ companyName: 'Shopee ' + run, name: 'Dono', email: `shopee-${run}@teste.local`, password: 'Senha#Segura123' }).expect(201);
    tenantId = reg.body.tenantId;
    const company = (await owner.post('/api/companies').set(H).send({ legalName: 'Shopee testes LTDA' }).expect(201)).body;
    const est = (await owner.post('/api/establishments').set(H).send({ companyId: company.id, kind: 'MATRIZ', name: 'Matriz' }).expect(201)).body;
    warehouseId = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
  });

  afterAll(async () => {
    await app?.close();
    await admin?.$disconnect();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const key of ['SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY', 'SHOPEE_API_BASE', 'SHOPEE_SANDBOX']) {
      if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
    }
  });

  it('recebe shop_id no callback, cifra credenciais, impede repetição e ativa somente após testar', async () => {
    connectionId = (await owner.post('/api/integrations/connections').set(H).send({ provider: 'SHOPEE', label: 'Shopee teste' }).expect(201)).body.id;
    await owner.put(`/api/integrations/connections/${connectionId}/config`).set(H).send({ warehouseId }).expect(200);
    const auth = (await owner.post(`/api/integrations/connections/${connectionId}/authorize`).set(H).expect(200)).body;
    const url = new URL(auth.authorizationUrl);
    const state = url.searchParams.get('state')!;
    const callback = '/api/integrations/callback?' + new URLSearchParams({ code: 'one-use-code', state, shop_id: '234' });
    const results = await Promise.all([request(app.getHttpServer()).get(callback), request(app.getHttpServer()).get(callback)]);
    expect(results.filter((result) => result.headers.location.includes('connected='))).toHaveLength(1);
    expect(exchangeCount).toBe(1);
    const conn = await admin.marketplaceConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(conn.credentialsEnc).not.toContain('access-secret-test');
    expect(conn.externalAccountId).toBe('234');
    await owner.post(`/api/integrations/connections/${connectionId}/activate`).set(H).expect(409);
    await owner.post(`/api/integrations/connections/${connectionId}/test`).set(H).expect(200);
    await owner.post(`/api/integrations/connections/${connectionId}/activate`).set(H).expect(200);
  });

  it('renova uma vez quando dois workers tentam usar o mesmo refresh token', async () => {
    const service = app.get(ConnectionsService);
    const results = await Promise.all([service.refreshCredentials(tenantId, connectionId), service.refreshCredentials(tenantId, connectionId)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(refreshCount).toBe(1);
    const conn = await admin.marketplaceConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(conn.tokenRefreshStartedAt).toBeNull();
    expect(app.get(CryptoService).decrypt(tenantId, `cred:${connectionId}`, conn.credentialsEnc!)).toMatchObject({ refreshToken: 'rotated-refresh-test' });
  });

  it('continua além de dez páginas, importa por SKU e só marca sincronização ao concluir', async () => {
    const productId = (await owner.post('/api/products').set(H).send({ sku: 'SHOPEE-' + run, name: 'Chocolate', suggestedPrice: 12, costPrice: 5 }).expect(201)).body.id;
    await owner.post('/api/stock/movements').set(H).send({ productId, warehouseId, type: 'PURCHASE_ENTRY', quantity: 30 }).expect(201);
    const prisma = app.get(PrismaService);
    await prisma.withContext({ tenantId }, (tx) => app.get(JobQueue).enqueue(tx, tenantId, { type: 'connection.reconcile', connectionId, idempotencyKey: 'shopee-pages-' + run }));
    await app.get(JobWorker).runOnce();
    expect(orderPages).toBe(10);
    expect((await admin.marketplaceConnection.findUniqueOrThrow({ where: { id: connectionId } })).lastSyncAt).toBeNull();
    await app.get(JobWorker).runOnce();
    expect(orderPages).toBe(12);
    expect((await admin.marketplaceConnection.findUniqueOrThrow({ where: { id: connectionId } })).lastSyncAt).not.toBeNull();
    expect(await admin.externalOrder.count({ where: { connectionId, status: 'IMPORTED' } })).toBe(12);
  });
});
