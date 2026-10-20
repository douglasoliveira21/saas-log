import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpException, HttpStatus, Injectable, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsInt, IsObject, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { AllowNoTenant, AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';
import { LIMIT_LABEL, LimitKey, limitsOf, usageOf } from './limits';

const KEYS = Object.keys(LIMIT_LABEL) as LimitKey[];

/** Plano e uso do próprio tenant. Não há gateway de pagamento integrado: a contratação é registrada pela plataforma. */
@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  overview(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const t = await tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId! }, include: { plan: true } });
      const limits = await limitsOf(tx, ctx.tenantId!);
      const usage = await usageOf(tx, ctx.tenantId!);
      const now = Date.now();
      const trialDaysLeft = t.status === 'TRIAL' && t.trialEndsAt ? Math.ceil((t.trialEndsAt.getTime() - now) / 86_400_000) : null;
      const subs = await tx.subscription.findMany({ where: { tenantId: ctx.tenantId! }, orderBy: { createdAt: 'desc' }, take: 20, include: { plan: { select: { code: true, name: true } } } });
      const plans = await tx.plan.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' }, select: { code: true, name: true, limits: true, priceCents: true, description: true } });
      return {
        status: t.status, plan: t.plan ? { code: t.plan.code, name: t.plan.name, priceCents: t.plan.priceCents } : null, trialEndsAt: t.trialEndsAt, trialDaysLeft,
        readOnly: t.status === 'TRIAL' && !!t.trialEndsAt && t.trialEndsAt.getTime() < now,
        resources: KEYS.map((k) => ({ key: k, label: LIMIT_LABEL[k], used: usage[k], limit: limits[k] ?? null, exceeded: limits[k] !== undefined && usage[k] > limits[k]! })),
        history: subs.map((s) => ({ at: s.createdAt, status: s.status, plan: s.plan.name, note: s.note })),
        plans,
        paymentGateway: { integrated: false, note: 'Cobrança automática ainda não integrada: a contratação é feita com a equipe da plataforma.' },
      };
    });
  }
}

// ───────────── administração da plataforma ─────────────

class UpdateTenantDto {
  @IsOptional() @IsString() @Matches(/^(TRIAL|ACTIVE|SUSPENDED)$/) status?: string;
  @IsOptional() @IsString() @Length(2, 40) planCode?: string;
  @IsOptional() @IsDateString() trialEndsAt?: string;
  @IsString() @Length(3, 300) note: string;
}
class PlanDto {
  @IsString() @Length(2, 80) name: string;
  @IsObject() limits: Record<string, number>;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(100_000_000) priceCents?: number;
  @IsOptional() @IsString() @Length(0, 300) description?: string;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
}
class AuditQuery { @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number; }

@Injectable()
export class PlatformService {
  constructor(private readonly prisma: PrismaService) {}

  /** Executa com a identidade do usuário e sem tenant; o banco recusa quem não é administrador da plataforma. */
  private async run<T>(ctx: AuthContext, fn: (tx: Parameters<Parameters<PrismaService['withContext']>[1]>[0]) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.withContext({ tenantId: null, userId: ctx.userId }, fn);
    } catch (e) {
      const msg = String((e as Error).message ?? '');
      if (msg.includes('platform_forbidden')) throw new ForbiddenException('Acesso restrito aos administradores da plataforma.');
      if (msg.includes('tenant_not_found')) throw new NotFoundException('Empresa não encontrada.');
      if (msg.includes('invalid_plan')) throw new BadRequestException('Plano inválido ou inativo.');
      if (msg.includes('invalid_status') || msg.includes('invalid_code')) throw new BadRequestException('Dados inválidos.');
      throw e;
    }
  }

  private async requireAdmin(ctx: AuthContext) {
    const [{ ok }] = await this.prisma.withContext({ tenantId: null, userId: ctx.userId }, (tx) => tx.$queryRaw<{ ok: boolean }[]>`SELECT platform_is_admin() AS ok`);
    if (!ok) throw new ForbiddenException('Acesso restrito aos administradores da plataforma.');
  }

  tenants(ctx: AuthContext) {
    return this.run(ctx, async (tx) => {
      const rows = await tx.$queryRaw<Record<string, unknown>[]>`SELECT * FROM platform_list_tenants()`;
      return rows.map((r) => ({
        id: r.id, name: r.name, slug: r.slug, status: r.status, plan: r.plan_code, trialEndsAt: r.trial_ends_at, createdAt: r.created_at,
        users: Number(r.users), products: Number(r.products), orders30d: Number(r.orders_30d), connections: Number(r.connections), lastActivity: r.last_activity,
      }));
    });
  }

  update(ctx: AuthContext, tenantId: string, dto: UpdateTenantDto) {
    return this.run(ctx, async (tx) => {
      await tx.$executeRaw`SELECT platform_update_tenant(${tenantId}::uuid, ${dto.status ?? null}, ${dto.planCode ?? null}, ${dto.trialEndsAt ? new Date(dto.trialEndsAt) : null}::timestamp, ${dto.note})`;
      return { ok: true };
    });
  }

  async plans(ctx: AuthContext) {
    await this.requireAdmin(ctx);
    return this.prisma.withContext({ tenantId: null, userId: ctx.userId }, (tx) => tx.plan.findMany({ orderBy: { sortOrder: 'asc' } }));
  }

  savePlan(ctx: AuthContext, code: string, dto: PlanDto) {
    for (const [k, v] of Object.entries(dto.limits)) if (!KEYS.includes(k as LimitKey) || !Number.isInteger(v) || v < 0) throw new BadRequestException(`Limite inválido: ${k}.`);
    return this.run(ctx, async (tx) => {
      await tx.$executeRaw`SELECT platform_upsert_plan(${code}, ${dto.name}, ${JSON.stringify(dto.limits)}::jsonb, ${dto.priceCents ?? null}::int, ${dto.description ?? null}, ${dto.active ?? true}, ${dto.sortOrder ?? 0}::int)`;
      return { ok: true };
    });
  }

  audit(ctx: AuthContext, limit = 100) {
    return this.run(ctx, async (tx) => (await tx.$queryRaw<Record<string, unknown>[]>`SELECT * FROM platform_audit(${limit}::int)`).map((r) => ({ id: String(r.id), actor: r.actor_user_id, action: r.action, tenantId: r.tenant_id, metadata: r.metadata, at: r.created_at })));
  }

  async queue(ctx: AuthContext) {
    await this.requireAdmin(ctx);
    return this.prisma.withContext({ tenantId: null, userId: ctx.userId }, async (tx) => (await tx.$queryRaw<{ status: string; jobs: bigint; oldest_ready: Date | null }[]>`SELECT * FROM platform_queue_stats()`).map((r) => ({ status: r.status, jobs: Number(r.jobs), oldestReady: r.oldest_ready })));
  }
}

@Controller('billing')
export class BillingController {
  constructor(private readonly svc: BillingService) {}
  @Get() @RequirePermissions('tenant.manage')
  overview(@CurrentAuth() ctx: AuthContext) { return this.svc.overview(ctx); }
}

/** Rotas sem tenant: o acesso é decidido pelo banco (platform_admins), nunca por token ou papel de tenant. */
@Controller('platform')
export class PlatformController {
  constructor(private readonly svc: PlatformService) {}
  @Get('tenants') @AllowNoTenant()
  tenants(@CurrentAuth() ctx: AuthContext) { return this.svc.tenants(ctx); }
  @Put('tenants/:id') @AllowNoTenant()
  update(@CurrentAuth() ctx: AuthContext, @Param('id') id: string, @Body() dto: UpdateTenantDto) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpException('Identificador inválido.', HttpStatus.BAD_REQUEST);
    return this.svc.update(ctx, id, dto);
  }
  @Get('plans') @AllowNoTenant()
  plans(@CurrentAuth() ctx: AuthContext) { return this.svc.plans(ctx); }
  @Put('plans/:code') @AllowNoTenant()
  savePlan(@CurrentAuth() ctx: AuthContext, @Param('code') code: string, @Body() dto: PlanDto) { return this.svc.savePlan(ctx, code, dto); }
  @Get('audit') @AllowNoTenant()
  audit(@CurrentAuth() ctx: AuthContext, @Query() q: AuditQuery) { return this.svc.audit(ctx, q.limit); }
  @Get('queue') @AllowNoTenant()
  queue(@CurrentAuth() ctx: AuthContext) { return this.svc.queue(ctx); }
}
