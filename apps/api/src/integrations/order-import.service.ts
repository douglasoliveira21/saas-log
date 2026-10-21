import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthContext, systemContext } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';
import { SalesService } from '../sales/sales.service';
import { ExternalOrder } from './connector';

type Tx = Prisma.TransactionClient;

export interface ImportSummary {
  imported: number;
  cancelled: number;
  awaitingPayment: number;
  needsAttention: number;
  unchanged: number;
}

type Outcome = keyof ImportSummary;

const PAID = new Set(['paid']);
const CANCELLED = new Set(['cancelled', 'invalid']);

const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/**
 * Importa pedidos de canais para pedidos de venda do ERP, com idempotência em três camadas:
 * livro `external_orders` (único por conexão+id externo), chave única do pedido (origem+referência) e reservas de estoque
 * com chave por pedido. Importar o mesmo pedido N vezes (webhook duplicado, reconciliação, reprocessamento) é seguro.
 */
@Injectable()
export class OrderImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sales: SalesService,
    private readonly audit: AuditService,
  ) {}

  async importOrders(tenantId: string, connectionId: string, orders: ExternalOrder[]): Promise<ImportSummary> {
    const summary: ImportSummary = { imported: 0, cancelled: 0, awaitingPayment: 0, needsAttention: 0, unchanged: 0 };
    for (const o of orders) summary[await this.importOne(tenantId, connectionId, o)]++;
    return summary;
  }

  private async importOne(tenantId: string, connectionId: string, order: ExternalOrder): Promise<Outcome> {
    const run = () => this.prisma.withContext({ tenantId }, (tx) => this.processInTx(tx, tenantId, connectionId, order));
    try {
      return await run();
    } catch (e) {
      if (isUnique(e)) return run(); // processamento concorrente do mesmo pedido: a segunda execução enxerga o resultado da primeira
      throw e;
    }
  }

  private async processInTx(tx: Tx, tenantId: string, connectionId: string, order: ExternalOrder): Promise<Outcome> {
    const ctx = systemContext(tenantId);
    const conn = await tx.marketplaceConnection.findFirst({ where: { id: connectionId, tenantId } });
    if (!conn) throw new NotFoundException('Conexão não encontrada.');
    const ledger = await tx.externalOrder.findUnique({ where: { connectionId_externalId: { connectionId, externalId: order.externalId } } });
    const payload = order as unknown as Prisma.InputJsonValue;
    const save = (status: string, extra: { reason?: string | null; salesOrderId?: string | null } = {}) =>
      tx.externalOrder.upsert({
        where: { connectionId_externalId: { connectionId, externalId: order.externalId } },
        create: { tenantId, connectionId, externalId: order.externalId, status, externalStatus: order.status, payload, reason: extra.reason ?? null, salesOrderId: extra.salesOrderId ?? null },
        update: { status, externalStatus: order.status, payload, reason: extra.reason ?? null, ...(extra.salesOrderId !== undefined ? { salesOrderId: extra.salesOrderId } : {}) },
      });

    // ── cancelado no canal
    if (CANCELLED.has(order.status)) {
      if (ledger?.status === 'CANCELLED') return 'unchanged';
      if (ledger?.salesOrderId) {
        const so = await tx.salesOrder.findFirstOrThrow({ where: { id: ledger.salesOrderId, tenantId } });
        const policy = (conn.config as { cancellationPolicy?: string }).cancellationPolicy ?? 'RELEASE_RESERVATION';
        if (so.status === 'CANCELLED') { await save('CANCELLED', { reason: null }); return 'cancelled'; }
        if (policy === 'MANUAL_REVIEW') { await save('NEEDS_ATTENTION', { reason: `Cancelado no canal; revise o pedido ${so.number} (política: revisão manual).` }); return 'needsAttention'; }
        if (['DRAFT', 'PENDING_APPROVAL', 'CONFIRMED', 'PICKING', 'PACKED'].includes(so.status)) {
          await this.sales.cancelInTx(tx, ctx, so.id, 'Cancelado no marketplace');
          await save('CANCELLED', { reason: null });
          return 'cancelled';
        }
        await save('NEEDS_ATTENTION', { reason: `Cancelado no canal, mas o pedido ${so.number} já foi expedido: registre a devolução, se aplicável.` });
        return 'needsAttention';
      }
      await save('CANCELLED', { reason: null });
      return 'cancelled';
    }

    // ── ainda não pago: só registra
    if (!PAID.has(order.status)) {
      if (ledger?.salesOrderId) return 'unchanged';
      await save('AWAITING_PAYMENT', { reason: `Situação no canal: ${order.status || 'desconhecida'}` });
      return 'awaitingPayment';
    }

    // ── pago e já importado: reavalia só se ficou pendente de estoque
    if (ledger?.salesOrderId) {
      const so = await tx.salesOrder.findFirstOrThrow({ where: { id: ledger.salesOrderId, tenantId } });
      if (so.status !== 'PENDING_APPROVAL' || ledger.status !== 'NEEDS_ATTENTION') return 'unchanged';
      const r = await this.sales.confirmExternal(tx, ctx, so.id);
      if (r.confirmed) { await save('IMPORTED', { reason: null }); return 'imported'; }
      await save('NEEDS_ATTENTION', { reason: r.reason });
      return 'needsAttention';
    }

    // ── pago e novo: precisa de depósito, itens vinculados e comprador
    if (!conn.warehouseId) { await save('NEEDS_ATTENTION', { reason: 'Defina o depósito de origem da conexão para importar pedidos.' }); return 'needsAttention'; }
    const items = order.items ?? [];
    if (!items.length) { await save('NEEDS_ATTENTION', { reason: 'Pedido sem itens na resposta do canal.' }); return 'needsAttention'; }

    const merged = new Map<string, { productId: string; quantity: number; unitPrice: number }>();
    const missing: string[] = [];
    for (const it of items) {
      const map = await tx.externalEntityMapping.findUnique({ where: { connectionId_entityType_externalId: { connectionId, entityType: 'LISTING', externalId: it.externalItemId } } });
      const product = map?.internalId
        ? await tx.product.findFirst({ where: { id: map.internalId, tenantId, active: true, kind: 'PHYSICAL' } })
        : it.sku ? await tx.product.findFirst({ where: { tenantId, sku: it.sku, active: true, kind: 'PHYSICAL' } }) : null;
      if (!product || !(it.quantity > 0) || !(it.unitPrice >= 0)) { missing.push(it.sku || it.externalItemId || it.title || '?'); continue; }
      const cur = merged.get(product.id);
      if (cur && cur.unitPrice !== it.unitPrice) { missing.push(`${product.sku} (preços diferentes na mesma ordem)`); continue; }
      merged.set(product.id, { productId: product.id, quantity: (cur?.quantity ?? 0) + it.quantity, unitPrice: it.unitPrice });
    }
    if (missing.length) {
      await save('NEEDS_ATTENTION', { reason: `Itens sem vínculo com produto do ERP: ${missing.join(', ')}. Cadastre um produto com o mesmo SKU ou vincule o anúncio ao produto.` });
      return 'needsAttention';
    }
    if (!order.buyer?.id) { await save('NEEDS_ATTENTION', { reason: 'Pedido sem identificação do comprador.' }); return 'needsAttention'; }

    const customerId = await this.customerFor(tx, tenantId, connectionId, conn.provider, order.buyer);
    const created = await this.sales.createFromExternal(tx, ctx, {
      customerId, warehouseId: conn.warehouseId, source: conn.provider, ref: order.externalId,
      notes: `Pedido ${order.externalId} importado de ${conn.label}`, items: [...merged.values()],
    });
    const r = await this.sales.confirmExternal(tx, ctx, created.id);
    if (r.confirmed) { await save('IMPORTED', { salesOrderId: created.id, reason: null }); await this.audit.record(tx, ctx, { action: 'integration.order_imported', entity: 'sales_order', entityId: created.id, metadata: { externalId: order.externalId, connectionId } }); return 'imported'; }
    await save('NEEDS_ATTENTION', { salesOrderId: created.id, reason: r.reason });
    return 'needsAttention';
  }

  private async customerFor(tx: Tx, tenantId: string, connectionId: string, provider: string, buyer: { id: string; nickname?: string }): Promise<string> {
    const key = { connectionId_entityType_externalId: { connectionId, entityType: 'BUYER', externalId: buyer.id } };
    const map = await tx.externalEntityMapping.findUnique({ where: key });
    if (map?.internalId) return map.internalId;
    const c = await tx.customer.create({ data: { tenantId, kind: 'PF', name: `${provider === 'MERCADO_LIVRE' ? 'Mercado Livre' : provider === 'MAGALU' ? 'Magalu' : provider} — ${buyer.nickname ?? buyer.id}`.slice(0, 200) } });
    await tx.externalEntityMapping.create({ data: { tenantId, connectionId, entityType: 'BUYER', externalId: buyer.id, internalId: c.id, metadata: { nickname: buyer.nickname ?? null } } });
    return c.id;
  }

  // ───────────── operação manual ─────────────

  listLedger(ctx: AuthContext, connectionId: string, status?: string) {
    return this.prisma.withContext(ctx, (tx) =>
      tx.externalOrder.findMany({
        where: { tenantId: ctx.tenantId!, connectionId, ...(status ? { status } : {}) },
        orderBy: { updatedAt: 'desc' }, take: 100,
        select: { id: true, externalId: true, status: true, externalStatus: true, reason: true, salesOrderId: true, updatedAt: true },
      }),
    );
  }

  /** Vincula um anúncio do canal (item) a um produto do ERP. */
  mapListing(ctx: AuthContext, connectionId: string, dto: { externalItemId: string; productId: string }) {
    return this.prisma.withContext(ctx, async (tx) => {
      if (!(await tx.marketplaceConnection.findFirst({ where: { id: connectionId, tenantId: ctx.tenantId! }, select: { id: true } }))) throw new NotFoundException('Conexão não encontrada.');
      if (!(await tx.product.findFirst({ where: { id: dto.productId, tenantId: ctx.tenantId!, kind: 'PHYSICAL' }, select: { id: true } }))) throw new BadRequestException('Produto inválido.');
      const key = { connectionId_entityType_externalId: { connectionId, entityType: 'LISTING', externalId: dto.externalItemId } };
      await tx.externalEntityMapping.upsert({
        where: key,
        create: { tenantId: ctx.tenantId!, connectionId, entityType: 'LISTING', externalId: dto.externalItemId, internalId: dto.productId },
        update: { internalId: dto.productId },
      });
      await this.audit.record(tx, ctx, { action: 'integration.listing_mapped', entity: 'marketplace_connection', entityId: connectionId, metadata: { externalItemId: dto.externalItemId, productId: dto.productId } });
      return { ok: true };
    });
  }

  /** Reprocessa pedidos pendentes de atenção (depois de vincular SKU, repor estoque ou definir o depósito). */
  async reprocess(ctx: AuthContext, connectionId: string, ledgerId?: string): Promise<ImportSummary> {
    const rows = await this.prisma.withContext(ctx, (tx) =>
      tx.externalOrder.findMany({ where: { tenantId: ctx.tenantId!, connectionId, status: 'NEEDS_ATTENTION', ...(ledgerId ? { id: ledgerId } : {}) } }),
    );
    if (ledgerId && !rows.length) throw new NotFoundException('Pedido pendente não encontrado.');
    return this.importOrders(ctx.tenantId!, connectionId, rows.map((r) => r.payload as unknown as ExternalOrder));
  }
}
