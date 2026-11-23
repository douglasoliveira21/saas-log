import { createHmac } from 'node:crypto';
import { ConnectionContext, ItemDraft } from './connector';
import { normalizeTikTokOrder, TikTokConnector, tiktokSign, tiktokWebhookSignature } from './tiktok.connector';

const SECRET = 'segredo-do-app';
const KEY = 'chave-do-app';
const ctx: ConnectionContext = {
  tenantId: 't', connectionId: 'c', externalAccountId: '7000000001',
  config: {}, credentials: { accessToken: 'ACCESS-1', refreshToken: 'REFRESH-1', shopId: '7000000001', shopCipher: 'CIFRA-LOJA' },
};

/** Reimplementação independente da regra de assinatura (não usa a função do conector). */
function expectedSign(url: URL, body: string, multipart = false) {
  const entries = [...url.searchParams.entries()].filter(([k]) => !['sign', 'access_token', 'x-tts-access-token'].includes(k)).sort(([a], [b]) => (a < b ? -1 : 1));
  const text = SECRET + url.pathname + entries.map(([k, v]) => k + v).join('') + (multipart ? '' : body) + SECRET;
  return createHmac('sha256', SECRET).update(text).digest('hex');
}

describe('TikTok Shop Open API 202309', () => {
  const c = new TikTokConnector();
  let fetchMock: jest.SpyInstance;
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.TIKTOK_APP_KEY = KEY; process.env.TIKTOK_APP_SECRET = SECRET; delete process.env.TIKTOK_SERVICE_ID;
    fetchMock = jest.spyOn(global, 'fetch');
  });
  afterEach(() => {
    fetchMock.mockRestore();
    for (const n of ['TIKTOK_APP_KEY', 'TIKTOK_APP_SECRET', 'TIKTOK_SERVICE_ID']) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
  });
  const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, message: 'Success', request_id: 'r', data }), { status: 200 });
  const queue = (...v: Response[]) => v.forEach((r) => fetchMock.mockResolvedValueOnce(r));
  const call = (i = 0) => {
    const [u, init] = fetchMock.mock.calls[i] as [URL, RequestInit];
    const url = new URL(String(u));
    return { url, init, headers: (init.headers ?? {}) as Record<string, string>, body: typeof init.body === 'string' ? init.body : '' };
  };

  describe('assinatura', () => {
    it('ordena os parâmetros, ignora sign/access_token, põe o caminho na frente e envolve com o segredo', () => {
      const params = { timestamp: '1700000000', app_key: KEY, shop_cipher: 'X', access_token: 'NAO-ENTRA', sign: 'NAO-ENTRA', page_size: '20' };
      const got = tiktokSign('/order/202309/orders/search', params, '{"a":1}', SECRET);
      const text = `${SECRET}/order/202309/orders/searchapp_key${KEY}page_size20shop_cipherXtimestamp1700000000{"a":1}${SECRET}`;
      expect(got).toBe(createHmac('sha256', SECRET).update(text).digest('hex'));
      expect(got).toMatch(/^[0-9a-f]{64}$/);
    });
    it('o corpo não entra em envio de arquivo (multipart)', () => {
      expect(tiktokSign('/p', { a: '1' }, 'CORPO', SECRET, true)).toBe(tiktokSign('/p', { a: '1' }, '', SECRET));
      expect(tiktokSign('/p', { a: '1' }, 'CORPO', SECRET)).not.toBe(tiktokSign('/p', { a: '1' }, '', SECRET));
    });
  });

  describe('autorização', () => {
    it('monta o endereço de autorização com app_key e state; usa o ID do serviço quando existe; avisa se faltar configuração', async () => {
      const r = await c.authorizeConnection(ctx, { redirectUri: 'x', state: 'assinado' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const u = new URL(r.data.authorizationUrl);
      expect(u.origin + u.pathname).toBe('https://auth.tiktok-shops.com/oauth/authorize');
      expect(u.searchParams.get('app_key')).toBe(KEY);
      expect(u.searchParams.get('state')).toBe('assinado');
      process.env.TIKTOK_SERVICE_ID = '99';
      const s = await c.authorizeConnection(ctx, { redirectUri: 'x', state: 's' });
      expect(s.ok && new URL(s.data.authorizationUrl).hostname).toBe('services.tiktokshop.com');
      delete process.env.TIKTOK_APP_SECRET;
      expect(await c.authorizeConnection(ctx, { redirectUri: 'x', state: 's' })).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' });
    });

    it('troca o código (sem assinatura), lê as lojas com o token no cabeçalho e guarda shop_cipher', async () => {
      const exp = Math.floor(Date.now() / 1000) + 604_800;
      queue(ok({ access_token: 'A1', access_token_expire_in: exp, refresh_token: 'R1', seller_name: 'Vendedor' }),
        ok({ shops: [{ id: '7000000001', name: 'Loja BR', region: 'BR', cipher: 'CIFRA-LOJA', code: 'BR1' }] }));
      const r = await c.completeAuthorization(ctx, { code: 'CODIGO' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const t = call(0);
      expect(t.url.origin + t.url.pathname).toBe('https://auth.tiktok-shops.com/api/v2/token/get');
      expect(Object.fromEntries(t.url.searchParams)).toMatchObject({ app_key: KEY, app_secret: SECRET, auth_code: 'CODIGO', grant_type: 'authorized_code' });
      expect(t.url.searchParams.has('sign')).toBe(false);
      const s = call(1);
      expect(s.url.pathname).toBe('/authorization/202309/shops');
      expect(s.headers['x-tts-access-token']).toBe('A1');
      expect(s.url.searchParams.has('shop_cipher')).toBe(false); // caminhos de autorização não levam shop_cipher
      expect(s.url.searchParams.get('sign')).toBe(expectedSign(s.url, ''));
      expect(r.data.credentials).toMatchObject({ accessToken: 'A1', refreshToken: 'R1', shopId: '7000000001', shopCipher: 'CIFRA-LOJA' });
      expect(r.data.externalAccountId).toBe('7000000001');
      expect(r.data.expiresAt!.getTime()).toBe(exp * 1000);
    });

    it('recusa lojas que não são do Brasil e autorização com mais de uma loja', async () => {
      queue(ok({ access_token: 'A', access_token_expire_in: 3600, refresh_token: 'R' }), ok({ shops: [{ id: '1', region: 'US', cipher: 'x' }] }));
      expect(await c.completeAuthorization(ctx, { code: 'c' })).toMatchObject({ ok: false, code: 'VALIDATION' });
      queue(ok({ access_token: 'A', access_token_expire_in: 3600, refresh_token: 'R' }), ok({ shops: [{ id: '1', region: 'BR', cipher: 'x' }, { id: '2', region: 'BR', cipher: 'y' }] }));
      expect(await c.completeAuthorization(ctx, { code: 'c' })).toMatchObject({ ok: false, code: 'VALIDATION' });
    });

    it('aceita validade em segundos a partir de agora e recusa resposta sem tokens', async () => {
      queue(ok({ access_token: 'A', access_token_expire_in: 3600, refresh_token: 'R' }), ok({ shops: [{ id: '5', region: 'BR', cipher: 'k' }] }));
      const r = await c.completeAuthorization(ctx, { code: 'c' });
      expect(r.ok && r.data.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
      queue(ok({ access_token: 'A' }));
      expect(await c.completeAuthorization(ctx, { code: 'c' })).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
    });

    it('renova o token mantendo os dados da loja; sem refresh token pede reconexão', async () => {
      queue(ok({ access_token: 'A2', access_token_expire_in: 3600, refresh_token: 'R2' }));
      const r = await c.refreshAuthorization(ctx);
      expect(r.ok).toBe(true);
      expect(Object.fromEntries(call(0).url.searchParams)).toMatchObject({ refresh_token: 'REFRESH-1', grant_type: 'refresh_token' });
      expect(call(0).url.pathname).toBe('/api/v2/token/refresh');
      if (r.ok) expect(r.data.credentials).toMatchObject({ accessToken: 'A2', refreshToken: 'R2', shopCipher: 'CIFRA-LOJA', shopId: '7000000001' });
      expect(await c.refreshAuthorization({ ...ctx, credentials: { accessToken: 'x' } })).toMatchObject({ ok: false, code: 'AUTH' });
    });

    it('valida que a loja continua autorizada', async () => {
      queue(ok({ shops: [{ id: '7000000001', region: 'BR' }] }));
      expect(await c.validateConnection(ctx)).toEqual({ ok: true, data: { externalAccountId: '7000000001' } });
      queue(ok({ shops: [{ id: '999', region: 'BR' }] }));
      expect(await c.validateConnection(ctx)).toMatchObject({ ok: false, code: 'AUTH' });
    });
  });

  describe('erros', () => {
    const bad = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    it('mapeia HTTP e códigos do canal sem expor segredos', async () => {
      queue(bad(401, { code: 105002, message: 'access token expired' }));
      expect(await c.validateConnection(ctx)).toMatchObject({ ok: false, code: 'AUTH' });
      queue(bad(429, { code: 1, message: 'rate limit exceeded' }));
      expect(await c.validateConnection(ctx)).toMatchObject({ ok: false, code: 'RATE_LIMIT', retryAfterMs: 60_000 });
      queue(bad(500, { message: 'boom' }));
      expect(await c.validateConnection(ctx)).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
      queue(bad(200, { code: 12052001, message: 'invalid parameter' }));
      const v = await c.validateConnection(ctx);
      expect(v).toMatchObject({ ok: false, code: 'VALIDATION' });
      expect(JSON.stringify(v)).not.toMatch(/ACCESS-1|CIFRA|segredo/);
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET ACCESS-1'));
      const net = await c.validateConnection(ctx);
      expect(net).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
      expect(JSON.stringify(net)).not.toContain('ACCESS-1');
    });
  });

  describe('pedidos', () => {
    const line = (sku: string, price = '25.00', pid = '111') => ({ id: Math.random().toString(), product_id: pid, sku_id: sku, seller_sku: `S-${sku}`, product_name: 'Parafuso', sku_name: 'M8', sale_price: price });
    const order = (id: string, status: string, lines: unknown[] = [line('1'), line('1'), line('2', '10.00')]) => ({
      id, status, create_time: 1_700_000_000, update_time: 1_700_000_100, user_id: 'U9', payment: { currency: 'BRL', total_amount: '60.00' }, recipient_address: { name: 'Fulana' }, line_items: lines,
    });

    it('busca por data de atualização com assinatura válida, cabeçalho de acesso e shop_cipher; agrupa unidades por SKU e mapeia status', async () => {
      queue(ok({ orders: [order('A1', 'AWAITING_SHIPMENT'), order('A2', 'UNPAID'), order('A3', 'CANCELLED'), order('A4', 'ON_HOLD')], next_page_token: '' }));
      const since = new Date('2026-11-01T00:00:00Z');
      const r = await c.fetchOrders(ctx, { since });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const q = call(0);
      expect(q.init.method).toBe('POST');
      expect(q.url.pathname).toBe('/order/202309/orders/search');
      expect(q.headers['x-tts-access-token']).toBe('ACCESS-1');
      expect(q.url.searchParams.get('shop_cipher')).toBe('CIFRA-LOJA');
      expect(q.url.searchParams.get('app_key')).toBe(KEY);
      expect(q.url.searchParams.get('page_size')).toBe('50');
      expect(q.url.searchParams.get('sign')).toBe(expectedSign(q.url, q.body));
      expect(JSON.parse(q.body).update_time_ge).toBe(Math.floor(since.getTime() / 1000));
      expect(r.data.orders.map((o) => [o.externalId, o.status])).toEqual([['A1', 'paid'], ['A2', 'unpaid'], ['A3', 'cancelled'], ['A4', 'on_hold']]);
      expect(r.data.orders[0].items).toEqual([
        { externalItemId: '111:1', sku: 'S-1', title: 'Parafuso — M8', quantity: 2, unitPrice: 25 },
        { externalItemId: '111:2', sku: 'S-2', title: 'Parafuso — M8', quantity: 1, unitPrice: 10 },
      ]);
      expect(r.data.orders[0]).toMatchObject({ total: 60, buyer: { id: 'U9', name: 'Fulana' }, createdAt: '2023-11-14T22:13:20.000Z' });
      expect(r.data.nextCursor).toBeUndefined();
    });

    it('segue a paginação por page_token e mantém a janela de tempo', async () => {
      queue(ok({ orders: [order('B1', 'COMPLETED')], next_page_token: 'PAG2' }), ok({ orders: [order('B2', 'DELIVERED')], next_page_token: '' }));
      const first = await c.fetchOrders(ctx, { since: new Date('2026-11-01T00:00:00Z') });
      expect(first.ok && first.data.nextCursor).toBeTruthy();
      if (!first.ok) return;
      const second = await c.fetchOrders(ctx, { cursor: first.data.nextCursor });
      expect(call(1).url.searchParams.get('page_token')).toBe('PAG2');
      expect(JSON.parse(call(1).body)).toEqual(JSON.parse(call(0).body));
      expect(second.ok && second.data.nextCursor).toBeUndefined();
      expect(await c.fetchOrders(ctx, { cursor: 'lixo' })).toMatchObject({ ok: false, code: 'VALIDATION' });
    });

    it('relê pelo detalhe quando a busca vem sem as linhas do pedido e recusa moeda diferente de BRL', async () => {
      queue(ok({ orders: [{ id: 'C1', status: 'AWAITING_SHIPMENT' }] }), ok({ orders: [order('C1', 'AWAITING_SHIPMENT')] }));
      const r = await c.fetchOrders(ctx, {});
      expect(call(1).init.method).toBe('GET');
      expect(call(1).url.pathname).toBe('/order/202309/orders');
      expect(call(1).url.searchParams.get('ids')).toBe('C1');
      expect(r.ok && r.data.orders[0].items).toHaveLength(2);
      queue(ok({ orders: [{ ...order('D1', 'AWAITING_SHIPMENT'), payment: { currency: 'USD', total_amount: '1' } }] }));
      expect(await c.fetchOrders(ctx, {})).toMatchObject({ ok: false, code: 'VALIDATION' });
    });

    it('normalizeTikTokOrder: pedido sem id é descartado e cada status tem tradução', () => {
      expect(normalizeTikTokOrder({ status: 'UNPAID' })).toBeNull();
      for (const s of ['AWAITING_COLLECTION', 'PARTIALLY_SHIPPING', 'IN_TRANSIT']) expect(normalizeTikTokOrder({ id: '1', status: s })!.status).toBe('paid');
    });
  });

  describe('catálogo', () => {
    const product = { id: '555', title: 'Camiseta', status: 'ACTIVATE', description: '<p>Algodão</p>', brand: { name: 'Marca' }, main_images: [{ urls: ['https://p16.tiktokcdn.com/a.jpg'] }], category_chains: [{ id: '1' }, { id: '2' }],
      skus: [{ id: '901', seller_sku: 'CAM-P', price: { currency: 'BRL', sale_price: '39.90' }, inventory: [{ warehouse_id: 'W1', quantity: 4 }, { warehouse_id: 'W2', quantity: 3 }], sales_attributes: [{ value_name: 'P' }], identifier_code: { code: '7891000100103', type: 'GTIN' } },
        { id: '902', seller_sku: 'CAM-M', price: { currency: 'BRL', sale_price: '39.90' }, inventory: [{ warehouse_id: 'W1', quantity: 1 }], sales_attributes: [{ value_name: 'M' }] }] };

    it('lista um anúncio por SKU, sem descrição nem fotos (só na leitura completa), com paginação', async () => {
      queue(ok({ products: [product], next_page_token: 'P2' }));
      const r = await c.fetchProducts(ctx, {});
      expect(call(0).url.pathname).toBe('/product/202309/products/search');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.products.map((p) => [p.externalId, p.sku, p.price, p.quantity])).toEqual([['555:901', 'CAM-P', 39.9, 7], ['555:902', 'CAM-M', 39.9, 1]]);
      expect(r.data.products[0]).toMatchObject({ title: 'Camiseta — P', description: undefined, pictures: [], gtin: '7891000100103' });
      expect(r.data.nextCursor).toBe('P2');
    });

    it('leitura completa traz descrição, marca, categoria e fotos; id inválido é recusado', async () => {
      queue(ok(product));
      const r = await c.fetchProductDetail(ctx, { externalId: '555:902' });
      expect(call(0).url.pathname).toBe('/product/202309/products/555');
      expect(r.ok && r.data).toMatchObject({ externalId: '555:902', description: '<p>Algodão</p>', brand: 'Marca', categoryId: '2', pictures: ['https://p16.tiktokcdn.com/a.jpg'] });
      expect(await c.fetchProductDetail(ctx, { externalId: 'abc' })).toMatchObject({ ok: false, code: 'VALIDATION' });
      queue(ok(product));
      expect(await c.fetchProductDetail(ctx, { externalId: '555:999' })).toMatchObject({ ok: false, code: 'VALIDATION' });
    });
  });

  describe('preço, estoque e anúncio', () => {
    const detail = { id: '555', skus: [{ id: '901', seller_sku: 'CAM-P', inventory: [{ warehouse_id: 'W1', quantity: 4 }] }] };

    it('preço: lê o SKU e envia o valor em BRL com duas casas', async () => {
      queue(ok(detail), ok({}));
      expect(await c.updatePrice(ctx, { externalId: '555:901', price: 49.9 })).toEqual({ ok: true, data: null });
      const u = call(1);
      expect(u.url.pathname).toBe('/product/202309/products/555/prices/update');
      expect(JSON.parse(u.body)).toEqual({ skus: [{ id: '901', price: { amount: '49.90', currency: 'BRL' } }] });
      expect(u.url.searchParams.get('sign')).toBe(expectedSign(u.url, u.body));
      expect(await c.updatePrice(ctx, { externalId: '555:901', price: 0 })).toMatchObject({ ok: false, code: 'VALIDATION' });
    });

    it('estoque: usa o depósito que o SKU já tem; sem depósito, procura o padrão da loja; recusa quantidade inválida', async () => {
      queue(ok(detail), ok({}));
      expect((await c.updateInventory(ctx, { externalId: '555:901', quantity: 12 })).ok).toBe(true);
      expect(call(1).url.pathname).toBe('/product/202309/products/555/inventory/update');
      expect(JSON.parse(call(1).body)).toEqual({ skus: [{ id: '901', inventory: [{ warehouse_id: 'W1', quantity: 12 }] }] });
      fetchMock.mockClear();
      queue(ok({ id: '555', skus: [{ id: '901' }] }), ok({ warehouses: [{ id: 'WX', is_default: false, effect_status: 'ENABLED' }, { id: 'WD', is_default: true, effect_status: 'ENABLED' }] }), ok({}));
      expect((await c.updateInventory(ctx, { externalId: '555', quantity: 0 })).ok).toBe(true); // 555 sem sku_id: só um SKU, resolvido sozinho
      expect(call(1).url.pathname).toBe('/logistics/202309/warehouses');
      expect(JSON.parse(call(2).body).skus[0].inventory[0]).toEqual({ warehouse_id: 'WD', quantity: 0 });
      expect(await c.updateInventory(ctx, { externalId: '555:901', quantity: -1 })).toMatchObject({ ok: false, code: 'VALIDATION' });
      expect(await c.updateInventory(ctx, { externalId: '555:901', quantity: 1.5 })).toMatchObject({ ok: false, code: 'VALIDATION' });
    });

    it('produto com vários SKUs exige o sku_id; desativar anúncio chama o canal e acusa erro por produto', async () => {
      queue(ok({ id: '555', skus: [{ id: '1' }, { id: '2' }] }));
      expect(await c.updatePrice(ctx, { externalId: '555', price: 10 })).toMatchObject({ ok: false, code: 'VALIDATION' });
      queue(ok({ errors: [] }));
      expect((await c.cancelListing(ctx, { externalId: '555:901' })).ok).toBe(true);
      expect(JSON.parse(call(1).body)).toEqual({ product_ids: ['555'] });
      queue(ok({ errors: [{ code: 1, message: 'não pode' }] }));
      expect(await c.cancelListing(ctx, { externalId: '555:901' })).toMatchObject({ ok: false, code: 'VALIDATION' });
    });

    it('atualização parcial envia só título e descrição', async () => {
      queue(ok({}));
      expect((await c.updateProduct(ctx, { externalId: '555:901', payload: { title: 'Novo', description: 'D', price: 5 } })).ok).toBe(true);
      expect(call(0).url.pathname).toBe('/product/202309/products/555/partial_edit');
      expect(JSON.parse(call(0).body)).toEqual({ title: 'Novo', description: 'D' });
      expect(await c.updateProduct(ctx, { externalId: '555:901', payload: {} })).toMatchObject({ ok: false, code: 'VALIDATION' });
    });
  });

  describe('publicação', () => {
    const draft: ItemDraft = {
      sku: 'NOVO-1', title: 'Produto novo', description: 'Descrição', price: 59.9, quantity: 8, condition: 'NEW', gtin: '7891000100103', categoryId: '600001', attributes: [],
      pictures: [{ url: 'https://fotos.exemplo/a.jpg', width: 800, height: 800 }], weightG: 250, heightMm: 100, widthMm: 200, lengthMm: 300,
    };

    it('valida antes de chamar o canal', () => {
      expect(c.validateDraft(draft)).toEqual([]);
      const issues = c.validateDraft({ ...draft, title: ' ', categoryId: undefined, pictures: [], weightG: undefined, price: 0, description: '' });
      expect(issues.length).toBe(6);
    });

    it('não cria em duplicidade: se o SKU já existe no canal, devolve o anúncio existente', async () => {
      queue(ok({ products: [{ id: '777', skus: [{ id: '31', seller_sku: 'NOVO-1' }] }] }));
      const r = await c.publishProduct(ctx, { productId: 'p', payload: draft, idempotencyKey: 'k' });
      expect(r).toEqual({ ok: true, data: { externalId: '777:31' } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(call(0).body)).toMatchObject({ seller_skus: ['NOVO-1'] });
    });

    it('envia a foto (multipart, sem assinar o corpo) e cria o produto com preço, estoque, peso e medidas', async () => {
      queue(ok({ products: [] }), ok({ warehouses: [{ id: 'WD', is_default: true, effect_status: 'ENABLED' }] }),
        new Response(new Uint8Array([1, 2, 3]), { status: 200 }), ok({ uri: 'tos-br/img1', url: 'https://x', width: 800, height: 800 }),
        ok({ product_id: '888', skus: [{ id: '41', seller_sku: 'NOVO-1' }] }));
      const r = await c.publishProduct(ctx, { productId: 'p', payload: draft, idempotencyKey: 'k' });
      expect(r).toEqual({ ok: true, data: { externalId: '888:41' } });
      const up = call(3);
      expect(up.url.pathname).toBe('/product/202309/images/upload');
      expect(up.init.body).toBeInstanceOf(FormData);
      expect(up.headers['content-type']).toBeUndefined(); // o navegador/Node define o boundary
      expect(up.url.searchParams.get('sign')).toBe(expectedSign(up.url, '', true));
      expect(up.url.searchParams.has('shop_cipher')).toBe(true);
      const create = call(4);
      expect(create.url.pathname).toBe('/product/202309/products');
      expect(create.url.searchParams.get('sign')).toBe(expectedSign(create.url, create.body));
      expect(JSON.parse(create.body)).toEqual({
        save_mode: 'LISTING', title: 'Produto novo', description: 'Descrição', category_id: '600001', main_images: [{ uri: 'tos-br/img1' }],
        skus: [{ seller_sku: 'NOVO-1', price: { amount: '59.90', currency: 'BRL' }, inventory: [{ warehouse_id: 'WD', quantity: 8 }], identifier_code: { code: '7891000100103', type: 'GTIN' } }],
        package_weight: { value: '0.250', unit: 'KILOGRAM' }, package_dimensions: { length: '30', width: '20', height: '10', unit: 'CENTIMETER' },
      });
    });

    it('recusa rascunho incompleto sem chamar o canal e repassa a recusa do canal', async () => {
      expect(await c.publishProduct(ctx, { productId: 'p', payload: { ...draft, categoryId: undefined }, idempotencyKey: 'k' })).toMatchObject({ ok: false, code: 'VALIDATION' });
      expect(fetchMock).not.toHaveBeenCalled();
      queue(ok({ products: [] }), ok({ warehouses: [{ id: 'WD', is_default: true }] }), new Response('img'), ok({ uri: 'u' }), new Response(JSON.stringify({ code: 12019001, message: 'missing required attributes' }), { status: 200 }));
      const r = await c.publishProduct(ctx, { productId: 'p', payload: draft, idempotencyKey: 'k' });
      expect(r).toMatchObject({ ok: false, code: 'VALIDATION' });
      expect(r.ok === false && r.message).toContain('missing required attributes');
    });
  });

  describe('envio', () => {
    it('lê o rastreio do pedido', async () => {
      queue(ok({ tracking: [{ update_time_millis: 1_700_000_000_000, description: 'Postado' }] }));
      const r = await c.getShipment(ctx, { externalOrderId: '5771' });
      expect(call(0).url.pathname).toBe('/fulfillment/202309/orders/5771/tracking');
      expect(r).toEqual({ ok: true, data: { orderId: '5771', tracking: [{ at: '2023-11-14T22:13:20.000Z', description: 'Postado' }] } });
      expect(await c.getShipment(ctx, { externalOrderId: '../x' })).toMatchObject({ ok: false, code: 'VALIDATION' });
    });
  });

  describe('notificações', () => {
    const body = JSON.stringify({ type: 1, tts_notification_id: 'N1', shop_id: '7000000001', timestamp: 1_700_000_000, data: { order_id: '5771', order_status: 'AWAITING_SHIPMENT' } });
    const raw = Buffer.from(body);

    it('confere o HMAC de app_key + corpo no cabeçalho Authorization (sem Bearer), em tempo constante', () => {
      const good = createHmac('sha256', SECRET).update(KEY + body).digest('hex');
      expect(tiktokWebhookSignature(KEY, raw, SECRET)).toBe(good);
      expect(c.verifyWebhook({ rawBody: raw, headers: { authorization: good } })).toBe(true);
      expect(c.verifyWebhook({ rawBody: raw, headers: { authorization: good.toUpperCase() } })).toBe(true);
      expect(c.verifyWebhook({ rawBody: raw, headers: { authorization: `Bearer ${good}` } })).toBe(false);
      expect(c.verifyWebhook({ rawBody: Buffer.from(body + ' '), headers: { authorization: good } })).toBe(false); // corpo alterado
      expect(c.verifyWebhook({ rawBody: raw, headers: {} })).toBe(false);
      delete process.env.TIKTOK_APP_SECRET;
      expect(c.verifyWebhook({ rawBody: raw, headers: { authorization: good } })).toBe(false); // sem segredo configurado, nada passa
    });

    it('usa tts_notification_id para não repetir evento', () => {
      expect(c.webhookEventId(JSON.parse(body))).toBe('N1');
      expect(c.webhookEventId({ type: 1 })).toBeNull();
    });

    it('mudança de status do pedido: relê o pedido na API (o corpo não é fonte de verdade)', async () => {
      queue(ok({ orders: [{ id: '5771', status: 'AWAITING_SHIPMENT', payment: { currency: 'BRL', total_amount: '10' }, line_items: [{ product_id: '1', sku_id: '2', sale_price: '10' }] }] }));
      const r = await c.processNotification(ctx, { eventType: null, payload: JSON.parse(body) });
      expect(call(0).url.searchParams.get('ids')).toBe('5771');
      expect(r.ok && r.data.orders!.map((o) => [o.externalId, o.status])).toEqual([['5771', 'paid']]);
      expect(await c.processNotification(ctx, { eventType: null, payload: { type: 1, data: {} } })).toMatchObject({ ok: false, code: 'VALIDATION' });
    });

    it('desautorização do vendedor derruba a conexão; outros eventos não fazem nada', async () => {
      expect(await c.processNotification(ctx, { eventType: null, payload: { type: 6, shop_id: '1' } })).toMatchObject({ ok: false, code: 'AUTH' });
      expect(await c.processNotification(ctx, { eventType: null, payload: { type: 5 } })).toEqual({ ok: true, data: { handled: false } });
      expect(await c.processNotification(ctx, { eventType: null, payload: { type: 7 } })).toEqual({ ok: true, data: { handled: true } });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('sem App Key/Secret nenhuma chamada sai', async () => {
    delete process.env.TIKTOK_APP_KEY;
    expect(await c.validateConnection(ctx)).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' });
    expect(await c.fetchOrders(ctx, {})).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
