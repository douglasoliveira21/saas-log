import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;

/** Pedidos que contam como compra: já confirmados (não rascunho, aguardando aprovação nem cancelados). */
export const PURCHASE_STATUSES = ['CONFIRMED', 'PICKING', 'PACKED', 'SHIPPED', 'DELIVERED', 'CLOSED'] as const;

/**
 * NEW = nunca comprou · ACTIVE = comprou há no máximo `inactiveAfterDays` dias · RETURNING = a última compra foi há MAIS que isso
 * (se comprar agora, é um cliente que voltou). Nos pedidos guarda-se o valor no momento da compra.
 */
export type PurchaseType = 'NEW' | 'ACTIVE' | 'RETURNING';

export function classifyPurchase(lastPurchaseAt: Date | null, now: Date, inactiveAfterDays: number): { type: PurchaseType; daysSince: number | null } {
  if (!lastPurchaseAt) return { type: 'NEW', daysSince: null };
  const daysSince = Math.max(0, Math.floor((now.getTime() - lastPurchaseAt.getTime()) / DAY));
  return { type: daysSince > inactiveAfterDays ? 'RETURNING' : 'ACTIVE', daysSince };
}

export interface PurchaseProfile {
  type: PurchaseType;
  lastPurchaseAt: string | null;
  daysSince: number | null;
  orders: number;
  totalSpent: string;
  inactiveAfterDays: number;
}

/** Perfil de compra de vários clientes de uma vez (uma consulta). `excludeOrderId` ignora o próprio pedido que está sendo criado/confirmado. */
export async function purchaseProfiles(tx: Tx, tenantId: string, customerIds: string[], inactiveAfterDays: number, opts: { now?: Date; excludeOrderId?: string } = {}) {
  const now = opts.now ?? new Date();
  const out = new Map<string, PurchaseProfile>();
  if (!customerIds.length) return out;
  const groups = await tx.salesOrder.groupBy({
    by: ['customerId'],
    where: { tenantId, customerId: { in: customerIds }, status: { in: [...PURCHASE_STATUSES] }, confirmedAt: { not: null }, ...(opts.excludeOrderId ? { id: { not: opts.excludeOrderId } } : {}) },
    _max: { confirmedAt: true }, _count: { _all: true }, _sum: { total: true },
  });
  const byId = new Map(groups.map((g) => [g.customerId, g]));
  for (const id of customerIds) {
    const g = byId.get(id);
    const last = g?._max.confirmedAt ?? null;
    const c = classifyPurchase(last, now, inactiveAfterDays);
    out.set(id, { type: c.type, lastPurchaseAt: last?.toISOString() ?? null, daysSince: c.daysSince, orders: g?._count._all ?? 0, totalSpent: (g?._sum.total ?? new Prisma.Decimal(0)).toFixed(2), inactiveAfterDays });
  }
  return out;
}
