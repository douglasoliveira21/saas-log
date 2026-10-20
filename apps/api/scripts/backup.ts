// Backup e verificação de restauração do PostgreSQL.
//   npm run backup -- [arquivo]            gera backup (formato custom do pg_dump); cifra se BACKUP_KEY estiver definida
//   npm run restore:check -- <arquivo>     restaura em um banco TEMPORÁRIO, compara com a origem e remove o temporário
// Um backup só vale depois de restaurado: `restore:check` é o teste a agendar (ver docs/DEPLOYMENT.md).
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync, openSync, readSync, closeSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('DHBK1');

/** Localiza um binário do PostgreSQL: PG_BIN, PATH ou instalações padrão do Windows/Linux. */
export function pgBin(name: string): string {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const dirs = [process.env.PG_BIN, ...(process.platform === 'win32' && existsSync('C:/Program Files/PostgreSQL') ? readdirSync('C:/Program Files/PostgreSQL').sort().reverse().map((v) => `C:/Program Files/PostgreSQL/${v}/bin`) : []), '/usr/bin', '/usr/local/bin'].filter(Boolean) as string[];
  for (const d of dirs) if (existsSync(join(d, exe))) return join(d, exe);
  return name; // confia no PATH
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`${cmd} falhou (${r.status}): ${(r.stderr || r.stdout || '').slice(0, 800)}`);
  return r.stdout;
}

function conn(url: string) {
  const u = new URL(url);
  return { host: u.hostname, port: u.port || '5432', user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), db: u.pathname.slice(1) };
}
const pgEnv = (c: ReturnType<typeof conn>): NodeJS.ProcessEnv => ({ ...process.env, ...(c.password ? { PGPASSWORD: c.password } : {}) });
const common = (c: ReturnType<typeof conn>) => ['-h', c.host, '-p', c.port, '-U', c.user];

function keyFrom(b64?: string): Buffer | null {
  if (!b64) return null;
  const k = Buffer.from(b64, 'base64');
  if (k.length !== 32) throw new Error('BACKUP_KEY deve ter 32 bytes em base64.');
  return k;
}

export async function encryptFile(src: string, dest: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const out = createWriteStream(dest);
  out.write(Buffer.concat([MAGIC, iv]));
  await pipeline(createReadStream(src), cipher, out, { end: false });
  out.end(cipher.getAuthTag());
  await new Promise<void>((r) => out.on('finish', () => r()));
}

export async function decryptFile(src: string, dest: string, key: Buffer) {
  const size = statSync(src).size;
  const fd = openSync(src, 'r');
  const head = Buffer.alloc(MAGIC.length + 12);
  const tag = Buffer.alloc(16);
  readSync(fd, head, 0, head.length, 0);
  readSync(fd, tag, 0, 16, size - 16);
  closeSync(fd);
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Arquivo de backup cifrado inválido.');
  const d = createDecipheriv('aes-256-gcm', key, head.subarray(MAGIC.length));
  d.setAuthTag(tag);
  await pipeline(createReadStream(src, { start: head.length, end: size - 17 }), d, createWriteStream(dest));
}

/** Gera o backup lógico. Retorna o caminho final (com extensão .enc se cifrado). */
export async function backup(directUrl: string, file: string, backupKey = process.env.BACKUP_KEY): Promise<string> {
  const c = conn(directUrl);
  mkdirSync(dirname(file), { recursive: true });
  const raw = backupKey ? `${file}.tmp` : file;
  run(pgBin('pg_dump'), [...common(c), '-d', c.db, '-Fc', '--no-password', '-f', raw], pgEnv(c));
  const key = keyFrom(backupKey);
  if (!key) return raw;
  await encryptFile(raw, `${file}.enc`, key);
  rmSync(raw);
  return `${file}.enc`;
}

const TABLES = `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations' ORDER BY 1`;

async function snapshot(url: string) {
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const tables = (await db.$queryRawUnsafe<{ t: string }[]>(TABLES)).map((r) => r.t);
    const counts: Record<string, number> = {};
    for (const t of tables) counts[t] = Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${t}"`))[0].n);
    const [rls] = await db.$queryRawUnsafe<{ forced: bigint; policies: bigint; functions: bigint }[]>(
      `SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relforcerowsecurity) AS forced,
              (SELECT count(*) FROM pg_policies WHERE schemaname='public') AS policies,
              (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef) AS functions`);
    const migrations = Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL`))[0].n);
    return { counts, forced: Number(rls.forced), policies: Number(rls.policies), securityDefiner: Number(rls.functions), migrations };
  } finally {
    await db.$disconnect();
  }
}

export interface RestoreReport { ok: boolean; problems: string[]; tables: number; rows: number; isolation: { withoutTenant: number; withTenant: number } }

/**
 * Restaura o backup em um banco temporário, compara com a origem e remove o temporário.
 * Verifica: contagem de linhas por tabela, RLS (tabelas forçadas, políticas, funções SECURITY DEFINER), migrações aplicadas
 * e — como o papel de runtime — que sem tenant nada é visível e com tenant só aparecem dados dele.
 */
export async function restoreCheck(directUrl: string, file: string, opts: { backupKey?: string; runtimeUser?: string; runtimePassword?: string } = {}): Promise<RestoreReport> {
  const c = conn(directUrl);
  const tmpDb = `restore_check_${Date.now().toString(36)}`;
  const admin = (sql: string) => run(pgBin('psql'), [...common(c), '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql], pgEnv(c));
  let dumpFile = file;
  const key = keyFrom(opts.backupKey ?? process.env.BACKUP_KEY);
  if (file.endsWith('.enc')) {
    if (!key) throw new Error('Backup cifrado: defina BACKUP_KEY.');
    dumpFile = `${file}.dec.tmp`;
    await decryptFile(file, dumpFile, key);
  }
  const problems: string[] = [];
  try {
    admin(`CREATE DATABASE "${tmpDb}"`);
    run(pgBin('pg_restore'), [...common(c), '-d', tmpDb, '--no-password', '--exit-on-error', dumpFile], pgEnv(c));
    const restoredUrl = directUrl.replace(/\/[^/?]+(\?|$)/, `/${tmpDb}$1`);
    const [a, b] = [await snapshot(directUrl), await snapshot(restoredUrl)];
    for (const t of Object.keys(a.counts)) {
      if (!(t in b.counts)) problems.push(`tabela ausente: ${t}`);
      else if (a.counts[t] !== b.counts[t]) problems.push(`${t}: origem ${a.counts[t]} × restaurado ${b.counts[t]}`);
    }
    for (const k of ['forced', 'policies', 'securityDefiner', 'migrations'] as const) if (a[k] !== b[k]) problems.push(`${k}: origem ${a[k]} × restaurado ${b[k]}`);

    // Isolamento como o papel de runtime (sem BYPASSRLS) no banco restaurado.
    const user = opts.runtimeUser ?? 'dh_app';
    const pass = opts.runtimePassword ?? process.env.DH_APP_PASSWORD ?? '';
    admin(`GRANT CONNECT ON DATABASE "${tmpDb}" TO ${user}`);
    const { PrismaClient } = await import('@prisma/client');
    const rt = new PrismaClient({ datasources: { db: { url: `postgresql://${user}:${encodeURIComponent(pass)}@${c.host}:${c.port}/${tmpDb}` } } });
    const isolation = { withoutTenant: -1, withTenant: -1 };
    try {
      isolation.withoutTenant = await rt.$transaction(async (tx) => Number((await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM customers`))[0].n));
      const tenants = await snapshotTenants(directUrl);
      const first = tenants.find((t) => t.customers > 0);
      if (first) {
        isolation.withTenant = await rt.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${first.id}', true)`);
          return Number((await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM customers`))[0].n);
        });
        if (isolation.withTenant !== first.customers) problems.push(`isolamento: tenant tinha ${first.customers} clientes, restaurado mostra ${isolation.withTenant}`);
      }
      if (isolation.withoutTenant !== 0) problems.push(`isolamento: sem tenant o papel de runtime enxergou ${isolation.withoutTenant} clientes`);
    } finally {
      await rt.$disconnect();
    }
    return { ok: problems.length === 0, problems, tables: Object.keys(b.counts).length, rows: Object.values(b.counts).reduce((s, n) => s + n, 0), isolation };
  } finally {
    try { admin(`DROP DATABASE IF EXISTS "${tmpDb}" WITH (FORCE)`); } catch { /* melhor esforço */ }
    if (dumpFile !== file) rmSync(dumpFile, { force: true });
  }
}

async function snapshotTenants(url: string) {
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    return (await db.$queryRawUnsafe<{ id: string; customers: bigint }[]>(`SELECT tenant_id AS id, count(*) AS customers FROM customers GROUP BY tenant_id ORDER BY 2 DESC LIMIT 5`)).map((r) => ({ id: r.id, customers: Number(r.customers) }));
  } finally {
    await db.$disconnect();
  }
}

async function main() {
  const { loadEnv } = await import('../src/config/app.config');
  loadEnv();
  const [cmd, arg] = process.argv.slice(2);
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error('DIRECT_URL não definido.');
  if (cmd === 'backup') {
    const file = arg ?? join('backups', `dh-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`);
    console.log(`Backup gerado: ${await backup(url, file)}`);
  } else if (cmd === 'restore-check') {
    if (!arg) throw new Error('Informe o arquivo de backup.');
    const r = await restoreCheck(url, arg);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 2);
  } else {
    console.log('Uso: tsx scripts/backup.ts backup [arquivo] | restore-check <arquivo>');
  }
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
