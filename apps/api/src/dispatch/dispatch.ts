import { Body, Controller, Get, Injectable, NotFoundException, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';
import { localToday } from '../sales/cutoff';
import { SettingsService } from '../settings/settings.service';

type Tx = Prisma.TransactionClient;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Tempo máximo esperado em cada etapa antes de virar alerta "parado". */
export const STUCK_PICKING_HOURS = 4;
export const STUCK_PACKED_HOURS = 6;

export type Stage = 'WAITING' | 'PICKING' | 'PACKED' | 'SHIPPED' | 'DELIVERED';
export type Flag = 'LATE' | 'DUE_TODAY' | 'STUCK' | 'DIVERGENT' | 'RUSH';
const STAGE_OF: Record<string, Stage> = { CONFIRMED: 'WAITING', PICKING: 'PICKING', PACKED: 'PACKED', SHIPPED: 'SHIPPED', DELIVERED: 'DELIVERED' };

export interface QueueItem {
  id: string; number: number; status: string; stage: Stage; channel: string; customer: string; city: string | null; state: string | null; warehouse: string;
  items: number; units: number; weightKg: number; dispatchDate: string | null; dispatchDeferred: boolean;
  confirmedAt: string | null; stageSince: string | null; ageHours: number; stageHours: number;
  rush: boolean; rushReason: string | null; note: string | null; pickingBy: string | null; packedBy: string | null; lastCheck: string | null;
  shipment: { carrier: string; trackingCode: string | null; status: string } | null; flags: Flag[];
}

class RushDto { @IsBoolean() rush: boolean; @IsOptional() @IsString() @MaxLength(200) reason?: string }
class NoteDto { @IsString() @MaxLength(500) note: string }

/**
 * Expedição: o pedido confirmado em Vendas cai aqui. A fila mostra cada pedido na sua etapa (aguardando, em separação, embalado/pronto,
 * expedido, entregue), com tempo na etapa, responsável, urgência e os alertas (atrasado, saída hoje, parado, divergência na conferência).
 * As ações de mudar de etapa usam as mesmas regras de sempre (`/sales/orders/:id/advance`: estoque, conferência obrigatória, comissão, avisos).
 */
@Injectable()
export class DispatchService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService) {}

  /** Fila completa: abertos (aguardando, separando, embalados) + expedidos (7 dias) + entregues (3 dias, para encerrar). */
  private async load(tx: Tx, tenantId: string, now: Date): Promise<QueueItem[]> {
    const today = localToday(now);
    const sla = (await this.settings.load(tx, { tenantId }))['orders.shippingSlaHours'];
    const rows = await tx.salesOrder.findMany({
      where: {
        tenantId,
        OR: [
          { status: { in: ['CONFIRMED', 'PICKING', 'PACKED'] } },
          { status: 'SHIPPED', shippedAt: { gte: new Date(now.getTime() - 7 * DAY) } },
          { status: 'DELIVERED', deliveredAt: { gte: new Date(now.getTime() - 3 * DAY) } },
        ],
      },
      orderBy: [{ rush: 'desc' }, { dispatchDate: { sort: 'asc', nulls: 'last' } }, { confirmedAt: 'asc' }], take: 400,
      select: {
        id: true, number: true, status: true, channel: true, dispatchDate: true, dispatchDeferred: true, confirmedAt: true, pickingStartedAt: true, pickingById: true, packedAt: true, packedById: true,
        shippedAt: true, deliveredAt: true, rush: true, rushReason: true, fulfillmentNote: true,
        customer: { select: { name: true, city: true, state: true } }, warehouse: { select: { code: true } }, _count: { select: { items: true } },
        checks: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } },
        shipments: { where: { status: { not: 'CANCELLED' } }, orderBy: { createdAt: 'desc' }, take: 1, select: { carrier: true, trackingCode: true, status: true } },
      },
    });
    const ids = rows.map((r) => r.id);
    const agg = ids.length
      ? await tx.$queryRaw<{ order_id: string; units: number; grams: string | null }[]>`
          SELECT i.order_id, sum(i.quantity)::int AS units, sum(i.quantity * COALESCE(p.gross_weight_g, p.net_weight_g, 0))::bigint AS grams
          FROM sales_order_items i JOIN products p ON p.id = i.product_id WHERE i.tenant_id = ${tenantId}::uuid AND i.order_id = ANY(${ids}::uuid[]) GROUP BY i.order_id`
      : [];
    const byOrder = new Map(agg.map((a) => [a.order_id, a]));
    const userIds = [...new Set(rows.flatMap((r) => [r.pickingById, r.packedById]).filter((x): x is string => !!x))];
    const users = userIds.length ? await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
    const name = new Map(users.map((u) => [u.id, u.name]));

    return rows.map((r) => {
      const stage = STAGE_OF[r.status];
      const since = stage === 'WAITING' ? r.confirmedAt : stage === 'PICKING' ? r.pickingStartedAt ?? r.confirmedAt : stage === 'PACKED' ? r.packedAt ?? r.pickingStartedAt ?? r.confirmedAt : stage === 'SHIPPED' ? r.shippedAt : r.deliveredAt;
      const ageHours = r.confirmedAt ? Math.floor((now.getTime() - r.confirmedAt.getTime()) / HOUR) : 0;
      const stageHours = since ? Math.floor((now.getTime() - since.getTime()) / HOUR) : 0;
      const dispatch = r.dispatchDate ? r.dispatchDate.toISOString().slice(0, 10) : null;
      const open = stage === 'WAITING' || stage === 'PICKING' || stage === 'PACKED';
      const flags: Flag[] = [];
      if (open && ((dispatch && dispatch < today) || ageHours > sla)) flags.push('LATE');
      if (open && dispatch === today) flags.push('DUE_TODAY');
      if ((stage === 'PICKING' && stageHours >= STUCK_PICKING_HOURS) || (stage === 'PACKED' && stageHours >= STUCK_PACKED_HOURS)) flags.push('STUCK');
      if ((stage === 'PICKING' || stage === 'WAITING') && r.checks[0]?.status === 'DIVERGENT') flags.push('DIVERGENT');
      if (open && r.rush) flags.push('RUSH');
      const a = byOrder.get(r.id);
      return {
        id: r.id, number: r.number, status: r.status, stage, channel: r.channel, customer: r.customer.name, city: r.customer.city, state: r.customer.state, warehouse: r.warehouse.code,
        items: r._count.items, units: a?.units ?? 0, weightKg: Math.round(Number(a?.grams ?? 0)) / 1000, dispatchDate: dispatch, dispatchDeferred: r.dispatchDeferred,
        confirmedAt: r.confirmedAt?.toISOString() ?? null, stageSince: since?.toISOString() ?? null, ageHours, stageHours,
        rush: r.rush, rushReason: r.rushReason, note: r.fulfillmentNote, pickingBy: r.pickingById ? name.get(r.pickingById) ?? null : null, packedBy: r.packedById ? name.get(r.packedById) ?? null : null,
        lastCheck: r.checks[0]?.status ?? null, shipment: r.shipments[0] ?? null, flags,
      };
    });
  }

  queue(ctx: AuthContext, now = new Date()) {
    return this.prisma.withContext(ctx, (tx) => this.load(tx, ctx.tenantId!, now));
  }

  /** Painel: números por etapa, tempo médio até expedir, expedições por dia e os alertas com os pedidos envolvidos. */
  overview(ctx: AuthContext, now = new Date()) {
    return this.prisma.withContext(ctx, async (tx) => {
      const q = await this.load(tx, ctx.tenantId!, now);
      const cfg = await this.settings.load(tx, ctx);
      const today = localToday(now);
      const count = (st: Stage) => q.filter((x) => x.stage === st).length;
      const open = q.filter((x) => ['WAITING', 'PICKING', 'PACKED'].includes(x.stage));

      const since = new Date(now.getTime() - 7 * DAY);
      const shipped = await tx.salesOrder.findMany({ where: { tenantId: ctx.tenantId!, shippedAt: { gte: since } }, select: { confirmedAt: true, shippedAt: true } });
      const dayKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
      const series: { date: string; shipped: number }[] = [];
      for (let i = 6; i >= 0; i--) series.push({ date: dayKey(new Date(now.getTime() - i * DAY)), shipped: 0 });
      for (const s of shipped) { const row = series.find((x) => x.date === dayKey(s.shippedAt!)); if (row) row.shipped++; }
      const hours = shipped.filter((s) => s.confirmedAt && s.shippedAt).map((s) => (s.shippedAt!.getTime() - s.confirmedAt!.getTime()) / HOUR);
      const avgHoursToShip = hours.length ? Math.round((hours.reduce((a, b) => a + b, 0) / hours.length) * 10) / 10 : null;

      // corte do dia (se configurado): quanto falta para o horário-limite de hoje (Brasília)
      const cutoff = cfg['sales.cutoffTime'] || null;
      let minutesToCutoff: number | null = null;
      if (cutoff) {
        const [h, m] = cutoff.split(':').map(Number);
        const nowBrt = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false }).format(now).split(':').map(Number);
        minutesToCutoff = h * 60 + m - (nowBrt[0] * 60 + nowBrt[1]);
      }

      const withFlag = (f: Flag) => open.filter((x) => x.flags.includes(f));
      const pack = (list: QueueItem[]) => ({ count: list.length, orders: list.slice(0, 6).map((x) => ({ id: x.id, number: x.number })) });
      const alerts: { key: string; severity: 'danger' | 'warn' | 'info'; title: string; detail: string; count: number; orders: { id: string; number: number }[] }[] = [];
      const add = (key: string, severity: 'danger' | 'warn' | 'info', title: string, detail: string, list: QueueItem[]) => { if (list.length) alerts.push({ key, severity, title, detail, ...pack(list) }); };
      add('LATE', 'danger', 'Pedidos atrasados', `Saída prevista vencida ou mais de ${cfg['orders.shippingSlaHours']} h desde a confirmação e ainda não expedidos.`, withFlag('LATE'));
      add('DIVERGENT', 'danger', 'Divergência na conferência', 'A última conferência acusou diferença: confira de novo antes de embalar.', withFlag('DIVERGENT'));
      add('DUE_TODAY', 'warn', 'Saem hoje', cutoff ? `Pedidos com saída prevista para hoje. Horário de corte: ${cutoff}${minutesToCutoff !== null ? (minutesToCutoff > 0 ? ` (faltam ${Math.floor(minutesToCutoff / 60)} h ${minutesToCutoff % 60} min)` : ' (já passou)') : ''}.` : 'Pedidos com saída prevista para hoje.', withFlag('DUE_TODAY').filter((x) => x.stage !== 'PACKED'));
      add('STUCK', 'warn', 'Parados na etapa', `Em separação há ${STUCK_PICKING_HOURS} h ou mais, ou embalados há ${STUCK_PACKED_HOURS} h ou mais sem sair.`, withFlag('STUCK'));
      add('RUSH', 'info', 'Urgentes em aberto', 'Pedidos marcados como urgentes pela expedição.', withFlag('RUSH'));
      add('READY', 'info', 'Prontos para expedir', 'Embalados esperando sair.', open.filter((x) => x.stage === 'PACKED' && !x.flags.includes('STUCK')));

      return {
        today, cutoff, minutesToCutoff, slaHours: cfg['orders.shippingSlaHours'], requireCheck: cfg['warehouse.requireCheck'],
        stages: { waiting: count('WAITING'), picking: count('PICKING'), packed: count('PACKED'), shipped: count('SHIPPED'), delivered: count('DELIVERED') },
        late: withFlag('LATE').length, dueToday: withFlag('DUE_TODAY').length, rush: withFlag('RUSH').length, divergent: withFlag('DIVERGENT').length, stuck: withFlag('STUCK').length,
        shippedToday: shipped.filter((s) => s.shippedAt && dayKey(s.shippedAt) === today).length, avgHoursToShip, series, alerts,
        weightOpenKg: Math.round(open.reduce((s, x) => s + x.weightKg, 0) * 10) / 10,
      };
    });
  }

  setRush(ctx: AuthContext, id: string, dto: RushDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      const o = await tx.salesOrder.findFirst({ where: { id, tenantId: ctx.tenantId!, status: { in: ['CONFIRMED', 'PICKING', 'PACKED'] } }, select: { id: true } });
      if (!o) throw new NotFoundException('Pedido não encontrado ou já expedido.');
      await tx.salesOrder.update({ where: { id }, data: { rush: dto.rush, rushReason: dto.rush ? dto.reason?.trim() || null : null } });
      await this.audit.record(tx, ctx, { action: dto.rush ? 'dispatch.rush_set' : 'dispatch.rush_cleared', entity: 'sales_order', entityId: id, metadata: { reason: dto.reason } });
      return { ok: true };
    });
  }

  setNote(ctx: AuthContext, id: string, note: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const r = await tx.salesOrder.updateMany({ where: { id, tenantId: ctx.tenantId! }, data: { fulfillmentNote: note.trim() || null } });
      if (r.count !== 1) throw new NotFoundException('Pedido não encontrado.');
      await this.audit.record(tx, ctx, { action: 'dispatch.note_set', entity: 'sales_order', entityId: id });
      return { ok: true };
    });
  }
}

@Controller('dispatch')
export class DispatchController {
  constructor(private readonly svc: DispatchService) {}

  @Get('overview') @RequirePermissions('sales.fulfill')
  overview(@CurrentAuth() ctx: AuthContext) { return this.svc.overview(ctx); }

  @Get('queue') @RequirePermissions('sales.fulfill')
  queue(@CurrentAuth() ctx: AuthContext) { return this.svc.queue(ctx); }

  @Put('orders/:id/rush') @RequirePermissions('sales.fulfill')
  rush(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RushDto) { return this.svc.setRush(ctx, id, dto); }

  @Put('orders/:id/note') @RequirePermissions('sales.fulfill')
  note(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: NoteDto) { return this.svc.setNote(ctx, id, dto.note); }
}
