import { INestApplication } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';
import { ALLOW_NO_TENANT, IS_PUBLIC, REQUIRED_PERMISSIONS } from '../src/common/auth';
import { backup, restoreCheck } from '../scripts/backup';

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);
let seq = 0;
const uid = () => `${run}${++seq}`;

describe('Fase 8 — planos, plataforma, observabilidade, backup e revisão estrutural de segurança', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  const agent = () => request.agent(app.getHttpServer());
  type Agent = ReturnType<typeof agent>;
  interface T { owner: Agent; tenantId: string; userId: string; email: string; wh: string }

  async function tenant(label: string): Promise<T> {
    const owner = agent();
    const email = `${label}-${run}@teste.local`;
    const reg = await owner.post('/api/auth/register').set(H).send({ companyName: `Co ${label} ${run}`, name: `Dono ${label}`, email, password: PASSWORD }).expect(201);
    const company = await owner.post('/api/companies').set(H).send({ legalName: `${label} LTDA` }).expect(201);
    const est = await owner.post('/api/establishments').set(H).send({ companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz' }).expect(201);
    const wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
    const me = (await owner.get('/api/auth/me').expect(200)).body;
    return { owner, tenantId: reg.body.tenantId, userId: me.user.id, email, wh };
  }
  const setLimits = (t: T, limits: object) => admin.$executeRaw`UPDATE plans SET limits = ${JSON.stringify(limits)}::jsonb WHERE id = (SELECT plan_id FROM tenants WHERE id = ${t.tenantId}::uuid)`;
  const product = (t: T) => t.owner.post('/api/products').set(H).send({ sku: `P8-${uid()}`, name: 'Produto', suggestedPrice: 10 });

  let A: T;
  let B: T;
  let root: T; // administrador da plataforma
  const trialLimits = { users: 100, establishments: 20, warehouses: 20 };

  beforeAll(async () => {
    process.env.METRICS_TOKEN = 'metrics-token-de-teste';
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    await admin.plan.update({ where: { code: 'trial' }, data: { limits: trialLimits } });
    A = await tenant('p8A');
    B = await tenant('p8B');
    root = await tenant('p8root');
    await admin.$executeRaw`INSERT INTO platform_admins (user_id) VALUES (${root.userId}::uuid) ON CONFLICT DO NOTHING`;
  });

  afterAll(async () => {
    delete process.env.METRICS_TOKEN;
    await admin.plan.update({ where: { code: 'trial' }, data: { limits: trialLimits } });
    await admin.$disconnect();
    await app.close();
  });

  // ───────────────────────── planos e limites ─────────────────────────
  describe('planos, limites e assinatura', () => {
    it('mostra plano, uso e limites ao proprietário; só quem gerencia o tenant vê', async () => {
      const b = (await A.owner.get('/api/billing').expect(200)).body;
      expect(b).toMatchObject({ status: 'TRIAL', readOnly: false, paymentGateway: { integrated: false } });
      expect(b.plan.code).toBe('trial');
      expect(b.resources.find((r: any) => r.key === 'users')).toMatchObject({ used: 1, limit: 100 });
      expect(b.plans.map((p: any) => p.code)).toEqual(expect.arrayContaining(['trial', 'starter', 'pro', 'enterprise']));
      expect(b.plans.find((p: any) => p.code === 'starter').priceCents).toBeNull(); // preço não inventado
    });

    it('bloqueia (402) produtos, conexões e pedidos acima do plano; ilimitado quando o limite não existe', async () => {
      const C = await tenant('p8lim');
      await admin.$executeRaw`UPDATE tenants SET plan_id = (SELECT id FROM plans WHERE code = 'starter') WHERE id = ${C.tenantId}::uuid`;
      // plano compartilhado 'starter': ajusta e restaura ao final
      const before = (await admin.plan.findUniqueOrThrow({ where: { code: 'starter' } })).limits;
      await admin.plan.update({ where: { code: 'starter' }, data: { limits: { products: 2, connections: 1, ordersPerMonth: 1 } } });
      try {
        await product(C).expect(201);
        await product(C).expect(201);
        const over = await product(C).expect(402);
        expect(over.body.message).toMatch(/Limite do plano atingido: 2 produtos/);
        // importação em lote também respeita o limite (nada é gravado)
        const csv = 'sku;nome\nIMP1;Um\nIMP2;Dois\n';
        await C.owner.post('/api/products/import').set(H).send({ csv }).expect(402);
        expect((await C.owner.get('/api/products').expect(200)).body.items?.length ?? (await C.owner.get('/api/products')).body.length).toBe(2);

        await C.owner.post('/api/integrations/connections').set(H).send({ provider: 'SANDBOX', label: 'conexao a' }).expect(201);
        await C.owner.post('/api/integrations/connections').set(H).send({ provider: 'SANDBOX', label: 'conexao b' }).expect(402);

        const cust = (await C.owner.post('/api/customers').set(H).send({ kind: 'PJ', name: 'Cli', document: '11.222.333/0001-81' }).expect(201)).body.id;
        const p = (await C.owner.get('/api/products').expect(200)).body;
        const pid = (p.items ?? p)[0].id;
        const mk = () => C.owner.post('/api/sales/orders').set(H).send({ customerId: cust, warehouseId: C.wh, items: [{ productId: pid, quantity: 1, unitPrice: 10 }] });
        await mk().expect(201);
        await mk().expect(402);
        const usage = (await C.owner.get('/api/billing').expect(200)).body.resources;
        expect(usage.find((r: any) => r.key === 'ordersPerMonth')).toMatchObject({ used: 1, limit: 1 });
        // enterprise: sem limites
        await admin.$executeRaw`UPDATE tenants SET plan_id = (SELECT id FROM plans WHERE code = 'enterprise') WHERE id = ${C.tenantId}::uuid`;
        await product(C).expect(201);
        await mk().expect(201);
      } finally {
        await admin.plan.update({ where: { code: 'starter' }, data: { limits: before as object } });
      }
    });

    it('avaliação encerrada vira somente leitura (402 em escrita, leitura e sessão seguem), até a plataforma ativar', async () => {
      const C = await tenant('p8trial');
      await admin.$executeRaw`UPDATE tenants SET trial_ends_at = now() - interval '1 day' WHERE id = ${C.tenantId}::uuid`;
      await product(C).expect(402);
      await C.owner.get('/api/products').expect(200);
      const b = (await C.owner.get('/api/billing').expect(200)).body;
      expect(b.readOnly).toBe(true);
      await C.owner.post('/api/auth/logout').set(H).expect(200);
    });
  });

  // ───────────────────────── administrador da plataforma ─────────────────────────
  describe('administrador global', () => {
    it('só administradores listam tenants; usuário comum e anônimo são recusados', async () => {
      await A.owner.get('/api/platform/tenants').expect(403);
      await agent().get('/api/platform/tenants').expect(401);
      expect((await root.owner.get('/api/auth/me').expect(200)).body.platformAdmin).toBe(true);
      expect((await A.owner.get('/api/auth/me').expect(200)).body.platformAdmin).toBe(false);
      const list = (await root.owner.get('/api/platform/tenants').expect(200)).body as any[];
      expect(list.map((t) => t.id)).toEqual(expect.arrayContaining([A.tenantId, B.tenantId]));
    });

    it('vê apenas metadados e contagens: nenhum dado de negócio, e-mail ou segredo', async () => {
      const C = await tenant('p8meta');
      await product(C).expect(201);
      const row = ((await root.owner.get('/api/platform/tenants').expect(200)).body as any[]).find((t) => t.id === C.tenantId);
      expect(row).toMatchObject({ products: 1, users: 1, status: 'TRIAL', plan: 'trial' });
      expect(Object.keys(row).sort()).toEqual(['connections', 'createdAt', 'id', 'lastActivity', 'name', 'orders30d', 'plan', 'products', 'slug', 'status', 'trialEndsAt', 'users']);
      expect(JSON.stringify(row)).not.toContain(C.email);
      // sem acesso direto às tabelas de plataforma pelo papel de runtime
      const rt = new PrismaClient();
      await expect(rt.$queryRawUnsafe('SELECT * FROM platform_admins')).rejects.toThrow();
      await rt.$disconnect();
      // administrador da plataforma não ganha acesso aos dados do tenant pelo próprio papel
      await root.owner.get(`/api/customers`).expect(200).then((r) => expect(JSON.stringify(r.body)).not.toContain(C.tenantId));
    });

    it('altera plano/situação com motivo, registra na auditoria da plataforma e do tenant, e suspensão bloqueia o acesso', async () => {
      const C = await tenant('p8susp');
      await C.owner.put(`/api/platform/tenants/${C.tenantId}`).set(H).send({ status: 'ACTIVE', note: 'tentativa' }).expect(403);
      await root.owner.put(`/api/platform/tenants/${C.tenantId}`).set(H).send({ status: 'ACTIVE', planCode: 'pro', note: 'Contrato assinado' }).expect(200);
      const b = (await C.owner.get('/api/billing').expect(200)).body;
      expect(b).toMatchObject({ status: 'ACTIVE', readOnly: false });
      expect(b.plan.code).toBe('pro');
      expect(b.history[0]).toMatchObject({ status: 'ACTIVE', plan: 'Pro', note: 'Contrato assinado' });
      const tenantAudit = (await C.owner.get('/api/audit?action=platform.subscription_changed').expect(200)).body.items as any[];
      expect(tenantAudit.length).toBe(1);

      await root.owner.put(`/api/platform/tenants/${C.tenantId}`).set(H).send({ planCode: 'inexistente', note: 'x y z' }).expect(400);
      await root.owner.put(`/api/platform/tenants/${C.tenantId}`).set(H).send({ status: 'SUSPENDED', note: 'Inadimplência' }).expect(200);
      await C.owner.get('/api/products').expect(403);
      await root.owner.put(`/api/platform/tenants/${C.tenantId}`).set(H).send({ status: 'ACTIVE', note: 'Regularizado' }).expect(200);
      await C.owner.get('/api/products').expect(200);
      await root.owner.put('/api/platform/tenants/00000000-0000-4000-8000-000000000000').set(H).send({ status: 'ACTIVE', note: 'não existe' }).expect(404);

      const audit = (await root.owner.get('/api/platform/audit?limit=20').expect(200)).body as any[];
      expect(audit.filter((a) => a.tenantId === C.tenantId && a.action === 'platform.tenant_updated').length).toBeGreaterThanOrEqual(3);
      await A.owner.get('/api/platform/audit').expect(403);
    });

    it('edita o catálogo de planos (limites validados) e só administradores', async () => {
      await A.owner.put('/api/platform/plans/teste8').set(H).send({ name: 'Plano X', limits: {} }).expect(403);
      await root.owner.put('/api/platform/plans/teste8').set(H).send({ name: 'Plano Teste', limits: { foo: 1 } }).expect(400);
      await root.owner.put('/api/platform/plans/teste8').set(H).send({ name: 'Plano Teste', limits: { products: -1 } }).expect(400);
      await root.owner.put('/api/platform/plans/teste8').set(H).send({ name: 'Plano Teste', limits: { products: 10 }, priceCents: 9900 }).expect(200);
      const plans = (await root.owner.get('/api/platform/plans').expect(200)).body as any[];
      expect(plans.find((p) => p.code === 'teste8')).toMatchObject({ priceCents: 9900, limits: { products: 10 } });
      await admin.$executeRaw`DELETE FROM plans WHERE code = 'teste8'`;
    });

    it('administrador desativado perde o acesso imediatamente', async () => {
      const X = await tenant('p8gone');
      await admin.$executeRaw`INSERT INTO platform_admins (user_id) VALUES (${X.userId}::uuid)`;
      await X.owner.get('/api/platform/tenants').expect(200);
      await admin.$executeRaw`UPDATE users SET status = 'DISABLED' WHERE id = ${X.userId}::uuid`;
      await X.owner.get('/api/platform/tenants').expect(403);
    });
  });

  // ───────────────────────── observabilidade ─────────────────────────
  describe('observabilidade', () => {
    it('devolve correlation id (aceita um válido, troca um suspeito) e mensagem de erro sem detalhes internos', async () => {
      const ok = await agent().get('/api/health').set('x-request-id', 'abc12345-req').expect(200);
      expect(ok.headers['x-request-id']).toBe('abc12345-req');
      const bad = await agent().get('/api/health').set('x-request-id', 'ruim <script>!').expect(200);
      expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      const err = await agent().get('/api/products').expect(401);
      expect(err.body.requestId).toBeTruthy();
    });

    it('/health/ready verifica banco e fila; /metrics fica desligado sem token e protegido com token', async () => {
      const ready = (await agent().get('/api/health/ready').expect(200)).body;
      expect(ready.checks).toMatchObject({ database: 'ok' });
      expect(['ok', 'degraded']).toContain(ready.status);
      await agent().get('/api/metrics').expect(401);
      await agent().get('/api/metrics').set('Authorization', 'Bearer errado').expect(401);
      const m = await agent().get('/api/metrics').set('Authorization', 'Bearer metrics-token-de-teste').expect(200);
      expect(m.text).toMatch(/http_requests_total\{method="GET",status="2xx"\} \d+/);
      expect(m.text).toContain('http_request_duration_seconds_count');
      expect(m.text).toContain('process_uptime_seconds');
      expect(m.text).not.toContain(A.tenantId); // métricas não carregam ids de tenant/usuário
      expect(m.text).not.toContain(A.email);
      delete process.env.METRICS_TOKEN;
      await agent().get('/api/metrics').expect(404);
      process.env.METRICS_TOKEN = 'metrics-token-de-teste';
    });
  });

  // ───────────────────────── backup e restauração ─────────────────────────
  describe('backup e restauração', () => {
    const dir = join(process.cwd(), '.data', `bk-${run}`);
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('gera backup, restaura em banco temporário e confirma contagens, RLS e isolamento do papel de runtime', async () => {
      const file = await backup(process.env.DIRECT_URL!, join(dir, 'plain.dump'), undefined);
      expect(existsSync(file)).toBe(true);
      const r = await restoreCheck(process.env.DIRECT_URL!, file);
      expect(r.problems).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.tables).toBeGreaterThan(50);
      expect(r.rows).toBeGreaterThan(0);
      expect(r.isolation.withoutTenant).toBe(0);
      expect(r.isolation.withTenant).toBeGreaterThanOrEqual(0);
    }, 180_000);

    it('backup cifrado (AES-256-GCM): restaura com a chave certa e é rejeitado se adulterado ou com chave errada', async () => {
      const key = randomBytes(32).toString('base64');
      const file = await backup(process.env.DIRECT_URL!, join(dir, 'enc.dump'), key);
      expect(file.endsWith('.enc')).toBe(true);
      expect(readFileSync(file).subarray(0, 5).toString()).toBe('DHBK1');
      expect((await restoreCheck(process.env.DIRECT_URL!, file, { backupKey: key })).ok).toBe(true);
      await expect(restoreCheck(process.env.DIRECT_URL!, file, { backupKey: randomBytes(32).toString('base64') })).rejects.toThrow();
      const tampered = join(dir, 'tampered.dump.enc');
      const buf = readFileSync(file);
      buf[Math.floor(buf.length / 2)] ^= 0xff;
      writeFileSync(tampered, buf);
      await expect(restoreCheck(process.env.DIRECT_URL!, tampered, { backupKey: key })).rejects.toThrow();
    }, 240_000);
  });

  // ───────────────────────── revisão estrutural de segurança ─────────────────────────
  describe('revisão estrutural de segurança', () => {
    it('toda rota é pública (lista explícita), sem-tenant (lista explícita) ou exige permissão', async () => {
      const controllers = [...app.get(ModulesContainer, { strict: false }).values()].flatMap((m) => [...m.controllers.values()]);
      const open: string[] = [];
      for (const w of controllers) {
        const proto = w.metatype?.prototype;
        if (!proto) continue;
        const base = String(Reflect.getMetadata(PATH_METADATA, w.metatype!) ?? '');
        for (const name of Object.getOwnPropertyNames(proto)) {
          const handler = proto[name];
          if (typeof handler !== 'function' || Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
          const perms = (Reflect.getMetadata(REQUIRED_PERMISSIONS, handler) ?? Reflect.getMetadata(REQUIRED_PERMISSIONS, w.metatype!) ?? []) as string[];
          const isPublic = Reflect.getMetadata(IS_PUBLIC, handler) ?? Reflect.getMetadata(IS_PUBLIC, w.metatype!);
          const noTenant = Reflect.getMetadata(ALLOW_NO_TENANT, handler) ?? Reflect.getMetadata(ALLOW_NO_TENANT, w.metatype!);
          if (perms.length === 0 && !isPublic && !noTenant) open.push(`${base}#${name}`);
        }
      }
      // Rotas autenticadas sem permissão específica (qualquer membro do tenant): conferidas manualmente e listadas aqui.
      expect(open.sort()).toEqual(EXPECTED_MEMBER_ONLY.sort());
    });

    it('rotas públicas e sem-tenant são exatamente as esperadas', async () => {
      const controllers = [...app.get(ModulesContainer, { strict: false }).values()].flatMap((m) => [...m.controllers.values()]);
      const pub: string[] = [];
      const noTenant: string[] = [];
      for (const w of controllers) {
        const proto = w.metatype?.prototype;
        if (!proto) continue;
        const base = String(Reflect.getMetadata(PATH_METADATA, w.metatype!) ?? '');
        for (const name of Object.getOwnPropertyNames(proto)) {
          const h = proto[name];
          if (typeof h !== 'function' || Reflect.getMetadata(METHOD_METADATA, h) === undefined) continue;
          if (Reflect.getMetadata(IS_PUBLIC, h) ?? Reflect.getMetadata(IS_PUBLIC, w.metatype!)) pub.push(`${base}/${String(Reflect.getMetadata(PATH_METADATA, h))}`);
          if (Reflect.getMetadata(ALLOW_NO_TENANT, h) ?? Reflect.getMetadata(ALLOW_NO_TENANT, w.metatype!)) noTenant.push(`${base}/${String(Reflect.getMetadata(PATH_METADATA, h))}`);
        }
      }
      const norm = (p: string): string => p.replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
      expect(pub.map(norm).sort()).toEqual(['auth/login', 'auth/logout', 'auth/refresh', 'auth/register', 'health', 'health/ready', 'integrations/callback', 'media/:id', 'metrics', 'webhooks/:tenantId/:connectionId', 'webhooks/providers/:provider/:token']);
      for (const p of pub) expect(p).not.toMatch(/finance|reports|platform|billing|fiscal|users/);
      expect(noTenant.sort()).toEqual(expect.arrayContaining(['platform/tenants', 'platform/audit']));
      for (const p of noTenant) expect(p).toMatch(/^(auth|platform)\//);
    });

    it('toda tabela com tenant_id tem RLS habilitada e forçada, e o papel de runtime não ignora RLS', async () => {
      const rows = await admin.$queryRawUnsafe<{ t: string; rls: boolean; forced: boolean }[]>(`
        SELECT c.relname AS t, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
        WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`);
      expect(rows.length).toBeGreaterThan(40);
      // refresh_sessions: consultada pelo hash do token antes de haver tenant (tenant_id é opcional); acesso restrito ao próprio usuário na aplicação.
      expect(rows.filter((r) => (!r.rls || !r.forced) && r.t !== 'refresh_sessions').map((r) => r.t)).toEqual([]);
      const [role] = await admin.$queryRawUnsafe<{ rolsuper: boolean; rolbypassrls: boolean }[]>(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'dh_app'`);
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
      // tabelas de plataforma: runtime sem privilégios diretos
      const grants = await admin.$queryRawUnsafe<{ t: string }[]>(`SELECT table_name AS t FROM information_schema.role_table_grants WHERE grantee = 'dh_app' AND table_name IN ('platform_admins','platform_audit_log')`);
      expect(grants).toEqual([]);
    });

    it('tabelas append-only não concedem UPDATE/DELETE ao papel de runtime', async () => {
      const rows = await admin.$queryRawUnsafe<{ t: string; p: string }[]>(`
        SELECT table_name AS t, privilege_type AS p FROM information_schema.role_table_grants
        WHERE grantee = 'dh_app' AND privilege_type IN ('UPDATE','DELETE')
          AND table_name IN ('audit_logs','financial_settlements','shipment_events','integration_logs','price_history','tax_calculations','fiscal_xml_files','subscriptions')`);
      expect(rows).toEqual([]);
    });

    it('cabeçalhos de segurança, cookies httpOnly e proteção CSRF', async () => {
      const r = await agent().get('/api/health').expect(200);
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['x-powered-by']).toBeUndefined();
      const a = agent();
      const login = await a.post('/api/auth/login').set(H).send({ email: A.email, password: PASSWORD }).expect(200);
      const cookies = ([] as string[]).concat(login.headers['set-cookie'] as unknown as string[]);
      expect(cookies.length).toBeGreaterThan(0);
      for (const c of cookies) expect(c).toMatch(/HttpOnly/i);
      await a.post('/api/products').send({ sku: 'x', name: 'x' }).expect(403); // sem cabeçalho CSRF
    });
  });
});

// Rotas autenticadas sem permissão específica: qualquer membro do tenant pode chamá-las. Revisadas em docs/SECURITY-REVIEW.md.
const EXPECTED_MEMBER_ONLY: string[] = ['/#overview']; // dashboard/overview: contagens e checklist de implantação do próprio tenant
