import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const dynamic = 'force-dynamic';

/** Lista os logotipos oficiais colocados em public/marketplaces (chave do canal → arquivo). Só nomes de arquivo, nada sensível. */
export function GET() {
  let files: string[] = [];
  try { files = readdirSync(join(process.cwd(), 'public', 'marketplaces')); } catch { /* pasta ausente */ }
  const out: Record<string, string> = {};
  for (const f of files) {
    const m = /^([a-z0-9_]+)\.(svg|png|webp|jpe?g)$/i.exec(f);
    if (m) out[m[1].toLowerCase()] = `/marketplaces/${f}`;
  }
  return Response.json(out, { headers: { 'cache-control': 'no-store' } });
}
