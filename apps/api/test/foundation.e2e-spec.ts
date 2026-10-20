import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);

describe('Fundação — autenticação, tenants, RBAC e RLS', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: PrismaClient; // conexão do dono do schema, só para inspeção
  const http = () => request(app.getHttpServer());

  // Agente com cookies persistentes
  const agent = () => request.agent(app.getHttpServer());

  async function register(label: string) {
    const a = agent();
    const email = `${label}-${run}@teste.local`.toLowerCase();
    const res = await a
      .post('/api/auth/register')
      .set(H)
      .send({ companyName: `Empresa ${label} ${run}`, name: `Dono ${label}`, email, password: PASSWORD })
      .expect(201);
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const refreshToken = cookies.find((c) => c.startsWith('dh_rt='))?.split(';')[0].slice('dh_rt='.length) ?? '';
    return { a, email, tenantId: res.body.tenantId as string, refreshToken };
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  describe('autenticação', () => {
    it('rejeita acesso sem sessão', async () => {
      await http().get('/api/structure').expect(401);
    });

    it('registra, mantém sessão por cookie httpOnly e devolve /me com permissões', async () => {
      const t = await register('auth');
      const me = await t.a.get('/api/auth/me').expect(200);
      expect(me.body.user.email).toBe(t.email);
      expect(me.body.role.key).toBe('owner');
      expect(me.body.permissions).toContain('users.manage');
      expect(JSON.stringify(me.body)).not.toMatch(/passwordHash|scrypt/);
    });

    it('exige cabeçalho CSRF em requisições mutáveis por cookie', async () => {
      const t = await register('csrf');
      await t.a.post('/api/companies').send({ legalName: 'Sem CSRF LTDA' }).expect(403);
    });

    it('rejeita login com senha errada e bloqueia após tentativas repetidas', async () => {
      const t = await register('lock');
      for (let i = 0; i < 5; i++) {
        await http().post('/api/auth/login').set(H).send({ email: t.email, password: 'errada-12345' }).expect(401);
      }
      await http().post('/api/auth/login').set(H).send({ email: t.email, password: PASSWORD }).expect(429);
    });

    it('rotaciona refresh token e detecta reutilização', async () => {
      const t = await register('refresh');
      const token = t.refreshToken;
      expect(token).not.toBe('');
      await http().post('/api/auth/refresh').set('Cookie', `dh_rt=${token}`).expect(200);
      // reutilizar o token antigo revoga toda a família
      await http().post('/api/auth/refresh').set('Cookie', `dh_rt=${token}`).expect(401);
    });

    it('logout revoga o refresh', async () => {
      const t = await register('logout');
      const res = await t.a.post('/api/auth/logout').set(H).expect(200);
      expect(([] as string[]).concat(res.headers['set-cookie']).join(';')).toMatch(/dh_at=;/);
    });
  });

  describe('isolamento entre tenants', () => {
    let A: Awaited<ReturnType<typeof register>>;
    let B: Awaited<ReturnType<typeof register>>;
    let warehouseA: string;
    let companyA: string;

    beforeAll(async () => {
      A = await register('tenantA');
      B = await register('tenantB');
      const c = await A.a.post('/api/companies').set(H).send({ legalName: 'Alfa LTDA', cnpj: '11.222.333/0001-81' }).expect(201);
      companyA = c.body.id;
      const e = await A.a
        .post('/api/establishments')
        .set(H)
        .send({ companyId: companyA, kind: 'MATRIZ', name: 'Matriz A', state: 'sp' })
        .expect(201);
      const w = await A.a.post('/api/warehouses').set(H).send({ establishmentId: e.body.id, code: 'cd01', name: 'Depósito A' }).expect(201);
      warehouseA = w.body.id;
      expect(w.body.code).toBe('CD01');
    });

    it('cada tenant enxerga apenas os próprios dados', async () => {
      const a = await A.a.get('/api/structure').expect(200);
      expect(a.body.map((c: any) => c.legalName)).toContain('Alfa LTDA');
      const b = await B.a.get('/api/structure').expect(200);
      expect(JSON.stringify(b.body)).not.toContain('Alfa');
      expect(JSON.stringify(b.body)).not.toContain(warehouseA);
    });

    it('B não consegue alterar nem referenciar registros de A (404 no backend)', async () => {
      await B.a.patch(`/api/warehouses/${warehouseA}`).set(H).send({ name: 'Invadido' }).expect(404);
      await B.a.patch(`/api/companies/${companyA}`).set(H).send({ legalName: 'Invadida' }).expect(404);
      await B.a.post('/api/warehouses').set(H).send({ establishmentId: companyA, code: 'X1', name: 'xx' }).expect(404);
      const check = await admin.warehouse.findUnique({ where: { id: warehouseA } });
      expect(check?.name).toBe('Depósito A');
    });

    it('B não consegue listar usuários nem auditoria de A', async () => {
      const users = await B.a.get('/api/users').expect(200);
      expect(JSON.stringify(users.body)).not.toContain(A.email);
      const audit = await B.a.get('/api/audit').expect(200);
      expect(JSON.stringify(audit.body)).not.toContain('Alfa');
    });

    it('troca de tenant forjada é recusada: usuário B não seleciona tenant A', async () => {
      await B.a.post('/api/auth/select-tenant').set(H).send({ tenantId: A.tenantId }).expect(403);
    });

    it('token com tid de outro tenant é recusado (membership relida do banco)', async () => {
      const { JwtService } = await import('@nestjs/jwt');
      const jwt = app.get(JwtService);
      const userB = await admin.user.findUniqueOrThrow({ where: { email: B.email } });
      const forged = await jwt.signAsync({ sub: userB.id, tid: A.tenantId }, { expiresIn: 60 });
      await http().get('/api/structure').set('Authorization', `Bearer ${forged}`).expect(403);
    });

    it('RLS no banco: contexto do tenant B não lê nem grava linhas do tenant A', async () => {
      const rows = await prisma.withContext({ tenantId: B.tenantId }, (tx) => tx.warehouse.findMany());
      expect(rows.find((w) => w.id === warehouseA)).toBeUndefined();

      const none = await prisma.warehouse.findMany(); // sem contexto: falha segura
      expect(none).toHaveLength(0);

      const est = await admin.establishment.findFirstOrThrow({ where: { tenantId: A.tenantId } });
      await expect(
        prisma.withContext({ tenantId: B.tenantId }, (tx) =>
          tx.warehouse.create({ data: { tenantId: A.tenantId, establishmentId: est.id, code: 'HACK', name: 'hack' } }),
        ),
      ).rejects.toThrow();
    });

    it('FK composta impede vincular depósito do tenant B a estabelecimento do tenant A', async () => {
      const est = await admin.establishment.findFirstOrThrow({ where: { tenantId: A.tenantId } });
      await expect(
        admin.warehouse.create({ data: { tenantId: B.tenantId, establishmentId: est.id, code: 'CROSS', name: 'cross' } }),
      ).rejects.toThrow();
    });

    it('auditoria é append-only para o papel de runtime', async () => {
      await expect(
        prisma.withContext({ tenantId: A.tenantId }, (tx) => tx.auditLog.deleteMany({})),
      ).rejects.toThrow();
      await expect(
        prisma.withContext({ tenantId: A.tenantId }, (tx) => tx.auditLog.updateMany({ data: { action: 'x' } })),
      ).rejects.toThrow();
    });
  });

  describe('RBAC e regras de negócio', () => {
    let T: Awaited<ReturnType<typeof register>>;
    let salesRoleId: string;
    let ownerRoleId: string;
    const vendedor = `vendedor-${run}@teste.local`;

    beforeAll(async () => {
      T = await register('rbac');
      const roles = await T.a.get('/api/roles').expect(200);
      salesRoleId = roles.body.find((r: any) => r.key === 'salesperson').id;
      ownerRoleId = roles.body.find((r: any) => r.key === 'owner').id;
      await T.a.post('/api/users').set(H).send({ name: 'Vera', email: vendedor, password: PASSWORD, roleId: salesRoleId }).expect(201);
    });

    it('vendedor consulta mas não cria depósitos nem usuários (403 no backend)', async () => {
      const v = agent();
      await v.post('/api/auth/login').set(H).send({ email: vendedor, password: PASSWORD }).expect(200);
      await v.get('/api/structure').expect(200);
      await v.post('/api/warehouses').set(H).send({ establishmentId: '00000000-0000-4000-8000-000000000000', code: 'ZZ', name: 'zz' }).expect(403);
      await v.get('/api/users').expect(403);
      await v.get('/api/audit').expect(403);
    });

    it('impede conceder papel com mais permissões que o ator (anti-escalação)', async () => {
      const v = agent();
      await v.post('/api/auth/login').set(H).send({ email: vendedor, password: PASSWORD }).expect(200);
      // vendedor nem tem users.manage; o próprio proprietário pode, mas o admin não pode atribuir 'owner'
      const roles = await T.a.get('/api/roles').expect(200);
      const adminRole = roles.body.find((r: any) => r.key === 'admin').id;
      await T.a.post('/api/users').set(H).send({ name: 'Adm', email: `adm-${run}@teste.local`, password: PASSWORD, roleId: adminRole }).expect(201);
      const a = agent();
      await a.post('/api/auth/login').set(H).send({ email: `adm-${run}@teste.local`, password: PASSWORD }).expect(200);
      await a.post('/api/users').set(H).send({ name: 'Xx', email: `x-${run}@teste.local`, password: PASSWORD, roleId: ownerRoleId }).expect(403);
    });

    it('não permite remover o último proprietário', async () => {
      const members = await T.a.get('/api/users').expect(200);
      const owner = members.body.find((m: any) => m.role.key === 'owner');
      await T.a.patch(`/api/users/${owner.id}`).set(H).send({ status: 'SUSPENDED' }).expect(400);
    });

    it('papéis personalizados e validação de CNPJ', async () => {
      await T.a.post('/api/roles').set(H).send({ name: 'Conferente', permissions: ['warehouse.view', 'inexistente'] }).expect(400);
      await T.a.post('/api/roles').set(H).send({ name: 'Conferente', permissions: ['warehouse.view'] }).expect(201);
      await T.a.post('/api/companies').set(H).send({ legalName: 'Inválida LTDA', cnpj: '11.222.333/0001-82' }).expect(400);
    });

    it('recusa campos desconhecidos (whitelist) e CNPJ duplicado no mesmo tenant', async () => {
      await T.a.post('/api/companies').set(H).send({ legalName: 'Com Extra', tenantId: 'x' }).expect(400);
      await T.a.post('/api/companies').set(H).send({ legalName: 'Uma LTDA', cnpj: '11.222.333/0001-81' }).expect(201);
      await T.a.post('/api/companies').set(H).send({ legalName: 'Duas LTDA', cnpj: '11222333000181' }).expect(409);
    });

    it('registra auditoria sem vazar segredos', async () => {
      const audit = await T.a.get('/api/audit').expect(200);
      const actions = audit.body.items.map((i: any) => i.action);
      expect(actions).toEqual(expect.arrayContaining(['tenant.created', 'user.added', 'company.created']));
      expect(JSON.stringify(audit.body)).not.toMatch(new RegExp(PASSWORD));
    });

    it('visão geral usa dados reais do banco', async () => {
      const o = await T.a.get('/api/dashboard/overview').expect(200);
      expect(o.body.counts.users).toBeGreaterThanOrEqual(3);
      expect(o.body.counts.companies).toBeGreaterThanOrEqual(1);
    });
  });
});
