import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/auth';
import { onlyDigits } from '../common/cnpj';
import { readImageInfo } from '../catalog/image';
import { PrismaService } from '../prisma/prisma.service';
import { SalesService } from '../sales/sales.service';
import { SettingsService } from '../settings/settings.service';
import { UsersService } from '../users/users.service';

type Tx = Prisma.TransactionClient;

export const PROOF_MIN_BYTES = 2_000;
export const PROOF_MAX_BYTES = 4_000_000;
export const PROOF_MIN_SIDE_PX = 480;
const DELIVERABLE = ['PACKED', 'SHIPPED'];

export interface AddressParts { street: string | null; number: string | null; district: string | null; city: string | null; state: string | null; zipCode: string | null }

/** Endereço em uma linha, só com o que existe. */
export function addressText(a: AddressParts): string {
  const line = [[a.street, a.number].filter(Boolean).join(', '), a.district, [a.city, a.state].filter(Boolean).join('/'), a.zipCode ? `CEP ${onlyDigits(a.zipCode).replace(/^(\d{5})(\d{3})$/, '$1-$2')}` : null].filter(Boolean).join(' - ');
  return line || 'Endereço não informado';
}

/**
 * Ordem sugerida por região: UF → cidade → CEP → rua → número. NÃO é o menor caminho: o CEP agrupa por proximidade, mas calcular a rota
 * mais curta exige coordenadas e um serviço de rotas (não implementado). O despachante ajusta a ordem à mão.
 */
export function regionOrder<T extends AddressParts & { id: string }>(items: T[]): T[] {
  const norm = (s: string | null) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const num = (s: string | null) => Number.parseInt(onlyDigits(s ?? ''), 10) || 0;
  return [...items].sort((a, b) =>
    norm(a.state).localeCompare(norm(b.state)) || norm(a.city).localeCompare(norm(b.city)) || onlyDigits(a.zipCode ?? '').localeCompare(onlyDigits(b.zipCode ?? '')) ||
    norm(a.street).localeCompare(norm(b.street)) || num(a.number) - num(b.number) || a.id.localeCompare(b.id),
  );
}

export interface PhotoInput { contentBase64: string }

/** Decodifica e valida a foto pelos BYTES (tipo e dimensões reais), nunca pelo que o cliente declara. */
export function parseProofPhoto(b64: string): { content: Buffer; contentType: string; width: number; height: number; sha256: string } {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new BadRequestException('Foto inválida (base64 malformado).');
  const content = Buffer.from(b64, 'base64');
  if (content.length < PROOF_MIN_BYTES) throw new BadRequestException('Foto muito pequena: tire uma foto do canhoto assinado.');
  if (content.length > PROOF_MAX_BYTES) throw new BadRequestException('Foto muito grande (máximo 4 MB): tente novamente.');
  const info = readImageInfo(content);
  if (!info) throw new BadRequestException('O arquivo enviado não é uma imagem válida (use JPG, PNG ou WebP).');
  if (Math.min(info.width, info.height) < PROOF_MIN_SIDE_PX) throw new BadRequestException(`Foto com resolução baixa (${info.width}×${info.height}): o canhoto precisa estar legível (mínimo ${PROOF_MIN_SIDE_PX}px no menor lado).`);
  return { content, contentType: info.type, width: info.width, height: info.height, sha256: createHash('sha256').update(content).digest('hex') };
}

export interface GeoInput { lat?: number; lng?: number; accuracyM?: number }

const stopInclude = { proofs: { select: { id: true, kind: true, createdAt: true, width: true, height: true, bytes: true } } } as const;

@Injectable()
export class DeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly sales: SalesService,
    private readonly settings: SettingsService,
    private readonly users: UsersService,
  ) {}

  // ───────────── motoristas ─────────────

  listDrivers(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const rows = await tx.driver.findMany({ where: { tenantId: ctx.tenantId! }, orderBy: { name: 'asc' } });
      const open = await tx.deliveryRoute.groupBy({ by: ['driverId'], where: { tenantId: ctx.tenantId!, status: { in: ['PLANNED', 'IN_PROGRESS'] } }, _count: { _all: true } });
      const byDriver = new Map(open.map((o) => [o.driverId, o._count._all]));
      return rows.map((d) => ({ ...d, openRoutes: byDriver.get(d.id) ?? 0 }));
    });
  }

  /** Cria o acesso (membro com o papel "Motorista") e o cadastro do motorista de uma vez. */
  async createDriver(ctx: AuthContext, dto: { name: string; email: string; password: string; phone?: string; vehicle?: string; plate?: string }) {
    const role = await this.prisma.withContext(ctx, (tx) => tx.role.findFirst({ where: { tenantId: ctx.tenantId!, key: 'driver' }, select: { id: true } }));
    if (!role) throw new ConflictException('O papel "Motorista" ainda não existe nesta empresa. Peça ao administrador para sincronizar os papéis do sistema.');
    const member = await this.users.createMember(ctx, { name: dto.name, email: dto.email, password: dto.password, roleId: role.id });
    return this.prisma.withContext(ctx, async (tx) => {
      const d = await tx.driver.create({
        data: { tenantId: ctx.tenantId!, userId: member.userId, name: dto.name.trim(), phone: dto.phone?.trim() || null, vehicle: dto.vehicle?.trim() || null, plate: dto.plate?.trim().toUpperCase() || null },
      });
      await this.audit.record(tx, ctx, { action: 'delivery.driver_created', entity: 'driver', entityId: d.id, metadata: { name: d.name, plate: d.plate } });
      return d;
    });
  }

  updateDriver(ctx: AuthContext, id: string, dto: { name?: string; phone?: string; vehicle?: string; plate?: string; active?: boolean }) {
    return this.prisma.withContext(ctx, async (tx) => {
      const d = await tx.driver.findFirst({ where: { id, tenantId: ctx.tenantId! } });
      if (!d) throw new NotFoundException('Motorista não encontrado.');
      if (dto.active === false) {
        const open = await tx.deliveryRoute.count({ where: { tenantId: ctx.tenantId!, driverId: id, status: { in: ['PLANNED', 'IN_PROGRESS'] } } });
        if (open) throw new ConflictException('O motorista tem rota em aberto: conclua ou cancele antes de inativar.');
      }
      const row = await tx.driver.update({
        where: { id },
        data: { name: dto.name?.trim(), phone: dto.phone?.trim() || (dto.phone === '' ? null : undefined), vehicle: dto.vehicle?.trim() || (dto.vehicle === '' ? null : undefined), plate: dto.plate?.trim().toUpperCase() || (dto.plate === '' ? null : undefined), active: dto.active },
      });
      await this.audit.record(tx, ctx, { action: 'delivery.driver_updated', entity: 'driver', entityId: id, metadata: { fields: Object.keys(dto) } });
      return row;
    });
  }

  // ───────────── pedidos prontos para rota ─────────────

  eligibleOrders(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const orders = await tx.salesOrder.findMany({
        where: { tenantId: ctx.tenantId!, status: { in: DELIVERABLE as ('PACKED' | 'SHIPPED')[] }, deliveryStops: { none: { status: 'PENDING' } } },
        orderBy: { number: 'asc' }, take: 300,
        select: { id: true, number: true, status: true, total: true, dispatchDate: true, customer: { select: { name: true, phone: true, street: true, number: true, district: true, city: true, state: true, zipCode: true } } },
      });
      return orders.map((o) => ({
        id: o.id, number: o.number, status: o.status, total: o.total.toString(), dispatchDate: o.dispatchDate?.toISOString().slice(0, 10) ?? null,
        customerName: o.customer.name, customerPhone: o.customer.phone, address: addressText(o.customer), zipCode: o.customer.zipCode, city: o.customer.city, state: o.customer.state,
        addressComplete: !!(o.customer.street && o.customer.city && o.customer.state),
      }));
    });
  }

  // ───────────── rotas ─────────────

  private view(r: Prisma.DeliveryRouteGetPayload<{ include: { driver: true; stops: { include: typeof stopInclude } } }>) {
    const stops = [...r.stops].sort((a, b) => a.sequence - b.sequence);
    const count = (s: string) => stops.filter((x) => x.status === s).length;
    return {
      id: r.id, number: r.number, routeDate: r.routeDate.toISOString().slice(0, 10), status: r.status, notes: r.notes, startedAt: r.startedAt, finishedAt: r.finishedAt, cancelReason: r.cancelReason,
      driver: { id: r.driver.id, name: r.driver.name, phone: r.driver.phone, vehicle: r.driver.vehicle, plate: r.driver.plate },
      totals: { stops: stops.length, pending: count('PENDING'), delivered: count('DELIVERED'), failed: count('FAILED'), cancelled: count('CANCELLED') },
      stops: stops.map((s) => ({
        id: s.id, sequence: s.sequence, status: s.status, salesOrderId: s.salesOrderId, customerName: s.customerName, customerPhone: s.customerPhone, address: s.addressText, zipCode: s.zipCode, city: s.city, state: s.state,
        deliveredAt: s.deliveredAt, receiverName: s.receiverName, receiverDocument: s.receiverDocument, notes: s.notes, failureReason: s.failureReason,
        lat: s.lat ? Number(s.lat) : null, lng: s.lng ? Number(s.lng) : null, hasProof: s.proofs.some((p) => p.kind === 'DELIVERY'), hasFailurePhoto: s.proofs.some((p) => p.kind === 'FAILURE'),
      })),
    };
  }

  private routeArgs = { include: { driver: true, stops: { include: stopInclude } } } as const;

  listRoutes(ctx: AuthContext, q: { status?: string; date?: string }) {
    return this.prisma.withContext(ctx, async (tx) => {
      const rows = await tx.deliveryRoute.findMany({
        where: { tenantId: ctx.tenantId!, ...(q.status ? { status: q.status } : {}), ...(q.date ? { routeDate: new Date(`${q.date}T00:00:00Z`) } : {}) },
        orderBy: [{ routeDate: 'desc' }, { number: 'desc' }], take: 100, ...this.routeArgs,
      });
      return rows.map((r) => { const { stops, ...rest } = this.view(r); void stops; return rest; });
    });
  }

  getRoute(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => this.view(await this.loadRoute(tx, ctx, id)));
  }

  private async loadRoute(tx: Tx, ctx: AuthContext, id: string) {
    const r = await tx.deliveryRoute.findFirst({ where: { id, tenantId: ctx.tenantId! }, ...this.routeArgs });
    if (!r) throw new NotFoundException('Rota não encontrada.');
    return r;
  }

  async createRoute(ctx: AuthContext, dto: { routeDate: string; driverId: string; orderIds: string[]; notes?: string; autoSort?: boolean }) {
    if (new Set(dto.orderIds).size !== dto.orderIds.length) throw new BadRequestException('Pedido repetido na rota.');
    return this.prisma.withContext(ctx, async (tx) => {
      const driver = await tx.driver.findFirst({ where: { id: dto.driverId, tenantId: ctx.tenantId!, active: true } });
      if (!driver) throw new BadRequestException('Motorista inválido ou inativo.');
      const orders = await tx.salesOrder.findMany({ where: { id: { in: dto.orderIds }, tenantId: ctx.tenantId! }, include: { customer: true } });
      if (orders.length !== dto.orderIds.length) throw new BadRequestException('Algum pedido não foi encontrado.');
      const bad = orders.filter((o) => !DELIVERABLE.includes(o.status));
      if (bad.length) throw new ConflictException(`Pedido(s) ${bad.map((o) => o.number).join(', ')} não estão prontos para entrega (precisam estar embalados ou expedidos).`);
      const rows = orders.map((o) => ({ ...o.customer, o, id: o.id })); // `id` por último: o do pedido, não o do cliente
      const ordered = dto.autoSort === false ? dto.orderIds.map((id) => rows.find((r) => r.id === id)!) : regionOrder(rows);
      const number = await this.settings.nextNumber(tx, ctx, 'delivery_route');
      const route = await tx.deliveryRoute.create({
        data: { tenantId: ctx.tenantId!, number, routeDate: new Date(`${dto.routeDate}T00:00:00Z`), driverId: driver.id, notes: dto.notes?.trim() || null, createdById: ctx.userId },
      });
      try {
        await tx.deliveryStop.createMany({
          data: ordered.map((r, i) => ({
            tenantId: ctx.tenantId!, routeId: route.id, salesOrderId: r.o.id, sequence: i + 1, customerName: r.o.customer.name, customerPhone: r.o.customer.phone,
            addressText: addressText(r.o.customer), zipCode: r.o.customer.zipCode, city: r.o.customer.city, state: r.o.customer.state,
          })),
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('Algum pedido já está em outra rota pendente.');
        throw e;
      }
      await this.audit.record(tx, ctx, { action: 'delivery.route_created', entity: 'delivery_route', entityId: route.id, metadata: { number, driver: driver.name, stops: ordered.length } });
      return this.view(await this.loadRoute(tx, ctx, route.id));
    });
  }

  private async editableRoute(tx: Tx, ctx: AuthContext, id: string, statuses: string[] = ['PLANNED', 'IN_PROGRESS']) {
    await tx.$queryRaw`SELECT id FROM delivery_routes WHERE id = ${id}::uuid AND tenant_id = ${ctx.tenantId}::uuid FOR UPDATE`;
    const r = await this.loadRoute(tx, ctx, id);
    if (!statuses.includes(r.status)) throw new ConflictException(`Rota ${r.status === 'COMPLETED' ? 'concluída' : r.status === 'CANCELLED' ? 'cancelada' : 'em andamento'}: operação não permitida.`);
    return r;
  }

  /** Nova ordem das paradas ainda pendentes (as já resolvidas ficam onde estão). */
  reorder(ctx: AuthContext, id: string, stopIds: string[]) {
    return this.prisma.withContext(ctx, async (tx) => {
      const r = await this.editableRoute(tx, ctx, id);
      const pending = r.stops.filter((s) => s.status === 'PENDING');
      if (stopIds.length !== pending.length || new Set(stopIds).size !== stopIds.length || !stopIds.every((s) => pending.some((p) => p.id === s))) {
        throw new BadRequestException('Informe todas as paradas pendentes, sem repetir.');
      }
      const resolved = r.stops.filter((s) => s.status !== 'PENDING').length;
      for (const [i, sid] of stopIds.entries()) await tx.deliveryStop.update({ where: { id: sid }, data: { sequence: resolved + i + 1 } });
      await this.audit.record(tx, ctx, { action: 'delivery.route_reordered', entity: 'delivery_route', entityId: id });
      return this.view(await this.loadRoute(tx, ctx, id));
    });
  }

  /** Reaplica a ordem sugerida por região às paradas pendentes. */
  autoSort(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const r = await this.editableRoute(tx, ctx, id);
      const pending = r.stops.filter((s) => s.status === 'PENDING');
      const order = regionOrder(pending.map((s) => ({ id: s.id, street: s.addressText.split(',')[0] ?? null, number: null, district: null, city: s.city, state: s.state, zipCode: s.zipCode })));
      const resolved = r.stops.length - pending.length;
      for (const [i, o] of order.entries()) await tx.deliveryStop.update({ where: { id: o.id }, data: { sequence: resolved + i + 1 } });
      return this.view(await this.loadRoute(tx, ctx, id));
    });
  }

  addStop(ctx: AuthContext, id: string, orderId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const r = await this.editableRoute(tx, ctx, id);
      const o = await tx.salesOrder.findFirst({ where: { id: orderId, tenantId: ctx.tenantId! }, include: { customer: true } });
      if (!o) throw new NotFoundException('Pedido não encontrado.');
      if (!DELIVERABLE.includes(o.status)) throw new ConflictException(`O pedido ${o.number} não está pronto para entrega.`);
      const prev = r.stops.find((s) => s.salesOrderId === orderId);
      if (prev?.status === 'PENDING') throw new ConflictException('Este pedido já está nesta rota.');
      try {
        if (prev) await tx.deliveryStop.update({ where: { id: prev.id }, data: { status: 'PENDING', sequence: r.stops.length + 1, failureReason: null } });
        else await tx.deliveryStop.create({ data: { tenantId: ctx.tenantId!, routeId: id, salesOrderId: orderId, sequence: r.stops.length + 1, customerName: o.customer.name, customerPhone: o.customer.phone, addressText: addressText(o.customer), zipCode: o.customer.zipCode, city: o.customer.city, state: o.customer.state } });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('Este pedido já está em outra rota pendente.');
        throw e;
      }
      if (r.status === 'IN_PROGRESS' && o.status === 'PACKED') await this.sales.advanceInTx(tx, ctx, orderId, 'SHIPPED', { unscoped: true });
      await this.audit.record(tx, ctx, { action: 'delivery.stop_added', entity: 'delivery_route', entityId: id, metadata: { orderId } });
      return this.view(await this.loadRoute(tx, ctx, id));
    });
  }

  removeStop(ctx: AuthContext, id: string, stopId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const r = await this.editableRoute(tx, ctx, id);
      const s = r.stops.find((x) => x.id === stopId);
      if (!s) throw new NotFoundException('Parada não encontrada nesta rota.');
      if (s.status !== 'PENDING') throw new ConflictException('Só é possível remover paradas pendentes.');
      await tx.deliveryStop.update({ where: { id: stopId }, data: { status: 'CANCELLED' } });
      const kept = r.stops.filter((x) => x.id !== stopId && x.status !== 'CANCELLED').sort((a, b) => a.sequence - b.sequence);
      for (const [i, x] of kept.entries()) if (x.sequence !== i + 1) await tx.deliveryStop.update({ where: { id: x.id }, data: { sequence: i + 1 } });
      await this.audit.record(tx, ctx, { action: 'delivery.stop_removed', entity: 'delivery_route', entityId: id, metadata: { orderId: s.salesOrderId } });
      await this.completeIfDone(tx, ctx, id);
      return this.view(await this.loadRoute(tx, ctx, id));
    });
  }

  /** Saída do veículo: pedidos embalados passam a expedidos (baixa o estoque) e o motorista passa a poder confirmar as entregas. */
  start(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const r = await this.editableRoute(tx, ctx, id, ['PLANNED']);
      const pending = r.stops.filter((s) => s.status === 'PENDING');
      if (!pending.length) throw new ConflictException('A rota não tem paradas pendentes.');
      for (const s of pending) {
        const o = await tx.salesOrder.findFirst({ where: { id: s.salesOrderId, tenantId: ctx.tenantId! }, select: { number: true, status: true } });
        if (!o || !DELIVERABLE.includes(o.status)) throw new ConflictException(`O pedido ${o?.number ?? ''} está "${o?.status ?? 'inexistente'}": remova-o da rota antes de iniciar.`);
        if (o.status === 'PACKED') await this.sales.advanceInTx(tx, ctx, s.salesOrderId, 'SHIPPED', { unscoped: true });
      }
      await tx.deliveryRoute.update({ where: { id }, data: { status: 'IN_PROGRESS', startedAt: new Date() } });
      await this.audit.record(tx, ctx, { action: 'delivery.route_started', entity: 'delivery_route', entityId: id, metadata: { number: r.number, stops: pending.length } });
      return this.view(await this.loadRoute(tx, ctx, id));
    });
  }

  cancel(ctx: AuthContext, id: string, reason: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const r = await this.editableRoute(tx, ctx, id);
      if (r.stops.some((s) => s.status === 'DELIVERED')) throw new ConflictException('A rota já tem entregas confirmadas: não pode ser cancelada.');
      await tx.deliveryStop.updateMany({ where: { tenantId: ctx.tenantId!, routeId: id, status: 'PENDING' }, data: { status: 'CANCELLED' } });
      await tx.deliveryRoute.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason.trim() } });
      await this.audit.record(tx, ctx, { action: 'delivery.route_cancelled', entity: 'delivery_route', entityId: id, metadata: { reason: reason.trim() } });
      return this.view(await this.loadRoute(tx, ctx, id));
    });
  }

  private async completeIfDone(tx: Tx, ctx: AuthContext, routeId: string) {
    const left = await tx.deliveryStop.count({ where: { tenantId: ctx.tenantId!, routeId, status: 'PENDING' } });
    if (left > 0) return;
    const r = await tx.deliveryRoute.findFirstOrThrow({ where: { id: routeId, tenantId: ctx.tenantId! }, select: { status: true } });
    if (r.status === 'IN_PROGRESS') {
      await tx.deliveryRoute.update({ where: { id: routeId }, data: { status: 'COMPLETED', finishedAt: new Date() } });
      await this.audit.record(tx, ctx, { action: 'delivery.route_completed', entity: 'delivery_route', entityId: routeId });
    } else if (r.status === 'PLANNED') {
      await tx.deliveryRoute.update({ where: { id: routeId }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'Todas as paradas foram removidas.' } });
    }
  }

  // ───────────── motorista ─────────────

  private async myDriver(tx: Tx, ctx: AuthContext) {
    const d = await tx.driver.findFirst({ where: { tenantId: ctx.tenantId!, userId: ctx.userId, active: true } });
    if (!d) throw new ForbiddenException('Seu usuário não está cadastrado como motorista ativo. Fale com o despachante.');
    return d;
  }

  myRoutes(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const d = await this.myDriver(tx, ctx);
      const recent = new Date(Date.now() - 2 * 86_400_000);
      const rows = await tx.deliveryRoute.findMany({
        where: { tenantId: ctx.tenantId!, driverId: d.id, OR: [{ status: { in: ['PLANNED', 'IN_PROGRESS'] } }, { status: 'COMPLETED', finishedAt: { gte: recent } }] },
        orderBy: [{ routeDate: 'asc' }, { number: 'asc' }], ...this.routeArgs,
      });
      return rows.map((r) => this.view(r));
    });
  }

  myRoute(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const d = await this.myDriver(tx, ctx);
      const r = await this.loadRoute(tx, ctx, id);
      if (r.driverId !== d.id) throw new NotFoundException('Rota não encontrada.');
      return this.view(r);
    });
  }

  private async ownStop(tx: Tx, ctx: AuthContext, stopId: string) {
    const d = await this.myDriver(tx, ctx);
    await tx.$queryRaw`SELECT id FROM delivery_stops WHERE id = ${stopId}::uuid AND tenant_id = ${ctx.tenantId}::uuid FOR UPDATE`;
    const s = await tx.deliveryStop.findFirst({ where: { id: stopId, tenantId: ctx.tenantId! }, include: { route: true } });
    if (!s || s.route.driverId !== d.id) throw new NotFoundException('Entrega não encontrada.');
    return s;
  }

  private geo(g: GeoInput) {
    if (g.lat !== undefined && (g.lat < -90 || g.lat > 90)) throw new BadRequestException('Latitude inválida.');
    if (g.lng !== undefined && (g.lng < -180 || g.lng > 180)) throw new BadRequestException('Longitude inválida.');
    const both = g.lat !== undefined && g.lng !== undefined;
    return { lat: both ? g.lat! : null, lng: both ? g.lng! : null, accuracyM: both && g.accuracyM !== undefined ? Math.round(g.accuracyM) : null };
  }

  /** Confirma a entrega. A FOTO DO CANHOTO É OBRIGATÓRIA: sem ela (ou com arquivo que não é imagem legível) nada é gravado. */
  deliver(ctx: AuthContext, stopId: string, dto: { photo?: PhotoInput; receiverName: string; receiverDocument?: string; notes?: string } & GeoInput) {
    if (!dto.photo?.contentBase64) throw new BadRequestException('A foto do canhoto assinado é obrigatória para confirmar a entrega.');
    const photo = parseProofPhoto(dto.photo.contentBase64);
    const geo = this.geo(dto);
    return this.prisma.withContext(ctx, async (tx) => {
      const s = await this.ownStop(tx, ctx, stopId);
      if (s.status === 'DELIVERED') {
        const proof = await tx.deliveryProof.findFirst({ where: { tenantId: ctx.tenantId!, stopId, kind: 'DELIVERY' }, select: { sha256: true } });
        if (proof?.sha256 === photo.sha256) return { replayed: true as const, stopId, status: 'DELIVERED' as const };
        throw new ConflictException('Esta entrega já foi confirmada.');
      }
      if (s.status !== 'PENDING') throw new ConflictException('Esta parada não está mais pendente.');
      if (s.route.status !== 'IN_PROGRESS') throw new ConflictException('A rota ainda não foi iniciada pelo despachante.');
      const dup = await tx.deliveryProof.findFirst({ where: { tenantId: ctx.tenantId!, sha256: photo.sha256 }, select: { id: true } });
      if (dup) throw new ConflictException('Esta foto já foi usada em outra entrega. Tire uma foto do canhoto desta entrega.');
      await this.sales.advanceInTx(tx, ctx, s.salesOrderId, 'DELIVERED', { unscoped: true }).catch((e) => {
        if (e instanceof ConflictException) throw new ConflictException('O pedido não está mais em trânsito (foi cancelado, devolvido ou já entregue). Avise o despachante.');
        throw e;
      });
      const now = new Date();
      await tx.deliveryStop.update({
        where: { id: stopId },
        data: { status: 'DELIVERED', deliveredAt: now, receiverName: dto.receiverName.trim(), receiverDocument: dto.receiverDocument?.trim() || null, notes: dto.notes?.trim() || null, resolvedById: ctx.userId, ...geo },
      });
      await tx.deliveryProof.create({
        data: { tenantId: ctx.tenantId!, stopId, kind: 'DELIVERY', contentType: photo.contentType, bytes: photo.content.length, width: photo.width, height: photo.height, sha256: photo.sha256, content: new Uint8Array(photo.content), takenById: ctx.userId },
      });
      await this.audit.record(tx, ctx, { action: 'delivery.confirmed', entity: 'delivery_stop', entityId: stopId, metadata: { orderId: s.salesOrderId, receiver: dto.receiverName.trim(), sha256: photo.sha256, geo: geo.lat !== null } });
      await this.completeIfDone(tx, ctx, s.routeId);
      return { replayed: false as const, stopId, status: 'DELIVERED' as const };
    });
  }

  /** Não entregue: motivo obrigatório; a foto da ocorrência é opcional. O pedido continua em trânsito para uma nova tentativa. */
  fail(ctx: AuthContext, stopId: string, dto: { reason: string; photo?: PhotoInput } & GeoInput) {
    const photo = dto.photo?.contentBase64 ? parseProofPhoto(dto.photo.contentBase64) : null;
    const geo = this.geo(dto);
    return this.prisma.withContext(ctx, async (tx) => {
      const s = await this.ownStop(tx, ctx, stopId);
      if (s.status !== 'PENDING') throw new ConflictException('Esta parada não está mais pendente.');
      if (s.route.status !== 'IN_PROGRESS') throw new ConflictException('A rota ainda não foi iniciada pelo despachante.');
      if (photo && (await tx.deliveryProof.findFirst({ where: { tenantId: ctx.tenantId!, sha256: photo.sha256 }, select: { id: true } }))) throw new ConflictException('Esta foto já foi usada em outra ocorrência.');
      await tx.deliveryStop.update({ where: { id: stopId }, data: { status: 'FAILED', failureReason: dto.reason.trim(), resolvedById: ctx.userId, ...geo } });
      if (photo) {
        await tx.deliveryProof.create({ data: { tenantId: ctx.tenantId!, stopId, kind: 'FAILURE', contentType: photo.contentType, bytes: photo.content.length, width: photo.width, height: photo.height, sha256: photo.sha256, content: new Uint8Array(photo.content), takenById: ctx.userId } });
      }
      await this.audit.record(tx, ctx, { action: 'delivery.failed', entity: 'delivery_stop', entityId: stopId, metadata: { orderId: s.salesOrderId, reason: dto.reason.trim() } });
      await this.completeIfDone(tx, ctx, s.routeId);
      return { stopId, status: 'FAILED' as const };
    });
  }

  // ───────────── comprovantes ─────────────

  async proof(ctx: AuthContext, stopId: string, kind: 'DELIVERY' | 'FAILURE', own: boolean) {
    return this.prisma.withContext(ctx, async (tx) => {
      const s = await tx.deliveryStop.findFirst({ where: { id: stopId, tenantId: ctx.tenantId! }, include: { route: { include: { driver: true } } } });
      if (!s || (own && s.route.driver.userId !== ctx.userId)) throw new NotFoundException('Comprovante não encontrado.');
      const p = await tx.deliveryProof.findFirst({ where: { tenantId: ctx.tenantId!, stopId, kind } });
      if (!p) throw new NotFoundException('Comprovante não encontrado.');
      return { contentType: p.contentType, content: Buffer.from(p.content), sha256: p.sha256 };
    });
  }
}
