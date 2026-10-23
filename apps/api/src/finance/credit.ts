import { Body, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IsInt, IsNumber, IsOptional, Max, Min, ValidateIf } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { fromCents, toCents } from '../commissions/commissions.service';
import { PrismaService } from '../prisma/prisma.service';

type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;
/** Formas de pagamento que dependem de o cliente pagar depois (consomem o limite de crédito). Sem forma informada, por prudência, conta. */
export const CREDIT_METHODS = ['BOLETO', 'CHECK', 'OTHER'];

export interface CreditInfo { minShelfLifeDays: number | null; limit: string | null; exposure: string; available: string | null; overdue: string; openTitles: number }

/** Exposição = contas a receber em aberto do cliente (vencidas ou a vencer, menos o que já foi pago). */
export async function creditInfo(tx: Tx, tenantId: string, customerId: string): Promise<CreditInfo> {
  const c = await tx.customer.findFirst({ where: { id: customerId, tenantId }, select: { creditLimit: true, minShelfLifeDays: true } });
  if (!c) throw new NotFoundException('Cliente não encontrado.');
  const g = await tx.financialTitle.aggregate({ where: { tenantId, customerId, direction: 'RECEIVABLE', status: { in: ['OPEN', 'PARTIAL'] } }, _sum: { amount: true, paidPrincipal: true }, _count: { _all: true } });
  const today = new Date(Math.floor((Date.now() - 3 * 3_600_000) / DAY) * DAY);
  const od = await tx.financialTitle.aggregate({ where: { tenantId, customerId, direction: 'RECEIVABLE', status: { in: ['OPEN', 'PARTIAL'] }, dueDate: { lt: today } }, _sum: { amount: true, paidPrincipal: true } });
  const exposure = toCents(g._sum.amount ?? 0) - toCents(g._sum.paidPrincipal ?? 0);
  const overdue = toCents(od._sum.amount ?? 0) - toCents(od._sum.paidPrincipal ?? 0);
  const limit = c.creditLimit === null ? null : toCents(c.creditLimit);
  return { minShelfLifeDays: c.minShelfLifeDays, limit: limit === null ? null : fromCents(limit), exposure: fromCents(exposure), available: limit === null ? null : fromCents(limit - exposure), overdue: fromCents(overdue), openTitles: g._count._all };
}

/**
 * Análise de crédito de uma venda a prazo: se o cliente tem limite e (em aberto + este pedido) passa dele, a venda precisa de aprovação.
 * Cliente sem limite cadastrado não é controlado. Limite 0 = nenhuma venda a prazo sem aprovação. Pix, dinheiro e cartão não consomem limite.
 */
export async function creditCheck(tx: Tx, tenantId: string, customerId: string, orderCents: number, paymentMethod: string | null): Promise<{ exceeded: boolean; message: string; info: CreditInfo }> {
  const info = await creditInfo(tx, tenantId, customerId);
  if (info.limit === null || (paymentMethod !== null && !CREDIT_METHODS.includes(paymentMethod))) return { exceeded: false, message: '', info };
  const after = toCents(info.exposure) + orderCents;
  if (after <= toCents(info.limit)) return { exceeded: false, message: '', info };
  const fmt = (v: string) => `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
  return { exceeded: true, info, message: `Limite de crédito excedido: limite ${fmt(info.limit)}, em aberto ${fmt(info.exposure)}, este pedido ${fmt(fromCents(orderCents))} (passa em ${fmt(fromCents(after - toCents(info.limit)))})` };
}

class ShelfDto { @IsOptional() @ValidateIf((o) => o.days !== null) @IsInt() @Min(0) @Max(3650) days: number | null }

class LimitDto {
  @IsOptional() @ValidateIf((o) => o.creditLimit !== null) @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false }) @Min(0) @Max(1e9) creditLimit: number | null;
}

@Injectable()
export class CreditService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  get(ctx: AuthContext, customerId: string) { return this.prisma.withContext(ctx, (tx) => creditInfo(tx, ctx.tenantId!, customerId)); }

  setLimit(ctx: AuthContext, customerId: string, limit: number | null) {
    return this.prisma.withContext(ctx, async (tx) => {
      const c = await tx.customer.findFirst({ where: { id: customerId, tenantId: ctx.tenantId! }, select: { creditLimit: true } });
      if (!c) throw new NotFoundException('Cliente não encontrado.');
      await tx.customer.update({ where: { id: customerId }, data: { creditLimit: limit } });
      await this.audit.record(tx, ctx, { action: 'customers.credit_limit_set', entity: 'customer', entityId: customerId, metadata: { before: c.creditLimit?.toString() ?? null, after: limit } });
      return creditInfo(tx, ctx.tenantId!, customerId);
    });
  }
}

/** Validade mínima (dias) dos lotes entregues ao cliente. */
@Injectable()
export class ShelfLifeService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}
  set(ctx: AuthContext, customerId: string, days: number | null) {
    return this.prisma.withContext(ctx, async (tx) => {
      const c = await tx.customer.findFirst({ where: { id: customerId, tenantId: ctx.tenantId! }, select: { minShelfLifeDays: true } });
      if (!c) throw new NotFoundException('Cliente não encontrado.');
      await tx.customer.update({ where: { id: customerId }, data: { minShelfLifeDays: days && days > 0 ? days : null } });
      await this.audit.record(tx, ctx, { action: 'customers.min_shelf_life_set', entity: 'customer', entityId: customerId, metadata: { before: c.minShelfLifeDays, after: days } });
      return creditInfo(tx, ctx.tenantId!, customerId);
    });
  }
}

@Controller('customers')
export class CreditController {
  constructor(private readonly svc: CreditService, private readonly shelf: ShelfLifeService) {}

  @Put(':id/min-shelf-life') @RequirePermissions('customers.manage')
  minShelf(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ShelfDto) { return this.shelf.set(ctx, id, dto.days ?? null); }

  @Get(':id/credit') @RequirePermissions('customers.view')
  get(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.get(ctx, id); }

  @Put(':id/credit-limit') @RequirePermissions('credit.manage')
  set(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LimitDto) { return this.svc.setLimit(ctx, id, dto.creditLimit ?? null); }
}
