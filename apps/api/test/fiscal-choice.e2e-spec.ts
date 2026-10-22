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
const CNPJ_FULL = '45723174000110';
const CNPJ_CUSTOMER = '11222333000181';

describe('Documento fiscal escolhido na venda (NF-e ou NFC-e) e espelho', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  const agent = () => request.agent(app.getHttpServer());
  type Agent = ReturnType<typeof agent>;
  interface T { owner: Agent; tenantId: string; wh: string; seller: Agent; sellerId: string }

  /** `complete` = estabelecimento com CNPJ, IE e endereço; senão, só o nome. */
  async function setup(label: string, complete: boolean): Promise<T> {
    const owner = agent();
    const reg = await owner.post('/api/auth/register').set(H).send({ companyName: `Co ${label} ${run}`, name: `Dono ${label}`, email: `${label}-${run}@teste.local`, password: PASSWORD }).expect(201);
    const company = await owner.post('/api/companies').set(H).send({ legalName: `${label} LTDA`, ...(complete ? { taxRegime: 'SIMPLES_NACIONAL' } : {}) }).expect(201);
    const est = await owner.post('/api/establishments').set(H).send({
      companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz',
      ...(complete ? { cnpj: CNPJ_FULL, stateRegistration: '111222333444', cnae: '4744-0/99', zipCode: '13000-000', city: 'Campinas', state: 'SP', street: 'Rua A', number: '1' } : {}),
    }).expect(201);
    const wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
    const roles = Object.fromEntries((await owner.get('/api/roles').expect(200)).body.map((r: any) => [r.key, r.id]));
    const email = `vend-${uid()}@teste.local`;
    const u = await owner.post('/api/users').set(H).send({ name: 'Vendedor', email, password: PASSWORD, roleId: roles.salesperson }).expect(201);
    const seller = agent();
    await seller.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200);
    const sellerId = (await owner.post('/api/salespeople').set(H).send({ name: 'Vera', userId: u.body.userId }).expect(201)).body.id;
    return { owner, tenantId: reg.body.tenantId, wh, seller, sellerId };
  }

  const customer = async (t: T, extra: object = {}) => (await t.owner.post('/api/customers').set(H).send({ kind: 'PF', name: `Cliente ${uid()}`, ...extra }).expect(201)).body.id as string;
  const product = async (t: T, extra: object = {}) => (await t.owner.post('/api/products').set(H).send({ sku: `FC-${uid()}`, name: 'Parafuso', suggestedPrice: 50, costPrice: 10, ...extra }).expect(201)).body.id as string;
  const order = (t: T, customerId: string, productId: string, extra: object = {}, who: Agent = t.owner) =>
    who.post('/api/sales/orders').set(H).send({ customerId, warehouseId: t.wh, items: [{ productId, quantity: 2, unitPrice: 50 }], ...extra });
  const preview = (t: T, id: string, who: Agent = t.owner) => who.get(`/api/sales/orders/${id}/fiscal-preview`);
  const codes = (b: any, level?: string) => (b.issues as any[]).filter((i) => !level || i.level === level).map((i) => i.code);

  let A: T; // cadastro fiscal completo
  let B: T; // estabelecimento sem dados fiscais
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    await admin.plan.update({ where: { code: 'trial' }, data: { limits: { users: 100, establishments: 20, warehouses: 20 } } });
    A = await setup('fcA', true);
    B = await setup('fcB', false);
  });
  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  it('o pedido guarda o documento escolhido (padrão: decidir depois) e aceita trocar no rascunho', async () => {
    const c = await customer(A); const p = await product(A);
    const def = (await order(A, c, p).expect(201)).body.id;
    expect((await A.owner.get(`/api/sales/orders/${def}`).expect(200)).body.fiscalDocType).toBe('NONE');

    const nfe = (await order(A, c, p, { fiscalDocType: 'NFE' }).expect(201)).body.id;
    expect((await A.owner.get(`/api/sales/orders/${nfe}`).expect(200)).body.fiscalDocType).toBe('NFE');
    await A.owner.put(`/api/sales/orders/${nfe}`).set(H).send({ customerId: c, warehouseId: A.wh, fiscalDocType: 'NFCE', items: [{ productId: p, quantity: 2, unitPrice: 50 }] }).expect(200);
    expect((await A.owner.get(`/api/sales/orders/${nfe}`).expect(200)).body.fiscalDocType).toBe('NFCE');

    await order(A, c, p, { fiscalDocType: 'CUPOM' }).expect(400); // valor desconhecido
  });

  it('sem documento escolhido o espelho não aponta pendências', async () => {
    const id = (await order(A, await customer(A), await product(A)).expect(201)).body.id;
    const r = (await preview(A, id).expect(200)).body;
    expect(r).toMatchObject({ mode: 'ESPELHO', docType: 'NONE', ready: false, issues: [] });
    expect(r.items).toHaveLength(1);
    expect(r.totals.total).toBe('100');
  });

  it('NF-e: exige CPF/CNPJ e endereço do destinatário e NCM dos itens; com tudo, fica pronta (com avisos fiscais)', async () => {
    const incompleteCustomer = await customer(A);
    const noNcm = await product(A);
    const id = (await order(A, incompleteCustomer, noNcm, { fiscalDocType: 'NFE' }).expect(201)).body.id;
    const bad = (await preview(A, id).expect(200)).body;
    expect(bad.ready).toBe(false);
    expect(codes(bad, 'BLOCKER').sort()).toEqual(['ITEM_NCM', 'RECIPIENT_ADDRESS', 'RECIPIENT_DOC']);

    const full = await customer(A, { kind: 'PJ', document: '11.222.333/0001-81', zipCode: '13010-000', street: 'Rua B', number: '10', city: 'Campinas', state: 'SP' });
    const withNcm = await product(A, { ncm: '73181500', taxOrigin: 0 });
    const ok = (await order(A, full, withNcm, { fiscalDocType: 'NFE' }).expect(201)).body.id;
    const r = (await preview(A, ok).expect(200)).body;
    expect(codes(r, 'BLOCKER')).toEqual([]);
    expect(r.ready).toBe(true);
    expect(codes(r)).toEqual(expect.arrayContaining(['FISCAL_CONFIG', 'CERTIFICATE', 'NOT_ISSUED'])); // contador e certificado ainda pendentes; espelho
    expect(r.emitter).toMatchObject({ legalName: expect.stringContaining('fcA'), cnpj: CNPJ_FULL, state: 'SP', taxRegime: 'SIMPLES_NACIONAL' });
    expect(r.recipient).toMatchObject({ document: CNPJ_CUSTOMER, city: 'Campinas' });
    expect(r.items[0]).toMatchObject({ ncm: '73181500', unit: 'UN', quantity: 2, total: '100' });
  });

  it('NFC-e: não exige destinatário, mas avisa que venda a empresa normalmente pede NF-e', async () => {
    const consumer = await customer(A);
    const p = await product(A, { ncm: '73181500', taxOrigin: 0 });
    const id = (await order(A, consumer, p, { fiscalDocType: 'NFCE' }).expect(201)).body.id;
    const r = (await preview(A, id).expect(200)).body;
    expect(r.docType).toBe('NFCE');
    expect(codes(r, 'BLOCKER')).toEqual([]);
    expect(codes(r)).not.toContain('NFCE_B2B');

    const pj = await customer(A, { kind: 'PJ', document: '45.723.174/0001-10' });
    const b2b = (await order(A, pj, p, { fiscalDocType: 'NFCE' }).expect(201)).body.id;
    expect(codes((await preview(A, b2b).expect(200)).body, 'WARNING')).toContain('NFCE_B2B');
  });

  it('estabelecimento sem CNPJ, IE, endereço e regime impede emitir qualquer dos dois documentos', async () => {
    const p = await product(B, { ncm: '73181500', taxOrigin: 0 });
    for (const t of ['NFE', 'NFCE']) {
      const id = (await order(B, await customer(B), p, { fiscalDocType: t }).expect(201)).body.id;
      const r = (await preview(B, id).expect(200)).body;
      expect(codes(r, 'BLOCKER')).toEqual(expect.arrayContaining(['EMITTER_CNPJ', 'EMITTER_IE', 'EMITTER_ADDRESS', 'TAX_REGIME']));
      expect(r.ready).toBe(false);
    }
  });

  it('respeita o escopo do vendedor e o isolamento entre empresas', async () => {
    const c = await customer(A); const p = await product(A);
    const mine = (await order(A, c, p, { salespersonId: A.sellerId, fiscalDocType: 'NFCE' }, A.seller).expect(201)).body.id;
    const others = (await order(A, c, p).expect(201)).body.id; // criado pelo dono, sem vendedor
    await preview(A, mine, A.seller).expect(200);
    await preview(A, others, A.seller).expect(404);
    await preview(B, mine).expect(404);
    await request(app.getHttpServer()).get(`/api/sales/orders/${mine}/fiscal-preview`).expect(401);
  });
});
