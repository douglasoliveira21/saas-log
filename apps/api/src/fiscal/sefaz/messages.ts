import { XMLParser } from 'fast-xml-parser';
import { SefazEnv, SefazService, UF_IBGE, Uf } from './registry';

/** Mensagens dos serviços da SEFAZ (leiaute 4.00) e leitura das respostas. Operação/método vêm do WSDL dos serviços (conferidos também no projeto sped-nfe). */
export const NS = 'http://www.portalfiscal.inf.br/nfe';

export const OPS: Record<SefazService, { operation: string; method: string }> = {
  status: { operation: 'NFeStatusServico4', method: 'nfeStatusServicoNF' },
  autorizacao: { operation: 'NFeAutorizacao4', method: 'nfeAutorizacaoLote' },
  retAutorizacao: { operation: 'NFeRetAutorizacao4', method: 'nfeRetAutorizacaoLote' },
  consulta: { operation: 'NFeConsultaProtocolo4', method: 'nfeConsultaNF' },
  inutilizacao: { operation: 'NFeInutilizacao4', method: 'nfeInutilizacaoNF' },
  evento: { operation: 'NFeRecepcaoEvento4', method: 'nfeRecepcaoEvento' },
};

const tpAmb = (e: SefazEnv) => (e === 'PRODUCAO' ? 1 : 2);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const enviNFe = (signedNfe: string, idLote: number) => `<enviNFe xmlns="${NS}" versao="4.00"><idLote>${String(idLote).padStart(1, '0').slice(0, 15)}</idLote><indSinc>1</indSinc>${signedNfe}</enviNFe>`;
export const consStatServ = (uf: Uf, env: SefazEnv) => `<consStatServ xmlns="${NS}" versao="4.00"><tpAmb>${tpAmb(env)}</tpAmb><cUF>${UF_IBGE[uf]}</cUF><xServ>STATUS</xServ></consStatServ>`;
export const consSitNFe = (chave: string, env: SefazEnv) => `<consSitNFe xmlns="${NS}" versao="4.00"><tpAmb>${tpAmb(env)}</tpAmb><xServ>CONSULTAR</xServ><chNFe>${chave}</chNFe></consSitNFe>`;
export const consReciNFe = (nRec: string, env: SefazEnv) => `<consReciNFe xmlns="${NS}" versao="4.00"><tpAmb>${tpAmb(env)}</tpAmb><nRec>${nRec}</nRec></consReciNFe>`;

/** Evento de cancelamento (110111), ainda SEM assinatura (a assinatura cobre infEvento e fica dentro de <evento>). */
export function cancelEvent(p: { chave: string; env: SefazEnv; cnpj: string; protocol: string; reason: string; at: string; seq?: number; idLote?: number }): string {
  const seq = String(p.seq ?? 1);
  const id = `ID110111${p.chave}${seq.padStart(2, '0')}`;
  return `<envEvento xmlns="${NS}" versao="1.00"><idLote>${p.idLote ?? 1}</idLote><evento xmlns="${NS}" versao="1.00"><infEvento Id="${id}"><cOrgao>${p.chave.slice(0, 2)}</cOrgao><tpAmb>${tpAmb(p.env)}</tpAmb><CNPJ>${p.cnpj}</CNPJ><chNFe>${p.chave}</chNFe><dhEvento>${p.at}</dhEvento><tpEvento>110111</tpEvento><nSeqEvento>${seq}</nSeqEvento><verEvento>1.00</verEvento><detEvento versao="1.00"><descEvento>Cancelamento</descEvento><nProt>${p.protocol}</nProt><xJust>${esc(p.reason.trim())}</xJust></detEvento></infEvento></evento></envEvento>`;
}

/** Inutilização de numeração, SEM assinatura (a assinatura cobre infInut e fica dentro de <inutNFe>). */
export function inutNFe(p: { uf: Uf; env: SefazEnv; year: string; cnpj: string; model: '55' | '65'; series: number; from: number; to: number; reason: string }): string {
  const id = `ID${UF_IBGE[p.uf]}${p.year}${p.cnpj}${p.model}${String(p.series).padStart(3, '0')}${String(p.from).padStart(9, '0')}${String(p.to).padStart(9, '0')}`;
  return `<inutNFe xmlns="${NS}" versao="4.00"><infInut Id="${id}"><tpAmb>${tpAmb(p.env)}</tpAmb><xServ>INUTILIZAR</xServ><cUF>${UF_IBGE[p.uf]}</cUF><ano>${p.year}</ano><CNPJ>${p.cnpj}</CNPJ><mod>${p.model}</mod><serie>${p.series}</serie><nNFIni>${p.from}</nNFIni><nNFFin>${p.to}</nNFFin><xJust>${esc(p.reason.trim())}</xJust></infInut></inutNFe>`;
}

/** nfeProc = NFe assinada + protocolo de autorização (é o XML que vale e deve ser guardado). */
export const nfeProc = (signedNfe: string, protNFe: string) => `<nfeProc xmlns="${NS}" versao="4.00">${signedNfe}${protNFe}</nfeProc>`;

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, parseTagValue: false, trimValues: true });
type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const s = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? undefined : String(v));

/** Extrai o conteúdo de <nfeResultMsg> de um envelope SOAP (ou devolve o XML se já vier sem envelope). */
export function resultOf(soapXml: string): string {
  const m = /<(?:\w+:)?nfeResultMsg[^>]*>([\s\S]*?)<\/(?:\w+:)?nfeResultMsg>/.exec(soapXml);
  if (m) return m[1];
  if (/<(?:\w+:)?Fault\b/.test(soapXml)) throw new Error(`SOAP Fault: ${(/<(?:\w+:)?Text[^>]*>([\s\S]*?)<\/(?:\w+:)?Text>/.exec(soapXml)?.[1] ?? 'falha no serviço').slice(0, 300)}`);
  return soapXml;
}

export interface Prot { chave?: string; cStat: string; xMotivo: string; protocol?: string; raw: string }

/** Retorno do envio (autorização síncrona) ou da consulta de recibo. */
export function parseAuthorization(xml: string): { cStat: string; xMotivo: string; nRec?: string; prot?: Prot } {
  const doc = o(parser.parse(xml));
  const root = o(doc.retEnviNFe ?? doc.retConsReciNFe);
  const protNode = o(root.protNFe);
  const inf = o(protNode.infProt);
  const rawProt = /<protNFe[\s\S]*?<\/protNFe>/.exec(xml)?.[0];
  return {
    cStat: s(root.cStat) ?? '', xMotivo: s(root.xMotivo) ?? '', nRec: s(o(root.infRec).nRec),
    prot: rawProt ? { chave: s(inf.chNFe), cStat: s(inf.cStat) ?? '', xMotivo: s(inf.xMotivo) ?? '', protocol: s(inf.nProt), raw: rawProt } : undefined,
  };
}

export function parseSituation(xml: string): { cStat: string; xMotivo: string; prot?: Prot; cancelled: boolean; cancelProtocol?: string } {
  const doc = o(parser.parse(xml));
  const root = o(doc.retConsSitNFe);
  const inf = o(o(root.protNFe).infProt);
  const rawProt = /<protNFe[\s\S]*?<\/protNFe>/.exec(xml)?.[0];
  const ev = o(o(o(root.procEventoNFe).retEvento).infEvento);
  const cancelled = s(ev.tpEvento) === '110111' && ['135', '136', '155'].includes(s(ev.cStat) ?? '');
  return { cStat: s(root.cStat) ?? '', xMotivo: s(root.xMotivo) ?? '', cancelled, cancelProtocol: s(ev.nProt), prot: rawProt ? { chave: s(inf.chNFe), cStat: s(inf.cStat) ?? '', xMotivo: s(inf.xMotivo) ?? '', protocol: s(inf.nProt), raw: rawProt } : undefined };
}

export function parseStatus(xml: string): { cStat: string; xMotivo: string; tMed?: string } {
  const r = o(o(parser.parse(xml)).retConsStatServ);
  return { cStat: s(r.cStat) ?? '', xMotivo: s(r.xMotivo) ?? '', tMed: s(r.tMed) };
}

export function parseEvent(xml: string): { cStat: string; xMotivo: string; event?: { cStat: string; xMotivo: string; protocol?: string } } {
  const r = o(o(parser.parse(xml)).retEnvEvento);
  const ev = o(o(r.retEvento).infEvento);
  return { cStat: s(r.cStat) ?? '', xMotivo: s(r.xMotivo) ?? '', event: ev.cStat ? { cStat: s(ev.cStat) ?? '', xMotivo: s(ev.xMotivo) ?? '', protocol: s(ev.nProt) } : undefined };
}

export function parseInut(xml: string): { cStat: string; xMotivo: string; protocol?: string } {
  const inf = o(o(o(parser.parse(xml)).retInutNFe).infInut);
  return { cStat: s(inf.cStat) ?? '', xMotivo: s(inf.xMotivo) ?? '', protocol: s(inf.nProt) };
}

/** Situações de autorização/denegação (Manual de Orientação do Contribuinte). A SEFAZ prevalece em qualquer divergência. */
export const AUTHORIZED_CODES = ['100', '150'];
export const DENIED_CODES = ['110', '205', '301', '302', '303'];
