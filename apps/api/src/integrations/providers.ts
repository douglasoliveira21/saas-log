import { Injectable } from '@nestjs/common';
import { getConfig } from '../config/app.config';
import { PLANNED_CHANNELS, PlannedConnector } from './catalog';
import { MercadoLivreConnector } from './mercado-livre.connector';
import {
  BaseConnector, CapabilityMatrix, ConnectionContext, Connector, ConnectorInfo, Credentials, ExternalOrder, ExternalProduct, ItemDraft, fail, OpResult, okResult,
} from './connector';

/** Opções de comportamento do conector de testes, lidas de `config.sandbox`. */
export interface SandboxBehavior {
  validate?: 'ok' | 'auth' | 'unavailable';
  fetchOrders?: 'ok' | 'unavailable' | 'ratelimit' | 'auth' | 'validation';
  notify?: 'ok' | 'error' | 'unavailable';
  refresh?: 'ok' | 'auth';
  push?: 'ok' | 'unavailable' | 'validation' | 'ratelimit';
}

/**
 * Conector SANDBOX: existe apenas para exercitar a infraestrutura (filas, retentativas, idempotência, webhooks) em testes
 * automatizados. Só é registrado com ENABLE_SANDBOX_CONNECTOR=true fora de produção e é rotulado como sandbox na API.
 * Não representa nenhum marketplace real.
 */
export class SandboxConnector extends BaseConnector {
  static created = new Map<string, string>();
  static creations = 0;
  static calls: string[] = [];
  static pushed: { op: string; externalId: string; value: number }[] = [];
  static published: { externalId: string; draft: ItemDraft }[] = [];

  readonly info: ConnectorInfo = { provider: 'SANDBOX', displayName: 'Sandbox (somente testes)', authType: 'OAUTH2', docsUrl: '', sandbox: true, notes: 'Não é um marketplace real.', imageHosts: ['127.0.0.1'] };
  getCapabilities(): CapabilityMatrix {
    return { authorization: 'SUPPORTED', orders: 'SUPPORTED', catalog: 'SUPPORTED', publishing: 'SUPPORTED', price: 'SUPPORTED', inventory: 'SUPPORTED', shipments: 'UNSUPPORTED', webhooks: 'SUPPORTED' };
  }
  private b(ctx: ConnectionContext): SandboxBehavior {
    return (ctx.config.sandbox as SandboxBehavior | undefined) ?? {};
  }
  private track(op: string) { SandboxConnector.calls.push(op); }

  authorizeConnection(ctx: ConnectionContext, p: { redirectUri: string; state: string }): Promise<OpResult<{ authorizationUrl: string }>> {
    return Promise.resolve(okResult({ authorizationUrl: `${p.redirectUri}?code=sandbox-code&state=${encodeURIComponent(p.state)}` }));
  }
  completeAuthorization(ctx: ConnectionContext, p: { code: string }): Promise<OpResult<Credentials>> {
    if (p.code !== 'sandbox-code') return Promise.resolve(fail('AUTH', 'Código de autorização inválido.'));
    return Promise.resolve(okResult({ credentials: { accessToken: `sbx-access-${Math.random().toString(36).slice(2)}`, refreshToken: 'sbx-refresh-secret' }, expiresAt: new Date(Date.now() + 3600_000), externalAccountId: `sbx-${ctx.connectionId.slice(0, 8)}` }));
  }
  validateConnection(ctx: ConnectionContext): Promise<OpResult<{ externalAccountId?: string }>> {
    this.track('validate');
    const m = this.b(ctx).validate ?? 'ok';
    if (m === 'auth') return Promise.resolve(fail('AUTH', 'Token inválido (access_token=sbx-secret-123).'));
    if (m === 'unavailable') return Promise.resolve(fail('UNAVAILABLE', 'Provedor indisponível.'));
    return Promise.resolve(okResult({ externalAccountId: ctx.externalAccountId ?? `sbx-${ctx.connectionId.slice(0, 8)}` }));
  }
  refreshAuthorization(ctx: ConnectionContext): Promise<OpResult<Credentials>> {
    this.track('refresh');
    if (this.b(ctx).refresh === 'auth') return Promise.resolve(fail('AUTH', 'Refresh token revogado.'));
    return Promise.resolve(okResult({ credentials: { accessToken: `sbx-access-${Math.random().toString(36).slice(2)}`, refreshToken: 'sbx-refresh-secret' }, expiresAt: new Date(Date.now() + 3600_000) }));
  }
  revokeAuthorization(): Promise<OpResult<null>> { this.track('revoke'); return Promise.resolve(okResult(null)); }
  fetchOrders(ctx: ConnectionContext): Promise<OpResult<{ orders: ExternalOrder[]; nextCursor?: string }>> {
    this.track('fetchOrders');
    switch (this.b(ctx).fetchOrders ?? 'ok') {
      case 'unavailable': return Promise.resolve(fail('UNAVAILABLE', 'Timeout ao consultar pedidos.'));
      case 'ratelimit': return Promise.resolve(fail('RATE_LIMIT', 'Limite de requisições atingido.', 30_000));
      case 'auth': return Promise.resolve(fail('AUTH', 'Token expirado.'));
      case 'validation': return Promise.resolve(fail('VALIDATION', 'Parâmetro inválido.'));
      default: return Promise.resolve(okResult({ orders: [{ externalId: 'SBX-1', status: 'paid', total: 10 }, { externalId: 'SBX-2', status: 'paid', total: 20 }] }));
    }
  }
  /** Catálogo simulado do canal: `config.sandbox.catalog` (lista de ExternalProduct), paginado de `pageSize` em `pageSize`. */
  fetchProducts(ctx: ConnectionContext, p: { cursor?: string }): Promise<OpResult<{ products: ExternalProduct[]; nextCursor?: string }>> {
    this.track('fetchProducts');
    const cfg = this.b(ctx) as SandboxBehavior & { catalog?: ExternalProduct[]; pageSize?: number; catalogError?: 'unavailable' };
    if (cfg.catalogError === 'unavailable') return Promise.resolve(fail('UNAVAILABLE', 'Catálogo indisponível.'));
    const all = cfg.catalog ?? [];
    const size = cfg.pageSize ?? 2;
    const start = Number(p.cursor ?? 0) || 0;
    const slice = all.slice(start, start + size).map((x) => ({ ...x, description: undefined }));
    return Promise.resolve(okResult({ products: slice, nextCursor: start + size < all.length ? String(start + size) : undefined }));
  }
  fetchProductDetail(ctx: ConnectionContext, p: { externalId: string }): Promise<OpResult<ExternalProduct>> {
    this.track('fetchProductDetail');
    const found = ((this.b(ctx) as { catalog?: ExternalProduct[] }).catalog ?? []).find((x) => x.externalId === p.externalId);
    return Promise.resolve(found ? okResult(found) : fail('VALIDATION', 'Anúncio não encontrado no canal.'));
  }
  validateDraft(draft: ItemDraft): string[] { return draft.title.length > 60 ? ['Sandbox: título acima de 60 caracteres.'] : []; }
  publishProduct(ctx: ConnectionContext, p: { idempotencyKey: string; payload?: unknown }): Promise<OpResult<{ externalId: string; permalink?: string }>> {
    this.track('publish');
    const mode = (this.b(ctx) as { publish?: 'unavailable' | 'validation' }).publish;
    if (mode === 'unavailable') return Promise.resolve(fail('UNAVAILABLE', 'Timeout ao publicar.'));
    if (mode === 'validation') return Promise.resolve(fail('VALIDATION', 'O canal recusou o anúncio: categoria inválida.'));
    const existing = SandboxConnector.created.get(p.idempotencyKey);
    if (existing) return Promise.resolve(okResult({ externalId: existing, permalink: `https://sandbox.invalid/${existing}` }));
    const id = `SBX-L-${++SandboxConnector.creations}`;
    SandboxConnector.created.set(p.idempotencyKey, id);
    SandboxConnector.published.push({ externalId: id, draft: p.payload as ItemDraft });
    return Promise.resolve(okResult({ externalId: id, permalink: `https://sandbox.invalid/${id}` }));
  }
  private push(ctx: ConnectionContext, op: string, externalId: string, value: number): Promise<OpResult<null>> {
    this.track(op);
    switch (this.b(ctx).push ?? 'ok') {
      case 'unavailable': return Promise.resolve(fail('UNAVAILABLE', 'Canal indisponível ao atualizar.'));
      case 'ratelimit': return Promise.resolve(fail('RATE_LIMIT', 'Limite de requisições.', 20_000));
      case 'validation': return Promise.resolve(fail('VALIDATION', 'Anúncio recusou o valor informado.'));
      default: SandboxConnector.pushed.push({ op, externalId, value }); return Promise.resolve(okResult(null));
    }
  }
  updateInventory(ctx: ConnectionContext, p: { externalId: string; quantity: number }): Promise<OpResult<null>> { return this.push(ctx, 'updateInventory', p.externalId, p.quantity); }
  updatePrice(ctx: ConnectionContext, p: { externalId: string; price: number }): Promise<OpResult<null>> { return this.push(ctx, 'updatePrice', p.externalId, p.price); }

  processNotification(ctx: ConnectionContext, p: { payload: unknown }): Promise<OpResult<{ handled: boolean; orders?: ExternalOrder[] }>> {
    this.track('notify');
    const m = this.b(ctx).notify ?? 'ok';
    if (m === 'error') return Promise.resolve(fail('VALIDATION', 'Notificação malformada.'));
    if (m === 'unavailable') return Promise.resolve(fail('UNAVAILABLE', 'Falha temporária.'));
    return Promise.resolve(okResult({ handled: !!p.payload }));
  }
  webhookEventId(payload: unknown): string | null {
    const id = (payload as { id?: unknown } | null)?.id;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
  }
}

@Injectable()
export class ConnectorRegistry {
  private readonly map = new Map<string, Connector>();

  constructor() {
    for (const c of [new MercadoLivreConnector(), ...PLANNED_CHANNELS.map((i) => new PlannedConnector(i))]) this.map.set(c.info.provider, c);
    if (getConfig().sandboxConnector) this.map.set('SANDBOX', new SandboxConnector());
  }

  get(provider: string): Connector | undefined { return this.map.get(provider); }
  list(): Connector[] { return [...this.map.values()]; }
}
