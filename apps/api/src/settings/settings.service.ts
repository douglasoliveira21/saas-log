import { BadRequestException, Body, Controller, Get, Injectable, Put } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';

type Tx = Prisma.TransactionClient;

export type CommissionEvent = 'CONFIRMED' | 'SHIPPED' | 'DELIVERED';

export interface TenantSettings {
  'commission.event': CommissionEvent;
  'sales.maxDiscountPct': number;
  'purchases.approvalLimit': number;
  'finance.paymentApprovalLimit': number;
}

/** Valores padrão documentados em docs/COMMERCIAL.md. "Recebimento confirmado"/"faturada" dependem de Financeiro/Fiscal. */
export const DEFAULT_SETTINGS: TenantSettings = {
  'commission.event': 'CONFIRMED',
  'sales.maxDiscountPct': 10,
  'purchases.approvalLimit': 5000,
  'finance.paymentApprovalLimit': 10000,
};

function validate(key: string, value: unknown): unknown {
  switch (key) {
    case 'commission.event':
      if (value === 'CONFIRMED' || value === 'SHIPPED' || value === 'DELIVERED') return value;
      throw new BadRequestException('Evento de comissão inválido (disponíveis: pedido aprovado, enviado, entregue).');
    case 'sales.maxDiscountPct':
      if (typeof value === 'number' && value >= 0 && value <= 100) return value;
      throw new BadRequestException('Desconto máximo deve estar entre 0 e 100.');
    case 'purchases.approvalLimit':
    case 'finance.paymentApprovalLimit':
      if (typeof value === 'number' && value >= 0 && value <= 1e9) return value;
      throw new BadRequestException('Limite de aprovação inválido.');
    default:
      throw new BadRequestException(`Configuração desconhecida: ${key}`);
  }
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async load(tx: Tx, ctx: Pick<AuthContext, 'tenantId'>): Promise<TenantSettings> {
    const rows = await tx.tenantSetting.findMany({ where: { tenantId: ctx.tenantId! } });
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const r of rows) if (r.key in DEFAULT_SETTINGS) out[r.key] = r.value;
    return out as unknown as TenantSettings;
  }

  get(ctx: AuthContext) {
    return this.prisma.withContext(ctx, (tx) => this.load(tx, ctx));
  }

  update(ctx: AuthContext, patch: Record<string, unknown>) {
    return this.prisma.withContext(ctx, async (tx) => {
      const before = await this.load(tx, ctx);
      for (const [key, raw] of Object.entries(patch)) {
        const value = validate(key, raw);
        await tx.tenantSetting.upsert({
          where: { tenantId_key: { tenantId: ctx.tenantId!, key } },
          create: { tenantId: ctx.tenantId!, key, value: value as Prisma.InputJsonValue },
          update: { value: value as Prisma.InputJsonValue },
        });
      }
      const after = await this.load(tx, ctx);
      await this.audit.record(tx, ctx, { action: 'settings.updated', entity: 'settings', metadata: { before, after } });
      return after;
    });
  }

  /** Numeração sequencial por tenant e tipo, sem lacunas duplicadas (UPSERT atômico). */
  async nextNumber(tx: Tx, ctx: Pick<AuthContext, 'tenantId'>, kind: string): Promise<number> {
    const rows = await tx.$queryRaw<{ last: number }[]>`
      INSERT INTO document_counters (tenant_id, kind, last) VALUES (${ctx.tenantId}::uuid, ${kind}, 1)
      ON CONFLICT (tenant_id, kind) DO UPDATE SET last = document_counters.last + 1
      RETURNING last`;
    return rows[0].last;
  }
}

@Controller('settings')
export class SettingsController {
  constructor(private readonly svc: SettingsService) {}

  @Get() @RequirePermissions('company.view')
  get(@CurrentAuth() ctx: AuthContext) { return this.svc.get(ctx); }

  @Put() @RequirePermissions('tenant.manage')
  update(@CurrentAuth() ctx: AuthContext, @Body() body: Record<string, unknown>) { return this.svc.update(ctx, body); }
}
