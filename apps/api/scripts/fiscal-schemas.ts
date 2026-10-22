// Gera schemas/MANIFEST.json (hash de cada XSD) depois de trocar o pacote de schemas.
// Uso: npm run fiscal:schemas -- "<origem do pacote, ex.: Pacote de Liberação PL_010f (portal oficial)>"
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(__dirname, '..', 'src', 'fiscal', 'sefaz', 'schemas');
const files = readdirSync(dir).filter((f) => f.endsWith('.xsd')).sort();
const source = process.argv[2] ?? 'não informada';
const manifest = {
  source, package: 'ver origem', generatedAt: new Date().toISOString(), files: files.length,
  sha256: Object.fromEntries(files.map((f) => [f, createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')])),
};
writeFileSync(join(dir, 'MANIFEST.json'), JSON.stringify(manifest, null, 1));
console.log(`MANIFEST.json gerado com ${files.length} arquivos. Origem: ${source}`);
