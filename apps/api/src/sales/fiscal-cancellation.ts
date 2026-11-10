import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export const CANCELLATION_LEASE_MS = 30 * 60_000;

export function assertNoFiscalCancellation(startedAt: Date | null) {
  if (startedAt && Date.now() - startedAt.getTime() < CANCELLATION_LEASE_MS) {
    throw new ConflictException('Já existe um cancelamento em andamento para este pedido.');
  }
}

/** Serializa o início de uma emissão com o início do cancelamento da venda. */
export async function lockOrdersForFiscal(tx: Prisma.TransactionClient, tenantId: string, ids: string[]) {
  if (!ids.length) return;
  const orders = await tx.$queryRaw<{ status: string; startedAt: Date | null }[]>`
    SELECT status, fiscal_cancellation_started_at AS "startedAt"
    FROM sales_orders
    WHERE tenant_id = ${tenantId}::uuid AND id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    ORDER BY id FOR UPDATE
  `;
  for (const order of orders) {
    assertNoFiscalCancellation(order.startedAt);
    if (order.status === 'CANCELLED') throw new ConflictException('Pedido cancelado. Atualize o documento fiscal antes de continuar.');
  }
}
