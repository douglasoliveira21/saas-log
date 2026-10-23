import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { GoalBonusTier, Prisma } from '@prisma/client';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { monthRange, soldByPerson } from '../management/management';
import { PrismaService } from '../prisma/prisma.service';
import { fromCents, toCents } from './commissions.service';

const money = { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false } as const;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const BRT = 3 * 3_600_000;
const currentPeriod = () => new Date(Date.now() - BRT).toISOString().slice(0, 7);

class TierDto {
  @IsString() @Length(2, 80) name: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(1000) minPct: number;
  @IsIn(['PERCENT', 'FIXED']) kind: 'PERCENT' | 'FIXED';
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(100) percent?: number;
  @IsOptional() @IsNumber(money) @Min(0) @Max(1e9) fixedAmount?: number;
}
class ActiveDto { @IsBoolean() active: boolean }
class PeriodDto { @Matches(PERIOD, { message: 'Período inválido: use AAAA-MM.' }) period: string }
class PeriodQuery { @IsOptional() @Matches(PERIOD) period?: string }

/** Maior faixa atingida vale (as faixas não se somam). Faixas com a mesma % mínima: vale a de maior bônus. */
export function pickTier(tiers: GoalBonusTier[], attainmentPct: number): GoalBonusTier | null {
  const ok = tiers.filter((t) => t.active && Number(t.minPct) <= attainmentPct);
  ok.sort((a, b) => Number(b.minPct) - Number(a.minPct) || Number(b.percent ?? 0) - Number(a.percent ?? 0));
  return ok[0] ?? null;
}

export function bonusCents(tier: GoalBonusTier, achievedCents: number): number {
  return tier.kind === 'PERCENT' ? Math.round((achievedCents * Math.round(Number(tier.percent ?? 0) * 10000)) / 1_000_000) : toCents(tier.fixedAmount ?? 0);
}

/**
 * Comissão por meta: faixas de bônus sobre a meta mensal de cada vendedor (a meta é a cadastrada em Gestão → Metas). O mês corrente é só
 * projeção. Só um mês JÁ ENCERRADO pode ser apurado; a apuração é congelada (devolução posterior não a altera) e entra no repasse de comissões.
 */
@Injectable()
export class GoalBonusService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  tiers(ctx: AuthContext) {
    return this.prisma.withContext(ctx, (tx) => tx.goalBonusTier.findMany({ where: { tenantId: ctx.tenantId! }, orderBy: [{ minPct: 'asc' }, { createdAt: 'asc' }] }));
  }

  createTier(ctx: AuthContext, dto: TierDto) {
    if (dto.kind === 'PERCENT' ? dto.percent == null : dto.fixedAmount == null) throw new BadRequestException('Informe o percentual ou o valor fixo conforme o tipo da faixa.');
    return this.prisma.withContext(ctx, async (tx) => {
      const row = await tx.goalBonusTier.create({ data: { tenantId: ctx.tenantId!, name: dto.name.trim(), minPct: dto.minPct, kind: dto.kind, percent: dto.kind === 'PERCENT' ? dto.percent : null, fixedAmount: dto.kind === 'FIXED' ? dto.fixedAmount : null } });
      await this.audit.record(tx, ctx, { action: 'goal_bonus_tier.created', entity: 'goal_bonus_tier', entityId: row.id, metadata: { name: row.name, minPct: dto.minPct, kind: dto.kind, percent: dto.percent, fixedAmount: dto.fixedAmount } });
      return row;
    });
  }

  setActive(ctx: AuthContext, id: string, active: boolean) {
    return this.prisma.withContext(ctx, async (tx) => {
      const r = await tx.goalBonusTier.updateMany({ where: { id, tenantId: ctx.tenantId! }, data: { active } });
      if (r.count !== 1) throw new NotFoundException('Faixa não encontrada.');
      await this.audit.record(tx, ctx, { action: active ? 'goal_bonus_tier.enabled' : 'goal_bonus_tier.disabled', entity: 'goal_bonus_tier', entityId: id });
      return { ok: true };
    });
  }

  private async visibleSalespersonId(tx: Prisma.TransactionClient, ctx: AuthContext): Promise<string | null | 'ALL'> {
    if (ctx.permissions.has('sales.view_all')) return 'ALL';
    return (await tx.salesperson.findFirst({ where: { tenantId: ctx.tenantId!, userId: ctx.userId }, select: { id: true } }))?.id ?? null;
  }

  /** Conta de cada vendedor com meta no mês. Meses já apurados mostram o valor gravado. */
  private async compute(tx: Prisma.TransactionClient, tenantId: string, period: string) {
    const [goals, tiers, saved, { sold, returned }, people] = await Promise.all([
      tx.salesGoal.findMany({ where: { tenantId, period } }),
      tx.goalBonusTier.findMany({ where: { tenantId, active: true } }),
      tx.goalBonus.findMany({ where: { tenantId, period } }),
      soldByPerson(tx, tenantId, period),
      tx.salesperson.findMany({ where: { tenantId }, select: { id: true, name: true } }),
    ]);
    const names = new Map(people.map((p) => [p.id, p.name]));
    return goals.filter((g) => toCents(g.amount) > 0).map((g) => {
      const frozen = saved.find((s) => s.salespersonId === g.salespersonId);
      const goalCents = toCents(g.amount);
      const achieved = toCents(sold.find((s) => s.salesperson_id === g.salespersonId)?.amount ?? 0) - toCents(returned.find((r) => r.salesperson_id === g.salespersonId)?.value ?? 0);
      const attain = Math.round((achieved / goalCents) * 10000) / 100;
      const tier = frozen ? null : pickTier(tiers, attain);
      return {
        salespersonId: g.salespersonId, name: names.get(g.salespersonId) ?? '—',
        goal: frozen ? Number(frozen.goalAmount).toFixed(2) : fromCents(goalCents), achieved: frozen ? Number(frozen.achieved).toFixed(2) : fromCents(achieved), pct: frozen ? Number(frozen.attainmentPct) : attain,
        tier: frozen ? (frozen.tierName ? { id: frozen.tierId, name: frozen.tierName } : null) : tier ? { id: tier.id, name: tier.name } : null,
        bonus: frozen ? Number(frozen.amount).toFixed(2) : tier ? fromCents(bonusCents(tier, achieved)) : '0.00',
        status: (frozen ? (Number(frozen.amount) === 0 ? 'NONE' : frozen.status) : 'PROJECTED') as 'PROJECTED' | 'EARNED' | 'PAID' | 'NONE',
        _compute: { goalCents, achieved, attain, tier },
      };
    });
  }

  async report(ctx: AuthContext, periodIn?: string) {
    const period = periodIn ?? currentPeriod();
    monthRange(period);
    return this.prisma.withContext(ctx, async (tx) => {
      const vis = await this.visibleSalespersonId(tx, ctx);
      const rows = (await this.compute(tx, ctx.tenantId!, period)).filter((r) => vis === 'ALL' || r.salespersonId === vis).map(({ _compute, ...r }) => r);
      const tiers = await tx.goalBonusTier.findMany({ where: { tenantId: ctx.tenantId!, active: true }, orderBy: { minPct: 'asc' } });
      return { period, closed: period < currentPeriod(), rows, tiers: tiers.map((t) => ({ id: t.id, name: t.name, minPct: String(t.minPct), kind: t.kind, percent: t.percent ? String(t.percent) : null, fixedAmount: t.fixedAmount ? String(t.fixedAmount) : null })), basis: 'Atingimento = vendido no mês (data da confirmação), líquido de devoluções, sobre a meta de Gestão → Metas. A maior faixa atingida vale; o mês só é apurado depois de encerrado e o valor apurado não muda mais.' };
    });
  }

  /** Apura (grava) o bônus de um mês encerrado. Repetir não duplica nem altera o que já foi apurado. */
  close(ctx: AuthContext, period: string) {
    monthRange(period);
    if (period >= currentPeriod()) throw new ConflictException('Só é possível apurar um mês já encerrado.');
    return this.prisma.withContext(ctx, async (tx) => {
      const rows = await this.compute(tx, ctx.tenantId!, period);
      let created = 0; let total = 0;
      for (const r of rows) {
        if (r.status !== 'PROJECTED') continue; // já apurado
        const c = r._compute;
        const amount = c.tier ? bonusCents(c.tier, c.achieved) : 0;
        const made = await tx.goalBonus.createMany({
          data: [{ tenantId: ctx.tenantId!, salespersonId: r.salespersonId, period, goalAmount: fromCents(c.goalCents), achieved: fromCents(c.achieved), attainmentPct: c.attain, tierId: c.tier?.id ?? null, tierName: c.tier?.name ?? null, amount: fromCents(amount), status: amount > 0 ? 'EARNED' : 'PAID', paidAt: amount > 0 ? null : new Date() }],
          skipDuplicates: true,
        });
        created += made.count; total += amount;
      }
      await this.audit.record(tx, ctx, { action: 'goal_bonus.closed', entity: 'goal_bonus', metadata: { period, salespeople: created, total: fromCents(total) } });
      return { period, created, total: fromCents(total) };
    });
  }
}

@Controller()
export class GoalBonusController {
  constructor(private readonly svc: GoalBonusService) {}

  @Get('goal-bonus-tiers') @RequirePermissions('commissions.manage')
  tiers(@CurrentAuth() ctx: AuthContext) { return this.svc.tiers(ctx); }

  @Post('goal-bonus-tiers') @RequirePermissions('commissions.manage')
  createTier(@CurrentAuth() ctx: AuthContext, @Body() dto: TierDto) { return this.svc.createTier(ctx, dto); }

  @Put('goal-bonus-tiers/:id/active') @RequirePermissions('commissions.manage')
  active(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ActiveDto) { return this.svc.setActive(ctx, id, dto.active); }

  @Get('goal-bonus') @RequirePermissions('commissions.view')
  report(@CurrentAuth() ctx: AuthContext, @Query() q: PeriodQuery) { return this.svc.report(ctx, q.period); }

  @Post('goal-bonus/close') @HttpCode(200) @RequirePermissions('commissions.manage')
  close(@CurrentAuth() ctx: AuthContext, @Body() dto: PeriodDto) { return this.svc.close(ctx, dto.period); }
}
