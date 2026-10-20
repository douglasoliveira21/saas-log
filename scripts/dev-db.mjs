// PostgreSQL de desenvolvimento isolado do projeto (sem Docker): cluster em .data/pg na porta 5439.
// Uso: node scripts/dev-db.mjs start|stop|status   (defina PG_BIN se pg_ctl não estiver no PATH)
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const data = join(root, '.data', 'pg');
const log = join(root, '.data', 'pg.log');
const bin = (name) => (process.env.PG_BIN ? join(process.env.PG_BIN, name) : name);
const run = (name, args) => spawnSync(bin(name), args, { stdio: ['ignore', 'inherit', 'inherit'] });
const port = process.env.DEV_DB_PORT ?? '5439';

const cmd = process.argv[2];
if (cmd === 'start') {
  if (!existsSync(join(data, 'PG_VERSION'))) {
    run('initdb', ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C']);
  }
  run('pg_ctl', ['-D', data, '-o', `-p ${port}`, '-l', log, '-w', 'start']);
} else if (cmd === 'stop') {
  run('pg_ctl', ['-D', data, '-m', 'fast', 'stop']);
} else if (cmd === 'status') {
  run('pg_ctl', ['-D', data, 'status']);
} else {
  console.error('Uso: node scripts/dev-db.mjs start|stop|status');
  process.exit(1);
}
