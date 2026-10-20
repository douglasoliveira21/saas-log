// Dados de demonstração (SOMENTE desenvolvimento). Dois tenants para exercitar o isolamento.
import { loadEnv } from '../src/config/app.config';
import { SYSTEM_ROLES } from '../src/access/permissions';
import { hashPassword } from '../src/common/password';

loadEnv();
if (process.env.NODE_ENV === 'production') throw new Error('Seed bloqueado em produção.');

import { PrismaClient } from '@prisma/client';

// Conexão administrativa (dono do schema): ignora RLS, só para o seed.
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });

async function createTenant(name: string, slug: string, ownerEmail: string, ownerName: string, extra: { email: string; name: string; role: string }[]) {
  const existing = await prisma.tenant.findUnique({ where: { slug } });
  if (existing) return console.log(`Tenant ${slug} já existe — mantido.`);
  const password = await hashPassword(process.env.SEED_PASSWORD ?? 'Demo@123456');
  const plan = await prisma.plan.findUnique({ where: { code: 'trial' } });
  const tenant = await prisma.tenant.create({ data: { name, slug, planId: plan?.id, status: 'ACTIVE' } });
  const roles = new Map<string, string>();
  for (const def of SYSTEM_ROLES) {
    const r = await prisma.role.create({ data: { tenantId: tenant.id, key: def.key, name: def.name, isSystem: true } });
    await prisma.rolePermission.createMany({
      data: def.permissions.map((permission) => ({ roleId: r.id, tenantId: tenant.id, permission })),
    });
    roles.set(def.key, r.id);
  }
  const people = [{ email: ownerEmail, name: ownerName, role: 'owner' }, ...extra];
  for (const p of people) {
    const user = await prisma.user.upsert({
      where: { email: p.email },
      update: {},
      create: { email: p.email, name: p.name, passwordHash: password },
    });
    await prisma.membership.create({ data: { tenantId: tenant.id, userId: user.id, roleId: roles.get(p.role)! } });
  }
  const company = await prisma.company.create({
    data: { tenantId: tenant.id, legalName: `${name} LTDA`, tradeName: name, taxRegime: 'SIMPLES_NACIONAL' },
  });
  const est = await prisma.establishment.create({
    data: { tenantId: tenant.id, companyId: company.id, kind: 'MATRIZ', name: 'Matriz', city: 'Campinas', state: 'SP' },
  });
  await prisma.warehouse.create({ data: { tenantId: tenant.id, establishmentId: est.id, code: 'CD01', name: 'Depósito Principal' } });
  console.log(`Tenant ${slug} criado (${people.map((p) => p.email).join(', ')}).`);
}

async function main() {
  await createTenant('Distribuidora Demo', 'demo', 'dono@demo.local', 'Dona Demo', [
    { email: 'vendedor@demo.local', name: 'Vera Vendedora', role: 'salesperson' },
    { email: 'auditor@demo.local', name: 'Caio Auditor', role: 'auditor' },
  ]);
  await createTenant('Atacado Exemplo', 'exemplo', 'dono@exemplo.local', 'Eduardo Exemplo', []);
}

main().finally(() => prisma.$disconnect());
