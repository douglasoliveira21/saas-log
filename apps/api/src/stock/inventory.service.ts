import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';
import { StockService } from './stock.service';

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stock: StockService,
    private readonly audit: AuditService,
  ) {}

  /** Abre uma contagem com o retrato dos saldos do depósito (ou só dos produtos informados). */
  create(ctx: AuthContext, dto: { warehouseId: string; name: string; productIds?: string[] }) {
    return this.prisma.withContext(ctx, async (tx) => {
      const wh = await tx.warehouse.findFirst({ where: { id: dto.warehouseId, tenantId: ctx.tenantId!, active: true } });
      if (!wh) throw new NotFoundException('Depósito não encontrado.');
      const count = await tx.inventoryCount.create({
        data: { tenantId: ctx.tenantId!, warehouseId: dto.warehouseId, name: dto.name.trim(), createdById: ctx.userId },
      });
      const balances = await tx.stockBalance.findMany({
        where: { tenantId: ctx.tenantId!, warehouseId: dto.warehouseId, ...(dto.productIds ? { productId: { in: dto.productIds } } : {}) },
      });
      const known = new Map(balances.map((b) => [b.productId, b.onHand]));
      if (dto.productIds) {
        const valid = await tx.product.findMany({ where: { tenantId: ctx.tenantId!, id: { in: dto.productIds }, kind: 'PHYSICAL' }, select: { id: true } });
        for (const p of valid) if (!known.has(p.id)) known.set(p.id, 0);
      }
      if (known.size)
        await tx.inventoryCountItem.createMany({
          data: [...known].map(([productId, systemQty]) => ({ tenantId: ctx.tenantId!, countId: count.id, productId, systemQty })),
        });
      await this.audit.record(tx, ctx, { action: 'inventory.opened', entity: 'inventory_count', entityId: count.id, metadata: { items: known.size } });
      return { id: count.id, items: known.size };
    });
  }

  list(ctx: AuthContext) {
    return this.prisma.withContext(ctx, (tx) =>
      tx.inventoryCount.findMany({
        where: { tenantId: ctx.tenantId! },
        include: { warehouse: { select: { code: true, name: true } }, _count: { select: { items: true } } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    );
  }

  /** Relatório de divergências: contado − sistema. */
  detail(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const count = await tx.inventoryCount.findFirst({
        where: { id, tenantId: ctx.tenantId! },
        include: { warehouse: { select: { code: true, name: true } }, items: { include: { product: { select: { sku: true, name: true, barcode: true } } } } },
      });
      if (!count) throw new NotFoundException('Inventário não encontrado.');
      return {
        ...count,
        items: count.items
          .map((i) => ({ ...i, divergence: i.countedQty === null ? null : i.countedQty - i.systemQty }))
          .sort((a, b) => a.product.sku.localeCompare(b.product.sku)),
      };
    });
  }

  /** Lança contagens por produto ou por código de barras/SKU (leitor de código de barras envia o texto lido). */
  enterCounts(ctx: AuthContext, id: string, entries: { productId?: string; code?: string; countedQty: number }[]) {
    return this.prisma.withContext(ctx, async (tx) => {
      const count = await this.openCount(tx, ctx, id, 'OPEN');
      let updated = 0;
      for (const e of entries) {
        const product = await tx.product.findFirst({
          where: { tenantId: ctx.tenantId!, kind: 'PHYSICAL', ...(e.productId ? { id: e.productId } : { OR: [{ barcode: e.code }, { sku: e.code }] }) },
          select: { id: true },
        });
        if (!product) throw new BadRequestException(`Produto não encontrado: ${e.productId ?? e.code}`);
        const item = await tx.inventoryCountItem.findUnique({ where: { countId_productId: { countId: count.id, productId: product.id } } });
        if (item) {
          await tx.inventoryCountItem.update({ where: { countId_productId: { countId: count.id, productId: product.id } }, data: { countedQty: e.countedQty } });
        } else {
          const bal = await tx.stockBalance.findUnique({ where: { productId_warehouseId: { productId: product.id, warehouseId: count.warehouseId } } });
          await tx.inventoryCountItem.create({
            data: { tenantId: ctx.tenantId!, countId: count.id, productId: product.id, systemQty: bal?.onHand ?? 0, countedQty: e.countedQty },
          });
        }
        updated++;
      }
      return { updated };
    });
  }

  submit(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      await this.openCount(tx, ctx, id, 'OPEN');
      const counted = await tx.inventoryCountItem.count({ where: { countId: id, tenantId: ctx.tenantId!, countedQty: { not: null } } });
      if (!counted) throw new BadRequestException('Lance ao menos uma contagem antes de enviar para aprovação.');
      await tx.inventoryCount.update({ where: { id }, data: { status: 'SUBMITTED', submittedAt: new Date() } });
      await this.audit.record(tx, ctx, { action: 'inventory.submitted', entity: 'inventory_count', entityId: id });
      return { id, status: 'SUBMITTED' };
    });
  }

  reject(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      await this.openCount(tx, ctx, id, 'SUBMITTED');
      await tx.inventoryCount.update({ where: { id }, data: { status: 'REJECTED', resolvedAt: new Date(), resolvedById: ctx.userId } });
      await this.audit.record(tx, ctx, { action: 'inventory.rejected', entity: 'inventory_count', entityId: id });
      return { id, status: 'REJECTED' };
    });
  }

  /**
   * Aprova e gera um ADJUSTMENT por divergência (contado − saldo atual), tudo na mesma transação:
   * se algum ajuste violar reservas/bloqueios, nada é aplicado.
   */
  approve(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const count = await this.openCount(tx, ctx, id, 'SUBMITTED');
      const items = await tx.inventoryCountItem.findMany({ where: { countId: id, tenantId: ctx.tenantId!, countedQty: { not: null } } });
      let adjusted = 0;
      for (const item of items.sort((a, b) => a.productId.localeCompare(b.productId))) {
        await this.stock.ensureBalance(tx, ctx, item.productId, count.warehouseId);
        const [bal] = await tx.$queryRaw<{ on_hand: number }[]>`SELECT on_hand FROM stock_balances
          WHERE tenant_id = ${ctx.tenantId}::uuid AND product_id = ${item.productId}::uuid AND warehouse_id = ${count.warehouseId}::uuid FOR UPDATE`;
        const delta = item.countedQty! - bal.on_hand;
        if (delta === 0) continue;
        await this.stock.applyMovement(tx, ctx, {
          productId: item.productId, warehouseId: count.warehouseId, type: 'ADJUSTMENT', quantity: delta,
          reason: `Inventário: ${count.name}`, reference: `inventario:${id}`, idempotencyKey: `count:${id}:${item.productId}`,
        }).catch((e) => {
          if (e instanceof ConflictException) throw new ConflictException('A contagem conflita com reservas/bloqueios ativos. Libere-os e tente novamente.');
          throw e;
        });
        adjusted++;
      }
      await tx.inventoryCount.update({ where: { id }, data: { status: 'APPROVED', resolvedAt: new Date(), resolvedById: ctx.userId } });
      await this.audit.record(tx, ctx, { action: 'inventory.approved', entity: 'inventory_count', entityId: id, metadata: { adjusted } });
      return { id, status: 'APPROVED', adjusted };
    });
  }

  private async openCount(tx: Parameters<Parameters<PrismaService['withContext']>[1]>[0], ctx: AuthContext, id: string, expected: 'OPEN' | 'SUBMITTED') {
    // updateMany não retorna a linha; travamos a linha para impedir aprovação dupla concorrente.
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM inventory_counts WHERE id = ${id}::uuid AND tenant_id = ${ctx.tenantId}::uuid FOR UPDATE`;
    if (!rows.length) throw new NotFoundException('Inventário não encontrado.');
    const count = await tx.inventoryCount.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId! } });
    if (count.status !== expected) throw new ConflictException(`Operação inválida: o inventário está "${count.status}".`);
    return count;
  }
}
