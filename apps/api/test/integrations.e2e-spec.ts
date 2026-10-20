import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';
import { JobQueue } from '../src/integrations/job-queue';
import { JobWorker } from '../src/integrations/jobs.service';
import type { Connector } from '../src/integrations/connector';
import { SandboxConnector } from '../src/integrations/providers';
import { PrismaService } from '../src/prisma/prisma.service';

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);

describe('Fase 4 — central de integrações, fila, webhooks e credenciais', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let worker: JobWorker;
  let queue: JobQueue;
  let admin: PrismaClient;
  const agent = () => request.agent(app.getHttpServer());
  type Agent = ReturnType<typeof agent>;

  interface T { owner: Agent; tenantId: string; wh: string; viewer: Agent; outsider: Agent }

  async function setup(label: string): Promise<T> {
    const owner = agent();
    const reg = await owner.post('/api/auth/register').set(H).send({ companyName: `Co ${label} ${run}`, name: `Dono ${label}`, email: `${label}-${run}@teste.local`, password: PASSWORD }).expect(201);
    const company = await owner.post('/api/companies').set(H).send({ legalName: `${label} LTDA` }).expect(201);
    const est = await owner.post('/api/establishments').set(H).send({ companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz' }).expect(201);
    const wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
    const roles = Object.fromEntries((await owner.get('/api/roles').expect(200)).body.map((r: any) => [r.key, r.id]));
    const mk = async (role: string) => {
      const email = `${role}-${label}-${run}@teste.local`;
      await owner.post('/api/users').set(H).send({ name: role, email, password: PASSWORD, roleId: roles[role] }).expect(201);
      const a = agent();
      await a.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200);
      return a;
    };
    return { owner, tenantId: reg.body.tenantId, wh, viewer: await mk('ops_manager'), outsider: await mk('stock_operator') };
  }

  const sign = (body: string, secret: string) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  const hook = (t: T, id: string, secret: string, payload: object, signature?: string) => {
    const body = JSON.stringify(payload);
    return request(app.getHttpServer()).post(`/api/webhooks/${t.tenantId}/${id}`).set('content-type', 'application/json').set('x-dh-signature', signature ?? sign(body, secret)).send(body);
  };
  const stateOf = (url: string) => new URL(url).searchParams.get('state')!;
  const drain = async () => { for (let i = 0; i < 10; i++) if ((await worker.runOnce(20)) === 0) break; };
  const due = (tenantId: string) => admin.$executeRaw`UPDATE background_jobs SET run_at = now() - interval '1 second' WHERE tenant_id = ${tenantId}::uuid AND status = 'QUEUED'`;
  const conn = async (id: string) => admin.marketplaceConnection.findUniqueOrThrow({ where: { id } });
  const jobsOf = (id: string) => admin.backgroundJob.findMany({ where: { connectionId: id }, orderBy: { createdAt: 'asc' } });

  /** Cria, autoriza, testa e ativa uma conexão Sandbox. */
  async function activeSandbox(t: T, cfg: object = {}, withWarehouse = true) {
    const created = (await t.owner.post('/api/integrations/connections').set(H).send({ provider: 'SANDBOX', label: `sbx ${Math.random().toString(36).slice(2, 6)}` }).expect(201)).body;
    const id = created.id as string;
    await t.owner.put(`/api/integrations/connections/${id}/config`).set(H).send({ ...(withWarehouse ? { warehouseId: t.wh } : {}), ...cfg }).expect(200);
    const auth = (await t.owner.post(`/api/integrations/connections/${id}/authorize`).set(H).expect(200)).body;
    const cb = await request(app.getHttpServer()).get(`/api/integrations/callback?code=sandbox-code&state=${encodeURIComponent(stateOf(auth.authorizationUrl))}`).expect(302);
    expect(cb.headers.location).toContain(`connected=${id}`);
    await t.owner.post(`/api/integrations/connections/${id}/test`).set(H).expect(200);
    if (withWarehouse) await t.owner.post(`/api/integrations/connections/${id}/activate`).set(H).expect(200);
    return { id, secret: created.webhook.secret as string };
  }

  let A: T;
  let B: T;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    prisma = app.get(PrismaService);
    worker = app.get(JobWorker);
    queue = app.get(JobQueue);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    await admin.$executeRaw`UPDATE marketplace_connections SET status = 'DISCONNECTED' WHERE status IN ('ACTIVE','SYNC_ERROR')`;
    await admin.$executeRaw`UPDATE background_jobs SET status = 'CANCELLED' WHERE status IN ('QUEUED','RUNNING')`;
    await admin.plan.update({ where: { code: 'trial' }, data: { limits: { users: 100, establishments: 20, warehouses: 20 } } });
    A = await setup('intA');
    B = await setup('intB');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  describe('catálogo de canais e honestidade dos conectores', () => {
    it('lista os canais com matriz de capacidades "planejada" (nada é anunciado como suportado sem implementação)', async () => {
      const list = (await A.owner.get('/api/integrations/providers').expect(200)).body as any[];
      for (const p of ['AMAZON', 'SHOPEE']) {
        const c = list.find((x) => x.provider === p);
        expect(c).toBeDefined();
        expect(Object.values(c.capabilities)).toEqual(Array(8).fill('PLANNED'));
        expect(c.docsUrl).toMatch(/^https:/);
      }
      const ml = list.find((x) => x.provider === 'MERCADO_LIVRE');
      expect(ml.capabilities).toMatchObject({ authorization: 'IMPLEMENTED_UNVERIFIED', orders: 'IMPLEMENTED_UNVERIFIED', webhooks: 'IMPLEMENTED_UNVERIFIED', publishing: 'PLANNED', price: 'PLANNED', inventory: 'PLANNED' });
      expect(Object.values(ml.capabilities)).not.toContain('SUPPORTED'); // nada validado com conta real
      expect(list.find((x) => x.provider === 'SANDBOX')?.sandbox).toBe(true);
    });

    it('conector sem implementação (Amazon) devolve 501 explícito em autorizar/testar e impede a ativação', async () => {
      const c = (await A.owner.post('/api/integrations/connections').set(H).send({ provider: 'AMAZON', label: 'Amazon principal' }).expect(201)).body;
      expect(c.status).toBe('NOT_CONNECTED');
      const a = await A.owner.post(`/api/integrations/connections/${c.id}/authorize`).set(H).expect(501);
      expect(a.body.code).toBe('NOT_IMPLEMENTED');
      await A.owner.post(`/api/integrations/connections/${c.id}/test`).set(H).expect(501);
      const act = await A.owner.post(`/api/integrations/connections/${c.id}/activate`).set(H).expect(409);
      expect(act.body.missing).toEqual(expect.arrayContaining(['autorizar a conta no canal', 'executar o teste de conexão com sucesso', 'definir o depósito de origem']));
      expect((await conn(c.id)).status).toBe('NOT_CONNECTED');
      const logs = (await A.owner.get(`/api/integrations/logs?connectionId=${c.id}`).expect(200)).body;
      expect(logs.some((l: any) => l.level === 'warn' && /NOT_IMPLEMENTED/.test(l.message))).toBe(true);
    });

    it('provedor desconhecido é recusado', async () => {
      await A.owner.post('/api/integrations/connections').set(H).send({ provider: 'INEXISTENTE', label: 'x1' }).expect(400);
    });
  });

  describe('ciclo de vida da conexão e credenciais', () => {
    it('autorizar → callback → testar → ativar; credenciais ficam cifradas e nunca saem pela API', async () => {
      const created = (await A.owner.post('/api/integrations/connections').set(H).send({ provider: 'SANDBOX', label: 'ciclo' }).expect(201)).body;
      const id = created.id;
      expect(created.webhook.secret.length).toBeGreaterThan(20);
      await A.owner.put(`/api/integrations/connections/${id}/config`).set(H).send({ warehouseId: A.wh, reconcileMinutes: 3 }).expect(400); // mínimo 5
      await A.owner.put(`/api/integrations/connections/${id}/config`).set(H).send({ warehouseId: A.wh, reconcileMinutes: 10, stockSync: true }).expect(200);

      const auth = (await A.owner.post(`/api/integrations/connections/${id}/authorize`).set(H).expect(200)).body;
      expect((await conn(id)).status).toBe('AWAITING_AUTHORIZATION');
      const state = stateOf(auth.authorizationUrl);
      const cb = await request(app.getHttpServer()).get(`/api/integrations/callback?code=sandbox-code&state=${encodeURIComponent(state)}`).expect(302);
      expect(cb.headers.location).toContain('connected=');
      expect((await conn(id)).status).toBe('TEST_PENDING');

      // uso único do state
      const replay = await request(app.getHttpServer()).get(`/api/integrations/callback?code=sandbox-code&state=${encodeURIComponent(state)}`).expect(302);
      expect(replay.headers.location).toContain('error=');
      // state forjado
      const forged = await request(app.getHttpServer()).get('/api/integrations/callback?code=sandbox-code&state=abc.def.ghi').expect(302);
      expect(forged.headers.location).toContain('error=');

      await A.owner.post(`/api/integrations/connections/${id}/activate`).set(H).expect(409); // sem teste
      expect((await A.owner.post(`/api/integrations/connections/${id}/test`).set(H).expect(200)).body.status).toBe('CONNECTED');
      expect((await A.owner.post(`/api/integrations/connections/${id}/activate`).set(H).expect(200)).body.status).toBe('ACTIVE');

      const row = await conn(id);
      expect(row.credentialsEnc).toMatch(/^v1\.[0-9a-f]{8}\./);
      expect(row.credentialsEnc).not.toContain('sbx-');
      expect(row.webhookSecretEnc).not.toContain(created.webhook.secret);
      const dump = JSON.stringify([(await A.owner.get('/api/integrations/connections').expect(200)).body, (await A.owner.get(`/api/integrations/connections/${id}`).expect(200)).body]);
      expect(dump).not.toMatch(/credentialsEnc|webhookSecretEnc|sbx-access|sbx-refresh|oauthNonce/);
    });

    it('salvar parte da configuração não apaga o restante (regressão)', async () => {
      const { id } = await activeSandbox(A, { reconcileMinutes: 30, stockSync: true, safetyStock: 4 });
      await A.owner.put(`/api/integrations/connections/${id}/config`).set(H).send({ priceSync: true }).expect(200);
      expect((await conn(id)).config).toMatchObject({ reconcileMinutes: 30, stockSync: true, safetyStock: 4, priceSync: true });
    });

    it('sem depósito de origem a conexão fica "configuração incompleta" e não ativa', async () => {
      const { id } = await activeSandbox(A, {}, false);
      expect((await conn(id)).status).toBe('INCOMPLETE_CONFIG');
      const r = await A.owner.post(`/api/integrations/connections/${id}/activate`).set(H).expect(409);
      expect(r.body.missing).toEqual(['definir o depósito de origem']);
      await A.owner.put(`/api/integrations/connections/${id}/config`).set(H).send({ warehouseId: A.wh }).expect(200);
      expect((await conn(id)).status).toBe('CONNECTED');
      await A.owner.put(`/api/integrations/connections/${id}/config`).set(H).send({ warehouseId: B.wh }).expect(400); // depósito de outro tenant
    });

    it('pausar cancela tarefas automáticas e preserva dados; desconectar apaga credenciais, revoga e encerra tarefas', async () => {
      const { id, secret } = await activeSandbox(A);
      expect(await worker.schedule()).toBeGreaterThanOrEqual(1);
      const paused = (await A.owner.post(`/api/integrations/connections/${id}/pause`).set(H).expect(200)).body;
      expect(paused.cancelledJobs).toBeGreaterThanOrEqual(1);
      expect((await jobsOf(id)).every((j) => j.status === 'CANCELLED')).toBe(true);
      await A.owner.post(`/api/integrations/connections/${id}/pause`).set(H).expect(409);

      await A.owner.post(`/api/integrations/connections/${id}/activate`).set(H).expect(200); // retomar
      SandboxConnector.calls.length = 0;
      const d = (await A.owner.post(`/api/integrations/connections/${id}/disconnect`).set(H).expect(200)).body;
      expect(d).toMatchObject({ status: 'DISCONNECTED', revoked: 'REVOKED' });
      expect(SandboxConnector.calls).toContain('revoke');
      const row = await conn(id);
      expect(row.credentialsEnc).toBeNull();
      expect(row.tokenExpiresAt).toBeNull();
      await A.owner.post(`/api/integrations/connections/${id}/disconnect`).set(H).expect(409);
      await A.owner.post(`/api/integrations/connections/${id}/activate`).set(H).expect(409);
      await hook(A, id, secret, { id: 'x' }).expect(404);
      expect((await A.owner.get(`/api/integrations/logs?connectionId=${id}`).expect(200)).body.length).toBeGreaterThan(0); // histórico preservado
    });
  });

  describe('webhooks', () => {
    it('valida assinatura, deduplica por evento, responde rápido e processa de forma assíncrona', async () => {
      const { id, secret } = await activeSandbox(A);
      await hook(A, id, secret, { id: 'evt-1', topic: 'orders' }, 'sha256=00').expect(401);
      await hook(A, id, 'segredo-errado', { id: 'evt-1' }).expect(401);
      const r1 = await hook(A, id, secret, { id: 'evt-1', topic: 'orders' }).expect(200);
      expect(r1.body).toEqual({ received: true, duplicate: false });
      const dups = await Promise.all([1, 2, 3].map(() => hook(A, id, secret, { id: 'evt-1', topic: 'orders' })));
      expect(dups.every((d) => d.status === 200 && d.body.duplicate === true)).toBe(true);
      expect(await admin.webhookEvent.count({ where: { connectionId: id } })).toBe(1);
      expect((await jobsOf(id)).filter((j) => j.type === 'webhook.process')).toHaveLength(1);
      expect((await admin.webhookEvent.findFirstOrThrow({ where: { connectionId: id } })).status).toBe('RECEIVED');
      await drain();
      expect((await admin.webhookEvent.findFirstOrThrow({ where: { connectionId: id } })).status).toBe('PROCESSED');
      // reentrega tardia do mesmo evento não reprocessa
      await hook(A, id, secret, { id: 'evt-1', topic: 'orders' }).expect(200);
      expect(await admin.webhookEvent.count({ where: { connectionId: id } })).toBe(1);
    });

    it('sem id de evento, a deduplicação usa o hash do corpo', async () => {
      const { id, secret } = await activeSandbox(A);
      await hook(A, id, secret, { topic: 'x', n: 1 }).expect(200);
      await hook(A, id, secret, { topic: 'x', n: 1 }).expect(200);
      await hook(A, id, secret, { topic: 'x', n: 2 }).expect(200);
      expect(await admin.webhookEvent.count({ where: { connectionId: id } })).toBe(2);
    });

    it('conexão pausada guarda o evento; ao retomar ele é processado', async () => {
      const { id, secret } = await activeSandbox(A);
      await A.owner.post(`/api/integrations/connections/${id}/pause`).set(H).expect(200);
      await hook(A, id, secret, { id: 'evt-p' }).expect(200);
      expect(await jobsOf(id)).toHaveLength(0);
      await A.owner.post(`/api/integrations/connections/${id}/activate`).set(H).expect(200);
      await drain();
      expect((await admin.webhookEvent.findFirstOrThrow({ where: { connectionId: id } })).status).toBe('PROCESSED');
    });

    it('rotação do segredo invalida o anterior', async () => {
      const { id, secret } = await activeSandbox(A);
      const next = (await A.owner.post(`/api/integrations/connections/${id}/webhook-secret`).set(H).expect(200)).body.secret;
      await hook(A, id, secret, { id: 'r1' }).expect(401);
      await hook(A, id, next, { id: 'r1' }).expect(200);
    });

    it('credenciais de outro tenant não valem: segredo/ids cruzados são rejeitados', async () => {
      const a = await activeSandbox(A);
      const b = await activeSandbox(B);
      await hook(A, a.id, b.secret, { id: 'z' }).expect(401);
      await request(app.getHttpServer()).post(`/api/webhooks/${B.tenantId}/${a.id}`).set('content-type', 'application/json').set('x-dh-signature', sign('{}', a.secret)).send('{}').expect(404);
    });
  });

  describe('fila: retentativas, limites, falhas e recuperação', () => {
    it('erro temporário: backoff, nova tentativa, DLQ após o limite, reprocessamento manual e recuperação', async () => {
      const { id, secret } = await activeSandbox(A, { sandbox: { notify: 'unavailable' } });
      await hook(A, id, secret, { id: 'flaky' }).expect(200);
      await worker.runOnce();
      let [job] = (await jobsOf(id)).filter((j) => j.type === 'webhook.process');
      expect(job).toMatchObject({ status: 'QUEUED', attempts: 1 });
      expect(job.runAt.getTime()).toBeGreaterThan(Date.now() + 10_000); // backoff aplicado
      expect(job.lastError).toMatch(/UNAVAILABLE/);

      for (let i = 0; i < 4; i++) { await due(A.tenantId); await worker.runOnce(); }
      [job] = (await jobsOf(id)).filter((j) => j.type === 'webhook.process');
      expect(job).toMatchObject({ status: 'DEAD', attempts: 5 });
      expect((await admin.webhookEvent.findFirstOrThrow({ where: { connectionId: id } })).status).toBe('FAILED');
      expect((await conn(id)).status).toBe('SYNC_ERROR');
      const ov = (await A.owner.get(`/api/integrations/connections/${id}`).expect(200)).body;
      expect(ov.attention.join(' ')).toMatch(/Erro de sincronização/);
      expect(ov.jobs.DEAD).toBe(1);

      // corrige a causa e reprocessa (não duplica o evento)
      await A.owner.put(`/api/integrations/connections/${id}/config`).set(H).send({ sandbox: { notify: 'ok' } }).expect(200);
      await A.viewer.post(`/api/integrations/jobs/${job.id}/retry`).set(H).send({}).expect(403);
      await A.owner.post(`/api/integrations/jobs/${job.id}/retry`).set(H).send({}).expect(200);
      await A.owner.post(`/api/integrations/jobs/${job.id}/retry`).set(H).send({}).expect(409); // já está na fila
      await drain();
      expect((await admin.webhookEvent.findFirstOrThrow({ where: { connectionId: id } })).status).toBe('PROCESSED');
      expect(await admin.webhookEvent.count({ where: { connectionId: id } })).toBe(1);

      // reconciliação periódica restabelece a conexão (e é idempotente por janela)
      expect(await worker.schedule()).toBeGreaterThanOrEqual(1);
      expect(await worker.schedule()).toBe(0);
      await drain();
      expect((await conn(id)).status).toBe('ACTIVE');
      expect((await conn(id)).lastSyncAt).not.toBeNull();
    });

    it('erro de validação não é repetido automaticamente', async () => {
      const { id, secret } = await activeSandbox(A, { sandbox: { notify: 'error' } });
      await hook(A, id, secret, { id: 'bad' }).expect(200);
      await worker.runOnce();
      const [job] = (await jobsOf(id)).filter((j) => j.type === 'webhook.process');
      expect(job).toMatchObject({ status: 'FAILED', attempts: 1 });
    });

    it('limite de requisições: respeita o retry-after do provedor sem consumir todas as tentativas', async () => {
      const { id } = await activeSandbox(A, { sandbox: { fetchOrders: 'ratelimit' } });
      await worker.schedule();
      await drain();
      const [job] = (await jobsOf(id)).filter((j) => j.type === 'connection.reconcile');
      expect(job.status).toBe('QUEUED');
      expect(job.attempts).toBe(1);
      const wait = job.runAt.getTime() - Date.now();
      expect(wait).toBeGreaterThan(20_000);
      expect(wait).toBeLessThan(40_000);
      expect((await conn(id)).status).toBe('ACTIVE');
    });

    it('token expirado: job falha sem repetição, conexão vira TOKEN_EXPIRED e exige reconexão', async () => {
      const { id } = await activeSandbox(A, { sandbox: { fetchOrders: 'auth' } });
      await worker.schedule();
      await drain();
      const [job] = (await jobsOf(id)).filter((j) => j.type === 'connection.reconcile');
      expect(job.status).toBe('FAILED');
      expect((await conn(id)).status).toBe('TOKEN_EXPIRED');
      const ov = (await A.owner.get(`/api/integrations/connections/${id}`).expect(200)).body;
      expect(ov.attention.join(' ')).toMatch(/reconecte/i);
      const auth = (await A.owner.post(`/api/integrations/connections/${id}/authorize`).set(H).expect(200)).body; // reautorização permitida
      expect(auth.authorizationUrl).toContain('state=');
    });

    it('erro de autenticação no teste não vaza segredos e não derruba a sessão do usuário (424, nunca 401)', async () => {
      const { id } = await activeSandbox(A);
      await A.owner.put(`/api/integrations/connections/${id}/config`).set(H).send({ sandbox: { validate: 'auth' } }).expect(200);
      const r = await A.owner.post(`/api/integrations/connections/${id}/test`).set(H).expect(424);
      expect(JSON.stringify(r.body)).not.toContain('sbx-secret-123');
      expect(r.body.code).toBe('AUTH');
      const logs = JSON.stringify((await A.owner.get(`/api/integrations/logs?connectionId=${id}&level=error`).expect(200)).body);
      expect(logs).not.toContain('sbx-secret-123');
      expect(logs).toContain('[REDACTED]');
      await A.owner.get('/api/auth/me').expect(200);
    });

    it('indisponibilidade da API no teste devolve 502 compreensível', async () => {
      const { id } = await activeSandbox(A);
      await A.owner.put(`/api/integrations/connections/${id}/config`).set(H).send({ sandbox: { validate: 'unavailable' } }).expect(200);
      const r = await A.owner.post(`/api/integrations/connections/${id}/test`).set(H).expect(502);
      expect(r.body.message).toMatch(/indisponível/i);
    });

    it('renovação de token agendada antes do vencimento atualiza as credenciais cifradas', async () => {
      const { id } = await activeSandbox(A);
      const before = (await conn(id)).credentialsEnc;
      await admin.marketplaceConnection.update({ where: { id }, data: { tokenExpiresAt: new Date(Date.now() + 60_000) } });
      await worker.schedule();
      await drain();
      const after = await conn(id);
      expect(after.credentialsEnc).not.toBe(before);
      expect(after.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 30 * 60_000);
      expect((await jobsOf(id)).find((j) => j.type === 'token.refresh')?.status).toBe('SUCCEEDED');
    });

    it('job travado por worker que morreu é recuperado; mesma chave de idempotência não duplica job', async () => {
      const { id } = await activeSandbox(A);
      await admin.$executeRaw`INSERT INTO background_jobs (id, tenant_id, connection_id, type, status, attempts, locked_at, locked_by, run_at)
        VALUES (gen_random_uuid(), ${A.tenantId}::uuid, ${id}::uuid, 'connection.reconcile', 'RUNNING', 1, now() - interval '10 minutes', 'w-morto', now() - interval '1 hour')`;
      await drain();
      expect((await jobsOf(id)).find((j) => j.lockedBy === null && j.type === 'connection.reconcile')?.status).toBe('SUCCEEDED');

      const key = `idem-${run}`;
      const results = await Promise.all(Array.from({ length: 5 }, () => prisma.withContext({ tenantId: A.tenantId }, (tx) => queue.enqueue(tx, A.tenantId, { type: 'connection.reconcile', connectionId: id, idempotencyKey: key }))));
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
    });

    it('operações não idempotentes exigem confirmação explícita para reprocessar', async () => {
      const { id } = await activeSandbox(A);
      worker.register('test.unsafe', { automatic: false, safeToRetry: false, run: async () => ({ ok: false, retryable: false, message: 'falhou no canal' }) });
      const j = await prisma.withContext({ tenantId: A.tenantId }, (tx) => queue.enqueue(tx, A.tenantId, { type: 'test.unsafe', connectionId: id }));
      await worker.runOnce();
      expect((await admin.backgroundJob.findUniqueOrThrow({ where: { id: j.id } })).status).toBe('FAILED');
      const r = await A.owner.post(`/api/integrations/jobs/${j.id}/retry`).set(H).send({}).expect(409);
      expect(r.body.message).toMatch(/duplicar/);
      await A.owner.post(`/api/integrations/jobs/${j.id}/retry`).set(H).send({ confirm: true }).expect(200);
    });

    it('publicação com a mesma chave de idempotência não cria anúncio duplicado (contrato do conector)', async () => {
      const connector = (app.get(JobWorker) as any).connections.registry.get('SANDBOX') as unknown as Connector;
      const ctx = { connectionId: 'c', tenantId: 't', credentials: null, config: {}, externalAccountId: null };
      const before = SandboxConnector.creations;
      const r1 = await connector.publishProduct(ctx, { productId: 'p', payload: {}, idempotencyKey: `pub-${run}` });
      const r2 = await connector.publishProduct(ctx, { productId: 'p', payload: {}, idempotencyKey: `pub-${run}` });
      expect(r1).toEqual(r2);
      expect(SandboxConnector.creations).toBe(before + 1);
    });
  });

  describe('monitoramento, isolamento e permissões', () => {
    it('painel traz contagens reais de jobs, webhooks, logs e tempo de resposta', async () => {
      const { id, secret } = await activeSandbox(A);
      await hook(A, id, secret, { id: 'm1' }).expect(200);
      await drain();
      await worker.schedule();
      await drain();
      const ov = (await A.viewer.get(`/api/integrations/connections/${id}`).expect(200)).body;
      expect(ov.webhooks.PROCESSED).toBe(1);
      expect(ov.jobs.SUCCEEDED).toBeGreaterThanOrEqual(2);
      expect(ov.logs24h.info).toBeGreaterThanOrEqual(2);
      expect(ov.connection.lastSyncAt).not.toBeNull();
      const jobs = (await A.viewer.get(`/api/integrations/jobs?connectionId=${id}&status=SUCCEEDED`).expect(200)).body;
      expect(jobs.length).toBeGreaterThanOrEqual(2);
    });

    it('permissões: gestor operacional só consulta; operador de estoque não acessa; criar/ativar exige integrations.manage', async () => {
      await A.viewer.get('/api/integrations/connections').expect(200);
      await A.viewer.post('/api/integrations/connections').set(H).send({ provider: 'SANDBOX', label: 'nao' }).expect(403);
      await A.outsider.get('/api/integrations/connections').expect(403);
      await A.outsider.get('/api/integrations/logs').expect(403);
    });

    it('tenant B não vê nem altera conexões, jobs ou logs do tenant A', async () => {
      const { id } = await activeSandbox(A);
      await drain();
      expect(JSON.stringify((await B.owner.get('/api/integrations/connections').expect(200)).body)).not.toContain(id);
      await B.owner.get(`/api/integrations/connections/${id}`).expect(404);
      await B.owner.post(`/api/integrations/connections/${id}/pause`).set(H).expect(404);
      await B.owner.post(`/api/integrations/connections/${id}/disconnect`).set(H).expect(404);
      await B.owner.put(`/api/integrations/connections/${id}/config`).set(H).send({ stockSync: true }).expect(404);
      const [job] = await jobsOf(id);
      if (job) await B.owner.post(`/api/integrations/jobs/${job.id}/retry`).set(H).send({}).expect(404);
      expect(JSON.stringify((await B.owner.get('/api/integrations/logs').expect(200)).body)).not.toContain(id);
    });

    it('RLS: o papel de runtime não lê jobs/credenciais sem contexto e não apaga logs', async () => {
      expect(await prisma.backgroundJob.findMany()).toHaveLength(0);
      expect(await prisma.marketplaceConnection.findMany()).toHaveLength(0);
      await expect(prisma.withContext({ tenantId: A.tenantId }, (tx) => tx.integrationLog.deleteMany({}))).rejects.toThrow();
      await expect(prisma.withContext({ tenantId: A.tenantId }, (tx) => tx.integrationLog.updateMany({ data: { message: 'x' } }))).rejects.toThrow();
      const other = await prisma.withContext({ tenantId: B.tenantId }, (tx) => tx.marketplaceConnection.findMany());
      expect(other.every((c) => c.tenantId === B.tenantId)).toBe(true);
    });

    it('nenhum segredo aparece em logs de integração, auditoria ou jobs gravados', async () => {
      const dumps = JSON.stringify([
        await admin.integrationLog.findMany({ where: { tenantId: A.tenantId } }),
        await admin.auditLog.findMany({ where: { tenantId: A.tenantId } }),
        await admin.backgroundJob.findMany({ where: { tenantId: A.tenantId } }),
      ], (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
      expect(dumps).not.toMatch(/sbx-secret-123|sbx-refresh-secret|sbx-access-[a-z0-9]+/);
    });
  });
});
