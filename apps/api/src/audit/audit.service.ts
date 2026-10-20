import { Controller, Get, Injectable, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  action: string;
  entity?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

const SENSITIVE_KEYS = /pass|senha|token|secret|certificado|authorization/i;

/** Remove segredos antes de gravar metadados na trilha. */
export function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE_KEYS.test(k) ? '[REDACTED]' : scrub(v)]),
    );
  }
  return value;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Grava dentro da transação do chamador: a auditoria confirma ou falha junto com a ação. */
  async record(tx: Prisma.TransactionClient, ctx: { tenantId: string | null; userId: string | null; ip?: string }, entry: AuditEntry): Promise<void> {
    if (!ctx.tenantId) throw new Error('Auditoria exige tenant');
    await tx.auditLog.create({
      data: {
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        metadata: scrub(entry.metadata ?? {}) as Prisma.InputJsonValue,
        ip: ctx.ip,
      },
    });
  }

  async list(ctx: AuthContext, q: AuditQuery) {
    const rows = await this.prisma.withContext(ctx, (tx) =>
      tx.auditLog.findMany({
        where: {
          tenantId: ctx.tenantId!,
          ...(q.action ? { action: { startsWith: q.action } } : {}),
          ...(q.entity ? { entity: q.entity } : {}),
          ...(q.cursor ? { id: { lt: BigInt(q.cursor) } } : {}),
        },
        orderBy: { id: 'desc' },
        take: (q.limit ?? 50) + 1,
      }),
    );
    const limit = q.limit ?? 50;
    const page = rows.slice(0, limit);
    const userIds = [...new Set(page.map((r) => r.userId).filter((v): v is string => !!v))];
    const users = userIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return {
      items: page.map((r) => ({
        id: r.id.toString(),
        action: r.action,
        entity: r.entity,
        entityId: r.entityId,
        metadata: r.metadata,
        ip: r.ip,
        createdAt: r.createdAt,
        user: r.userId ? (byId.get(r.userId) ?? null) : null,
      })),
      nextCursor: rows.length > limit ? page[page.length - 1].id.toString() : null,
    };
  }
}

export class AuditQuery {
  @IsOptional() @IsString() action?: string;
  @IsOptional() @IsString() entity?: string;
  @IsOptional() @IsString() cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions('audit.view')
  list(@CurrentAuth() ctx: AuthContext, @Query() q: AuditQuery) {
    return this.audit.list(ctx, q);
  }
}
