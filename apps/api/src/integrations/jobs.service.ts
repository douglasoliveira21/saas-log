import { ConflictException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { JobStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/auth';
import { getConfig } from '../config/app.config';
import { PrismaService } from '../prisma/prisma.service';
import { redactSecrets } from './crypto.service';
import { ConnectionsService } from './connections.service';
import { OpResult, RETRYABLE } from './connector';
import { JobQueue } from './job-queue';
import { ChannelCatalogService } from './channel-catalog.service';
import { ImportSummary, OrderImportService } from './order-import.service';

type Tx = Prisma.TransactionClient;

interface ClaimedJob {
  id: string; tenant_id: string; connection_id: string | null; type: string; payload: Record<string, unknown>;
  attempts: number; max_attempts: number;
}

type HandlerOutcome = { ok: true; result?: Record<string, unknown> } | { ok: false; retryable: boolean; message: string; retryAfterMs?: number };

interface HandlerDef {
  /** Operações automáticas são canceladas quando a conexão é pausada. */
  automatic: boolean;
  /** Repetir não duplica nada no provedor. Jobs "inseguros" exigem confirmação explícita para reprocessar. */
  safeToRetry: boolean;
  run(job: ClaimedJob): Promise<HandlerOutcome>;
}

const fromOp = (r: OpResult<unknown>): HandlerOutcome =>
  r.ok ? { ok: true } : { ok: false, retryable: RETRYABLE.includes(r.code), message: `${r.code}: ${r.message}`, retryAfterMs: r.retryAfterMs };

@Injectable()
export class JobWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(JobWorker.name);
  private readonly workerId = `w-${process.pid}-${randomUUID().slice(0, 6)}`;
  private timers: NodeJS.Timeout[] = [];
  private running = false;
  private readonly handlers = new Map<string, HandlerDef>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: JobQueue,
    private readonly connections: ConnectionsService,
    private readonly audit: AuditService,
    private readonly importer: OrderImportService,
    private readonly channels: ChannelCatalogService,
  ) {
    this.register('connection.reconcile', { automatic: true, safeToRetry: true, run: (j) => this.reconcile(j) });
    this.register('channel.sync', { automatic: true, safeToRetry: true, run: (j) => this.channels.sync(j.tenant_id, j.connection_id!) });
    this.register('token.refresh', { automatic: true, safeToRetry: true, run: (j) => this.refreshToken(j) });
    this.register('webhook.process', { automatic: true, safeToRetry: true, run: (j) => this.processWebhook(j) });
  }

  /** Permite que módulos registrem novos tipos de job (Fase 5: importação de pedidos, sync de estoque/preço). */
  register(type: string, def: HandlerDef) { this.handlers.set(type, def); }

  onApplicationBootstrap() {
    if (!getConfig().workerEnabled) return;
    this.timers.push(setInterval(() => void this.runOnce().catch((e) => this.log.error(e)), 2000));
    this.timers.push(setInterval(() => void this.schedule().catch((e) => this.log.error(e)), 30_000));
    this.log.log(`Worker ${this.workerId} iniciado`);
  }

  onModuleDestroy() {
    this.timers.forEach(clearInterval);
  }

  /** Reivindica e processa até `limit` jobs prontos. Retorna quantos foram processados. */
  async runOnce(limit = 10): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const jobs = await this.prisma.$queryRaw<ClaimedJob[]>`SELECT id, tenant_id, connection_id, type, payload, attempts, max_attempts FROM claim_background_jobs(${limit}::int, ${this.workerId})`;
      for (const job of jobs) await this.process(job);
      return jobs.length;
    } finally {
      this.running = false;
    }
  }

  /** Reconciliação periódica: não depende de webhooks, recupera eventos perdidos. */
  async schedule(now = new Date()): Promise<number> {
    const conns = await this.prisma.$queryRaw<{ tenant_id: string; id: string; config: Record<string, unknown>; token_expires_at: Date | null }[]>`SELECT tenant_id, id, config, token_expires_at FROM list_active_connections()`;
    let n = 0;
    for (const c of conns) {
      const every = Math.max(5, Number(c.config.reconcileMinutes ?? 15)) * 60_000;
      const bucket = Math.floor(now.getTime() / every);
      await this.prisma.withContext({ tenantId: c.tenant_id }, async (tx) => {
        if (c.config.orderImport !== false) {
          if ((await this.queue.enqueue(tx, c.tenant_id, { type: 'connection.reconcile', connectionId: c.id, idempotencyKey: `reconcile:${c.id}:${bucket}` })).created) n++;
        }
        if (c.config.stockSync === true || c.config.priceSync === true) {
          if ((await this.queue.enqueue(tx, c.tenant_id, { type: 'channel.sync', connectionId: c.id, idempotencyKey: `sync:${c.id}:${bucket}` })).created) n++;
        }
        if (c.token_expires_at && c.token_expires_at.getTime() - now.getTime() < 10 * 60_000) {
          if ((await this.queue.enqueue(tx, c.tenant_id, { type: 'token.refresh', connectionId: c.id, idempotencyKey: `refresh:${c.id}:${c.token_expires_at.getTime()}` })).created) n++;
        }
      });
    }
    return n;
  }

  static backoffMs(attempt: number): number {
    const base = Number(process.env.JOB_BACKOFF_BASE_MS ?? 30_000);
    const exp = Math.min(base * 2 ** (attempt - 1), 30 * 60_000);
    return Math.round(exp * (0.8 + Math.random() * 0.4));
  }

  private async process(job: ClaimedJob) {
    const tenant = { tenantId: job.tenant_id };
    const finish = (data: Prisma.BackgroundJobUpdateInput) => this.prisma.withContext(tenant, (tx) => tx.backgroundJob.update({ where: { id: job.id }, data: { lockedAt: null, lockedBy: null, ...data } }));
    try {
      const handler = this.handlers.get(job.type);
      if (!handler) return void (await finish({ status: 'FAILED', lastError: `Tipo de job desconhecido: ${job.type}`, finishedAt: new Date() }));
      if (job.attempts > job.max_attempts) return void (await finish({ status: 'DEAD', lastError: 'Excedeu as tentativas (worker interrompido repetidamente).', finishedAt: new Date() }));

      if (job.connection_id) {
        const state = await this.connections.statusOf(job.tenant_id, job.connection_id);
        if (!state || state === 'DISCONNECTED') return void (await finish({ status: 'CANCELLED', lastError: 'Conexão inexistente ou desconectada.', finishedAt: new Date() }));
        if (state === 'PAUSED' && handler.automatic) return void (await finish({ status: 'CANCELLED', lastError: 'Conexão pausada.', finishedAt: new Date() }));
      }

      let outcome: HandlerOutcome;
      try {
        outcome = await handler.run(job);
      } catch (e) {
        outcome = { ok: false, retryable: true, message: `Erro inesperado: ${(e as Error).message}` };
      }

      if (outcome.ok) return void (await finish({ status: 'SUCCEEDED', result: (outcome.result ?? {}) as Prisma.InputJsonValue, lastError: null, finishedAt: new Date() }));

      const message = redactSecrets(outcome.message).slice(0, 1000);
      if (outcome.retryable && job.attempts < job.max_attempts) {
        const delay = outcome.retryAfterMs ?? JobWorker.backoffMs(job.attempts);
        await finish({ status: 'QUEUED', runAt: new Date(Date.now() + delay), lastError: message });
        return;
      }
      const status: JobStatus = outcome.retryable ? 'DEAD' : 'FAILED';
      await finish({ status, lastError: message, finishedAt: new Date() });
      if (job.type === 'webhook.process') {
        await this.prisma.withContext(tenant, (tx) => tx.webhookEvent.updateMany({ where: { id: String(job.payload.eventId), tenantId: job.tenant_id }, data: { status: 'FAILED', error: message } }));
      }
      // Só falhas sistêmicas (tentativas esgotadas) colocam a conexão em erro; uma notificação inválida isolada não derruba o canal.
      if (job.connection_id && status === 'DEAD') await this.connections.markSyncError(job.tenant_id, job.connection_id, message);
    } catch (e) {
      this.log.error(`Falha ao finalizar job ${job.id}: ${(e as Error).message}`);
    }
  }

  // ───────────── handlers ─────────────

  private async reconcile(job: ClaimedJob): Promise<HandlerOutcome> {
    const { tenant_id: tenantId, connection_id: connectionId } = job;
    const last = await this.connections.lastSync(tenantId, connectionId!);
    const days = Math.max(1, Number((await this.connections.configOf(tenantId, connectionId!)).initialImportDays ?? 7));
    // Janela com sobreposição de 10 min: a importação é idempotente, então reler pedidos recentes é seguro.
    const since = last ? new Date(last.getTime() - 10 * 60_000) : new Date(Date.now() - days * 86_400_000);
    const total: ImportSummary & { fetched: number } = { fetched: 0, imported: 0, cancelled: 0, awaitingPayment: 0, needsAttention: 0, unchanged: 0 };
    let cursor: string | undefined;
    let pages = 0;
    let watermark = 0;
    do {
      const r = await this.connections.call(tenantId, connectionId!, 'fetchOrders', (c, ctx) => c.fetchOrders(ctx, { since, cursor }));
      if (!r.ok) {
        if (r.code === 'NOT_IMPLEMENTED' || r.code === 'UNSUPPORTED') return { ok: true, result: { skipped: r.code } };
        return fromOp(r);
      }
      const s = await this.importer.importOrders(tenantId, connectionId!, r.data.orders);
      for (const k of Object.keys(s) as (keyof ImportSummary)[]) total[k] += s[k];
      total.fetched += r.data.orders.length;
      for (const o of r.data.orders) if (o.createdAt) watermark = Math.max(watermark, new Date(o.createdAt).getTime());
      cursor = r.data.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    // Se houve mais páginas do que o limite por execução, avança só até o último pedido lido (a próxima execução continua dali).
    await this.connections.touchSync(tenantId, connectionId!, cursor && watermark ? new Date(watermark) : undefined);
    return { ok: true, result: { ...total, truncated: !!cursor } };
  }

  private async refreshToken(job: ClaimedJob): Promise<HandlerOutcome> {
    const r = await this.connections.refreshCredentials(job.tenant_id, job.connection_id!);
    return fromOp(r);
  }

  private async processWebhook(job: ClaimedJob): Promise<HandlerOutcome> {
    const eventId = String(job.payload.eventId);
    const tenant = { tenantId: job.tenant_id };
    const ev = await this.prisma.withContext(tenant, (tx) => tx.webhookEvent.findFirst({ where: { id: eventId, tenantId: job.tenant_id } }));
    if (!ev) return { ok: false, retryable: false, message: 'Evento não encontrado.' };
    if (ev.status === 'PROCESSED' || ev.status === 'IGNORED') return { ok: true, result: { skipped: 'already ' + ev.status } }; // reentrega: sem reprocessar
    const r = await this.connections.call(job.tenant_id, ev.connectionId, 'processNotification', (c, ctx) => c.processNotification(ctx, { eventType: ev.eventType, payload: ev.payload }));
    if (!r.ok) {
      if (r.code === 'NOT_IMPLEMENTED' || r.code === 'UNSUPPORTED') {
        await this.prisma.withContext(tenant, (tx) => tx.webhookEvent.update({ where: { id: ev.id }, data: { status: 'IGNORED', processedAt: new Date(), error: r.message } }));
        return { ok: true, result: { ignored: r.code } };
      }
      return fromOp(r);
    }
    const imported = r.data.orders?.length ? await this.importer.importOrders(job.tenant_id, ev.connectionId, r.data.orders) : null;
    await this.prisma.withContext(tenant, (tx) => tx.webhookEvent.update({ where: { id: ev.id }, data: { status: r.data.handled ? 'PROCESSED' : 'IGNORED', processedAt: new Date(), error: null } }));
    return { ok: true, result: { handled: r.data.handled, ...(imported ? { import: imported } : {}) } };
  }

  // ───────────── operação manual ─────────────

  list(ctx: AuthContext, q: { connectionId?: string; status?: JobStatus; limit?: number }) {
    return this.prisma.withContext(ctx, (tx) =>
      tx.backgroundJob.findMany({
        where: { tenantId: ctx.tenantId!, ...(q.connectionId ? { connectionId: q.connectionId } : {}), ...(q.status ? { status: q.status } : {}) },
        orderBy: { createdAt: 'desc' }, take: q.limit ?? 50,
        select: { id: true, type: true, connectionId: true, status: true, attempts: true, maxAttempts: true, runAt: true, lastError: true, result: true, createdAt: true, finishedAt: true },
      }),
    );
  }

  /** Reprocessa um job que falhou depois da causa ser corrigida. Tipos não idempotentes exigem confirmação. */
  retry(ctx: AuthContext, id: string, confirm: boolean) {
    return this.prisma.withContext(ctx, async (tx) => {
      const job = await tx.backgroundJob.findFirst({ where: { id, tenantId: ctx.tenantId! } });
      if (!job) throw new NotFoundException('Job não encontrado.');
      if (job.status !== 'FAILED' && job.status !== 'DEAD') throw new ConflictException(`Só jobs com falha podem ser reprocessados (situação atual: ${job.status}).`);
      const def = this.handlers.get(job.type);
      if (def && !def.safeToRetry && !confirm) {
        throw new ConflictException('Este tipo de operação pode duplicar dados no canal se repetido. Confirme explicitamente após verificar o resultado no marketplace.');
      }
      await tx.backgroundJob.update({ where: { id }, data: { status: 'QUEUED', attempts: 0, runAt: new Date(), lastError: null, finishedAt: null } });
      if (job.type === 'webhook.process') {
        await tx.webhookEvent.updateMany({ where: { id: String(( job.payload as { eventId?: string }).eventId), tenantId: ctx.tenantId! }, data: { status: 'RECEIVED', error: null } });
      }
      await this.audit.record(tx, ctx, { action: 'integration.job_retried', entity: 'background_job', entityId: id, metadata: { type: job.type, confirm } });
      return { id, status: 'QUEUED' as const };
    });
  }
}

