import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);
const PAST = '2026-09'; // mês já encerrado (os testes rodam em 2026-10 ou depois)
const thisMonth = new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 7);

describe('Comissão por meta: faixas, apuração do mês encerrado e repasse junto com as comissões', () => {
  let app: INestApplication; let admin: PrismaClient;
  type Agent = ReturnType<typeof request.agent>;
  let owner: Agent; let tenantId: string; let wh: string; let product: string;
  let ana: string; let beto: string; let carla: string;
  let seq = 0;

  async function sell(salespersonId: string, price: number) {
    const c = (await owner.post('/api/customers').set(H).send({ kind: 'PF', name: `Cli ${run}${++seq}` }).expect(201)).body.id;
    const o = (await owner.post('/api/sales/orders').set(H).send({ customerId: c, warehouseId: wh, salespersonId, paymentMethod: 'PIX', items: [{ productId: product, quantity: 1, unitPrice: price }] }).expect(201)).body.id as string;
    await owner.post(`/api/sales/orders/${o}/submit`).set(H).expect(200);
    return o;
  }
  /** Leva a confirmação do pedido para o mês encerrado (simula uma venda feita lá atrás). */
  const backdate = (orderId: string) => admin.$executeRaw`UPDATE sales_orders SET confirmed_at = '2026-09-15T15:00:00Z' WHERE id = ${orderId}::uuid`;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication(); configureApp(app); await app.listen(0);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    owner = request.agent(app.getHttpServer());
    const r = await owner.post('/api/auth/register').set(H).send({ companyName: `Co gb ${run}`, name: 'Dono', email: `gb-${run}@teste.local`, password: PASSWORD }).expect(201);
    tenantId = r.body.tenantId;
    const company = await owner.post('/api/companies').set(H).send({ legalName: 'GB LTDA' }).expect(201);
    const est = await owner.post('/api/establishments').set(H).send({ companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz' }).expect(201);
    wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
    product = (await owner.post('/api/products').set(H).send({ sku: `GB-${run}`, name: 'Produto', costPrice: 1, suggestedPrice: 10 }).expect(201)).body.id;
    await owner.post('/api/stock/movements').set(H).send({ productId: product, warehouseId: wh, type: 'PURCHASE_ENTRY', quantity: 500 }).expect(201);
    ana = (await owner.post('/api/salespeople').set(H).send({ name: 'Ana' }).expect(201)).body.id;
    beto = (await owner.post('/api/salespeople').set(H).send({ name: 'Beto' }).expect(201)).body.id;
    carla = (await owner.post('/api/salespeople').set(H).send({ name: 'Carla' }).expect(201)).body.id;
  }, 60_000);
  afterAll(async () => { await admin.$disconnect(); await app.close(); });

  it('cadastra faixas válidas, exige percentual/valor conforme o tipo e só quem gere comissões mexe', async () => {
    await owner.post('/api/goal-bonus-tiers').set(H).send({ name: 'Bateu a meta', minPct: 100, kind: 'PERCENT', percent: 1 }).expect(201);
    await owner.post('/api/goal-bonus-tiers').set(H).send({ name: 'Superou 120%', minPct: 120, kind: 'PERCENT', percent: 2 }).expect(201);
    const fixed = (await owner.post('/api/goal-bonus-tiers').set(H).send({ name: 'Prêmio 150%', minPct: 150, kind: 'FIXED', fixedAmount: 25 }).expect(201)).body;
    await owner.post('/api/goal-bonus-tiers').set(H).send({ name: 'Sem valor', minPct: 100, kind: 'PERCENT' }).expect(400);
    await owner.post('/api/goal-bonus-tiers').set(H).send({ name: 'Zero', minPct: 0, kind: 'PERCENT', percent: 1 }).expect(400);
    await owner.post('/api/goal-bonus-tiers').set(H).send({ name: 'Absurdo', minPct: 100, kind: 'PERCENT', percent: 500 }).expect(400);
    expect((await owner.get('/api/goal-bonus-tiers').expect(200)).body).toHaveLength(3);
    await owner.put(`/api/goal-bonus-tiers/${fixed.id}/active`).set(H).send({ active: false }).expect(200);
    await owner.put(`/api/goal-bonus-tiers/${fixed.id}/active`).set(H).send({ active: true }).expect(200);
    await owner.put(`/api/goal-bonus-tiers/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}/active`).set(H).send({ active: true }).expect(404);
  });

  it('mês corrente é só projeção e não pode ser apurado; apura o mês encerrado com a maior faixa atingida', async () => {
    // Ana: meta 200, vendeu 260 (130%) → faixa 120% = 2% de 260 = 5,20
    // Beto: meta 100, vendeu 100 (100%) → faixa 100% = 1% de 100 = 1,00
    // Carla: meta 500, vendeu 100 (20%) → nenhuma faixa
    for (const p of [130, 130]) await backdate(await sell(ana, p));
    await backdate(await sell(beto, 100));
    await backdate(await sell(carla, 100));
    await owner.put('/api/management/goals').set(H).send({ period: PAST, items: [{ salespersonId: ana, amount: 200 }, { salespersonId: beto, amount: 100 }, { salespersonId: carla, amount: 500 }] }).expect(200);

    const proj = (await owner.get(`/api/goal-bonus?period=${PAST}`).expect(200)).body;
    expect(proj.closed).toBe(true);
    const by = Object.fromEntries(proj.rows.map((r: any) => [r.name, r]));
    expect(by.Ana).toMatchObject({ pct: 130, tier: { name: 'Superou 120%' }, bonus: '5.20', status: 'PROJECTED' });
    expect(by.Beto).toMatchObject({ pct: 100, tier: { name: 'Bateu a meta' }, bonus: '1.00' });
    expect(by.Carla).toMatchObject({ pct: 20, tier: null, bonus: '0.00' });

    await owner.post('/api/goal-bonus/close').set(H).send({ period: thisMonth }).expect(409); // mês aberto
    await owner.post('/api/goal-bonus/close').set(H).send({ period: '2026-13' }).expect(400);
    const closed = (await owner.post('/api/goal-bonus/close').set(H).send({ period: PAST }).expect(200)).body;
    expect(closed).toMatchObject({ created: 3, total: '6.20' });
    // repetir não duplica
    expect((await owner.post('/api/goal-bonus/close').set(H).send({ period: PAST }).expect(200)).body).toMatchObject({ created: 0, total: '0.00' });
    const after = Object.fromEntries((await owner.get(`/api/goal-bonus?period=${PAST}`).expect(200)).body.rows.map((r: any) => [r.name, r]));
    expect(after.Ana).toMatchObject({ status: 'EARNED', bonus: '5.20' });
    expect(after.Carla.status).toBe('NONE');
  });

  it('o apurado fica congelado: mudar ou desligar as faixas depois não o altera', async () => {
    const before = await admin.goalBonus.findMany({ where: { tenantId, period: PAST }, orderBy: { amount: 'desc' } });
    const tiers = (await owner.get('/api/goal-bonus-tiers').expect(200)).body;
    for (const t of tiers) await owner.put(`/api/goal-bonus-tiers/${t.id}/active`).set(H).send({ active: false }).expect(200);
    const r = (await owner.get(`/api/goal-bonus?period=${PAST}`).expect(200)).body.rows.find((x: any) => x.name === 'Ana');
    expect(r).toMatchObject({ bonus: '5.20', status: 'EARNED' });
    for (const t of tiers) await owner.put(`/api/goal-bonus-tiers/${t.id}/active`).set(H).send({ active: true }).expect(200);
    expect(before.map((b) => String(b.amount))).toEqual(['5.2', '1', '0']);
  });

  it('o bônus entra no repasse de comissões do vendedor (título a pagar) e vira PAGO quando o título é baixado', async () => {
    await owner.post('/api/finance/commission-payout').set(H).send({ salespersonId: carla, dueDate: '2026-12-10' }).expect(409); // só tem bônus 0
    const out = (await owner.post('/api/finance/commission-payout').set(H).send({ salespersonId: ana, dueDate: '2026-12-10' }).expect(201)).body;
    expect(out.total).toBe('5.20');
    const bonus = await admin.goalBonus.findFirstOrThrow({ where: { tenantId, salespersonId: ana, period: PAST } });
    expect(bonus.payoutTitleId).toBe(out.titleId);
    await owner.post('/api/finance/commission-payout').set(H).send({ salespersonId: ana, dueDate: '2026-12-10' }).expect(409); // já repassado
    // cancelar o título libera o bônus para um novo repasse
    await owner.post(`/api/finance/titles/${out.titleId}/cancel`).set(H).send({ reason: 'Refazer repasse' }).expect(200);
    expect((await admin.goalBonus.findFirstOrThrow({ where: { id: bonus.id } })).payoutTitleId).toBeNull();
    const again = (await owner.post('/api/finance/commission-payout').set(H).send({ salespersonId: ana, dueDate: '2026-12-11' }).expect(201)).body;
    const acc = (await owner.post('/api/finance/accounts').set(H).send({ name: `Caixa ${run}`, kind: 'CASH' }).expect(201)).body.id;
    await owner.post(`/api/finance/titles/${again.titleId}/settle`).set(H).send({ accountId: acc, amount: 5.2, paidAt: '2026-12-11' }).expect(200);
    expect((await admin.goalBonus.findFirstOrThrow({ where: { id: bonus.id } })).status).toBe('PAID');
  });

  it('pagamento direto de comissões também inclui o bônus e só o próprio vendedor vê o seu', async () => {
    const pay = (await owner.post('/api/commissions/pay').set(H).send({ salespersonId: beto }).expect(200)).body;
    expect(pay).toMatchObject({ paid: '1.00', entries: 1 });
    expect((await admin.goalBonus.findFirstOrThrow({ where: { tenantId, salespersonId: beto, period: PAST } })).status).toBe('PAID');
    // vendedor com usuário vê só o próprio bônus
    const roles = Object.fromEntries((await owner.get('/api/roles').expect(200)).body.map((x: any) => [x.key, x.id]));
    const email = `anaux-${run}@teste.local`;
    const u = (await owner.post('/api/users').set(H).send({ name: 'Ana U', email, password: PASSWORD, roleId: roles.salesperson }).expect(201)).body;
    await owner.put(`/api/salespeople/${ana}`).set(H).send({ name: 'Ana' }).expect(200);
    await admin.salesperson.update({ where: { id: ana }, data: { userId: u.userId } });
    const a = request.agent(app.getHttpServer());
    await a.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200);
    const mine = (await a.get(`/api/goal-bonus?period=${PAST}`).expect(200)).body.rows;
    expect(mine.map((r: any) => r.name)).toEqual(['Ana']);
    await a.post('/api/goal-bonus/close').set(H).send({ period: PAST }).expect(403);
    await a.get('/api/goal-bonus-tiers').expect(403);
  });

  it('isola por empresa', async () => {
    const other = request.agent(app.getHttpServer());
    await other.post('/api/auth/register').set(H).send({ companyName: `Co gb2 ${run}`, name: 'Outro', email: `gb2-${run}@teste.local`, password: PASSWORD }).expect(201);
    expect((await other.get('/api/goal-bonus-tiers').expect(200)).body).toEqual([]);
    expect((await other.get(`/api/goal-bonus?period=${PAST}`).expect(200)).body.rows).toEqual([]);
  });
});
