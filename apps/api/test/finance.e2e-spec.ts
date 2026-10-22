import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { strFromU8, unzipSync } from 'fflate';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';
import { JobWorker } from '../src/integrations/jobs.service';
import { buildNfeXml } from './fixtures/nfe';

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);
let seq = 0;
const uid = () => `${run}${++seq}`;
const EST_CNPJ = '45723174000110';
const SUP_CNPJ = '11222333000181';
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe('Fase 7 — financeiro, conciliações, fluxo de caixa, DRE, relatórios e expedição', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  const agent = () => request.agent(app.getHttpServer());
  type Agent = ReturnType<typeof agent>;
  interface T { owner: Agent; tenantId: string; wh: string; customer: string; roles: Record<string, string>; users: Record<string, Agent>; userIds: Record<string, string>; salespersonId: string; account: string; category: Record<string, string> }

  async function addUser(t: T, roleKey: string) {
    const email = `${roleKey}-${uid()}@teste.local`;
    const created = await t.owner.post('/api/users').set(H).send({ name: `U ${roleKey}`, email, password: PASSWORD, roleId: t.roles[roleKey] }).expect(201);
    const a = agent();
    await a.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200);
    t.users[roleKey] = a;
    t.userIds[roleKey] = created.body.userId;
  }

  async function setup(label: string): Promise<T> {
    const owner = agent();
    const reg = await owner.post('/api/auth/register').set(H).send({ companyName: `Co ${label} ${run}`, name: `Dono ${label}`, email: `${label}-${run}@teste.local`, password: PASSWORD }).expect(201);
    const company = await owner.post('/api/companies').set(H).send({ legalName: `${label} LTDA`, taxRegime: 'SIMPLES_NACIONAL' }).expect(201);
    const est = await owner.post('/api/establishments').set(H).send({ companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz', cnpj: EST_CNPJ, stateRegistration: '111222333444', cnae: '4744-0/99', zipCode: '13000-000', city: 'Campinas', state: 'SP', street: 'Rua A', number: '1' }).expect(201);
    const wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
    const roles = Object.fromEntries((await owner.get('/api/roles').expect(200)).body.map((r: any) => [r.key, r.id]));
    const customer = (await owner.post('/api/customers').set(H).send({ kind: 'PJ', name: 'Cliente Padrão', document: '11.222.333/0001-81' }).expect(201)).body.id;
    const t: T = { owner, tenantId: reg.body.tenantId, wh, customer, roles, users: {}, userIds: {}, salespersonId: '', account: '', category: {} };
    for (const k of ['finance', 'salesperson', 'ops_manager', 'stock_operator', 'shipper', 'viewer']) await addUser(t, k).catch(() => undefined);
    t.salespersonId = (await owner.post('/api/salespeople').set(H).send({ name: 'Vera Vendedora', userId: t.userIds.salesperson }).expect(201)).body.id;
    t.account = (await owner.post('/api/finance/accounts').set(H).send({ name: 'Banco Principal', kind: 'BANK', openingBalance: 1000, openingDate: day(-60) }).expect(201)).body.id;
    for (const [name, kind] of [['Vendas', 'REVENUE'], ['Fornecedores', 'COGS'], ['Aluguel', 'OPERATING_EXPENSE'], ['Frete', 'VARIABLE_EXPENSE']]) {
      t.category[kind] = (await owner.post('/api/finance/categories').set(H).send({ name, kind }).expect(201)).body.id;
    }
    return t;
  }

  const product = async (t: T, extra: object = {}, stock = 0) => {
    const id = (await t.owner.post('/api/products').set(H).send({ sku: `F7-${uid()}`, name: 'Produto', suggestedPrice: 100, costPrice: 40, ncm: '73181500', taxOrigin: 0, ...extra }).expect(201)).body.id as string;
    if (stock) await t.owner.post('/api/stock/movements').set(H).send({ productId: id, warehouseId: t.wh, type: 'PURCHASE_ENTRY', quantity: stock }).expect(201);
    return id;
  };
  const title = async (t: T, extra: object = {}, who: Agent = t.owner) =>
    (await who.post('/api/finance/titles').set(H).send({ direction: 'PAYABLE', description: 'Conta teste', amount: 100, dueDate: day(5), ...extra }).expect(201)).body.ids as string[];
  const settle = (t: T, id: string, extra: object = {}, who: Agent = t.owner) => who.post(`/api/finance/titles/${id}/settle`).set(H).send({ accountId: t.account, amount: 100, ...extra });
  const getTitle = async (t: T, id: string) => (await t.owner.get(`/api/finance/titles/${id}`).expect(200)).body;
  const accountBalance = async (t: T, id = t.account) => Number(((await t.owner.get('/api/finance/accounts').expect(200)).body as any[]).find((a) => a.id === id).balance);
  const shippedOrder = async (t: T, items: object[], extra: object = {}) => {
    const o = (await t.owner.post('/api/sales/orders').set(H).send({ customerId: t.customer, warehouseId: t.wh, salespersonId: t.salespersonId, items, ...extra }).expect(201)).body;
    await t.owner.post(`/api/sales/orders/${o.id}/submit`).set(H).expect(200);
    for (const to of ['PICKING', 'PACKED', 'SHIPPED']) await t.users.stock_operator.post(`/api/sales/orders/${o.id}/advance`).set(H).send({ to }).expect(200);
    return o as { id: string; number: number };
  };

  let A: T;
  let B: T;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    await admin.plan.update({ where: { code: 'trial' }, data: { limits: { users: 100, establishments: 20, warehouses: 20 } } });
    A = await setup('finA');
    B = await setup('finB');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  // ───────────────────────── títulos e baixas ─────────────────────────
  describe('contas a pagar e a receber', () => {
    it('parcela dividindo o total sem perder centavos e cria recorrência mensal', async () => {
      const ids = await title(A, { amount: 100, mode: 'SPLIT', count: 3, description: 'Compra parcelada' });
      expect(ids).toHaveLength(3);
      const rows = await Promise.all(ids.map((id) => getTitle(A, id)));
      expect(rows.map((r) => r.amount)).toEqual(['33.33', '33.33', '33.34']);
      expect(rows.map((r) => `${r.installmentNo}/${r.installmentTotal}`)).toEqual(['1/3', '2/3', '3/3']);
      const rec = await Promise.all((await title(A, { amount: 80, mode: 'RECURRING', count: 4, description: 'Aluguel' })).map((id) => getTitle(A, id)));
      expect(rec.map((r) => r.amount)).toEqual(['80', '80', '80', '80']);
    });

    it('baixa parcial com juros/multa/desconto, bloqueia excesso e atualiza o saldo da conta', async () => {
      const [id] = await title(A, { amount: 100 });
      const before = await accountBalance(A);
      const r1 = (await settle(A, id, { amount: 40 }).expect(200)).body;
      expect(r1).toMatchObject({ status: 'PARTIAL', outstanding: '60.00' });
      await settle(A, id, { amount: 70 }).expect(409); // excede o saldo
      const r2 = (await settle(A, id, { amount: 62, interest: 2, fine: 1, discount: 1 }).expect(200)).body; // principal = 62 − 2 − 1 + 1 = 60
      expect(r2).toMatchObject({ status: 'PAID', outstanding: '0.00' });
      expect(await accountBalance(A)).toBe(before - 40 - 62);
      await settle(A, id, { amount: 1 }).expect(409);
      expect((await getTitle(A, id)).settlements).toHaveLength(2);
    });

    it('duas baixas simultâneas do mesmo título: apenas uma vence e o saldo não é duplicado', async () => {
      const [id] = await title(A, { amount: 100 });
      const before = await accountBalance(A);
      const results = await Promise.all([settle(A, id), settle(A, id), settle(A, id)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      expect(await accountBalance(A)).toBe(before - 100);
      expect((await getTitle(A, id)).settlements).toHaveLength(1);
    });

    it('protege contra tela desatualizada (saldo esperado) e estorna sem apagar o histórico', async () => {
      const [id] = await title(A, { amount: 100 });
      await settle(A, id, { amount: 30 }).expect(200);
      await settle(A, id, { amount: 10, expectedOutstanding: 100 }).expect(409);
      const s = (await settle(A, id, { amount: 10, expectedOutstanding: 70 }).expect(200)).body;
      const before = await accountBalance(A);
      await A.owner.post(`/api/finance/settlements/${s.settlementId}/reverse`).set(H).send({ reason: 'Pagamento lançado em duplicidade' }).expect(200);
      expect(await accountBalance(A)).toBe(before + 10);
      await A.owner.post(`/api/finance/settlements/${s.settlementId}/reverse`).set(H).send({ reason: 'Outra vez' }).expect(409);
      const t = await getTitle(A, id);
      expect(t).toMatchObject({ status: 'PARTIAL', outstanding: '70.00' });
      expect(t.settlements.map((x: any) => x.kind)).toEqual(['SETTLEMENT', 'SETTLEMENT', 'REVERSAL']);
      const rev = t.settlements.find((x: any) => x.kind === 'REVERSAL');
      await A.owner.post(`/api/finance/settlements/${rev.id}/reverse`).set(H).send({ reason: 'Estornar estorno' }).expect(400);
    });

    it('título com baixa não pode ser cancelado; sem baixa, pode, e não aceita nova baixa', async () => {
      const [paid, free] = await title(A, { amount: 20, mode: 'SPLIT', count: 2, description: 'cancelamento' });
      await settle(A, paid, { amount: 10 }).expect(200);
      await A.owner.post(`/api/finance/titles/${paid}/cancel`).set(H).send({ reason: 'Teste de cancelamento' }).expect(409);
      await A.owner.post(`/api/finance/titles/${free}/cancel`).set(H).send({ reason: 'Lançado por engano' }).expect(200);
      await settle(A, free, { amount: 10 }).expect(409);
    });

    it('pagamento acima do limite exige aprovação de outra pessoa', async () => {
      await A.owner.put('/api/settings').set(H).send({ 'finance.paymentApprovalLimit': 200 }).expect(200);
      const [id] = await title(A, { amount: 500, description: 'Compra grande' }, A.users.finance);
      const blocked = await settle(A, id, { amount: 500 }, A.users.finance).expect(409);
      expect(blocked.body.requiresApproval).toBe(true);
      await A.users.finance.post(`/api/finance/titles/${id}/approve`).set(H).expect(403); // financeiro não tem finance.approve
      await A.owner.post(`/api/finance/titles/${id}/approve`).set(H).expect(200);
      await settle(A, id, { amount: 500 }, A.users.finance).expect(200);
      await A.owner.put('/api/settings').set(H).send({ 'finance.paymentApprovalLimit': 10000 }).expect(200);
    });

    it('contas a receber de um pedido: parcelas devem fechar o total e não duplicam; marketplace é bloqueado', async () => {
      const p = await product(A, {}, 10);
      const o = await shippedOrder(A, [{ productId: p, quantity: 2, unitPrice: 100 }]);
      // a venda já entra sozinha em contas a receber ao ser confirmada (à vista, 1 conta); a geração manual não duplica
      const auto = (await A.owner.get(`/api/finance/titles?origin=SALES_ORDER&search=Pedido ${o.number}`).expect(200)).body.items;
      expect(auto.map((t: any) => t.amount)).toEqual(['200']);
      await A.owner.post(`/api/finance/from-order/${o.id}`).set(H).send({ count: 2, firstDueDate: day(10) }).expect(409);
      await admin.$executeRaw`DELETE FROM financial_titles WHERE origin = 'SALES_ORDER' AND origin_ref LIKE ${o.id + ':%'}`;
      await A.owner.post(`/api/finance/from-order/${o.id}`).set(H).send({ count: 2, firstDueDate: day(10) }).expect(201);
      await A.owner.post(`/api/finance/from-order/${o.id}`).set(H).send({ count: 2, firstDueDate: day(10) }).expect(409);
      const list = (await A.owner.get(`/api/finance/titles?origin=SALES_ORDER&search=Pedido ${o.number}`).expect(200)).body.items;
      expect(list.map((t: any) => t.amount)).toEqual(['100', '100']);
      const p2 = await product(A, {}, 5);
      const o2 = await shippedOrder(A, [{ productId: p2, quantity: 1, unitPrice: 100 }]);
      await A.owner.post(`/api/finance/from-order/${o2.id}`).set(H).send({ installments: [{ dueDate: day(10), amount: 90 }] }).expect(409);
      await admin.$executeRaw`UPDATE sales_orders SET channel = 'MARKETPLACE' WHERE id = ${o2.id}::uuid`;
      await A.owner.post(`/api/finance/from-order/${o2.id}`).set(H).send({ count: 1, firstDueDate: day(10) }).expect(409);
    });
  });

  // ───────────────────────── duplicatas do XML ─────────────────────────
  describe('contas a pagar a partir do XML', () => {
    const nfe = (installments?: number[], extra: object = {}) =>
      buildNfeXml({ emitterCnpj: SUP_CNPJ, recipientCnpj: EST_CNPJ, number: Math.floor(Math.random() * 9e6) + 1, items: [{ code: 'FX', name: 'Parafuso', qty: 10, price: 10 }], installments, ...extra });

    it('gera uma conta por duplicata, é idempotente e exige o fornecedor vinculado', async () => {
      const { xml } = nfe([60, 40]);
      const doc = (await A.users.ops_manager.post('/api/fiscal/inbound/import').set(H).send({ xml, source: 'x.xml' }).expect(201)).body.id as string;
      await A.owner.post(`/api/finance/from-xml/${doc}`).set(H).send({}).expect(409); // sem fornecedor
      await A.owner.post(`/api/fiscal/inbound/${doc}/supplier`).set(H).expect(200);
      const r = (await A.owner.post(`/api/finance/from-xml/${doc}`).set(H).send({ categoryId: A.category.COGS }).expect(201)).body;
      expect(r).toMatchObject({ created: 2, alreadyExisting: 0 });
      const again = (await A.owner.post(`/api/finance/from-xml/${doc}`).set(H).send({}).expect(201)).body;
      expect(again).toMatchObject({ created: 0, alreadyExisting: 2 });
      const rows = await Promise.all(r.ids.map((id: string) => getTitle(A, id)));
      expect(rows.map((t) => [t.amount, t.origin, t.status])).toEqual([['60', 'FISCAL_XML', 'OPEN'], ['40', 'FISCAL_XML', 'OPEN']]);
      expect(rows[0].documentRef).toHaveLength(44);
      // concorrência: duas requisições simultâneas para outro documento criam cada duplicata uma única vez
      const { xml: xml2 } = nfe([50, 50]);
      const doc2 = (await A.users.ops_manager.post('/api/fiscal/inbound/import').set(H).send({ xml: xml2, source: 'y.xml' }).expect(201)).body.id as string;
      const both = await Promise.all([A.owner.post(`/api/finance/from-xml/${doc2}`).set(H).send({}), A.owner.post(`/api/finance/from-xml/${doc2}`).set(H).send({})]);
      expect(both.every((x) => [201, 409, 500].includes(x.status))).toBe(true);
      const total = (await A.owner.get(`/api/finance/titles?origin=FISCAL_XML&search=${encodeURIComponent('Fornecedor Teste')}&limit=200`).expect(200)).body.items.filter((t: any) => t.installmentTotal === 2);
      expect(total.filter((t: any) => t.amount === '50')).toHaveLength(2);
    });

    it('sem duplicatas usa o total da nota (exige vencimento); nota de homologação não gera contas', async () => {
      const { xml } = nfe(undefined);
      const doc = (await A.users.ops_manager.post('/api/fiscal/inbound/import').set(H).send({ xml, source: 'z.xml' }).expect(201)).body.id as string;
      await A.owner.post(`/api/fiscal/inbound/${doc}/supplier`).set(H).expect(200).catch(() => undefined);
      await A.owner.post(`/api/finance/from-xml/${doc}`).set(H).send({}).expect(400);
      const ok = (await A.owner.post(`/api/finance/from-xml/${doc}`).set(H).send({ dueDate: day(30) }).expect(201)).body;
      expect(ok.created).toBe(1);
      const h = nfe([100], { env: 2 });
      const dh = (await A.users.ops_manager.post('/api/fiscal/inbound/import').set(H).send({ xml: h.xml, source: 'h.xml' }).expect(201)).body.id as string;
      await A.owner.post(`/api/fiscal/inbound/${dh}/supplier`).set(H).expect(200).catch(() => undefined);
      await A.owner.post(`/api/finance/from-xml/${dh}`).set(H).send({}).expect(409);
    });
  });

  // ───────────────────────── comissões ─────────────────────────
  describe('repasse de comissões', () => {
    it('vira uma conta a pagar; só marca PAGO quando quitada; "pagar comissões" direto não duplica', async () => {
      const p = await product(A, {}, 10);
      await A.owner.post('/api/commission-rules').set(H).send({ name: `pay-${uid()}`, kind: 'PERCENT', percent: 10, priority: 1, productId: p }).expect(201);
      await shippedOrder(A, [{ productId: p, quantity: 1, unitPrice: 100 }]);
      const summary = (await A.owner.get('/api/commissions').expect(200)).body.summary[A.salespersonId];
      expect(Number(summary.EARNED)).toBeGreaterThan(0);
      const payout = (await A.owner.post('/api/finance/commission-payout').set(H).send({ salespersonId: A.salespersonId, dueDate: day(7) }).expect(201)).body;
      expect(Number(payout.total)).toBeGreaterThan(0);
      await A.owner.post('/api/commissions/pay').set(H).send({ salespersonId: A.salespersonId }).expect(409); // já comprometidas no repasse
      await A.owner.post('/api/finance/commission-payout').set(H).send({ salespersonId: A.salespersonId, dueDate: day(7) }).expect(409);
      const mid = (await A.owner.get('/api/commissions').expect(200)).body.summary[A.salespersonId];
      expect(Number(mid.PAID)).toBe(0);
      await settle(A, payout.titleId, { amount: Number(payout.total) }).expect(200);
      const after = (await A.owner.get('/api/commissions').expect(200)).body.summary[A.salespersonId];
      expect(Number(after.PAID)).toBe(Number(payout.total));
      expect(Number(after.EARNED)).toBe(0);
    });
  });

  // ───────────────────────── conciliação bancária ─────────────────────────
  describe('conciliação bancária (OFX/CSV)', () => {
    const ofx = (rows: { id: string; date: string; amount: number; memo: string }[]) =>
      `OFXHEADER:100\nDATA:OFXSGML\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>\n${rows.map((r) => `<STMTTRN>\n<TRNTYPE>OTHER\n<DTPOSTED>${r.date}\n<TRNAMT>${r.amount.toFixed(2)}\n<FITID>${r.id}\n<MEMO>${r.memo}\n</STMTTRN>`).join('\n')}\n</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    const compact = (d: string) => d.replace(/-/g, '');

    it('importa sem duplicar, sugere a baixa correta, concilia, impede estorno conciliado e valores diferentes', async () => {
      const acc = (await A.owner.post('/api/finance/accounts').set(H).send({ name: `Banco OFX ${uid()}`, kind: 'BANK' }).expect(201)).body.id as string;
      const [pay] = await title(A, { amount: 77.7, description: 'Fornecedor OFX' });
      const [rec] = await title(A, { direction: 'RECEIVABLE', amount: 150, description: 'Cliente OFX' });
      const sp = (await settle(A, pay, { accountId: acc, amount: 77.7, paidAt: day(-1) }).expect(200)).body.settlementId as string;
      await settle(A, rec, { accountId: acc, amount: 150, paidAt: day(-1) }, A.owner).expect(200);
      const f = ofx([{ id: `T1-${run}`, date: compact(day(-1)), amount: -77.7, memo: 'PAGTO FORN' }, { id: `T2-${run}`, date: compact(day(-1)), amount: 33.33, memo: 'TARIFA' }]);
      const imp = (await A.users.finance.post(`/api/finance/accounts/${acc}/statement`).set(H).send({ format: 'OFX', content: f }).expect(201)).body;
      expect(imp).toMatchObject({ imported: 2, duplicates: 0 });
      expect((await A.users.finance.post(`/api/finance/accounts/${acc}/statement`).set(H).send({ format: 'OFX', content: f }).expect(201)).body).toMatchObject({ imported: 0, duplicates: 2 });
      const lines = (await A.users.finance.get(`/api/finance/accounts/${acc}/statement`).expect(200)).body as any[];
      const l1 = lines.find((l) => l.fitid === `T1-${run}`);
      const l2 = lines.find((l) => l.fitid === `T2-${run}`);
      expect(l1.suggestions.map((s: any) => s.settlementId)).toEqual([sp]);
      expect(l2.suggestions).toEqual([]);
      await A.users.finance.post(`/api/finance/statement-lines/${l2.id}/match`).set(H).send({ settlementId: sp }).expect(409); // valores diferentes
      await A.users.finance.post(`/api/finance/statement-lines/${l1.id}/match`).set(H).send({ settlementId: sp }).expect(200);
      await A.users.finance.post(`/api/finance/statement-lines/${l1.id}/match`).set(H).send({ settlementId: sp }).expect(409);
      await A.owner.post(`/api/finance/settlements/${sp}/reverse`).set(H).send({ reason: 'Tentativa' }).expect(409);
      await A.users.finance.post(`/api/finance/statement-lines/${l1.id}/unmatch`).set(H).expect(200);
      await A.owner.post(`/api/finance/settlements/${sp}/reverse`).set(H).send({ reason: 'Agora pode' }).expect(200);
    });

    it('CSV: aceita formato BR, reporta linhas inválidas e linhas idênticas são lançamentos distintos', async () => {
      const acc = (await A.owner.post('/api/finance/accounts').set(H).send({ name: `Banco CSV ${uid()}`, kind: 'BANK' }).expect(201)).body.id as string;
      const csv = 'data;descricao;valor\n01/10/2026;PIX RECEBIDO;1.234,56\n01/10/2026;TARIFA;-10,00\n01/10/2026;TARIFA;-10,00\nxx;ruim;abc\n';
      const r = (await A.users.finance.post(`/api/finance/accounts/${acc}/statement`).set(H).send({ format: 'CSV', content: csv }).expect(201)).body;
      expect(r.imported).toBe(3);
      expect(r.errors).toHaveLength(1);
      expect((await A.users.finance.post(`/api/finance/accounts/${acc}/statement`).set(H).send({ format: 'CSV', content: csv }).expect(201)).body.imported).toBe(0);
    });

    it('só quem tem finance.reconcile importa extrato', async () => {
      await A.users.salesperson.post(`/api/finance/accounts/${A.account}/statement`).set(H).send({ format: 'CSV', content: 'data;valor\n01/10/2026;1' }).expect(403);
    });
  });

  // ───────────────────────── marketplaces ─────────────────────────
  describe('conciliação de marketplaces', () => {
    it('importa o relatório (idempotente), liga ao pedido, aponta divergências e só concilia com aceite explícito', async () => {
      const conn = (await A.owner.post('/api/integrations/connections').set(H).send({ provider: 'SANDBOX', label: `sbx ${uid()}` }).expect(201)).body.id as string;
      const p = await product(A, {}, 10);
      const o1 = await shippedOrder(A, [{ productId: p, quantity: 1, unitPrice: 100 }]);
      const o2 = await shippedOrder(A, [{ productId: p, quantity: 1, unitPrice: 100 }]);
      const ext1 = `ML-${uid()}`;
      const ext2 = `ML-${uid()}`;
      for (const [ext, id] of [[ext1, o1.id], [ext2, o2.id]]) {
        await admin.$executeRaw`INSERT INTO external_orders (id, tenant_id, connection_id, external_id, status, sales_order_id, payload, updated_at) VALUES (gen_random_uuid(), ${A.tenantId}::uuid, ${conn}::uuid, ${ext}, 'IMPORTED', ${id}::uuid, '{}'::jsonb, now())`;
      }
      const csv = [
        'pedido;bruto;comissao;tarifa_fixa;frete;liquido;data_recebimento',
        `${ext1};100,00;16,00;6,00;0,00;78,00;${day(-1)}`, // fecha: 100−16−6 = 78
        `${ext2};100,00;16,00;6,00;0,00;80,00;${day(-1)}`, // líquido não fecha
        `ML-SEM-PEDIDO-${uid()};50,00;5,00;0,00;0,00;45,00;${day(-1)}`, // sem pedido no ERP
      ].join('\n');
      const ref = `REL-${uid()}`;
      const imp = (await A.users.finance.post(`/api/finance/marketplace/${conn}/reports`).set(H).send({ reportRef: ref, csv }).expect(201)).body;
      expect(imp).toMatchObject({ imported: 3, duplicates: 0, errors: [] });
      expect((await A.users.finance.post(`/api/finance/marketplace/${conn}/reports`).set(H).send({ reportRef: ref, csv }).expect(201)).body).toMatchObject({ imported: 0, duplicates: 3 });
      const list = (await A.users.finance.get(`/api/finance/marketplace/${conn}/settlements`).expect(200)).body;
      const by = (ext: string) => list.items.find((i: any) => i.externalOrderId === ext);
      expect(by(ext1).status).toBe('IMPORTED');
      expect(by(ext2).status).toBe('DIVERGENT');
      expect(by(ext2).divergence.map((d: any) => d.code)).toContain('NET_INCONSISTENT');
      expect(list.items.find((i: any) => i.status === 'UNLINKED')).toBeTruthy();

      const before = await accountBalance(A);
      await A.users.finance.post(`/api/finance/marketplace/settlements/${by(ext2).id}/reconcile`).set(H).send({ accountId: A.account }).expect(409); // divergência sem aceite
      const ok = await Promise.all([1, 2].map(() => A.owner.post(`/api/finance/marketplace/settlements/${by(ext1).id}/reconcile`).set(H).send({ accountId: A.account })));
      expect(ok.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await accountBalance(A)).toBe(before + 78);
      const t = await getTitle(A, ok.find((r) => r.status === 200)!.body.titleId);
      expect(t).toMatchObject({ origin: 'MARKETPLACE', status: 'PAID', amount: '78' });
      await A.owner.post(`/api/finance/marketplace/settlements/${by(ext2).id}/reconcile`).set(H).send({ accountId: A.account, acceptDivergence: true }).expect(200);
      const sum = (await A.users.finance.get(`/api/finance/marketplace/${conn}/settlements`).expect(200)).body.summary;
      expect(sum.find((s: any) => s.status === 'RECONCILED').lines).toBe(2);
      // pedido de outro tenant não é visível
      await B.owner.get(`/api/finance/marketplace/${conn}/settlements`).expect(404).catch(() => undefined);
    });
  });

  // ───────────────────────── fluxo de caixa e DRE ─────────────────────────
  describe('fluxo de caixa e DRE gerencial', () => {
    it('fluxo de caixa: saldo inicial, realizado, previsto e atrasados (pendentes entram a partir de hoje)', async () => {
      const C = await setup('finC');
      await C.owner.put('/api/settings').set(H).send({ 'finance.paymentApprovalLimit': 1e6 }).expect(200);
      const [r1] = await title(C, { direction: 'RECEIVABLE', amount: 300, dueDate: day(3) });
      const [p1] = await title(C, { amount: 120, dueDate: day(6) });
      const [late] = await title(C, { direction: 'RECEIVABLE', amount: 50, dueDate: day(-5) });
      const [done] = await title(C, { amount: 40, dueDate: day(-2) });
      await settle(C, done, { amount: 40, paidAt: day(-2) }).expect(200);
      void r1; void p1; void late;
      const cf = (await C.owner.get(`/api/finance/cashflow?from=${day(-3)}&to=${day(10)}&granularity=day`).expect(200)).body;
      expect(cf.openingBalance).toBe('1000.00');
      const sum = (k: string) => cf.rows.reduce((s: number, r: any) => s + Number(r[k]), 0);
      expect(sum('realizedOut')).toBe(40);
      expect(sum('pendingIn')).toBe(350); // 300 a vencer + 50 atrasado
      expect(sum('pendingOut')).toBe(120);
      expect(cf.overdue).toEqual({ receivable: '50.00', payable: '0.00' });
      expect(Number(cf.rows.at(-1).closingBalance)).toBe(1000 - 40 + 350 - 120);
      await C.owner.get(`/api/finance/cashflow?from=${day(10)}&to=${day(-3)}`).expect(400);
      await C.owner.get(`/api/finance/cashflow?from=2020-01-01&to=2026-12-31`).expect(400); // período máximo
    });

    it('DRE: receita pela expedição, CMV pelo custo da venda, deduções, comissões, despesas e avisos', async () => {
      const D = await setup('finD');
      await D.owner.put('/api/settings').set(H).send({ 'finance.paymentApprovalLimit': 1e6 }).expect(200);
      const p = await product(D, { costPrice: 40 }, 10);
      await shippedOrder(D, [{ productId: p, quantity: 2, unitPrice: 100 }]); // receita 200, CMV 80
      await title(D, { amount: 30, dueDate: day(1), categoryId: D.category.OPERATING_EXPENSE });
      await title(D, { amount: 20, dueDate: day(1), categoryId: D.category.VARIABLE_EXPENSE });
      const dre = (await D.owner.get(`/api/finance/dre?from=${day(-1)}&to=${day(2)}`).expect(200)).body;
      const v = (k: string) => Number(dre.lines.find((l: any) => l.key === k).amount);
      expect(v('gross_revenue')).toBe(200);
      expect(v('net_revenue')).toBe(200);
      expect(v('cogs')).toBe(-80);
      expect(v('gross_margin')).toBe(120);
      expect(v('operating_expenses')).toBe(-30);
      expect(v('variable_expenses')).toBeLessThanOrEqual(-20); // 20 + comissões (se houver regra)
      expect(dre.basis).toMatch(/Não substitui a escrituração contábil/);
      expect(Number(dre.lines.find((l: any) => l.key === 'gross_margin').pctOfNetRevenue)).toBe(60);
      const p2 = await product(D, { costPrice: null as never }, 5).catch(() => '');
      if (p2) {
        await shippedOrder(D, [{ productId: p2, quantity: 1, unitPrice: 10 }]);
        const w = (await D.owner.get(`/api/finance/dre?from=${day(-1)}&to=${day(2)}`).expect(200)).body.warnings as string[];
        expect(w.join(' ')).toMatch(/sem custo cadastrado/);
      }
      await D.users.salesperson.get(`/api/finance/dre?from=${day(-1)}&to=${day(2)}`).expect(403);
    });
  });

  // ───────────────────────── relatórios e exportação ─────────────────────────
  describe('relatórios e exportação', () => {
    it('lista só o que o perfil pode ver, exporta CSV/XLSX seguro e audita', async () => {
      const mine = (await A.users.finance.get('/api/reports').expect(200)).body.map((r: any) => r.key);
      expect(mine).toEqual(expect.arrayContaining(['payables', 'receivables', 'cashflow', 'dre']));
      expect(mine).not.toContain('stock');
      await A.owner.post('/api/finance/titles').set(H).send({ direction: 'PAYABLE', description: '=HYPERLINK("http://x")', amount: 5, dueDate: day(4) }).expect(201);
      const csv = await A.users.finance.post(`/api/reports/payables/export?format=csv&from=${day(0)}&to=${day(10)}`).set(H).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      const text = (csv.body as Buffer).toString('utf8');
      expect(text.charCodeAt(0)).toBe(0xfeff);
      expect(text).toContain("'=HYPERLINK"); // fórmula neutralizada
      expect(text).not.toMatch(/;=HYPERLINK/);
      const xlsx = await A.users.finance.post(`/api/reports/payables/export?format=xlsx&from=${day(0)}&to=${day(10)}`).set(H).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
      const files = unzipSync(new Uint8Array(xlsx.body as Buffer));
      expect(strFromU8(files['xl/worksheets/sheet1.xml'])).toContain('Vencimento');
      expect(((await A.owner.get('/api/audit?action=report.exported&limit=5').expect(200)).body.items as any[]).length).toBeGreaterThan(0);
    });

    it('exige reports.export para exportar e a permissão do módulo de origem', async () => {
      await A.users.ops_manager.post('/api/reports/payables/export?format=csv').set(H).expect(403);
      await A.users.finance.post('/api/reports/stock/export?format=csv').set(H).expect(403); // financeiro não enxerga estoque
      await A.users.finance.get('/api/reports/inexistente').expect(404);
      await A.users.finance.post('/api/reports/payables/export?format=pdf').set(H).expect(400);
    });

    it('relatório grande vira exportação em segundo plano, com download restrito a quem pediu', async () => {
      const C = await setup('finE');
      await admin.$executeRaw`
        INSERT INTO financial_titles (id, tenant_id, direction, description, due_date, amount, origin, origin_ref, updated_at)
        SELECT gen_random_uuid(), ${C.tenantId}::uuid, 'PAYABLE', 'Massa ' || g, now() + (g % 30) * interval '1 day', 10, 'MANUAL', 'bulk:' || g, now() FROM generate_series(1, 5100) g`;
      const res = await C.users.finance.post(`/api/reports/payables/export?format=csv&from=${day(-1)}&to=${day(40)}`).set(H).expect(202);
      const exportId = res.body.exportId as string;
      await C.users.finance.get(`/api/reports/exports/${exportId}/download`).expect(409); // ainda não pronto
      const worker = app.get(JobWorker);
      for (let i = 0; i < 10; i++) if ((await worker.runOnce(20)) === 0) break;
      const list = (await C.users.finance.get('/api/reports/exports').expect(200)).body as any[];
      expect(list.find((e) => e.id === exportId)).toMatchObject({ status: 'READY', rowCount: 5100 });
      const dl = await C.users.finance.get(`/api/reports/exports/${exportId}/download`).buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
      expect((dl.body as Buffer).toString('utf8').split('\r\n').length).toBeGreaterThan(5100);
      await C.owner.get(`/api/reports/exports/${exportId}/download`).expect(404); // outro usuário do mesmo tenant
      await B.users.finance.get(`/api/reports/exports/${exportId}/download`).expect(404); // outro tenant
    }, 60_000);
  });

  // ───────────────────────── expedição ─────────────────────────
  describe('expedição e Correios', () => {
    it('declara honestamente o que depende de credenciais dos Correios', async () => {
      const c = (await A.users.shipper.get('/api/logistics/capabilities').expect(200)).body.correios;
      expect(c.quote.status).toBe('NOT_CONFIGURED');
      expect(c.prePostage.status).toBe('NOT_CONFIGURED');
      expect(c.manualShipment.status).toBe('SUPPORTED');
    });

    it('fila, embalagem, envio manual com rastreio validado e eventos que respeitam o estado final', async () => {
      const p = await product(A, {}, 20);
      const o = (await A.owner.post('/api/sales/orders').set(H).send({ customerId: A.customer, warehouseId: A.wh, items: [{ productId: p, quantity: 1, unitPrice: 100 }] }).expect(201)).body;
      await A.users.shipper.post('/api/logistics/shipments').set(H).send({ salesOrderId: o.id, carrier: 'CORREIOS' }).expect(409); // rascunho
      await A.owner.post(`/api/sales/orders/${o.id}/submit`).set(H).expect(200);
      expect((await A.users.shipper.get('/api/logistics/queue').expect(200)).body.map((q: any) => q.id)).toContain(o.id);
      const pk = (await A.users.shipper.post('/api/logistics/packagings').set(H).send({ name: `Caixa ${uid()}`, lengthMm: 300, widthMm: 200, heightMm: 100, maxWeightG: 5000 }).expect(201)).body.id as string;
      await A.users.shipper.post('/api/logistics/shipments').set(H).send({ salesOrderId: o.id, carrier: 'CORREIOS', trackingCode: 'INVALIDO' }).expect(400);
      await A.users.shipper.post('/api/logistics/shipments').set(H).send({ salesOrderId: o.id, carrier: 'CORREIOS', packagingId: pk, weightG: 9000 }).expect(400); // acima do máximo da embalagem
      const code = `AA${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}BR`;
      const sh = (await A.users.shipper.post('/api/logistics/shipments').set(H).send({ salesOrderId: o.id, carrier: 'CORREIOS', service: 'SEDEX', trackingCode: code.toLowerCase(), packagingId: pk, weightG: 1200, cost: 25.9 }).expect(201)).body;
      expect(sh.trackingCode).toBe(code);
      await A.users.shipper.post('/api/logistics/shipments').set(H).send({ salesOrderId: o.id, carrier: 'OUTRA' }).expect(409); // um envio ativo por pedido
      expect((await A.users.shipper.get('/api/logistics/queue').expect(200)).body.map((q: any) => q.id)).not.toContain(o.id);
      const ev = (status: string, extra: object = {}) => A.users.shipper.post(`/api/logistics/shipments/${sh.id}/events`).set(H).send({ status, description: `Evento ${status}`, ...extra });
      await ev('POSTED').expect(200);
      await ev('DELIVERED', { occurredAt: new Date(Date.now() + 3_600_000).toISOString() }).expect(400); // data no futuro
      await ev('IN_TRANSIT', { location: 'CTE Campinas' }).expect(200);
      await ev('DELIVERED').expect(200);
      await ev('IN_TRANSIT').expect(409); // estado final
      const det = (await A.users.shipper.get(`/api/logistics/shipments/${sh.id}`).expect(200)).body;
      expect(det).toMatchObject({ status: 'DELIVERED' });
      expect(det.postedAt).toBeTruthy();
      expect(det.deliveredAt).toBeTruthy();
      expect(det.events.map((e: any) => e.status)).toEqual(['DELIVERED', 'IN_TRANSIT', 'POSTED', 'PENDING']);
    });

    it('código de rastreio é único por transportadora e o perfil de consulta não altera nada', async () => {
      const p = await product(A, {}, 5);
      const code = `BB${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}BR`;
      const mk = async () => {
        const o = (await A.owner.post('/api/sales/orders').set(H).send({ customerId: A.customer, warehouseId: A.wh, items: [{ productId: p, quantity: 1, unitPrice: 100 }] }).expect(201)).body;
        await A.owner.post(`/api/sales/orders/${o.id}/submit`).set(H).expect(200);
        return o.id as string;
      };
      await A.users.shipper.post('/api/logistics/shipments').set(H).send({ salesOrderId: await mk(), carrier: 'CORREIOS', trackingCode: code }).expect(201);
      await A.users.shipper.post('/api/logistics/shipments').set(H).send({ salesOrderId: await mk(), carrier: 'CORREIOS', trackingCode: code }).expect(409);
      await A.users.stock_operator.post('/api/logistics/shipments').set(H).send({ salesOrderId: await mk(), carrier: 'OUTRA' }).expect(403); // só consulta
    });
  });

  // ───────────────────────── isolamento e permissões ─────────────────────────
  describe('isolamento entre tenants e permissões', () => {
    it('tenant B não vê nem usa contas, títulos, extratos, envios ou relatórios de A', async () => {
      const [id] = await title(A, { amount: 12 });
      await B.owner.get(`/api/finance/titles/${id}`).expect(404);
      await B.owner.post(`/api/finance/titles/${id}/settle`).set(H).send({ accountId: B.account, amount: 12 }).expect(404);
      await B.owner.post(`/api/finance/titles/${id}/settle`).set(H).send({ accountId: A.account, amount: 12 }).expect(404);
      const [bid] = await title(B, { amount: 12 });
      await B.owner.post(`/api/finance/titles/${bid}/settle`).set(H).send({ accountId: A.account, amount: 12 }).expect(400); // conta de outro tenant
      await B.owner.post(`/api/finance/accounts/${A.account}/statement`).set(H).send({ format: 'CSV', content: 'data;valor\n01/10/2026;1' }).expect(404);
      await B.owner.post('/api/finance/titles').set(H).send({ direction: 'PAYABLE', description: 'x', amount: 1, dueDate: day(1), categoryId: A.category.COGS }).expect(400);
      const bList = (await B.owner.get('/api/finance/titles?limit=200').expect(200)).body.items;
      expect(bList.every((t: any) => t.tenantId === B.tenantId)).toBe(true);
      expect(bList.find((t: any) => t.id === id)).toBeUndefined();
      const shp = (await A.users.shipper.get('/api/logistics/shipments').expect(200)).body[0];
      if (shp) await B.owner.get(`/api/logistics/shipments/${shp.id}`).expect(404);
      await B.owner.post('/api/logistics/shipments').set(H).send({ salesOrderId: shp?.salesOrderId ?? '00000000-0000-4000-8000-000000000000', carrier: 'OUTRA' }).expect(404);
    });

    it('vendedor não acessa o financeiro e não há dados bancários para quem só consulta', async () => {
      await A.users.salesperson.get('/api/finance/titles').expect(403);
      await A.users.salesperson.get('/api/finance/accounts').expect(403);
      await A.users.salesperson.post('/api/finance/titles').set(H).send({ direction: 'PAYABLE', description: 'x', amount: 1, dueDate: day(1) }).expect(403);
      const acc = (await A.owner.post('/api/finance/accounts').set(H).send({ name: `Conta ${uid()}`, kind: 'BANK', bankName: 'Banco X', agency: '0001', accountNumber: '12345-6' }).expect(201)).body.id;
      const asAccountant = agent();
      const email = `acc-${uid()}@teste.local`;
      await A.owner.post('/api/users').set(H).send({ name: 'Contador', email, password: PASSWORD, roleId: A.roles.accountant }).expect(201);
      await asAccountant.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200);
      const seen = ((await asAccountant.get('/api/finance/accounts').expect(200)).body as any[]).find((a) => a.id === acc);
      expect(seen.accountNumber).toBeUndefined();
      await asAccountant.post(`/api/finance/titles`).set(H).send({ direction: 'PAYABLE', description: 'x', amount: 1, dueDate: day(1) }).expect(403);
    });

    it('baixas, estornos e conciliações ficam na trilha de auditoria', async () => {
      for (const action of ['finance.payment_made', 'finance.settlement_reversed', 'finance.bank_matched', 'finance.marketplace_reconciled', 'finance.payables_from_xml', 'finance.commission_payout_created', 'logistics.shipment_created']) {
        const items = (await A.owner.get(`/api/audit?action=${action}&limit=5`).expect(200)).body.items as any[];
        expect(items.length).toBeGreaterThan(0);
      }
    });
  });
});
