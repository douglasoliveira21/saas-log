import { createHmac } from 'node:crypto';
import {
  BaseConnector, CapabilityMatrix, ConnectionContext, ConnectorInfo, Credentials, ExternalOrder, ExternalProduct, fail, okResult, OpResult,
} from './connector';

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const rows = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : [];
const str = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const id = (value: unknown) => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? String(value) : undefined;
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
const WINDOW = 14 * 86_400;

export const SHOPEE = {
  partnerId: () => process.env.SHOPEE_PARTNER_ID ?? '',
  partnerKey: () => process.env.SHOPEE_PARTNER_KEY ?? '',
  sandbox: () => process.env.SHOPEE_SANDBOX === 'true',
  apiBase: () => process.env.NODE_ENV === 'test' && process.env.SHOPEE_API_BASE
    ? process.env.SHOPEE_API_BASE
    : SHOPEE.sandbox() ? 'https://partner.test-stable.shopeemobile.com' : 'https://partner.shopeemobile.com',
  authBase: () => SHOPEE.sandbox() ? 'https://open.sandbox.test-stable.shopee.com.br' : 'https://open.shopee.com.br',
};

export function shopeeSignature(path: string, timestamp: number, accessToken = '', shopId = '') {
  return createHmac('sha256', SHOPEE.partnerKey()).update(`${SHOPEE.partnerId()}${path}${timestamp}${accessToken}${shopId}`).digest('hex');
}

function configured(): OpResult<never> | null {
  return id(SHOPEE.partnerId()) && SHOPEE.partnerKey() ? null : fail('NOT_CONFIGURED', 'Configure SHOPEE_PARTNER_ID e SHOPEE_PARTNER_KEY no servidor para conectar a Shopee.');
}

function tokenResult(data: Json, shopId: string): OpResult<Credentials> {
  const ttl = Number(data.expire_in);
  if (!str(data.access_token) || !str(data.refresh_token) || !Number.isFinite(ttl) || ttl <= 0) {
    return fail('UNAVAILABLE', 'Shopee retornou credenciais incompletas.');
  }
  const shops = Array.isArray(data.shop_id_list) ? data.shop_id_list.map(String) : [];
  if ((data.shop_id !== undefined && String(data.shop_id) !== shopId) || (shops.length && !shops.includes(shopId))) {
    return fail('AUTH', 'A autorização recebida não corresponde à loja selecionada.');
  }
  return okResult({
    credentials: { accessToken: data.access_token, refreshToken: data.refresh_token, shopId },
    expiresAt: new Date(Date.now() + ttl * 1000), externalAccountId: shopId,
  });
}

function externalItemId(itemId: unknown, modelId: unknown) {
  return Number(modelId) > 0 ? `${itemId}:${modelId}` : String(itemId);
}

export function normalizeShopeeOrder(order: Json): ExternalOrder {
  const status = String(order.order_status ?? '');
  const paid = ['READY_TO_SHIP', 'PROCESSED', 'SHIPPED', 'COMPLETED', 'TO_CONFIRM_RECEIVE'].includes(status);
  return {
    externalId: String(order.order_sn),
    status: status === 'CANCELLED' ? 'cancelled' : paid ? 'paid' : status.toLowerCase(),
    createdAt: Number(order.create_time) > 0 ? new Date(Number(order.create_time) * 1000).toISOString() : undefined,
    total: order.total_amount === undefined ? undefined : Number(order.total_amount),
    buyer: id(order.buyer_user_id) ? { id: String(order.buyer_user_id), nickname: str(order.buyer_username) } : undefined,
    items: rows(order.item_list).map((item) => ({
      externalItemId: externalItemId(item.item_id, item.model_id),
      sku: Number(item.model_id) > 0 ? str(item.model_sku) : str(item.item_sku),
      title: [str(item.item_name), str(item.model_name)].filter(Boolean).join(' — '),
      quantity: Number(item.model_quantity_purchased),
      unitPrice: Number(item.model_discounted_price ?? item.model_original_price),
    })),
    raw: { order_sn: order.order_sn, order_status: status, update_time: order.update_time ?? null },
  };
}

function normalizeProduct(item: Json, model?: Json, variations: Json[] = []): ExternalProduct {
  const stock = object(model?.stock_info_v2 ?? item.stock_info_v2);
  const price = rows(model?.price_info ?? item.price_info)[0];
  const indexes = Array.isArray(model?.tier_index) ? model.tier_index : [];
  const options = indexes.map((index, tier) => object(rows(variations[tier]?.option_list)[Number(index)]));
  const names = options.map((option) => str(option.option)).filter(Boolean);
  const variationImages = options.map((option) => str(object(option.image).image_url)).filter((url): url is string => !!url);
  const images = object(item.image).image_url_list;
  return {
    externalId: externalItemId(item.item_id, model?.model_id),
    title: [String(item.item_name), ...names].join(' — '),
    sku: model ? str(model.model_sku) : str(item.item_sku),
    description: str(item.description) ?? rows(object(object(item.description_info).extended_description).field_list).map((field) => str(field.text)).filter(Boolean).join('\n'),
    brand: str(object(item.brand).original_brand_name),
    gtin: str(model?.gtin_code ?? item.gtin_code),
    price: price?.original_price === undefined ? undefined : Number(price.original_price),
    quantity: object(stock.summary_info).total_available_stock === undefined ? undefined : Number(object(stock.summary_info).total_available_stock),
    condition: item.condition === 'USED' ? 'USED' : 'NEW',
    categoryId: item.category_id === undefined ? undefined : String(item.category_id),
    status: str(model?.model_status) ?? str(item.item_status),
    pictures: [...new Set([...variationImages, ...(Array.isArray(images) ? images.filter((url): url is string => typeof url === 'string') : [])])],
    raw: { item_id: item.item_id, model_id: model?.model_id ?? 0 },
  };
}

interface OrderCursor { from: number; to: number; end: number; page: string }

/** Contratos oficiais v2 consultados em 16/11/2026. Validação real ainda depende de uma loja autorizada. */
export class ShopeeConnector extends BaseConnector {
  readonly info: ConnectorInfo = {
    provider: 'SHOPEE', displayName: 'Shopee', category: 'MARKETPLACE', region: 'BR', authType: 'SIGNED_OAUTH2',
    docsUrl: 'https://open.shopee.com/developer-guide/20',
    imageHosts: ['susercontent.com', 'shopeemobile.com'],
    notes: 'Aplicativo aprovado no Shopee Open Platform. Autorize uma loja por conexão. Pedidos, catálogo com variações, preço e estoque implementados com testes simulados. Configure Partner ID e Partner Key no servidor.',
  };

  getCapabilities(): CapabilityMatrix {
    return { authorization: 'IMPLEMENTED_UNVERIFIED', orders: 'IMPLEMENTED_UNVERIFIED', catalog: 'IMPLEMENTED_UNVERIFIED',
      price: 'IMPLEMENTED_UNVERIFIED', inventory: 'IMPLEMENTED_UNVERIFIED', publishing: 'PLANNED', shipments: 'PLANNED', webhooks: 'PLANNED' };
  }

  private async request(ctx: ConnectionContext | null, path: string, params: Record<string, string | number | string[]> = {}, body?: Json): Promise<OpResult<Json>> {
    const missing = configured();
    if (missing) return missing;
    const accessToken = ctx ? str(ctx.credentials?.accessToken) : undefined;
    const shopId = ctx ? id(ctx.externalAccountId) : undefined;
    if (ctx && (!accessToken || !shopId)) return fail('AUTH', 'Autorize a loja Shopee antes de continuar.');
    const timestamp = seconds(new Date());
    const url = new URL(path, SHOPEE.apiBase());
    url.searchParams.set('partner_id', SHOPEE.partnerId());
    url.searchParams.set('timestamp', String(timestamp));
    url.searchParams.set('sign', shopeeSignature(path, timestamp, accessToken, shopId));
    if (ctx) {
      url.searchParams.set('access_token', accessToken!);
      url.searchParams.set('shop_id', shopId!);
    }
    for (const [key, value] of Object.entries(params)) {
      for (const entry of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(entry));
    }
    try {
      const response = await fetch(url, {
        method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
      });
      const data = object(await response.json());
      const error = str(data.error);
      // Não devolve mensagens externas, que podem incluir tokens e assinaturas.
      if (response.status === 429 || /rate|too_many|too_frequent/i.test(error ?? '')) return fail('RATE_LIMIT', 'Limite de requisições da Shopee atingido. O sistema tentará novamente.', 60_000);
      if (response.status >= 500) return fail('UNAVAILABLE', 'Shopee temporariamente indisponível.');
      if ([401, 403].includes(response.status) || /auth|token|sign|permission/i.test(error ?? '')) return fail('AUTH', 'A Shopee recusou a autorização. Confira as permissões do aplicativo ou reconecte a loja.');
      if (!response.ok || error) return fail('VALIDATION', 'A Shopee recusou a solicitação. Confira os dados e as permissões da loja no Open Platform.');
      if (!Object.keys(data).length) return fail('UNAVAILABLE', 'Resposta vazia da Shopee.');
      return okResult(data);
    } catch {
      return fail('UNAVAILABLE', 'Não foi possível obter a resposta da Shopee. Tente novamente.');
    }
  }

  async authorizeConnection(_ctx: ConnectionContext, p: { redirectUri: string; state: string }): Promise<OpResult<{ authorizationUrl: string }>> {
    const missing = configured();
    if (missing) return missing;
    const url = new URL('/auth', SHOPEE.authBase());
    url.search = new URLSearchParams({ partner_id: SHOPEE.partnerId(), auth_type: 'seller', redirect_uri: p.redirectUri, response_type: 'code', state: p.state }).toString();
    return okResult({ authorizationUrl: url.toString() });
  }

  async completeAuthorization(_ctx: ConnectionContext, p: { code: string; shopId?: string }): Promise<OpResult<Credentials>> {
    const shopId = id(p.shopId);
    if (!shopId) return fail('VALIDATION', 'Autorize usando a conta de uma única loja Shopee. O retorno precisa conter shop_id.');
    const result = await this.request(null, '/api/v2/auth/token/get', {}, { code: p.code, shop_id: Number(shopId), partner_id: Number(SHOPEE.partnerId()) });
    return result.ok ? tokenResult(result.data, shopId) : result;
  }

  async refreshAuthorization(ctx: ConnectionContext): Promise<OpResult<Credentials>> {
    const shopId = id(ctx.externalAccountId);
    const refreshToken = str(ctx.credentials?.refreshToken);
    if (!shopId || !refreshToken) return fail('AUTH', 'Reconecte a loja Shopee para renovar a autorização.');
    const result = await this.request(null, '/api/v2/auth/access_token/get', {}, { refresh_token: refreshToken, shop_id: Number(shopId), partner_id: Number(SHOPEE.partnerId()) });
    return result.ok ? tokenResult(result.data, shopId) : result;
  }

  async validateConnection(ctx: ConnectionContext): Promise<OpResult<{ externalAccountId?: string }>> {
    const result = await this.request(ctx, '/api/v2/shop/get_shop_info');
    if (!result.ok) return result;
    if (result.data.shop_id !== undefined && String(result.data.shop_id) !== ctx.externalAccountId) return fail('AUTH', 'Shopee retornou uma loja diferente da conexão.');
    if (result.data.region !== 'BR') return fail('VALIDATION', 'Esta integração atende lojas Shopee do Brasil.');
    if (!str(result.data.shop_name) || result.data.status !== 'NORMAL') return fail('AUTH', 'A loja Shopee está indisponível para sincronização.');
    return okResult({ externalAccountId: ctx.externalAccountId! });
  }

  async fetchOrders(ctx: ConnectionContext, p: { since?: Date; cursor?: string }): Promise<OpResult<{ orders: ExternalOrder[]; nextCursor?: string }>> {
    let cursor: OrderCursor;
    const now = seconds(new Date());
    try {
      const from = seconds(p.since ?? new Date(Date.now() - 7 * 86_400_000));
      cursor = p.cursor ? JSON.parse(p.cursor) : { from, to: Math.min(from + WINDOW, now), end: now, page: '' };
      if (![cursor.from, cursor.to, cursor.end].every(Number.isSafeInteger) || cursor.from < 0 || cursor.from > cursor.to || cursor.to > cursor.end || cursor.to - cursor.from > WINDOW || typeof cursor.page !== 'string') throw new Error();
    } catch { return fail('VALIDATION', 'Cursor ou período de pedidos Shopee inválido.'); }
    const result = await this.request(ctx, '/api/v2/order/get_order_list', {
      time_range_field: 'update_time', time_from: cursor.from, time_to: cursor.to, page_size: 50, cursor: cursor.page,
    });
    if (!result.ok) return result;
    const response = object(result.data.response);
    if (!Array.isArray(response.order_list)) return fail('UNAVAILABLE', 'Resposta de pedidos da Shopee incompleta.');
    const ids = rows(response.order_list).map((order) => str(order.order_sn));
    if (ids.some((value) => !value)) return fail('UNAVAILABLE', 'Shopee retornou um pedido sem identificador.');
    let orders: ExternalOrder[] = [];
    if (ids.length) {
      const detail = await this.request(ctx, '/api/v2/order/get_order_detail', {
        order_sn_list: ids.join(','), response_optional_fields: 'buyer_user_id,buyer_username,item_list,total_amount,pay_time',
      });
      if (!detail.ok) return detail;
      const details = rows(object(detail.data.response).order_list);
      if (ids.some((value) => !details.some((order) => order.order_sn === value))) return fail('UNAVAILABLE', 'A Shopee ainda não retornou todos os detalhes dos pedidos. A consulta será repetida.');
      if (details.some((order) => order.currency !== 'BRL')) return fail('VALIDATION', 'Pedido Shopee com moeda diferente de BRL.');
      orders = details.map(normalizeShopeeOrder);
    }
    let nextCursor: string | undefined;
    if (response.more === true) {
      const page = str(response.next_cursor);
      if (!page || page === cursor.page) return fail('UNAVAILABLE', 'Shopee retornou paginação de pedidos inconsistente.');
      nextCursor = JSON.stringify({ ...cursor, page });
    } else if (cursor.to < cursor.end) {
      const from = cursor.to;
      nextCursor = JSON.stringify({ ...cursor, from, to: Math.min(from + WINDOW, cursor.end), page: '' });
    }
    return okResult({ orders, nextCursor });
  }

  private async products(ctx: ConnectionContext, ids: string[]): Promise<OpResult<ExternalProduct[]>> {
    if (!ids.length) return okResult([]);
    const result = await this.request(ctx, '/api/v2/product/get_item_base_info', { item_id_list: ids.join(',') });
    if (!result.ok) return result;
    const items = rows(object(result.data.response).item_list);
    if (ids.some((value) => !items.some((item) => String(item.item_id) === value))) return fail('UNAVAILABLE', 'Shopee retornou detalhes incompletos do catálogo.');
    const products: ExternalProduct[] = [];
    for (const item of items) {
      if (rows(item.price_info).some((price) => price.currency !== 'BRL')) return fail('VALIDATION', 'Produto Shopee com moeda diferente de BRL.');
      if (!item.has_model) { products.push(normalizeProduct(item)); continue; }
      const result = await this.request(ctx, '/api/v2/product/get_model_list', { item_id: String(item.item_id) });
      if (!result.ok) return result;
      const response = object(result.data.response);
      const models = rows(response.model);
      if (!models.length) return fail('UNAVAILABLE', 'Shopee retornou produto com variações sem detalhar as variações.');
      if (models.some((model) => rows(model.price_info).some((price) => price.currency !== 'BRL'))) return fail('VALIDATION', 'Variação Shopee com moeda diferente de BRL.');
      products.push(...models.map((model) => normalizeProduct(item, model, rows(response.tier_variation))));
    }
    return okResult(products);
  }

  async fetchProducts(ctx: ConnectionContext, p: { cursor?: string }): Promise<OpResult<{ products: ExternalProduct[]; nextCursor?: string }>> {
    const offset = Number(p.cursor ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) return fail('VALIDATION', 'Cursor de catálogo Shopee inválido.');
    const result = await this.request(ctx, '/api/v2/product/get_item_list', { offset, page_size: 50, item_status: ['NORMAL', 'UNLIST'] });
    if (!result.ok) return result;
    const response = object(result.data.response);
    if (!Array.isArray(response.item)) return fail('UNAVAILABLE', 'Shopee retornou uma página de catálogo incompleta.');
    const products = await this.products(ctx, rows(response.item).map((item) => String(item.item_id)));
    if (!products.ok) return products;
    const next = Number(response.next_offset);
    if (response.has_next_page === true && (!Number.isSafeInteger(next) || next <= offset)) return fail('UNAVAILABLE', 'Shopee retornou paginação de catálogo inconsistente.');
    return okResult({ products: products.data, nextCursor: response.has_next_page === true ? String(next) : undefined });
  }

  async fetchProductDetail(ctx: ConnectionContext, p: { externalId: string }): Promise<OpResult<ExternalProduct>> {
    const ref = this.itemRef(p.externalId);
    if (!ref.ok) return ref;
    const result = await this.products(ctx, [String(ref.data.itemId)]);
    if (!result.ok) return result;
    const product = result.data.find((item) => item.externalId === p.externalId);
    return product ? okResult(product) : fail('VALIDATION', 'Produto ou variação não encontrado na loja Shopee.');
  }

  private itemRef(value: string): OpResult<{ itemId: number; modelId: number }> {
    const match = /^([1-9]\d*)(?::([1-9]\d*))?$/.exec(value);
    if (!match || !id(match[1]) || (match[2] && !id(match[2]))) return fail('VALIDATION', 'Identificador Shopee inválido. Use item_id ou item_id:model_id para variações.');
    return okResult({ itemId: Number(match[1]), modelId: Number(match[2] ?? 0) });
  }

  private async update(ctx: ConnectionContext, externalId: string, action: 'price' | 'stock', value: number): Promise<OpResult<null>> {
    const ref = this.itemRef(externalId);
    if (!ref.ok) return ref;
    if (!Number.isFinite(value) || (action === 'stock' ? !Number.isSafeInteger(value) || value < 0 : value <= 0)) return fail('VALIDATION', 'Preço ou estoque Shopee inválido.');
    const entry = action === 'price' ? { model_id: ref.data.modelId, original_price: value } : { model_id: ref.data.modelId, seller_stock: [{ stock: value }] };
    const result = await this.request(ctx, `/api/v2/product/update_${action}`, {}, { item_id: ref.data.itemId, [action === 'price' ? 'price_list' : 'stock_list']: [entry] });
    if (!result.ok) return result;
    const response = object(result.data.response);
    if (rows(response.failure_list).length) return fail('VALIDATION', 'Shopee recusou a atualização do produto. Confira campanhas, estoque reservado e configuração de depósitos no canal.');
    if (!rows(response.success_list).some((item) => Number(item.model_id) === ref.data.modelId)) return fail('UNAVAILABLE', 'Shopee não confirmou a atualização do produto.');
    return okResult(null);
  }

  updatePrice(ctx: ConnectionContext, p: { externalId: string; price: number }) { return this.update(ctx, p.externalId, 'price', p.price); }
  updateInventory(ctx: ConnectionContext, p: { externalId: string; quantity: number }) { return this.update(ctx, p.externalId, 'stock', p.quantity); }
}
