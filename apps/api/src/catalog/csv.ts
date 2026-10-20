// Leitor de CSV simples (RFC 4180 básico) com detecção de separador (; ou ,) e números no padrão BR.

export function detectDelimiter(headerLine: string): string {
  const semi = (headerLine.match(/;/g) ?? []).length;
  const comma = (headerLine.match(/,/g) ?? []).length;
  const tab = (headerLine.match(/\t/g) ?? []).length;
  if (tab > semi && tab > comma) return '\t';
  return semi >= comma ? ';' : ',';
}

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = detectDelimiter(firstLine);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

/** "1.234,56" → 1234.56 ; "1234.56" → 1234.56 ; inválido → NaN */
export function parseDecimal(v: string): number {
  const s = v.trim().replace(/\s|R\$/g, '');
  if (s === '') return NaN;
  const normalized = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  return /^-?\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : NaN;
}

const norm = (h: string) =>
  h.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export interface ImportRow {
  line: number;
  sku: string;
  name: string;
  barcode?: string;
  brand?: string;
  manufacturer?: string;
  category?: string;
  saleUnit?: string;
  costPrice?: number;
  suggestedPrice?: number;
  minPrice?: number;
  minStock?: number;
  ncm?: string;
  cest?: string;
  warehouseCode?: string;
  initialStock?: number;
}

export interface RowError {
  line: number;
  message: string;
}

const ALIASES: Record<string, keyof ImportRow> = {
  sku: 'sku', codigo: 'sku', nome: 'name', produto: 'name', descricao: 'name', codigo_de_barras: 'barcode', codigo_barras: 'barcode',
  gtin: 'barcode', ean: 'barcode', marca: 'brand', fabricante: 'manufacturer', categoria: 'category', unidade: 'saleUnit',
  custo: 'costPrice', preco_custo: 'costPrice', preco_venda: 'suggestedPrice', preco_sugerido: 'suggestedPrice',
  preco_minimo: 'minPrice', estoque_minimo: 'minStock', ncm: 'ncm', cest: 'cest', deposito: 'warehouseCode',
  saldo_inicial: 'initialStock',
};

export const MAX_IMPORT_ROWS = 5000;

export function mapImportRows(text: string): { rows: ImportRow[]; errors: RowError[] } {
  const table = parseCsv(text);
  if (table.length < 2) return { rows: [], errors: [{ line: 1, message: 'Arquivo vazio ou sem linhas de dados.' }] };
  if (table.length - 1 > MAX_IMPORT_ROWS) {
    return { rows: [], errors: [{ line: 1, message: `Limite de ${MAX_IMPORT_ROWS} linhas por importação excedido.` }] };
  }
  const header = table[0].map((h) => ALIASES[norm(h)]);
  if (!header.includes('sku') || !header.includes('name')) {
    return { rows: [], errors: [{ line: 1, message: 'Cabeçalho deve conter ao menos as colunas "sku" e "nome".' }] };
  }
  const rows: ImportRow[] = [];
  const errors: RowError[] = [];
  const seen = new Set<string>();
  table.slice(1).forEach((cells, idx) => {
    const line = idx + 2;
    const raw: Record<string, string> = {};
    header.forEach((key, i) => { if (key) raw[key] = (cells[i] ?? '').trim(); });
    const problems: string[] = [];
    if (!raw.sku) problems.push('sku obrigatório');
    else if (!/^[A-Za-z0-9._\-/]{1,60}$/.test(raw.sku)) problems.push('sku inválido (use letras, números . _ - /)');
    else if (seen.has(raw.sku.toUpperCase())) problems.push(`sku duplicado no arquivo (${raw.sku})`);
    if (!raw.name || raw.name.length < 2) problems.push('nome obrigatório');
    const num = (key: keyof ImportRow, label: string, integer = false): number | undefined => {
      const v = raw[key];
      if (!v) return undefined;
      const n = parseDecimal(v);
      if (Number.isNaN(n) || n < 0 || (integer && !Number.isInteger(n))) { problems.push(`${label} inválido`); return undefined; }
      return n;
    };
    const costPrice = num('costPrice', 'custo');
    const suggestedPrice = num('suggestedPrice', 'preço de venda');
    const minPrice = num('minPrice', 'preço mínimo');
    const minStock = num('minStock', 'estoque mínimo', true);
    const initialStock = num('initialStock', 'saldo inicial', true);
    if (raw.ncm && !/^\d{8}$/.test(raw.ncm.replace(/\D/g, ''))) problems.push('NCM deve ter 8 dígitos');
    if (raw.cest && !/^\d{7}$/.test(raw.cest.replace(/\D/g, ''))) problems.push('CEST deve ter 7 dígitos');
    if (initialStock !== undefined && !raw.warehouseCode) problems.push('saldo inicial exige a coluna depósito');
    if (problems.length) { errors.push({ line, message: problems.join('; ') }); return; }
    seen.add(raw.sku.toUpperCase());
    rows.push({
      line, sku: raw.sku, name: raw.name, barcode: raw.barcode || undefined, brand: raw.brand || undefined,
      manufacturer: raw.manufacturer || undefined, category: raw.category || undefined, saleUnit: raw.saleUnit?.toUpperCase() || undefined,
      costPrice, suggestedPrice, minPrice, minStock,
      ncm: raw.ncm ? raw.ncm.replace(/\D/g, '') : undefined, cest: raw.cest ? raw.cest.replace(/\D/g, '') : undefined,
      warehouseCode: raw.warehouseCode?.toUpperCase() || undefined, initialStock,
    });
  });
  return { rows, errors };
}
