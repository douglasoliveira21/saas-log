// Cria papéis de SISTEMA novos nas empresas existentes e acrescenta aos existentes as permissões novas do catálogo (nunca remove nada).
import { SYSTEM_ROLES } from '../src/access/permissions';

export async function syncSystemRoles(url?: string): Promise<number> {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: url ?? process.env.DIRECT_URL } } });
  let added = 0;
  try {
    // Papéis de sistema NOVOS (ex.: Motorista) passam a existir também nas empresas já criadas.
    const tenants = await prisma.tenant.findMany({ select: { id: true } });
    for (const def of SYSTEM_ROLES) {
      for (const t of tenants) {
        const has = await prisma.role.findFirst({ where: { tenantId: t.id, key: def.key }, select: { id: true } });
        if (!has) await prisma.role.create({ data: { tenantId: t.id, key: def.key, name: def.name, isSystem: true } });
      }
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
