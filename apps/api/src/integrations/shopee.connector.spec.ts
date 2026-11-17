import { createHmac } from 'node:crypto';
import { ConnectionContext } from './connector';
import { normalizeShopeeOrder, ShopeeConnector } from './shopee.connector';

const ctx: ConnectionContext = { tenantId: 'tenant', connectionId: 'connection', externalAccountId: '234',
  config: {}, credentials: { accessToken: 'access-secret', refreshToken: 'refresh-secret', shopId: '234' } };
const item = { item_id: 100, item_name: 'Chocolate', item_sku: 'PAI', has_model: true, item_status: 'NORMAL',
  price_info: [{ currency: 'BRL', original_price: 10 }], image: { image_url_list: ['https://down-br.img.susercontent.com/file/photo'] } };
const summary = { stock_info_v2: { summary_info: { total_available_stock: 9 } } };

describe('Shopee Open Platform v2', () => {
  const connector = new ShopeeConnector();
  let fetchMock: jest.SpyInstance;
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.SHOPEE_PARTNER_ID = '123';
    process.env.SHOPEE_PARTNER_KEY = 'partner-secret';
    process.env.SHOPEE_SANDBOX = 'false';
    fetchMock = jest.spyOn(global, 'fetch');
  });
  afterEach(() => {
    fetchMock.mockRestore();
    for (const name of ['SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY', 'SHOPEE_SANDBOX']) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  });
  const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const queued = (...values: unknown[]) => values.forEach((value) => fetchMock.mockResolvedValueOnce(reply(value)));
  const requestUrl = (index = 0) => new URL(String(fetchMock.mock.calls[index][0]));

  it('gera autorização BR com state e callback e informa configuração ausente', async () => {
    const result = await connector.authorizeConnection(ctx, { redirectUri: 'https://log.vgon.com.br/api/integrations/callback', state: 'signed-state' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const url = new URL(result.data.authorizationUrl);
    expect(url.origin).toBe('https://open.shopee.com.br');
    expect(url.searchParams.get('state')).toBe('signed-state');
    expect(url.searchParams.get('auth_type')).toBe('seller');
    expect(url.searchParams.get('redirect_uri')).toBe('https://log.vgon.com.br/api/integrations/callback');
    delete process.env.SHOPEE_PARTNER_KEY;
    expect(await connector.authorizeConnection(ctx, { redirectUri: '', state: '' })).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' });
  });

  it('assina a troca de código e a renovação sem incluir access_token na assinatura pública', async () => {
    queued({ access_token: 'new-access', refresh_token: 'new-refresh', expire_in: 14400, shop_id_list: [234] },
      { access_token: 'rotated-access', refresh_token: 'rotated-refresh', expire_in: 14400, shop_id: 234 });
    expect(await connector.completeAuthorization(ctx, { code: 'one-use-code', shopId: '234' })).toMatchObject({
      ok: true, data: { credentials: { accessToken: 'new-access', refreshToken: 'new-refresh', shopId: '234' }, externalAccountId: '234' },
    });
    const url = requestUrl();
    const expected = createHmac('sha256', 'partner-secret').update('123/api/v2/auth/token/get' + url.searchParams.get('timestamp')).digest('hex');
    expect(url.searchParams.get('sign')).toBe(expected);
    expect(url.searchParams.has('access_token')).toBe(false);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ partner_id: 123, shop_id: 234, code: 'one-use-code' });
    expect(await connector.refreshAuthorization(ctx)).toMatchObject({ ok: true, data: { credentials: { refreshToken: 'rotated-refresh' } } });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ partner_id: 123, shop_id: 234, refresh_token: 'refresh-secret' });
    expect(await connector.completeAuthorization(ctx, { code: 'x' })).toMatchObject({ ok: false, code: 'VALIDATION' });
  });

  it('valida loja sem presumir shop_id na resposta e assina chamadas da loja', async () => {
    queued({ shop_name: 'Geber', region: 'BR', status: 'NORMAL' });
    expect(await connector.validateConnection(ctx)).toEqual({ ok: true, data: { externalAccountId: '234' } });
    const url = requestUrl();
    expect(url.searchParams.get('sign')).toBe(createHmac('sha256', 'partner-secret')
      .update('123/api/v2/shop/get_shop_info' + url.searchParams.get('timestamp') + 'access-secret234').digest('hex'));
  });

  it('trata HTTP 200 com erro, limite, resposta inválida e recusa parcial sem expor segredos', async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: 'common.error_auth', message: 'access-secret partner-secret' }));
    const result = await connector.validateConnection(ctx);
    expect(result).toMatchObject({ ok: false, code: 'AUTH' });
    expect(JSON.stringify(result)).not.toContain('access-secret');
    fetchMock.mockResolvedValueOnce(reply({}, 429));
    expect(await connector.validateConnection(ctx)).toMatchObject({ ok: false, code: 'RATE_LIMIT', retryAfterMs: 60000 });
    fetchMock.mockResolvedValueOnce(new Response('<html>erro</html>'));
    expect(await connector.validateConnection(ctx)).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
    queued({ response: { success_list: [], failure_list: [{ model_id: 7, failed_reason: 'refused' }] } });
    expect(await connector.updatePrice(ctx, { externalId: '100:7', price: 12 })).toMatchObject({ ok: false, code: 'VALIDATION' });
  });

  it('pagina por atualização em janelas menores que 15 dias, preservando a janela no cursor', async () => {
    queued({ response: { more: true, next_cursor: 'page2', order_list: [{ order_sn: 'ORDER1' }] } },
      { response: { order_list: [{ order_sn: 'ORDER1', order_status: 'READY_TO_SHIP', currency: 'BRL', create_time: 1700000000,
        buyer_user_id: 1234, item_list: [{ item_id: 100, model_id: 7, model_sku: 'SKU7', model_quantity_purchased: 2, model_discounted_price: 12 }] }] } },
      { response: { more: false, order_list: [] } });
    const first = await connector.fetchOrders(ctx, { since: new Date(Date.now() - 30 * 86_400_000) });
    expect(first).toMatchObject({ ok: true, data: { orders: [{ status: 'paid', items: [{ externalItemId: '100:7', sku: 'SKU7', unitPrice: 12 }] }] } });
    if (!first.ok) return;
    const url = requestUrl();
    expect(url.searchParams.get('time_range_field')).toBe('update_time');
    expect(Number(url.searchParams.get('time_to')) - Number(url.searchParams.get('time_from'))).toBe(14 * 86_400);
    const second = await connector.fetchOrders(ctx, { cursor: first.data.nextCursor });
    expect(requestUrl(2).searchParams.get('cursor')).toBe('page2');
    expect(second.ok && second.data.nextCursor && JSON.parse(second.data.nextCursor).from).toBe(Number(url.searchParams.get('time_to')));
  });

  it('preserva estados de pagamento e cancelamento e não usa o SKU pai para uma variação sem SKU', () => {
    expect(normalizeShopeeOrder({ order_sn: 'X', order_status: 'IN_CANCEL' }).status).toBe('in_cancel');
    expect(normalizeShopeeOrder({ order_sn: 'X', order_status: 'CANCELLED' }).status).toBe('cancelled');
    expect(normalizeShopeeOrder({ order_sn: 'X', order_status: 'UNPAID' }).status).toBe('unpaid');
    expect(normalizeShopeeOrder({ order_sn: 'X', item_list: [{ item_id: 100, model_id: 7, item_sku: 'PAI' }] }).items?.[0].sku).toBeUndefined();
  });

  it('importa catálogo com IDs e SKUs de cada variação e mantém fotos e quantidade', async () => {
    queued({ response: { item: [{ item_id: 100 }], has_next_page: true, next_offset: 50 } },
      { response: { item_list: [item] } },
      { response: { tier_variation: [{ option_list: [{ option: 'Branco' }, { option: 'Preto' }] }],
        model: [{ model_id: 7, model_sku: 'SKU7', tier_index: [1], price_info: [{ currency: 'BRL', original_price: 12 }], ...summary }] } });
    const result = await connector.fetchProducts(ctx, {});
    expect(result).toMatchObject({ ok: true, data: { nextCursor: '50', products: [{ externalId: '100:7', title: 'Chocolate — Preto', sku: 'SKU7', price: 12, quantity: 9, pictures: item.image.image_url_list }] } });
    expect(requestUrl().searchParams.getAll('item_status')).toEqual(['NORMAL', 'UNLIST']);
    queued({ response: { item_list: [item] } }, { response: { model: [{ model_id: 7, model_sku: 'SKU7', ...summary }] } });
    expect(await connector.fetchProductDetail(ctx, { externalId: '100:8' })).toMatchObject({ ok: false, code: 'VALIDATION' });
  });

  it('atualiza a variação exata, usa seller_stock e só confirma o modelo aceito', async () => {
    queued({ response: { success_list: [{ model_id: 7 }] } }, { response: { success_list: [{ model_id: 7 }] } });
    expect(await connector.updatePrice(ctx, { externalId: '100:7', price: 12.5 })).toEqual({ ok: true, data: null });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ item_id: 100, price_list: [{ model_id: 7, original_price: 12.5 }] });
    expect(await connector.updateInventory(ctx, { externalId: '100:7', quantity: 9 })).toEqual({ ok: true, data: null });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ item_id: 100, stock_list: [{ model_id: 7, seller_stock: [{ stock: 9 }] }] });
    expect(await connector.updateInventory(ctx, { externalId: '100:7', quantity: 1.5 })).toMatchObject({ ok: false, code: 'VALIDATION' });
    expect(await connector.updatePrice(ctx, { externalId: 'unsafe/id', price: 3 })).toMatchObject({ ok: false, code: 'VALIDATION' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
