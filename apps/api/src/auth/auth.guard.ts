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

interface AccessPayload {
  sub: string;
  tid?: string | null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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
    if (!membership || membership.user.status !== 'ACTIVE') {
      throw new ForbiddenException('Você não tem acesso a esta empresa.');
    }
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
    for (const perm of required) {
      if (!ctx.permissions.has(perm)) throw new ForbiddenException('Você não tem permissão para esta ação.');
    }
    req.auth = ctx;
    return true;
  }
}
