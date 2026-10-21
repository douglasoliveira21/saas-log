import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { MovementType, Prisma, StockMovement } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';

type Tx = Prisma.TransactionClient;

export interface MovementInput {
  productId: string;
  warehouseId: string;
  type: MovementType;
  quantity: number; // com sinal
  reason?: string;
  reference?: string;
  idempotencyKey?: string;
  reversalOfId?: string;
  transferId?: string;
}

/** Tipos que exigem a permissão crítica stock.adjust (perdas, avarias e ajustes). */
const CRITICAL_TYPES: MovementType[] = ['ADJUSTMENT', 'LOSS', 'DAMAGE'];
const EXIT_TYPES: MovementType[] = ['SALE_EXIT', 'INTERNAL_USE', 'LOSS', 'DAMAGE'];

const flat = (v: string) => v.replace(/[^a-z0-9]/gi, '').toLowerCase();
const isUniqueViolation = (e: unknown, field?: string) =>
  e instanceof Prisma.PrismaClientKnownRequestError &&
  e.code === 'P2002' &&
  (!field || !e.meta?.target || flat(JSON.stringify(e.meta.target)).includes(flat(field))); // com transações interativas o Prisma pode omitir o alvo

/**
 * Regra central de disponibilidade (documentada em docs/INVENTORY.md):
 *   disponível = físico − reservado − bloqueado
 * Quantidade de segurança, teto anunciado e reservas por canal são regras de canal (Fase 4).
 */
export const available = (b: { onHand: number; reserved: number; blocked: number }) => b.onHand - b.reserved - b.blocked;

@Injectable()
export class StockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ───────────── movimentos ─────────────

  /** Entrada/saída/ajuste simples. `quantity` positiva exceto ADJUSTMENT (com sinal). */
  async move(
    ctx: AuthContext,
    dto: { productId: string; warehouseId: string; type: MovementType; quantity: number; reason?: string; reference?: string; idempotencyKey?: string },
  ) {
    if (dto.type === 'TRANSFER_IN' || dto.type === 'TRANSFER_OUT' || dto.type === 'REVERSAL') {
      throw new BadRequestException('Use os endpoints de transferência e estorno.');
    }
    if (CRITICAL_TYPES.includes(dto.type) && !ctx.permissions.has('stock.adjust')) {
      throw new ForbiddenException('Você não tem permissão para esta ação.');
    }
    if (CRITICAL_TYPES.includes(dto.type) && !dto.reason?.trim()) throw new BadRequestException('Informe o motivo.');
    if (dto.quantity === 0) throw new BadRequestException('A quantidade não pode ser zero.');
    let qty = dto.quantity;
    if (dto.type !== 'ADJUSTMENT') {
      if (qty < 0) throw new BadRequestException('Informe a quantidade como número positivo.');
      if (EXIT_TYPES.includes(dto.type)) qty = -qty;
    }
    return this.idempotent(ctx, dto.idempotencyKey, async (tx) => ({
      movement: await this.applyMovement(tx, ctx, { ...dto, quantity: qty }),
    }));
  }

  /**
   * "Editar estoque": leva o saldo FÍSICO de um produto em um depósito a uma quantidade informada.
   * Não sobrescreve nada: registra um ajuste (ADJUSTMENT) com a diferença, motivo e histórico, calculado sob trava do saldo
   * (movimentos simultâneos não distorcem o resultado). Não desce abaixo de reservado + bloqueado.
   */
  async setOnHand(ctx: AuthContext, dto: { productId: string; warehouseId: string; newOnHand: number; reason: string; idempotencyKey?: string }) {
    if (!ctx.permissions.has('stock.adjust')) throw new ForbiddenException('Você não tem permissão para esta ação.');
    if (!dto.reason?.trim()) throw new BadRequestException('Informe o motivo.');
    return this.idempotent(ctx, dto.idempotencyKey, async (tx) => {
      await this.assertProductAndWarehouse(tx, ctx, dto.productId, dto.warehouseId);
      await this.lockBalances(tx, ctx, dto.productId, [dto.warehouseId]);
      const cur = await tx.stockBalance.findFirstOrThrow({ where: { tenantId: ctx.tenantId!, productId: dto.productId, warehouseId: dto.warehouseId } });
      const delta = dto.newOnHand - cur.onHand;
      if (delta === 0) throw new BadRequestException('A quantidade informada é igual ao saldo atual.');
      if (dto.newOnHand < cur.reserved + cur.blocked) {
        throw new ConflictException(`Não é possível ficar com ${dto.newOnHand}: há ${cur.reserved} reservado(s) e ${cur.blocked} bloqueado(s). Libere as reservas/bloqueios antes.`);
      }
      const movement = await this.applyMovement(tx, ctx, { productId: dto.productId, warehouseId: dto.warehouseId, type: 'ADJUSTMENT', quantity: delta, reason: dto.reason.trim(), idempotencyKey: dto.idempotencyKey });
      await this.audit.record(tx, ctx, { action: 'stock.set_on_hand', entity: 'product', entityId: dto.productId, metadata: { warehouseId: dto.warehouseId, from: cur.onHand, to: dto.newOnHand, delta, reason: dto.reason.trim() } });
      return { movement, from: cur.onHand, to: dto.newOnHand, delta };
    });
  }

  async transfer(
    ctx: AuthContext,
    dto: { productId: string; fromWarehouseId: string; toWarehouseId: string; quantity: number; reason?: string; idempotencyKey?: string },
  ) {
    if (dto.fromWarehouseId === dto.toWarehouseId) throw new BadRequestException('Origem e destino devem ser diferentes.');
    const key = dto.idempotencyKey;
    return this.idempotent(ctx, key ? `${key}:out` : undefined, async (tx) => {
      await this.lockBalances(tx, ctx, dto.productId, [dto.fromWarehouseId, dto.toWarehouseId]);
      const transferId = randomUUID();
      const out = await this.applyMovement(tx, ctx, {
        productId: dto.productId, warehouseId: dto.fromWarehouseId, type: 'TRANSFER_OUT', quantity: -dto.quantity,
        reason: dto.reason, idempotencyKey: key ? `${key}:out` : undefined, transferId,
      });
      const inn = await this.applyMovement(tx, ctx, {
        productId: dto.productId, warehouseId: dto.toWarehouseId, type: 'TRANSFER_IN', quantity: dto.quantity,
        reason: dto.reason, idempotencyKey: key ? `${key}:in` : undefined, transferId,
      });
      return { transferId, out, in: inn };
    });
  }

  async reverse(ctx: AuthContext, movementId: string, reason: string) {
    return this.prisma
      .withContext(ctx, async (tx) => {
        const orig = await tx.stockMovement.findFirst({ where: { id: movementId, tenantId: ctx.tenantId! } });
        if (!orig) throw new NotFoundException('Movimento não encontrado.');
        if (orig.type === 'REVERSAL' || orig.type === 'TRANSFER_IN' || orig.type === 'TRANSFER_OUT') {
          throw new BadRequestException('Este movimento não pode ser estornado (para transferências, faça a transferência inversa).');
        }
        const rev = await this.applyMovement(tx, ctx, {
          productId: orig.productId, warehouseId: orig.warehouseId, type: 'REVERSAL', quantity: -orig.quantity,
          reason, reversalOfId: orig.id, reference: orig.id,
        });
        await this.audit.record(tx, ctx, { action: 'stock.reversed', entity: 'stock_movement', entityId: orig.id, metadata: { reason } });
        return rev;
      })
      .catch((e) => {
        if (isUniqueViolation(e, 'reversal_of_id')) throw new ConflictException('Este movimento já foi estornado.');
        throw e;
      });
  }

  /** Bloqueio/desbloqueio (qty com sinal): reduz/aumenta o disponível sem alterar o físico. */
  async block(ctx: AuthContext, dto: { productId: string; warehouseId: string; quantity: number; reason: string }) {
    return this.prisma.withContext(ctx, async (tx) => {
      await this.assertProductAndWarehouse(tx, ctx, dto.productId, dto.warehouseId);
      await this.ensureBalance(tx, ctx, dto.productId, dto.warehouseId);
      const rows = await tx.$queryRaw<{ blocked: number }[]>`
        UPDATE stock_balances SET blocked = blocked + ${dto.quantity}, updated_at = now()
        WHERE tenant_id = ${ctx.tenantId}::uuid AND product_id = ${dto.productId}::uuid AND warehouse_id = ${dto.warehouseId}::uuid
          AND blocked + ${dto.quantity} >= 0 AND on_hand - reserved - blocked - ${dto.quantity} >= 0
        RETURNING blocked`;
      if (!rows.length) throw new ConflictException('Quantidade indisponível para bloquear (ou desbloqueio maior que o bloqueado).');
      await this.audit.record(tx, ctx, { action: dto.quantity > 0 ? 'stock.blocked' : 'stock.unblocked', entity: 'product', entityId: dto.productId, metadata: { ...dto } });
      return { blocked: rows[0].blocked };
    });
  }

  // ───────────── reservas ─────────────

  async reserve(ctx: AuthContext, dto: { productId: string; warehouseId: string; quantity: number; reference?: string; idempotencyKey: string }) {
    const run = () => this.prisma.withContext(ctx, (tx) => this.reserveTx(tx, ctx, dto));
    try {
      return await run();
    } catch (e) {
      if (isUniqueViolation(e, 'idempotency_key')) return run(); // corrida entre duas requisições iguais: a segunda vira replay
      throw e;
    }
  }

  /** Reserva dentro da transação do chamador (usado pela confirmação de pedidos). */
  async reserveTx(tx: Tx, ctx: AuthContext, dto: { productId: string; warehouseId: string; quantity: number; reference?: string; idempotencyKey: string }) {
    const existing = await tx.stockReservation.findUnique({ where: { tenantId_idempotencyKey: { tenantId: ctx.tenantId!, idempotencyKey: dto.idempotencyKey } } });
    if (existing) return { reservation: existing, replayed: true };
    await this.assertProductAndWarehouse(tx, ctx, dto.productId, dto.warehouseId);
    await this.ensureBalance(tx, ctx, dto.productId, dto.warehouseId);
    const rows = await tx.$queryRaw<unknown[]>`
      UPDATE stock_balances SET reserved = reserved + ${dto.quantity}, updated_at = now()
      WHERE tenant_id = ${ctx.tenantId}::uuid AND product_id = ${dto.productId}::uuid AND warehouse_id = ${dto.warehouseId}::uuid
        AND on_hand - reserved - blocked >= ${dto.quantity}
      RETURNING reserved`;
    if (!rows.length) throw new ConflictException('Estoque disponível insuficiente para reservar.');
    const reservation = await tx.stockReservation.create({
      data: { tenantId: ctx.tenantId!, productId: dto.productId, warehouseId: dto.warehouseId, quantity: dto.quantity, reference: dto.reference, idempotencyKey: dto.idempotencyKey, createdById: ctx.userId },
    });
    return { reservation, replayed: false };
  }

  async release(ctx: AuthContext, id: string) {
    return this.resolveReservation(ctx, id, 'RELEASED');
  }

  /** Efetiva a venda: baixa o físico e libera a reserva, gerando SALE_EXIT no razão. */
  async consume(ctx: AuthContext, id: string) {
    return this.resolveReservation(ctx, id, 'CONSUMED');
  }

  private resolveReservation(ctx: AuthContext, id: string, target: 'RELEASED' | 'CONSUMED') {
    return this.prisma.withContext(ctx, (tx) => this.resolveReservationTx(tx, ctx, id, target));
  }

  async resolveReservationTx(tx: Tx, ctx: AuthContext, id: string, target: 'RELEASED' | 'CONSUMED') {
    {
      const r = await tx.stockReservation.findFirst({ where: { id, tenantId: ctx.tenantId! } });
      if (!r) throw new NotFoundException('Reserva não encontrada.');
      if (r.status === target) return { reservation: r, replayed: true };
      const claimed = await tx.stockReservation.updateMany({
        where: { id, tenantId: ctx.tenantId!, status: 'ACTIVE' },
        data: { status: target, resolvedAt: new Date() },
      });
      if (claimed.count === 0) throw new ConflictException(`A reserva já está ${r.status === 'RELEASED' ? 'liberada' : 'consumida'}.`);
      if (target === 'RELEASED') {
        await tx.$executeRaw`UPDATE stock_balances SET reserved = reserved - ${r.quantity}, updated_at = now()
          WHERE tenant_id = ${ctx.tenantId}::uuid AND product_id = ${r.productId}::uuid AND warehouse_id = ${r.warehouseId}::uuid`;
      } else {
        const rows = await tx.$queryRaw<unknown[]>`UPDATE stock_balances SET reserved = reserved - ${r.quantity}, on_hand = on_hand - ${r.quantity}, updated_at = now()
          WHERE tenant_id = ${ctx.tenantId}::uuid AND product_id = ${r.productId}::uuid AND warehouse_id = ${r.warehouseId}::uuid
          RETURNING on_hand`;
        const after = (rows[0] as { on_hand: number }).on_hand;
        await tx.stockMovement.create({
          data: {
            tenantId: ctx.tenantId!, productId: r.productId, warehouseId: r.warehouseId, type: 'SALE_EXIT', quantity: -r.quantity,
            balanceBefore: after + r.quantity, balanceAfter: after, reference: `reserva:${r.id}`, idempotencyKey: `consume:${r.id}`, createdById: ctx.userId,
          },
        });
      }
      return { reservation: { ...r, status: target }, replayed: false };
    }
  }

  // ───────────── núcleo ─────────────

  /** Aplica um movimento dentro da transação do chamador. Falha com 409 se o disponível ficaria negativo. */
  async applyMovement(tx: Tx, ctx: AuthContext, m: MovementInput): Promise<StockMovement> {
    await this.assertProductAndWarehouse(tx, ctx, m.productId, m.warehouseId);
    await this.ensureBalance(tx, ctx, m.productId, m.warehouseId);
    // UPDATE atômico: a linha fica travada até o fim da transação e a condição é reavaliada após o lock,
    // então duas saídas concorrentes nunca levam o disponível abaixo de zero.
    const rows = await tx.$queryRaw<{ on_hand: number }[]>`
      UPDATE stock_balances SET on_hand = on_hand + ${m.quantity}, updated_at = now()
      WHERE tenant_id = ${ctx.tenantId}::uuid AND product_id = ${m.productId}::uuid AND warehouse_id = ${m.warehouseId}::uuid
        AND on_hand + ${m.quantity} - reserved - blocked >= 0
      RETURNING on_hand`;
    if (!rows.length) throw new ConflictException('Estoque disponível insuficiente para esta operação.');
    const after = rows[0].on_hand;
    return tx.stockMovement.create({
      data: {
        tenantId: ctx.tenantId!, productId: m.productId, warehouseId: m.warehouseId, type: m.type, quantity: m.quantity,
        balanceBefore: after - m.quantity, balanceAfter: after, reason: m.reason, reference: m.reference,
        idempotencyKey: m.idempotencyKey, reversalOfId: m.reversalOfId, transferId: m.transferId, createdById: ctx.userId,
      },
    });
  }

  /** Executa `fn` numa transação com idempotência por chave; a repetição devolve o resultado original. */
  private async idempotent<T extends object>(ctx: AuthContext, key: string | undefined, fn: (tx: Tx) => Promise<T>) {
    const run = () =>
      this.prisma.withContext(ctx, async (tx) => {
        if (key) {
          const existing = await tx.stockMovement.findUnique({ where: { tenantId_idempotencyKey: { tenantId: ctx.tenantId!, idempotencyKey: key } } });
          if (existing) return { replayed: true as const, movement: existing };
        }
        return { replayed: false as const, ...(await fn(tx)) };
      });
    try {
      return await run();
    } catch (e) {
      if (key && isUniqueViolation(e, 'idempotency_key')) return run();
      throw e;
    }
  }

  async ensureBalance(tx: Tx, ctx: AuthContext, productId: string, warehouseId: string) {
    await tx.$executeRaw`INSERT INTO stock_balances (tenant_id, product_id, warehouse_id)
      VALUES (${ctx.tenantId}::uuid, ${productId}::uuid, ${warehouseId}::uuid) ON CONFLICT DO NOTHING`;
  }

  /** Trava linhas em ordem determinística para evitar deadlock entre transferências opostas. */
  private async lockBalances(tx: Tx, ctx: AuthContext, productId: string, warehouseIds: string[]) {
    for (const w of warehouseIds) await this.ensureBalance(tx, ctx, productId, w);
    await tx.$queryRaw`SELECT 1 FROM stock_balances WHERE tenant_id = ${ctx.tenantId}::uuid AND product_id = ${productId}::uuid
      AND warehouse_id = ANY(${warehouseIds}::uuid[]) ORDER BY warehouse_id FOR UPDATE`;
  }

  private async assertProductAndWarehouse(tx: Tx, ctx: AuthContext, productId: string, warehouseId: string) {
    const [p, w] = await Promise.all([
      tx.product.findFirst({ where: { id: productId, tenantId: ctx.tenantId! }, select: { active: true, kind: true } }),
      tx.warehouse.findFirst({ where: { id: warehouseId, tenantId: ctx.tenantId! }, select: { active: true } }),
    ]);
    if (!p) throw new NotFoundException('Produto não encontrado.');
    if (!w) throw new NotFoundException('Depósito não encontrado.');
    if (!p.active) throw new BadRequestException('Produto inativo.');
    if (!w.active) throw new BadRequestException('Depósito inativo.');
    if (p.kind !== 'PHYSICAL') throw new BadRequestException('Somente produtos físicos possuem estoque próprio (kits: Fase 3).');
  }

  // ───────────── consultas ─────────────

  /** Visão por produto com totais e disponibilidade calculada (filtros: busca, abaixo do mínimo, zerados). */
  async overview(ctx: AuthContext, q: { search?: string; status?: 'below_min' | 'out'; limit?: number; offset?: number }) {
    const like = q.search ? `%${q.search.replace(/[%_\\]/g, '\\$&')}%` : null;
    const rows = await this.prisma.withContext(ctx, (tx) =>
      tx.$queryRaw<{ id: string; sku: string; name: string; min_stock: number; on_hand: number; reserved: number; blocked: number; cost: string | null }[]>`
        SELECT p.id, p.sku, p.name, p.min_stock, p.cost_price AS cost,
               COALESCE(b.on_hand, 0)::int AS on_hand, COALESCE(b.reserved, 0)::int AS reserved, COALESCE(b.blocked, 0)::int AS blocked
        FROM products p
        LEFT JOIN (SELECT product_id, sum(on_hand) on_hand, sum(reserved) reserved, sum(blocked) blocked
                   FROM stock_balances GROUP BY product_id) b ON b.product_id = p.id
        WHERE p.tenant_id = ${ctx.tenantId}::uuid AND p.active AND p.kind = 'PHYSICAL'
          AND (${like}::text IS NULL OR p.sku ILIKE ${like} OR p.name ILIKE ${like} OR p.barcode ILIKE ${like})
          AND (${q.status ?? null}::text IS NULL
               OR (${q.status ?? null} = 'out' AND COALESCE(b.on_hand - b.reserved - b.blocked, 0) <= 0)
               OR (${q.status ?? null} = 'below_min' AND COALESCE(b.on_hand - b.reserved - b.blocked, 0) < p.min_stock))
        ORDER BY p.name LIMIT ${q.limit ?? 50} OFFSET ${q.offset ?? 0}`,
    );
    return rows.map((r) => ({
      productId: r.id, sku: r.sku, name: r.name, minStock: r.min_stock,
      onHand: r.on_hand, reserved: r.reserved, blocked: r.blocked, available: r.on_hand - r.reserved - r.blocked,
    }));
  }

  balances(ctx: AuthContext, productId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const rows = await tx.stockBalance.findMany({
        where: { tenantId: ctx.tenantId!, productId },
        include: { warehouse: { select: { code: true, name: true } } },
        orderBy: { warehouseId: 'asc' },
      });
      return rows.map((b) => ({
        warehouseId: b.warehouseId, warehouse: b.warehouse, onHand: b.onHand, reserved: b.reserved, blocked: b.blocked, available: available(b),
      }));
    });
  }

  async movements(ctx: AuthContext, q: { productId?: string; warehouseId?: string; cursor?: string; limit?: number }) {
    const limit = q.limit ?? 50;
    const rows = await this.prisma.withContext(ctx, (tx) =>
      tx.stockMovement.findMany({
        where: {
          tenantId: ctx.tenantId!,
          ...(q.productId ? { productId: q.productId } : {}),
          ...(q.warehouseId ? { warehouseId: q.warehouseId } : {}),
        },
        include: { product: { select: { sku: true, name: true } }, warehouse: { select: { code: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      }),
    );
    return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
  }

  metrics(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const [r] = await tx.$queryRaw<{ products: number; below_min: number; out: number; value: string | null; fiscal_pending: number }[]>`
        SELECT count(*)::int AS products,
               count(*) FILTER (WHERE COALESCE(b.av, 0) < p.min_stock AND p.min_stock > 0)::int AS below_min,
               count(*) FILTER (WHERE COALESCE(b.av, 0) <= 0)::int AS out,
               sum(COALESCE(b.oh, 0) * COALESCE(p.cost_price, 0)) AS value,
               count(*) FILTER (WHERE p.ncm IS NULL)::int AS fiscal_pending
        FROM products p
        LEFT JOIN (SELECT product_id, sum(on_hand) oh, sum(on_hand - reserved - blocked) av FROM stock_balances GROUP BY product_id) b
          ON b.product_id = p.id
        WHERE p.tenant_id = ${ctx.tenantId}::uuid AND p.active AND p.kind = 'PHYSICAL'`;
      return { products: r.products, belowMin: r.below_min, outOfStock: r.out, stockValue: r.value ?? '0', fiscalPending: r.fiscal_pending };
    });
  }
}
