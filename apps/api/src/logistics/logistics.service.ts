import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';

const STATUSES = ['PENDING', 'POSTED', 'IN_TRANSIT', 'DELIVERED', 'PROBLEM', 'CANCELLED'] as const;
type ShipStatus = (typeof STATUSES)[number];
const TERMINAL: ShipStatus[] = ['DELIVERED', 'CANCELLED'];

/** Código de rastreamento dos Correios: 2 letras + 9 dígitos + 2 letras (ex.: AA123456789BR). Valida só o formato, não a existência. */
export const CORREIOS_TRACKING = /^[A-Z]{2}\d{9}[A-Z]{2}$/;

/**
 * Correios — o que existe e o que não existe nesta fase.
 * Sem contrato/credenciais NÃO há cotação, pré-postagem, etiqueta nem rastreamento automático: o conector responde NOT_CONFIGURED,
 * nunca valores inventados. O que funciona: registrar o envio, o código informado manualmente e os eventos de rastreio.
 */
export const CORREIOS_CAPABILITIES = {
  quote: { status: 'NOT_CONFIGURED', note: 'Cotação depende do contrato e das credenciais dos Correios (API oficial).' },
  prePostage: { status: 'NOT_CONFIGURED', note: 'Pré-postagem/etiqueta dependem do contrato e das credenciais.' },
  trackingSync: { status: 'NOT_CONFIGURED', note: 'Rastreamento automático depende das credenciais. Eventos podem ser lançados manualmente.' },
  manualShipment: { status: 'SUPPORTED', note: 'Registro de envio, código de rastreio informado e eventos manuais.' },
} as const;

@Injectable()
export class LogisticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  capabilities() { return { correios: CORREIOS_CAPABILITIES }; }

  // ---- Embalagens ---------------------------------------------------------
  packagings(ctx: AuthContext) {
    return this.prisma.withContext(ctx, (tx) => tx.packaging.findMany({ where: { tenantId: ctx.tenantId! }, orderBy: { name: 'asc' } }));
  }

  async createPackaging(ctx: AuthContext, dto: { name: string; lengthMm: number; widthMm: number; heightMm: number; maxWeightG: number; tareG?: number }) {
    for (const k of ['lengthMm', 'widthMm', 'heightMm', 'maxWeightG'] as const) if (!Number.isInteger(dto[k]) || dto[k] <= 0) throw new BadRequestException('Dimensões e peso máximo devem ser inteiros positivos.');
    return this.prisma.withContext(ctx, async (tx) => {
      try {
        const p = await tx.packaging.create({ data: { tenantId: ctx.tenantId!, name: dto.name.trim(), lengthMm: dto.lengthMm, widthMm: dto.widthMm, heightMm: dto.heightMm, maxWeightG: dto.maxWeightG, tareG: dto.tareG ?? 0 } });
        await this.audit.record(tx, ctx, { action: 'logistics.packaging_created', entity: 'packaging', entityId: p.id });
        return p;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('Já existe embalagem com este nome.');
        throw e;
      }
    });
  }

  // ---- Fila de expedição ---------------------------------------------------
  /** Pedidos aprovados/separados ainda sem envio ativo. Marketplaces seguem a etiqueta do canal quando o conector existir. */
  queue(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const orders = await tx.salesOrder.findMany({
        where: { tenantId: ctx.tenantId!, status: { in: ['CONFIRMED', 'PICKING', 'PACKED'] as never[] }, shipments: { none: { status: { not: 'CANCELLED' } } } },
        orderBy: { confirmedAt: 'asc' }, take: 200, include: { customer: { select: { name: true, city: true, state: true, zipCode: true } } },
      });
      return orders.map((o) => ({ id: o.id, number: o.number, status: o.status, channel: o.channel, confirmedAt: o.confirmedAt, customer: o.customer.name, city: o.customer.city, state: o.customer.state, zipCode: o.customer.zipCode }));
    });
  }

  // ---- Envios --------------------------------------------------------------
  list(ctx: AuthContext, status?: string) {
    return this.prisma.withContext(ctx, (tx) =>
      tx.shipment.findMany({ where: { tenantId: ctx.tenantId!, ...(status ? { status } : {}) }, orderBy: { createdAt: 'desc' }, take: 200, include: { order: { select: { number: true } } } }));
  }

  get(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const s = await tx.shipment.findFirst({ where: { id, tenantId: ctx.tenantId! }, include: { order: { select: { number: true } }, events: { orderBy: { occurredAt: 'desc' } } } });
      if (!s) throw new NotFoundException('Envio não encontrado.');
      return { ...s, events: s.events.map((e) => ({ ...e, id: e.id.toString() })) };
    });
  }

  async create(ctx: AuthContext, dto: { salesOrderId: string; carrier: 'CORREIOS' | 'OUTRA'; service?: string; trackingCode?: string; packagingId?: string; weightG?: number; cost?: number }) {
    if (dto.carrier !== 'CORREIOS' && dto.carrier !== 'OUTRA') throw new BadRequestException('Transportadora inválida.');
    const code = dto.trackingCode?.trim().toUpperCase() || null;
    if (code && dto.carrier === 'CORREIOS' && !CORREIOS_TRACKING.test(code)) throw new BadRequestException('Código de rastreio inválido para os Correios (formato AA123456789BR).');
    if (dto.weightG !== undefined && (!Number.isInteger(dto.weightG) || dto.weightG <= 0)) throw new BadRequestException('Peso inválido.');
    if (dto.cost !== undefined && !(dto.cost >= 0)) throw new BadRequestException('Custo inválido.');
    return this.prisma.withContext(ctx, async (tx) => {
      const order = await tx.salesOrder.findFirst({ where: { id: dto.salesOrderId, tenantId: ctx.tenantId! }, select: { id: true, status: true, number: true } });
      if (!order) throw new NotFoundException('Pedido não encontrado.');
      if (['DRAFT', 'PENDING_APPROVAL', 'CANCELLED'].includes(order.status as string)) throw new ConflictException('O pedido ainda não está liberado para expedição.');
      let pk: { id: string; maxWeightG: number; tareG: number; lengthMm: number; widthMm: number; heightMm: number } | null = null;
      if (dto.packagingId) {
        pk = await tx.packaging.findFirst({ where: { id: dto.packagingId, tenantId: ctx.tenantId!, active: true } });
        if (!pk) throw new BadRequestException('Embalagem inválida.');
        if (dto.weightG && dto.weightG > pk.maxWeightG) throw new BadRequestException(`O peso excede o máximo da embalagem (${pk.maxWeightG} g).`);
      }
      // Um pedido tem no máximo um envio ativo (a unicidade de código é garantida pelo banco).
      if (await tx.shipment.findFirst({ where: { tenantId: ctx.tenantId!, salesOrderId: order.id, status: { not: 'CANCELLED' } } })) throw new ConflictException('Este pedido já possui um envio ativo.');
      try {
        const s = await tx.shipment.create({
          data: {
            tenantId: ctx.tenantId!, salesOrderId: order.id, carrier: dto.carrier, service: dto.service ?? null, trackingCode: code, packagingId: pk?.id ?? null, weightG: dto.weightG ?? null,
            lengthMm: pk?.lengthMm ?? null, widthMm: pk?.widthMm ?? null, heightMm: pk?.heightMm ?? null, cost: dto.cost ?? null, createdById: ctx.userId,
          },
        });
        await tx.shipmentEvent.create({ data: { tenantId: ctx.tenantId!, shipmentId: s.id, occurredAt: new Date(), status: 'PENDING', description: 'Envio registrado', source: 'MANUAL' } });
        await this.audit.record(tx, ctx, { action: 'logistics.shipment_created', entity: 'shipment', entityId: s.id, metadata: { order: order.number, carrier: dto.carrier } });
        return s;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('Código de rastreio já usado em outro envio.');
        throw e;
      }
    });
  }

  /** Evento de rastreio manual. Estados finais não voltam atrás; a data de postagem/entrega é preenchida pelo primeiro evento correspondente. */
  async addEvent(ctx: AuthContext, id: string, dto: { status: ShipStatus; description: string; occurredAt?: string; location?: string; trackingCode?: string }) {
    if (!STATUSES.includes(dto.status)) throw new BadRequestException('Status inválido.');
    if (!dto.description?.trim()) throw new BadRequestException('Descreva o evento.');
    const at = dto.occurredAt ? new Date(dto.occurredAt) : new Date();
    if (Number.isNaN(at.getTime()) || at.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException('Data do evento inválida.');
    return this.prisma.withContext(ctx, async (tx) => {
      const rows = await tx.$queryRaw<{ status: string; carrier: string; tracking_code: string | null }[]>`SELECT status, carrier, tracking_code FROM shipments WHERE id = ${id}::uuid AND tenant_id = ${ctx.tenantId}::uuid FOR UPDATE`;
      const cur = rows[0];
      if (!cur) throw new NotFoundException('Envio não encontrado.');
      if (TERMINAL.includes(cur.status as ShipStatus)) throw new ConflictException('Envio já encerrado.');
      const code = dto.trackingCode?.trim().toUpperCase();
      if (code && cur.carrier === 'CORREIOS' && !CORREIOS_TRACKING.test(code)) throw new BadRequestException('Código de rastreio inválido para os Correios.');
      if (['POSTED', 'IN_TRANSIT', 'DELIVERED'].includes(dto.status) && !(code ?? cur.tracking_code) && cur.carrier === 'CORREIOS') throw new BadRequestException('Informe o código de rastreio antes de marcar como postado.');
      await tx.shipmentEvent.create({ data: { tenantId: ctx.tenantId!, shipmentId: id, occurredAt: at, status: dto.status, description: dto.description.trim().slice(0, 300), location: dto.location?.slice(0, 120) ?? null, source: 'MANUAL' } });
      try {
        await tx.shipment.update({
          where: { id },
          data: {
            status: dto.status, ...(code ? { trackingCode: code } : {}),
            ...(dto.status === 'POSTED' ? { postedAt: at } : {}), ...(dto.status === 'DELIVERED' ? { deliveredAt: at } : {}),
          },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('Código de rastreio já usado em outro envio.');
        throw e;
      }
      await this.audit.record(tx, ctx, { action: 'logistics.shipment_event', entity: 'shipment', entityId: id, metadata: { status: dto.status } });
      return { id, status: dto.status };
    });
  }
}
