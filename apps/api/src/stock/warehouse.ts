import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { BrandingService } from '../branding/branding.service';
import { PrismaService } from '../prisma/prisma.service';
import { SalesService } from '../sales/sales.service';
import { localToday } from '../sales/cutoff';
import { addToLocation } from './lots-core';

type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const CODE = /^[A-Za-z0-9][A-Za-z0-9._\-\/ ]{0,38}$/;

class LocationDto {
  @IsUUID() warehouseId: string;
  @Matches(CODE, { message: 'Código do endereço: letras, números e - . _ / (até 40).' }) code: string;
  @IsOptional() @IsString() @MaxLength(200) description?: string;
}
class LocationUpdateDto { @IsOptional() @IsString() @MaxLength(200) description?: string; @IsOptional() @IsBoolean() active?: boolean }
class PutawayDto {
  @IsUUID() warehouseId: string;
  @IsUUID() productId: string;
  @IsOptional() @IsUUID() lotId?: string;
  @IsString() @MaxLength(40) locationCode: string;
  @IsOptional() @IsString() @MaxLength(40) fromLocationCode?: string;
  @IsInt() @Min(1) @Max(1_000_000) quantity: number;
}
class TrackingDto { @IsBoolean() enabled: boolean }
class CheckItem { @IsUUID() productId: string; @IsInt() @Min(0) @Max(1_000_000) counted: number }
class CheckDto { @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => CheckItem) items: CheckItem[]; @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) unknown?: string[] }

/** Lotes e validade, endereços do depósito, lista de separação (com sugestão FEFO e caminho por endereço) e conferência. */
@Injectable()
export class WarehouseService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly sales: SalesService) {}

  // ───────────── lotes ─────────────

  lots(ctx: AuthContext, q: { productId?: string; warehouseId?: string; status?: string; days?: number }) {
    const soon = Math.min(365, Math.max(1, q.days ?? 30));
    const today = localToday();
    return this.prisma.withContext(ctx, async (tx) => {
      const rows = await tx.stockLot.findMany({
        where: { tenantId: ctx.tenantId!, onHand: { gt: 0 }, ...(q.productId ? { productId: q.productId } : {}), ...(q.warehouseId ? { warehouseId: q.warehouseId } : {}) },
        include: { product: { select: { sku: true, name: true } }, warehouse: { select: { code: true } } }, orderBy: [{ expiresAt: { sort: 'asc', nulls: 'last' } }, { receivedAt: 'asc' }], take: 2000,
      });
      const items = rows.map((l) => {
        const exp = day(l.expiresAt);
        const daysLeft = exp ? Math.round((Date.parse(`${exp}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY) : null;
        const status = daysLeft === null ? 'SEM_VALIDADE' : daysLeft < 0 ? 'VENCIDO' : daysLeft <= soon ? 'A_VENCER' : 'OK';
        return { id: l.id, productId: l.productId, sku: l.product.sku, name: l.product.name, warehouse: l.warehouse.code, warehouseId: l.warehouseId, code: l.code, expiresAt: exp, daysLeft, onHand: l.onHand, receivedAt: l.receivedAt, status };
      });
      const filtered = q.status ? items.filter((i) => i.status === q.status) : items;
      const sum = (s: string) => items.filter((i) => i.status === s).reduce((a, i) => a + i.onHand, 0);
      return { soonDays: soon, summary: { lots: items.length, expiredUnits: sum('VENCIDO'), expiredLots: items.filter((i) => i.status === 'VENCIDO').length, soonUnits: sum('A_VENCER'), soonLots: items.filter((i) => i.status === 'A_VENCER').length }, items: filtered };
    });
  }

  /** Liga/desliga o controle de lote. Ao ligar, o saldo atual vira o lote LEGADO (sem validade) em cada depósito. */
  setTracking(ctx: AuthContext, productId: string, enabled: boolean) {
    return this.prisma.withContext(ctx, async (tx) => {
      const p = await tx.product.findFirst({ where: { id: productId, tenantId: ctx.tenantId! }, select: { trackLots: true, kind: true } });
      if (!p) throw new NotFoundException('Produto não encontrado.');
      if (p.trackLots === enabled) return { productId, trackLots: enabled, legacyLots: 0 };
      let legacy = 0;
      if (enabled) {
        await tx.$queryRaw`SELECT 1 FROM stock_balances WHERE tenant_id = ${ctx.tenantId}::uuid AND product_id = ${productId}::uuid FOR UPDATE`;
        const bals = await tx.stockBalance.findMany({ where: { tenantId: ctx.tenantId!, productId, onHand: { gt: 0 } } });
        for (const b of bals) { await tx.stockLot.create({ data: { tenantId: ctx.tenantId!, productId, warehouseId: b.warehouseId, code: 'LEGADO', onHand: b.onHand } }); legacy++; }
      } else {
        const left = await tx.stockLot.aggregate({ where: { tenantId: ctx.tenantId!, productId }, _sum: { onHand: true } });
        if ((left._sum.onHand ?? 0) > 0) throw new ConflictException('Ainda há saldo em lotes deste produto: zere o estoque antes de desligar o controle de lote.');
      }
      await tx.product.update({ where: { id: productId }, data: { trackLots: enabled } });
      await this.audit.record(tx, ctx, { action: enabled ? 'stock.lot_tracking_on' : 'stock.lot_tracking_off', entity: 'product', entityId: productId, metadata: { legacyLots: legacy } });
      return { productId, trackLots: enabled, legacyLots: legacy };
    });
  }

  // ───────────── endereços ─────────────

  locations(ctx: AuthContext, warehouseId?: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const rows = await tx.warehouseLocation.findMany({ where: { tenantId: ctx.tenantId!, ...(warehouseId ? { warehouseId } : {}) }, orderBy: [{ warehouseId: 'asc' }, { code: 'asc' }], include: { warehouse: { select: { code: true } }, items: { select: { quantity: true, productId: true } } } });
      return rows.map(({ items, warehouse, ...l }) => ({ ...l, warehouse: warehouse.code, units: items.reduce((a, i) => a + i.quantity, 0), products: new Set(items.map((i) => i.productId)).size }));
    });
  }

  createLocation(ctx: AuthContext, dto: LocationDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      if (!(await tx.warehouse.findFirst({ where: { id: dto.warehouseId, tenantId: ctx.tenantId!, active: true } }))) throw new BadRequestException('Depósito inválido ou inativo.');
      const code = dto.code.trim().toUpperCase();
      if (await tx.warehouseLocation.findFirst({ where: { tenantId: ctx.tenantId!, warehouseId: dto.warehouseId, code } })) throw new ConflictException(`O endereço ${code} já existe neste depósito.`);
      const l = await tx.warehouseLocation.create({ data: { tenantId: ctx.tenantId!, warehouseId: dto.warehouseId, code, description: dto.description?.trim() || undefined } });
      await this.audit.record(tx, ctx, { action: 'warehouse.location_created', entity: 'warehouse_location', entityId: l.id, metadata: { code } });
      return l;
    });
  }

  updateLocation(ctx: AuthContext, id: string, dto: LocationUpdateDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      const l = await tx.warehouseLocation.findFirst({ where: { id, tenantId: ctx.tenantId! }, include: { items: { select: { quantity: true } } } });
      if (!l) throw new NotFoundException('Endereço não encontrado.');
      if (dto.active === false && l.items.some((i) => i.quantity > 0)) throw new ConflictException('Este endereço ainda tem mercadoria: mova-a antes de desativar.');
      return tx.warehouseLocation.update({ where: { id }, data: { ...(dto.description !== undefined ? { description: dto.description.trim() || null } : {}), ...(dto.active !== undefined ? { active: dto.active } : {}) } });
    });
  }

  locationItems(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const l = await tx.warehouseLocation.findFirst({ where: { id, tenantId: ctx.tenantId! }, include: { warehouse: { select: { code: true } } } });
      if (!l) throw new NotFoundException('Endereço não encontrado.');
      const items = await tx.stockLocationItem.findMany({ where: { tenantId: ctx.tenantId!, locationId: id }, include: { product: { select: { sku: true, name: true } }, lot: { select: { code: true, expiresAt: true } } }, orderBy: { product: { sku: 'asc' } } });
      return { id: l.id, code: l.code, warehouse: l.warehouse.code, description: l.description, active: l.active, items: items.map((i) => ({ id: i.id, productId: i.productId, sku: i.product.sku, name: i.product.name, lotCode: i.lot?.code ?? null, expiresAt: day(i.lot?.expiresAt ?? null), quantity: i.quantity })) };
    });
  }

  /** Produtos/lotes com saldo ainda "sem endereço" (físico − soma dos endereços), para guardar. */
  unaddressed(ctx: AuthContext, warehouseId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const rows = await tx.$queryRaw<{ product_id: string; sku: string; name: string; lot_id: string | null; lot_code: string | null; expires_at: Date | null; total: number; addressed: number }[]>`
        WITH base AS (
          SELECT p.id AS product_id, p.sku, p.name, l.id AS lot_id, l.code AS lot_code, l.expires_at, l.on_hand AS total
          FROM stock_lots l JOIN products p ON p.id = l.product_id WHERE l.tenant_id = ${ctx.tenantId}::uuid AND l.warehouse_id = ${warehouseId}::uuid AND l.on_hand > 0
          UNION ALL
          SELECT p.id, p.sku, p.name, NULL, NULL, NULL, b.on_hand FROM stock_balances b JOIN products p ON p.id = b.product_id
          WHERE b.tenant_id = ${ctx.tenantId}::uuid AND b.warehouse_id = ${warehouseId}::uuid AND b.on_hand > 0 AND NOT p.track_lots)
        SELECT base.*, COALESCE((SELECT sum(i.quantity) FROM stock_location_items i JOIN warehouse_locations w ON w.id = i.location_id
          WHERE i.tenant_id = ${ctx.tenantId}::uuid AND w.warehouse_id = ${warehouseId}::uuid AND i.product_id = base.product_id AND i.lot_id IS NOT DISTINCT FROM base.lot_id), 0)::int AS addressed
        FROM base ORDER BY sku, lot_code`;
      return rows.filter((r) => r.total - r.addressed > 0).map((r) => ({ productId: r.product_id, sku: r.sku, name: r.name, lotId: r.lot_id, lotCode: r.lot_code, expiresAt: day(r.expires_at), pending: r.total - r.addressed }));
    });
  }

  /** Guarda (do "sem endereço" ou de outro endereço) uma quantidade em um endereço. Nunca passa do saldo físico. */
  putaway(ctx: AuthContext, dto: PutawayDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      const product = await tx.product.findFirst({ where: { id: dto.productId, tenantId: ctx.tenantId! }, select: { trackLots: true } });
      if (!product) throw new NotFoundException('Produto não encontrado.');
      if (product.trackLots && !dto.lotId) throw new BadRequestException('Produto com controle de lote: escolha o lote.');
      const lotId = product.trackLots ? dto.lotId! : null;
      await tx.$queryRaw`SELECT 1 FROM stock_balances WHERE tenant_id = ${ctx.tenantId}::uuid AND product_id = ${dto.productId}::uuid AND warehouse_id = ${dto.warehouseId}::uuid FOR UPDATE`;
      if (dto.fromLocationCode) {
        const from = await tx.warehouseLocation.findFirst({ where: { tenantId: ctx.tenantId!, warehouseId: dto.warehouseId, code: dto.fromLocationCode.trim().toUpperCase() } });
        const item = from ? await tx.stockLocationItem.findFirst({ where: { tenantId: ctx.tenantId!, locationId: from.id, productId: dto.productId, lotId } }) : null;
        if (!item || item.quantity < dto.quantity) throw new ConflictException(`O endereço ${dto.fromLocationCode} não tem ${dto.quantity} unidade(s) deste produto${lotId ? ' e lote' : ''}.`);
        if (item.quantity === dto.quantity) await tx.stockLocationItem.delete({ where: { id: item.id } }); else await tx.stockLocationItem.update({ where: { id: item.id }, data: { quantity: { decrement: dto.quantity } } });
      } else {
        const total = lotId ? (await tx.stockLot.findFirst({ where: { id: lotId, tenantId: ctx.tenantId!, productId: dto.productId, warehouseId: dto.warehouseId } }))?.onHand : (await tx.stockBalance.findFirst({ where: { tenantId: ctx.tenantId!, productId: dto.productId, warehouseId: dto.warehouseId } }))?.onHand;
        if (total === undefined) throw new BadRequestException('Lote ou saldo não encontrado neste depósito.');
        const agg = await tx.stockLocationItem.aggregate({ where: { tenantId: ctx.tenantId!, productId: dto.productId, lotId, location: { warehouseId: dto.warehouseId } }, _sum: { quantity: true } });
        const free = total - (agg._sum.quantity ?? 0);
        if (dto.quantity > free) throw new ConflictException(`Só há ${free} unidade(s) sem endereço${lotId ? ' neste lote' : ''} (o restante já está guardado).`);
      }
      await addToLocation(tx, ctx, dto.warehouseId, dto.locationCode, dto.productId, lotId, dto.quantity);
      await this.audit.record(tx, ctx, { action: 'warehouse.putaway', entity: 'product', entityId: dto.productId, metadata: { to: dto.locationCode, from: dto.fromLocationCode ?? null, quantity: dto.quantity, lotId } });
      return { ok: true };
    });
  }

  // ───────────── separação ─────────────

  pickingOrders(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const rows = await tx.salesOrder.findMany({
        where: { tenantId: ctx.tenantId!, status: { in: ['CONFIRMED', 'PICKING'] } }, orderBy: [{ dispatchDate: { sort: 'asc', nulls: 'last' } }, { number: 'asc' }], take: 200,
        select: { id: true, number: true, status: true, dispatchDate: true, createdAt: true, warehouse: { select: { code: true } }, customer: { select: { name: true } }, _count: { select: { items: true } }, checks: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } } },
      });
      return rows.map(({ checks, _count, warehouse, customer, ...o }) => ({ ...o, warehouse: warehouse.code, customer: customer.name, items: _count.items, lastCheck: checks[0]?.status ?? null }));
    });
  }

  /** Lista de separação (de um ou vários pedidos): por produto, de onde tirar (lote que vence primeiro, endereços em ordem de caminho). */
  pickingList(ctx: AuthContext, orderIds: string[]) {
    if (!orderIds.length || orderIds.length > 50) throw new BadRequestException('Escolha de 1 a 50 pedidos.');
    return this.prisma.withContext(ctx, async (tx) => {
      const orders = await tx.salesOrder.findMany({ where: { tenantId: ctx.tenantId!, id: { in: orderIds } }, include: { customer: { select: { name: true, minShelfLifeDays: true } }, warehouse: { select: { code: true, id: true } }, items: { include: { product: { select: { sku: true, name: true, barcode: true, trackLots: true, saleUnit: true } } } } }, orderBy: { number: 'asc' } });
      if (orders.length !== new Set(orderIds).size) throw new NotFoundException('Algum pedido não foi encontrado.');
      if (orders.some((o) => !['CONFIRMED', 'PICKING'].includes(o.status))) throw new ConflictException('A lista é só para pedidos confirmados ou em separação.');
      if (new Set(orders.map((o) => o.warehouse.id)).size > 1) throw new ConflictException('Os pedidos são de depósitos diferentes: gere uma lista por depósito.');
      const warehouseId = orders[0].warehouse.id;
      const today = localToday();
      const mkSetting = await tx.tenantSetting.findFirst({ where: { tenantId: ctx.tenantId!, key: 'lots.marketplaceMinShelfLifeDays' } });
      const minOf = (o: (typeof orders)[number]) => (o.channel === 'MARKETPLACE' ? (typeof mkSetting?.value === 'number' ? mkSetting.value : 0) : o.customer.minShelfLifeDays ?? 0);
      const minDays = new Map<string, number>(); // por produto: a maior exigência entre os pedidos da lista
      for (const o of orders) for (const i of o.items) minDays.set(i.productId, Math.max(minDays.get(i.productId) ?? 0, minOf(o)));
      const need = new Map<string, { sku: string; name: string; barcode: string | null; unit: string; tracked: boolean; qty: number; orders: { number: number; qty: number }[] }>();
      for (const o of orders) for (const i of o.items) {
        const n = need.get(i.productId) ?? { sku: i.product.sku, name: i.product.name, barcode: i.product.barcode, unit: i.product.saleUnit, tracked: i.product.trackLots, qty: 0, orders: [] };
        n.qty += i.quantity; n.orders.push({ number: o.number, qty: i.quantity }); need.set(i.productId, n);
      }
      const lines = [];
      for (const [productId, n] of need) {
        const locItems = await tx.stockLocationItem.findMany({ where: { tenantId: ctx.tenantId!, productId, location: { warehouseId } }, include: { location: { select: { code: true } } } });
        const picks: { lotCode: string | null; expiresAt: string | null; location: string | null; qty: number }[] = [];
        let left = n.qty;
        if (n.tracked) {
          const lots = await tx.stockLot.findMany({ where: { tenantId: ctx.tenantId!, productId, warehouseId, onHand: { gt: 0 } }, orderBy: [{ expiresAt: { sort: 'asc', nulls: 'last' } }, { receivedAt: 'asc' }] });
          for (const l of lots) {
            if (left === 0) break;
            if (l.expiresAt && day(l.expiresAt)! < today) continue; // vencido não vai para venda
            if (l.expiresAt && (l.expiresAt.getTime() - Date.parse(`${today}T00:00:00Z`)) / DAY < (minDays.get(productId) ?? 0)) continue; // validade menor que a exigida pelo cliente/canal
            let lotLeft = Math.min(left, l.onHand);
            const here = locItems.filter((x) => x.lotId === l.id).sort((a, b) => a.location.code.localeCompare(b.location.code));
            for (const h of here) { if (lotLeft === 0) break; const t = Math.min(lotLeft, h.quantity); picks.push({ lotCode: l.code, expiresAt: day(l.expiresAt), location: h.location.code, qty: t }); lotLeft -= t; left -= t; }
            if (lotLeft > 0) { picks.push({ lotCode: l.code, expiresAt: day(l.expiresAt), location: null, qty: lotLeft }); left -= lotLeft; }
          }
        } else {
          const here = locItems.filter((x) => x.lotId === null).sort((a, b) => a.location.code.localeCompare(b.location.code));
          for (const h of here) { if (left === 0) break; const t = Math.min(left, h.quantity); picks.push({ lotCode: null, expiresAt: null, location: h.location.code, qty: t }); left -= t; }
          if (left > 0) { picks.push({ lotCode: null, expiresAt: null, location: null, qty: left }); left = 0; }
        }
        lines.push({ productId, sku: n.sku, name: n.name, barcode: n.barcode, unit: n.unit, quantity: n.qty, shortage: left, picks, orders: n.orders });
      }
      // caminho: ordena pelo primeiro endereço de cada linha (sem endereço por último)
      lines.sort((a, b) => (a.picks[0]?.location ?? '￿').localeCompare(b.picks[0]?.location ?? '￿') || a.sku.localeCompare(b.sku));
      const company = await this.sales.companyOfWarehouse(tx, ctx.tenantId!, warehouseId);
      return { warehouse: orders[0].warehouse.code, company, generatedAt: new Date().toISOString(), orders: orders.map((o) => ({ id: o.id, number: o.number, customer: o.customer.name, dispatchDate: o.dispatchDate ? o.dispatchDate.toISOString().slice(0, 10) : null, channel: o.channel })), lines };
    });
  }

  // ───────────── conferência ─────────────

  checkInfo(ctx: AuthContext, orderId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const o = await tx.salesOrder.findFirst({ where: { id: orderId, tenantId: ctx.tenantId! }, include: { customer: { select: { name: true } }, items: { include: { product: { select: { sku: true, name: true, barcode: true } } } }, checks: { orderBy: { createdAt: 'desc' }, take: 5 } } });
      if (!o) throw new NotFoundException('Pedido não encontrado.');
      return { orderId: o.id, number: o.number, status: o.status, customer: o.customer.name, items: o.items.map((i) => ({ productId: i.productId, sku: i.product.sku, name: i.product.name, barcode: i.product.barcode, expected: i.quantity })), checks: o.checks.map((c) => ({ id: c.id, status: c.status, createdAt: c.createdAt })) };
    });
  }

  /** Registra o resultado da conferência por leitura de código de barras. OK só se todas as quantidades baterem e não houver código desconhecido. */
  saveCheck(ctx: AuthContext, orderId: string, dto: CheckDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      const o = await tx.salesOrder.findFirst({ where: { id: orderId, tenantId: ctx.tenantId! }, include: { items: { include: { product: { select: { sku: true } } } } } });
      if (!o) throw new NotFoundException('Pedido não encontrado.');
      if (!['CONFIRMED', 'PICKING', 'PACKED'].includes(o.status)) throw new ConflictException('Só é possível conferir pedido confirmado, em separação ou embalado.');
      const counted = new Map(dto.items.map((i) => [i.productId, i.counted]));
      const rows = o.items.map((i) => ({ productId: i.productId, sku: i.product.sku, expected: i.quantity, counted: counted.get(i.productId) ?? 0 }));
      const extra = dto.items.filter((i) => !o.items.some((x) => x.productId === i.productId) && i.counted > 0).map((i) => ({ productId: i.productId, counted: i.counted }));
      const unknown = dto.unknown ?? [];
      const ok = rows.every((r) => r.expected === r.counted) && !extra.length && !unknown.length;
      const c = await tx.orderCheck.create({ data: { tenantId: ctx.tenantId!, orderId, status: ok ? 'OK' : 'DIVERGENT', items: { rows, extra, unknown } as unknown as Prisma.InputJsonValue, createdById: ctx.userId } });
      await this.audit.record(tx, ctx, { action: 'warehouse.order_checked', entity: 'sales_order', entityId: orderId, metadata: { status: c.status, divergences: rows.filter((r) => r.expected !== r.counted).length, unknown: unknown.length } });
      return { id: c.id, status: c.status, rows, extra, unknown };
    });
  }
}

@Controller()
export class WarehouseController {
  constructor(private readonly svc: WarehouseService, private readonly branding: BrandingService) {}

  @Get('stock/lots') @RequirePermissions('stock.view')
  lots(@CurrentAuth() ctx: AuthContext, @Query('productId') productId?: string, @Query('warehouseId') warehouseId?: string, @Query('status') status?: string, @Query('days') days?: string) {
    return this.svc.lots(ctx, { productId, warehouseId, status, days: days ? Number(days) : undefined });
  }
  @Put('stock/lots/tracking/:productId') @RequirePermissions('stock.adjust')
  tracking(@CurrentAuth() ctx: AuthContext, @Param('productId', ParseUUIDPipe) id: string, @Body() dto: TrackingDto) { return this.svc.setTracking(ctx, id, dto.enabled); }

  @Get('warehouse/locations') @RequirePermissions('stock.view')
  locations(@CurrentAuth() ctx: AuthContext, @Query('warehouseId') warehouseId?: string) { return this.svc.locations(ctx, warehouseId); }
  @Post('warehouse/locations') @RequirePermissions('warehouse.manage')
  createLocation(@CurrentAuth() ctx: AuthContext, @Body() dto: LocationDto) { return this.svc.createLocation(ctx, dto); }
  @Put('warehouse/locations/:id') @RequirePermissions('warehouse.manage')
  updateLocation(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LocationUpdateDto) { return this.svc.updateLocation(ctx, id, dto); }
  @Get('warehouse/locations/:id/items') @RequirePermissions('stock.view')
  locationItems(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.locationItems(ctx, id); }
  @Get('warehouse/unaddressed') @RequirePermissions('stock.view')
  unaddressed(@CurrentAuth() ctx: AuthContext, @Query('warehouseId', ParseUUIDPipe) warehouseId: string) { return this.svc.unaddressed(ctx, warehouseId); }
  @Post('warehouse/putaway') @HttpCode(200) @RequirePermissions('stock.move')
  putaway(@CurrentAuth() ctx: AuthContext, @Body() dto: PutawayDto) { return this.svc.putaway(ctx, dto); }

  @Get('warehouse/picking/orders') @RequirePermissions('sales.fulfill')
  pickingOrders(@CurrentAuth() ctx: AuthContext) { return this.svc.pickingOrders(ctx); }
  @Get('warehouse/picking') @RequirePermissions('sales.fulfill')
  async pickingList(@CurrentAuth() ctx: AuthContext, @Query('orderIds') orderIds?: string) {
    const data = await this.svc.pickingList(ctx, (orderIds ?? '').split(',').map((x) => x.trim()).filter(Boolean));
    let logo: string | null = null;
    try { const l = await this.branding.get(ctx); logo = `data:${l.contentType};base64,${l.content.toString('base64')}`; } catch { /* sem logotipo cadastrado */ }
    return { ...data, logo };
  }

  @Get('warehouse/check/:orderId') @RequirePermissions('sales.fulfill')
  checkInfo(@CurrentAuth() ctx: AuthContext, @Param('orderId', ParseUUIDPipe) id: string) { return this.svc.checkInfo(ctx, id); }
  @Post('warehouse/check/:orderId') @HttpCode(200) @RequirePermissions('sales.fulfill')
  saveCheck(@CurrentAuth() ctx: AuthContext, @Param('orderId', ParseUUIDPipe) id: string, @Body() dto: CheckDto) { return this.svc.saveCheck(ctx, id, dto); }
}
