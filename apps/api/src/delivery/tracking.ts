import { BadRequestException, Body, Controller, Get, HttpCode, Injectable, Logger, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsNumber, IsOptional, ValidateNested } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';
import { distanceToPolyline, downsample, Geocoder, haversine, LatLng, RoutePlanner, validLat, validLng } from './geo';

type Tx = Prisma.TransactionClient;
const MIN = 60_000;
/** Sem posição há mais que isso: "sem sinal". */
export const NO_SIGNAL_MS = 3 * MIN;
/** Distância ao trajeto planejado acima da qual (nos últimos pontos) o motorista está "fora da rota". */
export const OFF_ROUTE_M = 300;
const STOPPED_MS = 15 * MIN;
const NEAR_STOP_M = 150;
const AVG_SPEED_KMH = 30;

class PointDto {
  @IsNumber({ allowNaN: false, allowInfinity: false }) lat: number;
  @IsNumber({ allowNaN: false, allowInfinity: false }) lng: number;
  @IsOptional() @IsNumber() accuracyM?: number;
  @IsOptional() @IsNumber() speedMps?: number;
  @IsOptional() @IsNumber() heading?: number;
  @IsDateString() recordedAt: string;
}
class GpsDto {
  @IsBoolean() enabled: boolean;
  @IsOptional() @IsIn(['granted', 'denied', 'prompt']) permission?: 'granted' | 'denied' | 'prompt';
  @IsOptional() @IsIn(['APP', 'WEB']) source?: 'APP' | 'WEB';
}
class PositionDto {
  @IsOptional() @IsArray() @ArrayMaxSize(60) @ValidateNested({ each: true }) @Type(() => PointDto) points?: PointDto[];
  @ValidateNested() @Type(() => GpsDto) gps: GpsDto;
}

export type Flag = 'GPS_OFF' | 'NO_SIGNAL' | 'OFF_ROUTE' | 'STOPPED';

@Injectable()
export class TrackingService {
  private readonly log = new Logger(TrackingService.name);
  private purgedAt = 0;
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly geocoder: Geocoder, private readonly planner: RoutePlanner) {}

  private async myDriver(tx: Tx, ctx: AuthContext) {
    const d = await tx.driver.findFirst({ where: { tenantId: ctx.tenantId!, userId: ctx.userId, active: true }, select: { id: true, name: true } });
    if (!d) throw new NotFoundException('Você não tem cadastro de motorista.');
    return d;
  }

  // ───────────── envio da posição pelo aparelho do motorista ─────────────

  /**
   * Recebe os pontos (podem vir em lote, de um período sem sinal) e o estado do GPS. Os pontos só são GUARDADOS enquanto há rota em andamento:
   * fora disso só a última posição/estado é atualizada para a tela do motorista saber que está tudo certo.
   */
  async ingest(ctx: AuthContext, dto: PositionDto) {
    const now = Date.now();
    const points = (dto.points ?? []).map((p) => ({ ...p, t: new Date(p.recordedAt) })).filter((p) => {
      if (!validLat(p.lat) || !validLng(p.lng) || Number.isNaN(p.t.getTime())) return false;
      return p.t.getTime() <= now + 5 * MIN && p.t.getTime() >= now - 24 * 60 * MIN; // relógio errado ou ponto muito antigo
    }).sort((a, b) => a.t.getTime() - b.t.getTime());
    if ((dto.points ?? []).length && !points.length) throw new BadRequestException('Nenhum ponto válido (coordenadas ou horário fora do aceitável).');

    return this.prisma.withContext(ctx, async (tx) => {
      const driver = await this.myDriver(tx, ctx);
      const route = await tx.deliveryRoute.findFirst({ where: { tenantId: ctx.tenantId!, driverId: driver.id, status: 'IN_PROGRESS' }, orderBy: { startedAt: 'desc' }, select: { id: true, number: true } });
      if (route && points.length) {
        await tx.driverTrackPoint.createMany({
          data: points.map((p) => ({ tenantId: ctx.tenantId!, driverId: driver.id, routeId: route.id, lat: p.lat, lng: p.lng, accuracyM: p.accuracyM !== undefined ? Math.round(p.accuracyM) : null, speedMps: p.speedMps ?? null, heading: p.heading ?? null, recordedAt: p.t })),
          skipDuplicates: true,
        });
      }
      const last = points[points.length - 1];
      const cur = await tx.driverPosition.findUnique({ where: { tenantId_driverId: { tenantId: ctx.tenantId!, driverId: driver.id } } });
      const newer = route && last && (!cur?.recordedAt || last.t.getTime() >= cur.recordedAt.getTime());
      // fora de uma rota em andamento a localização NÃO é guardada: só o estado do GPS
      const data = {
        routeId: route?.id ?? null, gpsEnabled: dto.gps.enabled, permission: dto.gps.permission ?? null, source: dto.gps.source ?? 'APP', receivedAt: new Date(),
        ...(newer ? { lat: last.lat, lng: last.lng, accuracyM: last.accuracyM !== undefined ? Math.round(last.accuracyM) : null, speedMps: last.speedMps ?? null, heading: last.heading ?? null, recordedAt: last.t } : {}),
      };
      await tx.driverPosition.upsert({ where: { tenantId_driverId: { tenantId: ctx.tenantId!, driverId: driver.id } }, create: { tenantId: ctx.tenantId!, driverId: driver.id, ...data }, update: data });
      void this.purge(ctx);
      return { accepted: route ? points.length : 0, routeActive: !!route, routeId: route?.id ?? null, routeNumber: route?.number ?? null, serverTime: new Date().toISOString() };
    });
  }

  /** Apaga pontos antigos (retenção, padrão 30 dias; TRACK_RETENTION_DAYS). No máximo uma vez por hora por processo. */
  private async purge(ctx: AuthContext) {
    if (Date.now() - this.purgedAt < 60 * MIN) return;
    this.purgedAt = Date.now();
    const days = Math.max(1, Number(process.env.TRACK_RETENTION_DAYS ?? 30));
    try { await this.prisma.withContext(ctx, (tx) => tx.driverTrackPoint.deleteMany({ where: { tenantId: ctx.tenantId!, recordedAt: { lt: new Date(Date.now() - days * 86_400_000) } } })); } catch (e) { this.log.warn(`limpeza da trilha falhou: ${(e as Error).message}`); }
  }

  /** O que a tela do motorista precisa saber: se há rota em andamento (e portanto rastreio ativo). */
  myState(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const driver = await this.myDriver(tx, ctx);
      const route = await tx.deliveryRoute.findFirst({ where: { tenantId: ctx.tenantId!, driverId: driver.id, status: 'IN_PROGRESS' }, orderBy: { startedAt: 'desc' }, select: { id: true, number: true } });
      return { driverId: driver.id, routeActive: !!route, routeId: route?.id ?? null, routeNumber: route?.number ?? null, retentionDays: Number(process.env.TRACK_RETENTION_DAYS ?? 30) };
    });
  }

  // ───────────── mapa ao vivo (gestão) ─────────────

  private geometryOf(r: { planGeometry: Prisma.JsonValue | null }): LatLng[] { return Array.isArray(r.planGeometry) ? (r.planGeometry as unknown as LatLng[]) : []; }

  /** Rotas em andamento com a última posição de cada motorista, alertas e a próxima parada. */
  live(ctx: AuthContext, now = new Date()) {
    return this.prisma.withContext(ctx, async (tx) => {
      const routes = await tx.deliveryRoute.findMany({
        where: { tenantId: ctx.tenantId!, status: 'IN_PROGRESS' }, orderBy: { startedAt: 'asc' },
        include: { driver: { select: { id: true, name: true, phone: true } }, vehicle: { select: { plate: true, description: true } }, stops: { where: { status: { not: 'CANCELLED' } }, orderBy: { sequence: 'asc' } } },
      });
      const driverIds = routes.map((r) => r.driverId);
      const positions = driverIds.length ? await tx.driverPosition.findMany({ where: { tenantId: ctx.tenantId!, driverId: { in: driverIds } } }) : [];
      const recent = driverIds.length
        ? await tx.driverTrackPoint.findMany({ where: { tenantId: ctx.tenantId!, routeId: { in: routes.map((r) => r.id) }, recordedAt: { gte: new Date(now.getTime() - 30 * MIN) } }, orderBy: { recordedAt: 'desc' }, take: 60 * Math.max(1, routes.length) })
        : [];
      return routes.map((r) => {
        const pos = positions.find((p) => p.driverId === r.driverId) ?? null;
        const pts = recent.filter((p) => p.routeId === r.id);
        const geometry = this.geometryOf(r);
        const flags: Flag[] = [];
        const age = pos ? now.getTime() - pos.receivedAt.getTime() : null;
        if (pos && (!pos.gpsEnabled || pos.permission === 'denied')) flags.push('GPS_OFF');
        if (!pos || (age !== null && age > NO_SIGNAL_MS)) flags.push('NO_SIGNAL');
        const here: LatLng | null = pos?.lat != null && pos.lng != null ? [Number(pos.lat), Number(pos.lng)] : null;
        const pendingStops = r.stops.filter((s) => s.status === 'PENDING');
        const stopCoords = pendingStops.filter((s) => s.destLat != null && s.destLng != null).map((s) => ({ s, at: [Number(s.destLat), Number(s.destLng)] as LatLng }));
        // fora da rota: os 3 últimos pontos distantes do trajeto planejado
        let offRouteM: number | null = null;
        if (geometry.length > 1 && pts.length >= 3 && !flags.includes('NO_SIGNAL')) {
          const ds = pts.slice(0, 3).map((p) => distanceToPolyline([Number(p.lat), Number(p.lng)], geometry) ?? 0);
          if (ds.every((d) => d > OFF_ROUTE_M)) { offRouteM = Math.round(Math.min(...ds)); flags.push('OFF_ROUTE'); }
        }
        // parado há muito tempo longe de qualquer parada pendente
        if (here && pts.length >= 2 && !flags.includes('NO_SIGNAL')) {
          const span = pts[0].recordedAt.getTime() - pts[pts.length - 1].recordedAt.getTime();
          const still = pts.every((p) => (p.speedMps ?? 0) < 0.8 && haversine([Number(p.lat), Number(p.lng)], here) < 60);
          if (still && span >= STOPPED_MS && !stopCoords.some((c) => haversine(here, c.at) <= NEAR_STOP_M)) flags.push('STOPPED');
        }
        const next = pendingStops[0] ?? null;
        const nextAt = next && next.destLat != null && next.destLng != null ? ([Number(next.destLat), Number(next.destLng)] as LatLng) : null;
        const distNext = here && nextAt ? Math.round(haversine(here, nextAt)) : null;
        return {
          routeId: r.id, number: r.number, startedAt: r.startedAt,
          driver: { id: r.driver.id, name: r.driver.name, phone: r.driver.phone }, vehicle: r.vehicle,
          position: pos ? { lat: here?.[0] ?? null, lng: here?.[1] ?? null, accuracyM: pos.accuracyM, speedKmh: pos.speedMps != null ? Math.round(pos.speedMps * 3.6) : null, heading: pos.heading, recordedAt: pos.recordedAt, receivedAt: pos.receivedAt, ageSeconds: Math.round((age ?? 0) / 1000), source: pos.source } : null,
          gps: pos ? { enabled: pos.gpsEnabled, permission: pos.permission } : null, flags, offRouteM,
          progress: { total: r.stops.length, delivered: r.stops.filter((s) => s.status === 'DELIVERED').length, failed: r.stops.filter((s) => s.status === 'FAILED').length, pending: pendingStops.length },
          next: next ? { stopId: next.id, sequence: next.sequence, customer: next.customerName, address: next.addressText, distanceM: distNext, etaMinutes: distNext !== null ? Math.max(1, Math.round(((distNext * 1.3) / 1000 / AVG_SPEED_KMH) * 60)) : null } : null,
          plan: { calculated: geometry.length > 1, distanceM: r.planDistanceM, durationS: r.planDurationS, plannedAt: r.plannedAt },
          stops: r.stops.map((s) => ({ id: s.id, sequence: s.sequence, status: s.status, customer: s.customerName, address: s.addressText, lat: s.destLat != null ? Number(s.destLat) : null, lng: s.destLng != null ? Number(s.destLng) : null })),
        };
      });
    });
  }

  /** Trilha percorrida + trajeto planejado + paradas de uma rota (gestão). */
  async trail(ctx: AuthContext, routeId: string, own = false) {
    return this.prisma.withContext(ctx, async (tx) => {
      const where: Prisma.DeliveryRouteWhereInput = { id: routeId, tenantId: ctx.tenantId! };
      if (own) where.driverId = (await this.myDriver(tx, ctx)).id;
      const r = await tx.deliveryRoute.findFirst({
        where, include: { driver: { select: { id: true, name: true } }, stops: { where: { status: { not: 'CANCELLED' } }, orderBy: { sequence: 'asc' } } },
      });
      if (!r) throw new NotFoundException('Rota não encontrada.');
      const pts = await tx.driverTrackPoint.findMany({ where: { tenantId: ctx.tenantId!, routeId }, orderBy: { recordedAt: 'asc' }, take: 20_000, select: { lat: true, lng: true, recordedAt: true, speedMps: true } });
      let travelled = 0;
      for (let i = 1; i < pts.length; i++) travelled += haversine([Number(pts[i - 1].lat), Number(pts[i - 1].lng)], [Number(pts[i].lat), Number(pts[i].lng)]);
      const trail = downsample(pts, 1500).map((p) => ({ lat: Number(p.lat), lng: Number(p.lng), at: p.recordedAt }));
      return {
        routeId: r.id, number: r.number, status: r.status, driver: r.driver, startedAt: r.startedAt, finishedAt: r.finishedAt,
        trail, points: pts.length, travelledM: Math.round(travelled),
        plan: { geometry: this.geometryOf(r), distanceM: r.planDistanceM, durationS: r.planDurationS, plannedAt: r.plannedAt },
        stops: r.stops.map((s) => ({ id: s.id, sequence: s.sequence, status: s.status, customer: s.customerName, address: s.addressText, lat: s.destLat != null ? Number(s.destLat) : null, lng: s.destLng != null ? Number(s.destLng) : null, geocodeStatus: s.geocodeStatus, deliveredAt: s.deliveredAt, confirmedAt: s.lat != null ? { lat: Number(s.lat), lng: Number(s.lng) } : null })),
      };
    });
  }

  // ───────────── planejamento: coordenadas das paradas e trajeto ─────────────

  /** Geocodifica o depósito e as paradas que ainda não têm coordenadas (uma vez só) e calcula o trajeto pelas ruas, se houver chave do OpenRouteService. */
  async plan(ctx: AuthContext, routeId: string) {
    const r = await this.prisma.withContext(ctx, async (tx) => {
      const route = await tx.deliveryRoute.findFirst({ where: { id: routeId, tenantId: ctx.tenantId! }, include: { stops: { where: { status: { not: 'CANCELLED' } }, orderBy: { sequence: 'asc' } } } });
      if (!route) throw new NotFoundException('Rota não encontrada.');
      const first = route.stops[0];
      const est = first ? (await tx.salesOrder.findFirst({ where: { id: first.salesOrderId, tenantId: ctx.tenantId! }, select: { warehouse: { select: { establishment: { select: { id: true, street: true, number: true, district: true, city: true, state: true, zipCode: true, geoLat: true, geoLng: true } } } } } }))?.warehouse.establishment ?? null : null;
      return { route, est };
    });
    let geocoded = 0; let notFound = 0; let errors = 0;

    // depósito (ponto de partida)
    let depot: LatLng | null = r.est?.geoLat != null && r.est.geoLng != null ? [Number(r.est.geoLat), Number(r.est.geoLng)] : null;
    if (!depot && r.est && (r.est.street || r.est.city)) {
      const e = r.est;
      const g = await this.geocoder.geocode([[e.street && `${e.street}${e.number ? `, ${e.number}` : ''}`, e.district, e.city, e.state, 'Brasil'].filter(Boolean).join(', '), [e.zipCode, e.city, e.state, 'Brasil'].filter(Boolean).join(', ')]);
      if (g.status === 'OK') { depot = [g.lat, g.lng]; await this.prisma.withContext(ctx, (tx) => tx.establishment.update({ where: { id: e.id }, data: { geoLat: g.lat, geoLng: g.lng, geocodedAt: new Date() } })); }
    }

    // paradas
    for (const s of r.route.stops) {
      if (s.destLat != null && s.geocodeStatus === 'OK') continue;
      if (s.status !== 'PENDING' && s.status !== 'DELIVERED' && s.status !== 'FAILED') continue;
      const g = await this.geocoder.geocode([s.addressText.includes(s.city ?? '#') ? `${s.addressText}, Brasil` : [s.addressText, s.city, s.state, 'Brasil'].filter(Boolean).join(', '), [s.zipCode, s.city, s.state, 'Brasil'].filter(Boolean).join(', ')]);
      if (g.status === 'OK') geocoded++; else if (g.status === 'NOT_FOUND') notFound++; else errors++;
      await this.prisma.withContext(ctx, (tx) => tx.deliveryStop.update({ where: { id: s.id }, data: g.status === 'OK' ? { destLat: g.lat, destLng: g.lng, geocodedAt: new Date(), geocodeStatus: 'OK' } : { geocodeStatus: g.status, geocodedAt: new Date() } }));
    }

    // trajeto: depósito → paradas pendentes na ordem
    const stops = await this.prisma.withContext(ctx, (tx) => tx.deliveryStop.findMany({ where: { tenantId: ctx.tenantId!, routeId, status: 'PENDING' }, orderBy: { sequence: 'asc' }, select: { destLat: true, destLng: true } }));
    const pts: LatLng[] = [...(depot ? [depot] : []), ...stops.filter((s) => s.destLat != null && s.destLng != null).map((s) => [Number(s.destLat), Number(s.destLng)] as LatLng)];
    const planned = await this.planner.plan(pts);
    await this.prisma.withContext(ctx, async (tx) => {
      if (planned) await tx.deliveryRoute.update({ where: { id: routeId }, data: { planGeometry: planned.geometry as unknown as Prisma.InputJsonValue, planDistanceM: planned.distanceM, planDurationS: planned.durationS, plannedAt: new Date() } });
      await this.audit.record(tx, ctx, { action: 'delivery.route_planned', entity: 'delivery_route', entityId: routeId, metadata: { geocoded, notFound, errors, geometry: !!planned } });
    });
    return { geocoded, notFound, errors, depot: !!depot, routeCalculated: !!planned, routingConfigured: this.planner.configured(), distanceM: planned?.distanceM ?? null, durationS: planned?.durationS ?? null };
  }

  /** Versão que não lança erro: usada ao iniciar a rota (o início nunca deve falhar por causa do mapa). */
  async planSafe(ctx: AuthContext, routeId: string) {
    try { return await this.plan(ctx, routeId); } catch (e) { this.log.warn(`planejamento da rota ${routeId} falhou: ${(e as Error).message}`); return null; }
  }
}

@Controller('delivery')
export class DriverTrackingController {
  constructor(private readonly svc: TrackingService) {}

  @Post('my/position') @HttpCode(200) @Throttle({ default: { limit: 120, ttl: 60_000 } }) @RequirePermissions('delivery.perform')
  position(@CurrentAuth() ctx: AuthContext, @Body() dto: PositionDto) { return this.svc.ingest(ctx, dto); }

  @Get('my/tracking') @RequirePermissions('delivery.perform')
  mine(@CurrentAuth() ctx: AuthContext) { return this.svc.myState(ctx); }

  @Get('my/routes/:id/map') @RequirePermissions('delivery.perform')
  myMap(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.trail(ctx, id, true); }

  @Get('tracking') @RequirePermissions('routes.view')
  live(@CurrentAuth() ctx: AuthContext) { return this.svc.live(ctx); }

  @Get('routes/:id/track') @RequirePermissions('routes.view')
  trail(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.trail(ctx, id); }

  @Post('routes/:id/plan') @HttpCode(200) @RequirePermissions('routes.manage')
  plan(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.plan(ctx, id); }
}
