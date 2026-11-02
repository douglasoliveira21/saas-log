import { CanActivate, ExecutionContext, ForbiddenException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  ALLOW_NO_TENANT,
  AuthContext,
  AuthedRequest,
  COOKIE_ACCESS,
  CSRF_HEADER,
  IS_PUBLIC,
  REQUIRED_PERMISSIONS,
} from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';
import { ALL_PERMISSIONS } from '../access/permissions';

interface AccessPayload {
  sub: string;
  tid?: string | null;
  sid?: string;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TENANT_SUPER_ADMIN_PREFIXES = [
  '/api/structure', '/api/companies', '/api/establishments', '/api/warehouses',
  '/api/users', '/api/roles', '/api/permissions', '/api/settings', '/api/billing',
  '/api/support', '/api/onboarding', '/api/migration', '/api/audit', '/api/notifications',
];

function requiresTenantSuperAdmin(method: string, url: string) {
  const path = url.split('?')[0];
  // A árvore estrutural é usada como contexto por telas operacionais; somente sua
  // manutenção pertence ao portal administrativo.
  if (SAFE_METHODS.has(method) && (path === '/api/structure' || path.startsWith('/api/companies/') || path.startsWith('/api/establishments/') || path.startsWith('/api/warehouses/'))) return false;
  // Preferência de contato do próprio cliente é parte da operação comercial.
  if (path.startsWith('/api/notifications/customers/')) return false;
  if (TENANT_SUPER_ADMIN_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return true;
  return path.startsWith('/api/branding/') && !SAFE_METHODS.has(method);
}

/**
 * Guard global: autenticação + resolução do tenant + autorização por permissão.
 * O tenant do token NÃO é confiado: a membership ativa é relida do banco a cada requisição
 * e as permissões vêm do banco.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
    const cookieToken = (req.cookies?.[COOKIE_ACCESS] as string | undefined) ?? null;
    const token = bearer ?? cookieToken;
    if (!token) throw new UnauthorizedException('Sessão ausente ou expirada.');

    // CSRF: requisições mutáveis autenticadas por cookie exigem cabeçalho customizado
    // (navegadores não o enviam em requisições cross-site sem preflight/CORS).
    if (!bearer && !SAFE_METHODS.has(req.method) && req.headers[CSRF_HEADER] !== '1') {
      throw new ForbiddenException('Requisição rejeitada pela proteção CSRF.');
    }

    let payload: AccessPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessPayload>(token);
    } catch {
      throw new UnauthorizedException('Sessão ausente ou expirada.');
    }

    const allowNoTenant = this.reflector.getAllAndOverride<boolean>(ALLOW_NO_TENANT, targets);
    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS, targets) ?? [];

    const base: AuthContext = {
      userId: payload.sub,
      tenantId: null,
      membershipId: null,
      roleKey: null,
      permissions: new Set(),
      ip: req.ip,
    };

    if (!payload.tid) {
      if (!allowNoTenant || required.length > 0) throw new ForbiddenException('Selecione uma empresa para continuar.');
      const user = await this.prisma.user.findUnique({ where: { id: payload.sub }, select: { status: true } });
      if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('Sessão ausente ou expirada.');
      req.auth = base;
      return true;
    }

    // Um token de suporte nunca pode herdar uma eventual membership do agente no tenant:
    // a autorização temporária e o modo somente leitura prevalecem durante toda a sessão.
    if (payload.sid) {
      const support = await this.prisma.withContext({ tenantId: payload.tid, userId: payload.sub }, (tx) =>
        tx.$queryRaw<{ ok: boolean; allow_write: boolean }[]>`SELECT * FROM support_validate(${payload.sid}::uuid, ${payload.sub}::uuid, ${payload.tid}::uuid)`,
      );
      if (support[0]?.ok) {
        const allowWrite = support[0].allow_write;
        const exitingSupport = req.method === 'POST' && req.originalUrl.startsWith('/api/platform/support/exit');
        if (!allowWrite && !SAFE_METHODS.has(req.method) && !exitingSupport) throw new ForbiddenException('Este acesso de suporte foi autorizado somente para leitura.');
        const user = await this.prisma.user.findUnique({ where: { id: payload.sub }, select: { status: true } });
        if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('Sessão ausente ou expirada.');
        const permissions = new Set<string>(allowWrite ? ALL_PERMISSIONS : ALL_PERMISSIONS.filter((p) => p.endsWith('.view') || p === 'sales.view_all'));
        if (requiresTenantSuperAdmin(req.method, req.originalUrl) && !permissions.has('tenant.super_admin')) throw new ForbiddenException('Área restrita ao super administrador do tenant.');
        for (const perm of required) if (!permissions.has(perm)) throw new ForbiddenException('O acesso de suporte não inclui esta permissão.');
        req.auth = { ...base, tenantId: payload.tid, roleKey: 'support', permissions, supportSessionId: payload.sid, supportAllowWrite: allowWrite };
        return true;
      }
      throw new ForbiddenException('A autorização de suporte está inativa ou expirada.');
    }

    const membership = await this.prisma.withContext({ tenantId: payload.tid, userId: payload.sub }, (tx) =>
      tx.membership.findFirst({
        where: { tenantId: payload.tid!, userId: payload.sub, status: 'ACTIVE' },
        include: {
          user: { select: { status: true } },
          tenant: { select: { status: true, trialEndsAt: true } },
          role: { include: { permissions: { select: { permission: true } } } },
        },
      }),
    );
    if (!membership || membership.user.status !== 'ACTIVE') throw new ForbiddenException('Você não tem acesso a esta empresa.');
    if (membership.tenant.status === 'SUSPENDED') {
      throw new ForbiddenException('Assinatura suspensa. Entre em contato com o suporte.');
    }

    // Avaliação encerrada: somente leitura até a plataforma ativar um plano (login/sessão seguem funcionando).
    if (membership.tenant.status === 'TRIAL' && membership.tenant.trialEndsAt && membership.tenant.trialEndsAt < new Date() && !SAFE_METHODS.has(req.method) && !req.originalUrl.startsWith('/api/auth') && !req.originalUrl.startsWith('/api/platform')) {
      throw new HttpException('O período de avaliação terminou: o sistema está em modo somente leitura. Contrate um plano para continuar.', HttpStatus.PAYMENT_REQUIRED);
    }

    const ctx: AuthContext = {
      ...base,
      tenantId: payload.tid,
      membershipId: membership.id,
      roleKey: membership.role.key,
      permissions: new Set(membership.role.permissions.map((p) => p.permission)),
    };
    if (requiresTenantSuperAdmin(req.method, req.originalUrl) && !ctx.permissions.has('tenant.super_admin')) throw new ForbiddenException('Área restrita ao super administrador do tenant.');
    for (const perm of required) {
      if (!ctx.permissions.has(perm)) throw new ForbiddenException('Você não tem permissão para esta ação.');
    }
    req.auth = ctx;
    return true;
  }
}
