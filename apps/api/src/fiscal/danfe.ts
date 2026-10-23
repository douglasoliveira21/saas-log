import { DOMImplementation, XMLSerializer } from '@xmldom/xmldom';
import { XMLParser } from 'fast-xml-parser';
import JsBarcode from 'jsbarcode';
import QRCode from 'qrcode';

type J = Record<string, unknown>;
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true, isArray: (n) => n === 'det' || n === 'detPag' || n === 'dup' || n === 'vol' || n === 'NFref' });

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const o = (v: unknown): J => (v && typeof v === 'object' ? (v as J) : {});
const s = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const num = (v: unknown) => Number(s(v) || 0);
const brl = (v: unknown) => num(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (v: unknown) => num(v).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
const money4 = (v: unknown) => num(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const cnpjCpf = (v: unknown) => { const d = s(v).replace(/\D/g, ''); return d.length === 14 ? d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : d.length === 11 ? d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : d; };
const dateTime = (v: unknown) => { const t = s(v); const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}:\d{2}))?/.exec(t); return m ? `${m[3]}/${m[2]}/${m[1]}${m[4] ? ` ${m[4]}` : ''}` : t; };
const dateOnly = (v: unknown) => dateTime(v).slice(0, 10);
export const formatKey = (k: string) => k.replace(/(\d{4})/g, '$1 ').trim();
const PAY: Record<string, string> = { '01': 'Dinheiro', '02': 'Cheque', '03': 'Cartão de crédito', '04': 'Cartão de débito', '05': 'Crédito loja', '10': 'Vale alimentação', '11': 'Vale refeição', '12': 'Vale presente', '13': 'Vale combustível', '15': 'Boleto bancário', '16': 'Depósito bancário', '17': 'Pix', '18': 'Transferência', '19': 'Programa de fidelidade', '90': 'Sem pagamento', '99': 'Outros' };

/** Código de barras Code 128 (conjunto C) da chave de acesso, como SVG. */
export function barcodeSvg(value: string, opts: { height?: number; width?: number } = {}): string {
  const doc = new DOMImplementation().createDocument('http://www.w3.org/2000/svg', 'svg', null);
  const svg = doc.documentElement as unknown as Element;
  JsBarcode(svg, value, { xmlDocument: doc as unknown as Document, format: 'CODE128C', displayValue: false, height: opts.height ?? 40, width: opts.width ?? 1, margin: 0 });
  return new XMLSerializer().serializeToString(svg as never);
}

async function qrSvg(text: string): Promise<string> { return QRCode.toString(text, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }); }

export interface ParsedNfe { model: string; key: string; protocol: string | null; protocolDate: string | null; cStat: string | null; env: string; root: J }

/** Lê o XML da NF-e/NFC-e (nfeProc, NFe ou procNFe) e devolve os blocos principais. */
export function parseNfe(xml: string): ParsedNfe {
  const j = parser.parse(xml) as J;
  const proc = o(j.nfeProc ?? j.procNFe);
  const nfe = o(proc.NFe ?? j.NFe);
  const inf = o(nfe.infNFe);
  if (!Object.keys(inf).length) throw new Error('XML sem infNFe: não é uma NF-e/NFC-e.');
  const prot = o(o(proc.protNFe).infProt);
  const ide = o(inf.ide);
  return {
    model: s(ide.mod), key: s(inf['@_Id']).replace(/^NFe/, ''), protocol: s(prot.nProt) || null, protocolDate: s(prot.dhRecbto) || null, cStat: s(prot.cStat) || null, env: s(ide.tpAmb),
    root: { ...inf, infNFeSupl: o(nfe.infNFeSupl) },
  };
}

const css = `*{box-sizing:border-box}body{margin:0;font:11px Arial,Helvetica,sans-serif;color:#000}.pg{width:210mm;margin:0 auto;padding:6mm}.box{border:1px solid #000;padding:2px 4px;min-height:9mm}.box b{display:block;font-size:8px;font-weight:400;text-transform:uppercase;color:#222}.box span{font-size:11px;font-weight:600;word-break:break-word}.row{display:flex;gap:0}.row>*{flex:1}h3{margin:6px 0 2px;font-size:9px;text-transform:uppercase}table{width:100%;border-collapse:collapse;font-size:9px}th,td{border:1px solid #000;padding:2px 3px;text-align:left;vertical-align:top}th{font-size:8px;text-transform:uppercase;background:#f1f1f1}.n{text-align:right}.mark{border:2px solid #b00;color:#b00;text-align:center;font-weight:700;padding:3px;margin-bottom:4px}.small{font-size:8px;color:#333}@media print{body{background:#fff}.pg{width:auto;padding:0}.noprint{display:none}@page{size:A4;margin:6mm}}`;

/** DANFE (NF-e, modelo 55, retrato) gerado a partir do XML autorizado. O documento com valor jurídico é o XML. */
export function renderDanfe(xml: string): string {
  const p = parseNfe(xml); const inf = p.root;
  const ide = o(inf.ide), emit = o(inf.emit), dest = o(inf.dest), tot = o(o(inf.total).ICMSTot), transp = o(inf.transp), cobr = o(inf.cobr), pag = o(inf.pag), info = o(inf.infAdic);
  const enderEmit = o(emit.enderEmit), enderDest = o(dest.enderDest);
  const addr = (e: J) => [s(e.xLgr), s(e.nro), s(e.xCpl)].filter(Boolean).join(', ') + (s(e.xBairro) ? ` - ${s(e.xBairro)}` : '');
  const cityUf = (e: J) => [s(e.xMun), s(e.UF)].filter(Boolean).join('/');
  const items = (inf.det as J[] | undefined) ?? [];
  const taxOf = (d: J) => { const imp = o(o(d.imposto).ICMS); const g = o(Object.values(imp)[0]); return { cst: s(g.CST) || s(g.CSOSN), bc: s(g.vBC), v: s(g.vICMS), a: s(g.pICMS) }; };
  const rows = items.map((d) => { const pr = o(d.prod); const t = taxOf(d); return `<tr><td>${esc(pr.cProd)}</td><td>${esc(pr.xProd)}</td><td>${esc(pr.NCM)}</td><td>${esc(t.cst)}</td><td>${esc(pr.CFOP)}</td><td>${esc(pr.uCom)}</td><td class="n">${qty(pr.qCom)}</td><td class="n">${money4(pr.vUnCom)}</td><td class="n">${brl(pr.vProd)}</td><td class="n">${t.bc ? brl(t.bc) : ''}</td><td class="n">${t.v ? brl(t.v) : ''}</td><td class="n">${t.a ? brl(t.a) : ''}</td></tr>`; }).join('');
  const dups = ((cobr.dup as J[] | undefined) ?? []).map((d) => `<div>${esc(d.nDup)} · ${dateOnly(d.dVenc)} · R$ ${brl(d.vDup)}</div>`).join('');
  const pays = ((pag.detPag as J[] | undefined) ?? []).map((d) => `${esc(PAY[s(d.tPag)] ?? s(d.tPag))} R$ ${brl(d.vPag)}`).join(' · ');
  const vol = ((transp.vol as J[] | undefined) ?? [])[0] ?? {};
  const trans = o(transp.transporta);
  const mod = ['0', '1', '2', '3', '4', '9'].includes(s(transp.modFrete)) ? ({ '0': '0 - Remetente (CIF)', '1': '1 - Destinatário (FOB)', '2': '2 - Terceiros', '3': '3 - Próprio remetente', '4': '4 - Próprio destinatário', '9': '9 - Sem frete' } as Record<string, string>)[s(transp.modFrete)] : '';
  const homolog = p.env === '2' ? '<div class="mark">AMBIENTE DE HOMOLOGAÇÃO — SEM VALOR FISCAL</div>' : '';
  const authorized = p.protocol && ['100', '150'].includes(p.cStat ?? '');
  const box = (label: string, value: unknown, flex = 1) => `<div class="box" style="flex:${flex}"><b>${label}</b><span>${esc(value)}</span></div>`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>DANFE ${esc(s(ide.nNF))}</title><style>${css}</style></head><body><div class="pg">${homolog}${authorized ? '' : '<div class="mark">DOCUMENTO SEM PROTOCOLO DE AUTORIZAÇÃO — NÃO É UM DANFE VÁLIDO</div>'}
<div class="row">
  <div class="box" style="flex:3"><b>Recebemos de ${esc(emit.xNome)} os produtos constantes da nota fiscal indicada ao lado</b><span>Data de recebimento: ____/____/______ &nbsp; Identificação e assinatura do recebedor: ____________________</span></div>
  <div class="box" style="flex:1;text-align:center"><b>NF-e</b><span>Nº ${esc(ide.nNF)}<br>Série ${esc(ide.serie)}</span></div>
</div>
<div class="row" style="margin-top:3px">
  <div class="box" style="flex:2.2"><b>Emitente</b><span style="font-size:13px">${esc(emit.xNome)}</span><div class="small">${esc(addr(enderEmit))}<br>${esc(s(enderEmit.CEP))} ${esc(cityUf(enderEmit))} ${esc(s(enderEmit.fone))}</div></div>
  <div class="box" style="flex:1;text-align:center"><span style="font-size:15px">DANFE</span><div class="small">Documento Auxiliar da Nota Fiscal Eletrônica</div><div style="margin-top:4px"><b style="display:inline">${s(ide.tpNF) === '0' ? '0 - ENTRADA' : '1 - SAÍDA'}</b></div><div>Nº ${esc(ide.nNF)} · Série ${esc(ide.serie)}</div></div>
  <div class="box" style="flex:2.2"><b>Chave de acesso</b><div style="margin:3px 0">${barcodeSvg(p.key, { height: 36, width: 1.2 })}</div><span style="font-size:10px">${esc(formatKey(p.key))}</span><div class="small">Consulta de autenticidade no portal nacional da NF-e (www.nfe.fazenda.gov.br/portal) ou no site da SEFAZ autorizadora.</div></div>
</div>
<div class="row">${box('Natureza da operação', ide.natOp, 2)}${box('Protocolo de autorização de uso', p.protocol ? `${p.protocol} - ${dateTime(p.protocolDate)}` : '—', 1.4)}</div>
<div class="row">${box('Inscrição estadual', emit.IE)}${box('IE do substituto tributário', emit.IEST)}${box('CNPJ', cnpjCpf(emit.CNPJ))}</div>
<h3>Destinatário / remetente</h3>
<div class="row">${box('Nome / razão social', dest.xNome, 3)}${box('CNPJ / CPF', cnpjCpf(dest.CNPJ ?? dest.CPF))}${box('Data da emissão', dateOnly(ide.dhEmi))}</div>
<div class="row">${box('Endereço', addr(enderDest), 3)}${box('Bairro', enderDest.xBairro)}${box('CEP', enderDest.CEP)}${box('Data da saída', dateOnly(ide.dhSaiEnt ?? ide.dhEmi))}</div>
<div class="row">${box('Município', enderDest.xMun, 2)}${box('UF', enderDest.UF, 0.5)}${box('Fone', enderDest.fone)}${box('Inscrição estadual', dest.IE)}</div>
${dups ? `<h3>Fatura / duplicatas</h3><div class="box">${dups}</div>` : ''}
<h3>Cálculo do imposto</h3>
<div class="row">${box('Base de cálculo do ICMS', brl(tot.vBC))}${box('Valor do ICMS', brl(tot.vICMS))}${box('Base de cálculo do ICMS ST', brl(tot.vBCST))}${box('Valor do ICMS ST', brl(tot.vST))}${box('Valor total dos produtos', brl(tot.vProd))}</div>
<div class="row">${box('Valor do frete', brl(tot.vFrete))}${box('Valor do seguro', brl(tot.vSeg))}${box('Desconto', brl(tot.vDesc))}${box('Outras despesas', brl(tot.vOutro))}${box('Valor do IPI', brl(tot.vIPI))}${box('Valor total da nota', brl(tot.vNF))}</div>
<h3>Transportador / volumes transportados</h3>
<div class="row">${box('Nome / razão social', trans.xNome, 2.5)}${box('Frete por conta', mod, 1.4)}${box('CNPJ / CPF', cnpjCpf(trans.CNPJ ?? trans.CPF))}${box('Placa', o(transp.veicTransp).placa)}</div>
<div class="row">${box('Quantidade', o(vol).qVol)}${box('Espécie', o(vol).esp)}${box('Marca', o(vol).marca)}${box('Peso bruto', o(vol).pesoB)}${box('Peso líquido', o(vol).pesoL)}</div>
<h3>Dados dos produtos / serviços</h3>
<table><thead><tr><th>Código</th><th>Descrição</th><th>NCM</th><th>CST/CSOSN</th><th>CFOP</th><th>UN</th><th class="n">Qtd.</th><th class="n">V. unit.</th><th class="n">V. total</th><th class="n">BC ICMS</th><th class="n">V. ICMS</th><th class="n">Alíq.</th></tr></thead><tbody>${rows}</tbody></table>
<h3>Dados adicionais</h3>
<div class="row"><div class="box" style="flex:2;min-height:18mm"><b>Informações complementares</b><span style="font-weight:400">${esc(info.infCpl)}</span>${pays ? `<div class="small" style="margin-top:4px">Pagamento: ${pays}</div>` : ''}</div><div class="box" style="min-height:18mm"><b>Reservado ao fisco</b><span style="font-weight:400">${esc(info.infAdFisco)}</span></div></div>
<p class="small">DANFE gerado pelo sistema a partir do XML da NF-e. O documento com validade jurídica é o arquivo XML autorizado pela SEFAZ.</p></div></body></html>`;
}

/** DANFE NFC-e (modelo 65), formato bobina 80 mm, com QR Code a partir do XML autorizado. */
export async function renderDanfce(xml: string): Promise<string> {
  const p = parseNfe(xml); const inf = p.root;
  const ide = o(inf.ide), emit = o(inf.emit), dest = o(inf.dest), tot = o(o(inf.total).ICMSTot), pag = o(inf.pag), info = o(inf.infAdic), supl = o(inf.infNFeSupl);
  const enderEmit = o(emit.enderEmit);
  const items = (inf.det as J[] | undefined) ?? [];
  const rows = items.map((d, i) => { const pr = o(d.prod); return `<tr><td>${i + 1}</td><td>${esc(pr.cProd)} ${esc(pr.xProd)}</td><td class="n">${qty(pr.qCom)} ${esc(pr.uCom)}</td><td class="n">${brl(pr.vUnCom)}</td><td class="n">${brl(pr.vProd)}</td></tr>`; }).join('');
  const pays = ((pag.detPag as J[] | undefined) ?? []).map((d) => `<div class="r"><span>${esc(PAY[s(d.tPag)] ?? s(d.tPag))}</span><span>${brl(d.vPag)}</span></div>`).join('');
  const qr = s(supl.qrCode); const urlKey = s(supl.urlChave);
  const qrImg = qr ? await qrSvg(qr) : '';
  const homolog = p.env === '2' ? '<div class="mark">EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO — SEM VALOR FISCAL</div>' : '';
  const css80 = `*{box-sizing:border-box}body{margin:0;font:11px 'Courier New',monospace}.cp{width:80mm;margin:0 auto;padding:3mm}.c{text-align:center}.r{display:flex;justify-content:space-between}table{width:100%;border-collapse:collapse;font-size:10px}td{padding:1px 0;vertical-align:top}.n{text-align:right}hr{border:0;border-top:1px dashed #000;margin:4px 0}.mark{border:2px solid #000;text-align:center;font-weight:700;padding:2px;margin:3px 0}.qr svg{width:38mm;height:38mm}@media print{@page{size:80mm auto;margin:0}}`;
  const authorized = p.protocol && ['100', '150'].includes(p.cStat ?? '');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>DANFE NFC-e ${esc(ide.nNF)}</title><style>${css80}</style></head><body><div class="cp">
<div class="c"><b>${esc(emit.xNome)}</b><br>CNPJ ${cnpjCpf(emit.CNPJ)} ${s(emit.IE) ? `IE ${esc(emit.IE)}` : ''}<br>${esc([s(enderEmit.xLgr), s(enderEmit.nro), s(enderEmit.xBairro), s(enderEmit.xMun) + '/' + s(enderEmit.UF)].filter(Boolean).join(', '))}</div><hr>
<div class="c"><b>DANFE NFC-e - Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica</b></div>${homolog}${authorized ? '' : '<div class="mark">SEM PROTOCOLO DE AUTORIZAÇÃO</div>'}<hr>
<table><thead><tr><td>#</td><td>Descrição</td><td class="n">Qtd</td><td class="n">Unit.</td><td class="n">Total</td></tr></thead><tbody>${rows}</tbody></table><hr>
<div class="r"><span>Qtd. total de itens</span><span>${items.length}</span></div>
<div class="r"><span>Valor total R$</span><span>${brl(tot.vProd)}</span></div>
${num(tot.vDesc) ? `<div class="r"><span>Desconto R$</span><span>${brl(tot.vDesc)}</span></div>` : ''}
<div class="r"><b>Valor a pagar R$</b><b>${brl(tot.vNF)}</b></div>
<div style="margin-top:3px"><b>Forma de pagamento</b></div>${pays}<hr>
${num(tot.vTotTrib) ? `<div class="small">Tributos totais incidentes (Lei Federal 12.741/2012): R$ ${brl(tot.vTotTrib)}</div><hr>` : ''}
<div class="c">Número ${esc(ide.nNF)} Série ${esc(ide.serie)} Emissão ${dateTime(ide.dhEmi)}<br>${authorized ? `Protocolo de autorização: ${esc(p.protocol)}<br>Data de autorização: ${dateTime(p.protocolDate)}<br>` : ''}</div><hr>
<div class="c">Consulte pela Chave de Acesso em<br>${esc(urlKey)}<br><b>${esc(formatKey(p.key))}</b></div>
<div class="c" style="margin-top:4px"><b>CONSUMIDOR${dest.CPF || dest.CNPJ ? ` - ${dest.CPF ? 'CPF' : 'CNPJ'} ${cnpjCpf(dest.CPF ?? dest.CNPJ)}` : ' NÃO IDENTIFICADO'}</b></div>
<div class="c qr" style="margin-top:6px">${qrImg}</div>
${s(info.infCpl) ? `<hr><div>${esc(info.infCpl)}</div>` : ''}
</div></body></html>`;
}
