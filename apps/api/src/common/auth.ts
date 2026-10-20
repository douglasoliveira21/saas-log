import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';

export interface AuthContext {
  userId: string;
  tenantId: string | null;
  membershipId: string | null;
  roleKey: string | null;
  permissions: Set<string>;
  ip?: string;
}

export type AuthedRequest = Request & { auth?: AuthContext };

export const IS_PUBLIC = 'isPublic';
export const ALLOW_NO_TENANT = 'allowNoTenant';
export const REQUIRED_PERMISSIONS = 'requiredPermissions';

/** Rota sem autenticação (login, registro, saúde). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Rota que exige usuário autenticado mas ainda sem tenant selecionado. */
export const AllowNoTenant = () => SetMetadata(ALLOW_NO_TENANT, true);
/** Permissões exigidas (todas). Verificadas no servidor a partir do banco, nunca do token. */
export const RequirePermissions = (...perms: string[]) => SetMetadata(REQUIRED_PERMISSIONS, perms);

export const CurrentAuth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.auth) throw new Error('Contexto de autenticação ausente');
  return req.auth;
});

export const COOKIE_ACCESS = 'dh_at';
export const COOKIE_REFRESH = 'dh_rt';
export const CSRF_HEADER = 'x-dh-csrf';

/**
 * Contexto de sistema para trabalhos em segundo plano (importações, reconciliações): sem usuário, enxerga todos os
 * pedidos do tenant. O isolamento continua garantido pelo RLS (app.tenant_id).
 */
export function systemContext(tenantId: string): AuthContext {
  return { userId: null as unknown as string, tenantId, membershipId: null, roleKey: 'system', permissions: new Set(['sales.view_all']) };
}
