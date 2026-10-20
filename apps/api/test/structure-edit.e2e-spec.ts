import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);
let seq = 0;
const uid = () => `${run}${++seq}`;

describe('Empresa, estabelecimentos e depósitos — editar e excluir', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  const agent = () => request.agent(app.getHttpServer());
  type Agent = ReturnType<typeof agent>;
  interface T { owner: Agent; tenantId: string; roles: Record<string, string> }

  async function tenant(label: string): Promise<T> {
    const owner = agent();
    const reg = await owner.post('/api/auth/register').set(H).send({ companyName: `Co ${label} ${run}`, name: `Dono ${label}`, email: `${label}-${run}@teste.local`, password: PASSWORD }).expect(201);
    const roles = Object.fromEntries((await owner.get('/api/roles').expect(200)).body.map((r: any) => [r.key, r.id]));
    return { owner, tenantId: reg.body.tenantId, roles };
  }
  const company = async (t: T, extra: object = {}) => (await t.owner.post('/api/companies').set(H).send({ legalName: `Empresa ${uid()}`, ...extra }).expect(201)).body.id as string;
  const est = async (t: T, companyId: string, extra: object = {}) => (await t.owner.post('/api/establishments').set(H).send({ companyId, kind: 'MATRIZ', name: `Est ${uid()}`, ...extra }).expect(201)).body.id as string;
  const wh = async (t: T, establishmentId: string, extra: object = {}) => (await t.owner.post('/api/warehouses').set(H).send({ establishmentId, code: `W${uid()}`.slice(0, 18), name: 'Depósito', ...extra }).expect(201)).body.id as string;
  const structure = async (t: T) => (await t.owner.get('/api/structure').expect(200)).body as any[];

  let A: T;
  let B: T;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    await admin.plan.update({ where: { code: 'trial' }, data: { limits: { users: 100, establishments: 50, warehouses: 50 } } });
    A = await tenant('stA');
    B = await tenant('stB');
  });
  afterAll(async () => { await admin.$disconnect(); await app.close(); });

  describe('editar', () => {
    it('edita empresa, estabelecimento e depósito, inclusive limpando campos opcionais', async () => {
      const c = await company(A, { tradeName: 'Fantasia', contactPhone: '(11) 3333-4444', responsible: 'Ana' });
      await A.owner.patch(`/api/companies/${c}`).set(H).send({ legalName: 'Empresa Renomeada', tradeName: null, contactPhone: null, taxRegime: 'LUCRO_PRESUMIDO' }).expect(200);
      let row = (await structure(A)).find((x) => x.id === c);
      expect(row).toMatchObject({ legalName: 'Empresa Renomeada', tradeName: null, contactPhone: null, taxRegime: 'LUCRO_PRESUMIDO', responsible: 'Ana' });

      const e = await est(A, c, { city: 'Campinas', state: 'SP', complement: 'Sala 1' });
      await A.owner.patch(`/api/establishments/${e}`).set(H).send({ name: 'Filial Nova', city: 'Santos', complement: null, zipCode: '11010-000', cnae: '4744-0/99' }).expect(200);
      const w = await wh(A, e);
      await A.owner.patch(`/api/warehouses/${w}`).set(H).send({ name: 'Depósito Central', kind: 'TERCEIROS' }).expect(200);
      row = (await structure(A)).find((x) => x.id === c);
      const er = row.establishments[0];
      expect(er).toMatchObject({ name: 'Filial Nova', city: 'Santos', complement: null, zipCode: '11010000', state: 'SP' });
      expect(er.warehouses[0]).toMatchObject({ name: 'Depósito Central', kind: 'TERCEIROS' });
    });

    it('CNPJ duplicado é recusado; CNPJ pode ser removido; permissão e tenant são respeitados', async () => {
      const c1 = await company(A, { cnpj: '11.222.333/0001-81' });
      const c2 = await company(A);
      await A.owner.patch(`/api/companies/${c2}`).set(H).send({ cnpj: '11222333000181' }).expect(409);
      await A.owner.patch(`/api/companies/${c1}`).set(H).send({ cnpj: null }).expect(200);
      expect((await structure(A)).find((x) => x.id === c1).cnpj).toBeNull();
      await B.owner.patch(`/api/companies/${c2}`).set(H).send({ legalName: 'Invadida' }).expect(404);
      await B.owner.delete(`/api/companies/${c2}`).set(H).expect(404);
    });

    it('estabelecimento com documentos fiscais não troca CNPJ/UF/IE, mas edita o restante', async () => {
      const c = await company(A);
      const e = await est(A, c, { cnpj: '45.723.174/0001-10', state: 'SP', stateRegistration: '111222333444' });
      await admin.$executeRaw`INSERT INTO fiscal_series (tenant_id, establishment_id, model, series, environment, last) VALUES (${A.tenantId}::uuid, ${e}::uuid, '55', 1, 'HOMOLOGACAO', 1)`;
      await A.owner.patch(`/api/establishments/${e}`).set(H).send({ state: 'RJ' }).expect(409);
      await A.owner.patch(`/api/establishments/${e}`).set(H).send({ stateRegistration: '999' }).expect(409);
      await A.owner.patch(`/api/establishments/${e}`).set(H).send({ cnpj: '11222333000181' }).expect(409);
      await A.owner.patch(`/api/establishments/${e}`).set(H).send({ state: 'SP', name: 'Nome novo', city: 'Campinas' }).expect(200); // mesmos valores fiscais: permitido
    });

    it('vendedor (sem permissão de empresa) não edita nem exclui', async () => {
      const c = await company(A);
      const email = `sp-${uid()}@teste.local`;
      await A.owner.post('/api/users').set(H).send({ name: 'Vendedor', email, password: PASSWORD, roleId: A.roles.salesperson }).expect(201);
      const s = agent();
      await s.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200);
      await s.patch(`/api/companies/${c}`).set(H).send({ legalName: 'X Y' }).expect(403);
      await s.delete(`/api/companies/${c}`).set(H).expect(403);
    });
  });

  describe('excluir', () => {
    it('exclui o que não tem uso, na ordem certa (depósito → estabelecimento → empresa), com auditoria', async () => {
      const c = await company(A);
      const e = await est(A, c);
      const w = await wh(A, e);
      await A.owner.delete(`/api/companies/${c}`).set(H).expect(409); // tem estabelecimento
      await A.owner.delete(`/api/establishments/${e}`).set(H).expect(409); // tem depósito
      await A.owner.delete(`/api/warehouses/${w}`).set(H).expect(200);
      await A.owner.delete(`/api/warehouses/${w}`).set(H).expect(404); // não repete
      await A.owner.delete(`/api/establishments/${e}`).set(H).expect(200);
      await A.owner.delete(`/api/companies/${c}`).set(H).expect(200);
      expect((await structure(A)).find((x) => x.id === c)).toBeUndefined();
      for (const action of ['warehouse.deleted', 'establishment.deleted', 'company.deleted']) {
        expect(((await A.owner.get(`/api/audit?action=${action}&limit=5`).expect(200)).body.items as any[]).length).toBeGreaterThan(0);
      }
    });

    it('depósito com estoque/movimentação não é excluído (inativa-se)', async () => {
      const c = await company(A);
      const e = await est(A, c);
      const w = await wh(A, e);
      const p = (await A.owner.post('/api/products').set(H).send({ sku: `D-${uid()}`, name: 'Prod' }).expect(201)).body.id;
      await A.owner.post('/api/stock/movements').set(H).send({ productId: p, warehouseId: w, type: 'PURCHASE_ENTRY', quantity: 3 }).expect(201);
      const r = await A.owner.delete(`/api/warehouses/${w}`).set(H).expect(409);
      expect(r.body.message).toMatch(/em uso|Desative/);
      expect((await structure(A)).find((x) => x.id === c).establishments[0].warehouses).toHaveLength(1);
      await A.owner.patch(`/api/warehouses/${w}`).set(H).send({ active: false }).expect(200);
    });

    it('estabelecimento com numeração/certificado fiscal não é excluído; com rascunho fiscal vazio é', async () => {
      const c = await company(A);
      const used = await est(A, c);
      await admin.$executeRaw`INSERT INTO fiscal_series (tenant_id, establishment_id, model, series, environment, last) VALUES (${A.tenantId}::uuid, ${used}::uuid, '55', 1, 'HOMOLOGACAO', 5)`;
      const r = await A.owner.delete(`/api/establishments/${used}`).set(H).expect(409);
      expect(r.body.message).toMatch(/fiscal/);

      const draft = await est(A, c);
      await A.owner.get(`/api/fiscal/establishments/${draft}/config`).expect(200); // cria o rascunho da configuração fiscal
      await A.owner.delete(`/api/establishments/${draft}`).set(H).expect(200);

      const sent = await est(A, c);
      await admin.$executeRaw`UPDATE fiscal_configurations SET status = 'PENDING_ACCOUNTANT' WHERE establishment_id = ${sent}::uuid`;
      await A.owner.get(`/api/fiscal/establishments/${sent}/config`).expect(200);
      await admin.$executeRaw`UPDATE fiscal_configurations SET status = 'PENDING_ACCOUNTANT' WHERE establishment_id = ${sent}::uuid`;
      await A.owner.delete(`/api/establishments/${sent}`).set(H).expect(409);
    });

    it('depósito usado em pedido de venda não é excluído', async () => {
      const c = await company(A);
      const e = await est(A, c);
      const w = await wh(A, e);
      const cust = (await A.owner.post('/api/customers').set(H).send({ kind: 'PJ', name: `Cli ${uid()}` }).expect(201)).body.id;
      const p = (await A.owner.post('/api/products').set(H).send({ sku: `V-${uid()}`, name: 'Prod', suggestedPrice: 10 }).expect(201)).body.id;
      await A.owner.post('/api/sales/orders').set(H).send({ customerId: cust, warehouseId: w, items: [{ productId: p, quantity: 1, unitPrice: 10 }] }).expect(201);
      await A.owner.delete(`/api/warehouses/${w}`).set(H).expect(409);
    });

    it('o papel de runtime só apaga o que a aplicação permite (sem DELETE em tabelas de auditoria/financeiro)', async () => {
      const rows = await admin.$queryRawUnsafe<{ t: string }[]>(`SELECT table_name AS t FROM information_schema.role_table_grants WHERE grantee = 'dh_app' AND privilege_type = 'DELETE' AND table_name IN ('audit_logs','financial_settlements','stock_movements','sales_orders','fiscal_documents')`);
      expect(rows).toEqual([]);
    });
  });
});
