// Acrescenta aos papéis de SISTEMA existentes as permissões novas do catálogo (nunca remove nada).
import { SYSTEM_ROLES } from '../src/access/permissions';

export async function syncSystemRoles(url?: string): Promise<number> {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: url ?? process.env.DIRECT_URL } } });
  let added = 0;
  try {
    for (const def of SYSTEM_ROLES) {
      const roles = await prisma.role.findMany({ where: { key: def.key, isSystem: true }, select: { id: true, tenantId: true } });
      for (const r of roles) {
        const res = await prisma.rolePermission.createMany({
          data: def.permissions.map((permission) => ({ roleId: r.id, tenantId: r.tenantId, permission })),
          skipDuplicates: true,
        });
        added += res.count;
      }
    }
  } finally {
    await prisma.$disconnect();
  }
  return added;
}
