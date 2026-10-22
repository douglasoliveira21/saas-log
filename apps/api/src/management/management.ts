import { BadRequestException, Body, Controller, Get, Injectable, Put, Query, Res } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import type { Response } from 'express';
import { strToU8, zipSync } from 'fflate';
import { AuditService } from '../audit/audit.service';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { fromCents, toCents } from '../commissions/commissions.service';
import { StatementsService } from '../finance/statements.service';
import { PrismaService } from '../prisma/prisma.service';
import { toCsv, type Cell, type Column } from '../reports/export';

type Tx = Prisma.TransactionClient;
type Row = Record<string, Cell>;
const DAY = 86_400_000;
const BRT = 3 * 3_600_000; // Brasília = UTC−3 (sem horário de verão)
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const money = { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false } as const;
const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (num: number, den: number) => (den > 0 ? round2((num / den) * 100) : null);

/** Início (inclusive) e fim (exclusive) do mês `YYYY-MM` no fuso de Brasília. */
export function monthRange(period: string): { start: Date; end: Date; days: number } {
  if (!PERIOD.test(period)) throw new BadRequestException('Período inválido: use AAAA-MM.');
  const [y, m] = period.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1) + BRT);
  const end = new Date(Date.UTC(y, m, 1) + BRT);
  return { start, end, days: Math.round((end.getTime() - start.getTime()) / DAY) };
}
const localDate = (d = new Date()) => new Date(d.getTime() - BRT).toISOString().slice(0, 10);
const currentPeriod = () => localDate().slice(0, 7);

function range(from?: string, to?: string, defaultDays = 30) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const f = from ?? localDate(new Date(Date.now() - defaultDays * DAY)); const t = to ?? localDate();
  if (!re.test(f) || !re.test(t) || Number.isNaN(Date.parse(f)) || Number.isNaN(Date.parse(t)) || t < f) throw new BadRequestException('Período inválido.');
  return { from: f, to: t, start: new Date(Date.parse(`${f}T00:00:00Z`) + BRT), end: new Date(Date.parse(`${t}T00:00:00Z`) + BRT + DAY) };
}

class GoalItem { @IsUUID() salespersonId: string; @IsNumber(money) @Min(0) @Max(1e9) amount: number }
class GoalsDto { @Matches(PERIOD) period: string; @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => GoalItem) items: GoalItem[] }
class BudgetItem { @IsString() @MaxLength(40) lineKey: string; @Matches(PERIOD) period: string; @IsNumber(money) @Min(0) @Max(1e10) amount: number }
class BudgetDto { @IsArray() @ArrayMaxSize(1200) @ValidateNested({ each: true }) @Type(() => BudgetItem) lines: BudgetItem[] }
class RangeQuery {
  @IsOptional() @IsString() @MaxLength(10) from?: string;
  @IsOptional() @IsString() @MaxLength(10) to?: string;
  @IsOptional() @IsIn(['product', 'customer', 'order']) by?: 'product' | 'customer' | 'order';
  @IsOptional() @IsString() @MaxLength(7) period?: string;
  @IsOptional() @IsString() @MaxLength(4) year?: string;
  @IsOptional() @IsString() @MaxLength(3) days?: string;
  @IsOptional() @IsString() @MaxLength(2) leadDays?: string;
}

/**
 * Gestão: metas de vendas, margem real, giro/ruptura/previsão de estoque, orçamento financeiro e pacote do contador.
 * Tudo é calculado em centavos a partir dos dados do sistema; nada aqui altera estoque, pedidos ou títulos.
 */
@Injectable()
export class ManagementService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly statements: StatementsService) {}

  // ───────────── metas ─────────────

  goals(ctx: AuthContext, periodIn?: string) {
    const period = periodIn ?? currentPeriod();
    const { start, end, days } = monthRange(period);
    return this.prisma.withContext(ctx, async (tx) => {
      const [people, goals, sold, returned] = await Promise.all([
        tx.salesperson.findMany({ where: { tenantId: ctx.tenantId!, active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
        tx.salesGoal.findMany({ where: { tenantId: ctx.tenantId!, period } }),
        tx.$queryRaw<{ salesperson_id: string; amount: string; orders: number }[]>`
          SELECT salesperson_id, sum(total) AS amount, count(*)::int AS orders FROM sales_orders
          WHERE tenant_id = ${ctx.tenantId}::uuid AND salesperson_id IS NOT NULL AND status NOT IN ('DRAFT','PENDING_APPROVAL','CANCELLED') AND confirmed_at >= ${start} AND confirmed_at < ${end}
          GROUP BY salesperson_id`,
        tx.$queryRaw<{ salesperson_id: string; value: string }[]>`
          SELECT o.salesperson_id, sum(ri.quantity * i.total / i.quantity) AS value FROM return_items ri
          JOIN sales_order_items i ON i.id = ri.order_item_id JOIN sales_orders o ON o.id = i.order_id
          WHERE o.tenant_id = ${ctx.tenantId}::uuid AND o.salesperson_id IS NOT NULL AND o.status NOT IN ('DRAFT','PENDING_APPROVAL','CANCELLED') AND o.confirmed_at >= ${start} AND o.confirmed_at < ${end}
          GROUP BY o.salesperson_id`,
      ]);
      const today = localDate();
      const elapsed = period < today.slice(0, 7) ? days : period > today.slice(0, 7) ? 0 : Number(today.slice(8, 10));
      const rows = people.map((p) => {
        const goal = goals.find((g) => g.salespersonId === p.id);
        const gross = toCents(sold.find((s) => s.salesperson_id === p.id)?.amount ?? 0);
        const ret = toCents(returned.find((r) => r.salesperson_id === p.id)?.value ?? 0);
        const achieved = gross - ret;
        const goalCents = goal ? toCents(goal.amount) : 0;
        const projected = elapsed > 0 && elapsed < days ? Math.round((achieved / elapsed) * days) : achieved;
        return {
          salespersonId: p.id, name: p.name, goal: goal ? fromCents(goalCents) : null, achieved: fromCents(achieved), returns: fromCents(ret), orders: sold.find((s) => s.salesperson_id === p.id)?.orders ?? 0,
          pct: goalCents > 0 ? pct(achieved, goalCents) : null, projected: fromCents(projected), projectedPct: goalCents > 0 ? pct(projected, goalCents) : null,
          missing: goalCents > 0 ? fromCents(Math.max(0, goalCents - achieved)) : null,
        };
      }).sort((a, b) => Number(b.achieved) - Number(a.achieved)).map((r, i) => ({ ...r, rank: i + 1 }));
      const totalGoal = rows.reduce((s, r) => s + toCents(r.goal ?? 0), 0); const totalAchieved = rows.reduce((s, r) => s + toCents(r.achieved), 0);
      return {
        period, daysElapsed: elapsed, daysTotal: days, rows,
        totals: { goal: fromCents(totalGoal), achieved: fromCents(totalAchieved), pct: totalGoal > 0 ? pct(totalAchieved, totalGoal) : null },
        basis: 'Venda confirmada no mês (data da confirmação), líquida de devoluções; pedidos cancelados e de marketplace sem vendedor não entram. Projeção = ritmo médio por dia × dias do mês.',
      };
    });
  }

  setGoals(ctx: AuthContext, dto: GoalsDto) {
    monthRange(dto.period);
    return this.prisma.withContext(ctx, async (tx) => {
      const ids = [...new Set(dto.items.map((i) => i.salespersonId))];
      const found = await tx.salesperson.count({ where: { tenantId: ctx.tenantId!, id: { in: ids } } });
      if (found !== ids.length) throw new BadRequestException('Vendedor inválido.');
      for (const i of dto.items) {
        await tx.salesGoal.upsert({
          where: { tenantId_salespersonId_period: { tenantId: ctx.tenantId!, salespersonId: i.salespersonId, period: dto.period } },
          create: { tenantId: ctx.tenantId!, salespersonId: i.salespersonId, period: dto.period, amount: i.amount }, update: { amount: i.amount },
        });
      }
      await this.audit.record(tx, ctx, { action: 'management.goals_set', entity: 'sales_goal', metadata: { period: dto.period, items: dto.items.length } });
      return { period: dto.period, saved: dto.items.length };
    });
  }

  // ───────────── margem ─────────────

  margin(ctx: AuthContext, q: { from?: string; to?: string; by?: 'product' | 'customer' | 'order' }) {
    const r = range(q.from, q.to);
    const by = q.by ?? 'product';
    return this.prisma.withContext(ctx, async (tx) => {
      const rows = await tx.$queryRaw<{ order_id: string; number: number; shipped_at: Date; customer_id: string; customer: string; product_id: string; sku: string; pname: string; qty: number; ret: number; total: string; cost: string | null }[]>`
        SELECT o.id AS order_id, o.number, o.shipped_at, c.id AS customer_id, c.name AS customer, p.id AS product_id, p.sku, p.name AS pname, i.quantity AS qty,
               COALESCE((SELECT sum(ri.quantity) FROM return_items ri WHERE ri.order_item_id = i.id), 0)::int AS ret, i.total, i.cost_snapshot AS cost
        FROM sales_order_items i JOIN sales_orders o ON o.id = i.order_id JOIN customers c ON c.id = o.customer_id JOIN products p ON p.id = i.product_id
        WHERE o.tenant_id = ${ctx.tenantId}::uuid AND o.status IN ('SHIPPED','DELIVERED','CLOSED') AND o.shipped_at >= ${r.start} AND o.shipped_at < ${r.end}
        LIMIT 100000`;
      type Acc = { key: string; label: string; sub: string; qty: number; revenue: number; cost: number; missing: number; orders: Set<string>; date?: string };
      const map = new Map<string, Acc>();
      for (const x of rows) {
        const net = x.qty - x.ret;
        if (net <= 0) continue;
        const revenue = Math.round(toCents(x.total) * (net / x.qty));
        const key = by === 'product' ? x.product_id : by === 'customer' ? x.customer_id : x.order_id;
        const a = map.get(key) ?? { key, label: by === 'product' ? x.pname : by === 'customer' ? x.customer : `Pedido #${x.number}`, sub: by === 'product' ? x.sku : by === 'order' ? x.customer : '', qty: 0, revenue: 0, cost: 0, missing: 0, orders: new Set<string>(), date: by === 'order' ? x.shipped_at.toISOString().slice(0, 10) : undefined };
        a.qty += net; a.revenue += revenue; a.orders.add(x.order_id);
        if (x.cost === null) a.missing++; else a.cost += Math.round(Number(x.cost) * 100 * net);
        map.set(key, a);
      }
      const items = [...map.values()].map((a) => {
        const margin = a.revenue - a.cost;
        return { key: a.key, label: a.label, sub: a.sub, date: a.date ?? null, quantity: a.qty, orders: a.orders.size, revenue: fromCents(a.revenue), cost: fromCents(a.cost), margin: fromCents(margin), marginPct: pct(margin, a.revenue), itemsWithoutCost: a.missing };
      }).sort((a, b) => Number(b.revenue) - Number(a.revenue));
      const t = items.reduce((s, i) => ({ revenue: s.revenue + toCents(i.revenue), cost: s.cost + toCents(i.cost), missing: s.missing + i.itemsWithoutCost }), { revenue: 0, cost: 0, missing: 0 });
      return {
        from: r.from, to: r.to, by, items: items.slice(0, 500), truncated: items.length > 500,
        totals: { revenue: fromCents(t.revenue), cost: fromCents(t.cost), margin: fromCents(t.revenue - t.cost), marginPct: pct(t.revenue - t.cost, t.revenue), itemsWithoutCost: t.missing },
        basis: 'Margem bruta de mercadoria: venda expedida no período, líquida de devoluções, menos o custo cadastrado do produto quando o pedido foi criado. Não desconta frete, comissão, tarifa de marketplace nem impostos (veja a DRE no Financeiro). Item sem custo cadastrado entra com custo zero e é contado em "sem custo".',
      };
    });
  }

  // ───────────── giro, ruptura e previsão ─────────────

  stockHealth(ctx: AuthContext, q: { days?: number; leadDays?: number }) {
    const days = Math.min(365, Math.max(14, q.days ?? 90));
    const defaultLead = Math.min(60, Math.max(0, q.leadDays ?? 7));
    const now = new Date(); const since = new Date(now.getTime() - days * DAY); const since28 = new Date(now.getTime() - 28 * DAY);
    return this.prisma.withContext(ctx, async (tx) => {
      const [products, stock, sales] = await Promise.all([
        tx.product.findMany({ where: { tenantId: ctx.tenantId!, active: true, kind: 'PHYSICAL' }, select: { id: true, sku: true, name: true, costPrice: true, minStock: true, reorderPoint: true, leadTimeDays: true } }),
        tx.$queryRaw<{ product_id: string; on_hand: number; reserved: number; blocked: number }[]>`
          SELECT product_id, sum(on_hand)::int AS on_hand, sum(reserved)::int AS reserved, sum(blocked)::int AS blocked FROM stock_balances WHERE tenant_id = ${ctx.tenantId}::uuid GROUP BY product_id`,
        tx.$queryRaw<{ product_id: string; qty: number; qty28: number; revenue: string }[]>`
          SELECT i.product_id,
                 sum(i.quantity - COALESCE((SELECT sum(ri.quantity) FROM return_items ri WHERE ri.order_item_id = i.id), 0))::int AS qty,
                 sum(CASE WHEN o.shipped_at >= ${since28} THEN i.quantity - COALESCE((SELECT sum(ri.quantity) FROM return_items ri WHERE ri.order_item_id = i.id), 0) ELSE 0 END)::int AS qty28,
                 sum(i.total) AS revenue
          FROM sales_order_items i JOIN sales_orders o ON o.id = i.order_id
          WHERE o.tenant_id = ${ctx.tenantId}::uuid AND o.status IN ('SHIPPED','DELIVERED','CLOSED') AND o.shipped_at >= ${since} GROUP BY i.product_id`,
      ]);
      const sm = new Map(stock.map((s) => [s.product_id, s])); const sl = new Map(sales.map((s) => [s.product_id, s]));
      type Item = { productId: string; sku: string; name: string; onHand: number; available: number; sold: number; avgDaily: number; coverageDays: number | null; turnover: number | null; forecast30: number; suggestedPurchase: number; leadDays: number; status: string; abc: string; stockValue: number; revenue: number };
      const items: Item[] = products.map((p) => {
        const s = sm.get(p.id); const v = sl.get(p.id);
        const onHand = s?.on_hand ?? 0; const available = onHand - (s?.reserved ?? 0) - (s?.blocked ?? 0);
        const sold = Math.max(0, v?.qty ?? 0); const avg = sold / days; const recent = days >= 28 ? Math.max(0, v?.qty28 ?? 0) / 28 : avg;
        const rate = 0.6 * recent + 0.4 * avg; // previsão: ritmo recente pesa mais que a média do período
        const lead = p.leadTimeDays ?? defaultLead;
        const coverage = avg > 0 || recent > 0 ? round2(available / Math.max(rate, 1e-9)) : null;
        const forecast30 = Math.ceil(rate * 30);
        const need = rate * (30 + lead) + (p.minStock ?? 0) - available;
        let status = 'OK';
        if (rate > 0 && available <= 0) status = 'RUPTURA';
        else if (coverage !== null && coverage < lead) status = 'CRITICO';
        else if (coverage !== null && coverage < lead * 2) status = 'ATENCAO';
        else if (onHand > 0 && sold === 0) status = 'SEM_GIRO';
        else if (p.reorderPoint !== null && available <= p.reorderPoint) status = 'ATENCAO';
        return { productId: p.id, sku: p.sku, name: p.name, onHand, available, sold, avgDaily: round2(avg), coverageDays: coverage, turnover: onHand > 0 ? round2(sold / onHand) : null, forecast30, suggestedPurchase: Math.max(0, Math.ceil(need)), leadDays: lead, status, abc: 'C', stockValue: round2(onHand * Number(p.costPrice ?? 0)), revenue: toCents(v?.revenue ?? 0) / 100 };
      });
      // curva ABC por faturamento no período: A = primeiros 80%, B = até 95%, C = o resto
      const totalRev = items.reduce((s, i) => s + i.revenue, 0); let acc = 0;
      for (const i of [...items].sort((a, b) => b.revenue - a.revenue)) { if (i.revenue <= 0) { i.abc = 'C'; continue; } acc += i.revenue; i.abc = acc - i.revenue < totalRev * 0.8 ? 'A' : acc - i.revenue < totalRev * 0.95 ? 'B' : 'C'; }
      const order: Record<string, number> = { RUPTURA: 0, CRITICO: 1, ATENCAO: 2, SEM_GIRO: 3, OK: 4 };
      items.sort((a, b) => order[a.status] - order[b.status] || (a.coverageDays ?? 1e9) - (b.coverageDays ?? 1e9));
      const count = (s: string) => items.filter((i) => i.status === s).length;
      return {
        days, defaultLeadDays: defaultLead,
        summary: { products: items.length, ruptura: count('RUPTURA'), critico: count('CRITICO'), atencao: count('ATENCAO'), semGiro: count('SEM_GIRO'), stockValue: round2(items.reduce((s, i) => s + i.stockValue, 0)), purchaseSuggestedUnits: items.reduce((s, i) => s + i.suggestedPurchase, 0), classA: items.filter((i) => i.abc === 'A').length },
        items: items.filter((i) => i.status !== 'OK' || i.suggestedPurchase > 0).slice(0, 300).concat(items.filter((i) => i.status === 'OK' && i.suggestedPurchase === 0).slice(0, 100)),
        basis: `Vendas expedidas nos últimos ${days} dias (líquidas de devoluções). Ritmo diário = 60% do ritmo dos últimos 28 dias + 40% da média do período. Cobertura = disponível ÷ ritmo. Ruptura = sem disponível e com venda; crítico = cobertura menor que o prazo de reposição do produto (padrão ${defaultLead} dias); atenção = menor que 2× o prazo ou abaixo do ponto de reposição; sem giro = estoque parado sem venda no período. Compra sugerida = ritmo × (30 dias + prazo) + estoque mínimo − disponível. É estimativa estatística simples, não considera sazonalidade nem promoções.`,
      };
    });
  }

  // ───────────── orçamento ─────────────

  budget(ctx: AuthContext, yearIn?: string) {
    const year = yearIn ?? localDate().slice(0, 4);
    if (!/^\d{4}$/.test(year)) throw new BadRequestException('Ano inválido.');
    const start = new Date(Date.UTC(Number(year), 0, 1) + BRT); const end = new Date(Date.UTC(Number(year) + 1, 0, 1) + BRT);
    return this.prisma.withContext(ctx, async (tx) => {
      const [cats, lines, titles, sales] = await Promise.all([
        tx.financialCategory.findMany({ where: { tenantId: ctx.tenantId!, active: true }, orderBy: [{ kind: 'asc' }, { name: 'asc' }] }),
        tx.budgetLine.findMany({ where: { tenantId: ctx.tenantId!, period: { startsWith: `${year}-` } } }),
        tx.$queryRaw<{ category_id: string | null; direction: string; m: string; total: string }[]>`
          SELECT category_id, direction, to_char(due_date, 'YYYY-MM') AS m, sum(amount) AS total FROM financial_titles
          WHERE tenant_id = ${ctx.tenantId}::uuid AND status <> 'CANCELLED' AND due_date >= ${start} AND due_date < ${end} AND origin NOT IN ('SALES_ORDER','MARKETPLACE','COMMISSION','NEGOTIATION')
          GROUP BY category_id, direction, to_char(due_date, 'YYYY-MM')`,
        tx.$queryRaw<{ m: string; total: string }[]>`
          SELECT to_char(shipped_at - interval '3 hours', 'YYYY-MM') AS m, sum(subtotal - discount_total) AS total FROM sales_orders
          WHERE tenant_id = ${ctx.tenantId}::uuid AND status IN ('SHIPPED','DELIVERED','CLOSED') AND shipped_at >= ${start} AND shipped_at < ${end} GROUP BY 1`,
      ]);
      const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
      const build = (lineKey: string, label: string, kind: string, realized: (m: string) => number) => ({
        lineKey, label, kind, expense: kind !== 'REVENUE' && lineKey !== 'SALES',
        months: months.map((m) => {
          const b = lines.find((l) => l.lineKey === lineKey && l.period === m); const bc = b ? toCents(b.amount) : null; const rc = realized(m);
          return { period: m, budget: bc === null ? null : fromCents(bc), realized: fromCents(rc), variance: bc === null ? null : fromCents(rc - bc) };
        }),
      });
      const rowsOut = [
        build('SALES', 'Vendas (receita bruta de mercadoria)', 'SALES', (m) => toCents(sales.find((s) => s.m === m)?.total ?? 0)),
        ...cats.map((c) => build(c.id, c.name, c.kind, (m) => titles.filter((t) => t.category_id === c.id && t.m === m && t.direction === (c.kind === 'REVENUE' ? 'RECEIVABLE' : 'PAYABLE')).reduce((s, t) => s + toCents(t.total), 0))),
        build('NONE', 'Sem categoria (contas a pagar)', 'OTHER', (m) => titles.filter((t) => t.category_id === null && t.m === m && t.direction === 'PAYABLE').reduce((s, t) => s + toCents(t.total), 0)),
      ];
      return {
        year, months, rows: rowsOut,
        basis: 'Realizado: vendas pela data de expedição (valor dos produtos menos descontos) e demais linhas pelo VENCIMENTO dos títulos lançados na categoria, sem os gerados por pedidos, marketplace, comissão ou negociação. Variação = realizado − orçado (despesa acima do orçado e receita abaixo do orçado merecem atenção).',
      };
    });
  }

  setBudget(ctx: AuthContext, dto: BudgetDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      const catIds = [...new Set(dto.lines.map((l) => l.lineKey).filter((k) => k !== 'SALES' && k !== 'NONE'))];
      if (catIds.some((k) => !/^[0-9a-f-]{36}$/i.test(k))) throw new BadRequestException('Linha de orçamento inválida.');
      if (catIds.length && (await tx.financialCategory.count({ where: { tenantId: ctx.tenantId!, id: { in: catIds } } })) !== catIds.length) throw new BadRequestException('Categoria inválida.');
      for (const l of dto.lines) {
        await tx.budgetLine.upsert({
          where: { tenantId_lineKey_period: { tenantId: ctx.tenantId!, lineKey: l.lineKey, period: l.period } },
          create: { tenantId: ctx.tenantId!, lineKey: l.lineKey, categoryId: catIds.includes(l.lineKey) ? l.lineKey : null, period: l.period, amount: l.amount }, update: { amount: l.amount },
        });
      }
      await this.audit.record(tx, ctx, { action: 'management.budget_set', entity: 'budget_line', metadata: { lines: dto.lines.length } });
      return { saved: dto.lines.length };
    });
  }

  // ───────────── pacote do contador ─────────────

  /**
   * ZIP para o contador: planilhas (CSV) de notas de saída/entrada, lançamentos e baixas financeiras, plano de contas e DRE, mais os XML
   * autorizados/recebidos. NÃO é SPED (EFD ICMS/IPI, Contribuições ou ECD): o escritório contábil gera o SPED a partir destes dados.
   */
  async accountantPackage(ctx: AuthContext, q: { from?: string; to?: string }) {
    const r = range(q.from, q.to, 30);
    const files: Record<string, Uint8Array> = {};
    const csv = (name: string, cols: Column[], rows: Row[]) => { files[name] = new Uint8Array(toCsv(cols, rows)); };
    const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
    const MAX_XML = 5000;
    let xmlCount = 0; let xmlSkipped = 0;
    await this.prisma.withContext(ctx, async (tx) => {
      const docs = await tx.fiscalDocument.findMany({
        where: { tenantId: ctx.tenantId!, status: { notIn: ['DRAFT', 'PENDING_VALIDATION'] }, OR: [{ issuedAt: { gte: r.start, lt: r.end } }, { issuedAt: null, createdAt: { gte: r.start, lt: r.end } }] },
        orderBy: { createdAt: 'asc' }, take: 20000,
        include: { supplier: { select: { legalName: true } }, xmlFiles: { orderBy: { createdAt: 'desc' }, select: { kind: true, content: true } } },
      });
      const cols: Column[] = [{ key: 'model', label: 'Modelo' }, { key: 'series', label: 'Série' }, { key: 'number', label: 'Número' }, { key: 'key', label: 'Chave de acesso' }, { key: 'status', label: 'Situação' }, { key: 'date', label: 'Emissão' }, { key: 'party', label: 'Emitente/Destinatário' }, { key: 'doc', label: 'CNPJ/CPF' }, { key: 'total', label: 'Valor total' }, { key: 'env', label: 'Ambiente' }, { key: 'xml', label: 'XML no pacote' }];
      const out: Row[] = []; const inn: Row[] = [];
      for (const d of docs) {
        const exit = d.direction === 'EXIT';
        const xml = d.xmlFiles.find((x) => (exit ? x.kind === 'AUTHORIZED' : x.kind === 'RECEIVED' || x.kind === 'AUTHORIZED'));
        let inPack = 'não';
        if (xml && d.accessKey) {
          if (xmlCount < MAX_XML) { files[`xml/${exit ? 'saida' : 'entrada'}/${d.accessKey}.xml`] = strToU8(xml.content); xmlCount++; inPack = 'sim'; } else xmlSkipped++;
        }
        const row: Row = { model: d.model, series: d.series, number: d.number, key: d.accessKey, status: d.status, date: day(d.issuedAt ?? d.createdAt), party: exit ? d.emitterName : (d.emitterName ?? d.supplier?.legalName), doc: exit ? d.recipientDoc : d.emitterDoc, total: Number(d.totalInvoice ?? 0), env: d.environment, xml: inPack };
        (exit ? out : inn).push(row);
      }
      csv('notas_saida.csv', cols, out); csv('notas_entrada.csv', cols, inn);

      const titles = await tx.financialTitle.findMany({
        where: { tenantId: ctx.tenantId!, dueDate: { gte: r.start, lt: r.end } }, orderBy: { dueDate: 'asc' }, take: 50000,
        include: { category: { select: { name: true } }, costCenter: { select: { name: true } } },
      });
      csv('lancamentos_financeiros.csv', [{ key: 'type', label: 'Tipo' }, { key: 'desc', label: 'Descrição' }, { key: 'party', label: 'Cliente/Fornecedor' }, { key: 'doc', label: 'Documento' }, { key: 'inst', label: 'Parcela' }, { key: 'issue', label: 'Emissão' }, { key: 'due', label: 'Vencimento' }, { key: 'amount', label: 'Valor' }, { key: 'paid', label: 'Valor pago' }, { key: 'status', label: 'Situação' }, { key: 'cat', label: 'Categoria' }, { key: 'cc', label: 'Centro de custo' }, { key: 'origin', label: 'Origem' }],
        titles.map((t) => ({ type: t.direction === 'RECEIVABLE' ? 'A receber' : 'A pagar', desc: t.description, party: t.counterpartyName, doc: t.documentRef, inst: `${t.installmentNo}/${t.installmentTotal}`, issue: day(t.issueDate), due: day(t.dueDate), amount: Number(t.amount), paid: Number(t.paidPrincipal), status: t.status, cat: t.category?.name ?? null, cc: t.costCenter?.name ?? null, origin: t.origin })));

      const sets = await tx.financialSettlement.findMany({ where: { tenantId: ctx.tenantId!, paidAt: { gte: r.start, lt: r.end } }, orderBy: { paidAt: 'asc' }, take: 50000, include: { title: { select: { description: true, direction: true } }, account: { select: { name: true } } } });
      csv('baixas.csv', [{ key: 'date', label: 'Data' }, { key: 'type', label: 'Tipo' }, { key: 'title', label: 'Título' }, { key: 'account', label: 'Conta' }, { key: 'kind', label: 'Movimento' }, { key: 'amount', label: 'Valor' }, { key: 'principal', label: 'Principal' }, { key: 'interest', label: 'Juros' }, { key: 'fine', label: 'Multa' }, { key: 'discount', label: 'Desconto' }],
        sets.map((s) => ({ date: day(s.paidAt), type: s.title.direction === 'RECEIVABLE' ? 'Recebimento' : 'Pagamento', title: s.title.description, account: s.account.name, kind: s.kind === 'REVERSAL' ? 'Estorno' : 'Baixa', amount: Number(s.amount), principal: Number(s.principal), interest: Number(s.interest), fine: Number(s.fine), discount: Number(s.discount) })));

      const [cats, ccs] = await Promise.all([tx.financialCategory.findMany({ where: { tenantId: ctx.tenantId! }, orderBy: [{ kind: 'asc' }, { name: 'asc' }] }), tx.costCenter.findMany({ where: { tenantId: ctx.tenantId! }, orderBy: { name: 'asc' } })]);
      csv('plano_de_contas.csv', [{ key: 'kind', label: 'Grupo' }, { key: 'name', label: 'Nome' }, { key: 'type', label: 'Tipo' }, { key: 'active', label: 'Ativo' }],
        [...cats.map((c) => ({ kind: c.kind, name: c.name, type: 'Categoria', active: c.active })), ...ccs.map((c) => ({ kind: 'CENTRO_DE_CUSTO', name: c.name, type: 'Centro de custo', active: c.active }))]);
    });
    const dre = await this.statements.dre(ctx, { from: r.from, to: r.to });
    csv('dre_gerencial.csv', [{ key: 'label', label: 'Linha' }, { key: 'amount', label: 'Valor' }, { key: 'pct', label: '% da receita líquida' }], dre.lines.map((l) => ({ label: l.label, amount: Number(l.amount), pct: l.pctOfNetRevenue })));
    files['LEIA-ME.txt'] = strToU8([
      `Pacote do contador — período ${r.from} a ${r.to}`,
      '',
      'Conteúdo: notas_saida.csv, notas_entrada.csv, lancamentos_financeiros.csv, baixas.csv, plano_de_contas.csv, dre_gerencial.csv e a pasta xml/ (saida e entrada).',
      '',
      'IMPORTANTE: este pacote NÃO é o arquivo SPED (EFD ICMS/IPI, EFD Contribuições, ECD). Ele reúne os dados e os XML para o escritório contábil conciliar e gerar o SPED no sistema fiscal/contábil dele.',
      'Notas de saída: só as que saíram de rascunho/validação; o XML vai no pacote apenas para as autorizadas. Notas de entrada: as importadas (XML recebido).',
      'A DRE é gerencial e não substitui a escrituração contábil.',
      xmlSkipped ? `Atenção: ${xmlSkipped} XML não couberam no pacote (limite de ${MAX_XML}); reduza o período.` : '',
    ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\r\n'));
    await this.prisma.withContext(ctx, (tx) => this.audit.record(tx, ctx, { action: 'management.accountant_package', entity: 'report', metadata: { from: r.from, to: r.to, xml: xmlCount } }));
    return { fileName: `pacote-contador-${r.from}_${r.to}.zip`, content: Buffer.from(zipSync(files)) };
  }
}

@Controller('management')
export class ManagementController {
  constructor(private readonly svc: ManagementService) {}

  @Get('goals') @RequirePermissions('management.view')
  goals(@CurrentAuth() ctx: AuthContext, @Query() q: RangeQuery) { return this.svc.goals(ctx, q.period); }

  @Put('goals') @RequirePermissions('management.manage')
  setGoals(@CurrentAuth() ctx: AuthContext, @Body() dto: GoalsDto) { return this.svc.setGoals(ctx, dto); }

  @Get('margin') @RequirePermissions('management.view')
  margin(@CurrentAuth() ctx: AuthContext, @Query() q: RangeQuery) { return this.svc.margin(ctx, q); }

  @Get('stock-health') @RequirePermissions('management.view')
  stockHealth(@CurrentAuth() ctx: AuthContext, @Query() q: RangeQuery) { return this.svc.stockHealth(ctx, { days: q.days ? Number(q.days) : undefined, leadDays: q.leadDays ? Number(q.leadDays) : undefined }); }

  @Get('budget') @RequirePermissions('management.view')
  budget(@CurrentAuth() ctx: AuthContext, @Query() q: RangeQuery) { return this.svc.budget(ctx, q.year); }

  @Put('budget') @RequirePermissions('management.manage')
  setBudget(@CurrentAuth() ctx: AuthContext, @Body() dto: BudgetDto) { return this.svc.setBudget(ctx, dto); }

  @Get('accountant-package') @RequirePermissions('finance.view', 'reports.export')
  async accountant(@CurrentAuth() ctx: AuthContext, @Query() q: RangeQuery, @Res() res: Response) {
    const f = await this.svc.accountantPackage(ctx, q);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${f.fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(f.content);
  }
}
