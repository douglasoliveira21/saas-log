import { XMLParser } from 'fast-xml-parser';
import { isValidChave, isValidGtin, parseChave } from './chave';
import { onlyDigits } from '../common/cnpj';

// Leitura e validação ESTRUTURAL de NF-e (modelo 55, leiaute 4.00) recebida de fornecedores.
// Não interpreta regra tributária: os valores de impostos são apenas guardados "como declarados".
// NÃO verifica a assinatura digital nem consulta a SEFAZ: a autenticidade fica sempre como NÃO VERIFICADA.

export const MAX_XML_BYTES = 2 * 1024 * 1024;

export type Severity = 'BLOCKING' | 'WARNING' | 'INFO';
export interface Issue { severity: Severity; code: string; message: string }

export interface ParsedItem {
  line: number; supplierCode: string; gtin: string | null; description: string; ncm: string | null; cest: string | null; cfop: string | null; unit: string;
  quantity: number; unitValue: number; totalValue: number; freight: number; discount: number;
  declaredTax: Record<string, unknown>;
}

export interface ParsedNfe {
  accessKey: string;
  version: string;
  model: string;
  series: number;
  number: number;
  issuedAt: Date | null;
  environment: 'HOMOLOGACAO' | 'PRODUCAO' | null;
  natureOfOperation: string;
  emitter: { doc: string; name: string; uf: string; ie: string | null };
  recipient: { doc: string | null; name: string | null };
  items: ParsedItem[];
  totals: Record<string, number>;
  installments: { number: string; dueDate: string | null; value: number }[];
  freightMode: string | null;
  protocol: { number: string; statusCode: string; reason: string | null; environment: string | null } | null;
  hasSignature: boolean;
}

export class NfeParseError extends Error {}

const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, parseTagValue: false, trimValues: true,
  isArray: (name) => ['det', 'dup', 'NFref'].includes(name),
});

const str = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
type Obj = Record<string, any>;

/** Primeiro filho objeto de um grupo (ex.: ICMS → ICMS00/ICMS10/ICMSSN102). */
function firstGroup(g: unknown): Obj {
  if (!g || typeof g !== 'object') return {};
  const first = Object.values(g as Obj).find((v) => v && typeof v === 'object');
  return (first as Obj) ?? (g as Obj);
}

export function parseNfe(xml: string): ParsedNfe {
  if (Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES) throw new NfeParseError('Arquivo XML acima do limite de 2 MB.');
  // Segurança: DTD/entidades externas não são aceitas (XXE / expansão de entidades).
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new NfeParseError('XML com DOCTYPE/ENTITY não é aceito.');
  let doc: Obj;
  try {
    doc = parser.parse(xml) as Obj;
  } catch (e) {
    throw new NfeParseError(`XML malformado: ${(e as Error).message}`);
  }
  const root: Obj | undefined = doc.nfeProc ?? doc;
  const nfe: Obj | undefined = root?.NFe ?? (doc.NFe as Obj | undefined);
  const inf: Obj | undefined = nfe?.infNFe;
  if (!inf) throw new NfeParseError('O arquivo não é uma NF-e (elemento infNFe não encontrado).');

  const ide: Obj = inf.ide ?? {};
  const emit: Obj = inf.emit ?? {};
  const dest: Obj = inf.dest ?? {};
  const tot: Obj = inf.total?.ICMSTot ?? {};
  const idAttr = String(inf['@_Id'] ?? '');
  const accessKey = idAttr.replace(/^NFe/i, '');
  const prot: Obj | undefined = root?.protNFe?.infProt;

  const items: ParsedItem[] = (inf.det ?? []).map((d: Obj, i: number) => {
    const p: Obj = d.prod ?? {};
    const imp: Obj = d.imposto ?? {};
    const icms = firstGroup(imp.ICMS);
    const ipi = firstGroup(imp.IPI);
    const pis = firstGroup(imp.PIS);
    const cofins = firstGroup(imp.COFINS);
    const ean = str(p.cEAN);
    return {
      line: Number(d['@_nItem'] ?? i + 1), supplierCode: String(p.cProd ?? ''), gtin: ean && ean.toUpperCase() !== 'SEM GTIN' ? ean : null,
      description: String(p.xProd ?? ''), ncm: str(p.NCM), cest: str(p.CEST), cfop: str(p.CFOP), unit: String(p.uCom ?? ''),
      quantity: num(p.qCom), unitValue: num(p.vUnCom), totalValue: num(p.vProd), freight: num(p.vFrete), discount: num(p.vDesc),
      declaredTax: {
        origin: str(icms.orig), icms: { cst: str(icms.CST), csosn: str(icms.CSOSN), vBC: str(icms.vBC), pICMS: str(icms.pICMS), vICMS: str(icms.vICMS), vICMSST: str(icms.vICMSST) },
        ipi: { cst: str(ipi.CST), vIPI: str(ipi.vIPI) }, pis: { cst: str(pis.CST), vPIS: str(pis.vPIS) }, cofins: { cst: str(cofins.CST), vCOFINS: str(cofins.vCOFINS) },
      },
    };
  });

  const totals: Record<string, number> = {};
  for (const k of ['vBC', 'vICMS', 'vICMSDeson', 'vFCP', 'vBCST', 'vST', 'vFCPST', 'vProd', 'vFrete', 'vSeg', 'vDesc', 'vII', 'vIPI', 'vIPIDevol', 'vPIS', 'vCOFINS', 'vOutro', 'vNF']) totals[k] = num(tot[k]);

  const dups: Obj[] = inf.cobr?.dup ?? [];
  const tpAmb = str(ide.tpAmb);
  return {
    accessKey, version: String(inf['@_versao'] ?? ''), model: String(ide.mod ?? ''), series: Number(ide.serie ?? 0), number: Number(ide.nNF ?? 0),
    issuedAt: str(ide.dhEmi ?? ide.dEmi) ? new Date(String(ide.dhEmi ?? ide.dEmi)) : null,
    environment: tpAmb === '1' ? 'PRODUCAO' : tpAmb === '2' ? 'HOMOLOGACAO' : null, natureOfOperation: String(ide.natOp ?? ''),
    emitter: { doc: onlyDigits(String(emit.CNPJ ?? emit.CPF ?? '')), name: String(emit.xNome ?? ''), uf: String(emit.enderEmit?.UF ?? ''), ie: str(emit.IE) },
    recipient: { doc: dest.CNPJ || dest.CPF ? onlyDigits(String(dest.CNPJ ?? dest.CPF)) : null, name: str(dest.xNome) },
    items, totals, installments: dups.map((d) => ({ number: String(d.nDup ?? ''), dueDate: str(d.dVenc), value: num(d.vDup) })),
    freightMode: str(inf.transp?.modFrete),
    protocol: prot ? { number: String(prot.nProt ?? ''), statusCode: String(prot.cStat ?? ''), reason: str(prot.xMotivo), environment: str(prot.tpAmb) } : null,
    hasSignature: !!(nfe?.Signature ?? root?.Signature),
  };
}

const near = (a: number, b: number, tol = 0.011) => Math.abs(a - b) <= tol;

/** Validações determinísticas (estrutura, consistência interna, destinatário). Nenhuma delas é regra tributária. */
export function validateNfe(n: ParsedNfe, ctx: { establishmentDocs: string[] }): Issue[] {
  const out: Issue[] = [];
  const add = (severity: Severity, code: string, message: string) => out.push({ severity, code, message });

  if (!isValidChave(n.accessKey)) add('BLOCKING', 'KEY_INVALID', 'Chave de acesso inválida (tamanho ou dígito verificador).');
  else {
    const k = parseChave(n.accessKey)!;
    const mism: string[] = [];
    if (k.cnpj !== n.emitter.doc.padStart(14, '0')) mism.push('CNPJ do emitente');
    if (k.model !== n.model.padStart(2, '0')) mism.push('modelo');
    if (k.series !== n.series) mism.push('série');
    if (k.number !== n.number) mism.push('número');
    if (n.issuedAt && k.yearMonth !== `${String(n.issuedAt.getUTCFullYear()).slice(2)}${String(n.issuedAt.getUTCMonth() + 1).padStart(2, '0')}`) {
      // dhEmi traz fuso: tolera diferença de mês só na virada
      const alt = new Date(n.issuedAt.getTime() - 3 * 3600_000);
      if (k.yearMonth !== `${String(alt.getUTCFullYear()).slice(2)}${String(alt.getUTCMonth() + 1).padStart(2, '0')}`) mism.push('ano/mês de emissão');
    }
    if (mism.length) add('BLOCKING', 'KEY_MISMATCH', `A chave de acesso não confere com os dados do XML: ${mism.join(', ')}.`);
  }
  if (n.model !== '55') add('BLOCKING', 'MODEL_UNSUPPORTED', `Modelo ${n.model || '?'} não suportado para recebimento (esperado 55).`);
  if (n.version !== '4.00') add('WARNING', 'VERSION_UNSUPPORTED', `Leiaute ${n.version || '?'} diferente do 4.00 suportado: confira os dados.`);
  if (!n.recipient.doc || !ctx.establishmentDocs.includes(n.recipient.doc)) {
    add('BLOCKING', 'RECIPIENT_NOT_ESTABLISHMENT', 'A nota não é destinada a nenhum estabelecimento desta empresa (confira o CNPJ do destinatário).');
  }
  if (n.environment === 'HOMOLOGACAO') add('WARNING', 'HOMOLOGATION_DOCUMENT', 'Documento emitido em ambiente de HOMOLOGAÇÃO: não tem valor fiscal.');
  if (!n.protocol) add('WARNING', 'NO_PROTOCOL', 'O XML não contém o protocolo de autorização (nfeProc/protNFe).');
  else if (!['100', '150'].includes(n.protocol.statusCode)) add('BLOCKING', 'NOT_AUTHORIZED', `Protocolo com situação ${n.protocol.statusCode}${n.protocol.reason ? ` (${n.protocol.reason})` : ''}: documento não autorizado para uso.`);
  else if (n.protocol.number === '') add('WARNING', 'PROTOCOL_EMPTY', 'Protocolo sem número.');
  if (!n.hasSignature) add('WARNING', 'NO_SIGNATURE', 'O XML não contém assinatura digital.');
  add('INFO', 'AUTHENTICITY_UNVERIFIED', 'A assinatura digital e a situação na SEFAZ NÃO foram verificadas por este sistema; confirme a autenticidade pelo canal oficial.');

  if (!n.items.length) add('BLOCKING', 'NO_ITEMS', 'A nota não possui itens.');
  const sumProd = n.items.reduce((s, i) => s + i.totalValue, 0);
  if (n.items.length && !near(sumProd, n.totals.vProd, 0.02)) add('BLOCKING', 'TOTAL_PRODUCTS_MISMATCH', `Soma dos itens (${sumProd.toFixed(2)}) difere do total de produtos (${n.totals.vProd.toFixed(2)}).`);
  const t = n.totals;
  const expectedNf = t.vProd - t.vDesc - t.vICMSDeson + t.vST + t.vFCPST + t.vFrete + t.vSeg + t.vOutro + t.vII + t.vIPI + t.vIPIDevol;
  if (!near(expectedNf, t.vNF, 0.02)) add('WARNING', 'TOTAL_INVOICE_MISMATCH', `Valor da nota (${t.vNF.toFixed(2)}) difere da composição dos totais (${expectedNf.toFixed(2)}).`);
  const dupSum = n.installments.reduce((s, d) => s + d.value, 0);
  if (n.installments.length && !near(dupSum, t.vNF, 0.02)) add('WARNING', 'INSTALLMENTS_MISMATCH', `Duplicatas (${dupSum.toFixed(2)}) não somam o valor da nota (${t.vNF.toFixed(2)}).`);

  for (const i of n.items) {
    if (!near(i.quantity * i.unitValue, i.totalValue, Math.max(0.011, i.quantity * 0.000001))) add('WARNING', 'ITEM_MATH', `Item ${i.line}: quantidade × valor unitário não confere com o valor total.`);
    if (!i.ncm || !/^\d{8}$/.test(i.ncm)) add('WARNING', 'NCM_FORMAT', `Item ${i.line}: NCM ausente ou fora do formato de 8 dígitos.`);
    if (i.gtin && !isValidGtin(i.gtin)) add('WARNING', 'GTIN_INVALID', `Item ${i.line}: GTIN com dígito verificador inválido.`);
    if (i.cfop && /^[123]/.test(i.cfop)) add('WARNING', 'CFOP_UNEXPECTED', `Item ${i.line}: CFOP ${i.cfop} é de entrada; em nota emitida pelo fornecedor esperava-se CFOP de saída (5/6/7).`);
    if (i.quantity <= 0) add('BLOCKING', 'ITEM_QTY', `Item ${i.line}: quantidade inválida.`);
  }
  return out;
}
