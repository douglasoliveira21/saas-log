import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  BaseConnector, CapabilityMatrix, ConnectionContext, ConnectorInfo, Credentials, ErrorCode, ExternalOrder, ExternalOrderItem, ExternalProduct, fail, ItemDraft, okResult, OpResult,
} from './connector';

/**
 * Conector TikTok Shop (Partner Center / Open API v2, versão 202309) — autorização OAuth por loja, validação, renovação do token, pedidos,
 * catálogo, publicação, preço, estoque, desativação de anúncio, rastreio e notificações (webhook assinado).
 *
 * ORIGEM DAS REGRAS (ver docs/MARKETPLACE-INTEGRATIONS.md → TikTok Shop):
 *  [SDK COMUNITÁRIO]  lidos em 23/11/2026 o código do SDK EcomPHP/tiktokshop-php (assinatura das requisições, endereços de autorização/token,
 *                     caminhos e versão 202309, cabeçalho x-tts-access-token, regras de shop_cipher) e a referência de webhooks da Hookdeck
 *                     (cabeçalho Authorization = HMAC-SHA256 hex de app_key + corpo, tipos numéricos de evento, tentativas de reenvio).
 *  [MEMÓRIA]          nomes dos campos das RESPOSTAS e dos corpos de preço/estoque/criação de produto: nenhuma das fontes lidas os traz.
 *                     A leitura é TOLERANTE e nunca inventa dados. Tudo marcado [A VALIDAR] precisa de uma loja real autorizada.
 * A documentação oficial (partner.tiktokshop.com) é uma aplicação de página única e não pôde ser lida por busca automática.
 * Endereços só podem ser trocados por variável de ambiente com NODE_ENV=test (servidor simulado).
 */
export const TIKTOK = {
  appKey: () => process.env.TIKTOK_APP_KEY ?? '',
  appSecret: () => process.env.TIKTOK_APP_SECRET ?? '',
  /** Opcional: ID do serviço, quando a autorização é pelo endereço "services.tiktokshop.com/open/authorize" mostrado no Partner Center. */
  serviceId: () => process.env.TIKTOK_SERVICE_ID ?? '',
  apiBase: () => (process.env.NODE_ENV === 'test' && process.env.TIKTOK_API_BASE) || 'https://open-api.tiktokglobalshop.com',
  authBase: () => (process.env.NODE_ENV === 'test' && process.env.TIKTOK_AUTH_BASE) || 'https://auth.tiktok-shops.com',
  version: '202309',
  pageSize: 50,
  windowDays: 7,
  timeoutMs: 20_000,
  /** Tipos numéricos de notificação (a TikTok não publica o mapa completo; estes vêm do SDK e da Hookdeck). */
  events: { orderStatus: 1, deauthorized: 6, expiring: 7 },
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : []);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined);
const num = (v: unknown) => { const n = Number(typeof v === 'string' ? v.replace(',', '.') : v); return Number.isFinite(n) ? n : undefined; };
const digits = (v: unknown) => (/^[1-9]\d{0,24}$/.test(String(v ?? '')) ? String(v) : undefined);
const nowSec = () => Math.floor(Date.now() / 1000);
const iso = (sec: unknown) => (Number(sec) > 0 ? new Date(Number(sec) * 1000).toISOString() : undefined);

// ───────────── assinatura ─────────────

/**
 * Assinatura das requisições (não vale para os endereços de autorização). [SDK] 1) parâmetros da URL sem `sign`, `access_token` e
 * `x-tts-access-token`, em ordem alfabética; 2) concatena chave+valor; 3) põe o CAMINHO da URL na frente; 4) se não for GET nem multipart, soma o
 * corpo; 5) envolve tudo com o segredo; 6) HMAC-SHA256 em hexadecimal, com o segredo como chave.
 */
export function tiktokSign(path: string, params: Record<string, string>, body: string, secret: string, multipart = false): string {
  const keys = Object.keys(params).filter((k) => !['sign', 'access_token', 'x-tts-access-token'].includes(k)).sort();
  let s = path + keys.map((k) => `${k}${params[k]}`).join('');
  if (body && !multipart) s += body;
  return createHmac('sha256', secret).update(secret + s + secret).digest('hex');
}

/** Assinatura das notificações recebidas: HMAC-SHA256 hexadecimal de `app_key + corpo cru`, com o segredo do aplicativo (vem no cabeçalho Authorization). */
export function tiktokWebhookSignature(appKey: string, rawBody: Buffer | string, secret: string): string {
  return createHmac('sha256', secret).update(appKey + (typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'))).digest('hex');
}

// ───────────── erros ─────────────

function failure(status: number, body: Json | null): OpResult<never> {
  const message = String(body?.message ?? `HTTP ${status}`).slice(0, 200);
  const code = Number(body?.code);
  let kind: ErrorCode = 'VALIDATION';
  if (status === 429 || /rate.?limit|too many|frequen|throttl/i.test(message)) kind = 'RATE_LIMIT';
  else if (status >= 500) kind = 'UNAVAILABLE';
  else if ([401, 403].includes(status) || /access.?token|expired|unauthori[sz]ed|permission|scope|credential|sign(ature)?\b|authori[sz]ation/i.test(message)) kind = 'AUTH';
  const text = kind === 'RATE_LIMIT' ? 'Limite de requisições do TikTok Shop atingido. O sistema tentará novamente.'
    : kind === 'UNAVAILABLE' ? 'TikTok Shop temporariamente indisponível.'
      : kind === 'AUTH' ? `O TikTok Shop recusou a autorização (${message}). Confira as permissões do aplicativo ou reconecte a loja.`
        : `O TikTok Shop recusou a solicitação${Number.isFinite(code) && code ? ` (código ${code})` : ''}: ${message}`;
  return fail(kind, text, kind === 'RATE_LIMIT' ? 60_000 : undefined);
}

function configured(): OpResult<never> | null {
  return TIKTOK.appKey() && TIKTOK.appSecret() ? null : fail('NOT_CONFIGURED', 'Configure TIKTOK_APP_KEY e TIKTOK_APP_SECRET no servidor para conectar o TikTok Shop (Partner Center → seu aplicativo).');
}

// ───────────── normalização ─────────────

const PAID = ['AWAITING_SHIPMENT', 'PARTIALLY_SHIPPING', 'AWAITING_COLLECTION', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED'];

/** Pedido do TikTok → importador. UNPAID e ON_HOLD (em análise) ficam aguardando; nunca viram venda. [A VALIDAR] nomes dos campos. */
export function normalizeTikTokOrder(o: Json): ExternalOrder | null {
  const id = str(o.id);
  if (!id) return null;
  const status = String(o.status ?? '').toUpperCase();
  // cada unidade vem como uma linha própria: agrupa por produto+SKU
  const groups = new Map<string, ExternalOrderItem>();
  for (const li of list(o.line_items)) {
    const key = `${str(li.product_id) ?? ''}:${str(li.sku_id) ?? ''}`;
    const qty = Number(li.quantity) > 0 ? Number(li.quantity) : 1;
    const g = groups.get(key);
    if (g) g.quantity += qty;
    else groups.set(key, { externalItemId: key, sku: str(li.seller_sku) ?? null, title: [str(li.product_name), str(li.sku_name)].filter(Boolean).join(' — ') || undefined, quantity: qty, unitPrice: num(li.sale_price) ?? 0 });
  }
  const pay = obj(o.payment);
  const recipient = obj(o.recipient_address);
  return {
    externalId: id,
    status: status === 'CANCELLED' ? 'cancelled' : PAID.includes(status) ? 'paid' : (status || 'unpaid').toLowerCase(),
    createdAt: iso(o.create_time),
    total: num(pay.total_amount),
    buyer: { id: str(o.user_id) ?? id, name: str(recipient.name), nickname: str(recipient.name) },
    items: [...groups.values()],
    raw: { id, channelStatus: status, currency: pay.currency ?? null, updateTime: o.update_time ?? null },
  };
}

const refOf = (productId: unknown, skuId: unknown) => `${String(productId)}:${String(skuId)}`;

/** Anúncio do TikTok (um por SKU, como a Shopee) → catálogo do sistema. [A VALIDAR] nomes dos campos. */
export function normalizeTikTokProduct(p: Json, sku: Json): ExternalProduct {
  const price = obj(sku.price);
  const names = list(sku.sales_attributes).map((a) => str(a.value_name)).filter((x): x is string => !!x);
  const inventory = list(sku.inventory);
  const images = list(p.main_images).map((i) => (Array.isArray(i.urls) ? str(i.urls[0]) : undefined) ?? str(i.url)).filter((u): u is string => !!u);
  const code = str(obj(sku.identifier_code).code) ?? str(obj(p.identifier_code).code);
  const chain = list(p.category_chains);
  return {
    externalId: refOf(p.id, sku.id),
    title: [String(p.title ?? ''), ...names].filter(Boolean).join(' — '),
    sku: str(sku.seller_sku) ?? null,
    description: str(p.description),
    gtin: code && /^\d{8,14}$/.test(code) ? code : null,
    brand: str(obj(p.brand).name) ?? null,
    price: num(price.sale_price) ?? num(price.tax_exclusive_price) ?? num(price.amount),
    quantity: inventory.length ? inventory.reduce((a, i) => a + (num(i.quantity) ?? 0), 0) : undefined,
    condition: 'NEW',
    status: str(p.status),
    categoryId: chain.length ? str(chain[chain.length - 1].id) : str(p.category_id),
    pictures: images,
    raw: { product_id: p.id, sku_id: sku.id },
  };
}

interface Cursor { from: number; to: number; token: string }

export class TikTokConnector extends BaseConnector {
  readonly info: ConnectorInfo = {
    provider: 'TIKTOK_SHOP', displayName: 'TikTok Shop', category: 'MARKETPLACE', region: 'BR', authType: 'SIGNED_OAUTH2',
    docsUrl: 'https://partner.tiktokshop.com/docv2',
    imageHosts: ['tiktokcdn.com', 'tiktokcdn-us.com', 'ibyteimg.com', 'tiktokv.com'],
    notes: 'Requer um aplicativo aprovado no TikTok Shop Partner Center (App Key e App Secret no servidor). Autorize uma loja do Brasil por conexão. Pedidos, catálogo, publicação, preço, estoque, desativação, rastreio e notificações implementados conforme o SDK da comunidade e testados só com respostas simuladas.',
  };

  getCapabilities(): CapabilityMatrix {
    return {
      authorization: 'IMPLEMENTED_UNVERIFIED', orders: 'IMPLEMENTED_UNVERIFIED', catalog: 'IMPLEMENTED_UNVERIFIED', publishing: 'IMPLEMENTED_UNVERIFIED',
      price: 'IMPLEMENTED_UNVERIFIED', inventory: 'IMPLEMENTED_UNVERIFIED', shipments: 'IMPLEMENTED_UNVERIFIED', webhooks: 'IMPLEMENTED_UNVERIFIED',
    };
  }

  // ───────────── chamadas ─────────────

  /** Autorização e renovação do token: GET sem assinatura no domínio de autorização. */
  private async authCall(path: string, params: Record<string, string>): Promise<OpResult<Json>> {
    const missing = configured();
    if (missing) return missing;
    const url = new URL(path, TIKTOK.authBase());
    for (const [k, v] of Object.entries({ app_key: TIKTOK.appKey(), app_secret: TIKTOK.appSecret(), ...params })) url.searchParams.set(k, v);
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIKTOK.timeoutMs) });
      const body = obj(await res.json().catch(() => null));
      if (!res.ok || Number(body.code) !== 0) return failure(res.status, body);
      return okResult(obj(body.data));
    } catch { return fail('UNAVAILABLE', 'Não foi possível obter a resposta do TikTok Shop. Tente novamente.'); }
  }

  /** Chamada da Open API: parâmetros assinados, access token no cabeçalho e shop_cipher da loja (exceto nos caminhos de autorização). */
  private async call(ctx: ConnectionContext | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', category: string, action: string, opts: { query?: Record<string, string>; body?: unknown; form?: FormData; token?: string; cipher?: string } = {}): Promise<OpResult<Json>> {
    const missing = configured();
    if (missing) return missing;
    const token = opts.token ?? str(ctx?.credentials?.accessToken);
    const cipher = opts.cipher ?? str(ctx?.credentials?.shopCipher);
    if (!token) return fail('AUTH', 'Autorize a loja do TikTok Shop antes de continuar.');
    const path = `/${category}/${TIKTOK.version}/${action}`;
    const params: Record<string, string> = { ...(opts.query ?? {}), app_key: TIKTOK.appKey(), timestamp: String(nowSec()) };
    if (category !== 'authorization' && category !== 'seller') {
      if (!cipher) return fail('AUTH', 'Loja do TikTok Shop sem identificação (shop_cipher). Reconecte a loja.');
      params.shop_cipher = cipher;
    }
    const raw = opts.body === undefined ? '' : JSON.stringify(opts.body);
    params.sign = tiktokSign(path, params, raw, TIKTOK.appSecret(), !!opts.form);
    const url = new URL(path, TIKTOK.apiBase());
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    try {
      const res = await fetch(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(TIKTOK.timeoutMs),
        headers: { accept: 'application/json', 'x-tts-access-token': token, ...(opts.form ? {} : { 'content-type': 'application/json' }) },
        body: opts.form ?? (raw || undefined),
      });
      const body = obj(await res.json().catch(() => null));
      if (!res.ok || Number(body.code) !== 0) return failure(res.status, Object.keys(body).length ? body : null);
      return okResult(obj(body.data));
    } catch { return fail('UNAVAILABLE', 'Não foi possível obter a resposta do TikTok Shop. Tente novamente.'); }
  }

  // ───────────── autorização ─────────────

  authorizeConnection(_ctx: ConnectionContext, p: { redirectUri: string; state: string }): Promise<OpResult<{ authorizationUrl: string }>> {
    const missing = configured();
    if (missing) return Promise.resolve(missing);
    // O endereço de retorno é o cadastrado no aplicativo (Partner Center), não vai na URL. [SDK] /oauth/authorize?app_key&state
    const service = TIKTOK.serviceId();
    const url = service
      ? new URL(`https://services.tiktokshop.com/open/authorize?${new URLSearchParams({ service_id: service, state: p.state })}`)
      : new URL(`/oauth/authorize?${new URLSearchParams({ app_key: TIKTOK.appKey(), state: p.state })}`, TIKTOK.authBase());
    return Promise.resolve(okResult({ authorizationUrl: url.toString() }));
  }

  private tokens(data: Json, prior?: Json): OpResult<{ accessToken: string; refreshToken: string; expiresAt?: Date }> {
    const accessToken = str(data.access_token); const refreshToken = str(data.refresh_token) ?? str(prior?.refreshToken);
    if (!accessToken || !refreshToken) return fail('UNAVAILABLE', 'O TikTok Shop retornou credenciais incompletas.');
    // [A VALIDAR] access_token_expire_in: data/hora em segundos (época) segundo as integrações conhecidas; aceita também "segundos a partir de agora".
    const exp = Number(data.access_token_expire_in);
    const at = Number.isFinite(exp) && exp > 0 ? (exp > 1e9 ? exp * 1000 : Date.now() + exp * 1000) : undefined;
    return okResult({ accessToken, refreshToken, expiresAt: at ? new Date(at) : undefined });
  }

  async completeAuthorization(_ctx: ConnectionContext, p: { code: string }): Promise<OpResult<Credentials>> {
    const t = await this.authCall('/api/v2/token/get', { auth_code: p.code, grant_type: 'authorized_code' });
    if (!t.ok) return t;
    const tok = this.tokens(t.data);
    if (!tok.ok) return tok;
    const shops = await this.call(null, 'GET', 'authorization', 'shops', { token: tok.data.accessToken });
    if (!shops.ok) return shops;
    const br = list(shops.data.shops).filter((s) => String(s.region ?? 'BR').toUpperCase() === 'BR');
    if (!br.length) return fail('VALIDATION', 'Nenhuma loja do Brasil foi autorizada. Autorize uma loja TikTok Shop do Brasil.');
    if (br.length > 1) return fail('VALIDATION', 'Mais de uma loja foi autorizada. Autorize uma única loja por conexão.');
    const shop = br[0];
    const shopId = str(shop.id); const cipher = str(shop.cipher);
    if (!shopId || !cipher) return fail('UNAVAILABLE', 'O TikTok Shop não informou o identificador da loja.');
    return okResult({
      credentials: { accessToken: tok.data.accessToken, refreshToken: tok.data.refreshToken, shopId, shopCipher: cipher, shopName: str(shop.name) ?? null, sellerName: str(t.data.seller_name) ?? null },
      expiresAt: tok.data.expiresAt, externalAccountId: shopId,
    });
  }

  async refreshAuthorization(ctx: ConnectionContext): Promise<OpResult<Credentials>> {
    const c = ctx.credentials ?? {};
    const refresh = str(c.refreshToken);
    if (!refresh) return fail('AUTH', 'Reconecte a loja do TikTok Shop para renovar a autorização.');
    const r = await this.authCall('/api/v2/token/refresh', { refresh_token: refresh, grant_type: 'refresh_token' });
    if (!r.ok) return r;
    const tok = this.tokens(r.data, c);
    if (!tok.ok) return tok;
    return okResult({ credentials: { ...c, accessToken: tok.data.accessToken, refreshToken: tok.data.refreshToken }, expiresAt: tok.data.expiresAt });
  }

  revokeAuthorization(): Promise<OpResult<null>> {
    return Promise.resolve(okResult(null)); // a revogação é feita no Seller Center; aqui as credenciais são descartadas
  }

  async validateConnection(ctx: ConnectionContext): Promise<OpResult<{ externalAccountId?: string }>> {
    const r = await this.call(ctx, 'GET', 'authorization', 'shops');
    if (!r.ok) return r;
    const mine = list(r.data.shops).find((s) => str(s.id) === ctx.externalAccountId);
    if (!mine) return fail('AUTH', 'A loja desta conexão não está mais autorizada no TikTok Shop. Reconecte.');
    if (String(mine.region ?? 'BR').toUpperCase() !== 'BR') return fail('VALIDATION', 'Esta integração atende lojas TikTok Shop do Brasil.');
    return okResult({ externalAccountId: ctx.externalAccountId! });
  }

  // ───────────── pedidos ─────────────

  private async orderDetails(ctx: ConnectionContext, ids: string[]): Promise<OpResult<Json[]>> {
    const out: Json[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const r = await this.call(ctx, 'GET', 'order', 'orders', { query: { ids: ids.slice(i, i + 50).join(',') } });
      if (!r.ok) return r;
      out.push(...list(r.data.orders));
    }
    return okResult(out);
  }

  private convert(rows: Json[]): OpResult<ExternalOrder[]> {
    const orders: ExternalOrder[] = [];
    for (const row of rows) {
      const cur = str(obj(row.payment).currency);
      if (cur && cur !== 'BRL') return fail('VALIDATION', 'Pedido do TikTok Shop com moeda diferente de BRL.');
      const n = normalizeTikTokOrder(row);
      if (!n) return fail('UNAVAILABLE', 'O TikTok Shop retornou um pedido sem identificador.');
      orders.push(n);
    }
    return okResult(orders);
  }

  async fetchOrders(ctx: ConnectionContext, p: { since?: Date; cursor?: string }): Promise<OpResult<{ orders: ExternalOrder[]; nextCursor?: string }>> {
    const now = nowSec();
    let cur: Cursor;
    try {
      const from = Math.floor((p.since ?? new Date(Date.now() - TIKTOK.windowDays * 86_400_000)).getTime() / 1000);
      cur = p.cursor ? JSON.parse(p.cursor) : { from, to: now, token: '' };
      if (!Number.isSafeInteger(cur.from) || !Number.isSafeInteger(cur.to) || cur.from < 0 || cur.from > cur.to || typeof cur.token !== 'string') throw new Error();
    } catch { return fail('VALIDATION', 'Cursor ou período de pedidos do TikTok Shop inválido.'); }
    const query: Record<string, string> = { page_size: String(TIKTOK.pageSize), sort_field: 'update_time', sort_order: 'ASC' };
    if (cur.token) query.page_token = cur.token;
    const r = await this.call(ctx, 'POST', 'order', 'orders/search', { query, body: { update_time_ge: cur.from, update_time_lt: cur.to } });
    if (!r.ok) return r;
    if (r.data.orders !== undefined && !Array.isArray(r.data.orders)) return fail('UNAVAILABLE', 'Resposta de pedidos do TikTok Shop incompleta.');
    let rows = list(r.data.orders);
    // se a busca vier sem as linhas dos pedidos, relê pelo detalhe
    const bare = rows.filter((o) => !Array.isArray(o.line_items)).map((o) => str(o.id)).filter((x): x is string => !!x);
    if (bare.length) {
      const d = await this.orderDetails(ctx, bare);
      if (!d.ok) return d;
      const byId = new Map(d.data.map((o) => [str(o.id), o]));
      rows = rows.map((o) => (Array.isArray(o.line_items) ? o : byId.get(str(o.id)) ?? o));
    }
    const orders = this.convert(rows);
    if (!orders.ok) return orders;
    const next = str(r.data.next_page_token);
    if (next && next === cur.token) return fail('UNAVAILABLE', 'O TikTok Shop retornou paginação de pedidos inconsistente.');
    return okResult({ orders: orders.data, nextCursor: next ? JSON.stringify({ ...cur, token: next }) : undefined });
  }

  // ───────────── catálogo ─────────────

  private ref(externalId: string): OpResult<{ productId: string; skuId?: string }> {
    const m = /^([1-9]\d*)(?::([1-9]\d*))?$/.exec(externalId);
    return m ? okResult({ productId: m[1], skuId: m[2] }) : fail('VALIDATION', 'Identificador do TikTok Shop inválido. Use product_id ou product_id:sku_id.');
  }

  async fetchProducts(ctx: ConnectionContext, p: { cursor?: string }): Promise<OpResult<{ products: ExternalProduct[]; nextCursor?: string }>> {
    const query: Record<string, string> = { page_size: String(TIKTOK.pageSize) };
    if (p.cursor) query.page_token = p.cursor;
    const r = await this.call(ctx, 'POST', 'product', 'products/search', { query, body: { status: 'ALL' } });
    if (!r.ok) return r;
    if (r.data.products !== undefined && !Array.isArray(r.data.products)) return fail('UNAVAILABLE', 'Resposta de catálogo do TikTok Shop incompleta.');
    const products: ExternalProduct[] = [];
    for (const pr of list(r.data.products)) {
      if (!digits(pr.id)) return fail('UNAVAILABLE', 'O TikTok Shop retornou um produto sem identificador.');
      for (const sku of list(pr.skus)) {
        if (!digits(sku.id)) continue;
        const cur = str(obj(sku.price).currency);
        if (cur && cur !== 'BRL') return fail('VALIDATION', 'Produto do TikTok Shop com moeda diferente de BRL.');
        const n = normalizeTikTokProduct(pr, sku);
        products.push({ ...n, description: undefined, pictures: [] }); // descrição e fotos só na leitura completa
      }
    }
    const next = str(r.data.next_page_token);
    if (next && next === p.cursor) return fail('UNAVAILABLE', 'O TikTok Shop retornou paginação de catálogo inconsistente.');
    return okResult({ products, nextCursor: next || undefined });
  }

  private async detail(ctx: ConnectionContext, productId: string): Promise<OpResult<Json>> {
    return this.call(ctx, 'GET', 'product', `products/${productId}`);
  }

  async fetchProductDetail(ctx: ConnectionContext, p: { externalId: string }): Promise<OpResult<ExternalProduct>> {
    const ref = this.ref(p.externalId);
    if (!ref.ok) return ref;
    const d = await this.detail(ctx, ref.data.productId);
    if (!d.ok) return d;
    const skus = list(d.data.skus);
    const sku = ref.data.skuId ? skus.find((s) => str(s.id) === ref.data.skuId) : skus.length === 1 ? skus[0] : undefined;
    if (!sku) return fail('VALIDATION', 'Produto ou variação não encontrado na loja TikTok Shop.');
    return okResult(normalizeTikTokProduct({ ...d.data, id: d.data.id ?? ref.data.productId }, sku));
  }

  /** Regras que dá para checar antes de publicar (o canal exige estes dados; categorias podem exigir atributos próprios). [A VALIDAR] */
  validateDraft(draft: ItemDraft): string[] {
    const issues: string[] = [];
    if (!draft.title.trim()) issues.push('TikTok Shop: título obrigatório.');
    if (!draft.description.trim()) issues.push('TikTok Shop: descrição obrigatória.');
    if (!draft.categoryId) issues.push('TikTok Shop: informe a categoria do canal (mapeie a categoria do produto).');
    if (!draft.pictures.length) issues.push('TikTok Shop: ao menos uma foto é obrigatória.');
    if (!(draft.price > 0)) issues.push('TikTok Shop: preço deve ser maior que zero.');
    if (!(draft.weightG && draft.weightG > 0)) issues.push('TikTok Shop: peso da embalagem obrigatório (cadastre o peso do produto).');
    return issues;
  }

  private async warehouse(ctx: ConnectionContext): Promise<OpResult<string>> {
    const r = await this.call(ctx, 'GET', 'logistics', 'warehouses');
    if (!r.ok) return r;
    const all = list(r.data.warehouses);
    const pick = all.find((w) => w.is_default === true && String(w.effect_status ?? 'ENABLED') === 'ENABLED') ?? all.find((w) => String(w.type ?? 'SALES_WAREHOUSE') === 'SALES_WAREHOUSE' && String(w.effect_status ?? 'ENABLED') === 'ENABLED') ?? all[0];
    const id = str(pick?.id);
    return id ? okResult(id) : fail('VALIDATION', 'Nenhum depósito de vendas encontrado na loja TikTok Shop. Cadastre um no Seller Center.');
  }

  private async upload(ctx: ConnectionContext, pic: { url: string }): Promise<OpResult<string>> {
    let data: Blob;
    try {
      const res = await fetch(pic.url, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
      if (!res.ok) return fail('VALIDATION', 'Não foi possível ler uma das fotos do produto.');
      data = await res.blob();
      if (data.size > 10_000_000) return fail('VALIDATION', 'Foto do produto acima de 10 MB.');
    } catch { return fail('UNAVAILABLE', 'Não foi possível baixar uma das fotos do produto.'); }
    const form = new FormData();
    form.set('data', data, 'foto.jpg');
    const r = await this.call(ctx, 'POST', 'product', 'images/upload', { query: { use_case: 'MAIN_IMAGE' }, form });
    if (!r.ok) return r;
    const uri = str(r.data.uri);
    return uri ? okResult(uri) : fail('UNAVAILABLE', 'O TikTok Shop não confirmou o envio da foto.');
  }

  async publishProduct(ctx: ConnectionContext, p: { productId: string; payload: unknown; idempotencyKey: string }): Promise<OpResult<{ externalId: string; permalink?: string }>> {
    const d = p.payload as ItemDraft;
    const issues = this.validateDraft(d);
    if (issues.length) return fail('VALIDATION', issues.join(' '));
    // idempotência: o canal não aceita chave; se já existe SKU vendedor igual, devolve o existente (nunca cria em duplicidade)
    const found = await this.call(ctx, 'POST', 'product', 'products/search', { query: { page_size: '10' }, body: { status: 'ALL', seller_skus: [d.sku] } });
    if (!found.ok) return found;
    for (const pr of list(found.data.products)) {
      const sku = list(pr.skus).find((s) => str(s.seller_sku) === d.sku);
      if (sku && digits(pr.id) && digits(sku.id)) return okResult({ externalId: refOf(pr.id, sku.id) });
    }
    const wh = await this.warehouse(ctx);
    if (!wh.ok) return wh;
    const uris: string[] = [];
    for (const pic of d.pictures.slice(0, 9)) {
      const up = await this.upload(ctx, pic);
      if (!up.ok) return up;
      uris.push(up.data);
    }
    const kg = (d.weightG ?? 0) / 1000;
    const dims = d.lengthMm && d.widthMm && d.heightMm ? { package_dimensions: { length: String(Math.ceil(d.lengthMm / 10)), width: String(Math.ceil(d.widthMm / 10)), height: String(Math.ceil(d.heightMm / 10)), unit: 'CENTIMETER' } } : {};
    const cfg = obj(d.channelConfig);
    const body = {
      save_mode: 'LISTING', title: d.title, description: d.description, category_id: d.categoryId,
      ...(str(cfg.brandId) ? { brand_id: str(cfg.brandId) } : {}),
      main_images: uris.map((uri) => ({ uri })),
      skus: [{
        seller_sku: d.sku, price: { amount: d.price.toFixed(2), currency: 'BRL' }, inventory: [{ warehouse_id: wh.data, quantity: Math.max(0, Math.floor(d.quantity)) }],
        ...(d.gtin && /^\d{8,14}$/.test(d.gtin) ? { identifier_code: { code: d.gtin, type: 'GTIN' } } : {}),
      }],
      package_weight: { value: kg.toFixed(3), unit: 'KILOGRAM' }, ...dims,
      ...(Array.isArray(cfg.productAttributes) ? { product_attributes: cfg.productAttributes } : {}),
    };
    const r = await this.call(ctx, 'POST', 'product', 'products', { body });
    if (!r.ok) return r;
    const pid = digits(r.data.product_id);
    const sku = list(r.data.skus)[0];
    if (!pid || !digits(sku?.id)) return fail('UNAVAILABLE', 'O TikTok Shop não confirmou a criação do produto.');
    return okResult({ externalId: refOf(pid, sku.id) });
  }

  async updateProduct(ctx: ConnectionContext, p: { externalId: string; payload: unknown }): Promise<OpResult<null>> {
    const ref = this.ref(p.externalId);
    if (!ref.ok) return ref;
    const pl = obj(p.payload);
    const body: Json = {};
    if (str(pl.title)) body.title = str(pl.title);
    if (str(pl.description)) body.description = str(pl.description);
    if (!Object.keys(body).length) return fail('VALIDATION', 'Nada para atualizar: informe título e/ou descrição.');
    const r = await this.call(ctx, 'POST', 'product', `products/${ref.data.productId}/partial_edit`, { body });
    return r.ok ? okResult(null) : r;
  }

  /** Resolve o SKU a atualizar (e, para estoque, o depósito dele) lendo o produto. */
  private async target(ctx: ConnectionContext, externalId: string): Promise<OpResult<{ productId: string; skuId: string; warehouseId?: string }>> {
    const ref = this.ref(externalId);
    if (!ref.ok) return ref;
    const d = await this.detail(ctx, ref.data.productId);
    if (!d.ok) return d;
    const skus = list(d.data.skus);
    const sku = ref.data.skuId ? skus.find((s) => str(s.id) === ref.data.skuId) : skus.length === 1 ? skus[0] : undefined;
    const skuId = str(sku?.id);
    if (!sku || !skuId) return fail('VALIDATION', 'Produto ou variação não encontrado na loja TikTok Shop.');
    return okResult({ productId: ref.data.productId, skuId, warehouseId: str(list(sku.inventory)[0]?.warehouse_id) });
  }

  async updatePrice(ctx: ConnectionContext, p: { externalId: string; price: number }): Promise<OpResult<null>> {
    if (!Number.isFinite(p.price) || p.price <= 0) return fail('VALIDATION', 'Preço do TikTok Shop inválido.');
    const t = await this.target(ctx, p.externalId);
    if (!t.ok) return t;
    const r = await this.call(ctx, 'POST', 'product', `products/${t.data.productId}/prices/update`, { body: { skus: [{ id: t.data.skuId, price: { amount: p.price.toFixed(2), currency: 'BRL' } }] } });
    return r.ok ? okResult(null) : r;
  }

  async updateInventory(ctx: ConnectionContext, p: { externalId: string; quantity: number }): Promise<OpResult<null>> {
    if (!Number.isSafeInteger(p.quantity) || p.quantity < 0) return fail('VALIDATION', 'Estoque do TikTok Shop inválido.');
    const t = await this.target(ctx, p.externalId);
    if (!t.ok) return t;
    let warehouse = t.data.warehouseId;
    if (!warehouse) { const w = await this.warehouse(ctx); if (!w.ok) return w; warehouse = w.data; }
    const r = await this.call(ctx, 'POST', 'product', `products/${t.data.productId}/inventory/update`, { body: { skus: [{ id: t.data.skuId, inventory: [{ warehouse_id: warehouse, quantity: p.quantity }] }] } });
    return r.ok ? okResult(null) : r;
  }

  async cancelListing(ctx: ConnectionContext, p: { externalId: string }): Promise<OpResult<null>> {
    const ref = this.ref(p.externalId);
    if (!ref.ok) return ref;
    const r = await this.call(ctx, 'POST', 'product', 'products/deactivate', { body: { product_ids: [ref.data.productId] } });
    if (!r.ok) return r;
    if (list(r.data.errors).length) return fail('VALIDATION', 'O TikTok Shop não conseguiu desativar o anúncio.');
    return okResult(null);
  }

  // ───────────── envio ─────────────

  /** Leitura do rastreio do pedido (a confirmação de envio é feita no Seller Center ou pela etiqueta do canal). */
  async getShipment(ctx: ConnectionContext, p: { externalOrderId: string }): Promise<OpResult<unknown>> {
    const id = digits(p.externalOrderId);
    if (!id) return fail('VALIDATION', 'Identificador de pedido do TikTok Shop inválido.');
    const r = await this.call(ctx, 'GET', 'fulfillment', `orders/${id}/tracking`);
    if (!r.ok) return r;
    return okResult({ orderId: id, tracking: list(r.data.tracking).map((t) => ({ at: iso(Number(t.update_time_millis) / 1000), description: str(t.description) })) });
  }

  // ───────────── notificações ─────────────

  /** O cabeçalho Authorization traz o HMAC (sem "Bearer"). A chave é o segredo do APLICATIVO, não o segredo da conexão. */
  verifyWebhook(p: { rawBody: Buffer; headers: Record<string, string | string[] | undefined> }): boolean {
    if (!TIKTOK.appKey() || !TIKTOK.appSecret()) return false;
    const h = p.headers.authorization;
    const given = (Array.isArray(h) ? h[0] : h) ?? '';
    const expected = tiktokWebhookSignature(TIKTOK.appKey(), p.rawBody, TIKTOK.appSecret());
    const a = Buffer.from(given.trim().toLowerCase()); const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  webhookEventId(payload: unknown): string | null {
    const id = obj(payload).tts_notification_id;
    return typeof id === 'string' && id ? id : null; // sem o campo, o sistema usa o hash do corpo
  }

  async processNotification(ctx: ConnectionContext, p: { eventType: string | null; payload: unknown }): Promise<OpResult<{ handled: boolean; orders?: ExternalOrder[] }>> {
    const body = obj(p.payload);
    const type = Number(body.type);
    if (type === TIKTOK.events.deauthorized) return fail('AUTH', 'O vendedor revogou a autorização do aplicativo no TikTok Shop. Reconecte a loja.');
    if (type === TIKTOK.events.orderStatus) {
      // o conteúdo da notificação não é fonte de verdade: relê o pedido na API com o token da loja
      const id = digits(obj(body.data).order_id);
      if (!id) return fail('VALIDATION', 'Notificação de pedido sem order_id.');
      const d = await this.orderDetails(ctx, [id]);
      if (!d.ok) return d;
      const orders = this.convert(d.data);
      return orders.ok ? okResult({ handled: true, orders: orders.data }) : orders;
    }
    return okResult({ handled: type === TIKTOK.events.expiring }); // demais eventos: a sincronização periódica cobre
  }
}
