import {
  BaseConnector, CapabilityMatrix, ConnectionContext, ConnectorInfo, Credentials, ErrorCode, ExternalOrder, ExternalOrderItem, ExternalProduct, fail, okResult, OpResult,
} from './connector';

/**
 * Conector Magalu (Marketplace) — escopo desta etapa: autorização OAuth, validação, renovação, leitura de pedidos e leitura
 * do catálogo (SKUs). Publicação, preço, estoque, envios e notificações continuam PLANNED.
 *
 * ORIGEM DAS REGRAS (ver docs/MARKETPLACE-INTEGRATIONS.md → Magalu):
 *  [CONFIRMADO]  páginas oficiais de developers.magalu.com lidas em 21/10/2026: endereços de login e token, parâmetros do consentimento
 *                (choose_tenants=true para sellers), concessões authorization_code/refresh_token, escopos, URL da API e rotas
 *                GET /seller/v1/orders e GET /seller/v1/portfolios/skus.
 *  [A VALIDAR]   o que a documentação pública NÃO traz nas páginas lidas: formato das respostas (nomes de campos), paginação,
 *                filtros, cabeçalhos extras e vocabulário de status. A leitura é TOLERANTE (aceita nomes alternativos) e nunca inventa
 *                dados; confirme com uma conta de seller real antes de confiar.
 * Todos os endereços podem ser sobrescritos por variáveis de ambiente para testes com servidor simulado.
 */
export const MAGALU = {
  authBase: () => process.env.MAGALU_AUTH_BASE ?? 'https://id.magalu.com', // [CONFIRMADO] /login e /oauth/token
  apiBase: () => process.env.MAGALU_API_BASE ?? 'https://api.magalu.com', // [CONFIRMADO] ambiente de produção do Marketplace
  clientId: () => process.env.MAGALU_CLIENT_ID ?? '',
  clientSecret: () => process.env.MAGALU_CLIENT_SECRET ?? '',
  /** [CONFIRMADO] nomes dos escopos de leitura (pedidos, entregas, SKUs, preços e estoques). Somados aos escopos padrão do client. */
  scopes: () => process.env.MAGALU_SCOPES ?? 'open:order-order-seller:read open:order-delivery-seller:read open:portfolio-skus-seller:read open:portfolio-prices-seller:read open:portfolio-stocks-seller:read',
  /** [A VALIDAR] vocabulário de status do pedido. Só o que for listado aqui é tratado como pago/cancelado; o resto é ignorado (nunca importa pedido não pago). */
  paidStatuses: () => csv(process.env.MAGALU_PAID_STATUSES),
  cancelledStatuses: () => csv(process.env.MAGALU_CANCELLED_STATUSES ?? 'canceled,cancelled'),
  timeoutMs: 10_000,
};

type Json = Record<string, unknown>;
const csv = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => { const n = Number(typeof v === 'object' && v !== null ? (v as Json).value ?? (v as Json).amount : v); return Number.isFinite(n) ? n : undefined; };
const rec = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});

function httpError(status: number, body: Json | null, retryAfter: string | null): OpResult<never> {
  const detail = String(body?.detail ?? body?.message ?? body?.error_description ?? body?.error ?? `HTTP ${status}`).slice(0, 300);
  let code: ErrorCode = 'ERROR';
  if (status === 401 || status === 403) code = 'AUTH';
  else if (status === 429) code = 'RATE_LIMIT';
  else if (status >= 500) code = 'UNAVAILABLE';
  else if (status === 400 || status === 404 || status === 422) code = 'VALIDATION';
  if (/invalid_grant|invalid_token|expired/i.test(detail)) code = 'AUTH';
  const ra = retryAfter ? Number(retryAfter) * 1000 : undefined;
  return fail(code, `Magalu respondeu ${status}: ${detail}`, code === 'RATE_LIMIT' ? (ra && ra > 0 ? ra : 60_000) : undefined);
}

async function request(method: string, url: string, init: { headers?: Record<string, string>; body?: string } = {}): Promise<OpResult<Json>> {
  try {
    const res = await fetch(url, { method, headers: { accept: 'application/json', ...init.headers }, body: init.body, signal: AbortSignal.timeout(MAGALU.timeoutMs) });
    const text = await res.text();
    let body: Json | null = null;
    try { body = text ? (JSON.parse(text) as Json) : {}; } catch { body = null; }
    if (!res.ok) return httpError(res.status, body, res.headers.get('retry-after'));
    if (body === null) return fail('UNAVAILABLE', 'Resposta inválida (não é JSON) do Magalu.');
    return okResult(body);
  } catch (e) {
    const err = e as Error;
    return fail('UNAVAILABLE', err.name === 'TimeoutError' ? 'Tempo esgotado ao consultar o Magalu.' : `Falha de rede ao consultar o Magalu: ${err.message}`);
  }
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

function toTokenResult(b: Json): OpResult<Credentials> {
  const access = b.access_token;
  const refresh = b.refresh_token;
  if (typeof access !== 'string') return fail('VALIDATION', 'Resposta de token sem access_token.');
  const ttl = Number(b.expires_in); // [CONFIRMADO] expires_in (exemplo: 7200 s); nunca presumido
  return okResult({
    credentials: { accessToken: access, ...(typeof refresh === 'string' ? { refreshToken: refresh } : {}), scope: b.scope ?? null },
    expiresAt: Number.isFinite(ttl) && ttl > 0 ? new Date(Date.now() + ttl * 1000) : undefined,
  });
}

function bearer(ctx: ConnectionContext): Record<string, string> | null {
  const t = ctx.credentials?.accessToken;
  return typeof t === 'string' ? { authorization: `Bearer ${t}` } : null;
}

/** Lista de itens de uma resposta paginada: aceita array puro ou os envelopes mais comuns. [A VALIDAR] nome real do envelope. */
export function listOf(b: unknown): Json[] {
  if (Array.isArray(b)) return b as Json[];
  const o = rec(b);
  for (const k of ['results', 'items', 'data', 'orders', 'skus']) if (Array.isArray(o[k])) return o[k] as Json[];
  return [];
}

/** Próxima página, se a resposta trouxer o link (meta.links.next); só aceita endereços do mesmo servidor da API. [A VALIDAR] */
export function nextLink(b: unknown, apiBase: string): string | undefined {
  const o = rec(b);
  const raw = str(rec(rec(o.meta).links).next) ?? str(rec(o.links).next) ?? str(o.next);
  if (!raw) return undefined;
  try {
    const base = new URL(apiBase);
    const u = new URL(raw, base);
    return u.origin === base.origin ? `${u.pathname}${u.search}` : undefined;
  } catch { return undefined; }
}

/**
 * Normaliza um pedido do Magalu. [A VALIDAR] nomes: código `code` (ou id), `status`, `created_at`, itens em `items`/`order_items`
 * (sku, quantity, unit price), total em `amount`/`total`. O status devolvido segue o vocabulário comum do importador:
 * 'paid'/'cancelled' somente quando listado em MAGALU_PAID_STATUSES/MAGALU_CANCELLED_STATUSES; qualquer outro segue como veio (ou 'pending' se vazio) e fica aguardando pagamento.
 */
export function normalizeOrder(o: Json): ExternalOrder | null {
  const id = str(o.code) ?? (o.id !== undefined && o.id !== null ? String(o.id) : undefined);
  if (!id) return null;
  const rawStatus = String(o.status ?? '').toLowerCase();
  // Status não listado segue como veio do canal (aparece no motivo "Situação no canal"), exceto os que o importador entenderia por engano.
  const reserved = ['paid', 'cancelled', 'invalid'];
  const status = MAGALU.cancelledStatuses().includes(rawStatus) ? 'cancelled' : MAGALU.paidStatuses().includes(rawStatus) ? 'paid' : reserved.includes(rawStatus) || !rawStatus ? 'pending' : rawStatus;
  const items: ExternalOrderItem[] = (Array.isArray(o.items) ? (o.items as Json[]) : Array.isArray(o.order_items) ? (o.order_items as Json[]) : []).map((it) => {
    const sku = rec(it.sku);
    return {
      externalItemId: String(str(it.id) ?? str(sku.sku) ?? str(it.sku) ?? str(it.code) ?? ''),
      sku: str(it.sku) ?? str(sku.sku) ?? str(sku.code) ?? str(it.seller_sku) ?? null,
      title: str(it.title) ?? str(it.name) ?? str(sku.title) ?? str(sku.name),
      quantity: num(it.quantity) ?? 0,
      unitPrice: num(it.unit_price) ?? num(it.unitPrice) ?? num(it.price) ?? 0,
    };
  });
  const cust = rec(o.customer ?? o.buyer);
  const buyerId = str(cust.id) ?? str(cust.document) ?? (cust.id !== undefined ? String(cust.id) : undefined);
  return {
    externalId: id, status,
    createdAt: str(o.created_at) ?? str(o.createdAt) ?? str(o.date_created),
    total: num(o.amount) ?? num(o.total) ?? num(o.total_amount),
    buyer: buyerId ? { id: buyerId, name: str(cust.name), nickname: str(cust.name) } : undefined,
    items,
    raw: { code: id, channelStatus: o.status ?? null },
  };
}

/** Normaliza um SKU do portfólio. [A VALIDAR] nomes: sku (ou code/id), title (ou name), brand, ean/gtin, images. Sem título, o item é descartado. */
export function normalizeSku(o: Json): ExternalProduct | null {
  const sku = str(o.sku) ?? str(o.code) ?? (o.id !== undefined && o.id !== null ? String(o.id) : undefined);
  const title = str(o.title) ?? str(o.name);
  if (!sku || !title) return null;
  const gtinRaw = str(o.ean) ?? str(o.gtin) ?? str(o.barcode);
  const brand = o.brand;
  const imgs = Array.isArray(o.images) ? (o.images as unknown[]) : [];
  return {
    externalId: sku, title, sku,
    description: str(o.description),
    gtin: gtinRaw && /^\d{8,14}$/.test(gtinRaw) ? gtinRaw : null,
    brand: typeof brand === 'string' ? brand.trim() || null : str(rec(brand).name) ?? null,
    model: str(o.model) ?? null,
    price: num(o.price),
    quantity: num(o.stock) ?? num(o.quantity),
    condition: 'NEW',
    status: str(o.status),
    pictures: imgs.map((i) => (typeof i === 'string' ? i : str(rec(i).url))).filter((u): u is string => !!u),
    attributes: [],
    raw: { sku },
  };
}

export class MagaluConnector extends BaseConnector {
  readonly info: ConnectorInfo = {
    provider: 'MAGALU', displayName: 'Magalu', category: 'MARKETPLACE', region: 'BR', authType: 'OAUTH2',
    docsUrl: 'https://developers.magalu.com/',
    notes: 'Requer um aplicativo criado no portal de desenvolvedores do Magalu (pela ferramenta idm) e conta de seller. Hoje: autorização, leitura de pedidos e leitura dos SKUs (importar para a base). O formato exato das respostas ainda não foi validado com conta real. Publicação, preço, estoque, envios e notificações ainda não.',
    imageHosts: [], // domínio das fotos não confirmado: nenhuma foto é baixada na importação
  };

  getCapabilities(): CapabilityMatrix {
    return {
      authorization: 'IMPLEMENTED_UNVERIFIED', orders: 'IMPLEMENTED_UNVERIFIED', catalog: 'IMPLEMENTED_UNVERIFIED',
      publishing: 'PLANNED', price: 'PLANNED', inventory: 'PLANNED', shipments: 'PLANNED', webhooks: 'PLANNED',
    };
  }

  private notConfigured(): OpResult<never> {
    return fail('NOT_CONFIGURED', 'Aplicativo do Magalu não configurado no servidor: defina MAGALU_CLIENT_ID e MAGALU_CLIENT_SECRET (criados com a ferramenta idm no portal de desenvolvedores).');
  }

  authorizeConnection(_c: ConnectionContext, p: { redirectUri: string; state: string }): Promise<OpResult<{ authorizationUrl: string }>> {
    if (!MAGALU.clientId() || !MAGALU.clientSecret()) return Promise.resolve(this.notConfigured());
    // [CONFIRMADO] choose_tenants=true é obrigatório para sellers (escolher a loja); scope separado por espaço.
    const q = form({ client_id: MAGALU.clientId(), redirect_uri: p.redirectUri, scope: MAGALU.scopes(), response_type: 'code', choose_tenants: 'true', state: p.state });
    return Promise.resolve(okResult({ authorizationUrl: `${MAGALU.authBase()}/login?${q}` }));
  }

  async completeAuthorization(_c: ConnectionContext, p: { code: string; redirectUri: string; state: string }): Promise<OpResult<Credentials>> {
    if (!MAGALU.clientId() || !MAGALU.clientSecret()) return this.notConfigured();
    // [CONFIRMADO] troca do código: POST com JSON; o código vale 10 min e é de uso único.
    const r = await request('POST', `${MAGALU.authBase()}/oauth/token`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', client_id: MAGALU.clientId(), client_secret: MAGALU.clientSecret(), redirect_uri: p.redirectUri, code: p.code }),
    });
    if (!r.ok) return r;
    const t = toTokenResult(r.data);
    if (t.ok && !t.data.credentials.refreshToken) return fail('VALIDATION', 'O Magalu não devolveu refresh_token: a conexão não se renovaria sozinha. Confira os escopos do aplicativo.');
    return t;
  }

  async validateConnection(ctx: ConnectionContext): Promise<OpResult<{ externalAccountId?: string }>> {
    const h = bearer(ctx);
    if (!h) return fail('AUTH', 'Conexão sem credenciais.');
    // Não há (nas páginas lidas) um endereço "quem sou eu": uma leitura simples de pedidos prova que o token e o escopo funcionam.
    const r = await request('GET', `${MAGALU.apiBase()}/seller/v1/orders`, { headers: h });
    if (!r.ok) return r;
    return okResult({});
  }

  async refreshAuthorization(ctx: ConnectionContext): Promise<OpResult<Credentials>> {
    if (!MAGALU.clientId() || !MAGALU.clientSecret()) return this.notConfigured();
    const rt = ctx.credentials?.refreshToken;
    if (typeof rt !== 'string') return fail('AUTH', 'Sem refresh token: reconecte a conta.');
    // [CONFIRMADO] renovação: POST application/x-www-form-urlencoded; a resposta traz um novo refresh_token (quem chama grava o novo).
    const r = await request('POST', `${MAGALU.authBase()}/oauth/token`, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'refresh_token', client_id: MAGALU.clientId(), client_secret: MAGALU.clientSecret(), refresh_token: rt }),
    });
    if (!r.ok) return r;
    const t = toTokenResult(r.data);
    if (t.ok && !t.data.credentials.refreshToken) t.data.credentials.refreshToken = rt; // se não vier um novo, mantém o atual
    return t;
  }

  revokeAuthorization(): Promise<OpResult<null>> {
    // Sem endereço de revogação confirmado: apenas descartamos as credenciais localmente (feito por quem chama).
    return Promise.resolve(okResult(null));
  }

  async fetchOrders(ctx: ConnectionContext, p: { since?: Date; cursor?: string }): Promise<OpResult<{ orders: ExternalOrder[]; nextCursor?: string }>> {
    const h = bearer(ctx);
    if (!h) return fail('AUTH', 'Conexão sem credenciais.');
    // Paginação/filtros não constam nas páginas lidas: sem parâmetros inventados. `since` é ignorado (o livro de pedidos é idempotente).
    const path = p.cursor && p.cursor.startsWith('/seller/') ? p.cursor : '/seller/v1/orders';
    const r = await request('GET', `${MAGALU.apiBase()}${path}`, { headers: h });
    if (!r.ok) return r;
    const orders = listOf(r.data).map(normalizeOrder).filter((o): o is ExternalOrder => !!o);
    return okResult({ orders, nextCursor: nextLink(r.data, MAGALU.apiBase()) });
  }

  async fetchProducts(ctx: ConnectionContext, p: { cursor?: string }): Promise<OpResult<{ products: ExternalProduct[]; nextCursor?: string }>> {
    const h = bearer(ctx);
    if (!h) return fail('AUTH', 'Conexão sem credenciais.');
    const path = p.cursor && p.cursor.startsWith('/seller/') ? p.cursor : '/seller/v1/portfolios/skus';
    const r = await request('GET', `${MAGALU.apiBase()}${path}`, { headers: h });
    if (!r.ok) return r;
    const products = listOf(r.data).map(normalizeSku).filter((x): x is ExternalProduct => !!x);
    return okResult({ products, nextCursor: nextLink(r.data, MAGALU.apiBase()) });
  }

  async fetchProductDetail(ctx: ConnectionContext, p: { externalId: string }): Promise<OpResult<ExternalProduct>> {
    const h = bearer(ctx);
    if (!h) return fail('AUTH', 'Conexão sem credenciais.');
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(p.externalId)) return fail('VALIDATION', 'Identificador de SKU inválido.');
    const r = await request('GET', `${MAGALU.apiBase()}/seller/v1/portfolios/skus/${encodeURIComponent(p.externalId)}`, { headers: h }); // [A VALIDAR] caminho "Consultar pelo SKU"
    if (!r.ok) return r;
    const item = normalizeSku(r.data) ?? normalizeSku(rec(r.data.data));
    if (!item) return fail('VALIDATION', 'Resposta de SKU sem código/título.');
    return okResult(item);
  }
}
