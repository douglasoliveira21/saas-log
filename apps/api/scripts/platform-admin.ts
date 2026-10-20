// Concede/revoga administrador da plataforma. Só por aqui (acesso direto ao banco): não existe rota de API para isso.
//   npm run platform-admin -- grant usuario@empresa.com
//   npm run platform-admin -- revoke usuario@empresa.com
//   npm run platform-admin -- list
import { loadEnv } from '../src/config/app.config';

async function main() {
  loadEnv();
  const [cmd, emailRaw] = process.argv.slice(2);
  if (!process.env.DIRECT_URL) throw new Error('DIRECT_URL não definido.');
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
  try {
    if (cmd === 'list') {
      console.table(await db.$queryRaw`SELECT u.email, u.status, a.created_at FROM platform_admins a JOIN users u ON u.id = a.user_id ORDER BY a.created_at`);
      return;
    }
    if (!['grant', 'revoke'].includes(cmd ?? '') || !emailRaw) throw new Error('Uso: platform-admin grant|revoke <email> | list');
    const email = emailRaw.trim().toLowerCase();
    const user = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) throw new Error(`Usuário não encontrado: ${email}`);
    if (cmd === 'grant') await db.$executeRaw`INSERT INTO platform_admins (user_id) VALUES (${user.id}::uuid) ON CONFLICT DO NOTHING`;
    else await db.$executeRaw`DELETE FROM platform_admins WHERE user_id = ${user.id}::uuid`;
    await db.$executeRaw`INSERT INTO platform_audit_log (actor_user_id, action, metadata) VALUES (NULL, ${'platform.admin_' + cmd}, ${JSON.stringify({ email, via: 'cli' })}::jsonb)`;
    console.log(`${cmd === 'grant' ? 'Concedido a' : 'Revogado de'} ${email}.`);
  } finally {
    await db.$disconnect();
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
