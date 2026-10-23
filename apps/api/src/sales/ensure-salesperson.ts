import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/auth';

/** Cadastro de vendedor do usuário logado; se ainda não existe, é criado com o nome e o e-mail dele. Cadastro inativo não é recriado. */
export async function ensureSalesperson(tx: Prisma.TransactionClient, ctx: AuthContext, audit: AuditService): Promise<{ id: string } | null> {
  if (!ctx.userId) return null;
  const active = await tx.salesperson.findFirst({ where: { tenantId: ctx.tenantId!, userId: ctx.userId, active: true }, select: { id: true } });
  if (active) return active;
  if (await tx.salesperson.findFirst({ where: { tenantId: ctx.tenantId!, userId: ctx.userId }, select: { id: true } })) return null; // existe, mas inativo
  const u = await tx.user.findUnique({ where: { id: ctx.userId }, select: { name: true, email: true } });
  if (!u) return null;
  const sp = await tx.salesperson.create({ data: { tenantId: ctx.tenantId!, name: u.name, email: u.email, userId: ctx.userId }, select: { id: true } });
  await audit.record(tx, ctx, { action: 'salesperson.auto_created', entity: 'salesperson', entityId: sp.id, metadata: { name: u.name } });
  return sp;
}
