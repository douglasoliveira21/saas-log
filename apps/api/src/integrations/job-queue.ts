import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

type Tx = Prisma.TransactionClient;

export interface EnqueueInput {
  type: string;
  connectionId?: string | null;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
  runAt?: Date;
  maxAttempts?: number;
}

/** Fila durável em PostgreSQL com retentativas, backoff, DLQ lógica (DEAD) e reprocessamento controlado. */
@Injectable()
export class JobQueue {
  /** Idempotente por (tenant, idempotencyKey): repetir a chamada devolve o job existente. */
  async enqueue(tx: Tx, tenantId: string, input: EnqueueInput): Promise<{ id: string; created: boolean }> {
    const payload = JSON.stringify(input.payload ?? {});
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO background_jobs (id, tenant_id, connection_id, type, payload, idempotency_key, run_at, max_attempts)
      VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${input.connectionId ?? null}::uuid, ${input.type}, ${payload}::jsonb,
              ${input.idempotencyKey ?? null}, ${input.runAt ?? new Date()}, ${input.maxAttempts ?? 5})
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`;
    if (rows.length) return { id: rows[0].id, created: true };
    const existing = await tx.backgroundJob.findFirstOrThrow({ where: { tenantId, idempotencyKey: input.idempotencyKey } });
    return { id: existing.id, created: false };
  }

  async cancelQueued(tx: Tx, tenantId: string, connectionId: string, types?: string[]): Promise<number> {
    const r = await tx.backgroundJob.updateMany({
      where: { tenantId, connectionId, status: 'QUEUED', ...(types ? { type: { in: types } } : {}) },
      data: { status: 'CANCELLED', finishedAt: new Date(), lastError: 'Cancelado: conexão pausada ou desconectada.' },
    });
    return r.count;
  }
}

