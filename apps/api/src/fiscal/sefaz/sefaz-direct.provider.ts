import { buildChave } from '../chave';
import {
  CancelResult, ConsultResult, EventInput, EventResult, FiscalEnvironment, FiscalProvider, InutInput, OutgoingDocument, ProviderCtx, TransmitInput, TransmitResult, ValidationIssue,
} from '../fiscal-provider';
import { PAYMENT_CODE } from '../focus-nfe.provider';
import * as M from './messages';
import { buildNfeXml, NfeInput } from './nfe-builder';
import { pfxToPem } from './pfx';
import { anEventUrl, NFCE_QRCODE, service, SefazModel, UfNotAnalyzedError, Uf } from './registry';
import { signXml, verifySignature } from './signature';
import { Mtls, soapCall, TlsSetupError } from './soap';
import { validateAgainst } from './xsd';

/**
 * Emissão DIRETA na SEFAZ (sem provedor): monta o XML, valida no XSD, assina com o certificado A1 do estabelecimento e fala com os serviços
 * oficiais por SOAP 1.2 com TLS mútuo. Cobertura hoje: apenas as UFs com endereços verificados em fonte oficial (registry.ts: MG).
 *
 * O QUE ESTE CONECTOR NÃO PROVA: nunca foi executado contra a SEFAZ real (exige certificado A1 ICP-Brasil e credenciamento da empresa).
 * Estrutura do XML e assinatura são conferidas por testes contra o XSD; as REGRAS DE NEGÓCIO (rejeições) só se conhecem em homologação.
 */
const sent = (e: unknown) => (e as { sent?: boolean }).sent === true;
const mtls = (ctx: ProviderCtx): Mtls => ({ keyPem: ctx.certificate!.keyPem, certPem: ctx.certificate!.certPem });
const PRES = { COUNTER: 1, INTERNET: 2, PHONE: 3, DELIVERY: 9, OTHER: 9 } as const;

export function toNfeInput(doc: OutgoingDocument, ctx: ProviderCtx): NfeInput {
  if (!doc.accessKey) throw new Error('Documento sem chave de acesso reservada.');
  const e = doc.emitter;
  if (!e.cMun) throw new Error('Código IBGE do município do emitente não encontrado.');
  const r = doc.recipient;
  const rdoc = (r?.document ?? '').replace(/\D/g, '');
  const is65 = doc.model === '65';
  const qr = is65 ? NFCE_QRCODE[ctx.uf as Uf]?.[ctx.environment] : undefined;
  return {
    model: doc.model, environment: ctx.environment, chave: doc.accessKey, natOp: doc.returnOf?.length ? 'DEVOLUCAO DE VENDA' : is65 ? 'VENDA AO CONSUMIDOR' : 'VENDA DE MERCADORIA', issuedAt: doc.issuedAt,
    idDest: is65 ? 1 : doc.destination, indFinal: is65 || doc.finalConsumer ? 1 : 0, indPres: is65 ? (doc.presence === 'COUNTER' ? 1 : 4) : PRES[doc.presence], cMunFG: e.cMun,
    emitter: { cnpj: e.cnpj, name: e.name, tradeName: e.tradeName, ie: e.ie, crt: e.regime, cnae: e.cnae, street: e.street, number: e.number, district: e.district, cMun: e.cMun, city: e.city, uf: e.uf, zip: e.zip },
    recipient: r && (rdoc || !is65)
      ? { ...(rdoc.length === 14 ? { cnpj: rdoc } : rdoc.length === 11 ? { cpf: rdoc } : {}), name: r.name ?? '', indIEDest: r.ieIndicator, ie: r.ie, email: r.email, street: r.street ?? undefined, number: r.number ?? undefined, district: r.district ?? undefined, cMun: r.cMun ?? undefined, city: r.city ?? undefined, uf: r.uf ?? undefined, zip: r.zip ?? undefined, phone: r.phone }
      : null,
    items: doc.items.map((i) => ({
      line: i.line, code: i.sku, gtin: null, description: i.description, ncm: i.ncm, cfop: i.cfop, unit: i.unit, quantity: i.quantity, total: i.total,
      icms: { origin: i.origin ?? 0, regime: e.regime === 3 ? 'NORMAL' : 'SN', code: i.icmsCode ?? '', base: i.tax?.icms.base, rate: i.tax?.icms.rate, amount: i.tax?.icms.amount },
      pis: { cst: i.pisCst ?? '', base: i.tax?.pis.base, rate: i.tax?.pis.rate, amount: i.tax?.pis.amount },
      cofins: { cst: i.cofinsCst ?? '', base: i.tax?.cofins.base, rate: i.tax?.cofins.rate, amount: i.tax?.cofins.amount },
    })),
    freight: doc.totals.freight, payments: doc.returnOf?.length ? [{ tPag: '90', vPag: 0 }] : doc.payments.map((p) => ({ tPag: PAYMENT_CODE[p.method] ?? '99', vPag: p.amount })), returnOf: doc.returnOf, additionalInfo: doc.additionalInfo, procVersion: 'DistribuiHub 1.0',
    ...(qr && ctx.csc ? { qr: { url: qr.qrCodeUrl, cscId: ctx.csc.id, csc: ctx.csc.token, consultaChaveUrl: qr.consultaChaveUrl } } : {}),
  };
}

/** XML da nota já assinado (NFC-e: a assinatura vai depois do infNFeSupl). */
export function signedNfe(doc: OutgoingDocument, ctx: ProviderCtx): string {
  const xml = buildNfeXml(toNfeInput(doc, ctx));
  return signXml(xml, { keyPem: ctx.certificate!.keyPem, certPem: ctx.certificate!.certPem, tagToSign: 'infNFe', after: doc.model === '65' ? 'infNFeSupl' : 'infNFe' });
}

export class SefazDirectProvider implements FiscalProvider {
  readonly name = 'SEFAZ (emissão direta)';
  readonly numbering = 'SYSTEM' as const;
  readonly needsDocument = true;

  isConfigured(ctx?: ProviderCtx) { return !!ctx?.certificate && ctx.providerName === 'SEFAZ_DIRECT'; }

  private svc(ctx: ProviderCtx, s: Parameters<typeof service>[3]) { return service(ctx.uf ?? '', ctx.model as SefazModel, ctx.environment, s); }

  async validate(doc: OutgoingDocument, ctx: ProviderCtx): Promise<ValidationIssue[]> {
    const out: ValidationIssue[] = [];
    try { this.svc(ctx, 'autorizacao'); } catch (e) { out.push({ code: 'SEFAZ_UF', message: (e as Error).message }); return out; }
    if (!doc.emitter.cMun) out.push({ code: 'SEFAZ_CMUN_EMIT', message: `Código IBGE do município do emitente (${doc.emitter.city}/${doc.emitter.uf}) não encontrado: confira o nome da cidade no cadastro do estabelecimento.` });
    if (doc.model === '55' && doc.recipient && !doc.recipient.cMun) out.push({ code: 'SEFAZ_CMUN_DEST', message: `Código IBGE do município do cliente (${doc.recipient.city}/${doc.recipient.uf}) não encontrado: confira a cidade no cadastro do cliente.` });
    if (doc.model === '65') {
      if (!NFCE_QRCODE[ctx.uf as Uf]) out.push({ code: 'SEFAZ_QRCODE', message: `Endereços do QR Code da NFC-e de ${ctx.uf} não verificados.` });
      if (!ctx.csc) out.push({ code: 'SEFAZ_CSC', message: 'CSC da NFC-e não configurado para este ambiente (código e identificador, obtidos no portal da SEFAZ).' });
    }
    if (!doc.payments.length && !doc.returnOf?.length) out.push({ code: 'SEFAZ_PAYMENT', message: 'Informe a forma de pagamento.' });
    if (out.length) return out;
    // Ensaio completo: monta, assina e valida no XSD com um número de teste (nada é enviado).
    try {
      const probe = { ...doc, accessKey: doc.accessKey ?? buildChave({ uf: ctx.uf!, issuedAt: doc.issuedAt, cnpj: doc.emitter.cnpj, model: doc.model, series: doc.series ?? 1, number: doc.number ?? 1, cNF: '00000001' }) };
      const r = await validateAgainst('nfe_v4.00.xsd', signedNfe(probe, ctx));
      for (const e of r.errors.slice(0, 5)) out.push({ code: 'SEFAZ_XSD', message: `Leiaute: ${e.message}` });
    } catch (e) { out.push({ code: 'SEFAZ_BUILD', message: (e as Error).message }); }
    return out;
  }

  async transmit(input: TransmitInput, ctx?: ProviderCtx): Promise<TransmitResult> {
    if (!ctx?.certificate) return { kind: 'UNAVAILABLE', reason: 'Certificado digital A1 não disponível para este estabelecimento.' };
    const doc = input.document;
    if (!doc) return { kind: 'UNAVAILABLE', reason: 'Documento não informado ao provedor.' };
    let signed: string;
    let url: string;
    try {
      url = this.svc(ctx, 'autorizacao').url;
      signed = signedNfe({ ...doc, accessKey: input.accessKey }, ctx);
      const check = await validateAgainst('nfe_v4.00.xsd', signed); // nunca enviar XML que o leiaute já recusa
      if (!check.valid) return { kind: 'REJECTED', statusCode: 'XSD', reason: `XML fora do leiaute (não enviado): ${check.errors.slice(0, 3).map((e) => e.message).join(' | ')}` };
    } catch (e) {
      if (e instanceof UfNotAnalyzedError) return { kind: 'UNAVAILABLE', reason: e.message };
      return { kind: 'REJECTED', statusCode: 'BUILD', reason: (e as Error).message };
    }
    let reply;
    try {
      reply = await soapCall(url, M.OPS.autorizacao, M.enviNFe(signed, doc.number ?? 1), mtls(ctx));
    } catch (e) {
      if (e instanceof TlsSetupError) return { kind: 'UNAVAILABLE', reason: e.message };
      return sent(e) ? { kind: 'TIMEOUT', signedXml: signed } : { kind: 'UNAVAILABLE', reason: `Falha de conexão com a SEFAZ (nada foi enviado): ${(e as Error).message}` };
    }
    if (reply.status >= 500 || reply.status === 0) return { kind: 'TIMEOUT', signedXml: signed };
    let a;
    try { a = M.parseAuthorization(M.resultOf(reply.text)); } catch { return { kind: 'TIMEOUT', signedXml: signed }; }
    return this.interpret(a, signed, input.accessKey, ctx, doc);
  }

  private async interpret(a: ReturnType<typeof M.parseAuthorization>, signed: string, chave: string, ctx: ProviderCtx, doc: OutgoingDocument): Promise<TransmitResult> {
    if (a.prot) {
      if (M.AUTHORIZED_CODES.includes(a.prot.cStat)) {
        return { kind: 'AUTHORIZED', protocol: a.prot.protocol ?? '', statusCode: a.prot.cStat, xml: M.nfeProc(signed, a.prot.raw), signedXml: signed, remote: { accessKey: chave, number: doc.number, series: doc.series } };
      }
      if (M.DENIED_CODES.includes(a.prot.cStat)) return { kind: 'REJECTED', statusCode: a.prot.cStat, reason: `Denegada: ${a.prot.xMotivo}`, signedXml: signed };
      return { kind: 'REJECTED', statusCode: a.prot.cStat, reason: a.prot.xMotivo, signedXml: signed };
    }
    if (['103', '105'].includes(a.cStat)) {
      if (a.nRec) {
        const r = await this.pollReceipt(a.nRec, signed, chave, ctx, doc);
        if (r) return r;
      }
      return { kind: 'TIMEOUT', signedXml: signed }; // lote recebido, resultado ainda desconhecido: consultar pela chave
    }
    if (['108', '109'].includes(a.cStat)) return { kind: 'UNAVAILABLE', reason: `SEFAZ: ${a.xMotivo}` };
    return { kind: 'REJECTED', statusCode: a.cStat || 'sem-codigo', reason: a.xMotivo || 'Resposta da SEFAZ sem motivo.', signedXml: signed };
  }

  private async pollReceipt(nRec: string, signed: string, chave: string, ctx: ProviderCtx, doc: OutgoingDocument): Promise<TransmitResult | null> {
    const attempts = Number(process.env.FISCAL_SEFAZ_POLL_ATTEMPTS ?? 3);
    for (let i = 0; i < attempts; i++) {
      await new Promise((r) => setTimeout(r, Number(process.env.FISCAL_SEFAZ_POLL_DELAY_MS ?? 3000)));
      try {
        const reply = await soapCall(this.svc(ctx, 'retAutorizacao').url, M.OPS.retAutorizacao, M.consReciNFe(nRec, ctx.environment), mtls(ctx));
        const a = M.parseAuthorization(M.resultOf(reply.text));
        if (a.prot) return this.interpret(a, signed, chave, ctx, doc);
        if (!['105', '103'].includes(a.cStat)) return { kind: 'REJECTED', statusCode: a.cStat, reason: a.xMotivo, signedXml: signed };
      } catch { return null; }
    }
    return null;
  }

  async consult(chave: string, _env: FiscalEnvironment, ctx?: ProviderCtx): Promise<ConsultResult> {
    if (!ctx?.certificate) return { kind: 'UNKNOWN' };
    try {
      const reply = await soapCall(this.svc(ctx, 'consulta').url, M.OPS.consulta, M.consSitNFe(chave, ctx.environment), mtls(ctx));
      if (reply.status >= 500) return { kind: 'UNKNOWN' };
      const s = M.parseSituation(M.resultOf(reply.text));
      if (s.cancelled) return { kind: 'CANCELLED', statusCode: s.cStat };
      if (s.prot && M.AUTHORIZED_CODES.includes(s.prot.cStat) && ['100', '150'].includes(s.cStat)) return { kind: 'AUTHORIZED', protocol: s.prot.protocol ?? '', statusCode: s.prot.cStat, protXml: s.prot.raw, remote: { accessKey: chave } };
      if (s.cStat === '217') return { kind: 'NOT_FOUND' }; // NF-e não consta na base: reenvio seguro com a MESMA numeração
      if (M.DENIED_CODES.includes(s.cStat)) return { kind: 'REJECTED', statusCode: s.cStat, reason: `Denegada: ${s.xMotivo}` };
      return { kind: 'UNKNOWN' };
    } catch { return { kind: 'UNKNOWN' }; }
  }

  async cancel(_ref: string, reason: string, ctx: ProviderCtx, doc?: { accessKey?: string | null; protocol?: string | null }): Promise<CancelResult> {
    if (!ctx.certificate) return { kind: 'UNAVAILABLE', reason: 'Certificado A1 não disponível.' };
    if (!doc?.accessKey || !doc.protocol) return { kind: 'UNAVAILABLE', reason: 'Faltam a chave de acesso e o protocolo de autorização para cancelar.' };
    if (reason.trim().length < 15) return { kind: 'REJECTED', statusCode: 'justificativa', reason: 'A justificativa precisa ter no mínimo 15 caracteres.' };
    try {
      const at = new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).replace(' ', 'T') + '-03:00';
      const body = signXml(M.cancelEvent({ chave: doc.accessKey, env: ctx.environment, cnpj: doc.accessKey.slice(6, 20), protocol: doc.protocol, reason, at }), { keyPem: ctx.certificate.keyPem, certPem: ctx.certificate.certPem, tagToSign: 'infEvento', after: 'infEvento' });
      const check = await validateAgainst('envEvento_v1.00.xsd', body);
      if (!check.valid) return { kind: 'REJECTED', statusCode: 'XSD', reason: `Evento fora do leiaute (não enviado): ${check.errors[0]?.message}` };
      const reply = await soapCall(this.svc(ctx, 'evento').url, M.OPS.evento, body, mtls(ctx));
      const r = M.parseEvent(M.resultOf(reply.text));
      if (r.event && ['135', '136', '155'].includes(r.event.cStat)) return { kind: 'CANCELLED', statusCode: r.event.cStat };
      return { kind: 'REJECTED', statusCode: r.event?.cStat ?? r.cStat, reason: r.event?.xMotivo ?? r.xMotivo };
    } catch (e) {
      return { kind: 'UNAVAILABLE', reason: e instanceof TlsSetupError ? e.message : 'Sem resposta da SEFAZ ao cancelar. Consulte a situação antes de tentar de novo.' };
    }
  }

  /** Carta de correção (110110, serviço de eventos da UF) e manifestação do destinatário (2102xx, Ambiente Nacional). */
  async sendEvent(p: EventInput, ctx: ProviderCtx): Promise<EventResult> {
    if (!ctx.certificate) return { kind: 'UNAVAILABLE', reason: 'Certificado A1 não disponível.' };
    const manifest = p.kind === 'MANIFEST';
    const cfg = manifest ? M.MANIFEST[p.action ?? ''] : undefined;
    if (manifest && !cfg) return { kind: 'REJECTED', statusCode: 'tipo', reason: 'Tipo de manifestação inválido.' };
    if (manifest && cfg!.needsReason && (p.text ?? '').trim().length < 15) return { kind: 'REJECTED', statusCode: 'justificativa', reason: 'A justificativa precisa ter no mínimo 15 caracteres.' };
    if (!manifest && ((p.text ?? '').trim().length < 15 || (p.text ?? '').trim().length > 1000)) return { kind: 'REJECTED', statusCode: 'correcao', reason: 'A correção precisa ter de 15 a 1000 caracteres.' };
    try {
      const url = manifest ? anEventUrl(ctx.environment) : this.svc(ctx, 'evento').url;
      if (!url) return { kind: 'UNAVAILABLE', reason: 'O endereço do serviço de eventos do Ambiente Nacional não está configurado: confira no Portal Nacional da NF-e e informe em FISCAL_SEFAZ_AN_EVENT_URL_PRODUCAO / _HOMOLOGACAO.' };
      const at = new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).replace(' ', 'T') + '-03:00';
      const tpEvento = manifest ? cfg!.tp : '110110';
      const det = manifest ? M.manifestDetail(p.action!, p.text) : M.cceDetail(p.text!);
      const body = signXml(M.eventEnvelope({ tpEvento, chave: p.accessKey, env: ctx.environment, cnpj: p.cnpj, at, seq: p.seq, orgao: manifest ? '91' : p.accessKey.slice(0, 2), det }), { keyPem: ctx.certificate.keyPem, certPem: ctx.certificate.certPem, tagToSign: 'infEvento', after: 'infEvento' });
      const env = await validateAgainst('envEvento_v1.00.xsd', body);
      const det2 = await validateAgainst(`e${tpEvento}_v1.00.xsd`, M.detEventoOf(body));
      if (!env.valid || !det2.valid) return { kind: 'REJECTED', statusCode: 'XSD', reason: `Evento fora do leiaute (não enviado): ${(env.errors[0] ?? det2.errors[0])?.message}` };
      const reply = await soapCall(url, M.OPS.evento, body, mtls(ctx));
      const r = M.parseEvent(M.resultOf(reply.text));
      if (!r.cStat && !r.event) return { kind: 'UNAVAILABLE', reason: 'Resposta inesperada do serviço de eventos. Confira a situação da nota antes de tentar de novo.' };
      if (r.event && ['135', '136'].includes(r.event.cStat)) return { kind: 'REGISTERED', statusCode: r.event.cStat, protocol: r.event.protocol ?? '' };
      return { kind: 'REJECTED', statusCode: r.event?.cStat ?? r.cStat, reason: r.event?.xMotivo ?? r.xMotivo };
    } catch (e) {
      return { kind: 'UNAVAILABLE', reason: e instanceof TlsSetupError ? e.message : `Sem resposta da SEFAZ: ${(e as Error).message}. Confira a situação antes de tentar de novo.` };
    }
  }

  async inutilize(p: InutInput, ctx: ProviderCtx) {
    if (!ctx.certificate) return { kind: 'UNAVAILABLE' as const, reason: 'Certificado A1 não disponível.' };
    if (p.reason.trim().length < 15) return { kind: 'REJECTED' as const, statusCode: 'justificativa', reason: 'A justificativa precisa ter no mínimo 15 caracteres.' };
    if (p.to < p.from) return { kind: 'REJECTED' as const, statusCode: 'faixa', reason: 'Faixa de numeração inválida.' };
    try {
      const cnpj = (ctx.certificate.cnpj ?? '').replace(/\D/g, '');
      const body = signXml(M.inutNFe({ uf: ctx.uf as Uf, env: ctx.environment, year: String(new Date().getFullYear()).slice(2), cnpj, model: p.model, series: p.series, from: p.from, to: p.to, reason: p.reason }), { keyPem: ctx.certificate.keyPem, certPem: ctx.certificate.certPem, tagToSign: 'infInut', after: 'infInut' });
      const check = await validateAgainst('inutNFe_v4.00.xsd', body);
      if (!check.valid) return { kind: 'REJECTED' as const, statusCode: 'XSD', reason: `Pedido fora do leiaute (não enviado): ${check.errors[0]?.message}` };
      const reply = await soapCall(this.svc(ctx, 'inutilizacao').url, M.OPS.inutilizacao, body, mtls(ctx));
      const r = M.parseInut(M.resultOf(reply.text));
      return r.cStat === '102' ? { kind: 'OK' as const, protocol: r.protocol ?? '', statusCode: r.cStat } : { kind: 'REJECTED' as const, statusCode: r.cStat, reason: r.xMotivo };
    } catch (e) {
      return { kind: 'UNAVAILABLE' as const, reason: e instanceof TlsSetupError ? e.message : `Sem resposta da SEFAZ: ${(e as Error).message}` };
    }
  }

  /** Teste de comunicação: consulta o status do serviço da UF (nada é emitido). */
  async ping(ctx: ProviderCtx): Promise<{ ok: boolean; message: string }> {
    if (!ctx.certificate) return { ok: false, message: 'Envie o certificado digital A1 do estabelecimento.' };
    try {
      const uf = ctx.uf as Uf;
      const reply = await soapCall(this.svc(ctx, 'status').url, M.OPS.status, M.consStatServ(uf, ctx.environment), mtls(ctx), 15_000);
      const s = M.parseStatus(M.resultOf(reply.text));
      return s.cStat === '107' ? { ok: true, message: `SEFAZ ${ctx.uf}: serviço em operação (${s.xMotivo}).` } : { ok: false, message: `SEFAZ ${ctx.uf} respondeu ${s.cStat}: ${s.xMotivo || 'sem detalhe'}.` };
    } catch (e) {
      if (e instanceof UfNotAnalyzedError || e instanceof TlsSetupError) return { ok: false, message: e.message };
      return { ok: false, message: `Não foi possível falar com a SEFAZ: ${(e as Error).message}` };
    }
  }
}

export { verifySignature, pfxToPem };
