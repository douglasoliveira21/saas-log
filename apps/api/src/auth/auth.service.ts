import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import { randomBytes, randomUUID } from 'node:crypto';
import * as QRCode from 'qrcode';
import type { Response } from 'express';
import { SYSTEM_ROLES } from '../access/permissions';
import { AuditService } from '../audit/audit.service';
import { AuthContext, COOKIE_ACCESS, COOKIE_REFRESH } from '../common/auth';
import { DUMMY_HASH, hashPassword, newOpaqueToken, sha256, validatePasswordPolicy, verifyPassword } from '../common/password';
import { getConfig } from '../config/app.config';
import { CryptoService } from '../integrations/crypto.service';
import { newTotpSecret, otpauthUrl, verifyTotp } from '../notify/totp';
import { PrismaService } from '../prisma/prisma.service';
import type { LoginDto, MfaVerifyDto, RegisterDto } from './auth.dto';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  role: { key: string; name: string };
}

@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
  ) {}

  async register(dto: RegisterDto, res: Response, meta: RequestMeta) {
    const policy = validatePasswordPolicy(dto.password);
    if (policy) throw new BadRequestException(policy);
    const email = dto.email.trim().toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new ConflictException('Já existe uma conta com este e-mail.');
    }

    const passwordHash = await hashPassword(dto.password);
    const tenantId = randomUUID();
    const slug = await this.uniqueSlug(dto.companyName);

    const userId = await this.prisma.withContext({ tenantId, userId: null }, async (tx) => {
      const plan = await tx.plan.findUnique({ where: { code: 'trial' } });
      const user = await tx.user.create({ data: { email, name: dto.name.trim(), passwordHash } });
      await tx.$executeRaw`SELECT set_config('app.user_id', ${user.id}, true)`;
      await tx.tenant.create({
        data: {
          id: tenantId,
          name: dto.companyName.trim(),
          slug,
          planId: plan?.id,
          trialEndsAt: new Date(Date.now() + 14 * 86400_000),
        },
      });
      for (const def of SYSTEM_ROLES) {
        const role = await tx.role.create({ data: { tenantId, key: def.key, name: def.name, isSystem: true } });
        await tx.rolePermission.createMany({
          data: def.permissions.map((permission) => ({ roleId: role.id, tenantId, permission })),
        });
      }
      const owner = await tx.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId, key: 'owner' } } });
      await tx.membership.create({ data: { tenantId, userId: user.id, roleId: owner.id } });
      await this.audit.record(tx, { tenantId, userId: user.id, ip: meta.ip }, {
        action: 'tenant.created',
        entity: 'tenant',
        entityId: tenantId,
        metadata: { name: dto.companyName },
      });
      return user.id;
    });

    await this.startSession(res, userId, tenantId, meta);
    return { tenantId, next: 'dashboard' as const };
  }

  async login(dto: LoginDto, res: Response, meta: RequestMeta) {
    const email = dto.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      throw new HttpException('Muitas tentativas. Tente novamente em alguns minutos.', HttpStatus.TOO_MANY_REQUESTS);
    }
    const ok = await verifyPassword(dto.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok || user.status !== 'ACTIVE') {
      if (user && !ok) {
        const failed = user.failedLoginCount + 1;
        await this.prisma.user.update({
          where: { id: user.id },
          data: {
            failedLoginCount: failed >= MAX_FAILED ? 0 : failed,
            lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
          },
        });
        this.log.warn(`login falhou para userId=${user.id} (tentativa ${failed})`);
      }
      throw new UnauthorizedException('E-mail ou senha inválidos.');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    // Segundo fator: a senha sozinha não abre a sessão. O token abaixo só serve para /auth/mfa/verify (outra chave, 5 minutos).
    if (user.totpEnabledAt) {
      const mfaToken = await this.jwt.signAsync({ sub: user.id, purpose: 'mfa' }, { secret: this.mfaSecret(), expiresIn: 300 });
      return { mfaRequired: true as const, mfaToken };
    }
    return this.completeLogin(user.id, res, meta);
  }

  private mfaSecret() { return `${getConfig().jwtSecret}:mfa`; }

  private async completeLogin(userId: string, res: Response, meta: RequestMeta) {
    const tenants = await this.listTenants(userId);
    if (tenants.length === 1) {
      await this.startSession(res, userId, tenants[0].id, meta);
      await this.auditLogin(userId, tenants[0].id, meta);
      return { tenants, selectedTenantId: tenants[0].id };
    }
    await this.startSession(res, userId, null, meta);
    return { tenants, selectedTenantId: null };
  }

  /** Segunda etapa do login: código do aplicativo (6 dígitos) ou um código de recuperação. Erros contam para o bloqueio. */
  async verifyMfa(dto: MfaVerifyDto, res: Response, meta: RequestMeta) {
    let sub: string;
    try { sub = (await this.jwt.verifyAsync<{ sub: string; purpose?: string }>(dto.mfaToken, { secret: this.mfaSecret() })).sub; } catch { throw new UnauthorizedException('Verificação expirada. Entre novamente com a senha.'); }
    const user = await this.prisma.user.findUnique({ where: { id: sub } });
    if (!user || user.status !== 'ACTIVE' || !user.totpEnabledAt || !user.totpSecret) throw new UnauthorizedException('Verificação inválida.');
    if (user.lockedUntil && user.lockedUntil > new Date()) throw new HttpException('Muitas tentativas. Tente novamente em alguns minutos.', HttpStatus.TOO_MANY_REQUESTS);
    const secret = this.crypto.decrypt<{ secret: string; lastStep?: number }>(user.id, 'totp', user.totpSecret);
    const code = dto.code.trim().replace(/\s|-/g, '');
    let ok = false; let usedRecovery = false; let step: number | null = null;
    if (/^\d{6}$/.test(code)) {
      step = verifyTotp(secret.secret, code);
      ok = step !== null && step > (secret.lastStep ?? 0); // o mesmo código não vale duas vezes
    } else {
      const hashes = (user.recoveryCodes as string[] | null) ?? [];
      const h = sha256(dto.code.trim().toLowerCase());
      if (hashes.includes(h)) { ok = true; usedRecovery = true; await this.prisma.user.update({ where: { id: user.id }, data: { recoveryCodes: hashes.filter((x) => x !== h) } }); }
    }
    if (!ok) {
      const failed = user.failedLoginCount + 1;
      await this.prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: failed >= MAX_FAILED ? 0 : failed, lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null } });
      throw new UnauthorizedException('Código inválido.');
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date(), ...(step !== null ? { totpSecret: this.crypto.encrypt(user.id, 'totp', { secret: secret.secret, lastStep: step }) } : {}) },
    });
    if (usedRecovery) this.log.warn(`código de recuperação usado userId=${user.id}`);
    return this.completeLogin(user.id, res, meta);
  }

  // ───────────── gerenciamento do 2FA (usuário logado) ─────────────

  async mfaStatus(ctx: AuthContext) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { totpEnabledAt: true, recoveryCodes: true } });
    return { enabled: !!u.totpEnabledAt, enabledAt: u.totpEnabledAt, recoveryCodesLeft: ((u.recoveryCodes as string[] | null) ?? []).length };
  }

  /** Gera um segredo novo (ainda inativo) e o QR code para o aplicativo autenticador. */
  async mfaSetup(ctx: AuthContext) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    if (u.totpEnabledAt) throw new ConflictException('O segundo fator já está ativo. Desative-o antes de configurar de novo.');
    const secret = newTotpSecret();
    await this.prisma.user.update({ where: { id: u.id }, data: { totpSecret: this.crypto.encrypt(u.id, 'totp', { secret }) } });
    const url = otpauthUrl(secret, u.email, getConfig().appName);
    return { secret, otpauthUrl: url, qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 220 }) };
  }

  /** Confere o primeiro código, ativa e devolve 8 códigos de recuperação (mostrados uma única vez). */
  async mfaEnable(ctx: AuthContext, code: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    if (u.totpEnabledAt) throw new ConflictException('O segundo fator já está ativo.');
    if (!u.totpSecret) throw new BadRequestException('Gere o QR code antes de ativar.');
    const secret = this.crypto.decrypt<{ secret: string }>(u.id, 'totp', u.totpSecret);
    const step = verifyTotp(secret.secret, code.trim());
    if (step === null) throw new BadRequestException('Código inválido. Confira o horário do celular e tente de novo.');
    const codes = Array.from({ length: 8 }, () => { const h = randomBytes(5).toString('hex'); return `${h.slice(0, 5)}-${h.slice(5)}`; });
    await this.prisma.user.update({ where: { id: u.id }, data: { totpEnabledAt: new Date(), recoveryCodes: codes.map((c) => sha256(c)), totpSecret: this.crypto.encrypt(u.id, 'totp', { secret: secret.secret, lastStep: step }) } });
    return { recoveryCodes: codes };
  }

  async mfaDisable(ctx: AuthContext, password: string, code: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    if (!u.totpEnabledAt || !u.totpSecret) throw new ConflictException('O segundo fator não está ativo.');
    if (!(await verifyPassword(password, u.passwordHash))) throw new UnauthorizedException('Senha incorreta.');
    const secret = this.crypto.decrypt<{ secret: string }>(u.id, 'totp', u.totpSecret);
    const c = code.trim().replace(/\s|-/g, '');
    const okTotp = /^\d{6}$/.test(c) && verifyTotp(secret.secret, c) !== null;
    const okRecovery = ((u.recoveryCodes as string[] | null) ?? []).includes(sha256(code.trim().toLowerCase()));
    if (!okTotp && !okRecovery) throw new UnauthorizedException('Código inválido.');
    await this.prisma.user.update({ where: { id: u.id }, data: { totpEnabledAt: null, totpSecret: null, recoveryCodes: Prisma.JsonNull } });
    return { ok: true };
  }

  async selectTenant(ctx: AuthContext, tenantId: string, res: Response, meta: RequestMeta) {
    const tenants = await this.listTenants(ctx.userId);
    if (!tenants.some((t) => t.id === tenantId)) throw new ForbiddenException('Você não tem acesso a esta empresa.');
    await this.startSession(res, ctx.userId, tenantId, meta);
    await this.auditLogin(ctx.userId, tenantId, meta);
    return { selectedTenantId: tenantId };
  }

  async refresh(rawToken: string | undefined, res: Response, meta: RequestMeta) {
    if (!rawToken) throw new UnauthorizedException('Sessão expirada.');
    const session = await this.prisma.refreshSession.findUnique({ where: { tokenHash: sha256(rawToken) } });
    if (!session) throw new UnauthorizedException('Sessão expirada.');
    if (session.revokedAt) {
      // Reutilização de token já rotacionado: possível roubo — revoga a família inteira.
      await this.prisma.refreshSession.updateMany({
        where: { familyId: session.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.log.warn(`reuso de refresh token detectado userId=${session.userId}`);
      throw new UnauthorizedException('Sessão expirada.');
    }
    if (session.expiresAt < new Date()) throw new UnauthorizedException('Sessão expirada.');

    const user = await this.prisma.user.findUnique({ where: { id: session.userId } });
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('Sessão expirada.');

    await this.startSession(res, session.userId, session.tenantId, meta, session);
    return { ok: true };
  }

  async logout(rawToken: string | undefined, res: Response) {
    if (rawToken) {
      await this.prisma.refreshSession.updateMany({
        where: { tokenHash: sha256(rawToken), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    this.clearCookies(res);
    return { ok: true };
  }

  async me(ctx: AuthContext) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: ctx.userId },
      select: { id: true, name: true, email: true, totpEnabledAt: true },
    });
    const tenants = await this.listTenants(ctx.userId);
    let tenant: { id: string; name: string; slug: string; status: string; plan: string | null; trialEndsAt: Date | null; logoVersion: number | null } | null = null;
    let role: { key: string; name: string } | null = null;
    if (ctx.tenantId) {
      const t = await this.prisma.withContext(ctx, (tx) =>
        tx.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId! }, include: { plan: true, branding: { select: { updatedAt: true } } } }),
      );
      tenant = { id: t.id, name: t.name, slug: t.slug, status: t.status, plan: t.plan?.name ?? null, trialEndsAt: t.trialEndsAt, logoVersion: t.branding?.updatedAt.getTime() ?? null };
      role = tenants.find((x) => x.id === ctx.tenantId)?.role ?? null;
    }
    const [{ is_admin: platformAdmin }] = await this.prisma.withContext({ tenantId: null, userId: ctx.userId }, (tx) => tx.$queryRaw<{ is_admin: boolean }[]>`SELECT platform_is_admin() AS is_admin`);
    return { user: { id: user.id, name: user.name, email: user.email, mfaEnabled: !!user.totpEnabledAt }, tenant, role, permissions: [...ctx.permissions].sort(), tenants, platformAdmin, appName: getConfig().appName };
  }

  private async listTenants(userId: string): Promise<TenantSummary[]> {
    const rows = await this.prisma.withContext({ userId }, (tx) =>
      tx.membership.findMany({
        where: { userId, status: 'ACTIVE', tenant: { status: { not: 'SUSPENDED' } } },
        include: { tenant: true, role: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return rows.map((m) => ({
      id: m.tenant.id,
      name: m.tenant.name,
      slug: m.tenant.slug,
      role: { key: m.role.key, name: m.role.name },
    }));
  }

  private async auditLogin(userId: string, tenantId: string, meta: RequestMeta) {
    await this.prisma.withContext({ tenantId, userId }, (tx) =>
      this.audit.record(tx, { tenantId, userId, ip: meta.ip }, { action: 'auth.login' }),
    );
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base =
      name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) ||
      'empresa';
    return `${base}-${randomUUID().slice(0, 6)}`;
  }

  /** Emite access (curto) + refresh (opaco, rotacionado). `previous` revoga o refresh anterior. */
  private async startSession(
    res: Response,
    userId: string,
    tenantId: string | null,
    meta: RequestMeta,
    previous?: { id: string; familyId: string },
  ) {
    const cfg = getConfig();
    const refresh = newOpaqueToken();
    const created = await this.prisma.refreshSession.create({
      data: {
        userId,
        tenantId,
        familyId: previous?.familyId ?? randomUUID(),
        tokenHash: sha256(refresh),
        expiresAt: new Date(Date.now() + cfg.refreshTtlSeconds * 1000),
        userAgent: meta.userAgent?.slice(0, 255),
        ip: meta.ip,
      },
    });
    if (previous) {
      await this.prisma.refreshSession.update({
        where: { id: previous.id },
        data: { revokedAt: new Date(), replacedBy: created.id },
      });
    }
    const access = await this.jwt.signAsync({ sub: userId, tid: tenantId }, { expiresIn: cfg.accessTtlSeconds });
    const base = { httpOnly: true, sameSite: 'lax' as const, secure: cfg.cookieSecure };
    res.cookie(COOKIE_ACCESS, access, { ...base, path: '/', maxAge: cfg.accessTtlSeconds * 1000 });
    res.cookie(COOKIE_REFRESH, refresh, { ...base, path: '/api/auth', maxAge: cfg.refreshTtlSeconds * 1000 });
  }

  private clearCookies(res: Response) {
    res.clearCookie(COOKIE_ACCESS, { path: '/' });
    res.clearCookie(COOKIE_REFRESH, { path: '/api/auth' });
  }
}
