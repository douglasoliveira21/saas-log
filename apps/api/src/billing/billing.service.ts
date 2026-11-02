import { randomUUID } from 'node:crypto';
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, HttpException, HttpStatus, Injectable, NotFoundException, Param, Post, Put, Query, Res } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsEmail, IsIn, IsInt, IsObject, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Response } from 'express';
import { SYSTEM_ROLES } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import { AllowNoTenant, AuthContext, COOKIE_ACCESS, CurrentAuth, RequirePermissions } from '../common/auth';
import { hashPassword, validatePasswordPolicy } from '../common/password';
import { getConfig } from '../config/app.config';
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
class CreateTenantDto {
  @IsString() @Length(2, 120) companyName: string;
  @IsString() @Length(2, 120) ownerName: string;
  @IsEmail() @MaxLength(200) ownerEmail: string;
  @IsString() @MaxLength(200) ownerPassword: string;
  @IsString() @Length(2, 40) planCode: string;
  @IsIn(['TRIAL', 'ACTIVE']) status: 'TRIAL' | 'ACTIVE';
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
class SupportRequestDto { @IsString() @Length(10, 500) reason: string; @Type(() => Number) @IsInt() @Min(5) @Max(120) minutes: number }
class SupportDecisionDto { @IsBoolean() approve: boolean; @Type(() => Number) @IsInt() @Min(5) @Max(120) minutes: number; @IsBoolean() allowWrite: boolean }

@Injectable()
export class PlatformService {
  constructor(private readonly prisma: PrismaService, private readonly jwt: JwtService, private readonly auditLog: AuditService) {}

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

  async createTenant(ctx: AuthContext, dto: CreateTenantDto) {
    await this.requireAdmin(ctx);
    const email = dto.ownerEmail.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email }, select: { id: true, status: true } });
    if (existing?.status !== undefined && existing.status !== 'ACTIVE') throw new ConflictException('O usuário proprietário existe, mas está inativo.');
    if (!existing) {
      const policy = validatePasswordPolicy(dto.ownerPassword);
      if (policy) throw new BadRequestException(policy);
    }
    const plan = await this.prisma.plan.findFirst({ where: { code: dto.planCode, active: true }, select: { id: true, code: true } });
    if (!plan) throw new BadRequestException('Plano inválido ou inativo.');

    const tenantId = randomUUID();
    const base = dto.companyName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 45) || 'empresa';
    const slug = `${base}-${tenantId.slice(0, 8)}`;
    const trialEndsAt = dto.status === 'TRIAL' ? new Date(dto.trialEndsAt ?? Date.now() + 14 * 86_400_000) : null;
    const passwordHash = existing ? null : await hashPassword(dto.ownerPassword);

    await this.prisma.withContext({ tenantId, userId: ctx.userId }, async (tx) => {
      const user = existing ?? await tx.user.create({ data: { email, name: dto.ownerName.trim(), passwordHash: passwordHash! } });
      await tx.tenant.create({ data: { id: tenantId, name: dto.companyName.trim(), slug, status: dto.status, planId: plan.id, trialEndsAt } });
      for (const def of SYSTEM_ROLES) {
        const role = await tx.role.create({ data: { tenantId, key: def.key, name: def.name, isSystem: true } });
        await tx.rolePermission.createMany({ data: def.permissions.map((permission) => ({ roleId: role.id, tenantId, permission })) });
      }
      const owner = await tx.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId, key: 'owner' } } });
      await tx.membership.create({ data: { tenantId, userId: user.id, roleId: owner.id } });
      await this.auditLog.record(tx, { tenantId, userId: ctx.userId, ip: ctx.ip }, { action: 'platform.tenant_created', entity: 'tenant', entityId: tenantId, metadata: { name: dto.companyName.trim(), plan: plan.code, status: dto.status, ownerEmail: email, note: dto.note } });
      await tx.$executeRaw`SELECT platform_record_tenant_created(${tenantId}::uuid, ${email}, ${dto.note})`;
    });
    return { id: tenantId, name: dto.companyName.trim(), slug, status: dto.status, plan: plan.code, ownerEmail: email, ownerExisting: !!existing };
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

  requestSupport(ctx: AuthContext, tenantId: string, dto: SupportRequestDto) {
    return this.run(ctx, async (tx) => {
      const [{ id }] = await tx.$queryRaw<{ id: string }[]>`SELECT platform_support_request(${tenantId}::uuid, ${dto.reason}, ${dto.minutes}::int) AS id`;
      return { id };
    });
  }

  supportSessions(ctx: AuthContext) {
    return this.run(ctx, (tx) => tx.$queryRaw<Record<string, unknown>[]>`SELECT * FROM platform_support_sessions()`);
  }

  tenantSupportSessions(ctx: AuthContext) {
    return this.prisma.withContext(ctx, (tx) => tx.$queryRaw<Record<string, unknown>[]>`SELECT * FROM tenant_support_sessions()`);
  }

  decideSupport(ctx: AuthContext, id: string, dto: SupportDecisionDto) {
    return this.prisma.withContext(ctx, async (tx) => { await tx.$executeRaw`SELECT tenant_support_decide(${id}::uuid, ${dto.approve}, ${dto.minutes}::int, ${dto.allowWrite})`; return { ok: true }; });
  }

  revokeSupport(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => { await tx.$executeRaw`SELECT tenant_support_revoke(${id}::uuid)`; return { ok: true }; });
  }

  async enterSupport(ctx: AuthContext, id: string, res: Response) {
    const rows = await this.run(ctx, (tx) => tx.$queryRaw<{ tenant_id: string; allow_write: boolean; expires_at: Date }[]>`SELECT * FROM platform_support_enter(${id}::uuid)`);
    if (!rows.length) throw new ForbiddenException('A autorização está inativa ou expirada.');
    const cfg = getConfig(); const ttl = Math.max(30, Math.min(cfg.accessTtlSeconds, Math.floor((rows[0].expires_at.getTime() - Date.now()) / 1000)));
    const token = await this.jwt.signAsync({ sub: ctx.userId, tid: rows[0].tenant_id, sid: id }, { expiresIn: ttl });
    res.cookie(COOKIE_ACCESS, token, { httpOnly: true, sameSite: 'lax', secure: cfg.cookieSecure, path: '/', maxAge: ttl * 1000 });
    return { tenantId: rows[0].tenant_id, allowWrite: rows[0].allow_write, expiresAt: rows[0].expires_at };
  }

  async exitSupport(ctx: AuthContext, res: Response) {
    await this.requireAdmin(ctx);
    const cfg = getConfig(); const token = await this.jwt.signAsync({ sub: ctx.userId, tid: null }, { expiresIn: cfg.accessTtlSeconds });
    res.cookie(COOKIE_ACCESS, token, { httpOnly: true, sameSite: 'lax', secure: cfg.cookieSecure, path: '/', maxAge: cfg.accessTtlSeconds * 1000 });
    return { ok: true };
  }

  operations(ctx: AuthContext) {
    return this.run(ctx, async (tx) => (await tx.$queryRaw<{ data: unknown }[]>`SELECT platform_operations_overview() AS data`)[0].data);
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
  @Post('tenants') @AllowNoTenant()
  createTenant(@CurrentAuth() ctx: AuthContext, @Body() dto: CreateTenantDto) { return this.svc.createTenant(ctx, dto); }
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
  @Get('operations') @AllowNoTenant()
  operations(@CurrentAuth() ctx: AuthContext) { return this.svc.operations(ctx); }
  @Get('support') @AllowNoTenant()
  support(@CurrentAuth() ctx: AuthContext) { return this.svc.supportSessions(ctx); }
  @Post('tenants/:id/support') @AllowNoTenant()
  requestSupport(@CurrentAuth() ctx: AuthContext, @Param('id') id: string, @Body() dto: SupportRequestDto) { return this.svc.requestSupport(ctx, id, dto); }
  @Post('support/:id/enter') @AllowNoTenant() @HttpCode(200)
  enterSupport(@CurrentAuth() ctx: AuthContext, @Param('id') id: string, @Res({ passthrough: true }) res: Response) { return this.svc.enterSupport(ctx, id, res); }
  @Post('support/exit') @AllowNoTenant() @HttpCode(200)
  exitSupport(@CurrentAuth() ctx: AuthContext, @Res({ passthrough: true }) res: Response) { return this.svc.exitSupport(ctx, res); }
}

@Controller('support')
export class TenantSupportController {
  constructor(private readonly svc: PlatformService) {}
  @Get() @RequirePermissions('tenant.manage') list(@CurrentAuth() ctx: AuthContext) { return this.svc.tenantSupportSessions(ctx); }
  @Post(':id/decision') @HttpCode(200) @RequirePermissions('tenant.manage') decide(@CurrentAuth() ctx: AuthContext, @Param('id') id: string, @Body() dto: SupportDecisionDto) { return this.svc.decideSupport(ctx, id, dto); }
  @Post(':id/revoke') @HttpCode(200) @RequirePermissions('tenant.manage') revoke(@CurrentAuth() ctx: AuthContext, @Param('id') id: string) { return this.svc.revokeSupport(ctx, id); }
}
