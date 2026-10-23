import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Injectable, Put, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { onlyDigits } from '../common/cnpj';
import { fromCents, toCents } from '../commissions/commissions.service';
import { PrismaService } from '../prisma/prisma.service';

const SOLD: ('CONFIRMED' | 'PICKING' | 'PACKED' | 'SHIPPED' | 'DELIVERED' | 'CLOSED')[] = ['CONFIRMED', 'PICKING', 'PACKED', 'SHIPPED', 'DELIVERED', 'CLOSED'];
const DAY = 86_400_000;

class PortfolioQuery {
  /** UUID do vendedor, ou "none" para clientes sem carteira. Quem não vê todas as vendas só enxerga a própria carteira. */
  @IsOptional() @IsString() @MaxLength(40) salespersonId?: string;
  @IsOptional() @IsString() @MaxLength(100) search?: string;
}
class TransferDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsUUID('all', { each: true }) customerIds: string[];
  @ValidateIf((o) => o.salespersonId !== null) @IsUUID() salespersonId: string | null;
}

/**
 * Carteira de clientes: cada cliente pertence a um vendedor. O vendedor vê só a sua; quem enxerga todas as vendas (administrador,
 * gerente) vê a de qualquer vendedor, os clientes sem carteira e pode transferir clientes entre vendedores.
 */
@Injectable()
export class PortfolioService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private async mine(tx: Prisma.TransactionClient, ctx: AuthContext) {
    return (await tx.salesperson.findFirst({ where: { tenantId: ctx.tenantId!, userId: ctx.userId }, select: { id: true, name: true } })) ?? null;
  }

  /** Resumo por vendedor (quantos clientes, vendido nos últimos 90 dias). */
  summary(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const all = ctx.permissions.has('sales.view_all');
      const me = await this.mine(tx, ctx);
      const people = await tx.salesperson.findMany({ where: { tenantId: ctx.tenantId!, active: true, ...(all ? {} : { id: me?.id ?? '00000000-0000-0000-0000-000000000000' }) }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
      const counts = await tx.customer.groupBy({ by: ['salespersonId'], where: { tenantId: ctx.tenantId!, active: true }, _count: { _all: true } });
      const since = new Date(Date.now() - 90 * DAY);
      const sold = await tx.salesOrder.groupBy({ by: ['salespersonId'], where: { tenantId: ctx.tenantId!, status: { in: SOLD }, confirmedAt: { gte: since }, salespersonId: { not: null } }, _sum: { total: true } });
      return {
        canSeeAll: all, mineId: me?.id ?? null,
        salespeople: people.map((p) => ({ id: p.id, name: p.name, customers: counts.find((c) => c.salespersonId === p.id)?._count._all ?? 0, sold90d: fromCents(toCents(sold.find((s) => s.salespersonId === p.id)?._sum.total ?? 0)) })),
        unassigned: all ? (counts.find((c) => c.salespersonId === null)?._count._all ?? 0) : 0,
      };
    });
  }

  list(ctx: AuthContext, q: PortfolioQuery) {
    return this.prisma.withContext(ctx, async (tx) => {
      const all = ctx.permissions.has('sales.view_all');
      const me = await this.mine(tx, ctx);
      let owner: Prisma.CustomerWhereInput;
      if (!all) {
        if (!me) return { owner: null, items: [] };
        owner = { salespersonId: me.id };
      } else if (q.salespersonId === 'none') owner = { salespersonId: null };
      else if (q.salespersonId) {
        if (!/^[0-9a-f-]{36}$/i.test(q.salespersonId)) throw new BadRequestException('Vendedor inválido.');
        owner = { salespersonId: q.salespersonId };
      } else owner = {};
      const search = q.search?.trim();
      const where: Prisma.CustomerWhereInput = {
        tenantId: ctx.tenantId!, active: true, ...owner,
        ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { document: { contains: onlyDigits(search) || '∅' } }] } : {}),
      };
      const rows = await tx.customer.findMany({ where, orderBy: { name: 'asc' }, take: 300, select: { id: true, name: true, kind: true, document: true, phone: true, email: true, city: true, state: true, priceTable: true, notifyOptOut: true, salespersonId: true, portfolioOwner: { select: { name: true } } } });
      const ids = rows.map((r) => r.id);
      const [last, year, open] = await Promise.all([
        tx.salesOrder.groupBy({ by: ['customerId'], where: { tenantId: ctx.tenantId!, customerId: { in: ids }, status: { in: SOLD } }, _max: { confirmedAt: true }, _count: { _all: true } }),
        tx.salesOrder.groupBy({ by: ['customerId'], where: { tenantId: ctx.tenantId!, customerId: { in: ids }, status: { in: SOLD }, confirmedAt: { gte: new Date(Date.now() - 365 * DAY) } }, _sum: { total: true } }),
        tx.financialTitle.groupBy({ by: ['customerId'], where: { tenantId: ctx.tenantId!, direction: 'RECEIVABLE', status: { in: ['OPEN', 'PARTIAL'] }, customerId: { in: ids } }, _sum: { amount: true, paidPrincipal: true } }),
      ]);
      const today = Date.now();
      return {
        owner: q.salespersonId ?? (all ? null : me?.id ?? null),
        items: rows.map((r) => {
          const l = last.find((x) => x.customerId === r.id); const y = year.find((x) => x.customerId === r.id); const o = open.find((x) => x.customerId === r.id);
          const lastAt = l?._max.confirmedAt ?? null;
          return {
            id: r.id, name: r.name, kind: r.kind, document: r.document, phone: r.phone, email: r.email, city: r.city, state: r.state, priceTable: r.priceTable, notifyOptOut: r.notifyOptOut,
            salespersonId: r.salespersonId, salespersonName: r.portfolioOwner?.name ?? null,
            orders: l?._count._all ?? 0, lastPurchaseAt: lastAt, daysSinceLastPurchase: lastAt ? Math.floor((today - lastAt.getTime()) / DAY) : null,
            sold12m: fromCents(toCents(y?._sum.total ?? 0)),
            openBalance: fromCents(toCents(o?._sum.amount ?? 0) - toCents(o?._sum.paidPrincipal ?? 0)),
          };
        }),
      };
    });
  }

  /** Passa clientes de um vendedor para outro (ou para "sem carteira"). Só quem enxerga todas as vendas. */
  transfer(ctx: AuthContext, dto: TransferDto) {
    if (!ctx.permissions.has('sales.view_all')) throw new ForbiddenException('Somente quem enxerga todas as vendas pode mudar a carteira de clientes.');
    return this.prisma.withContext(ctx, async (tx) => {
      if (dto.salespersonId && !(await tx.salesperson.findFirst({ where: { id: dto.salespersonId, tenantId: ctx.tenantId!, active: true } }))) throw new BadRequestException('Vendedor inválido ou inativo.');
      const r = await tx.customer.updateMany({ where: { tenantId: ctx.tenantId!, id: { in: dto.customerIds } }, data: { salespersonId: dto.salespersonId } });
      await this.audit.record(tx, ctx, { action: 'portfolio.transferred', entity: 'customer', metadata: { to: dto.salespersonId, customers: r.count } });
      return { moved: r.count };
    });
  }
}

@Controller('portfolio')
export class PortfolioController {
  constructor(private readonly svc: PortfolioService) {}

  @Get('summary') @RequirePermissions('customers.view')
  summary(@CurrentAuth() ctx: AuthContext) { return this.svc.summary(ctx); }

  @Get() @RequirePermissions('customers.view')
  list(@CurrentAuth() ctx: AuthContext, @Query() q: PortfolioQuery) { return this.svc.list(ctx, q); }

  @Put('transfer') @HttpCode(200) @RequirePermissions('customers.manage')
  transfer(@CurrentAuth() ctx: AuthContext, @Body() dto: TransferDto) { return this.svc.transfer(ctx, dto); }
}
