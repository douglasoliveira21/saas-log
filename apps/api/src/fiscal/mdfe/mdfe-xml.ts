import { XMLParser } from 'fast-xml-parser';
import { gzipSync } from 'node:zlib';

/**
 * MDF-e modal RODOVIÁRIO (leiaute 3.00): montagem do XML, eventos (cancelamento e encerramento), consultas e leitura das respostas.
 * Conformidade ESTRUTURAL conferida no XSD (testes); regras de negócio (rejeições) só se conhecem em homologação real, que NÃO foi feita.
 * Emitente fixo como transportador de CARGA PRÓPRIA (tpEmit 2): o distribuidor transportando a própria mercadoria.
 */
export const MDFE_NS = 'http://www.portalfiscal.inf.br/mdfe';
export type MdfeEnv = 'HOMOLOGACAO' | 'PRODUCAO';
const tpAmb = (e: MdfeEnv) => (e === 'PRODUCAO' ? 1 : 2);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const txt = (s: string, max: number) => esc(s.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max));
const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');
const tag = (name: string, v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? '' : `<${name}>${v}</${name}>`);
const brt = (d: Date) => { const p = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d); return `${p.replace(' ', 'T')}-03:00`; };
const dec = (n: number, d: number) => n.toFixed(d);

export interface MdfeInput {
  environment: MdfeEnv;
  /** Chave de 44 dígitos (cUF, AAMM, CNPJ, mod 58, série, nMDF, tpEmis, cMDF, cDV). */
  chave: string;
  issuedAt: Date;
  emitter: { cnpj: string; ie: string; name: string; tradeName?: string | null; street: string; number: string; complement?: string | null; district: string; cMun: string; city: string; uf: string; zip: string; phone?: string | null; email?: string | null };
  /** Município de carregamento (o do estabelecimento). */
  load: { cMun: string; city: string };
  ufIni: string;
  ufFim: string;
  /** UFs de percurso (opcional). */
  route?: string[];
  vehicle: { plate: string; renavam?: string | null; tareKg: number; capKg?: number | null; uf: string; tpRod: string; tpCar: string };
  driver: { name: string; cpf: string };
  /** Municípios de descarga com as NF-e entregues em cada um. */
  unload: { cMun: string; city: string; nfeKeys: string[] }[];
  totals: { nfeCount: number; value: number; weightKg: number };
  additionalInfo?: string | null;
  procVersion: string;
}

export function buildMdfeXml(m: MdfeInput): string {
  const cMDF = m.chave.slice(35, 43); const nMDF = Number(m.chave.slice(25, 34)); const serie = Number(m.chave.slice(22, 25)); const cDV = m.chave.slice(43);
  const e = m.emitter;
  const ide = `<ide>${tag('cUF', m.chave.slice(0, 2))}${tag('tpAmb', tpAmb(m.environment))}${tag('tpEmit', 2)}${tag('mod', 58)}${tag('serie', serie)}${tag('nMDF', nMDF)}${tag('cMDF', cMDF)}${tag('cDV', cDV)}${tag('modal', 1)}${tag('dhEmi', brt(m.issuedAt))}${tag('tpEmis', m.chave.slice(34, 35))}${tag('procEmi', 0)}${tag('verProc', txt(m.procVersion, 20))}${tag('UFIni', m.ufIni)}${tag('UFFim', m.ufFim)}<infMunCarrega>${tag('cMunCarrega', m.load.cMun)}${tag('xMunCarrega', txt(m.load.city, 60))}</infMunCarrega>${(m.route ?? []).map((u) => `<infPercurso>${tag('UFPer', u)}</infPercurso>`).join('')}</ide>`;
  const emit = `<emit>${tag('CNPJ', digits(e.cnpj))}${tag('IE', digits(e.ie))}${tag('xNome', txt(e.name, 60))}${e.tradeName ? tag('xFant', txt(e.tradeName, 60)) : ''}<enderEmit>${tag('xLgr', txt(e.street, 60))}${tag('nro', txt(e.number || 'SN', 60))}${e.complement ? tag('xCpl', txt(e.complement, 60)) : ''}${tag('xBairro', txt(e.district, 60))}${tag('cMun', e.cMun)}${tag('xMun', txt(e.city, 60))}${tag('CEP', digits(e.zip))}${tag('UF', e.uf)}${e.phone ? tag('fone', digits(e.phone)) : ''}${e.email ? tag('email', txt(e.email, 60)) : ''}</enderEmit></emit>`;
  const v = m.vehicle;
  const rodo = `<infModal versaoModal="3.00"><rodo><veicTracao>${tag('placa', v.plate.replace(/[^A-Za-z0-9]/g, '').toUpperCase())}${v.renavam ? tag('RENAVAM', digits(v.renavam)) : ''}${tag('tara', Math.round(v.tareKg))}${v.capKg ? tag('capKG', Math.round(v.capKg)) : ''}<condutor>${tag('xNome', txt(m.driver.name, 60))}${tag('CPF', digits(m.driver.cpf))}</condutor>${tag('tpRod', v.tpRod)}${tag('tpCar', v.tpCar)}${tag('UF', v.uf)}</veicTracao></rodo></infModal>`;
  const doc = `<infDoc>${m.unload.map((u) => `<infMunDescarga>${tag('cMunDescarga', u.cMun)}${tag('xMunDescarga', txt(u.city, 60))}${u.nfeKeys.map((k) => `<infNFe>${tag('chNFe', k)}</infNFe>`).join('')}</infMunDescarga>`).join('')}</infDoc>`;
  const tot = `<tot>${tag('qNFe', m.totals.nfeCount)}${tag('vCarga', dec(m.totals.value, 2))}${tag('cUnid', '01')}${tag('qCarga', dec(m.totals.weightKg, 4))}</tot>`;
  const adic = m.additionalInfo ? `<infAdic>${tag('infCpl', txt(m.additionalInfo, 5000))}</infAdic>` : '';
  return `<MDFe xmlns="${MDFE_NS}"><infMDFe versao="3.00" Id="MDFe${m.chave}">${ide}${emit}${rodo}${doc}${tot}${adic}</infMDFe></MDFe>`;
}

/** Envio síncrono: o corpo do serviço é o MDF-e assinado, compactado (gzip) e codificado em base64. */
export const syncBody = (signedMdfe: string) => gzipSync(Buffer.from(signedMdfe, 'utf8')).toString('base64');

// ───── eventos (sem assinatura: ela cobre infEvento)
export type MdfeEvent = { tp: '110111' | '110112'; chave: string; env: MdfeEnv; cnpj: string; at: string; seq?: number; det: string };
export function mdfeEvent(p: MdfeEvent): string {
  const seq = p.seq ?? 1;
  const id = `ID${p.tp}${p.chave}${String(seq).padStart(2, '0')}`;
  return `<eventoMDFe xmlns="${MDFE_NS}" versao="3.00"><infEvento Id="${id}"><cOrgao>${p.chave.slice(0, 2)}</cOrgao><tpAmb>${tpAmb(p.env)}</tpAmb><CNPJ>${p.cnpj}</CNPJ><chMDFe>${p.chave}</chMDFe><dhEvento>${p.at}</dhEvento><tpEvento>${p.tp}</tpEvento><nSeqEvento>${seq}</nSeqEvento><detEvento versaoEvento="3.00">${p.det}</detEvento></infEvento></eventoMDFe>`;
}
export const cancelDetail = (protocol: string, reason: string) => `<evCancMDFe><descEvento>Cancelamento</descEvento><nProt>${protocol}</nProt><xJust>${txt(reason, 255)}</xJust></evCancMDFe>`;
export const closeDetail = (protocol: string, date: string, cUF: string, cMun: string) => `<evEncMDFe><descEvento>Encerramento</descEvento><nProt>${protocol}</nProt><dtEnc>${date}</dtEnc><cUF>${cUF}</cUF><cMun>${cMun}</cMun></evEncMDFe>`;

// ───── consultas
export const consSitMDFe = (chave: string, env: MdfeEnv) => `<consSitMDFe xmlns="${MDFE_NS}" versao="3.00"><tpAmb>${tpAmb(env)}</tpAmb><xServ>CONSULTAR</xServ><chMDFe>${chave}</chMDFe></consSitMDFe>`;
export const consStatServMDFe = (env: MdfeEnv) => `<consStatServMDFe xmlns="${MDFE_NS}" versao="3.00"><tpAmb>${tpAmb(env)}</tpAmb><xServ>STATUS</xServ></consStatServMDFe>`;

/** mdfeProc = MDFe assinado + protocolo de autorização (é o XML que vale e deve ser guardado). */
export const mdfeProc = (signedMdfe: string, protMDFe: string) => `<mdfeProc xmlns="${MDFE_NS}" versao="3.00">${signedMdfe}${protMDFe}</mdfeProc>`;

// ───── leitura das respostas
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, parseTagValue: false, trimValues: true });
type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const s = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? undefined : String(v));

/** Extrai o conteúdo de <mdfeResultMsg> do envelope SOAP. */
export function mdfeResultOf(soapXml: string): string {
  const m = /<(?:\w+:)?mdfeResultMsg[^>]*>([\s\S]*?)<\/(?:\w+:)?mdfeResultMsg>/.exec(soapXml);
  if (m) return m[1];
  if (/<(?:\w+:)?Fault\b/.test(soapXml)) throw new Error(`SOAP Fault: ${(/<(?:\w+:)?Text[^>]*>([\s\S]*?)<\/(?:\w+:)?Text>/.exec(soapXml)?.[1] ?? 'falha no serviço').slice(0, 300)}`);
  return soapXml;
}

export interface MdfeProt { cStat: string; xMotivo: string; protocol?: string; chave?: string; raw: string }
function protOf(infProt: Obj, raw: string): MdfeProt { return { cStat: s(infProt.cStat) ?? '', xMotivo: s(infProt.xMotivo) ?? '', protocol: s(infProt.nProt), chave: s(infProt.chMDFe), raw }; }

/** Resposta do envio síncrono (retMDFe): protocolo da autorização ou rejeição. */
export function parseMdfeAuthorization(xml: string): { cStat: string; xMotivo: string; prot?: MdfeProt } {
  const r = o(o(parser.parse(xml)).retMDFe);
  const p = o(r.protMDFe);
  const raw = /<protMDFe[\s\S]*?<\/protMDFe>/.exec(xml)?.[0];
  return { cStat: s(r.cStat) ?? '', xMotivo: s(r.xMotivo) ?? '', prot: p.infProt ? protOf(o(p.infProt), raw ?? '') : undefined };
}

export function parseMdfeSituation(xml: string): { cStat: string; xMotivo: string; prot?: MdfeProt; closed: boolean; cancelled: boolean } {
  const r = o(o(parser.parse(xml)).retConsSitMDFe);
  const p = o(r.protMDFe);
  const raw = /<protMDFe[\s\S]*?<\/protMDFe>/.exec(xml)?.[0];
  const cStat = s(r.cStat) ?? '';
  return { cStat, xMotivo: s(r.xMotivo) ?? '', prot: p.infProt ? protOf(o(p.infProt), raw ?? '') : undefined, cancelled: cStat === '101', closed: cStat === '132' };
}

export function parseMdfeEvent(xml: string): { cStat: string; xMotivo: string; event?: { cStat: string; xMotivo: string; protocol?: string } } {
  const r = o(o(parser.parse(xml)).retEventoMDFe);
  const ev = o(r.infEvento);
  return { cStat: s(r.cStat) ?? s(ev.cStat) ?? '', xMotivo: s(r.xMotivo) ?? s(ev.xMotivo) ?? '', event: ev.cStat ? { cStat: s(ev.cStat) ?? '', xMotivo: s(ev.xMotivo) ?? '', protocol: s(ev.nProt) } : undefined };
}

export function parseMdfeStatus(xml: string): { cStat: string; xMotivo: string } {
  const r = o(o(parser.parse(xml)).retConsStatServMDFe);
  return { cStat: s(r.cStat) ?? '', xMotivo: s(r.xMotivo) ?? '' };
}

/** Códigos de situação do MDF-e (leiaute 3.00). 100 autorizado; 132 encerrado; 101 cancelado; 135 evento registrado. A SEFAZ prevalece. */
export const MDFE_AUTHORIZED = ['100'];
export const MDFE_EVENT_OK = ['135', '136'];

/** Tipos de rodado e carroceria (tpRod/tpCar) a partir do tipo de veículo cadastrado. */
export const TP_ROD: Record<string, string> = { MOTORCYCLE: '06', VAN: '04', TRUCK: '01', OTHER: '06' };
