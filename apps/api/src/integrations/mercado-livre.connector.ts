import { createHash, createHmac } from 'node:crypto';
import { getConfig } from '../config/app.config';
import {
  BaseConnector, CapabilityMatrix, ConnectionContext, ConnectorInfo, Credentials, ErrorCode, ExternalOrder, ExternalOrderItem, fail, okResult, OpResult,
} from './connector';

/**
 * Conector Mercado Livre — escopo desta etapa: autorização OAuth, validação, renovação, leitura de pedidos e
 * notificações de pedidos. Publicação, preço, estoque, catálogo e envios continuam NOT_IMPLEMENTED.
 *
 * ORIGEM DAS REGRAS (ver docs/MARKETPLACE-INTEGRATIONS.md → "Verificação da documentação"):
 *  [CONFIRMADO]  trecho de páginas oficiais obtido por busca em developers.mercadolivre.com.br (leitura direta bloqueada, HTTP 403)
 *  [A VALIDAR]   conhecimento prévio do contrato da API, NÃO confirmado nesta sessão; deve ser validado com conta real
 * Todos os endereços podem ser sobrescritos por variáveis de ambiente para testes com servidor simulado.
 */
export const ML = {
  authBase: () => process.env.ML_AUTH_BASE ?? 'https://auth.mercadolivre.com.br', // [CONFIRMADO] domínio de autorização do Brasil
  apiBase: () => process.env.ML_API_BASE ?? 'https://api.mercadolibre.com', // [CONFIRMADO] api.mercadolibre.com/oauth/token e /orders/search
  clientId: () => process.env.ML_CLIENT_ID ?? '',
  clientSecret: () => process.env.ML_CLIENT_SECRET ?? '',
  usePkce: () => process.env.ML_USE_PKCE === 'true', // [CONFIRMADO] PKCE só se habilitado no aplicativo
  pageSize: 50, // [A VALIDAR] limite máximo do parâmetro limit
  timeoutMs: 10_000,
};

type Json = Record<string, unknown>;

/** Mapeia respostas HTTP para os códigos de erro comuns, sem nunca ecoar tokens. */
function httpError(status: number, body: Json | null, retryAfter: string | null): OpResult<never> {
  const detail = String(body?.message ?? body?.error ?? `HTTP ${status}`);
  let code: ErrorCode = 'ERROR';
  if (status === 401 || status === 403) code = 'AUTH';
  else if (status === 429) code = 'RATE_LIMIT';
  else if (status >= 500) code = 'UNAVAILABLE';
  else if (status === 400 || status === 404 || status === 422) code = 'VALIDATION';
  // invalid_grant/invalid_token: autorização inválida ou expirada
  if (/invalid_grant|invalid_token|expired_token/i.test(detail)) code = 'AUTH';
  const ra = retryAfter ? Number(retryAfter) * 1000 : undefined;
  return fail(code, `Mercado Livre respondeu ${status}: ${detail}`, code === 'RATE_LIMIT' ? (ra && ra > 0 ? ra : 60_000) : undefined);
}

async function request(method: string, url: string, init: { headers?: Record<string, string>; body?: string } = {}): Promise<OpResult<Json>> {
  try {
    const res = await fetch(url, { method, headers: { accept: 'application/json', ...init.headers }, body: init.body, signal: AbortSignal.timeout(ML.timeoutMs) });
    const text = await res.text();
    let body: Json | null = null;
    try { body = text ? (JSON.parse(text) as Json) : {}; } catch { body = null; }
    if (!res.ok) return httpError(res.status, body, res.headers.get('retry-after'));
    if (body === null) return fail('UNAVAILABLE', 'Resposta inválida (não é JSON) do Mercado Livre.');
    return okResult(body);
  } catch (e) {
    const err = e as Error;
    return fail('UNAVAILABLE', err.name === 'TimeoutError' ? 'Tempo esgotado ao consultar o Mercado Livre.' : `Falha de rede ao consultar o Mercado Livre: ${err.message}`);
  }
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

/** Verificador PKCE determinístico a partir do state (sem guardar nada no servidor). */
function pkceVerifier(state: string): string {
  return createHmac('sha256', getConfig().jwtSecret).update(`pkce:${state}`).digest('base64url');
}

function toTokenResult(b: Json): OpResult<Credentials> {
  const access = b.access_token;
  const refresh = b.refresh_token;
  if (typeof access !== 'string') return fail('VALIDATION', 'Resposta de token sem access_token.');
  // [CONFIRMADO] a validade deve ser lida de expires_in (a documentação traz exemplos diferentes); nunca presumida.
  const ttl = Number(b.expires_in);
  return okResult({
    credentials: { accessToken: access, ...(typeof refresh === 'string' ? { refreshToken: refresh } : {}), scope: b.scope ?? null },
    expiresAt: Number.isFinite(ttl) && ttl > 0 ? new Date(Date.now() + ttl * 1000) : undefined,
    externalAccountId: b.user_id !== undefined ? String(b.user_id) : undefined,
  });
}

function bearer(ctx: ConnectionContext): Record<string, string> | null {
  const t = ctx.credentials?.accessToken;
  return typeof t === 'string' ? { authorization: `Bearer ${t}` } : null;
}

/** Normaliza um pedido do Mercado Livre. [A VALIDAR] nomes de campos: id, status, date_created, order_items[].item, buyer. */
export function normalizeOrder(o: Json): ExternalOrder | null {
  if (o.id === undefined || o.id === null) return null;
  const items: ExternalOrderItem[] = (Array.isArray(o.order_items) ? (o.order_items as Json[]) : []).map((oi) => {
    const item = (oi.item ?? {}) as Json;
    return {
      externalItemId: String(item.id ?? ''),
      sku: (item.seller_sku ?? item.seller_custom_field ?? null) as string | null,
      title: typeof item.title === 'string' ? item.title : undefined,
      quantity: Number(oi.quantity ?? 0),
      unitPrice: Number(oi.unit_price ?? 0),
    };
  });
  const buyer = (o.buyer ?? null) as Json | null;
  return {
    externalId: String(o.id), status: String(o.status ?? ''), createdAt: typeof o.date_created === 'string' ? o.date_created : undefined,
    total: o.total_amount !== undefined ? Number(o.total_amount) : undefined,
    buyer: buyer && buyer.id !== undefined ? { id: String(buyer.id), nickname: typeof buyer.nickname === 'string' ? buyer.nickname : undefined } : undefined,
    items, raw: { id: o.id, status: o.status, pack_id: o.pack_id ?? null, shipping: (o.shipping as Json | undefined)?.id ?? null },
  };
}

export class MercadoLivreConnector extends BaseConnector {
  readonly info: ConnectorInfo = {
    provider: 'MERCADO_LIVRE', displayName: 'Mercado Livre', authType: 'OAUTH2',
    docsUrl: 'https://developers.mercadolivre.com.br/pt_br/api-docs-pt-br',
    notes: 'Requer aplicativo no Mercado Livre Developers (ML_CLIENT_ID/ML_CLIENT_SECRET) e autorização do vendedor. Hoje: autorização, pedidos e notificações de pedidos; sem publicação, preço, estoque e envios.',
  };

  getCapabilities(): CapabilityMatrix {
    return {
      authorization: 'IMPLEMENTED_UNVERIFIED', orders: 'IMPLEMENTED_UNVERIFIED', webhooks: 'IMPLEMENTED_UNVERIFIED',
      catalog: 'PLANNED', publishing: 'PLANNED', price: 'PLANNED', inventory: 'PLANNED', shipments: 'PLANNED',
    };
  }

  private notConfigured(): OpResult<never> {
    return fail('NOT_CONFIGURED', 'Aplicativo do Mercado Livre não configurado no servidor: defina ML_CLIENT_ID e ML_CLIENT_SECRET (criados em Mercado Livre Developers).');
  }

  authorizeConnection(_c: ConnectionContext, p: { redirectUri: string; state: string }): Promise<OpResult<{ authorizationUrl: string }>> {
    if (!ML.clientId() || !ML.clientSecret()) return Promise.resolve(this.notConfigured());
    const q: Record<string, string> = { response_type: 'code', client_id: ML.clientId(), redirect_uri: p.redirectUri, state: p.state };
    if (ML.usePkce()) {
      q.code_challenge = createHash('sha256').update(pkceVerifier(p.state)).digest('base64url');
      q.code_challenge_method = 'S256';
    }
    return Promise.resolve(okResult({ authorizationUrl: `${ML.authBase()}/authorization?${form(q)}` }));
  }

  async completeAuthorization(_c: ConnectionContext, p: { code: string; redirectUri: string; state: string }): Promise<OpResult<Credentials>> {
    if (!ML.clientId() || !ML.clientSecret()) return this.notConfigured();
    const body: Record<string, string> = { grant_type: 'authorization_code', client_id: ML.clientId(), client_secret: ML.clientSecret(), code: p.code, redirect_uri: p.redirectUri };
    if (ML.usePkce()) body.code_verifier = pkceVerifier(p.state);
    const r = await request('POST', `${ML.apiBase()}/oauth/token`, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(body) });
    if (!r.ok) return r;
    const t = toTokenResult(r.data);
    // Sem refresh_token (escopo offline_access ausente no aplicativo) a conexão não se renova sozinha.
    if (t.ok && !t.data.credentials.refreshToken) return fail('VALIDATION', 'O Mercado Livre não devolveu refresh_token: habilite o escopo offline_access no aplicativo.');
    return t;
  }

  async validateConnection(ctx: ConnectionContext): Promise<OpResult<{ externalAccountId?: string }>> {
    const h = bearer(ctx);
    if (!h) return fail('AUTH', 'Conexão sem credenciais.');
    const r = await request('GET', `${ML.apiBase()}/users/me`, { headers: h }); // [A VALIDAR] /users/me
    if (!r.ok) return r;
    const id = r.data.id !== undefined ? String(r.data.id) : undefined;
    if (!id) return fail('VALIDATION', 'Resposta de /users/me sem id.');
    if (ctx.externalAccountId && ctx.externalAccountId !== id) return fail('AUTH', 'O token pertence a outra conta de vendedor.');
    return okResult({ externalAccountId: id });
  }

  async refreshAuthorization(ctx: ConnectionContext): Promise<OpResult<Credentials>> {
    if (!ML.clientId() || !ML.clientSecret()) return this.notConfigured();
    const rt = ctx.credentials?.refreshToken;
    if (typeof rt !== 'string') return fail('AUTH', 'Sem refresh token: reconecte a conta.');
    const r = await request('POST', `${ML.apiBase()}/oauth/token`, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'refresh_token', client_id: ML.clientId(), client_secret: ML.clientSecret(), refresh_token: rt }),
    });
    if (!r.ok) return r;
    return toTokenResult(r.data); // [CONFIRMADO] refresh token é de uso único: o novo substitui o anterior (quem chama deve gravar)
  }

  async fetchOrders(ctx: ConnectionContext, p: { since?: Date; cursor?: string }): Promise<OpResult<{ orders: ExternalOrder[]; nextCursor?: string }>> {
    const h = bearer(ctx);
    if (!h || !ctx.externalAccountId) return fail('AUTH', 'Conexão sem credenciais.');
    const offset = Number(p.cursor ?? 0) || 0;
    const q: Record<string, string> = { seller: ctx.externalAccountId, sort: 'date_asc', limit: String(ML.pageSize), offset: String(offset) }; // [A VALIDAR] sort/limit/offset
    if (p.since) q['order.date_created.from'] = p.since.toISOString(); // [A VALIDAR] nome do filtro de data
    const r = await request('GET', `${ML.apiBase()}/orders/search?${form(q)}`, { headers: h }); // [CONFIRMADO] endpoint e parâmetro seller
    if (!r.ok) return r;
    const results = Array.isArray(r.data.results) ? (r.data.results as Json[]) : [];
    const orders = results.map(normalizeOrder).filter((o): o is ExternalOrder => !!o);
    const paging = (r.data.paging ?? {}) as Json; // [A VALIDAR] paging.total
    const total = Number(paging.total ?? 0);
    const next = offset + results.length;
    return okResult({ orders, nextCursor: results.length > 0 && next < total ? String(next) : undefined });
  }

  /** Busca um pedido pelo recurso recebido em notificação (ex.: /orders/123). */
  async fetchOrderByResource(ctx: ConnectionContext, resource: string): Promise<OpResult<ExternalOrder>> {
    const h = bearer(ctx);
    if (!h) return fail('AUTH', 'Conexão sem credenciais.');
    if (!/^\/orders\/\d+$/.test(resource)) return fail('VALIDATION', 'Recurso de pedido inválido.');
    const r = await request('GET', `${ML.apiBase()}${resource}`, { headers: h });
    if (!r.ok) return r;
    const order = normalizeOrder(r.data);
    if (!order) return fail('VALIDATION', 'Pedido sem id.');
    const seller = (r.data.seller ?? {}) as Json; // [A VALIDAR] seller.id no pedido
    if (seller.id !== undefined && ctx.externalAccountId && String(seller.id) !== ctx.externalAccountId) return fail('VALIDATION', 'O pedido pertence a outra conta de vendedor.');
    return okResult(order);
  }

  /**
   * A notificação é apenas um aviso: nunca confiamos no conteúdo do corpo. Só o `resource` é usado, e o dado real
   * é buscado na API com o token do vendedor. [CONFIRMADO] campos: topic, resource, user_id, application_id.
   */
  async processNotification(ctx: ConnectionContext, p: { eventType: string | null; payload: unknown }): Promise<OpResult<{ handled: boolean; orders?: ExternalOrder[] }>> {
    const body = (p.payload ?? {}) as Json;
    const topic = String(p.eventType ?? body.topic ?? '');
    if (topic !== 'orders_v2' && topic !== 'orders') return okResult({ handled: false });
    const resource = typeof body.resource === 'string' ? body.resource : '';
    const r = await this.fetchOrderByResource(ctx, resource);
    if (!r.ok) return r;
    return okResult({ handled: true, orders: [r.data] });
  }

  webhookEventId(payload: unknown): string | null {
    const b = (payload ?? {}) as Json;
    return typeof b._id === 'string' ? b._id : null; // [A VALIDAR] campo _id no corpo; a deduplicação final é feita pelo livro de pedidos
  }
}
