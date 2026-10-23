import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateXML } from 'xmllint-wasm';

/**
 * Validação do XML do MDF-e contra os schemas (XSD) de mdfe/schemas/. ATENÇÃO: a cópia vem do projeto de código aberto `sped-mdfe`
 * (PL_MDFe_300b, leiaute 3.00), NÃO do download oficial do Portal do MDF-e. Para usar o pacote oficial, substitua o conteúdo de schemas/.
 */
export interface SchemaIssue { message: string; line?: number }
export interface SchemaResult { valid: boolean; errors: SchemaIssue[] }

function schemaDir(): string {
  const candidates = [process.env.MDFE_SCHEMAS_DIR, join(__dirname, 'schemas'), resolve(process.cwd(), 'src/fiscal/mdfe/schemas'), resolve(process.cwd(), 'apps/api/src/fiscal/mdfe/schemas')].filter(Boolean) as string[];
  const dir = candidates.find((d) => existsSync(join(d, 'mdfe_v3.00.xsd')));
  if (!dir) throw new Error('Schemas do MDF-e não encontrados (defina MDFE_SCHEMAS_DIR).');
  return dir;
}

let cache: { fileName: string; contents: string }[] | null = null;
const files = () => (cache ??= readdirSync(schemaDir()).filter((f) => f.endsWith('.xsd')).map((f) => ({ fileName: f, contents: readFileSync(join(schemaDir(), f), 'utf8') })));

export async function validateMdfe(main: string, xml: string): Promise<SchemaResult> {
  const all = files();
  const root = all.find((f) => f.fileName === main);
  if (!root) throw new Error(`Schema ${main} não encontrado no pacote do MDF-e.`);
  const r = await validateXML({ xml: [{ fileName: 'doc.xml', contents: xml }], schema: [root], preload: all.filter((f) => f.fileName !== main) });
  return { valid: r.valid, errors: r.errors.map((e) => ({ message: e.message.replace(/^Schemas validity error : /, ''), line: e.loc?.lineNumber })) };
}

/** O XSD do MDF-e deixa o conteúdo do modal (infModal) livre: valida o MDF-e e, à parte, o bloco <rodo> no XSD do modal rodoviário. */
export async function validateMdfeFull(xml: string): Promise<SchemaResult> {
  const main = await validateMdfe('mdfe_v3.00.xsd', xml);
  const rodo = /<rodo[\s>][\s\S]*?<\/rodo>/.exec(xml)?.[0];
  if (!rodo) return { valid: false, errors: [...main.errors, { message: 'MDF-e sem o bloco do modal rodoviário (rodo).' }] };
  const modal = await validateMdfe('mdfeModalRodoviario_v3.00.xsd', rodo.replace('<rodo', `<rodo xmlns="http://www.portalfiscal.inf.br/mdfe"`));
  return { valid: main.valid && modal.valid, errors: [...main.errors, ...modal.errors] };
}
