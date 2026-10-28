import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { fromCents, toCents } from '../commissions/commissions.service';
import { BrandingService } from '../branding/branding.service';
import { PrismaService } from '../prisma/prisma.service';
import { SalesService } from '../sales/sales.service';
import { localToday } from '../sales/cutoff';

const BRT = 3 * 3_600_000;
const COST_KINDS = ['FUEL', 'TOLL', 'MAINTENANCE', 'DRIVER', 'INSURANCE', 'OTHER'] as const;
const KIND_LABEL: Record<string, string> = { FUEL: 'Combustível', TOLL: 'Pedágio', MAINTENANCE: 'Manutenção', DRIVER: 'Motorista', INSURANCE: 'Seguro', OTHER: 'Outros' };
const PLATE = /^[A-Za-z]{3}-?\d[A-Za-z0-9]\d{2}$/;
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10000) / 100 : null);

class VehicleDto {
  @Matches(PLATE, { message: 'Placa inválida (ex.: ABC1D23 ou ABC-1234).' }) plate: string;
  @IsString() @MaxLength(100) description: string;
  @IsOptional() @IsIn(['MOTORCYCLE', 'VAN', 'TRUCK', 'OTHER']) kind?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100_000) capacityKg?: number;
  @IsOptional() @IsInt() @Min(1) @Max(100_000) tareKg?: number;
  @IsOptional() @Matches(/^[A-Za-z]{2}$/, { message: 'UF inválida.' }) plateUf?: string;
  @IsOptional() @Matches(/^\d{9,11}$/, { message: 'RENAVAM deve ter 9 a 11 dígitos.' }) renavam?: string;
  @IsOptional() @IsIn(['00', '01', '02', '03', '04', '05']) bodyCode?: string;
  @IsOptional() @IsString() @MaxLength(300) notes?: string;
}
class VehicleUpdateDto {
  @IsOptional() @IsString() @MaxLength(100) description?: string;
  @IsOptional() @IsIn(['MOTORCYCLE', 'VAN', 'TRUCK', 'OTHER']) kind?: string;
  @IsOptional() @ValidateIf((o) => o.capacityKg !== null) @IsInt() @Min(1) @Max(100_000) capacityKg?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(100_000) tareKg?: number;
  @IsOptional() @Matches(/^[A-Za-z]{2}$/, { message: 'UF inválida.' }) plateUf?: string;
  @IsOptional() @Matches(/^\d{9,11}$/, { message: 'RENAVAM deve ter 9 a 11 dígitos.' }) renavam?: string;
  @IsOptional() @IsIn(['00', '01', '02', '03', '04', '05']) bodyCode?: string;
  @IsOptional() @IsString() @MaxLength(300) notes?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
class AssignDto { @IsOptional() @ValidateIf((o) => o.vehicleId !== null) @IsUUID() vehicleId: string | null }
class CostDto {
  @IsUUID() vehicleId: string;
  @IsOptional() @IsUUID() routeId?: string;
  @IsIn(COST_KINDS as unknown as string[]) kind: string;
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false }) @Min(0.01) @Max(1e8) amount: number;
  @IsDateString() date: string;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}
class RangeQuery { @IsOptional() @IsString() from?: string; @IsOptional() @IsString() to?: string; @IsOptional() @IsUUID() vehicleId?: string }

/** Frota e carga: veículos, capacidade x peso da viagem, custos (combustível, pedágio...) e custo de frete por entrega e sobre a venda. */
@Injectable()
export class FleetService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly sales: SalesService) {}

  vehicles(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const rows = await tx.vehicle.findMany({ where: { tenantId: ctx.tenantId! }, orderBy: [{ active: 'desc' }, { plate: 'asc' }], include: { _count: { select: { routes: true } } } });
      return rows.map(({ _count, ...v }) => ({ ...v, routes: _count.routes }));
    });
  }

  createVehicle(ctx: AuthContext, dto: VehicleDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      const plate = dto.plate.toUpperCase().replace('-', '');
      if (await tx.vehicle.findFirst({ where: { tenantId: ctx.tenantId!, plate } })) throw new ConflictException(`Já existe um veículo com a placa ${plate}.`);
      const v = await tx.vehicle.create({ data: { tenantId: ctx.tenantId!, plate, description: dto.description.trim(), kind: dto.kind ?? 'VAN', capacityKg: dto.capacityKg, tareKg: dto.tareKg, plateUf: dto.plateUf?.toUpperCase(), renavam: dto.renavam, bodyCode: dto.bodyCode ?? '00', notes: dto.notes } });
      await this.audit.record(tx, ctx, { action: 'fleet.vehicle_created', entity: 'vehicle', entityId: v.id, metadata: { plate } });
      return v;
    });
  }

  updateVehicle(ctx: AuthContext, id: string, dto: VehicleUpdateDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      const v = await tx.vehicle.findFirst({ where: { id, tenantId: ctx.tenantId! } });
      if (!v) throw new NotFoundException('Veículo não encontrado.');
      if (dto.active === false && (await tx.deliveryRoute.count({ where: { tenantId: ctx.tenantId!, vehicleId: id, status: { in: ['PLANNED', 'IN_PROGRESS'] } } })) > 0) throw new ConflictException('O veículo está em uma viagem planejada ou em andamento.');
      return tx.vehicle.update({ where: { id }, data: { ...(dto.description !== undefined ? { description: dto.description.trim() } : {}), ...(dto.kind ? { kind: dto.kind } : {}), ...(dto.capacityKg !== undefined ? { capacityKg: dto.capacityKg } : {}), ...(dto.tareKg !== undefined ? { tareKg: dto.tareKg } : {}), ...(dto.plateUf ? { plateUf: dto.plateUf.toUpperCase() } : {}), ...(dto.renavam !== undefined ? { renavam: dto.renavam } : {}), ...(dto.bodyCode ? { bodyCode: dto.bodyCode } : {}), ...(dto.notes !== undefined ? { notes: dto.notes } : {}), ...(dto.active !== undefined ? { active: dto.active } : {}) } });
    });
  }

  /** Peso (kg) e valor dos pedidos de uma viagem. Produto sem peso cadastrado entra como zero e é contado em `itemsWithoutWeight`. */
  private async load(tx: Parameters<Parameters<PrismaService['withContext']>[1]>[0], tenantId: string, routeId: string) {
    const rows = await tx.$queryRaw<{ order_id: string; grams: string | null; missing: number; total: string }[]>`
      SELECT o.id AS order_id, o.total, sum(i.quantity * COALESCE(p.gross_weight_g, p.net_weight_g, 0))::bigint AS grams,
             count(*) FILTER (WHERE COALESCE(p.gross_weight_g, p.net_weight_g) IS NULL)::int AS missing
      FROM delivery_stops s JOIN sales_orders o ON o.id = s.sales_order_id JOIN sales_order_items i ON i.order_id = o.id JOIN products p ON p.id = i.product_id
      WHERE s.tenant_id = ${tenantId}::uuid AND s.route_id = ${routeId}::uuid AND s.status <> 'CANCELLED' GROUP BY o.id, o.total`;
    const grams = rows.reduce((s, r) => s + Number(r.grams ?? 0), 0);
    return { orders: rows.length, weightKg: Math.round(grams / 10) / 100, itemsWithoutWeight: rows.reduce((s, r) => s + r.missing, 0), value: fromCents(rows.reduce((s, r) => s + toCents(r.total), 0)) };
  }

  assign(ctx: AuthContext, routeId: string, vehicleId: string | null) {
    return this.prisma.withContext(ctx, async (tx) => {
      const r = await tx.deliveryRoute.findFirst({ where: { id: routeId, tenantId: ctx.tenantId! } });
      if (!r) throw new NotFoundException('Viagem não encontrada.');
      if (['COMPLETED', 'CANCELLED'].includes(r.status)) throw new ConflictException('Viagem já encerrada.');
      let capacityKg: number | null = null;
      if (vehicleId) {
        const v = await tx.vehicle.findFirst({ where: { id: vehicleId, tenantId: ctx.tenantId!, active: true } });
        if (!v) throw new BadRequestException('Veículo inválido ou inativo.');
        capacityKg = v.capacityKg;
        const clash = await tx.deliveryRoute.findFirst({ where: { tenantId: ctx.tenantId!, vehicleId, routeDate: r.routeDate, status: { in: ['PLANNED', 'IN_PROGRESS'] }, NOT: { id: routeId } }, select: { number: true } });
        if (clash) throw new ConflictException(`O veículo já está na viagem #${clash.number} neste dia.`);
      }
      await tx.deliveryRoute.update({ where: { id: routeId }, data: { vehicleId } });
      const load = await this.load(tx, ctx.tenantId!, routeId);
      await this.audit.record(tx, ctx, { action: 'fleet.vehicle_assigned', entity: 'delivery_route', entityId: routeId, metadata: { vehicleId, weightKg: load.weightKg } });
      return { routeId, vehicleId, ...load, capacityKg, overCapacity: capacityKg !== null && load.weightKg > capacityKg };
    });
  }

  routeLoad(ctx: AuthContext, routeId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const r = await tx.deliveryRoute.findFirst({ where: { id: routeId, tenantId: ctx.tenantId! }, include: { vehicle: true } });
      if (!r) throw new NotFoundException('Viagem não encontrada.');
      const load = await this.load(tx, ctx.tenantId!, routeId);
      const cap = r.vehicle?.capacityKg ?? null;
      const costs = await tx.fleetCost.aggregate({ where: { tenantId: ctx.tenantId!, routeId }, _sum: { amount: true } });
      return { routeId, vehicle: r.vehicle ? { id: r.vehicle.id, plate: r.vehicle.plate, description: r.vehicle.description } : null, ...load, capacityKg: cap, usedPct: cap ? pct(load.weightKg, cap) : null, overCapacity: cap !== null && load.weightKg > cap, cost: fromCents(toCents(costs._sum.amount ?? 0)) };
    });
  }

  addCost(ctx: AuthContext, dto: CostDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      const v = await tx.vehicle.findFirst({ where: { id: dto.vehicleId, tenantId: ctx.tenantId! } });
      if (!v) throw new BadRequestException('Veículo não encontrado.');
      if (dto.routeId) {
        const r = await tx.deliveryRoute.findFirst({ where: { id: dto.routeId, tenantId: ctx.tenantId! } });
        if (!r) throw new BadRequestException('Viagem não encontrada.');
        if (r.vehicleId !== dto.vehicleId) throw new ConflictException('A viagem não usa este veículo.');
      }
      const date = dto.date.slice(0, 10);
      if (date > localToday()) throw new BadRequestException('A data do custo não pode ser futura.');
      const c = await tx.fleetCost.create({ data: { tenantId: ctx.tenantId!, vehicleId: dto.vehicleId, routeId: dto.routeId, kind: dto.kind, amount: dto.amount, date: new Date(`${date}T00:00:00Z`), note: dto.note, createdById: ctx.userId } });
      await this.audit.record(tx, ctx, { action: 'fleet.cost_added', entity: 'fleet_cost', entityId: c.id, metadata: { kind: dto.kind, amount: dto.amount, vehicleId: dto.vehicleId, routeId: dto.routeId ?? null } });
      return c;
    });
  }

  costs(ctx: AuthContext, q: { vehicleId?: string; from?: string; to?: string }) {
    return this.prisma.withContext(ctx, async (tx) => {
      const { start, end } = this.period(q.from, q.to);
      const rows = await tx.fleetCost.findMany({ where: { tenantId: ctx.tenantId!, date: { gte: start, lt: end }, ...(q.vehicleId ? { vehicleId: q.vehicleId } : {}) }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 500, include: { vehicle: { select: { plate: true } } } });
      return rows.map(({ vehicle, ...c }) => ({ ...c, plate: vehicle.plate, kindLabel: KIND_LABEL[c.kind] }));
    });
  }

  private period(from?: string, to?: string) {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    const f = from ?? new Date(Date.now() - BRT - 30 * 86_400_000).toISOString().slice(0, 10); const t = to ?? localToday();
    if (!re.test(f) || !re.test(t) || t < f) throw new BadRequestException('Período inválido.');
    return { from: f, to: t, start: new Date(`${f}T00:00:00Z`), end: new Date(Date.parse(`${t}T00:00:00Z`) + 86_400_000) };
  }

  /** Custo por veículo no período: viagens, entregas, custo por tipo, custo por entrega e quanto representa das vendas entregues. */
  summary(ctx: AuthContext, q: { from?: string; to?: string }) {
    const p = this.period(q.from, q.to);
    return this.prisma.withContext(ctx, async (tx) => {
      const [vehicles, costs, routes] = await Promise.all([
        tx.vehicle.findMany({ where: { tenantId: ctx.tenantId! }, orderBy: { plate: 'asc' } }),
        tx.fleetCost.groupBy({ by: ['vehicleId', 'kind'], where: { tenantId: ctx.tenantId!, date: { gte: p.start, lt: p.end } }, _sum: { amount: true } }),
        tx.$queryRaw<{ vehicle_id: string; routes: number; stops: number; delivered: number; sales: string | null }[]>`
          SELECT r.vehicle_id, count(DISTINCT r.id)::int AS routes, count(s.id) FILTER (WHERE s.status <> 'CANCELLED')::int AS stops,
                 count(s.id) FILTER (WHERE s.status = 'DELIVERED')::int AS delivered, sum(o.total) FILTER (WHERE s.status = 'DELIVERED') AS sales
          FROM delivery_routes r LEFT JOIN delivery_stops s ON s.route_id = r.id LEFT JOIN sales_orders o ON o.id = s.sales_order_id
          WHERE r.tenant_id = ${ctx.tenantId}::uuid AND r.vehicle_id IS NOT NULL AND r.route_date >= ${p.from}::date AND r.route_date <= ${p.to}::date AND r.status <> 'CANCELLED' GROUP BY r.vehicle_id`,
      ]);
      const rows = vehicles.map((v) => {
        const c = costs.filter((x) => x.vehicleId === v.id);
        const total = c.reduce((s, x) => s + toCents(x._sum.amount ?? 0), 0);
        const r = routes.find((x) => x.vehicle_id === v.id);
        const sales = toCents(r?.sales ?? 0);
        return { vehicleId: v.id, plate: v.plate, description: v.description, active: v.active, routes: r?.routes ?? 0, stops: r?.stops ?? 0, delivered: r?.delivered ?? 0, cost: fromCents(total), byKind: Object.fromEntries(c.map((x) => [x.kind, fromCents(toCents(x._sum.amount ?? 0))])), costPerDelivery: r?.delivered ? fromCents(Math.round(total / r.delivered)) : null, sales: fromCents(sales), costOverSalesPct: pct(total, sales) };
      }).filter((v) => v.routes > 0 || Number(v.cost) > 0);
      const t = rows.reduce((s, r) => ({ cost: s.cost + toCents(r.cost), delivered: s.delivered + r.delivered, sales: s.sales + toCents(r.sales) }), { cost: 0, delivered: 0, sales: 0 });
      return { from: p.from, to: p.to, rows, totals: { cost: fromCents(t.cost), delivered: t.delivered, sales: fromCents(t.sales), costPerDelivery: t.delivered ? fromCents(Math.round(t.cost / t.delivered)) : null, costOverSalesPct: pct(t.cost, t.sales) }, kinds: KIND_LABEL,
        basis: 'Custo = lançamentos de frota com data no período. Entregas e vendas = viagens do período (data da rota) não canceladas, só paradas entregues. Custo sobre vendas = custo ÷ valor dos pedidos entregues.' };
    });
  }

  /**
   * Manifesto de carga da viagem (conferência e apoio à emissão do MDF-e): veículo, motorista, pedidos, peso, valor e chaves das NF-e autorizadas.
   * NÃO é o MDF-e: o sistema ainda não o emite nem o transmite à SEFAZ.
   */
  async manifest(ctx: AuthContext, routeId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const r = await tx.deliveryRoute.findFirst({ where: { id: routeId, tenantId: ctx.tenantId! }, include: { vehicle: true, driver: true, stops: { orderBy: { sequence: 'asc' } } } });
      if (!r) throw new NotFoundException('Viagem não encontrada.');
      const orderIds = r.stops.filter((s) => s.status !== 'CANCELLED').map((s) => s.salesOrderId);
      const [orders, docs, load, items] = await Promise.all([
        tx.salesOrder.findMany({ where: { tenantId: ctx.tenantId!, id: { in: orderIds } }, select: { id: true, number: true, total: true, warehouseId: true } }),
        tx.fiscalDocument.findMany({ where: { tenantId: ctx.tenantId!, salesOrderId: { in: orderIds }, direction: 'EXIT', status: 'AUTHORIZED' }, select: { salesOrderId: true, model: true, number: true, series: true, accessKey: true } }),
        this.load(tx, ctx.tenantId!, routeId),
        tx.salesOrderItem.findMany({ where: { tenantId: ctx.tenantId!, orderId: { in: orderIds } }, orderBy: { product: { name: 'asc' } }, select: { orderId: true, quantity: true, product: { select: { sku: true, name: true, saleUnit: true } } } }),
      ]);
      const stops = r.stops.filter((s) => s.status !== 'CANCELLED').map((s) => {
        const o = orders.find((x) => x.id === s.salesOrderId); const d = docs.filter((x) => x.salesOrderId === s.salesOrderId);
        return { sequence: s.sequence, orderNumber: o?.number ?? null, customer: s.customerName, city: s.city, state: s.state, address: s.addressText, value: o ? Number(o.total) : 0, phone: s.customerPhone, items: items.filter((i) => i.orderId === s.salesOrderId).map((i) => ({ sku: i.product.sku, name: i.product.name, unit: i.product.saleUnit, quantity: i.quantity })), documents: d.map((x) => ({ model: x.model, number: x.number, series: x.series, accessKey: x.accessKey })), status: s.status };
      });
      const withoutNote = stops.filter((s) => !s.documents.length).map((s) => s.orderNumber);
      const states = [...new Set(stops.map((s) => s.state).filter(Boolean))] as string[];
      const cap = r.vehicle?.capacityKg ?? null;
      const company = orders[0] ? await this.sales.companyOfWarehouse(tx, ctx.tenantId!, orders[0].warehouseId) : null; // cabeçalho do documento: empresa do depósito de saída
      return {
        company, generatedAt: new Date().toISOString(),
        route: { id: r.id, number: r.number, date: r.routeDate.toISOString().slice(0, 10), status: r.status, notes: r.notes, startedAt: r.startedAt },
        vehicle: r.vehicle ? { plate: r.vehicle.plate, description: r.vehicle.description, kind: r.vehicle.kind, capacityKg: cap } : null,
        driver: { name: r.driver.name, phone: r.driver.phone }, stops, states, ...load, overCapacity: cap !== null && load.weightKg > cap,
        warnings: [...(r.vehicle ? [] : ['Viagem sem veículo definido.']), ...(withoutNote.length ? [`Pedido(s) sem NF-e autorizada: ${withoutNote.join(', ')}. O transporte de mercadoria exige o documento fiscal.`] : []), ...(cap !== null && load.weightKg > cap ? [`Carga de ${load.weightKg} kg passa da capacidade do veículo (${cap} kg).`] : []), ...(load.itemsWithoutWeight ? [`${load.itemsWithoutWeight} item(ns) sem peso cadastrado: o peso total está subestimado.`] : [])],
        notice: 'Este manifesto é um documento de conferência. Não é o MDF-e (Manifesto Eletrônico de Documentos Fiscais), que ainda não é emitido pelo sistema.',
      };
    });
  }
}

@Controller()
export class FleetController {
  constructor(private readonly svc: FleetService, private readonly branding: BrandingService) {}

  @Get('fleet/vehicles') @RequirePermissions('routes.view')
  vehicles(@CurrentAuth() ctx: AuthContext) { return this.svc.vehicles(ctx); }
  @Post('fleet/vehicles') @RequirePermissions('routes.manage')
  createVehicle(@CurrentAuth() ctx: AuthContext, @Body() dto: VehicleDto) { return this.svc.createVehicle(ctx, dto); }
  @Put('fleet/vehicles/:id') @RequirePermissions('routes.manage')
  updateVehicle(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VehicleUpdateDto) { return this.svc.updateVehicle(ctx, id, dto); }

  @Put('fleet/routes/:id/vehicle') @RequirePermissions('routes.manage')
  assign(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignDto) { return this.svc.assign(ctx, id, dto.vehicleId ?? null); }
  @Get('fleet/routes/:id/load') @RequirePermissions('routes.view')
  load(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.routeLoad(ctx, id); }
  @Get('fleet/routes/:id/manifest') @RequirePermissions('routes.view')
  async manifest(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    const data = await this.svc.manifest(ctx, id);
    let logo: string | null = null;
    try { const l = await this.branding.get(ctx); logo = `data:${l.contentType};base64,${l.content.toString('base64')}`; } catch { /* sem logotipo cadastrado */ }
    return { ...data, logo };
  }

  @Post('fleet/costs') @HttpCode(200) @RequirePermissions('routes.manage')
  addCost(@CurrentAuth() ctx: AuthContext, @Body() dto: CostDto) { return this.svc.addCost(ctx, dto); }
  @Get('fleet/costs') @RequirePermissions('routes.view')
  costs(@CurrentAuth() ctx: AuthContext, @Query() q: RangeQuery) { return this.svc.costs(ctx, q); }
  @Get('fleet/summary') @RequirePermissions('routes.view')
  summary(@CurrentAuth() ctx: AuthContext, @Query() q: RangeQuery) { return this.svc.summary(ctx, q); }
}
