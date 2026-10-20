import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CommissionRule, CommissionStatus, Prisma, SalesChannel } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/auth';
import { normalizeContact } from '../common/phone';
import { PrismaService } from '../prisma/prisma.service';
import { CommissionEvent, SettingsService } from '../settings/settings.service';

type Tx = Prisma.TransactionClient;

export const toCents = (d: Prisma.Decimal | number | string) => Math.round(Number(d) * 100);
export const fromCents = (c: number) => (c / 100).toFixed(2);

export interface RuleContext {
  salespersonId: string;
  categoryId: string | null;
  productId: string;
  customerId: string;
  channel: SalesChannel;
  at: Date;
}

const criteria = (r: CommissionRule) => [r.salespersonId, r.categoryId, r.productId, r.customerId, r.channel].filter((v) => v != null).length;

/**
 * Escolhe UMA regra por item (nunca soma regras → sem aplicação duplicada):
 * maior prioridade; empate → regra mais específica (mais critérios); empate → a mais antiga.
 */
export function pickRule(rules: CommissionRule[], c: RuleContext): CommissionRule | null {
  const match = rules.filter(
    (r) =>
      r.active &&
      (!r.salespersonId || r.salespersonId === c.salespersonId) &&
      (!r.categoryId || r.categoryId === c.categoryId) &&
      (!r.productId || r.productId === c.productId) &&
      (!r.customerId || r.customerId === c.customerId) &&
      (!r.channel || r.channel === c.channel) &&
      (!r.validFrom || r.validFrom <= c.at) &&
      (!r.validTo || r.validTo >= c.at),
  );
  match.sort((a, b) => b.priority - a.priority || criteria(b) - criteria(a) || a.createdAt.getTime() - b.createdAt.getTime());
  return match[0] ?? null;
}

/** Valor em centavos para um item líquido (percentual em 4 casas ou valor fixo por unidade). */
export function commissionCents(rule: CommissionRule, baseCents: number, qty: number): number {
  if (rule.kind === 'PERCENT') return Math.round((baseCents * Math.round(Number(rule.percent) * 10000)) / 1_000_000);
  return toCents(rule.fixedAmount ?? 0) * qty;
}

@Injectable()
export class CommissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  // ───────────── vendedores ─────────────
  listSalespeople(ctx: AuthContext) {
    return this.prisma.withContext(ctx, (tx) => tx.salesperson.findMany({ where: { tenantId: ctx.tenantId! }, orderBy: { name: 'asc' } }));
  }

  createSalesperson(ctx: AuthContext, dto: { name: string; email?: string; phone?: string; userId?: string; employment?: string; supervisorId?: string }) {
    return this.prisma.withContext(ctx, async (tx) => {
      if (dto.userId && !(await tx.membership.findFirst({ where: { tenantId: ctx.tenantId!, userId: dto.userId, status: 'ACTIVE' } }))) {
        throw new BadRequestException('Usuário não pertence a esta empresa.');
      }
      if (dto.supervisorId && !(await tx.salesperson.findFirst({ where: { id: dto.supervisorId, tenantId: ctx.tenantId! } }))) {
        throw new BadRequestException('Supervisor inválido.');
      }
      const row = await tx.salesperson.create({ data: { ...normalizeContact(dto), tenantId: ctx.tenantId! } }).catch((e) => {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('Este usuário já está vinculado a um vendedor.');
        throw e;
      });
      await this.audit.record(tx, ctx, { action: 'salesperson.created', entity: 'salesperson', entityId: row.id, metadata: { name: row.name } });
      return row;
    });
  }

  updateSalesperson(ctx: AuthContext, id: string, dto: { name?: string; email?: string; phone?: string; active?: boolean }) {
    return this.prisma.withContext(ctx, async (tx) => {
      if (!(await tx.salesperson.findFirst({ where: { id, tenantId: ctx.tenantId! } }))) throw new NotFoundException('Vendedor não encontrado.');
      const row = await tx.salesperson.update({ where: { id }, data: normalizeContact(dto) });
      await this.audit.record(tx, ctx, { action: 'salesperson.updated', entity: 'salesperson', entityId: id, metadata: { fields: Object.keys(dto) } });
      return row;
    });
  }

  // ───────────── regras ─────────────
  listRules(ctx: AuthContext) {
    return this.prisma.withContext(ctx, (tx) => tx.commissionRule.findMany({ where: { tenantId: ctx.tenantId! }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }] }));
  }

  createRule(ctx: AuthContext, dto: Omit<Prisma.CommissionRuleUncheckedCreateInput, 'tenantId'>) {
    return this.prisma.withContext(ctx, async (tx) => {
      if (dto.salespersonId && !(await tx.salesperson.findFirst({ where: { id: dto.salespersonId, tenantId: ctx.tenantId! } }))) throw new BadRequestException('Vendedor inválido.');
      if (dto.categoryId && !(await tx.productCategory.findFirst({ where: { id: dto.categoryId, tenantId: ctx.tenantId! } }))) throw new BadRequestException('Categoria inválida.');
      if (dto.productId && !(await tx.product.findFirst({ where: { id: dto.productId, tenantId: ctx.tenantId! } }))) throw new BadRequestException('Produto inválido.');
      if (dto.customerId && !(await tx.customer.findFirst({ where: { id: dto.customerId, tenantId: ctx.tenantId! } }))) throw new BadRequestException('Cliente inválido.');
      if (dto.kind === 'PERCENT' ? dto.percent == null : dto.fixedAmount == null) throw new BadRequestException('Informe o percentual ou o valor fixo conforme o tipo da regra.');
      const row = await tx.commissionRule.create({ data: { ...dto, tenantId: ctx.tenantId! } });
      await this.audit.record(tx, ctx, { action: 'commission_rule.created', entity: 'commission_rule', entityId: row.id, metadata: { name: row.name, kind: row.kind, percent: dto.percent, fixedAmount: dto.fixedAmount } });
      return row;
    });
  }

  setRuleActive(ctx: AuthContext, id: string, active: boolean) {
    return this.prisma.withContext(ctx, async (tx) => {
      if (!(await tx.commissionRule.findFirst({ where: { id, tenantId: ctx.tenantId! } }))) throw new NotFoundException('Regra não encontrada.');
      const row = await tx.commissionRule.update({ where: { id }, data: { active } });
      await this.audit.record(tx, ctx, { action: active ? 'commission_rule.enabled' : 'commission_rule.disabled', entity: 'commission_rule', entityId: id });
      return row;
    });
  }

  // ───────────── livro de comissões (chamado pelos pedidos, na mesma transação) ─────────────

  async accrue(
    tx: Tx, ctx: AuthContext,
    order: { id: string; salespersonId: string | null; customerId: string; channel: SalesChannel },
    items: { id: string; productId: string; quantity: number; total: Prisma.Decimal; categoryId: string | null }[],
  ): Promise<number> {
    if (!order.salespersonId) return 0;
    const rules = await tx.commissionRule.findMany({ where: { tenantId: ctx.tenantId!, active: true } });
    const event = (await this.settings.load(tx, ctx))['commission.event'];
    const status: CommissionStatus = event === 'CONFIRMED' ? 'EARNED' : 'FORECAST';
    let n = 0;
    for (const it of items) {
      const rule = pickRule(rules, { salespersonId: order.salespersonId, categoryId: it.categoryId, productId: it.productId, customerId: order.customerId, channel: order.channel, at: new Date() });
      if (!rule) continue;
      const amount = commissionCents(rule, toCents(it.total), it.quantity);
      if (amount === 0) continue;
      await tx.salesCommission.create({
        data: {
          tenantId: ctx.tenantId!, orderId: order.id, orderItemId: it.id, salespersonId: order.salespersonId, ruleId: rule.id,
          kind: 'ACCRUAL', status, base: it.total, amount: fromCents(amount), earnedAt: status === 'EARNED' ? new Date() : null,
        },
      });
      n++;
    }
    return n;
  }

  /** Quando o pedido atinge o evento configurado, previsões viram "aprovadas" (EARNED). */
  async onOrderEvent(tx: Tx, ctx: AuthContext, orderId: string, event: CommissionEvent) {
    const configured = (await this.settings.load(tx, ctx))['commission.event'];
    if (configured !== event) return;
    await tx.salesCommission.updateMany({
      where: { tenantId: ctx.tenantId!, orderId, status: 'FORECAST' },
      data: { status: 'EARNED', earnedAt: new Date() },
    });
  }

  /** Cancelamento: estorna o saldo líquido de cada item com lançamentos REVERSAL (o histórico permanece). */
  async reverseAll(tx: Tx, ctx: AuthContext, orderId: string, note: string) {
    const entries = await tx.salesCommission.findMany({ where: { tenantId: ctx.tenantId!, orderId } });
    const byItem = new Map<string, typeof entries>();
    for (const e of entries) byItem.set(e.orderItemId ?? '', [...(byItem.get(e.orderItemId ?? '') ?? []), e]);
    for (const [itemId, list] of byItem) {
      const net = list.reduce((s, e) => s + toCents(e.amount), 0);
      if (net === 0) continue;
      await this.insertReversal(tx, ctx, list, -net, null, note, itemId || null);
    }
  }

  /** Devolução parcial/total: estorna proporcionalmente ao acumulado devolvido (sem deriva de arredondamento). */
  async reverseForReturn(
    tx: Tx, ctx: AuthContext, orderId: string, returnId: string,
    lines: { orderItemId: string; itemQty: number; returnedBefore: number; returnedNow: number }[],
  ) {
    for (const l of lines) {
      const list = await tx.salesCommission.findMany({ where: { tenantId: ctx.tenantId!, orderId, orderItemId: l.orderItemId } });
      if (!list.length) continue;
      const accrued = list.filter((e) => e.kind === 'ACCRUAL').reduce((s, e) => s + toCents(e.amount), 0);
      const reversed = list.filter((e) => e.kind === 'REVERSAL').reduce((s, e) => s + toCents(e.amount), 0);
      const target = -Math.round((accrued * (l.returnedBefore + l.returnedNow)) / l.itemQty);
      const delta = target - reversed;
      if (delta !== 0) await this.insertReversal(tx, ctx, list, delta, returnId, 'Devolução', l.orderItemId);
    }
  }

  private async insertReversal(tx: Tx, ctx: AuthContext, list: { salespersonId: string; ruleId: string | null; orderId: string; status: CommissionStatus }[], cents: number, returnId: string | null, note: string, orderItemId: string | null) {
    const ref = list[0];
    // Se o original já foi pago, o estorno vira saldo negativo "aprovado" a descontar no próximo pagamento.
    const status: CommissionStatus = ref.status === 'FORECAST' ? 'FORECAST' : 'EARNED';
    await tx.salesCommission.create({
      data: {
        tenantId: ctx.tenantId!, orderId: ref.orderId, orderItemId, salespersonId: ref.salespersonId, ruleId: ref.ruleId, returnId, kind: 'REVERSAL',
        status, base: 0, amount: fromCents(cents), note, earnedAt: status === 'EARNED' ? new Date() : null,
      },
    });
  }

  // ───────────── consultas e pagamento ─────────────

  private async scope(tx: Tx, ctx: AuthContext): Promise<Prisma.SalesCommissionWhereInput> {
    if (ctx.permissions.has('sales.view_all')) return {};
    const mine = await tx.salesperson.findFirst({ where: { tenantId: ctx.tenantId!, userId: ctx.userId }, select: { id: true } });
    return { salespersonId: mine?.id ?? '00000000-0000-0000-0000-000000000000' };
  }

  list(ctx: AuthContext, q: { salespersonId?: string; status?: CommissionStatus; orderId?: string }) {
    return this.prisma.withContext(ctx, async (tx) => {
      const where: Prisma.SalesCommissionWhereInput = { tenantId: ctx.tenantId!, ...(await this.scope(tx, ctx)), ...(q.salespersonId ? { salespersonId: q.salespersonId } : {}), ...(q.status ? { status: q.status } : {}), ...(q.orderId ? { orderId: q.orderId } : {}) };
      const [rows, groups] = await Promise.all([
        tx.salesCommission.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200, include: { order: { select: { number: true } }, salesperson: { select: { name: true } } } }),
        tx.salesCommission.groupBy({ by: ['salespersonId', 'status'], where, _sum: { amount: true } }),
      ]);
      const names = new Map((await tx.salesperson.findMany({ where: { tenantId: ctx.tenantId!, id: { in: [...new Set(groups.map((g) => g.salespersonId))] } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
      const summary: Record<string, { name: string; FORECAST: string; EARNED: string; PAID: string }> = {};
      for (const g of groups) {
        summary[g.salespersonId] ??= { name: names.get(g.salespersonId) ?? '—', FORECAST: '0.00', EARNED: '0.00', PAID: '0.00' };
        summary[g.salespersonId][g.status] = Number(g._sum.amount ?? 0).toFixed(2);
      }
      return { summary, entries: rows };
    });
  }

  /** Paga tudo que está aprovado (EARNED) do vendedor, incluindo estornos negativos. Saldo negativo não é pago. */
  pay(ctx: AuthContext, salespersonId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      if (!(await tx.salesperson.findFirst({ where: { id: salespersonId, tenantId: ctx.tenantId! } }))) throw new NotFoundException('Vendedor não encontrado.');
      const rows = await tx.$queryRaw<{ id: string; amount: string }[]>`
        SELECT id, amount FROM sales_commissions WHERE tenant_id = ${ctx.tenantId}::uuid AND salesperson_id = ${salespersonId}::uuid AND status = 'EARNED' AND payout_title_id IS NULL FOR UPDATE`;
      const total = rows.reduce((s, r) => s + toCents(r.amount), 0);
      if (!rows.length) throw new ConflictException('Não há comissões aprovadas a pagar.');
      if (total < 0) throw new ConflictException('O saldo aprovado é negativo (estornos); será descontado em pagamentos futuros.');
      await tx.salesCommission.updateMany({ where: { id: { in: rows.map((r) => r.id) }, tenantId: ctx.tenantId! }, data: { status: 'PAID', paidAt: new Date() } });
      await this.audit.record(tx, ctx, { action: 'commission.paid', entity: 'salesperson', entityId: salespersonId, metadata: { entries: rows.length, total: fromCents(total) } });
      return { paid: fromCents(total), entries: rows.length };
    });
  }
}
