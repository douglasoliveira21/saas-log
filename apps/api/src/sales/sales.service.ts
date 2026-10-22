import { buildFiscalPreview } from './fiscal-preview';
import { asDateColumn, computeDispatch } from './cutoff';
import { purchaseProfiles } from '../customers/purchase-profile';
import { DelinquencyService } from '../finance/delinquency';
import { assertWithinPlan } from '../billing/limits';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { FiscalDocChoice, OrderStatus, Prisma, SalesChannel } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/auth';
import { CommissionsService, fromCents, toCents } from '../commissions/commissions.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { StockService } from '../stock/stock.service';

type Tx = Prisma.TransactionClient;

export interface OrderInput {
  customerId: string;
  warehouseId: string;
  salespersonId?: string;
  channel?: SalesChannel;
  fiscalDocType?: FiscalDocChoice;
  shipping?: number;
  notes?: string;
  items: { productId: string; quantity: number; unitPrice?: number; discountPct?: number }[];
}

const NEXT: Partial<Record<OrderStatus, OrderStatus>> = { CONFIRMED: 'PICKING', PICKING: 'PACKED', PACKED: 'SHIPPED', SHIPPED: 'DELIVERED', DELIVERED: 'CLOSED' };
const CANCELLABLE: OrderStatus[] = ['DRAFT', 'PENDING_APPROVAL', 'CONFIRMED', 'PICKING', 'PACKED'];
const RETURNABLE: OrderStatus[] = ['SHIPPED', 'DELIVERED', 'CLOSED'];

/** Valor da linha em centavos: preço × qtd × (1 − desconto), desconto em pontos-base (2 casas). */
export const lineCents = (unitCents: number, qty: number, discountPct: number) =>
  Math.round((unitCents * qty * (10000 - Math.round(discountPct * 100))) / 10000);

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly stock: StockService,
    private readonly commissions: CommissionsService,
    private readonly settings: SettingsService,
    private readonly delinquency: DelinquencyService,
  ) {}

  // ───────────── consulta ─────────────

  private async scope(tx: Tx, ctx: AuthContext): Promise<Prisma.SalesOrderWhereInput> {
    if (ctx.permissions.has('sales.view_all')) return {};
    const mine = await tx.salesperson.findFirst({ where: { tenantId: ctx.tenantId!, userId: ctx.userId }, select: { id: true } });
    return { OR: [{ createdById: ctx.userId }, ...(mine ? [{ salespersonId: mine.id }] : [])] };
  }

  list(ctx: AuthContext, q: { status?: OrderStatus; search?: string; limit?: number; offset?: number }) {
    return this.prisma.withContext(ctx, async (tx) => {
      const num = q.search && /^\d+$/.test(q.search) ? Number(q.search) : undefined;
      const where: Prisma.SalesOrderWhereInput = {
        tenantId: ctx.tenantId!, AND: [await this.scope(tx, ctx)],
        ...(q.status ? { status: q.status } : {}),
        ...(q.search ? { OR: [...(num ? [{ number: num }] : []), { customer: { name: { contains: q.search, mode: 'insensitive' } } }] } : {}),
      };
      const [items, total] = await Promise.all([
        tx.salesOrder.findMany({
          where, orderBy: { number: 'desc' }, take: q.limit ?? 50, skip: q.offset ?? 0,
          select: { id: true, number: true, status: true, channel: true, total: true, createdAt: true, customerType: true, dispatchDate: true, dispatchDeferred: true, customer: { select: { name: true } }, salesperson: { select: { name: true } } },
        }),
        tx.salesOrder.count({ where }),
      ]);
      return { total, items };
    });
  }

  get(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const order = await tx.salesOrder.findFirst({
        where: { id, tenantId: ctx.tenantId!, AND: [await this.scope(tx, ctx)] },
        include: {
          customer: { select: { id: true, name: true, document: true } }, salesperson: { select: { id: true, name: true } }, warehouse: { select: { code: true, name: true } },
          items: { include: { product: { select: { sku: true, name: true } }, returnItems: { select: { quantity: true } } }, orderBy: { id: 'asc' } },
          returns: { include: { items: true }, orderBy: { createdAt: 'desc' } },
        },
      });
      if (!order) throw new NotFoundException('Pedido não encontrado.');
      return { ...order, items: order.items.map(({ returnItems, ...i }) => ({ ...i, returnedQty: returnItems.reduce((s, r) => s + r.quantity, 0) })) };
    });
  }

  /** Espelho (DANFE/cupom) e pendências para emitir o documento fiscal escolhido. Respeita o escopo do usuário. */
  fiscalPreview(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const own = await tx.salesOrder.findFirst({ where: { id, tenantId: ctx.tenantId!, AND: [await this.scope(tx, ctx)] }, select: { id: true } });
      if (!own) throw new NotFoundException('Pedido não encontrado.');
      return buildFiscalPreview(tx, ctx.tenantId!, id);
    });
  }

  /** Perfil do cliente agora (primeira compra, ativo ou que voltou); guardado no pedido e refeito na confirmação. */
  private async customerTypeOf(tx: Tx, ctx: AuthContext, customerId: string, excludeOrderId?: string) {
    const cfg = await this.settings.load(tx, ctx);
    return (await purchaseProfiles(tx, ctx.tenantId!, [customerId], cfg['customers.inactiveAfterDays'], { excludeOrderId })).get(customerId)?.type;
  }

  /** Regra do horário de corte e quando sairia um pedido confirmado agora (vendas fora de marketplace). */
  cutoffInfo(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const cfg = await this.settings.load(tx, ctx);
      const time = cfg['sales.cutoffTime'];
      if (!time) return { enabled: false as const, cutoffTime: null, businessDaysOnly: cfg['sales.cutoffBusinessDaysOnly'], dispatchDate: null, deferred: false, today: null };
      const d = computeDispatch(new Date(), time, cfg['sales.cutoffBusinessDaysOnly']);
      return { enabled: true as const, cutoffTime: time, businessDaysOnly: cfg['sales.cutoffBusinessDaysOnly'], dispatchDate: d.dispatchDate, deferred: d.deferred, today: d.today };
    });
  }

  // ───────────── rascunho ─────────────

  create(ctx: AuthContext, dto: OrderInput) {
    return this.prisma.withContext(ctx, async (tx) => {
      await assertWithinPlan(tx, ctx.tenantId!, 'ordersPerMonth');
      const data = await this.prepare(tx, ctx, dto);
      const number = await this.settings.nextNumber(tx, ctx, 'sales_order');
      const order = await tx.salesOrder.create({
        data: {
          tenantId: ctx.tenantId!, number, customerId: dto.customerId, warehouseId: dto.warehouseId, salespersonId: data.salespersonId,
          channel: dto.channel ?? 'DIRECT', fiscalDocType: dto.fiscalDocType ?? 'NONE', customerType: await this.customerTypeOf(tx, ctx, dto.customerId), notes: dto.notes, createdById: ctx.userId, ...data.totals,
        },
      });
      await tx.salesOrderItem.createMany({ data: data.rows.map((r) => ({ ...r, orderId: order.id })) });
      await this.audit.record(tx, ctx, { action: 'sales.created', entity: 'sales_order', entityId: order.id, metadata: { number, total: data.totals.total } });
      return { id: order.id, number };
    });
  }

  update(ctx: AuthContext, id: string, dto: OrderInput) {
    return this.prisma.withContext(ctx, async (tx) => {
      const order = await this.lock(tx, ctx, id);
      if (order.status !== 'DRAFT') throw new ConflictException('Somente pedidos em rascunho podem ser editados.');
      const data = await this.prepare(tx, ctx, dto);
      await tx.salesOrderItem.deleteMany({ where: { orderId: id, tenantId: ctx.tenantId! } });
      await tx.salesOrder.update({
        where: { id },
        data: {
          customerId: dto.customerId, warehouseId: dto.warehouseId, salespersonId: data.salespersonId, channel: dto.channel ?? 'DIRECT', fiscalDocType: dto.fiscalDocType ?? 'NONE', customerType: await this.customerTypeOf(tx, ctx, dto.customerId, id), notes: dto.notes, ...data.totals,
        },
      });
      await tx.salesOrderItem.createMany({ data: data.rows.map((r) => ({ ...r, orderId: id })) });
      await this.audit.record(tx, ctx, { action: 'sales.updated', entity: 'sales_order', entityId: id, metadata: { total: data.totals.total } });
      return { id };
    });
  }

  // ───────────── fluxo ─────────────

  submit(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const order = await this.lock(tx, ctx, id);
      if (order.status !== 'DRAFT') throw new ConflictException(`Operação inválida: o pedido está "${order.status}".`);
      if (!order.items.length) throw new BadRequestException('O pedido não possui itens.');
      await this.delinquency.assertNotBlocked(tx, ctx.tenantId!, order.customerId);
      const cfg = await this.settings.load(tx, ctx);
      const reasons: string[] = [];
      for (const i of order.items) {
        if (Number(i.discountPct) > cfg['sales.maxDiscountPct']) reasons.push(`${i.product.sku}: desconto de ${Number(i.discountPct)}% acima do limite de ${cfg['sales.maxDiscountPct']}%`);
        const min = (await tx.product.findUniqueOrThrow({ where: { id: i.productId }, select: { minPrice: true } })).minPrice;
        const net = toCents(i.unitPrice) * (10000 - Math.round(Number(i.discountPct) * 100)) / 10000;
        if (min && net < toCents(min)) reasons.push(`${i.product.sku}: preço líquido abaixo do mínimo autorizado`);
      }
      if (reasons.length) {
        await tx.salesOrder.update({ where: { id }, data: { status: 'PENDING_APPROVAL', approvalReason: reasons.join('; ') } });
        await this.audit.record(tx, ctx, { action: 'sales.approval_requested', entity: 'sales_order', entityId: id, metadata: { reasons } });
        return { id, status: 'PENDING_APPROVAL' as const, reasons };
      }
      await this.confirm(tx, ctx, order);
      return { id, status: 'CONFIRMED' as const, reasons };
    });
  }

  approve(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const order = await this.lock(tx, ctx, id);
      if (order.status !== 'PENDING_APPROVAL') throw new ConflictException(`Operação inválida: o pedido está "${order.status}".`);
      // Segregação de funções: quem criou não aprova (exceto o proprietário da empresa).
      if (order.createdById === ctx.userId && !ctx.permissions.has('tenant.manage')) throw new ForbiddenException('A aprovação deve ser feita por outro usuário.');
      await tx.salesOrder.update({ where: { id }, data: { approvedById: ctx.userId } });
      await this.confirm(tx, ctx, order);
      await this.audit.record(tx, ctx, { action: 'sales.approved', entity: 'sales_order', entityId: id, metadata: { reason: order.approvalReason } });
      return { id, status: 'CONFIRMED' as const };
    });
  }

  reject(ctx: AuthContext, id: string, reason: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const order = await this.lock(tx, ctx, id);
      if (order.status !== 'PENDING_APPROVAL') throw new ConflictException(`Operação inválida: o pedido está "${order.status}".`);
      await tx.salesOrder.update({ where: { id }, data: { status: 'DRAFT', approvalReason: `Rejeitado: ${reason}` } });
      await this.audit.record(tx, ctx, { action: 'sales.rejected', entity: 'sales_order', entityId: id, metadata: { reason } });
      return { id, status: 'DRAFT' as const };
    });
  }

  advance(ctx: AuthContext, id: string, to: OrderStatus) {
    return this.prisma.withContext(ctx, async (tx) => {
      const order = await this.lock(tx, ctx, id);
      if (NEXT[order.status] !== to) throw new ConflictException(`Transição inválida: ${order.status} → ${to}.`);
      const data: Prisma.SalesOrderUpdateInput = { status: to };
      if (to === 'SHIPPED') {
        // Efetiva a venda: consome as reservas (baixa o físico e grava SALE_EXIT no razão).
        for (const i of order.items) if (i.reservationId) await this.stock.resolveReservationTx(tx, ctx, i.reservationId, 'CONSUMED');
        data.shippedAt = new Date();
      }
      if (to === 'DELIVERED') data.deliveredAt = new Date();
      await tx.salesOrder.update({ where: { id }, data });
      if (to === 'SHIPPED') await this.commissions.onOrderEvent(tx, ctx, id, 'SHIPPED');
      if (to === 'DELIVERED') await this.commissions.onOrderEvent(tx, ctx, id, 'DELIVERED');
      await this.audit.record(tx, ctx, { action: `sales.${to.toLowerCase()}`, entity: 'sales_order', entityId: id });
      return { id, status: to };
    });
  }

  cancel(ctx: AuthContext, id: string, reason: string) {
    return this.prisma.withContext(ctx, (tx) => this.cancelInTx(tx, ctx, id, reason));
  }

  async cancelInTx(tx: Tx, ctx: AuthContext, id: string, reason: string) {
    {
      const order = await this.lock(tx, ctx, id);
      if (!CANCELLABLE.includes(order.status)) {
        throw new ConflictException(order.status === 'CANCELLED' ? 'O pedido já está cancelado.' : 'Pedido já expedido: registre uma devolução em vez de cancelar.');
      }
      for (const i of order.items) if (i.reservationId) await this.stock.resolveReservationTx(tx, ctx, i.reservationId, 'RELEASED');
      await this.commissions.reverseAll(tx, ctx, id, `Cancelamento: ${reason}`);
      await tx.salesOrder.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason } });
      await this.audit.record(tx, ctx, { action: 'sales.cancelled', entity: 'sales_order', entityId: id, metadata: { reason, from: order.status } });
      return { id, status: 'CANCELLED' as const };
    }
  }

  /** Devolução total/parcial de itens já expedidos. Repõe estoque (se `restock`) e estorna comissão proporcional. */
  createReturn(ctx: AuthContext, id: string, dto: { reason: string; restock?: boolean; items: { orderItemId: string; quantity: number }[] }) {
    return this.prisma.withContext(ctx, async (tx) => {
      const order = await this.lock(tx, ctx, id);
      if (!RETURNABLE.includes(order.status)) throw new ConflictException('Só é possível devolver pedidos já expedidos.');
      const restock = dto.restock ?? true;
      const lines: { orderItemId: string; itemQty: number; returnedBefore: number; returnedNow: number; productId: string }[] = [];
      for (const it of dto.items) {
        const oi = order.items.find((x) => x.id === it.orderItemId);
        if (!oi) throw new BadRequestException('Item não pertence ao pedido.');
        if (lines.some((l) => l.orderItemId === it.orderItemId)) throw new BadRequestException('Item repetido na devolução.');
        const done = await tx.returnItem.aggregate({ where: { tenantId: ctx.tenantId!, orderItemId: oi.id }, _sum: { quantity: true } });
        const before = done._sum.quantity ?? 0;
        if (it.quantity + before > oi.quantity) throw new ConflictException(`Quantidade devolvida excede o vendido para ${oi.product.sku} (vendido ${oi.quantity}, já devolvido ${before}).`);
        lines.push({ orderItemId: oi.id, itemQty: oi.quantity, returnedBefore: before, returnedNow: it.quantity, productId: oi.productId });
      }
      const ret = await tx.returnRequest.create({ data: { tenantId: ctx.tenantId!, orderId: id, reason: dto.reason, restock, createdById: ctx.userId } });
      await tx.returnItem.createMany({ data: lines.map((l) => ({ tenantId: ctx.tenantId!, returnId: ret.id, orderItemId: l.orderItemId, quantity: l.returnedNow })) });
      if (restock) {
        for (const l of lines) {
          await this.stock.applyMovement(tx, ctx, {
            productId: l.productId, warehouseId: order.warehouseId, type: 'RETURN_ENTRY', quantity: l.returnedNow,
            reason: `Devolução do pedido ${order.number}`, reference: `pedido:${order.number}`, idempotencyKey: `return:${ret.id}:${l.productId}`,
          });
        }
      }
      await this.commissions.reverseForReturn(tx, ctx, id, ret.id, lines);
      await this.audit.record(tx, ctx, { action: 'sales.returned', entity: 'sales_order', entityId: id, metadata: { returnId: ret.id, restock, items: lines.length, reason: dto.reason } });
      return { id: ret.id };
    });
  }

  // ───────────── pedidos vindos de canais externos ─────────────

  /**
   * Cria um pedido a partir de um canal (a venda já aconteceu no marketplace): preço vem do canal, sem vendedor,
   * origem MARKETPLACE. A chave (origem, referência externa) é única no banco: nunca há pedido duplicado.
   */
  async createFromExternal(
    tx: Tx, ctx: AuthContext,
    input: { customerId: string; warehouseId: string; source: string; ref: string; notes?: string; items: { productId: string; quantity: number; unitPrice: number }[] },
  ) {
    const data = await this.prepare(tx, ctx, { customerId: input.customerId, warehouseId: input.warehouseId, channel: 'MARKETPLACE', notes: input.notes, items: input.items });
    const number = await this.settings.nextNumber(tx, ctx, 'sales_order');
    const order = await tx.salesOrder.create({
      data: {
        tenantId: ctx.tenantId!, number, customerId: input.customerId, warehouseId: input.warehouseId, salespersonId: null, channel: 'MARKETPLACE',
        notes: input.notes, externalSource: input.source, externalRef: input.ref, ...data.totals,
      },
    });
    await tx.salesOrderItem.createMany({ data: data.rows.map((r) => ({ ...r, orderId: order.id })) });
    await this.audit.record(tx, ctx, { action: 'sales.imported', entity: 'sales_order', entityId: order.id, metadata: { number, source: input.source, ref: input.ref } });
    return { id: order.id, number };
  }

  /**
   * Confirma (reserva estoque) um pedido importado. Se faltar estoque, o pedido NÃO é perdido: fica em
   * PENDING_APPROVAL com o motivo, para tratamento manual (a venda existe no canal).
   */
  async confirmExternal(tx: Tx, ctx: AuthContext, id: string): Promise<{ confirmed: boolean; reason?: string }> {
    const order = await this.lock(tx, ctx, id);
    await tx.$executeRawUnsafe('SAVEPOINT import_confirm');
    try {
      await this.confirm(tx, ctx, order);
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT import_confirm');
      return { confirmed: true };
    } catch (e) {
      if (!(e instanceof ConflictException)) throw e;
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT import_confirm');
      const reason = 'Importado do marketplace: ' + e.message;
      await tx.salesOrder.update({ where: { id }, data: { status: 'PENDING_APPROVAL', approvalReason: reason } });
      await this.audit.record(tx, ctx, { action: 'sales.import_needs_attention', entity: 'sales_order', entityId: id, metadata: { reason } });
      return { confirmed: false, reason };
    }
  }

  // ───────────── internos ─────────────

  private async confirm(tx: Tx, ctx: AuthContext, order: Awaited<ReturnType<SalesService['lock']>>) {
    for (const i of order.items) {
      const res = await this.stock
        .reserveTx(tx, ctx, { productId: i.productId, warehouseId: order.warehouseId, quantity: i.quantity, reference: `pedido:${order.number}`, idempotencyKey: `order:${order.id}:${i.productId}` })
        .catch((e) => {
          if (e instanceof ConflictException) throw new ConflictException(`Estoque insuficiente para ${i.product.sku} no depósito do pedido.`);
          throw e;
        });
      await tx.salesOrderItem.update({ where: { id: i.id }, data: { reservationId: res.reservation.id } });
    }
    const now = new Date();
    const cfg = await this.settings.load(tx, { tenantId: ctx.tenantId });
    const cut = order.channel !== 'MARKETPLACE' && cfg['sales.cutoffTime'] ? computeDispatch(now, cfg['sales.cutoffTime'], cfg['sales.cutoffBusinessDaysOnly']) : null;
    const profile = (await purchaseProfiles(tx, ctx.tenantId!, [order.customerId], cfg['customers.inactiveAfterDays'], { now, excludeOrderId: order.id })).get(order.customerId);
    await tx.salesOrder.update({
      where: { id: order.id },
      data: { status: 'CONFIRMED', confirmedAt: now, customerType: profile?.type, ...(cut ? { dispatchDate: asDateColumn(cut.dispatchDate), dispatchDeferred: cut.deferred } : {}) },
    });
    const n = await this.commissions.accrue(
      tx, ctx, { id: order.id, salespersonId: order.salespersonId, customerId: order.customerId, channel: order.channel },
      order.items.map((i) => ({ id: i.id, productId: i.productId, quantity: i.quantity, total: i.total, categoryId: i.product.categoryId })),
    );
    await this.audit.record(tx, ctx, { action: 'sales.confirmed', entity: 'sales_order', entityId: order.id, metadata: { number: order.number, commissionEntries: n } });
  }

  private async lock(tx: Tx, ctx: AuthContext, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM sales_orders WHERE id = ${id}::uuid AND tenant_id = ${ctx.tenantId}::uuid FOR UPDATE`;
    const order = rows.length
      ? await tx.salesOrder.findFirst({
          where: { id, tenantId: ctx.tenantId!, AND: [await this.scope(tx, ctx)] },
          include: { items: { include: { product: { select: { sku: true, categoryId: true } } }, orderBy: { id: 'asc' } } },
        })
      : null;
    if (!order) throw new NotFoundException('Pedido não encontrado.');
    return order;
  }

  /** Valida referências do tenant, calcula preços/descontos/totais em centavos e resolve o vendedor. */
  private async prepare(tx: Tx, ctx: AuthContext, dto: OrderInput) {
    const [customer, wh] = await Promise.all([
      tx.customer.findFirst({ where: { id: dto.customerId, tenantId: ctx.tenantId!, active: true } }),
      tx.warehouse.findFirst({ where: { id: dto.warehouseId, tenantId: ctx.tenantId!, active: true } }),
    ]);
    if (!customer) throw new BadRequestException('Cliente inválido ou inativo.');
    if (dto.channel !== 'MARKETPLACE') await this.delinquency.assertNotBlocked(tx, ctx.tenantId!, customer.id);
    if (!wh) throw new BadRequestException('Depósito inválido ou inativo.');
    if (!dto.items.length) throw new BadRequestException('Inclua ao menos um item.');
    if (new Set(dto.items.map((i) => i.productId)).size !== dto.items.length) throw new BadRequestException('Produto repetido no pedido: some as quantidades em uma linha.');

    let salespersonId = dto.salespersonId ?? null;
    const mine = ctx.userId ? await tx.salesperson.findFirst({ where: { tenantId: ctx.tenantId!, userId: ctx.userId, active: true }, select: { id: true } }) : null;
    if (!ctx.permissions.has('sales.view_all')) salespersonId = mine?.id ?? null; // vendedor só vende em seu próprio nome
    else if (!salespersonId) salespersonId = mine?.id ?? null;
    if (salespersonId && !(await tx.salesperson.findFirst({ where: { id: salespersonId, tenantId: ctx.tenantId!, active: true } }))) throw new BadRequestException('Vendedor inválido ou inativo.');

    const products = await tx.product.findMany({ where: { tenantId: ctx.tenantId!, id: { in: dto.items.map((i) => i.productId) }, active: true, kind: 'PHYSICAL' } });
    const byId = new Map(products.map((p) => [p.id, p]));
    let subtotal = 0;
    let net = 0;
    const rows = dto.items.map((i) => {
      const p = byId.get(i.productId);
      if (!p) throw new BadRequestException('Produto inválido, inativo ou não físico.');
      const price = i.unitPrice ?? (p.suggestedPrice ? Number(p.suggestedPrice) : undefined);
      if (price === undefined) throw new BadRequestException(`Informe o preço de ${p.sku} (sem preço sugerido).`);
      const disc = i.discountPct ?? 0;
      const unitCents = Math.round(price * 100);
      const total = lineCents(unitCents, i.quantity, disc);
      subtotal += unitCents * i.quantity;
      net += total;
      return { tenantId: ctx.tenantId!, productId: p.id, quantity: i.quantity, unitPrice: fromCents(unitCents), discountPct: disc, total: fromCents(total), costSnapshot: p.costPrice };
    });
    const shippingCents = Math.round((dto.shipping ?? 0) * 100);
    return {
      salespersonId, rows,
      totals: { subtotal: fromCents(subtotal), discountTotal: fromCents(subtotal - net), shipping: fromCents(shippingCents), total: fromCents(net + shippingCents) },
    };
  }
}
