import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { OrderStatus, Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';

type Tx = Prisma.TransactionClient;

const OPEN: OrderStatus[] = ['PENDING_APPROVAL', 'CONFIRMED', 'PICKING', 'PACKED', 'SHIPPED'];
const PREPARING: OrderStatus[] = ['CONFIRMED', 'PICKING', 'PACKED'];
const HOUR = 3_600_000;
const DAY = 86_400_000;
const TZ = 'America/Sao_Paulo';
const dayKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

export class OrdersDashQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90) days?: number;
}

/** Indicadores de pedidos da Visão geral. Respeita o escopo: quem não tem `sales.view_all` vê só os próprios pedidos. */
@Injectable()
export class OrdersDashboardService {
  constructor(private readonly prisma: PrismaService, private readonly settings: SettingsService) {}

  private async scope(tx: Tx, ctx: AuthContext): Promise<Prisma.SalesOrderWhereInput> {
    if (ctx.permissions.has('sales.view_all')) return {};
    const mine = await tx.salesperson.findFirst({ where: { tenantId: ctx.tenantId!, userId: ctx.userId }, select: { id: true } });
    return { OR: [{ createdById: ctx.userId }, ...(mine ? [{ salespersonId: mine.id }] : [])] };
  }

  summary(ctx: AuthContext, q: { days?: number }, now = new Date()) {
    const days = q.days ?? 30;
    return this.prisma.withContext(ctx, async (tx) => {
      const cfg = await this.settings.load(tx, ctx);
      const shipH = cfg['orders.shippingSlaHours'];
      const delD = cfg['orders.deliverySlaDays'];
      const base: Prisma.SalesOrderWhereInput = { tenantId: ctx.tenantId!, AND: [await this.scope(tx, ctx)] };
      const from = new Date(now.getTime() - days * DAY);
      const shipLimit = new Date(now.getTime() - shipH * HOUR);
      const delLimit = new Date(now.getTime() - delD * DAY);
      const startToday = new Date(`${dayKey(now)}T00:00:00-03:00`);

      const lateShipWhere: Prisma.SalesOrderWhereInput = { ...base, status: { in: PREPARING }, confirmedAt: { lt: shipLimit } };
      const lateDelWhere: Prisma.SalesOrderWhereInput = { ...base, status: 'SHIPPED', shippedAt: { lt: delLimit } };
      const pick = { id: true, number: true, status: true, channel: true, total: true, confirmedAt: true, shippedAt: true, customer: { select: { name: true } } } as const;

      const [byStatus, byChannel, newToday, createdInPeriod, shippedInPeriod, deliveredInPeriod, cancelledInPeriod, lateShipCount, lateDelCount, lateShip, lateDel, inPeriod] = await Promise.all([
        tx.salesOrder.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
        tx.salesOrder.groupBy({ by: ['channel'], where: { ...base, createdAt: { gte: from }, status: { notIn: ['DRAFT', 'CANCELLED'] } }, _count: { _all: true }, _sum: { total: true } }),
        tx.salesOrder.count({ where: { ...base, createdAt: { gte: startToday }, status: { not: 'DRAFT' } } }),
        tx.salesOrder.aggregate({ where: { ...base, createdAt: { gte: from }, status: { notIn: ['DRAFT', 'CANCELLED'] } }, _count: { _all: true }, _sum: { total: true } }),
        tx.salesOrder.count({ where: { ...base, shippedAt: { gte: from } } }),
        tx.salesOrder.count({ where: { ...base, deliveredAt: { gte: from } } }),
        tx.salesOrder.count({ where: { ...base, cancelledAt: { gte: from } } }),
        tx.salesOrder.count({ where: lateShipWhere }),
        tx.salesOrder.count({ where: lateDelWhere }),
        tx.salesOrder.findMany({ where: lateShipWhere, orderBy: { confirmedAt: 'asc' }, take: 10, select: pick }),
        tx.salesOrder.findMany({ where: lateDelWhere, orderBy: { shippedAt: 'asc' }, take: 10, select: pick }),
        tx.salesOrder.findMany({
          where: { ...base, OR: [{ createdAt: { gte: from } }, { shippedAt: { gte: from } }, { deliveredAt: { gte: from } }] },
          select: { createdAt: true, shippedAt: true, deliveredAt: true, status: true }, take: 20000,
        }),
      ]);

      const count = (s: OrderStatus) => byStatus.find((x) => x.status === s)?._count._all ?? 0;
      const series = new Map<string, { date: string; created: number; shipped: number; delivered: number }>();
      for (let i = days - 1; i >= 0; i--) {
        const k = dayKey(new Date(now.getTime() - i * DAY));
        series.set(k, { date: k, created: 0, shipped: 0, delivered: 0 });
      }
      for (const o of inPeriod) {
        if (o.status !== 'DRAFT' && o.status !== 'CANCELLED' && o.createdAt >= from) series.get(dayKey(o.createdAt))!.created++;
        if (o.shippedAt && o.shippedAt >= from) series.get(dayKey(o.shippedAt))!.shipped++;
        if (o.deliveredAt && o.deliveredAt >= from) series.get(dayKey(o.deliveredAt))!.delivered++;
      }

      const mapLate = (rows: typeof lateShip, since: 'confirmedAt' | 'shippedAt') =>
        rows.map((r) => ({ id: r.id, number: r.number, status: r.status, channel: r.channel, total: r.total.toString(), customer: r.customer.name, since: r[since], hoursLate: Math.floor((now.getTime() - (r[since]?.getTime() ?? now.getTime())) / HOUR) }));

      return {
        days,
        sla: { shippingHours: shipH, deliveryDays: delD },
        status: Object.fromEntries((['DRAFT', 'PENDING_APPROVAL', 'CONFIRMED', 'PICKING', 'PACKED', 'SHIPPED', 'DELIVERED', 'CLOSED', 'CANCELLED'] as OrderStatus[]).map((s) => [s, count(s)])),
        cards: {
          newToday,
          awaitingApproval: count('PENDING_APPROVAL'),
          toShip: PREPARING.reduce((n, s) => n + count(s), 0),
          inTransit: count('SHIPPED'),
          open: OPEN.reduce((n, s) => n + count(s), 0),
          lateShipping: lateShipCount,
          lateDelivery: lateDelCount,
          late: lateShipCount + lateDelCount,
        },
        period: {
          created: createdInPeriod._count._all,
          revenue: (createdInPeriod._sum.total ?? 0).toString(),
          shipped: shippedInPeriod,
          delivered: deliveredInPeriod,
          cancelled: cancelledInPeriod,
        },
        series: [...series.values()],
        byChannel: byChannel.map((c) => ({ channel: c.channel, orders: c._count._all, revenue: (c._sum.total ?? 0).toString() })).sort((a, b) => b.orders - a.orders),
        late: { shipping: mapLate(lateShip, 'confirmedAt'), delivery: mapLate(lateDel, 'shippedAt') },
      };
    });
  }
}

@Controller('dashboard')
export class OrdersDashboardController {
  constructor(private readonly svc: OrdersDashboardService) {}

  @Get('orders') @RequirePermissions('sales.view')
  orders(@CurrentAuth() ctx: AuthContext, @Query() q: OrdersDashQuery) { return this.svc.summary(ctx, q); }
}
