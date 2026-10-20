// Prepara o banco: aplica migrações (cria o banco se faltar) e habilita o login do papel de runtime dh_app.
// Uso: npm run db:setup [-- --test]   (--test usa o banco distribuihub_test)
import { spawnSync } from 'node:child_process';
import { loadEnv } from '../src/config/app.config';

const isTest = process.argv.includes('--test');
if (isTest) {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://dh_app:dh_app_dev@localhost:5439/distribuihub_test';
  process.env.DIRECT_URL = process.env.DIRECT_URL ?? 'postgresql://postgres@localhost:5439/distribuihub_test';
}
loadEnv();

async function main() {
  const migrate = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit', shell: true, env: process.env });
  if (migrate.status !== 0) process.exit(migrate.status ?? 1);

  const password = process.env.DH_APP_PASSWORD;
  if (!password) throw new Error('DH_APP_PASSWORD não definido.');
  const { PrismaClient } = await import('@prisma/client');
  const admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
  try {
    const escaped = password.replace(/'/g, "''");
    await admin.$executeRawUnsafe(`ALTER ROLE dh_app WITH LOGIN PASSWORD '${escaped}'`);
    const db = new URL(process.env.DIRECT_URL!).pathname.slice(1);
    await admin.$executeRawUnsafe(`ALTER DATABASE "${new URL(process.env.DIRECT_URL!).pathname.slice(1)}" SET timezone TO 'UTC'`);
    await admin.$executeRawUnsafe(`GRANT CONNECT ON DATABASE "${db}" TO dh_app`);
    const { syncSystemRoles } = await import('./sync-roles');
    console.log(`Permissões novas em papéis de sistema: ${await syncSystemRoles()}`);
    console.log(`Banco "${db}" pronto. Papel dh_app habilitado.`);
  } finally {
    await admin.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
