import { createHash } from 'node:crypto';

/**
 * Montagem do XML da NF-e/NFC-e (leiaute 4.00) a partir de dados neutros. A conformidade ESTRUTURAL é conferida contra o XSD do pacote em schemas/
 * (testes); as REGRAS DE NEGÓCIO da SEFAZ (rejeições) só se confirmam em homologação real.
 */
export type NfeEnv = 'HOMOLOGACAO' | 'PRODUCAO';

export interface NfeAddress { street: string; number: string; complement?: string | null; district: string; cMun: string; city: string; uf: string; zip: string; phone?: string | null }

export interface NfeItem {
  line: number;
  code: string;
  gtin: string | null;
  description: string;
  ncm: string;
  cest?: string | null;
  cfop: string;
  unit: string;
  quantity: number;
  /** Valor total do item (já líquido de desconto). */
  total: number;
  freight?: number;
  /** ICMS: 'SN' (Simples Nacional, CSOSN) ou 'NORMAL' (CST). */
  icms: { origin: number; regime: 'SN' | 'NORMAL'; code: string; base?: number; rate?: number; amount?: number };
  pis: { cst: string; base?: number; rate?: number; amount?: number };
  cofins: { cst: string; base?: number; rate?: number; amount?: number };
}

export interface NfeInput {
  model: '55' | '65';
  environment: NfeEnv;
  /** Chave de acesso de 44 dígitos (cUF, AAMM, CNPJ, mod, série, nNF, tpEmis, cNF, cDV já compostos). */
  chave: string;
  natOp: string;
  issuedAt: Date;
  idDest: 1 | 2 | 3;
  indFinal: 0 | 1;
  indPres: 0 | 1 | 2 | 3 | 4 | 5 | 9;
  cMunFG: string;
  emitter: NfeAddress & { cnpj: string; name: string; tradeName?: string | null; ie: string; crt: 1 | 2 | 3 | 4; im?: string | null; cnae?: string | null };
  recipient: null | (Partial<NfeAddress> & { cnpj?: string; cpf?: string; name: string; indIEDest: 1 | 2 | 9; ie?: string | null; email?: string | null });
  items: NfeItem[];
  freight: number;
  payments: { tPag: string; vPag: number }[];
  additionalInfo?: string | null;
  /** Devolução: finNFe 4, tpNF 0 (entrada própria) e chaves das notas referenciadas (NFref). */
  returnOf?: string[];
  procVersion: string;
  /** NFC-e: QR Code (versão 2.00, online) e URL de consulta por chave. */
  qr?: { url: string; cscId: string; csc: string; consultaChaveUrl: string };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
/** Texto de campo livre: sem quebras, espaços duplicados ou espaços nas pontas (a SEFAZ rejeita). */
const txt = (s: string, max: number) => esc(s.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max));
const dec = (n: number, d = 2) => n.toFixed(d);
const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');
const tag = (name: string, value: string | number | null | undefined) => (value === null || value === undefined || value === '' ? '' : `<${name}>${value}</${name}>`);

export const HOMOLOG_NAME = 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';
export const HOMOLOG_PRODUCT = 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';

function brt(d: Date): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}-03:00`;
}

function address(tagName: string, a: Partial<NfeAddress>, withPais: boolean): string {
  return `<${tagName}>${tag('xLgr', txt(a.street ?? '', 60))}${tag('nro', txt(a.number ?? 'S/N', 60))}${a.complement ? tag('xCpl', txt(a.complement, 60)) : ''}${tag('xBairro', txt(a.district ?? '', 60))}${tag('cMun', a.cMun)}${tag('xMun', txt(a.city ?? '', 60))}${tag('UF', a.uf)}${tag('CEP', digits(a.zip))}${withPais ? '<cPais>1058</cPais><xPais>Brasil</xPais>' : ''}${a.phone ? tag('fone', digits(a.phone).slice(0, 14)) : ''}</${tagName}>`;
}

/** Rateia o frete em centavos proporcionalmente ao valor dos itens; o resto vai para o último (a soma tem de bater com o total). */
export function allocateFreight(totals: number[], freight: number): number[] {
  const cents = Math.round(freight * 100);
  const sum = totals.reduce((s, t) => s + Math.round(t * 100), 0);
  if (cents === 0 || sum === 0) return totals.map(() => 0);
  const parts = totals.map((t) => Math.floor((cents * Math.round(t * 100)) / sum));
  parts[parts.length - 1] += cents - parts.reduce((s, p) => s + p, 0);
  return parts.map((p) => p / 100);
}

function icmsXml(i: NfeItem['icms']): string {
  const o = tag('orig', i.origin);
  if (i.regime === 'SN') {
    if (['102', '103', '300', '400'].includes(i.code)) return `<ICMS><ICMSSN102>${o}<CSOSN>${i.code}</CSOSN></ICMSSN102></ICMS>`;
    throw new Error(`CSOSN ${i.code} ainda não suportado pelo conector direto (suportados: 102, 103, 300, 400).`);
  }
  if (i.code === '00') return `<ICMS><ICMS00>${o}<CST>00</CST><modBC>3</modBC><vBC>${dec(i.base ?? 0)}</vBC><pICMS>${dec(i.rate ?? 0, 4)}</pICMS><vICMS>${dec(i.amount ?? 0)}</vICMS></ICMS00></ICMS>`;
  if (['40', '41', '50'].includes(i.code)) return `<ICMS><ICMS40>${o}<CST>${i.code}</CST></ICMS40></ICMS>`;
  throw new Error(`CST ${i.code} de ICMS ainda não suportado pelo conector direto (suportados: 00, 40, 41, 50).`);
}

function pisCofins(kind: 'PIS' | 'COFINS', t: NfeItem['pis']): string {
  const r = kind === 'PIS' ? { aliq: 'PISAliq', nt: 'PISNT', outr: 'PISOutr', p: 'pPIS', v: 'vPIS' } : { aliq: 'COFINSAliq', nt: 'COFINSNT', outr: 'COFINSOutr', p: 'pCOFINS', v: 'vCOFINS' };
  const vals = `<vBC>${dec(t.base ?? 0)}</vBC><${r.p}>${dec(t.rate ?? 0, 4)}</${r.p}><${r.v}>${dec(t.amount ?? 0)}</${r.v}>`;
  if (['01', '02'].includes(t.cst)) return `<${kind}><${r.aliq}><CST>${t.cst}</CST>${vals}</${r.aliq}></${kind}>`;
  if (['04', '05', '06', '07', '08', '09'].includes(t.cst)) return `<${kind}><${r.nt}><CST>${t.cst}</CST></${r.nt}></${kind}>`;
  if (t.cst === '03') throw new Error(`CST 03 de ${kind} (por quantidade) não é suportado pelo conector direto.`);
  return `<${kind}><${r.outr}><CST>${t.cst}</CST>${vals}</${r.outr}></${kind}>`;
}

/** SHA-1 em hexadecimal maiúsculo do QR Code 2.00 (online): `chave|2|tpAmb|cscId` + CSC. */
export function qrCodeV2(url: string, chave: string, env: NfeEnv, cscId: string, csc: string): string {
  const seq = `${chave}|2|${env === 'PRODUCAO' ? 1 : 2}|${Number(cscId)}`;
  const hash = createHash('sha1').update(seq + csc).digest('hex').toUpperCase();
  return `${url}${url.includes('?p=') ? '' : '?p='}${seq}|${hash}`;
}

export function buildNfeXml(n: NfeInput): string {
  if (!/^\d{44}$/.test(n.chave)) throw new Error('Chave de acesso inválida.');
  const cNF = n.chave.slice(35, 43);
  const cDV = n.chave.slice(43);
  const serie = Number(n.chave.slice(22, 25));
  const nNF = Number(n.chave.slice(25, 34));
  const tpAmb = n.environment === 'PRODUCAO' ? 1 : 2;
  const is65 = n.model === '65';
  const frete = allocateFreight(n.items.map((i) => i.total), n.freight);

  const items = n.items.map((i, idx) => {
    const homologFirst = n.environment === 'HOMOLOGACAO' && is65 && idx === 0; // [A VALIDAR] regra do primeiro item em homologação da NFC-e
    const gtin = i.gtin && /^\d{8}$|^\d{12,14}$/.test(i.gtin) ? i.gtin : 'SEM GTIN';
    const vUn = i.total / i.quantity;
    return `<det nItem="${i.line}"><prod>${tag('cProd', txt(i.code, 60))}${tag('cEAN', gtin)}${tag('xProd', homologFirst ? HOMOLOG_PRODUCT : txt(i.description, 120))}${tag('NCM', digits(i.ncm))}${i.cest ? tag('CEST', digits(i.cest)) : ''}${tag('CFOP', i.cfop)}${tag('uCom', txt(i.unit, 6))}${tag('qCom', dec(i.quantity, 4))}${tag('vUnCom', vUn.toFixed(10).replace(/0+$/, '').replace(/\.$/, '.0').replace(/^(\d+)\.(\d)$/, '$1.$2'))}${tag('vProd', dec(i.total))}${tag('cEANTrib', gtin)}${tag('uTrib', txt(i.unit, 6))}${tag('qTrib', dec(i.quantity, 4))}${tag('vUnTrib', vUn.toFixed(10).replace(/0+$/, '').replace(/\.$/, '.0'))}${frete[idx] > 0 ? tag('vFrete', dec(frete[idx])) : ''}<indTot>1</indTot></prod><imposto>${icmsXml(i.icms)}${pisCofins('PIS', i.pis)}${pisCofins('COFINS', i.cofins)}</imposto></det>`;
  });

  const sum = (f: (i: NfeItem) => number) => n.items.reduce((s, i) => s + Math.round(f(i) * 100), 0) / 100;
  const vProd = sum((i) => i.total);
  const vFrete = frete.reduce((s, f) => s + Math.round(f * 100), 0) / 100;
  const vBC = sum((i) => (i.icms.code === '00' ? i.icms.base ?? 0 : 0));
  const vICMS = sum((i) => (i.icms.code === '00' ? i.icms.amount ?? 0 : 0));
  const vPIS = sum((i) => i.pis.amount ?? 0);
  const vCOFINS = sum((i) => i.cofins.amount ?? 0);
  const vNF = Math.round((vProd + vFrete) * 100) / 100;

  const e = n.emitter;
  const emit = `<emit>${tag('CNPJ', digits(e.cnpj))}${tag('xNome', txt(e.name, 60))}${e.tradeName ? tag('xFant', txt(e.tradeName, 60)) : ''}${address('enderEmit', e, true)}${tag('IE', digits(e.ie))}${e.im ? tag('IM', txt(e.im, 15)) + (e.cnae ? tag('CNAE', digits(e.cnae)) : '') : ''}${tag('CRT', e.crt)}</emit>`;

  let dest = '';
  const r = n.recipient;
  if (r) {
    const id = r.cnpj ? tag('CNPJ', digits(r.cnpj)) : r.cpf ? tag('CPF', digits(r.cpf)) : '';
    const name = n.environment === 'HOMOLOGACAO' ? HOMOLOG_NAME : txt(r.name, 60);
    dest = `<dest>${id}${tag('xNome', name)}${!is65 && r.street ? address('enderDest', r, true) : ''}${tag('indIEDest', r.indIEDest)}${r.indIEDest === 1 && r.ie ? tag('IE', digits(r.ie)) : ''}${r.email ? tag('email', txt(r.email, 60)) : ''}</dest>`;
  }

  const pag = `<pag>${n.payments.map((p) => `<detPag>${tag('tPag', p.tPag)}${p.tPag === '99' ? '<xPag>Outros</xPag>' : ''}${tag('vPag', dec(p.vPag))}${['03', '04'].includes(p.tPag) ? '<card><tpIntegra>2</tpIntegra></card>' : ''}</detPag>`).join('')}</pag>`;

  const total = `<total><ICMSTot><vBC>${dec(vBC)}</vBC><vICMS>${dec(vICMS)}</vICMS><vICMSDeson>0.00</vICMSDeson><vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet><vProd>${dec(vProd)}</vProd><vFrete>${dec(vFrete)}</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>${dec(vPIS)}</vPIS><vCOFINS>${dec(vCOFINS)}</vCOFINS><vOutro>0.00</vOutro><vNF>${dec(vNF)}</vNF></ICMSTot></total>`;

  const paid = n.payments.reduce((s, p) => s + Math.round(p.vPag * 100), 0);
  if (paid < Math.round(vNF * 100) && !n.returnOf) throw new Error(`O total pago (${dec(paid / 100)}) é menor que o valor da nota (${dec(vNF)}).`);

  const ide = `<ide>${tag('cUF', n.chave.slice(0, 2))}${tag('cNF', cNF)}${tag('natOp', txt(n.natOp, 60))}${tag('mod', n.model)}${tag('serie', serie)}${tag('nNF', nNF)}${tag('dhEmi', brt(n.issuedAt))}${is65 ? '' : tag('dhSaiEnt', brt(n.issuedAt))}${tag('tpNF', n.returnOf ? 0 : 1)}${tag('idDest', n.idDest)}${tag('cMunFG', n.cMunFG)}${tag('tpImp', is65 ? 4 : 1)}${tag('tpEmis', n.chave.slice(34, 35))}${tag('cDV', cDV)}${tag('tpAmb', tpAmb)}${tag('finNFe', n.returnOf ? 4 : 1)}${tag('indFinal', n.indFinal)}${tag('indPres', n.indPres)}${tag('procEmi', 0)}${tag('verProc', txt(n.procVersion, 20))}${(n.returnOf ?? []).map((k) => `<NFref><refNFe>${k}</refNFe></NFref>`).join('')}</ide>`;

  const infAdic = n.additionalInfo ? `<infAdic>${tag('infCpl', txt(n.additionalInfo, 2000))}</infAdic>` : '';
  const supl = is65 && n.qr ? `<infNFeSupl><qrCode>${esc(qrCodeV2(n.qr.url, n.chave, n.environment, n.qr.cscId, n.qr.csc))}</qrCode><urlChave>${esc(n.qr.consultaChaveUrl)}</urlChave></infNFeSupl>` : '';

  return `<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe${n.chave}" versao="4.00">${ide}${emit}${dest}${items.join('')}${total}<transp><modFrete>${n.freight > 0 ? 0 : 9}</modFrete></transp>${pag}${infAdic}</infNFe>${supl}</NFe>`;
}
