import { BadRequestException, Injectable } from '@nestjs/common';
import { AuthContext } from '../common/auth';
import { fromCents, toCents } from '../commissions/commissions.service';
import { PrismaService } from '../prisma/prisma.service';
import { startOfDay } from './finance.service';

const DAY = 86_400_000;
const MAX_RANGE_DAYS = 400;

export type Granularity = 'day' | 'week' | 'month';

function bucketStart(d: Date, g: Granularity): Date {
  const x = startOfDay(d);
  if (g === 'day') return x;
  if (g === 'week') return new Date(x.getTime() - ((x.getUTCDay() + 6) % 7) * DAY); // segunda-feira
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 1));
}
function nextBucket(d: Date, g: Granularity): Date {
  if (g === 'day') return new Date(d.getTime() + DAY);
  if (g === 'week') return new Date(d.getTime() + 7 * DAY);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

export function parseRange(from: string, to: string): { from: Date; to: Date } {
  const f = startOfDay(new Date(from));
  const t = startOfDay(new Date(to));
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime()) || t < f) throw new BadRequestException('Período inválido.');
  if ((t.getTime() - f.getTime()) / DAY > MAX_RANGE_DAYS) throw new BadRequestException(`O período máximo é de ${MAX_RANGE_DAYS} dias.`);
  return { from: f, to: t };
}

@Injectable()
export class StatementsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Fluxo de caixa: realizado (baixas), previsto (vencimentos) e saldo projetado.
   * Saldo inicial = saldos de abertura das contas + baixas anteriores ao período.
   * O realizado respeita o filtro de conta; títulos ainda não baixados não têm conta, então o previsto não é filtrado por ela.
   */
  cashflow(ctx: AuthContext, q: { from: string; to: string; granularity?: Granularity; accountId?: string; costCenterId?: string }) {
    const { from, to } = parseRange(q.from, q.to);
    const g = q.granularity ?? 'day';
    const end = new Date(to.getTime() + DAY); // exclusivo
    const today = startOfDay(new Date());
    return this.prisma.withContext(ctx, async (tx) => {
      const acc = q.accountId ?? null;
      const cc = q.costCenterId ?? null;
      const [open] = await tx.$queryRaw<{ opening: string | null }[]>`SELECT sum(opening_balance) AS opening FROM financial_accounts WHERE tenant_id = ${ctx.tenantId}::uuid AND (${acc}::uuid IS NULL OR id = ${acc}::uuid)`;
      const [prior] = await tx.$queryRaw<{ net: string | null }[]>`
        SELECT sum(CASE t.direction WHEN 'RECEIVABLE' THEN s.amount ELSE -s.amount END) AS net FROM financial_settlements s JOIN financial_titles t ON t.id = s.title_id
        WHERE s.tenant_id = ${ctx.tenantId}::uuid AND s.paid_at < ${from} AND (${acc}::uuid IS NULL OR s.account_id = ${acc}::uuid) AND (${cc}::uuid IS NULL OR t.cost_center_id = ${cc}::uuid)`;
      const settled = await tx.$queryRaw<{ paid_at: Date; direction: string; amount: string }[]>`
        SELECT s.paid_at, t.direction, s.amount FROM financial_settlements s JOIN financial_titles t ON t.id = s.title_id
        WHERE s.tenant_id = ${ctx.tenantId}::uuid AND s.paid_at >= ${from} AND s.paid_at < ${end} AND (${acc}::uuid IS NULL OR s.account_id = ${acc}::uuid) AND (${cc}::uuid IS NULL OR t.cost_center_id = ${cc}::uuid)`;
      const titles = await tx.$queryRaw<{ due_date: Date; direction: string; amount: string; outstanding: string; status: string }[]>`
        SELECT due_date, direction, amount, (amount - paid_principal) AS outstanding, status FROM financial_titles
        WHERE tenant_id = ${ctx.tenantId}::uuid AND status <> 'CANCELLED' AND (${cc}::uuid IS NULL OR cost_center_id = ${cc}::uuid)
          AND ((due_date >= ${from} AND due_date < ${end}) OR (status IN ('OPEN','PARTIAL') AND due_date < ${today}))`;
      const mkt = await tx.$queryRaw<{ expected_date: Date | null; net: string }[]>`
        SELECT expected_date, net_reported AS net FROM marketplace_settlements WHERE tenant_id = ${ctx.tenantId}::uuid AND received_date IS NULL AND title_id IS NULL AND status <> 'RECONCILED'
          AND expected_date IS NOT NULL AND expected_date >= ${today} AND expected_date < ${end}`;

      const buckets: { start: Date; end: Date; [k: string]: number | Date }[] = [];
      for (let s = bucketStart(from, g); s < end; s = nextBucket(s, g)) buckets.push({ start: s, end: nextBucket(s, g), scheduledIn: 0, scheduledOut: 0, realizedIn: 0, realizedOut: 0, pendingIn: 0, pendingOut: 0, marketplaceIn: 0 });
      const at = (d: Date) => buckets.find((b) => d >= b.start && d < b.end) ?? null;
      const todayBucket = buckets.find((b) => today >= b.start && today < b.end) ?? buckets.find((b) => b.start >= today) ?? null;
      const add = (b: (typeof buckets)[number] | null, k: string, cents: number) => { if (b) b[k] = (b[k] as number) + cents; };

      for (const s of settled) add(at(s.paid_at), s.direction === 'RECEIVABLE' ? 'realizedIn' : 'realizedOut', toCents(s.amount));
      let overdueIn = 0;
      let overdueOut = 0;
      for (const t of titles) {
        const inRange = t.due_date >= from && t.due_date < end;
        const open = t.status === 'OPEN' || t.status === 'PARTIAL';
        if (inRange) add(at(t.due_date), t.direction === 'RECEIVABLE' ? 'scheduledIn' : 'scheduledOut', toCents(t.amount));
        if (!open) continue;
        const out = toCents(t.outstanding);
        if (t.due_date < today) { // vencido: aparece como pendência a regularizar a partir de hoje
          if (t.direction === 'RECEIVABLE') overdueIn += out; else overdueOut += out;
          add(todayBucket, t.direction === 'RECEIVABLE' ? 'pendingIn' : 'pendingOut', out);
        } else if (inRange) add(at(t.due_date), t.direction === 'RECEIVABLE' ? 'pendingIn' : 'pendingOut', out);
      }
      for (const m of mkt) add(at(m.expected_date!), 'marketplaceIn', toCents(m.net));

      let running = toCents(open?.opening ?? 0) + toCents(prior?.net ?? 0);
      const opening = running;
      const rows = buckets.map((b) => {
        const wholePast = b.end <= today;
        const net = (b.realizedIn as number) - (b.realizedOut as number) + (wholePast ? 0 : (b.pendingIn as number) - (b.pendingOut as number) + (b.marketplaceIn as number));
        running += net;
        return {
          start: b.start.toISOString().slice(0, 10), end: new Date(b.end.getTime() - DAY).toISOString().slice(0, 10),
          scheduledIn: fromCents(b.scheduledIn as number), scheduledOut: fromCents(b.scheduledOut as number),
          realizedIn: fromCents(b.realizedIn as number), realizedOut: fromCents(b.realizedOut as number),
          pendingIn: fromCents(b.pendingIn as number), pendingOut: fromCents(b.pendingOut as number), marketplaceExpectedIn: fromCents(b.marketplaceIn as number),
          closingBalance: fromCents(running), projected: !wholePast,
        };
      });
      return {
        from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), granularity: g, openingBalance: fromCents(opening), overdue: { receivable: fromCents(overdueIn), payable: fromCents(overdueOut) }, rows,
        notes: ['Saldo projetado = saldo inicial + realizado + pendente (vencidos entram no período que contém hoje).', 'O pendente não é filtrado por conta porque títulos em aberto ainda não têm conta de baixa.'],
      };
    });
  }

  /**
   * DRE gerencial. Regime: receita pela DATA DE EXPEDIÇÃO; custo pelo custo cadastrado quando o pedido foi confirmado;
   * despesas pelo VENCIMENTO dos títulos; comissões pela data de aprovação. Não substitui a escrituração contábil.
   */
  dre(ctx: AuthContext, q: { from: string; to: string; costCenterId?: string }) {
    const { from, to } = parseRange(q.from, q.to);
    const end = new Date(to.getTime() + DAY);
    return this.prisma.withContext(ctx, async (tx) => {
      const cc = q.costCenterId ?? null;
      const [rev] = await tx.$queryRaw<{ gross: string | null; discounts: string | null; orders: number }[]>`
        SELECT sum(subtotal) AS gross, sum(discount_total) AS discounts, count(*)::int AS orders FROM sales_orders
        WHERE tenant_id = ${ctx.tenantId}::uuid AND status IN ('SHIPPED','DELIVERED','CLOSED') AND shipped_at >= ${from} AND shipped_at < ${end}`;
      const [cogs] = await tx.$queryRaw<{ cost: string | null; missing: number }[]>`
        SELECT sum(i.quantity * COALESCE(i.cost_snapshot, 0)) AS cost, count(*) FILTER (WHERE i.cost_snapshot IS NULL)::int AS missing
        FROM sales_order_items i JOIN sales_orders o ON o.id = i.order_id
        WHERE o.tenant_id = ${ctx.tenantId}::uuid AND o.status IN ('SHIPPED','DELIVERED','CLOSED') AND o.shipped_at >= ${from} AND o.shipped_at < ${end}`;
      const [ret] = await tx.$queryRaw<{ value: string | null; restocked_cost: string | null }[]>`
        SELECT sum(ri.quantity * (i.total / i.quantity)) AS value, sum(CASE WHEN r.restock THEN ri.quantity * COALESCE(i.cost_snapshot, 0) ELSE 0 END) AS restocked_cost
        FROM return_items ri JOIN return_requests r ON r.id = ri.return_id JOIN sales_order_items i ON i.id = ri.order_item_id
        WHERE r.tenant_id = ${ctx.tenantId}::uuid AND r.created_at >= ${from} AND r.created_at < ${end}`;
      const [com] = await tx.$queryRaw<{ total: string | null }[]>`
        SELECT sum(amount) AS total FROM sales_commissions WHERE tenant_id = ${ctx.tenantId}::uuid AND status IN ('EARNED','PAID') AND earned_at >= ${from} AND earned_at < ${end}`;
      const [mkt] = await tx.$queryRaw<{ fees: string | null }[]>`
        SELECT sum(commission + fixed_fee + payment_fee + shipping) AS fees FROM marketplace_settlements
        WHERE tenant_id = ${ctx.tenantId}::uuid AND COALESCE(received_date, expected_date, created_at) >= ${from} AND COALESCE(received_date, expected_date, created_at) < ${end}`;
      const titles = await tx.$queryRaw<{ direction: string; kind: string | null; total: string; n: number }[]>`
        SELECT t.direction, c.kind, sum(t.amount) AS total, count(*)::int AS n FROM financial_titles t LEFT JOIN financial_categories c ON c.id = t.category_id
        WHERE t.tenant_id = ${ctx.tenantId}::uuid AND t.status <> 'CANCELLED' AND t.due_date >= ${from} AND t.due_date < ${end}
          AND (${cc}::uuid IS NULL OR t.cost_center_id = ${cc}::uuid) AND NOT (t.direction = 'RECEIVABLE' AND t.origin IN ('SALES_ORDER','MARKETPLACE'))
          AND t.origin <> 'COMMISSION' AND t.origin <> 'MARKETPLACE'
        GROUP BY t.direction, c.kind`;

      const sum = (direction: string, kind: string | null) => toCents(titles.find((t) => t.direction === direction && t.kind === kind)?.total ?? 0);
      const uncategorized = sum('PAYABLE', null);
      const grossSales = toCents(rev?.gross ?? 0);
      const otherRevenue = sum('RECEIVABLE', 'REVENUE');
      const grossRevenue = grossSales + otherRevenue;
      const discounts = toCents(rev?.discounts ?? 0);
      const returns = toCents(ret?.value ?? 0);
      const taxDeductions = sum('PAYABLE', 'DEDUCTION');
      const deductions = discounts + returns + taxDeductions;
      const netRevenue = grossRevenue - deductions;
      const cmv = toCents(cogs?.cost ?? 0) - toCents(ret?.restocked_cost ?? 0) + sum('PAYABLE', 'COGS');
      const grossMargin = netRevenue - cmv;
      const commissions = toCents(com?.total ?? 0);
      const marketplaceFees = toCents(mkt?.fees ?? 0);
      const variable = commissions + marketplaceFees + sum('PAYABLE', 'VARIABLE_EXPENSE');
      const contribution = grossMargin - variable;
      const operating = sum('PAYABLE', 'OPERATING_EXPENSE') + sum('PAYABLE', 'FINANCIAL') + sum('PAYABLE', 'OTHER') + uncategorized;
      const result = contribution - operating;
      const pct = (v: number) => (netRevenue > 0 ? Math.round((v / netRevenue) * 10000) / 100 : null);
      const line = (key: string, label: string, v: number, extra: object = {}) => ({ key, label, amount: fromCents(v), pctOfNetRevenue: pct(v), ...extra });
      const warnings: string[] = [];
      if ((cogs?.missing ?? 0) > 0) warnings.push(`${cogs!.missing} item(ns) vendido(s) sem custo cadastrado: o CMV está subestimado.`);
      if (uncategorized) warnings.push(`R$ ${fromCents(uncategorized)} em contas a pagar sem categoria foram lançados em despesas operacionais.`);
      return {
        from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), orders: rev?.orders ?? 0,
        lines: [
          line('gross_revenue', 'Receita bruta', grossRevenue, { detail: { vendas: fromCents(grossSales), outrasReceitas: fromCents(otherRevenue) } }),
          line('deductions', '(−) Deduções', -deductions, { detail: { descontosConcedidos: fromCents(discounts), devolucoes: fromCents(returns), impostosSobreVendasLancados: fromCents(taxDeductions) } }),
          line('net_revenue', 'Receita líquida', netRevenue),
          line('cogs', '(−) Custo das mercadorias vendidas', -cmv),
          line('gross_margin', 'Margem bruta', grossMargin),
          line('variable_expenses', '(−) Despesas variáveis', -variable, { detail: { comissoesDeVendedores: fromCents(commissions), tarifasDeMarketplace: fromCents(marketplaceFees), outras: fromCents(sum('PAYABLE', 'VARIABLE_EXPENSE')) } }),
          line('contribution_margin', 'Margem de contribuição', contribution),
          line('operating_expenses', '(−) Despesas operacionais', -operating, { detail: { operacionais: fromCents(sum('PAYABLE', 'OPERATING_EXPENSE')), financeiras: fromCents(sum('PAYABLE', 'FINANCIAL')), outras: fromCents(sum('PAYABLE', 'OTHER')), semCategoria: fromCents(uncategorized) } }),
          line('result', 'Resultado gerencial', result),
        ],
        warnings,
        basis: 'Gerencial: receita pela data de expedição; CMV pelo custo cadastrado na confirmação do pedido (devoluções repostas abatem); despesas pelo vencimento do título; comissões pela data de aprovação. Tributos sobre vendas só entram se lançados em categorias de Dedução. Não substitui a escrituração contábil oficial.',
      };
    });
  }
}
