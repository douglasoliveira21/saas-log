import { assertWithinPlan } from '../billing/limits';
import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConnectionStatus, MarketplaceConnection, Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/auth';
import { getConfig } from '../config/app.config';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectionContext, Connector, ErrorCode, fail, OpResult } from './connector';
import { CryptoService, redactSecrets } from './crypto.service';
import { JobQueue } from './job-queue';
import { ConnectorRegistry } from './providers';

type Tx = Prisma.TransactionClient;

export interface ConnectionConfig {
  orderImport?: boolean;
  stockSync?: boolean;
  priceSync?: boolean;
  safetyStock?: number;
  maxPublished?: number | null;
  reconcileMinutes?: number;
  initialImportDays?: number;
  cancellationPolicy?: 'RELEASE_RESERVATION' | 'MANUAL_REVIEW';
  sandbox?: Record<string, unknown>;
}

const HTTP_BY_CODE: Record<ErrorCode, HttpStatus> = {
  UNSUPPORTED: HttpStatus.NOT_IMPLEMENTED, NOT_IMPLEMENTED: HttpStatus.NOT_IMPLEMENTED, NOT_CONFIGURED: HttpStatus.FAILED_DEPENDENCY,
  AUTH: HttpStatus.FAILED_DEPENDENCY, // nunca 401: o navegador interpretaria como sessão do ERP expirada
  RATE_LIMIT: HttpStatus.TOO_MANY_REQUESTS, UNAVAILABLE: HttpStatus.BAD_GATEWAY, VALIDATION: HttpStatus.BAD_REQUEST, ERROR: HttpStatus.BAD_GATEWAY,
};

const FRIENDLY: Partial<Record<ErrorCode, string>> = {
  AUTH: 'A autorização com o canal é inválida ou expirou. Reconecte a conta.',
  NOT_IMPLEMENTED: 'Este conector ainda não está disponível nesta versão do sistema.',
  UNSUPPORTED: 'O canal não oferece esta operação.',
  UNAVAILABLE: 'O canal está indisponível no momento. Tente novamente em alguns minutos.',
  RATE_LIMIT: 'O canal limitou as requisições. Aguarde e tente novamente.',
};

export function throwFor(r: Extract<OpResult<unknown>, { ok: false }>): never {
  const detail = redactSecrets(r.message);
  throw new HttpException({ message: FRIENDLY[r.code] ? `${FRIENDLY[r.code]} (${detail})` : detail, code: r.code, retryAfterMs: r.retryAfterMs }, HTTP_BY_CODE[r.code]);
}

/** Estado "estável" quando a conexão não está ativa/pausada, calculado a partir de credenciais, teste e configuração. */
export function settledStatus(c: Pick<MarketplaceConnection, 'credentialsEnc' | 'testedAt' | 'warehouseId'>): ConnectionStatus {
  if (!c.credentialsEnc) return 'NOT_CONNECTED';
  if (!c.testedAt) return 'TEST_PENDING';
  if (!c.warehouseId) return 'INCOMPLETE_CONFIG';
  return 'CONNECTED';
}

const SAFE = {
  id: true, provider: true, label: true, status: true, externalAccountId: true, warehouseId: true, config: true, tokenExpiresAt: true, testedAt: true,
  lastSyncAt: true, lastError: true, createdAt: true, updatedAt: true,
} as const;

@Injectable()
export class ConnectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly registry: ConnectorRegistry,
    private readonly queue: JobQueue,
    private readonly jwt: JwtService,
  ) {}

  providers() {
    return this.registry.list().map((c) => ({ ...c.info, category: c.info.category ?? 'MARKETPLACE', region: c.info.region ?? 'BR', capabilities: c.getCapabilities() }));
  }

  private connector(provider: string): Connector {
    const c = this.registry.get(provider);
    if (!c) throw new BadRequestException('Canal desconhecido ou indisponível neste ambiente.');
    return c;
  }

  // ───────────── cadastro e leitura ─────────────

  list(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const rows = await tx.marketplaceConnection.findMany({ where: { tenantId: ctx.tenantId! }, select: SAFE, orderBy: { createdAt: 'asc' } });
      const jobs = await tx.backgroundJob.groupBy({ by: ['connectionId', 'status'], where: { tenantId: ctx.tenantId!, status: { in: ['FAILED', 'DEAD', 'QUEUED'] } }, _count: true });
      return rows.map((r) => ({
        ...r,
        failedJobs: jobs.filter((j) => j.connectionId === r.id && (j.status === 'FAILED' || j.status === 'DEAD')).reduce((s, j) => s + j._count, 0),
        queuedJobs: jobs.filter((j) => j.connectionId === r.id && j.status === 'QUEUED').reduce((s, j) => s + j._count, 0),
      }));
    });
  }

  async create(ctx: AuthContext, dto: { provider: string; label: string }) {
    this.connector(dto.provider);
    const secret = randomBytes(24).toString('base64url');
    return this.prisma.withContext(ctx, async (tx) => {
      await assertWithinPlan(tx, ctx.tenantId!, 'connections');
      const id = crypto.randomUUID();
      const row = await tx.marketplaceConnection.create({
        data: {
          id, tenantId: ctx.tenantId!, provider: dto.provider, label: dto.label.trim(), createdById: ctx.userId,
          webhookSecretEnc: this.crypto.encrypt(ctx.tenantId!, `webhook:${id}`, { secret }),
        },
        select: SAFE,
      });
      await this.audit.record(tx, ctx, { action: 'integration.created', entity: 'marketplace_connection', entityId: id, metadata: { provider: dto.provider, label: dto.label } });
      // O segredo do webhook é mostrado UMA vez; depois só é possível gerar outro.
      return { ...row, webhook: { path: `/api/webhooks/${ctx.tenantId}/${id}`, secret, signatureHeader: 'x-dh-signature: sha256=<HMAC-SHA256 do corpo>' } };
    });
  }

  async rotateWebhookSecret(ctx: AuthContext, id: string) {
    const secret = randomBytes(24).toString('base64url');
    return this.prisma.withContext(ctx, async (tx) => {
      await this.load(tx, ctx, id);
      await tx.marketplaceConnection.update({ where: { id }, data: { webhookSecretEnc: this.crypto.encrypt(ctx.tenantId!, `webhook:${id}`, { secret }) } });
      await this.audit.record(tx, ctx, { action: 'integration.webhook_secret_rotated', entity: 'marketplace_connection', entityId: id });
      return { path: `/api/webhooks/${ctx.tenantId}/${id}`, secret };
    });
  }

  get(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const c = await tx.marketplaceConnection.findFirst({ where: { id, tenantId: ctx.tenantId! }, select: SAFE });
      if (!c) throw new NotFoundException('Conexão não encontrada.');
      return c;
    });
  }

  /** Painel de monitoramento da conexão. */
  overview(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const c = await tx.marketplaceConnection.findFirst({ where: { id, tenantId: ctx.tenantId! }, select: SAFE });
      if (!c) throw new NotFoundException('Conexão não encontrada.');
      const since = new Date(Date.now() - 24 * 3600_000);
      const [jobs, hooks, logs, durations, nextJob, recentFailures] = await Promise.all([
        tx.backgroundJob.groupBy({ by: ['status'], where: { tenantId: ctx.tenantId!, connectionId: id }, _count: true }),
        tx.webhookEvent.groupBy({ by: ['status'], where: { tenantId: ctx.tenantId!, connectionId: id }, _count: true }),
        tx.integrationLog.groupBy({ by: ['level'], where: { tenantId: ctx.tenantId!, connectionId: id, createdAt: { gte: since } }, _count: true }),
        tx.integrationLog.aggregate({ where: { tenantId: ctx.tenantId!, connectionId: id, createdAt: { gte: since }, durationMs: { not: null } }, _avg: { durationMs: true }, _max: { durationMs: true } }),
        tx.backgroundJob.findFirst({ where: { tenantId: ctx.tenantId!, connectionId: id, status: 'QUEUED' }, orderBy: { runAt: 'asc' }, select: { runAt: true, type: true } }),
        tx.backgroundJob.findMany({ where: { tenantId: ctx.tenantId!, connectionId: id, status: { in: ['FAILED', 'DEAD'] } }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, type: true, status: true, lastError: true, attempts: true } }),
      ]);
      const count = <T extends { _count: number }>(rows: (T & { status?: string; level?: string })[], key: 'status' | 'level') => Object.fromEntries(rows.map((r) => [r[key], r._count]));
      const tokenSoon = c.tokenExpiresAt && c.tokenExpiresAt.getTime() - Date.now() < 24 * 3600_000;
      return {
        connection: c,
        jobs: count(jobs, 'status'), webhooks: count(hooks, 'status'), logs24h: count(logs, 'level'),
        responseMs: { avg: Math.round(durations._avg.durationMs ?? 0), max: durations._max.durationMs ?? 0 },
        nextScheduled: nextJob, recentFailures,
        attention: [
          ...(c.status === 'TOKEN_EXPIRED' ? ['Autorização expirada: reconecte a conta.'] : []),
          ...(tokenSoon && c.status !== 'TOKEN_EXPIRED' ? ['O token expira em menos de 24h.'] : []),
          ...(c.status === 'SYNC_ERROR' ? [`Erro de sincronização: ${c.lastError ?? 'ver logs'}`] : []),
          ...((hooks.find((h) => h.status === 'RECEIVED')?._count ?? 0) > 0 ? ['Há notificações recebidas aguardando processamento.'] : []),
        ],
      };
    });
  }

  logs(ctx: AuthContext, q: { connectionId?: string; level?: string; limit?: number }) {
    return this.prisma.withContext(ctx, async (tx) => {
      const rows = await tx.integrationLog.findMany({
        where: { tenantId: ctx.tenantId!, ...(q.connectionId ? { connectionId: q.connectionId } : {}), ...(q.level ? { level: q.level } : {}) },
        orderBy: { id: 'desc' }, take: q.limit ?? 100,
      });
      return rows.map((r) => ({ ...r, id: r.id.toString() }));
    });
  }

  // ───────────── configuração ─────────────

  updateConfig(ctx: AuthContext, id: string, dto: ConnectionConfig & { warehouseId?: string }) {
    return this.prisma.withContext(ctx, async (tx) => {
      const c = await this.load(tx, ctx, id);
      // Campos ausentes chegam como `undefined` (propriedades de classe): se entrassem no merge apagariam a configuração salva.
      const { warehouseId, ...provided } = dto;
      const rest = Object.fromEntries(Object.entries(provided).filter(([, v]) => v !== undefined)) as ConnectionConfig;
      if (rest.sandbox && c.provider !== 'SANDBOX') throw new BadRequestException('Opção disponível apenas no conector Sandbox.');
      if (warehouseId && !(await tx.warehouse.findFirst({ where: { id: warehouseId, tenantId: ctx.tenantId!, active: true } }))) throw new BadRequestException('Depósito inválido ou inativo.');
      const config = { ...(c.config as ConnectionConfig), ...rest };
      const next: Prisma.MarketplaceConnectionUncheckedUpdateInput = { config: config as Prisma.InputJsonValue };
      if (warehouseId) next.warehouseId = warehouseId;
      const merged = { ...c, warehouseId: warehouseId ?? c.warehouseId };
      if (!['ACTIVE', 'PAUSED', 'AWAITING_AUTHORIZATION', 'TOKEN_EXPIRED', 'DISCONNECTED', 'SYNC_ERROR'].includes(c.status)) next.status = settledStatus(merged);
      const row = await tx.marketplaceConnection.update({ where: { id }, data: next, select: SAFE });
      await this.audit.record(tx, ctx, { action: 'integration.configured', entity: 'marketplace_connection', entityId: id, metadata: { fields: Object.keys(dto) } });
      return row;
    });
  }

  // ───────────── autorização ─────────────

  async authorize(ctx: AuthContext, id: string) {
    const conn = await this.get(ctx, id);
    if (['ACTIVE', 'PAUSED'].includes(conn.status)) throw new ConflictException('Pause a conexão antes de reautorizar.');
    const connector = this.connector(conn.provider);
    const nonce = randomBytes(16).toString('hex');
    const redirectUri = `${getConfig().webOrigin}/api/integrations/callback`;
    const state = await this.jwt.signAsync({ purpose: 'oauth', tid: ctx.tenantId, cid: id, uid: ctx.userId, nonce }, { expiresIn: 600 });
    const r = await connector.authorizeConnection(this.context(ctx.tenantId!, conn as unknown as MarketplaceConnection, null), { redirectUri, state });
    await this.writeLog(ctx.tenantId!, id, 'authorizeConnection', r, 0);
    if (!r.ok) throwFor(r);
    await this.prisma.withContext(ctx, async (tx) => {
      await tx.marketplaceConnection.update({ where: { id }, data: { status: 'AWAITING_AUTHORIZATION', oauthNonce: nonce } });
      await this.audit.record(tx, ctx, { action: 'integration.authorization_started', entity: 'marketplace_connection', entityId: id });
    });
    return { authorizationUrl: r.data.authorizationUrl };
  }

  /**
   * Autorização própria (ex.: Amazon): o usuário informa as credenciais do aplicativo dele; o conector as confere no canal e guardamos
   * cifradas. Nada volta ao navegador. A conexão fica "teste pendente" e segue o fluxo normal (testar e ativar).
   */
  async saveCredentials(ctx: AuthContext, id: string, fields: Record<string, string>) {
    const conn = await this.get(ctx, id);
    if (['ACTIVE', 'PAUSED'].includes(conn.status)) throw new ConflictException('Pause a conexão antes de trocar as credenciais.');
    const connector = this.connector(conn.provider);
    if (!connector.authorizeWithCredentials) throw new BadRequestException('Este canal usa autorização por login, não por credenciais.');
    const started = Date.now();
    const r = await connector.authorizeWithCredentials(this.context(ctx.tenantId!, conn as unknown as MarketplaceConnection, null), fields);
    await this.writeLog(ctx.tenantId!, id, 'authorizeWithCredentials', r, Date.now() - started);
    if (!r.ok) throwFor(r);
    try {
      await this.prisma.withContext(ctx, async (tx) => {
        await tx.marketplaceConnection.update({
          where: { id },
          data: { credentialsEnc: this.crypto.encrypt(ctx.tenantId!, `cred:${id}`, r.data.credentials), tokenExpiresAt: r.data.expiresAt ?? null, externalAccountId: r.data.externalAccountId ?? conn.externalAccountId, testedAt: null, lastError: null, status: 'TEST_PENDING' },
        });
        await this.audit.record(tx, ctx, { action: 'integration.authorized', entity: 'marketplace_connection', entityId: id, metadata: { provider: conn.provider, mode: 'credentials' } });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('Esta conta do canal já está conectada em outra conexão desta empresa. Desconecte a outra conexão antes.');
      throw e;
    }
    return { id, status: 'TEST_PENDING' };
  }

  /** Retorno do provedor (rota pública protegida por `state` assinado, expirável e de uso único). */
  async callback(code: string, state: string): Promise<{ connectionId: string }> {
    let p: { purpose: string; tid: string; cid: string; uid: string; nonce: string };
    try {
      p = await this.jwt.verifyAsync(state);
    } catch {
      throw new BadRequestException('Autorização expirada ou inválida. Inicie a conexão novamente.');
    }
    if (p.purpose !== 'oauth') throw new BadRequestException('Autorização inválida.');
    const ctx = { tenantId: p.tid, userId: p.uid };
    const conn = await this.prisma.withContext(ctx, (tx) => tx.marketplaceConnection.findFirst({ where: { id: p.cid, tenantId: p.tid } }));
    if (!conn || conn.status !== 'AWAITING_AUTHORIZATION' || conn.oauthNonce !== p.nonce) throw new BadRequestException('Autorização já utilizada ou inválida. Inicie a conexão novamente.');
    const connector = this.connector(conn.provider);
    const redirectUri = `${getConfig().webOrigin}/api/integrations/callback`;
    const started = Date.now();
    const r = await connector.completeAuthorization(this.context(p.tid, conn, null), { code, redirectUri, state });
    await this.writeLog(p.tid, conn.id, 'completeAuthorization', r, Date.now() - started);
    if (!r.ok) {
      await this.prisma.withContext(ctx, (tx) => tx.marketplaceConnection.update({ where: { id: conn.id }, data: { status: settledStatus(conn), oauthNonce: null, lastError: redactSecrets(r.message) } }));
      throwFor(r);
    }
    try {
    await this.prisma.withContext(ctx, async (tx) => {
      await tx.marketplaceConnection.update({
        where: { id: conn.id },
        data: {
          credentialsEnc: this.crypto.encrypt(p.tid, `cred:${conn.id}`, r.data.credentials), tokenExpiresAt: r.data.expiresAt ?? null,
          externalAccountId: r.data.externalAccountId ?? conn.externalAccountId, oauthNonce: null, testedAt: null, lastError: null, status: 'TEST_PENDING',
        },
      });
      await this.audit.record(tx, ctx, { action: 'integration.authorized', entity: 'marketplace_connection', entityId: conn.id, metadata: { provider: conn.provider } });
    });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        await this.prisma.withContext(ctx, (tx) => tx.marketplaceConnection.update({ where: { id: conn.id }, data: { status: settledStatus(conn), oauthNonce: null } }));
        throw new ConflictException('Esta conta do canal já está conectada em outra conexão desta empresa. Desconecte a outra conexão antes.');
      }
      throw e;
    }
    return { connectionId: conn.id };
  }

  async test(ctx: AuthContext, id: string) {
    const conn = await this.get(ctx, id);
    const r = await this.call(ctx.tenantId!, id, 'validateConnection', (c, cc) => c.validateConnection(cc), { allowAnyStatus: true });
    if (!r.ok) throwFor(r);
    await this.prisma.withContext(ctx, async (tx) => {
      const cur = await this.load(tx, ctx, id);
      const data: Prisma.MarketplaceConnectionUncheckedUpdateInput = { testedAt: new Date(), lastError: null, externalAccountId: r.data.externalAccountId ?? cur.externalAccountId };
      if (!['ACTIVE', 'PAUSED'].includes(cur.status)) data.status = settledStatus({ ...cur, testedAt: new Date() });
      await tx.marketplaceConnection.update({ where: { id }, data });
      await this.audit.record(tx, ctx, { action: 'integration.tested', entity: 'marketplace_connection', entityId: id });
    });
    return this.get(ctx, conn.id);
  }

  /** Ativa (ou retoma) a sincronização somente quando todas as pré-condições estão satisfeitas. */
  activate(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const c = await this.load(tx, ctx, id);
      if (!['NOT_CONNECTED', 'TEST_PENDING', 'INCOMPLETE_CONFIG', 'CONNECTED', 'PAUSED', 'SYNC_ERROR'].includes(c.status)) {
        throw new ConflictException(c.status === 'TOKEN_EXPIRED' ? 'A autorização expirou: reautorize a conta antes de ativar.' : `Não é possível ativar uma conexão "${c.status}".`);
      }
      const missing: string[] = [];
      if (!c.credentialsEnc) missing.push('autorizar a conta no canal');
      if (!c.testedAt) missing.push('executar o teste de conexão com sucesso');
      if (!c.warehouseId) missing.push('definir o depósito de origem');
      if (missing.length) throw new ConflictException({ message: `Pendências para ativar: ${missing.join('; ')}.`, missing });
      await tx.marketplaceConnection.update({ where: { id }, data: { status: 'ACTIVE', lastError: null } });
      // Notificações recebidas enquanto estava pausada voltam à fila.
      const pending = await tx.webhookEvent.findMany({ where: { tenantId: ctx.tenantId!, connectionId: id, status: 'RECEIVED' }, select: { id: true } });
      for (const ev of pending) await this.queue.enqueue(tx, ctx.tenantId!, { type: 'webhook.process', connectionId: id, payload: { eventId: ev.id }, idempotencyKey: `wh:${ev.id}:resume:${Date.now()}` });
      await this.audit.record(tx, ctx, { action: 'integration.activated', entity: 'marketplace_connection', entityId: id, metadata: { resumedWebhooks: pending.length } });
      return { id, status: 'ACTIVE' as const, resumedWebhooks: pending.length };
    });
  }

  pause(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const c = await this.load(tx, ctx, id);
      if (!['ACTIVE', 'SYNC_ERROR'].includes(c.status)) throw new ConflictException('Somente conexões ativas podem ser pausadas.');
      await tx.marketplaceConnection.update({ where: { id }, data: { status: 'PAUSED' } });
      const cancelled = await this.queue.cancelQueued(tx, ctx.tenantId!, id);
      await this.audit.record(tx, ctx, { action: 'integration.paused', entity: 'marketplace_connection', entityId: id, metadata: { cancelledJobs: cancelled } });
      return { id, status: 'PAUSED' as const, cancelledJobs: cancelled };
    });
  }

  /** Revoga a autorização quando o conector permitir, apaga as credenciais e encerra as tarefas. O histórico permanece. */
  async disconnect(ctx: AuthContext, id: string) {
    const conn = await this.get(ctx, id);
    if (conn.status === 'DISCONNECTED') throw new ConflictException('A conexão já está desconectada.');
    let revoked: 'REVOKED' | 'NOT_SUPPORTED' | 'FAILED' | 'NO_CREDENTIALS' = 'NO_CREDENTIALS';
    if (conn.status !== 'NOT_CONNECTED') {
      const r = await this.call(ctx.tenantId!, id, 'revokeAuthorization', (c, cc) => c.revokeAuthorization(cc), { allowAnyStatus: true });
      revoked = r.ok ? 'REVOKED' : r.code === 'NOT_IMPLEMENTED' || r.code === 'UNSUPPORTED' ? 'NOT_SUPPORTED' : 'FAILED';
    }
    return this.prisma.withContext(ctx, async (tx) => {
      await tx.marketplaceConnection.update({ where: { id }, data: { status: 'DISCONNECTED', credentialsEnc: null, tokenExpiresAt: null, oauthNonce: null, testedAt: null, externalAccountId: null, config: { ...(conn.config as object), lastExternalAccountId: conn.externalAccountId } as Prisma.InputJsonValue } });
      const cancelled = await this.queue.cancelQueued(tx, ctx.tenantId!, id);
      await this.audit.record(tx, ctx, { action: 'integration.disconnected', entity: 'marketplace_connection', entityId: id, metadata: { revoked, cancelledJobs: cancelled } });
      return { id, status: 'DISCONNECTED' as const, revoked, cancelledJobs: cancelled };
    });
  }

  // ───────────── gateway usado pelo worker e pelas rotas ─────────────

  async statusOf(tenantId: string, id: string): Promise<ConnectionStatus | null> {
    return this.prisma.withContext({ tenantId }, async (tx) => (await tx.marketplaceConnection.findFirst({ where: { id, tenantId }, select: { status: true } }))?.status ?? null);
  }

  async lastSync(tenantId: string, id: string): Promise<Date | null> {
    return this.prisma.withContext({ tenantId }, async (tx) => (await tx.marketplaceConnection.findFirst({ where: { id, tenantId }, select: { lastSyncAt: true } }))?.lastSyncAt ?? null);
  }

  async configOf(tenantId: string, id: string): Promise<Record<string, unknown>> {
    return this.prisma.withContext({ tenantId }, async (tx) => ((await tx.marketplaceConnection.findFirst({ where: { id, tenantId }, select: { config: true } }))?.config as Record<string, unknown>) ?? {});
  }

  async touchSync(tenantId: string, id: string, at?: Date) {
    await this.prisma.withContext({ tenantId }, (tx) =>
      tx.marketplaceConnection.updateMany({ where: { id, tenantId }, data: { lastSyncAt: at ?? new Date(), lastError: null } }),
    );
    // Recuperação automática: sucesso após SYNC_ERROR volta a ACTIVE.
    await this.prisma.withContext({ tenantId }, (tx) => tx.marketplaceConnection.updateMany({ where: { id, tenantId, status: 'SYNC_ERROR' }, data: { status: 'ACTIVE' } }));
  }

  async markSyncError(tenantId: string, id: string, message: string) {
    await this.prisma.withContext({ tenantId }, (tx) =>
      tx.marketplaceConnection.updateMany({ where: { id, tenantId, status: 'ACTIVE' }, data: { status: 'SYNC_ERROR', lastError: redactSecrets(message).slice(0, 500) } }),
    );
  }

  async refreshCredentials(tenantId: string, id: string): Promise<OpResult<null>> {
    const r = await this.call(tenantId, id, 'refreshAuthorization', (c, cc) => c.refreshAuthorization(cc));
    if (!r.ok) return r;
    await this.prisma.withContext({ tenantId }, (tx) =>
      tx.marketplaceConnection.update({ where: { id }, data: { credentialsEnc: this.crypto.encrypt(tenantId, `cred:${id}`, r.data.credentials), tokenExpiresAt: r.data.expiresAt ?? null } }),
    );
    return { ok: true, data: null };
  }

  /**
   * Única porta para chamar o provedor: carrega e decifra credenciais numa transação curta, chama o conector SEM transação
   * aberta, e registra log (com segredos removidos) e efeitos de estado numa segunda transação.
   */
  async call<T>(
    tenantId: string, id: string, operation: string, fn: (c: Connector, ctx: ConnectionContext) => Promise<OpResult<T>>, opts: { allowAnyStatus?: boolean } = {},
  ): Promise<OpResult<T>> {
    const conn = await this.prisma.withContext({ tenantId }, (tx) => tx.marketplaceConnection.findFirst({ where: { id, tenantId } }));
    if (!conn) return fail('ERROR', 'Conexão não encontrada.');
    if (!opts.allowAnyStatus && ['DISCONNECTED', 'NOT_CONNECTED', 'AWAITING_AUTHORIZATION'].includes(conn.status)) return fail('NOT_CONFIGURED', `Conexão "${conn.status}" não pode chamar o canal.`);
    const connector = this.registry.get(conn.provider);
    if (!connector) return fail('NOT_CONFIGURED', 'Conector indisponível neste ambiente.');
    let creds: Record<string, unknown> | null = null;
    if (conn.credentialsEnc) {
      try {
        creds = this.crypto.decrypt(tenantId, `cred:${id}`, conn.credentialsEnc);
      } catch (e) {
        return fail('NOT_CONFIGURED', (e as Error).message);
      }
    }
    const started = Date.now();
    let result: OpResult<T>;
    try {
      result = await fn(connector, this.context(tenantId, conn, creds));
    } catch (e) {
      result = fail('UNAVAILABLE', `Falha de comunicação: ${(e as Error).message}`);
    }
    const ms = Date.now() - started;
    await this.writeLog(tenantId, id, operation, result, ms);
    if (!result.ok && result.code === 'AUTH' && ['ACTIVE', 'SYNC_ERROR', 'CONNECTED', 'TEST_PENDING', 'INCOMPLETE_CONFIG'].includes(conn.status)) {
      await this.prisma.withContext({ tenantId }, (tx) => tx.marketplaceConnection.update({ where: { id }, data: { status: 'TOKEN_EXPIRED', lastError: redactSecrets(result.ok ? '' : result.message).slice(0, 500) } }));
    }
    return result;
  }

  // ───────────── internos ─────────────

  private context(tenantId: string, c: Pick<MarketplaceConnection, 'id' | 'config' | 'externalAccountId'>, credentials: Record<string, unknown> | null): ConnectionContext {
    return { connectionId: c.id, tenantId, credentials, config: (c.config as Record<string, unknown>) ?? {}, externalAccountId: c.externalAccountId };
  }

  private async load(tx: Tx, ctx: Pick<AuthContext, 'tenantId'>, id: string) {
    const c = await tx.marketplaceConnection.findFirst({ where: { id, tenantId: ctx.tenantId! } });
    if (!c) throw new NotFoundException('Conexão não encontrada.');
    return c;
  }

  async writeLog(tenantId: string, connectionId: string, operation: string, r: OpResult<unknown>, durationMs: number) {
    await this.prisma.withContext({ tenantId }, (tx) =>
      tx.integrationLog.create({
        data: {
          tenantId, connectionId, operation, durationMs,
          level: r.ok ? 'info' : r.code === 'NOT_IMPLEMENTED' || r.code === 'UNSUPPORTED' ? 'warn' : 'error',
          message: r.ok ? 'ok' : redactSecrets(`${r.code}: ${r.message}`).slice(0, 1000),
          metadata: r.ok ? {} : ({ code: r.code, retryAfterMs: r.retryAfterMs ?? null } as Prisma.InputJsonValue),
        },
      }),
    );
  }
}
