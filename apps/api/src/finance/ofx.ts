import { createHash } from 'node:crypto';
import { parseCsv, parseDecimal } from '../catalog/csv';

export interface StatementLine {
  fitid: string;
  postedAt: Date;
  amount: number; // com sinal
  description: string;
}

export interface StatementParse {
  lines: StatementLine[];
  errors: { line: number; message: string }[];
}

/** OFX 1.x (SGML) e 2.x (XML): lê apenas as transações (STMTTRN). Datas YYYYMMDD[HHMMSS]; valores com ponto decimal. */
export function parseOfx(text: string): StatementParse {
  const lines: StatementLine[] = [];
  const errors: { line: number; message: string }[] = [];
  const blocks = text.match(/<STMTTRN>[\s\S]*?(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi) ?? [];
  blocks.forEach((b, i) => {
    const tag = (name: string) => b.match(new RegExp(`<${name}>\\s*([^<\\r\\n]*)`, 'i'))?.[1]?.trim() ?? '';
    const dt = tag('DTPOSTED').match(/^(\d{4})(\d{2})(\d{2})/);
    const amount = Number(tag('TRNAMT').replace(',', '.'));
    const fitid = tag('FITID');
    if (!dt || !Number.isFinite(amount) || !fitid) { errors.push({ line: i + 1, message: 'transação OFX incompleta (DTPOSTED, TRNAMT ou FITID)' }); return; }
    lines.push({ fitid, postedAt: new Date(Date.UTC(+dt[1], +dt[2] - 1, +dt[3])), amount: Math.round(amount * 100) / 100, description: (tag('MEMO') || tag('NAME') || 'Lançamento').slice(0, 200) });
  });
  if (!blocks.length) errors.push({ line: 1, message: 'nenhuma transação (STMTTRN) encontrada no arquivo OFX' });
  return { lines, errors };
}

/** CSV de extrato: colunas data;descricao;valor[;id]. Datas dd/mm/aaaa ou aaaa-mm-dd; valores no padrão BR. */
export function parseStatementCsv(text: string): StatementParse {
  const table = parseCsv(text);
  const errors: { line: number; message: string }[] = [];
  const lines: StatementLine[] = [];
  if (table.length < 2) return { lines, errors: [{ line: 1, message: 'arquivo vazio' }] };
  const norm = (h: string) => h.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  const head = table[0].map(norm);
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const [iDate, iDesc, iAmt, iId] = [col('data', 'date'), col('descricao', 'historico', 'description', 'memo'), col('valor', 'amount'), col('id', 'fitid', 'documento')];
  if (iDate < 0 || iAmt < 0) return { lines, errors: [{ line: 1, message: 'cabeçalho deve conter "data" e "valor"' }] };
  table.slice(1).forEach((cells, idx) => {
    const lineNo = idx + 2;
    const raw = (cells[iDate] ?? '').trim();
    const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/) ?? raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    const amount = parseDecimal((cells[iAmt] ?? '').replace(/^\+/, ''));
    if (!m || Number.isNaN(amount)) { errors.push({ line: lineNo, message: 'data ou valor inválido' }); return; }
    const [y, mo, d] = raw.includes('/') ? [+m[3], +m[2], +m[1]] : [+m[1], +m[2], +m[3]];
    const postedAt = new Date(Date.UTC(y, mo - 1, d));
    const description = ((iDesc >= 0 ? cells[iDesc] : '') ?? '').trim().slice(0, 200) || 'Lançamento';
    const given = iId >= 0 ? (cells[iId] ?? '').trim() : '';
    // Sem identificador no arquivo: derivamos um estável (data+valor+histórico+nº da repetição) para que reimportar não duplique.
    const fitid = given || createHash('sha1').update(`${postedAt.toISOString().slice(0, 10)}|${amount}|${description}`).digest('hex').slice(0, 20);
    lines.push({ fitid, postedAt, amount: Math.round(amount * 100) / 100, description });
  });
  // Linhas idênticas no mesmo arquivo recebem sufixo sequencial (são lançamentos distintos).
  const seen = new Map<string, number>();
  for (const l of lines) {
    const n = (seen.get(l.fitid) ?? 0) + 1;
    seen.set(l.fitid, n);
    if (n > 1) l.fitid = `${l.fitid}#${n}`;
  }
  return { lines, errors };
}
