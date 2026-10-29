import {
  BaseConnector, CapabilityMatrix, ConnectionContext, ConnectorInfo, Credentials, ErrorCode, ExternalOrder, ExternalOrderItem, fail, okResult, OpResult,
} from './connector';

/**
 * Conector Amazon (Selling Partner API, SP-API) — escopo desta etapa: AUTORIZAÇÃO PRÓPRIA (o vendedor cria um aplicativo privado no
 * Seller Central e informa as credenciais; não há tela de autorização/redirecionamento), validação, renovação do token e LEITURA de pedidos.
 * Catálogo, publicação, preço, estoque, envios e notificações continuam PLANNED.
 *
 * ORIGEM DAS REGRAS (ver docs/MARKETPLACE-INTEGRATIONS.md → Amazon):
 *  [DOCUMENTAÇÃO] pesquisa em 29/10/2026 (leitura parcial das páginas oficiais; algumas só por resumos de busca): troca do refresh token
 *                 no Login with Amazon (POST api.amazon.com/auth/o2/token, grant_type=refresh_token, access token de 1 h), cabeçalho
 *                 x-amz-access-token (sem assinatura AWS SigV4), Orders API v0 (GET /orders/v0/orders e .../{id}/orderItems), marketplace do Brasil
 *                 A2Q3Y263D00KWC servido pela região América do Norte (sellingpartnerapi-na.amazon.com).
 *  [A VALIDAR]    tudo acima contra uma conta real; limites de taxa (getOrders ≈ 1 req/min; getOrderItems ≈ 1 req/2 s) e o vocabulário de status.
 *                 Dados pessoais do comprador exigem o "Restricted Data Token", que NÃO é usado: o comprador aparece sem endereço/CPF.
 * Endereços e o marketplace podem ser sobrescritos por variáveis de ambiente (testes com servidor simulado).
 */
export const AMAZON = {
  lwaUrl: () => process.env.AMAZON_LWA_URL ?? 'https://api.amazon.com/auth/o2/token',
  apiBase: () => process.env.AMAZON_SPAPI_BASE ?? 'https://sellingpartnerapi-na.amazon.com',
  marketplaceId: () => process.env.AMAZON_MARKETPLACE_ID ?? 'A2Q3Y263D00KWC', // Brasil
  /** Intervalo mínimo entre chamadas de itens do pedido (limite ≈ 0,5 req/s). */
  itemGapMs: () => Number(process.env.AMAZON_ITEM_GAP_MS ?? 2100),
  pageSize: 20,
  /** Primeira leitura (sem `since`): últimos 30 dias. */
  initialDays: 30,
  timeoutMs: 20_000,
};

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const rec = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const money = (v: unknown): number | undefined => { const n = Number(rec(v).Amount); return Number.isFinite(n) ? n : undefined; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function httpError(status: number, body: Json | null, retryAfter: string | null): OpResult<never> {
  const err = Array.isArray(body?.errors) ? (body!.errors as Json[])[0] : undefined;
  const detail = String(err?.message ?? err?.code ?? body?.error_description ?? body?.error ?? `HTTP ${status}`).slice(0, 300);
  let code: ErrorCode = 'ERROR';
  if (status === 401 || status === 403) code = 'AUTH';
  else if (status === 429) code = 'RATE_LIMIT';
  else if (status >= 500) code = 'UNAVAILABLE';
  else if (status === 400 || status === 404 || status === 422) code = 'VALIDATION';
  if (/invalid_grant|invalid_client|invalid_token|expired|unauthorized/i.test(`${detail} ${String(body?.error ?? '')}`)) code = 'AUTH';
  const ra = retryAfter ? Number(retryAfter) * 1000 : undefined;
  return fail(code, `Amazon respondeu ${status}: ${detail}`, code === 'RATE_LIMIT' ? (ra && ra > 0 ? ra : 90_000) : undefined);
}

async function request(method: string, url: string, init: { headers?: Record<string, string>; body?: string } = {}): Promise<OpResult<Json>> {
  try {
    const res = await fetch(url, { method, headers: { accept: 'application/json', ...init.headers }, body: init.body, signal: AbortSignal.timeout(AMAZON.timeoutMs) });
    const text = await res.text();
    let body: Json | null = null;
    try { body = text ? (JSON.parse(text) as Json) : {}; } catch { body = null; }
    if (!res.ok) return httpError(res.status, body, res.headers.get('retry-after'));
    if (body === null) return fail('UNAVAILABLE', 'Resposta inválida (não é JSON) da Amazon.');
    return okResult(body);
  } catch (e) {
    const err = e as Error;
    return fail('UNAVAILABLE', err.name === 'TimeoutError' ? 'Tempo esgotado ao consultar a Amazon.' : `Falha de rede ao consultar a Amazon: ${err.message}`);
  }
}

/** Troca o refresh token por um access token (válido por ~1 h). */
async function exchange(clientId: string, clientSecret: string, refreshToken: string): Promise<OpResult<{ accessToken: string; expiresAt?: Date }>> {
  const r = await request('POST', AMAZON.lwaUrl(), {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }).toString(),
  });
  if (!r.ok) return r;
  const access = r.data.access_token;
  if (typeof access !== 'string') return fail('VALIDATION', 'Resposta da Amazon sem access_token.');
  const ttl = Number(r.data.expires_in);
  return okResult({ accessToken: access, expiresAt: Number.isFinite(ttl) && ttl > 0 ? new Date(Date.now() + ttl * 1000) : undefined });
}

const field = (f: Record<string, unknown> | null | undefined, k: string) => (typeof f?.[k] === 'string' ? (f[k] as string).trim() : '');

function headers(ctx: ConnectionContext): Record<string, string> | null {
  const t = ctx.credentials?.accessToken;
  return typeof t === 'string' ? { 'x-amz-access-token': t } : null;
}

/**
 * Status da Amazon → vocabulário do importador. Unshipped/PartiallyShipped/Shipped = pagamento confirmado (a Amazon só libera o envio depois);
 * Canceled = cancelado; Pending/PendingAvailability = aguardando pagamento; o resto segue como veio e fica aguardando (nunca vira venda).
 */
export function mapStatus(s: string | undefined): string {
  switch ((s ?? '').toLowerCase()) {
    case 'unshipped': case 'partiallyshipped': case 'shipped': return 'paid';
    case 'canceled': case 'cancelled': return 'cancelled';
    case 'pending': case 'pendingavailability': case '': return 'pending';
    default: return `amazon_${(s ?? '').toLowerCase()}`;
  }
}

/** Normaliza um pedido (sem itens; os itens vêm de outra chamada). */
export function normalizeOrder(o: Json): ExternalOrder | null {
  const id = str(o.AmazonOrderId);
  if (!id) return null;
  const buyer = rec(o.BuyerInfo);
  return {
    externalId: id, status: mapStatus(str(o.OrderStatus)),
    createdAt: str(o.PurchaseDate),
    total: money(o.OrderTotal),
    buyer: { id: str(buyer.BuyerEmail) ?? id, name: str(buyer.BuyerName), nickname: str(buyer.BuyerName) },
    items: [],
    raw: { AmazonOrderId: id, channelStatus: o.OrderStatus ?? null, fulfillmentChannel: o.FulfillmentChannel ?? null, lastUpdate: o.LastUpdateDate ?? null },
  };
}

/** Normaliza os itens: `ItemPrice` da Amazon é o total da linha (preço × quantidade), então o unitário é calculado. */
export function normalizeItems(list: unknown): ExternalOrderItem[] {
  return (Array.isArray(list) ? (list as Json[]) : []).map((it) => {
    const qty = Number(it.QuantityOrdered);
    const total = money(it.ItemPrice);
    return {
      externalItemId: String(str(it.OrderItemId) ?? str(it.SellerSKU) ?? ''),
      sku: str(it.SellerSKU) ?? null,
      title: str(it.Title),
      quantity: Number.isFinite(qty) ? qty : 0,
      unitPrice: total !== undefined && qty > 0 ? Math.round((total / qty) * 100) / 100 : 0,
    };
  });
}

export class AmazonConnector extends BaseConnector {
  readonly info: ConnectorInfo = {
    provider: 'AMAZON', displayName: 'Amazon', category: 'MARKETPLACE', region: 'BR', authType: 'API_KEY',
    docsUrl: 'https://developer-docs.amazon.com/sp-api/',
    notes: 'Autorização própria: no Seller Central (Aplicativos e serviços → Desenvolver aplicativos) crie um aplicativo privado e autorize-o para a sua conta; informe aqui o ID e o segredo do aplicativo (Login with Amazon), o token de atualização e o ID do vendedor. Hoje: leitura de pedidos (somente os enviados por você; pedidos FBA ficam de fora). Não foi testado contra a conta real.',
    imageHosts: [],
    credentialFields: [
      { name: 'lwaClientId', label: 'ID do aplicativo (Client ID)', hint: 'Começa com amzn1.application-oa2-client.' },
      { name: 'lwaClientSecret', label: 'Segredo do aplicativo (Client Secret)', secret: true },
      { name: 'refreshToken', label: 'Token de atualização (Refresh Token)', secret: true, hint: 'Começa com Atzr|. Gerado ao autorizar o aplicativo na sua conta.' },
      { name: 'sellerId', label: 'ID do vendedor (Merchant Token)', hint: 'Seller Central → Configurações → Informações da conta → ID do comerciante.' },
    ],
  };

  getCapabilities(): CapabilityMatrix {
    return {
      authorization: 'IMPLEMENTED_UNVERIFIED', orders: 'IMPLEMENTED_UNVERIFIED', catalog: 'PLANNED',
      publishing: 'PLANNED', price: 'PLANNED', inventory: 'PLANNED', shipments: 'PLANNED', webhooks: 'UNSUPPORTED',
    };
  }

  /** Autorização própria: confere as credenciais trocando o token e devolve o que será guardado (cifrado). */
  async authorizeWithCredentials(_ctx: ConnectionContext, f: Record<string, string>): Promise<OpResult<Credentials>> {
    const lwaClientId = field(f, 'lwaClientId'); const lwaClientSecret = field(f, 'lwaClientSecret'); const refreshToken = field(f, 'refreshToken'); const sellerId = field(f, 'sellerId');
    if (!lwaClientId || !lwaClientSecret || !refreshToken || !sellerId) return fail('VALIDATION', 'Preencha o ID e o segredo do aplicativo, o token de atualização e o ID do vendedor.');
    if (!/^[A-Z0-9]{8,20}$/.test(sellerId)) return fail('VALIDATION', 'ID do vendedor inválido (letras maiúsculas e números, ex.: A1B2C3D4E5F6G7).');
    const t = await exchange(lwaClientId, lwaClientSecret, refreshToken);
    if (!t.ok) return t;
    return okResult({ credentials: { lwaClientId, lwaClientSecret, refreshToken, accessToken: t.data.accessToken, sellerId }, expiresAt: t.data.expiresAt, externalAccountId: sellerId });
  }

  authorizeConnection(): Promise<OpResult<{ authorizationUrl: string }>> {
    return Promise.resolve(fail('UNSUPPORTED', 'A Amazon usa autorização própria: informe as credenciais do seu aplicativo privado (não há tela de autorização).'));
  }

  async validateConnection(ctx: ConnectionContext): Promise<OpResult<{ externalAccountId?: string }>> {
    const h = headers(ctx);
    if (!h) return fail('AUTH', 'Conexão sem credenciais.');
    const r = await request('GET', `${AMAZON.apiBase()}/sellers/v1/marketplaceParticipations`, { headers: h });
    if (!r.ok) return r;
    const list = Array.isArray(r.data.payload) ? (r.data.payload as Json[]) : [];
    const ok = list.some((p) => rec(p.marketplace).id === AMAZON.marketplaceId() && rec(p.participation).isParticipating !== false);
    if (!ok) return fail('VALIDATION', 'Esta conta da Amazon não participa do marketplace do Brasil (Amazon.com.br).');
    return okResult({ externalAccountId: typeof ctx.credentials?.sellerId === 'string' ? ctx.credentials.sellerId : undefined });
  }

  async refreshAuthorization(ctx: ConnectionContext): Promise<OpResult<Credentials>> {
    const c = ctx.credentials ?? {};
    if (typeof c.lwaClientId !== 'string' || typeof c.lwaClientSecret !== 'string' || typeof c.refreshToken !== 'string') return fail('AUTH', 'Credenciais incompletas: informe-as novamente.');
    const t = await exchange(c.lwaClientId, c.lwaClientSecret, c.refreshToken);
    if (!t.ok) return t;
    return okResult({ credentials: { ...c, accessToken: t.data.accessToken }, expiresAt: t.data.expiresAt });
  }

  revokeAuthorization(): Promise<OpResult<null>> {
    return Promise.resolve(okResult(null)); // as credenciais são descartadas localmente; a revogação é feita no Seller Central
  }

  async fetchOrders(ctx: ConnectionContext, p: { since?: Date; cursor?: string }): Promise<OpResult<{ orders: ExternalOrder[]; nextCursor?: string }>> {
    const h = headers(ctx);
    if (!h) return fail('AUTH', 'Conexão sem credenciais.');
    // Com NextToken só o próprio NextToken é aceito; sem ele, filtro por data de atualização (obrigatório) e marketplace.
    const q = p.cursor
      ? new URLSearchParams({ NextToken: p.cursor })
      : new URLSearchParams({
        MarketplaceIds: AMAZON.marketplaceId(), MaxResultsPerPage: String(AMAZON.pageSize),
        LastUpdatedAfter: (p.since ?? new Date(Date.now() - AMAZON.initialDays * 86_400_000)).toISOString(),
      });
    const r = await request('GET', `${AMAZON.apiBase()}/orders/v0/orders?${q}`, { headers: h });
    if (!r.ok) return r;
    const payload = rec(r.data.payload);
    const raw = (Array.isArray(payload.Orders) ? (payload.Orders as Json[]) : []);
    // Pedidos FBA (a Amazon separa e entrega) não saem do NOSSO estoque: ficam de fora para não reservar/baixar saldo indevidamente.
    const mine = raw.filter((o) => str(o.FulfillmentChannel)?.toUpperCase() !== 'AFN');
    const orders: ExternalOrder[] = [];
    let first = true;
    for (const o of mine) {
      const n = normalizeOrder(o);
      if (!n) continue;
      if (n.status === 'paid') {
        // itens só dos pedidos que viram venda (limite de taxa baixo: espaçamos as chamadas)
        if (!first) await sleep(AMAZON.itemGapMs());
        first = false;
        const it = await request('GET', `${AMAZON.apiBase()}/orders/v0/orders/${encodeURIComponent(n.externalId)}/orderItems`, { headers: h });
        if (!it.ok) return it;
        n.items = normalizeItems(rec(it.data.payload).OrderItems);
      }
      orders.push(n);
    }
    const next = str(payload.NextToken);
    return okResult({ orders, nextCursor: next });
  }
}
