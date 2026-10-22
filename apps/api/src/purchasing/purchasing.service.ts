import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PurchaseStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/auth';
import { fromCents, toCents } from '../commissions/commissions.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { StockService } from '../stock/stock.service';

type Tx = Prisma.TransactionClient;

export interface PurchaseInput {
  supplierId: string;
  warehouseId: string;
  expectedDate?: string;
  freight?: number;
  notes?: string;
  items: { productId: string; quantity: number; unitCost: number }[];
}

const flat = (v: string) => v.replace(/[^a-z0-9]/gi, '').toLowerCase();

@Injectable()
export class PurchasingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly stock: StockService,
    private readonly settings: SettingsService,
  ) {}

  list(ctx: AuthContext, q: { status?: PurchaseStatus; limit?: number; offset?: number }) {
    return this.prisma.withContext(ctx, async (tx) => {
      const where: Prisma.PurchaseOrderWhereInput = { tenantId: ctx.tenantId!, ...(q.status ? { status: q.status } : {}) };
      const [items, total] = await Promise.all([
        tx.purchaseOrder.findMany({
          where, orderBy: { number: 'desc' }, take: q.limit ?? 50, skip: q.offset ?? 0,
          select: { id: true, number: true, status: true, total: true, expectedDate: true, createdAt: true, supplier: { select: { legalName: true } }, warehouse: { select: { code: true } } },
        }),
        tx.purchaseOrder.count({ where }),
      ]);
      return { total, items };
    });
  }

  get(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const po = await tx.purchaseOrder.findFirst({
        where: { id, tenantId: ctx.tenantId! },
        include: {
          supplier: { select: { legalName: true, tradeName: true } }, warehouse: { select: { code: true, name: true } },
          items: { include: { product: { select: { sku: true, name: true } } }, orderBy: { id: 'asc' } },
          receipts: { include: { items: { include: { product: { select: { sku: true } } } } }, orderBy: { createdAt: 'desc' } },
        },
      });
      if (!po) throw new NotFoundException('Ordem de compra não encontrada.');
      return po;
    });
  }

  create(ctx: AuthContext, dto: PurchaseInput) {
    return this.prisma.withContext(ctx, async (tx) => {
      const data = await this.prepare(tx, ctx, dto);
      const number = await this.settings.nextNumber(tx, ctx, 'purchase_order');
      const po = await tx.purchaseOrder.create({
        data: {
          tenantId: ctx.tenantId!, number, supplierId: dto.supplierId, warehouseId: dto.warehouseId, expectedDate: dto.expectedDate ? new Date(dto.expectedDate) : null,
          freight: data.freight, total: data.total, notes: dto.notes, createdById: ctx.userId,
        },
      });
      await tx.purchaseOrderItem.createMany({ data: data.rows.map((r) => ({ ...r, orderId: po.id })) });
      await this.audit.record(tx, ctx, { action: 'purchase.created', entity: 'purchase_order', entityId: po.id, metadata: { number, total: data.total } });
      return { id: po.id, number };
    });
  }

  update(ctx: AuthContext, id: string, dto: PurchaseInput) {
    return this.prisma.withContext(ctx, async (tx) => {
      const po = await this.lock(tx, ctx, id);
      if (po.status !== 'DRAFT') throw new ConflictException('Somente ordens em rascunho podem ser editadas.');
      const data = await this.prepare(tx, ctx, dto);
      await tx.purchaseOrderItem.deleteMany({ where: { orderId: id, tenantId: ctx.tenantId! } });
      await tx.purchaseOrder.update({
        where: { id },
        data: { supplierId: dto.supplierId, warehouseId: dto.warehouseId, expectedDate: dto.expectedDate ? new Date(dto.expectedDate) : null, freight: data.freight, total: data.total, notes: dto.notes },
      });
      await tx.purchaseOrderItem.createMany({ data: data.rows.map((r) => ({ ...r, orderId: id })) });
      await this.audit.record(tx, ctx, { action: 'purchase.updated', entity: 'purchase_order', entityId: id, metadata: { total: data.total } });
      return { id };
    });
  }

  /** Até o limite configurado a ordem é aprovada automaticamente; acima dele exige alçada (`purchases.approve`). */
  submit(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const po = await this.lock(tx, ctx, id);
      if (po.status !== 'DRAFT') throw new ConflictException(`Operação inválida: a ordem está "${po.status}".`);
      const limit = (await this.settings.load(tx, ctx))['purchases.approvalLimit'];
      const auto = toCents(po.total) <= Math.round(limit * 100);
      const status: PurchaseStatus = auto ? 'APPROVED' : 'PENDING_APPROVAL';
      await tx.purchaseOrder.update({ where: { id }, data: { status } });
      await this.audit.record(tx, ctx, { action: auto ? 'purchase.auto_approved' : 'purchase.approval_requested', entity: 'purchase_order', entityId: id, metadata: { total: po.total.toString(), limit } });
      return { id, status };
    });
  }

  approve(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const po = await this.lock(tx, ctx, id);
      if (po.status !== 'PENDING_APPROVAL') throw new ConflictException(`Operação inválida: a ordem está "${po.status}".`);
      if (po.createdById === ctx.userId && !ctx.permissions.has('tenant.manage')) throw new ForbiddenException('A aprovação deve ser feita por outro usuário.');
      await tx.purchaseOrder.update({ where: { id }, data: { status: 'APPROVED', approvedById: ctx.userId } });
      await this.audit.record(tx, ctx, { action: 'purchase.approved', entity: 'purchase_order', entityId: id });
      return { id, status: 'APPROVED' as const };
    });
  }

  reject(ctx: AuthContext, id: string, reason: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const po = await this.lock(tx, ctx, id);
      if (po.status !== 'PENDING_APPROVAL') throw new ConflictException(`Operação inválida: a ordem está "${po.status}".`);
      await tx.purchaseOrder.update({ where: { id }, data: { status: 'DRAFT', notes: `${po.notes ?? ''}\nRejeitada: ${reason}`.trim() } });
      await this.audit.record(tx, ctx, { action: 'purchase.rejected', entity: 'purchase_order', entityId: id, metadata: { reason } });
      return { id, status: 'DRAFT' as const };
    });
  }

  cancel(ctx: AuthContext, id: string, reason: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const po = await this.lock(tx, ctx, id);
      if (!['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(po.status)) {
        throw new ConflictException('Ordem com recebimentos não pode ser cancelada: estorne os recebimentos ou use "encerrar com saldo pendente".');
      }
      await tx.purchaseOrder.update({ where: { id }, data: { status: 'CANCELLED', notes: `${po.notes ?? ''}\nCancelada: ${reason}`.trim() } });
      await this.audit.record(tx, ctx, { action: 'purchase.cancelled', entity: 'purchase_order', entityId: id, metadata: { reason } });
      return { id, status: 'CANCELLED' as const };
    });
  }

  /** Encerra uma ordem parcialmente recebida aceitando a falta (divergência de quantidade). */
  closeShort(ctx: AuthContext, id: string, reason: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const po = await this.lock(tx, ctx, id);
      if (po.status !== 'PARTIALLY_RECEIVED') throw new ConflictException('Somente ordens parcialmente recebidas podem ser encerradas com saldo pendente.');
      const missing = po.items.map((i) => ({ productId: i.productId, missing: i.qtyOrdered - i.qtyReceived })).filter((m) => m.missing > 0);
      await tx.purchaseOrder.update({ where: { id }, data: { status: 'RECEIVED', notes: `${po.notes ?? ''}\nEncerrada com pendência: ${reason}`.trim() } });
      await this.audit.record(tx, ctx, { action: 'purchase.closed_short', entity: 'purchase_order', entityId: id, metadata: { reason, missing } });
      return { id, status: 'RECEIVED' as const, missing };
    });
  }

  // ───────────── recebimento ─────────────

  async receive(ctx: AuthContext, id: string, dto: { note?: string; idempotencyKey?: string; items: { productId: string; quantity: number; unitCost?: number; note?: string; lotCode?: string; expiresAt?: string; locationCode?: string }[] }) {
    const run = () => this.prisma.withContext(ctx, (tx) => this.receiveTx(tx, ctx, id, dto));
    try {
      return await run();
    } catch (e) {
      if (dto.idempotencyKey && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && (!e.meta?.target || flat(JSON.stringify(e.meta.target)).includes('idempotencykey'))) return run();
      throw e;
    }
  }

  private async receiveTx(tx: Tx, ctx: AuthContext, id: string, dto: { note?: string; idempotencyKey?: string; items: { productId: string; quantity: number; unitCost?: number; note?: string; lotCode?: string; expiresAt?: string; locationCode?: string }[] }) {
    const po = await this.lock(tx, ctx, id);
    // Relido após o lock da ordem: uma requisição concorrente com a mesma chave já pode ter confirmado.
    if (dto.idempotencyKey) {
      const existing = await tx.goodsReceipt.findUnique({ where: { tenantId_idempotencyKey: { tenantId: ctx.tenantId!, idempotencyKey: dto.idempotencyKey } }, include: { items: true } });
      if (existing) return { replayed: true, receipt: existing };
    }
    if (po.status !== 'APPROVED' && po.status !== 'PARTIALLY_RECEIVED') throw new ConflictException(`A ordem está "${po.status}" e não aceita recebimento.`);
    if (!dto.items.length) throw new BadRequestException('Informe ao menos um item recebido.');
    if (new Set(dto.items.map((i) => i.productId)).size !== dto.items.length) throw new BadRequestException('Produto repetido no recebimento.');

    const receipt = await tx.goodsReceipt.create({ data: { tenantId: ctx.tenantId!, purchaseId: id, note: dto.note, idempotencyKey: dto.idempotencyKey, createdById: ctx.userId } });
    for (const it of dto.items) {
      const line = po.items.find((x) => x.productId === it.productId);
      if (!line) throw new BadRequestException('Produto não consta na ordem de compra.');
      const pending = line.qtyOrdered - line.qtyReceived;
      if (it.quantity > pending) {
        throw new ConflictException(`Divergência no item recebido — quantidade informada ${it.quantity}, pendente na ordem ${pending}. Ajuste a quantidade ou altere a ordem.`);
      }
      const cost = it.unitCost ?? Number(line.unitCost);
      // Custo médio ponderado: considera o saldo físico total antes da entrada.
      const [bal] = await tx.$queryRaw<{ oh: number | null }[]>`SELECT sum(on_hand)::int AS oh FROM stock_balances WHERE tenant_id = ${ctx.tenantId}::uuid AND product_id = ${it.productId}::uuid`;
      const product = await tx.product.findUniqueOrThrow({ where: { id: it.productId }, select: { costPrice: true } });
      const oldOnHand = bal?.oh ?? 0;
      const oldCost = product.costPrice ? Number(product.costPrice) : null;
      const newCost = oldCost !== null && oldOnHand > 0 ? (oldOnHand * oldCost + it.quantity * cost) / (oldOnHand + it.quantity) : cost;

      const mv = await this.stock.applyMovement(tx, ctx, {
        productId: it.productId, warehouseId: po.warehouseId, type: 'PURCHASE_ENTRY', quantity: it.quantity,
        reason: `Recebimento da OC ${po.number}`, reference: `compra:${po.number}`, idempotencyKey: `receipt:${receipt.id}:${it.productId}`,
        lotCode: it.lotCode, expiresAt: it.expiresAt, locationCode: it.locationCode,
      });
      await tx.goodsReceiptItem.create({ data: { tenantId: ctx.tenantId!, receiptId: receipt.id, productId: it.productId, quantity: it.quantity, unitCost: cost, movementId: mv.id, note: it.note } });
      await tx.purchaseOrderItem.update({ where: { id: line.id }, data: { qtyReceived: { increment: it.quantity } } });
      await tx.product.update({ where: { id: it.productId }, data: { costPrice: newCost.toFixed(4) } });
      await tx.$executeRaw`UPDATE product_suppliers SET last_price = ${cost.toFixed(4)}::numeric WHERE tenant_id = ${ctx.tenantId}::uuid AND product_id = ${it.productId}::uuid AND supplier_id = ${po.supplierId}::uuid`;
    }
    await this.refreshStatus(tx, ctx, id);
    await this.audit.record(tx, ctx, { action: 'purchase.received', entity: 'purchase_order', entityId: id, metadata: { receiptId: receipt.id, items: dto.items.length } });
    return { replayed: false, receipt: await tx.goodsReceipt.findUniqueOrThrow({ where: { id: receipt.id }, include: { items: true } }) };
  }

  /** Estorna o recebimento inteiro: movimentos inversos no razão e quantidades recebidas revertidas. */
  reverseReceipt(ctx: AuthContext, receiptId: string, reason: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const found = await tx.goodsReceipt.findFirst({ where: { id: receiptId, tenantId: ctx.tenantId! }, select: { purchaseId: true } });
      if (!found) throw new NotFoundException('Recebimento não encontrado.');
      const po = await this.lock(tx, ctx, found.purchaseId);
      const receipt = await tx.goodsReceipt.findFirstOrThrow({ where: { id: receiptId, tenantId: ctx.tenantId! }, include: { items: true } });
      if (receipt.status !== 'POSTED') throw new ConflictException('Este recebimento já foi estornado.');
      for (const it of receipt.items) {
        await this.stock.applyMovement(tx, ctx, {
          productId: it.productId, warehouseId: po.warehouseId, type: 'REVERSAL', quantity: -it.quantity,
          reason: `Estorno do recebimento: ${reason}`, reversalOfId: it.movementId ?? undefined, reference: `compra:${po.number}`,
        });
        await tx.purchaseOrderItem.updateMany({ where: { orderId: po.id, productId: it.productId, tenantId: ctx.tenantId! }, data: { qtyReceived: { decrement: it.quantity } } });
      }
      await tx.fiscalDocument.updateMany({ where: { tenantId: ctx.tenantId!, receiptId, status: 'RECEIVED' }, data: { status: 'IMPORTED', receiptId: null } });
      await tx.goodsReceipt.update({ where: { id: receiptId }, data: { status: 'REVERSED', note: `${receipt.note ?? ''}\nEstornado: ${reason}`.trim() } });
      await this.refreshStatus(tx, ctx, po.id);
      await this.audit.record(tx, ctx, { action: 'purchase.receipt_reversed', entity: 'goods_receipt', entityId: receiptId, metadata: { reason } });
      return { id: receiptId, status: 'REVERSED' as const };
    });
  }

  /** Sugestões de reposição com justificativa. Nada é comprado automaticamente. */
  suggestions(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string; sku: string; name: string; min_stock: number; max_stock: number | null; reorder_point: number | null; lead: number | null; avail: number; pending: number; sold30: number; supplier: string | null }[]
      >`
        SELECT p.id, p.sku, p.name, p.min_stock, p.max_stock, p.reorder_point, p.lead_time_days AS lead,
          COALESCE(b.av, 0)::int AS avail,
          COALESCE((SELECT sum(i.qty_ordered - i.qty_received) FROM purchase_order_items i JOIN purchase_orders o ON o.id = i.order_id
                    WHERE i.product_id = p.id AND o.status IN ('PENDING_APPROVAL','APPROVED','PARTIALLY_RECEIVED')), 0)::int AS pending,
          COALESCE((SELECT -sum(m.quantity) FROM stock_movements m WHERE m.product_id = p.id AND m.type = 'SALE_EXIT' AND m.created_at > now() - interval '30 days'), 0)::int AS sold30,
          (SELECT s.legal_name FROM product_suppliers ps JOIN suppliers s ON s.id = ps.supplier_id WHERE ps.product_id = p.id ORDER BY ps.is_main DESC LIMIT 1) AS supplier
        FROM products p
        LEFT JOIN (SELECT product_id, sum(on_hand - reserved - blocked) av FROM stock_balances GROUP BY product_id) b ON b.product_id = p.id
        WHERE p.tenant_id = ${ctx.tenantId}::uuid AND p.active AND p.kind = 'PHYSICAL'`;
      return rows
        .map((r) => {
          const daily = r.sold30 / 30;
          const lead = r.lead ?? 0;
          const trigger = r.reorder_point ?? r.min_stock;
          const position = r.avail + r.pending;
          const target = r.max_stock ?? Math.ceil(r.min_stock + daily * lead);
          const qty = Math.max(0, target - position);
          const reason = `Posição ${position} (disponível ${r.avail} + em compra ${r.pending}) ${position <= trigger ? 'abaixo ou igual ao' : 'acima do'} ponto de reposição ${trigger}; consumo médio ${daily.toFixed(2)}/dia (últimos 30 dias), prazo ${lead} dia(s); alvo ${target}.`;
          return { productId: r.id, sku: r.sku, name: r.name, supplier: r.supplier, available: r.avail, onOrder: r.pending, suggestedQty: position <= trigger && trigger > 0 ? qty : 0, reason };
        })
        .filter((s) => s.suggestedQty > 0);
    });
  }

  // ───────────── internos ─────────────

  private async refreshStatus(tx: Tx, ctx: AuthContext, id: string) {
    const items = await tx.purchaseOrderItem.findMany({ where: { orderId: id, tenantId: ctx.tenantId! } });
    const all = items.every((i) => i.qtyReceived >= i.qtyOrdered);
    const any = items.some((i) => i.qtyReceived > 0);
    const status: PurchaseStatus = all ? 'RECEIVED' : any ? 'PARTIALLY_RECEIVED' : 'APPROVED';
    await tx.purchaseOrder.update({ where: { id }, data: { status } });
  }

  private async lock(tx: Tx, ctx: AuthContext, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM purchase_orders WHERE id = ${id}::uuid AND tenant_id = ${ctx.tenantId}::uuid FOR UPDATE`;
    if (!rows.length) throw new NotFoundException('Ordem de compra não encontrada.');
    return tx.purchaseOrder.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId! }, include: { items: true } });
  }

  private async prepare(tx: Tx, ctx: AuthContext, dto: PurchaseInput) {
    const [supplier, wh] = await Promise.all([
      tx.supplier.findFirst({ where: { id: dto.supplierId, tenantId: ctx.tenantId!, active: true } }),
      tx.warehouse.findFirst({ where: { id: dto.warehouseId, tenantId: ctx.tenantId!, active: true } }),
    ]);
    if (!supplier) throw new BadRequestException('Fornecedor inválido ou inativo.');
    if (!wh) throw new BadRequestException('Depósito inválido ou inativo.');
    if (!dto.items.length) throw new BadRequestException('Inclua ao menos um item.');
    if (new Set(dto.items.map((i) => i.productId)).size !== dto.items.length) throw new BadRequestException('Produto repetido: some as quantidades em uma linha.');
    const products = await tx.product.findMany({ where: { tenantId: ctx.tenantId!, id: { in: dto.items.map((i) => i.productId) }, active: true, kind: 'PHYSICAL' }, select: { id: true } });
    if (products.length !== dto.items.length) throw new BadRequestException('Produto inválido, inativo ou não físico.');
    let sum = 0;
    const rows = dto.items.map((i) => {
      sum += Math.round(i.unitCost * 10000) * i.quantity;
      return { tenantId: ctx.tenantId!, productId: i.productId, qtyOrdered: i.quantity, unitCost: i.unitCost.toFixed(4) };
    });
    const freightCents = Math.round((dto.freight ?? 0) * 100);
    return { rows, freight: fromCents(freightCents), total: fromCents(Math.round(sum / 100) + freightCents) };
  }
}
