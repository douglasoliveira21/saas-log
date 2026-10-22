import { Body, Controller, Get, HttpException, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IsInt, IsNotEmpty, IsString, Max, MaxLength, Min } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { startOfDay } from './finance.service';

type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;

export type DelinquencyState = 'ATTENTION' | 'BLOCKED' | 'RELEASED';

export interface DelinquentCustomer {
  customerId: string;
  name: string;
  document: string | null;
  titles: number;
  overdueAmount: string;
  oldestDueDate: string;
  maxDaysOverdue: number;
  /** ATTENTION = com atraso, ainda abaixo do prazo de bloqueio · BLOCKED = não pode comprar · RELEASED = liberado manualmente até a data informada. */
  state: DelinquencyState;
  releasedUntil: string | null;
  releaseReason: string | null;
}

class ConfigDto { @IsInt() @Min(0) @Max(365) blockAfterDays: number; }
class ReleaseDto {
  @IsInt() @Min(1) @Max(90) days: number;
  @IsString() @IsNotEmpty() @MaxLength(300) reason: string;
}

/**
 * Inadimplência: um cliente com título a receber vencido há N dias ou mais (N = configuração "bloquear após X dias", 0 = desligado)
 * fica BLOQUEADO para novos pedidos. Quem tem permissão pode liberar por um prazo (com motivo); pagar os títulos remove o atraso.
 * O cálculo vem sempre dos títulos em aberto, então não existe "bloqueio esquecido" a desfazer.
 */
@Injectable()
export class DelinquencyService {
  constructor(private readonly prisma: PrismaService, private readonly settings: SettingsService, private readonly audit: AuditService) {}

  /** Atrasos por cliente (títulos a receber em aberto e vencidos). Passe `customerId` para um só cliente. */
  async scan(tx: Tx, tenantId: string, opts: { customerId?: string; now?: Date } = {}): Promise<DelinquentCustomer[]> {
    const now = opts.now ?? new Date();
    const today = startOfDay(now);
    const threshold = (await this.settings.load(tx, { tenantId }))['finance.blockAfterDays'];
    const groups = await tx.financialTitle.groupBy({
      by: ['customerId'],
      where: { tenantId, direction: 'RECEIVABLE', status: { in: ['OPEN', 'PARTIAL'] }, customerId: opts.customerId ?? { not: null }, dueDate: { lt: today } },
      _sum: { amount: true, paidPrincipal: true }, _min: { dueDate: true }, _count: { _all: true },
    });
    if (!groups.length) return [];
    const ids = groups.map((g) => g.customerId!);
    const customers = await tx.customer.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true, document: true, blockReleasedUntil: true, blockReleaseReason: true } });
    const byId = new Map(customers.map((c) => [c.id, c]));
    const out: DelinquentCustomer[] = [];
    for (const g of groups) {
      const c = byId.get(g.customerId!);
      if (!c) continue;
      const outstanding = (g._sum.amount ?? new Prisma.Decimal(0)).minus(g._sum.paidPrincipal ?? new Prisma.Decimal(0));
      if (outstanding.lte(0)) continue;
      const oldest = g._min.dueDate!;
      const days = Math.floor((today.getTime() - oldest.getTime()) / DAY);
      const over = threshold > 0 && days >= threshold;
      const released = over && !!c.blockReleasedUntil && c.blockReleasedUntil > now;
      out.push({
        customerId: c.id, name: c.name, document: c.document, titles: g._count._all, overdueAmount: outstanding.toFixed(2),
        oldestDueDate: oldest.toISOString().slice(0, 10), maxDaysOverdue: days,
        state: !over ? 'ATTENTION' : released ? 'RELEASED' : 'BLOCKED',
        releasedUntil: released ? c.blockReleasedUntil!.toISOString() : null, releaseReason: released ? c.blockReleaseReason : null,
      });
    }
    return out.sort((a, b) => b.maxDaysOverdue - a.maxDaysOverdue);
  }

  /** Recusa (422) a venda a cliente bloqueado. Pedidos vindos de marketplace (já pagos no canal) não passam por aqui. */
  async assertNotBlocked(tx: Tx, tenantId: string, customerId: string) {
    const [d] = await this.scan(tx, tenantId, { customerId });
    if (d?.state === 'BLOCKED') {
      throw new HttpException(
        `Cliente bloqueado por inadimplência: ${d.titles} título(s) vencido(s), R$ ${d.overdueAmount} em aberto, o mais antigo há ${d.maxDaysOverdue} dia(s). Regularize o pagamento ou peça a liberação no Financeiro.`,
        422,
      );
    }
  }

  summary(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const threshold = (await this.settings.load(tx, ctx))['finance.blockAfterDays'];
      const items = await this.scan(tx, ctx.tenantId!);
      const total = items.reduce((s, i) => s.plus(i.overdueAmount), new Prisma.Decimal(0));
      return {
        blockAfterDays: threshold,
        totals: {
          customers: items.length, overdueAmount: total.toFixed(2),
          blocked: items.filter((i) => i.state === 'BLOCKED').length, released: items.filter((i) => i.state === 'RELEASED').length,
        },
        items,
      };
    });
  }

  setConfig(ctx: AuthContext, blockAfterDays: number) {
    return this.settings.update(ctx, { 'finance.blockAfterDays': blockAfterDays }).then((s) => ({ blockAfterDays: s['finance.blockAfterDays'] }));
  }

  release(ctx: AuthContext, customerId: string, dto: { days: number; reason: string }) {
    return this.prisma.withContext(ctx, async (tx) => {
      const c = await tx.customer.findFirst({ where: { id: customerId, tenantId: ctx.tenantId! }, select: { id: true, name: true } });
      if (!c) throw new NotFoundException('Cliente não encontrado.');
      const until = new Date(Date.now() + dto.days * DAY);
      await tx.customer.update({ where: { id: customerId }, data: { blockReleasedUntil: until, blockReleaseReason: dto.reason.trim(), blockReleasedById: ctx.userId } });
      await this.audit.record(tx, ctx, { action: 'finance.delinquency_released', entity: 'customer', entityId: customerId, metadata: { days: dto.days, until: until.toISOString(), reason: dto.reason.trim() } });
      return { customerId, releasedUntil: until.toISOString() };
    });
  }

  revokeRelease(ctx: AuthContext, customerId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const r = await tx.customer.updateMany({ where: { id: customerId, tenantId: ctx.tenantId! }, data: { blockReleasedUntil: null, blockReleaseReason: null, blockReleasedById: null } });
      if (!r.count) throw new NotFoundException('Cliente não encontrado.');
      await this.audit.record(tx, ctx, { action: 'finance.delinquency_release_revoked', entity: 'customer', entityId: customerId });
      return { customerId };
    });
  }
}

@Controller('finance/delinquency')
export class DelinquencyController {
  constructor(private readonly svc: DelinquencyService) {}

  @Get() @RequirePermissions('finance.view')
  summary(@CurrentAuth() ctx: AuthContext) { return this.svc.summary(ctx); }

  @Put('config') @RequirePermissions('finance.manage')
  config(@CurrentAuth() ctx: AuthContext, @Body() dto: ConfigDto) { return this.svc.setConfig(ctx, dto.blockAfterDays); }

  @Post('customers/:id/release') @RequirePermissions('finance.approve')
  release(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReleaseDto) { return this.svc.release(ctx, id, dto); }

  @Post('customers/:id/revoke-release') @RequirePermissions('finance.approve')
  revoke(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.revokeRelease(ctx, id); }
}
