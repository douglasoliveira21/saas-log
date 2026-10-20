import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export type LimitKey = 'users' | 'establishments' | 'warehouses' | 'products' | 'connections' | 'ordersPerMonth';
export type PlanLimits = Partial<Record<LimitKey, number>>;

export const LIMIT_LABEL: Record<LimitKey, string> = {
  users: 'usuários', establishments: 'estabelecimentos', warehouses: 'depósitos', products: 'produtos', connections: 'conexões de marketplace', ordersPerMonth: 'pedidos por mês',
};

type Tx = Prisma.TransactionClient;

export async function limitsOf(tx: Tx, tenantId: string): Promise<PlanLimits> {
  const t = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { plan: { select: { limits: true } } } });
  return (t.plan?.limits as PlanLimits | undefined) ?? {};
}

/** Contagem atual de cada recurso limitado (sempre do próprio tenant, via RLS). */
export async function usageOf(tx: Tx, tenantId: string): Promise<Record<LimitKey, number>> {
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const [users, establishments, warehouses, products, connections, orders] = await Promise.all([
    tx.membership.count({ where: { tenantId, status: 'ACTIVE' } }),
    tx.establishment.count({ where: { tenantId } }),
    tx.warehouse.count({ where: { tenantId } }),
    tx.product.count({ where: { tenantId } }),
    tx.marketplaceConnection.count({ where: { tenantId, status: { not: 'DISCONNECTED' } } }),
    tx.salesOrder.count({ where: { tenantId, createdAt: { gte: monthStart }, status: { not: 'CANCELLED' } } }),
  ]);
  return { users, establishments, warehouses, products, connections, ordersPerMonth: orders };
}

/**
 * Bloqueia (402) a criação quando o plano não comporta `adding` novos itens. Limite ausente = ilimitado.
 * Pedidos importados de marketplace NÃO passam por aqui: perder uma venda já paga seria pior que exceder o plano
 * (o excedente aparece em Plano e uso).
 */
export async function assertWithinPlan(tx: Tx, tenantId: string, key: LimitKey, adding = 1): Promise<void> {
  const limit = (await limitsOf(tx, tenantId))[key];
  if (limit === undefined) return;
  const current = (await usageOf(tx, tenantId))[key];
  if (current + adding > limit) {
    throw new HttpException(`Limite do plano atingido: ${limit} ${LIMIT_LABEL[key]} (em uso: ${current}). Faça upgrade para continuar.`, HttpStatus.PAYMENT_REQUIRED);
  }
}
