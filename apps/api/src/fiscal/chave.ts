// Chave de acesso da NF-e (44 dígitos) e validadores determinísticos (sem regra tributária).
// Composição: cUF(2) AAMM(4) CNPJ(14) mod(2) série(3) nNF(9) tpEmis(1) cNF(8) cDV(1).

/** Códigos IBGE das UFs usados na chave. */
export const UF_CODE: Record<string, string> = {
  RO: '11', AC: '12', AM: '13', RR: '14', PA: '15', AP: '16', TO: '17', MA: '21', PI: '22', CE: '23', RN: '24', PB: '25', PE: '26', AL: '27', SE: '28', BA: '29',
  MG: '31', ES: '32', RJ: '33', SP: '35', PR: '41', SC: '42', RS: '43', MS: '50', MT: '51', GO: '52', DF: '53',
};
export const UF_BY_CODE = Object.fromEntries(Object.entries(UF_CODE).map(([uf, code]) => [code, uf]));

/** Dígito verificador módulo 11 (pesos 2..9 da direita para a esquerda). */
export function chaveDv(first43: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = first43.length - 1; i >= 0; i--) {
    sum += Number(first43[i]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

export interface ChaveParts {
  uf: string; // sigla
  ufCode: string;
  yearMonth: string; // AAMM
  cnpj: string;
  model: string;
  series: number;
  number: number;
  tpEmis: string;
  cNF: string;
  dv: number;
}

export function parseChave(chave: string): ChaveParts | null {
  if (!/^\d{44}$/.test(chave)) return null;
  return {
    ufCode: chave.slice(0, 2), uf: UF_BY_CODE[chave.slice(0, 2)] ?? '??', yearMonth: chave.slice(2, 6), cnpj: chave.slice(6, 20), model: chave.slice(20, 22),
    series: Number(chave.slice(22, 25)), number: Number(chave.slice(25, 34)), tpEmis: chave.slice(34, 35), cNF: chave.slice(35, 43), dv: Number(chave[43]),
  };
}

export function isValidChave(chave: string): boolean {
  return /^\d{44}$/.test(chave) && chaveDv(chave.slice(0, 43)) === Number(chave[43]);
}

export function buildChave(p: { uf: string; issuedAt: Date; cnpj: string; model?: string; series: number; number: number; tpEmis?: string; cNF?: string }): string {
  const code = UF_CODE[p.uf];
  if (!code) throw new Error(`UF inválida: ${p.uf}`);
  // AAMM é o da data de emissão no horário de Brasília (o mesmo de dhEmi): perto da virada do mês o UTC já está no mês seguinte.
  const [yy, mm] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: '2-digit', month: '2-digit' }).format(p.issuedAt).split('-');
  const aamm = `${yy}${mm}`;
  const cNF = p.cNF ?? String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  const base = `${code}${aamm}${p.cnpj.padStart(14, '0')}${(p.model ?? '55').padStart(2, '0')}${String(p.series).padStart(3, '0')}${String(p.number).padStart(9, '0')}${p.tpEmis ?? '1'}${cNF}`;
  if (base.length !== 43) throw new Error('Composição da chave inválida.');
  return base + chaveDv(base);
}

/** GTIN-8/12/13/14: dígito verificador GS1 (módulo 10). */
export function isValidGtin(code: string): boolean {
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop()!;
  let sum = 0;
  digits.reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}
