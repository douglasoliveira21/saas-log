import { createHash, createHmac } from 'node:crypto';
import { getConfig } from '../config/app.config';
import {
  BaseConnector, CapabilityMatrix, ConnectionContext, ConnectorInfo, Credentials, ErrorCode, ExternalOrder, ExternalOrderItem, ExternalProduct, fail, ItemDraft, okResult, OpResult,
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
  itemsPageSize: 40, // ids por página de varredura (o multiget aceita poucos ids por chamada)
  multigetMax: 20, // [A VALIDAR] máximo de ids em /items?ids=
  /** Publicar anúncios cria anúncios REAIS e o contrato do POST /items não foi validado com conta real: desligado por padrão. */
  publishEnabled: () => process.env.ML_PUBLISH_ENABLED === 'true',
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

const ml = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * Normaliza um anúncio do Mercado Livre (GET /items). [A VALIDAR] campos: id, title, price, available_quantity, condition, status, permalink,
 * category_id, seller_custom_field, pictures[].secure_url|url, attributes[].id|name|value_name.
 * SKU: seller_custom_field ou atributo SELLER_SKU; GTIN: atributo GTIN; marca/modelo: atributos BRAND/MODEL.
 */
export function normalizeItem(o: Json): ExternalProduct | null {
  if (o.id === undefined || o.id === null || !ml(o.title)) return null;
  const attrs = (Array.isArray(o.attributes) ? (o.attributes as Json[]) : []).map((a) => ({ id: String(a.id ?? ''), name: ml(a.name) ?? String(a.id ?? ''), value: ml(a.value_name) }));
  const byId = (id: string) => attrs.find((a) => a.id === id)?.value;
  const gtin = byId('GTIN')?.split(/[,\s]+/)[0];
  const cond = String(o.condition ?? '');
  return {
    externalId: String(o.id),
    title: String(o.title).trim(),
    sku: ml(o.seller_custom_field) ?? byId('SELLER_SKU') ?? null,
    gtin: gtin && /^\d{8,14}$/.test(gtin) ? gtin : null,
    brand: byId('BRAND') ?? null,
    model: byId('MODEL') ?? null,
    price: o.price !== undefined ? Number(o.price) : undefined,
    quantity: o.available_quantity !== undefined ? Number(o.available_quantity) : undefined,
    condition: cond === 'used' ? 'USED' : 'NEW',
    status: ml(o.status),
    permalink: ml(o.permalink),
    categoryId: ml(o.category_id),
    pictures: (Array.isArray(o.pictures) ? (o.pictures as Json[]) : []).map((p) => ml(p.secure_url) ?? ml(p.url)).filter((u): u is string => !!u),
    attributes: attrs.filter((a) => a.value && !['SELLER_SKU', 'GTIN', 'BRAND', 'MODEL'].includes(a.id)).map((a) => ({ name: a.name, value: a.value! })),
    raw: { id: o.id, listing_type_id: o.listing_type_id ?? null, catalog_product_id: o.catalog_product_id ?? null },
  };
}

/** Corpo do POST /items. [A VALIDAR] contrato completo; atributos próprios do produto vão na descrição (o canal só aceita IDs do seu catálogo). */
export function buildItemBody(d: ItemDraft): Json {
  const tech = d.attributes.length ? `\n\nFicha técnica:\n${d.attributes.map((a) => `- ${a.name}: ${a.value}`).join('\n')}` : '';
  const attrs: Json[] = [];
  if (d.brand) attrs.push({ id: 'BRAND', value_name: d.brand });
  if (d.model) attrs.push({ id: 'MODEL', value_name: d.model });
  if (d.gtin) attrs.push({ id: 'GTIN', value_name: d.gtin });
  if (d.mpn) attrs.push({ id: 'MPN', value_name: d.mpn });
  attrs.push({ id: 'SELLER_SKU', value_name: d.sku });
  const body: Json = {
    title: d.title, category_id: d.categoryId, price: d.price, currency_id: 'BRL', available_quantity: d.quantity, buying_mode: 'buy_it_now',
    listing_type_id: typeof d.channelConfig?.listingTypeId === 'string' ? d.channelConfig.listingTypeId : 'gold_special',
    condition: d.condition === 'USED' ? 'used' : 'new', seller_custom_field: d.sku,
    pictures: d.pictures.map((p) => ({ source: p.url })), attributes: attrs, description: { plain_text: `${d.description}${tech}`.slice(0, 50_000) },
  };
  if (d.warrantyMonths) body.sale_terms = [{ id: 'WARRANTY_TYPE', value_name: 'Garantia do vendedor' }, { id: 'WARRANTY_TIME', value_name: `${d.warrantyMonths} meses` }];
  return body;
}

export class MercadoLivreConnector extends BaseConnector {
  readonly info: ConnectorInfo = {
    provider: 'MERCADO_LIVRE', displayName: 'Mercado Livre', authType: 'OAUTH2',
    docsUrl: 'https://developers.mercadolivre.com.br/pt_br/api-docs-pt-br',
    notes: 'Requer aplicativo no Mercado Livre Developers (ML_CLIENT_ID/ML_CLIENT_SECRET) e autorização do vendedor. Hoje: autorização, pedidos, notificações e leitura dos anúncios (importar para a base). Publicação de anúncios existe, mas fica desligada até ser validada com conta real (ML_PUBLISH_ENABLED); preço, estoque e envios ainda não.',
    imageHosts: ['mlstatic.com'],
  };

  getCapabilities(): CapabilityMatrix {
    return {
      authorization: 'IMPLEMENTED_UNVERIFIED', orders: 'IMPLEMENTED_UNVERIFIED', webhooks: 'IMPLEMENTED_UNVERIFIED',
      catalog: 'IMPLEMENTED_UNVERIFIED', publishing: ML.publishEnabled() ? 'IMPLEMENTED_UNVERIFIED' : 'PLANNED', price: 'PLANNED', inventory: 'PLANNED', shipments: 'PLANNED',
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

  /**
   * Varre os anúncios do vendedor: 1) ids por /users/{id}/items/search com search_type=scan (rolagem por scroll_id; [A VALIDAR]),
   * 2) detalhes por /items?ids=… ([A VALIDAR] formato [{code, body}]). A descrição NÃO vem aqui (chamada separada em fetchProductDetail).
   */
  async fetchProducts(ctx: ConnectionContext, p: { cursor?: string }): Promise<OpResult<{ products: ExternalProduct[]; nextCursor?: string }>> {
    const h = bearer(ctx);
    if (!h || !ctx.externalAccountId) return fail('AUTH', 'Conexão sem credenciais.');
    const q: Record<string, string> = { search_type: 'scan', limit: String(ML.itemsPageSize) };
    if (p.cursor) q.scroll_id = p.cursor;
    const ids = await request('GET', `${ML.apiBase()}/users/${encodeURIComponent(ctx.externalAccountId)}/items/search?${form(q)}`, { headers: h });
    if (!ids.ok) return ids;
    const list = (Array.isArray(ids.data.results) ? ids.data.results : []).map(String).filter((x) => /^[A-Za-z0-9]+$/.test(x));
    const scroll = ml(ids.data.scroll_id);
    const products: ExternalProduct[] = [];
    for (let i = 0; i < list.length; i += ML.multigetMax) {
      const r = await request('GET', `${ML.apiBase()}/items?ids=${list.slice(i, i + ML.multigetMax).join(',')}`, { headers: h });
      if (!r.ok) return r;
      const arr = (Array.isArray(r.data) ? (r.data as unknown as Json[]) : []);
      for (const entry of arr) {
        if (Number(entry.code) !== 200) continue; // anúncio indisponível: segue
        const item = normalizeItem((entry.body ?? {}) as Json);
        if (item) products.push(item);
      }
    }
    return okResult({ products, nextCursor: list.length > 0 && scroll ? scroll : undefined });
  }

  async fetchProductDetail(ctx: ConnectionContext, p: { externalId: string }): Promise<OpResult<ExternalProduct>> {
    const h = bearer(ctx);
    if (!h) return fail('AUTH', 'Conexão sem credenciais.');
    if (!/^[A-Za-z0-9]+$/.test(p.externalId)) return fail('VALIDATION', 'Identificador de anúncio inválido.');
    const r = await request('GET', `${ML.apiBase()}/items/${p.externalId}`, { headers: h });
    if (!r.ok) return r;
    const item = normalizeItem(r.data);
    if (!item) return fail('VALIDATION', 'Resposta de anúncio sem id/título.');
    const d = await request('GET', `${ML.apiBase()}/items/${p.externalId}/description`, { headers: h }); // [A VALIDAR] plain_text
    if (d.ok) item.description = ml(d.data.plain_text) ?? ml(d.data.text);
    return okResult(item);
  }

  /** Regras conhecidas do canal checadas antes de publicar. [A VALIDAR] limites; a resposta do canal sempre prevalece. */
  validateDraft(d: ItemDraft): string[] {
    const out: string[] = [];
    if (d.title.length > 60) out.push(`Mercado Livre: título com ${d.title.length} caracteres (máximo 60).`);
    const main = d.pictures[0];
    if (main && (main.width < 500 || main.height < 500)) out.push('Mercado Livre: a foto principal precisa ter ao menos 500 × 500 px.');
    if (!ML.publishEnabled()) out.push('Publicação desligada no servidor (ML_PUBLISH_ENABLED): ainda não foi validada com uma conta real.');
    return out;
  }

  async publishProduct(ctx: ConnectionContext, p: { productId: string; payload: unknown; idempotencyKey: string }): Promise<OpResult<{ externalId: string; permalink?: string }>> {
    if (!ML.publishEnabled()) return fail('NOT_CONFIGURED', 'Publicação no Mercado Livre desligada neste servidor (ML_PUBLISH_ENABLED). Ela cria anúncios reais e ainda não foi validada com uma conta real.');
    const h = bearer(ctx);
    if (!h) return fail('AUTH', 'Conexão sem credenciais.');
    const draft = p.payload as ItemDraft;
    const problems = this.validateDraft(draft).filter((x) => !x.includes('ML_PUBLISH_ENABLED'));
    if (!draft.categoryId) problems.push('Falta a categoria do canal.');
    if (problems.length) return fail('VALIDATION', problems.join(' '));
    const r = await request('POST', `${ML.apiBase()}/items`, { headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify(buildItemBody(draft)) }); // [A VALIDAR] POST /items
    if (!r.ok) return r;
    const id = ml(r.data.id);
    if (!id) return fail('VALIDATION', 'O Mercado Livre respondeu sem o id do anúncio criado: confira no canal antes de repetir.');
    return okResult({ externalId: id, permalink: ml(r.data.permalink) });
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
