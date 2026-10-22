import {
  CancelResult, ConsultResult, FiscalEnvironment, FiscalModel, FiscalProvider, OutgoingDocument, ProviderCtx, RemoteDoc, TransmitInput, TransmitResult, ValidationIssue,
} from './fiscal-provider';

/**
 * Provedor Focus NFe (https://focusnfe.com.br) para NF-e (modelo 55) e NFC-e (modelo 65).
 *
 * ORIGEM DAS REGRAS (docs/FISCAL-PROVIDER.md):
 *  [CONFIRMADO] páginas oficiais de doc.focusnfe.com.br lidas em 22/10/2026: autenticação HTTP Basic (token como usuário, senha vazia);
 *               URLs https://homologacao.focusnfe.com.br e https://api.focusnfe.com.br (prefixo /v2); POST /v2/nfe?ref= (assíncrono: 202 +
 *               processando_autorizacao) e POST /v2/nfce?ref= (síncrono); GET /v2/{nfe|nfce}/{ref}; DELETE /v2/{nfe|nfce}/{ref} com `justificativa`
 *               (15 a 255 caracteres); status autorizado / processando_autorizacao / erro_autorizacao / cancelado; códigos de erro
 *               (requisicao_invalida, erro_validacao_schema, pending_operation, already_processed, nao_encontrado, permissao_negada…);
 *               campos listados nos métodos de montagem abaixo.
 *  [A VALIDAR]  o que as páginas lidas NÃO trazem: bloco de pagamentos da NF-e (usamos `formas_pagamento`, como na NFC-e), campos de BASE/VALOR
 *               de ICMS, PIS e COFINS (por isso notas com tributo > 0 são bloqueadas na validação, em vez de enviadas incompletas), e o formato do
 *               link de XML/DANFE. Tudo isso só se confirma com uma conta de homologação real.
 * O provedor numera a nota (não enviamos numero/serie) e devolve a chave ao autorizar. A referência (`ref`) é o id do nosso documento: reenvio
 * com a mesma referência não cria nota nova.
 */
export const FOCUS = {
  baseUrl: (env: FiscalEnvironment) =>
    env === 'PRODUCAO' ? (process.env.FOCUS_NFE_BASE_PRODUCAO ?? 'https://api.focusnfe.com.br') : (process.env.FOCUS_NFE_BASE_HOMOLOGACAO ?? 'https://homologacao.focusnfe.com.br'),
  timeoutMs: 20_000,
  pollAttempts: () => Number(process.env.FOCUS_NFE_POLL_ATTEMPTS ?? 4),
  pollDelayMs: () => Number(process.env.FOCUS_NFE_POLL_DELAY_MS ?? 1500),
  maxDownloadBytes: 10 * 1024 * 1024,
};

type Json = Record<string, unknown>;
const rec = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const money = (n: number) => Number(n.toFixed(2));
const qty = (n: number) => Number(n.toFixed(4));

/** AAAA-MM-DDTHH:mm:ss-03:00 (Brasília; sem horário de verão desde 2019). */
export function brtIso(d: Date): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}-03:00`;
}

const PRESENCE_NFE = { COUNTER: 1, INTERNET: 2, PHONE: 3, DELIVERY: 9, OTHER: 9 } as const;
const PRESENCE_NFCE = { COUNTER: 1, DELIVERY: 4, INTERNET: 4, PHONE: 4, OTHER: 4 } as const; // [CONFIRMADO] NFC-e: 1 presencial, 4 entrega em domicílio
export const PAYMENT_CODE: Record<string, string> = { CASH: '01', CHECK: '02', CREDIT: '03', DEBIT: '04', BOLETO: '15', PIX: '17', OTHER: '99' };

function itemsOf(doc: OutgoingDocument): Json[] {
  return doc.items.map((i) => ({
    numero_item: i.line, codigo_produto: i.sku, descricao: i.description, codigo_ncm: i.ncm, cfop: i.cfop,
    unidade_comercial: i.unit, unidade_tributavel: i.unit, quantidade_comercial: qty(i.quantity), quantidade_tributavel: qty(i.quantity),
    valor_unitario_comercial: Number(i.unitValue.toFixed(6)), valor_unitario_tributavel: Number(i.unitValue.toFixed(6)), valor_bruto: money(i.total),
    icms_origem: i.origin ?? 0, icms_situacao_tributaria: i.icmsCode,
    ...(doc.model === '55' ? { pis_situacao_tributaria: i.pisCst, cofins_situacao_tributaria: i.cofinsCst, inclui_no_total: 1 } : {}),
  }));
}

/** Corpo do POST /v2/nfe ou /v2/nfce. Só campos documentados; o que não está documentado fica de fora (ver cabeçalho do arquivo). */
export function buildFocusPayload(doc: OutgoingDocument): Json {
  const r = doc.recipient;
  const rdoc = r?.document?.replace(/\D/g, '') ?? '';
  const payments = doc.payments.map((p) => ({ forma_pagamento: PAYMENT_CODE[p.method] ?? '99', valor_pagamento: money(p.amount) }));
  if (doc.model === '65') {
    return {
      natureza_operacao: 'VENDA AO CONSUMIDOR', cnpj_emitente: doc.emitter.cnpj, data_emissao: brtIso(doc.issuedAt), presenca_comprador: PRESENCE_NFCE[doc.presence],
      modalidade_frete: 9, local_destino: 1,
      ...(rdoc.length === 11 ? { cpf_destinatario: rdoc } : rdoc.length === 14 ? { cnpj_destinatario: rdoc } : {}), ...(r?.name && rdoc ? { nome_destinatario: r.name } : {}),
      ...(doc.additionalInfo ? { informacoes_adicionais_contribuinte: doc.additionalInfo } : {}),
      items: itemsOf(doc), formas_pagamento: payments,
    };
  }
  return {
    natureza_operacao: 'VENDA DE MERCADORIA', data_emissao: brtIso(doc.issuedAt), data_entrada_saida: brtIso(doc.issuedAt), tipo_documento: 1, finalidade_emissao: 1,
    local_destino: doc.destination, consumidor_final: doc.finalConsumer ? 1 : 0, presenca_comprador: PRESENCE_NFE[doc.presence],
    cnpj_emitente: doc.emitter.cnpj, nome_emitente: doc.emitter.name, ...(doc.emitter.tradeName ? { nome_fantasia_emitente: doc.emitter.tradeName } : {}),
    logradouro_emitente: doc.emitter.street, numero_emitente: doc.emitter.number, bairro_emitente: doc.emitter.district, municipio_emitente: doc.emitter.city, uf_emitente: doc.emitter.uf,
    cep_emitente: doc.emitter.zip, inscricao_estadual_emitente: doc.emitter.ie, regime_tributario_emitente: doc.emitter.regime,
    ...(rdoc.length === 14 ? { cnpj_destinatario: rdoc } : { cpf_destinatario: rdoc }), nome_destinatario: r?.name,
    ...(r?.ie ? { inscricao_estadual_destinatario: r.ie } : {}), indicador_inscricao_estadual_destinatario: r?.ieIndicator ?? 9,
    logradouro_destinatario: r?.street, numero_destinatario: r?.number, bairro_destinatario: r?.district, municipio_destinatario: r?.city, uf_destinatario: r?.uf, cep_destinatario: r?.zip,
    pais_destinatario: 'Brasil', ...(r?.phone ? { telefone_destinatario: r.phone } : {}),
    valor_frete: money(doc.totals.freight), valor_seguro: 0, valor_desconto: 0, valor_outras_despesas: 0, valor_produtos: money(doc.totals.products), valor_total: money(doc.totals.total),
    modalidade_frete: doc.totals.freight > 0 ? 0 : 9,
    ...(doc.additionalInfo ? { informacoes_adicionais_contribuinte: doc.additionalInfo } : {}),
    items: itemsOf(doc), formas_pagamento: payments, // [A VALIDAR] nome do bloco de pagamentos na NF-e
  };
}

interface Reply { status: number; body: Json | null; text: string }

async function call(method: string, url: string, token: string, body?: unknown): Promise<Reply | 'NETWORK'> {
  try {
    const res = await fetch(url, {
      method, headers: { authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(FOCUS.timeoutMs),
    });
    const text = await res.text();
    let json: Json | null = null;
    try { json = text ? (JSON.parse(text) as Json) : {}; } catch { json = null; }
    return { status: res.status, body: json, text };
  } catch { return 'NETWORK'; }
}

const path = (m: FiscalModel) => (m === '65' ? 'nfce' : 'nfe');

function reasonOf(b: Json | null): string {
  if (!b) return 'resposta inesperada do provedor';
  const errs = Array.isArray(b.erros) ? (b.erros as Json[]).map((e) => [str(e.campo), str(e.mensagem)].filter(Boolean).join(': ')).filter(Boolean) : [];
  return [str(b.mensagem_sefaz) ?? str(b.mensagem), ...errs].filter(Boolean).join(' | ').slice(0, 600) || 'sem detalhe';
}

function remoteOf(b: Json): RemoteDoc {
  return {
    accessKey: str(b.chave_nfe), number: b.numero !== undefined ? Number(b.numero) : undefined, series: b.serie !== undefined ? Number(b.serie) : undefined,
    xmlPath: str(b.caminho_xml_nota_fiscal), danfePath: str(b.caminho_danfe), qrCodeUrl: str(b.qrcode_url), consultUrl: str(b.url_consulta_nf),
  };
}

function protocolOf(b: Json): string {
  return str(b.protocolo) ?? str(rec(b.protocolo_nota_fiscal).numero_protocolo) ?? str(b.numero_protocolo) ?? str(b.chave_nfe) ?? 'autorizado';
}

export class FocusNfeProvider implements FiscalProvider {
  readonly name = 'Focus NFe';
  readonly numbering = 'PROVIDER' as const;

  isConfigured(ctx?: ProviderCtx) { return !!ctx?.token; }

  validate(doc: OutgoingDocument): ValidationIssue[] {
    const out: ValidationIssue[] = [];
    const noCode = doc.items.filter((i) => !i.icmsCode).map((i) => i.line);
    if (noCode.length) out.push({ code: 'FOCUS_ICMS_CODE', message: `Item(ns) ${noCode.join(', ')}: a regra tributária não define o CST/CSOSN de ICMS.` });
    if (doc.model === '55') {
      const noPis = doc.items.filter((i) => !i.pisCst || !i.cofinsCst).map((i) => i.line);
      if (noPis.length) out.push({ code: 'FOCUS_PIS_COFINS', message: `Item(ns) ${noPis.join(', ')}: a regra não define o CST de PIS e COFINS (obrigatório na NF-e).` });
    }
    const taxed = doc.items.filter((i) => i.taxAmounts.icms > 0 || i.taxAmounts.pis > 0 || i.taxAmounts.cofins > 0).map((i) => i.line);
    if (taxed.length) out.push({ code: 'FOCUS_TAX_AMOUNTS', message: `Item(ns) ${taxed.join(', ')} têm tributo com valor (base/alíquota). Este conector ainda não envia base e valor de ICMS/PIS/COFINS: use regras sem tributo destacado (ex.: Simples Nacional sem crédito) ou aguarde o mapeamento validado em homologação.` });
    if (!doc.items.every((i) => /^\d{8}$/.test(i.ncm) && i.cfop)) out.push({ code: 'FOCUS_NCM_CFOP', message: 'Todos os itens precisam de NCM (8 dígitos) e CFOP.' });
    if (doc.model === '65' && !doc.payments.length) out.push({ code: 'FOCUS_PAYMENT', message: 'NFC-e exige a forma de pagamento.' });
    return out;
  }

  async transmit(input: TransmitInput, ctx?: ProviderCtx): Promise<TransmitResult> {
    if (!ctx?.token) return { kind: 'UNAVAILABLE', reason: 'Token do Focus NFe não configurado para este estabelecimento.' };
    if (!input.document) return { kind: 'UNAVAILABLE', reason: 'Documento não informado ao provedor.' };
    const base = FOCUS.baseUrl(ctx.environment);
    const ref = input.document.ref;
    const r = await call('POST', `${base}/v2/${path(ctx.model)}?ref=${encodeURIComponent(ref)}`, ctx.token, buildFocusPayload(input.document));
    if (r === 'NETWORK') return { kind: 'TIMEOUT' }; // pode ter chegado: só consulta pela referência
    const b = r.body;
    if (r.status === 401 || r.status === 403) return { kind: 'UNAVAILABLE', reason: 'O Focus NFe recusou o token (acesso negado). Confira o token do ambiente selecionado.' };
    if (r.status >= 500) return { kind: 'TIMEOUT' };
    if (r.status === 429) return { kind: 'UNAVAILABLE', reason: 'Limite de requisições do Focus NFe: tente de novo em instantes.' };
    const code = str(b?.codigo);
    if (r.status === 422 && (code === 'pending_operation' || code === 'already_processed')) return this.settle(ref, ctx, true); // já recebida: acompanha pela referência
    if (code === 'empresa_nao_configurada' || code === 'ambiente_nao_configurado' || code === 'permissao_negada') return { kind: 'UNAVAILABLE', reason: `Focus NFe: ${str(b?.mensagem) ?? code}` };
    if (r.status === 400 || r.status === 415 || r.status === 422) return { kind: 'REJECTED', statusCode: code ?? String(r.status), reason: reasonOf(b) };
    if (r.status !== 200 && r.status !== 201 && r.status !== 202) return { kind: 'TIMEOUT' };
    const st = str(b?.status);
    if (st === 'autorizado') return this.authorized(b!);
    if (st === 'erro_autorizacao') return { kind: 'REJECTED', statusCode: str(b?.status_sefaz) ?? 'erro_autorizacao', reason: reasonOf(b) };
    return this.settle(ref, ctx, false); // processando_autorizacao
  }

  private authorized(b: Json): TransmitResult {
    return { kind: 'AUTHORIZED', protocol: protocolOf(b), statusCode: str(b.status_sefaz) ?? '100', remote: remoteOf(b) };
  }

  /** Acompanha a nota (emissão assíncrona) por algumas tentativas; se ainda estiver processando, devolve TIMEOUT (consulta manual depois). */
  private async settle(ref: string, ctx: ProviderCtx, immediate: boolean): Promise<TransmitResult> {
    for (let i = 0; i < Math.max(1, FOCUS.pollAttempts()); i++) {
      if (!(immediate && i === 0)) await sleep(FOCUS.pollDelayMs());
      const c = await this.consult(ref, ctx.environment, ctx);
      if (c.kind === 'AUTHORIZED') return { kind: 'AUTHORIZED', protocol: c.protocol, statusCode: c.statusCode, remote: c.remote };
      if (c.kind === 'REJECTED') return c;
      if (c.kind === 'CANCELLED') return { kind: 'REJECTED', statusCode: 'cancelada', reason: 'A nota já foi cancelada no provedor.' };
    }
    return { kind: 'TIMEOUT' };
  }

  async consult(ref: string, environment: FiscalEnvironment, ctx?: ProviderCtx): Promise<ConsultResult> {
    if (!ctx?.token) return { kind: 'UNKNOWN' };
    const r = await call('GET', `${FOCUS.baseUrl(environment)}/v2/${path(ctx.model)}/${encodeURIComponent(ref)}?completa=1`, ctx.token);
    if (r === 'NETWORK' || r.status >= 500 || r.status === 401 || r.status === 403 || r.status === 429) return { kind: 'UNKNOWN' };
    if (r.status === 404 || str(r.body?.codigo) === 'nao_encontrado') return { kind: 'NOT_FOUND' };
    const b = r.body;
    if (!b) return { kind: 'UNKNOWN' };
    switch (str(b.status)) {
      case 'autorizado': return { kind: 'AUTHORIZED', protocol: protocolOf(b), statusCode: str(b.status_sefaz) ?? '100', remote: remoteOf(b) };
      case 'erro_autorizacao': return { kind: 'REJECTED', statusCode: str(b.status_sefaz) ?? 'erro_autorizacao', reason: reasonOf(b) };
      case 'cancelado': return { kind: 'CANCELLED', statusCode: str(b.status_sefaz), xmlPath: str(b.caminho_xml_cancelamento) };
      default: return { kind: 'UNKNOWN' }; // processando_autorizacao e demais
    }
  }

  async cancel(ref: string, reason: string, ctx: ProviderCtx): Promise<CancelResult> {
    if (!ctx.token) return { kind: 'UNAVAILABLE', reason: 'Token do Focus NFe não configurado.' };
    const r = await call('DELETE', `${FOCUS.baseUrl(ctx.environment)}/v2/${path(ctx.model)}/${encodeURIComponent(ref)}`, ctx.token, { justificativa: reason });
    if (r === 'NETWORK' || r.status >= 500) return { kind: 'UNAVAILABLE', reason: 'Sem resposta do Focus NFe. Consulte a situação antes de tentar de novo.' };
    const b = r.body;
    if (r.status === 200 && str(b?.status) === 'cancelado') return { kind: 'CANCELLED', statusCode: str(b?.status_sefaz) ?? '135', xmlPath: str(b?.caminho_xml_cancelamento) };
    return { kind: 'REJECTED', statusCode: str(b?.status_sefaz) ?? str(b?.codigo) ?? String(r.status), reason: reasonOf(b) };
  }

  async download(p: string, ctx: ProviderCtx): Promise<{ content: Buffer; contentType: string }> {
    // O caminho vem do provedor, mas nunca é confiado: só caminho relativo simples, sempre no host do provedor (sem SSRF).
    if (!/^\/[A-Za-z0-9._~\-/%]+(\?[A-Za-z0-9._~\-/%=&]*)?$/.test(p) || p.includes('//') || p.includes('..')) throw new Error('Caminho de arquivo inválido.');
    const res = await fetch(`${FOCUS.baseUrl(ctx.environment)}${p}`, {
      headers: { authorization: `Basic ${Buffer.from(`${ctx.token ?? ''}:`).toString('base64')}` }, redirect: 'follow', signal: AbortSignal.timeout(FOCUS.timeoutMs),
    });
    if (!res.ok) throw new Error(`O provedor respondeu ${res.status} ao baixar o arquivo.`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > FOCUS.maxDownloadBytes) throw new Error('Arquivo grande demais.');
    return { content: buf, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
  }

  /** 404 `nao_encontrado` para uma referência inexistente prova que o token foi aceito; 401 prova que não. Nada é emitido. */
  async ping(ctx: ProviderCtx): Promise<{ ok: boolean; message: string }> {
    if (!ctx.token) return { ok: false, message: 'Informe o token.' };
    const r = await call('GET', `${FOCUS.baseUrl(ctx.environment)}/v2/nfe/dh-teste-conexao`, ctx.token);
    if (r === 'NETWORK') return { ok: false, message: 'Não foi possível falar com o Focus NFe (rede).' };
    if (r.status === 401 || r.status === 403) return { ok: false, message: 'Token recusado pelo Focus NFe para este ambiente.' };
    if (r.status === 404 || r.status === 200) return { ok: true, message: 'Token aceito pelo Focus NFe.' };
    return { ok: false, message: `Resposta inesperada do Focus NFe (${r.status}).` };
  }
}
