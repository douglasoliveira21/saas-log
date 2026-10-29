import { createHmac, timingSafeEqual } from 'node:crypto';

// Interface comum dos conectores de marketplace. Nenhum método pode fingir sucesso: o que o provedor ou a
// implementação não oferece retorna um estado explícito (UNSUPPORTED / NOT_IMPLEMENTED / NOT_CONFIGURED).

export type ErrorCode =
  | 'UNSUPPORTED' // o provedor não oferece esta operação
  | 'NOT_IMPLEMENTED' // o provedor oferece, mas este conector ainda não implementa
  | 'NOT_CONFIGURED' // faltam credenciais do aplicativo/conta
  | 'AUTH' // token inválido/expirado/revogado
  | 'RATE_LIMIT'
  | 'UNAVAILABLE' // indisponibilidade/timeout do provedor (reexecutável)
  | 'VALIDATION' // dados recusados pelo provedor (corrigir antes de repetir)
  | 'ERROR';

export type OpResult<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; message: string; retryAfterMs?: number };

export const okResult = <T>(data: T): OpResult<T> => ({ ok: true, data });
export const fail = (code: ErrorCode, message: string, retryAfterMs?: number): OpResult<never> => ({ ok: false, code, message, retryAfterMs });

/** Códigos que valem nova tentativa automática. */
export const RETRYABLE: ErrorCode[] = ['UNAVAILABLE', 'RATE_LIMIT'];

/**
 * SUPPORTED = implementado e validado contra o canal real.
 * IMPLEMENTED_UNVERIFIED = implementado conforme a documentação, testado só com respostas simuladas (falta conta real).
 * PLANNED = prevista no provedor, ainda não implementada. UNSUPPORTED = o canal não oferece.
 */
export type Support = 'SUPPORTED' | 'IMPLEMENTED_UNVERIFIED' | 'PLANNED' | 'UNSUPPORTED';

export interface CapabilityMatrix {
  authorization: Support;
  orders: Support;
  catalog: Support;
  publishing: Support;
  price: Support;
  inventory: Support;
  shipments: Support;
  webhooks: Support;
}

export interface ConnectorInfo {
  provider: string;
  displayName: string;
  docsUrl: string;
  authType: 'OAUTH2' | 'API_KEY' | 'SIGNED_OAUTH2';
  /** Agrupamento na galeria de canais (padrão: MARKETPLACE). */
  category?: 'MARKETPLACE' | 'STORE_PLATFORM' | 'HUB';
  region?: 'BR' | 'GLOBAL';
  /** Verdadeiro somente para o conector de testes. */
  sandbox?: boolean;
  notes?: string;
  /** Domínios (sufixos) de onde as fotos do canal podem ser baixadas na importação. Vazio = não baixa fotos. */
  imageHosts?: string[];
  /** Canais com autorização própria (sem tela de redirecionamento): campos que o usuário informa. `secret` = campo de senha. */
  credentialFields?: { name: string; label: string; secret?: boolean; hint?: string }[];
}

export interface ConnectionContext {
  connectionId: string;
  tenantId: string;
  credentials: Record<string, unknown> | null;
  config: Record<string, unknown>;
  externalAccountId: string | null;
}

export interface Credentials {
  credentials: Record<string, unknown>;
  expiresAt?: Date;
  externalAccountId?: string;
}

export interface ExternalOrderItem {
  externalItemId: string;
  sku?: string | null;
  title?: string;
  quantity: number;
  unitPrice: number;
}

/** Pedido normalizado de um canal. O campo status usa o vocabulário do canal; o importador decide o que fazer. */
export interface ExternalOrder {
  externalId: string;
  status: string;
  createdAt?: string;
  total?: number;
  buyer?: { id: string; nickname?: string; name?: string };
  items?: ExternalOrderItem[];
  raw?: unknown;
}

/** Produto/anúncio normalizado de um canal (leitura). Campos ausentes no canal ficam indefinidos — nada é inventado. */
export interface ExternalProduct {
  externalId: string;
  title: string;
  description?: string;
  sku?: string | null;
  gtin?: string | null;
  brand?: string | null;
  model?: string | null;
  price?: number;
  quantity?: number;
  condition?: 'NEW' | 'USED' | 'REFURBISHED';
  status?: string;
  permalink?: string;
  categoryId?: string;
  pictures?: string[];
  attributes?: { name: string; value: string }[];
  raw?: unknown;
}

/** Anúncio a publicar, montado a partir do cadastro do produto (o mesmo conteúdo para qualquer canal; cada conector converte). */
export interface ItemDraft {
  sku: string;
  title: string;
  description: string;
  price: number;
  quantity: number;
  condition: 'NEW' | 'USED' | 'REFURBISHED';
  brand?: string;
  model?: string;
  gtin?: string;
  mpn?: string;
  warrantyMonths?: number;
  /** Categoria do canal (vem do mapeamento da categoria interna). */
  categoryId?: string;
  attributes: { name: string; value: string }[];
  /** URLs públicas temporárias das fotos, na ordem (a primeira é a principal). */
  pictures: { url: string; width: number; height: number }[];
  weightG?: number;
  heightMm?: number;
  widthMm?: number;
  lengthMm?: number;
  /** Configuração do canal na conexão (ex.: tipo de anúncio). */
  channelConfig?: Record<string, unknown>;
}

export interface Connector {
  readonly info: ConnectorInfo;
  getCapabilities(): CapabilityMatrix;

  // autorização
  authorizeConnection(ctx: ConnectionContext, p: { redirectUri: string; state: string }): Promise<OpResult<{ authorizationUrl: string }>>;
  completeAuthorization(ctx: ConnectionContext, p: { code: string; redirectUri: string; state: string }): Promise<OpResult<Credentials>>;
  /** Autorização própria (opcional): confere as credenciais informadas pelo usuário e devolve o que será guardado cifrado. */
  authorizeWithCredentials?(ctx: ConnectionContext, fields: Record<string, string>): Promise<OpResult<Credentials>>;
  validateConnection(ctx: ConnectionContext): Promise<OpResult<{ externalAccountId?: string }>>;
  refreshAuthorization(ctx: ConnectionContext): Promise<OpResult<Credentials>>;
  revokeAuthorization(ctx: ConnectionContext): Promise<OpResult<null>>;

  // dados
  fetchOrders(ctx: ConnectionContext, p: { since?: Date; cursor?: string }): Promise<OpResult<{ orders: ExternalOrder[]; nextCursor?: string }>>;
  fetchProducts(ctx: ConnectionContext, p: { cursor?: string }): Promise<OpResult<{ products: ExternalProduct[]; nextCursor?: string }>>;
  /** Um anúncio completo (inclui a descrição, que muitos canais só entregam por chamada separada). */
  fetchProductDetail(ctx: ConnectionContext, p: { externalId: string }): Promise<OpResult<ExternalProduct>>;
  /** Regras do canal que dá para checar ANTES de publicar (sem chamar o canal). Devolve os problemas encontrados. */
  validateDraft?(draft: ItemDraft): string[];
  publishProduct(ctx: ConnectionContext, p: { productId: string; payload: unknown; idempotencyKey: string }): Promise<OpResult<{ externalId: string; permalink?: string }>>;
  updateProduct(ctx: ConnectionContext, p: { externalId: string; payload: unknown }): Promise<OpResult<null>>;
  updatePrice(ctx: ConnectionContext, p: { externalId: string; price: number }): Promise<OpResult<null>>;
  updateInventory(ctx: ConnectionContext, p: { externalId: string; quantity: number }): Promise<OpResult<null>>;
  cancelListing(ctx: ConnectionContext, p: { externalId: string }): Promise<OpResult<null>>;
  getShipment(ctx: ConnectionContext, p: { externalOrderId: string }): Promise<OpResult<unknown>>;

  // notificações
  verifyWebhook(p: { rawBody: Buffer; headers: Record<string, string | string[] | undefined>; secret: string }): boolean;
  webhookEventId(payload: unknown, headers: Record<string, string | string[] | undefined>): string | null;
  processNotification(ctx: ConnectionContext, p: { eventType: string | null; payload: unknown }): Promise<OpResult<{ handled: boolean; orders?: ExternalOrder[] }>>;
}

/**
 * Base que declara tudo como não implementado. Conectores reais herdam e sobrescrevem SOMENTE o que foi
 * implementado e testado contra a documentação oficial vigente — o restante continua devolvendo NOT_IMPLEMENTED.
 */
export abstract class BaseConnector implements Connector {
  abstract readonly info: ConnectorInfo;
  abstract getCapabilities(): CapabilityMatrix;

  protected notImplemented(op: string): OpResult<never> {
    return fail('NOT_IMPLEMENTED', `${this.info.displayName}: a operação "${op}" ainda não foi implementada neste conector.`);
  }

  authorizeConnection(_c: ConnectionContext, _p: { redirectUri: string; state: string }): Promise<OpResult<{ authorizationUrl: string }>> { return Promise.resolve(this.notImplemented('authorizeConnection')); }
  completeAuthorization(_c: ConnectionContext, _p: { code: string; redirectUri: string; state: string }): Promise<OpResult<Credentials>> { return Promise.resolve(this.notImplemented('completeAuthorization')); }
  validateConnection(_c: ConnectionContext): Promise<OpResult<{ externalAccountId?: string }>> { return Promise.resolve(this.notImplemented('validateConnection')); }
  refreshAuthorization(_c: ConnectionContext): Promise<OpResult<Credentials>> { return Promise.resolve(this.notImplemented('refreshAuthorization')); }
  revokeAuthorization(_c: ConnectionContext): Promise<OpResult<null>> { return Promise.resolve(this.notImplemented('revokeAuthorization')); }
  fetchOrders(_c: ConnectionContext, _p: { since?: Date; cursor?: string }): Promise<OpResult<{ orders: ExternalOrder[]; nextCursor?: string }>> { return Promise.resolve(this.notImplemented('fetchOrders')); }
  fetchProducts(_c: ConnectionContext, _p: { cursor?: string }): Promise<OpResult<{ products: ExternalProduct[]; nextCursor?: string }>> { return Promise.resolve(this.notImplemented('fetchProducts')); }
  fetchProductDetail(_c: ConnectionContext, _p: { externalId: string }): Promise<OpResult<ExternalProduct>> { return Promise.resolve(this.notImplemented('fetchProductDetail')); }
  publishProduct(_c: ConnectionContext, _p: { productId: string; payload: unknown; idempotencyKey: string }): Promise<OpResult<{ externalId: string; permalink?: string }>> { return Promise.resolve(this.notImplemented('publishProduct')); }
  updateProduct(_c: ConnectionContext, _p: { externalId: string; payload: unknown }): Promise<OpResult<null>> { return Promise.resolve(this.notImplemented('updateProduct')); }
  updatePrice(_c: ConnectionContext, _p: { externalId: string; price: number }): Promise<OpResult<null>> { return Promise.resolve(this.notImplemented('updatePrice')); }
  updateInventory(_c: ConnectionContext, _p: { externalId: string; quantity: number }): Promise<OpResult<null>> { return Promise.resolve(this.notImplemented('updateInventory')); }
  cancelListing(_c: ConnectionContext, _p: { externalId: string }): Promise<OpResult<null>> { return Promise.resolve(this.notImplemented('cancelListing')); }
  getShipment(_c: ConnectionContext, _p: { externalOrderId: string }): Promise<OpResult<unknown>> { return Promise.resolve(this.notImplemented('getShipment')); }
  processNotification(_c: ConnectionContext, _p: { eventType: string | null; payload: unknown }): Promise<OpResult<{ handled: boolean; orders?: ExternalOrder[] }>> { return Promise.resolve(this.notImplemented('processNotification')); }

  /** Padrão genérico (HMAC-SHA256 do corpo com o segredo do webhook). Cada provedor pode definir o seu esquema oficial. */
  verifyWebhook(p: { rawBody: Buffer; headers: Record<string, string | string[] | undefined>; secret: string }): boolean {
    return verifyHmacSignature(p.rawBody, p.headers['x-dh-signature'], p.secret);
  }
  webhookEventId(_payload: unknown, _headers: Record<string, string | string[] | undefined>): string | null { return null; }
}


export function verifyHmacSignature(rawBody: Buffer, header: string | string[] | undefined, secret: string): boolean {
  const given = Array.isArray(header) ? header[0] : header;
  if (!given || !secret) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
