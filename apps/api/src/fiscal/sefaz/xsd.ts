import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateXML } from 'xmllint-wasm';

/**
 * Validação do XML contra os schemas (XSD) do pacote em schemas/. O pacote em uso e a origem ficam em schemas/MANIFEST.json (com hash de cada arquivo).
 * ATENÇÃO: a cópia atual vem do projeto de código aberto `sped-nfe` (espelho do pacote PL_010 v1.30), NÃO do download oficial do Portal da NF-e,
 * que não pôde ser baixado automaticamente. Para usar o pacote oficial, substitua o conteúdo de schemas/ pelos XSD do pacote de liberação vigente e
 * rode `npm run fiscal:schemas` para gerar o novo manifesto. O pacote vigente em produção pode ser MAIS NOVO que o espelho: a SEFAZ sempre prevalece.
 */
export interface SchemaIssue { message: string; line?: number }
export interface SchemaResult { valid: boolean; errors: SchemaIssue[] }

function schemaDir(): string {
  const candidates = [process.env.FISCAL_SCHEMAS_DIR, join(__dirname, 'schemas'), resolve(process.cwd(), 'src/fiscal/sefaz/schemas'), resolve(process.cwd(), 'apps/api/src/fiscal/sefaz/schemas')].filter(Boolean) as string[];
  const dir = candidates.find((d) => existsSync(join(d, 'leiauteNFe_v4.00.xsd')));
  if (!dir) throw new Error('Schemas oficiais da NF-e não encontrados (defina FISCAL_SCHEMAS_DIR).');
  return dir;
}

let cache: { dir: string; files: { fileName: string; contents: string }[] } | null = null;
function files() {
  if (!cache) {
    const dir = schemaDir();
    cache = { dir, files: readdirSync(dir).filter((f) => f.endsWith('.xsd')).map((f) => ({ fileName: f, contents: readFileSync(join(dir, f), 'utf8') })) };
  }
  return cache.files;
}

export function schemaManifest(): { source: string; package: string; files: number } {
  const dir = schemaDir();
  const m = join(dir, 'MANIFEST.json');
  return existsSync(m) ? (JSON.parse(readFileSync(m, 'utf8')) as { source: string; package: string; files: number }) : { source: 'desconhecida', package: 'desconhecido', files: files().length };
}

/** `main` é o XSD raiz da mensagem (ex.: nfe_v4.00.xsd, enviNFe_v4.00.xsd, procNFe_v4.00.xsd). */
export async function validateAgainst(main: string, xml: string): Promise<SchemaResult> {
  const all = files();
  const root = all.find((f) => f.fileName === main);
  if (!root) throw new Error(`Schema ${main} não encontrado no pacote.`);
  const r = await validateXML({ xml: [{ fileName: 'doc.xml', contents: xml }], schema: [root], preload: all.filter((f) => f.fileName !== main) });
  return { valid: r.valid, errors: r.errors.map((e) => ({ message: e.message.replace(/^Schemas validity error : /, ''), line: e.loc?.lineNumber })) };
}
