import {
  Body, Controller, Delete, HttpException, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query, Req, Res, UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JobStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import type { Request, Response } from 'express';
import { AuthContext, CurrentAuth, Public, RequirePermissions } from '../common/auth';
import { getConfig } from '../config/app.config';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectionsService } from './connections.service';
import { ChannelCatalogService } from './channel-catalog.service';
import { OrderImportService } from './order-import.service';
import { CryptoService, redactSecrets } from './crypto.service';
import { JobQueue } from './job-queue';
import { JobWorker } from './jobs.service';
import { ConnectorRegistry } from './providers';

class CreateConnectionDto {
  @IsString() @IsNotEmpty() @MaxLength(40) provider: string;
  @IsString() @Length(2, 80) label: string;
}
class ConfigDto {
  @IsOptional() @IsUUID() warehouseId?: string;
  @IsOptional() @IsBoolean() orderImport?: boolean;
  @IsOptional() @IsBoolean() stockSync?: boolean;
  @IsOptional() @IsBoolean() priceSync?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) safetyStock?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) maxPublished?: number;
  @IsOptional() @IsInt() @Min(5) @Max(1440) reconcileMinutes?: number;
  @IsOptional() @IsInt() @Min(1) @Max(60) initialImportDays?: number;
  @IsOptional() @IsIn(['RELEASE_RESERVATION', 'MANUAL_REVIEW']) cancellationPolicy?: 'RELEASE_RESERVATION' | 'MANUAL_REVIEW';
  @IsOptional() @IsObject() sandbox?: Record<string, unknown>;
}
class JobsQuery {
  @IsOptional() @IsUUID() connectionId?: string;
  @IsOptional() @IsEnum(JobStatus) status?: JobStatus;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}
class LogsQuery {
  @IsOptional() @IsUUID() connectionId?: string;
  @IsOptional() @IsIn(['info', 'warn', 'error']) level?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}
const money = { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false } as const;
class FeesDto {
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(100) commissionPct: number;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(100) paymentPct: number;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(100) taxPct: number;
  @IsNumber(money) @Min(0) fixedFee: number;
  @IsNumber(money) @Min(0) shippingSubsidy: number;
  @IsNumber(money) @Min(0) packaging: number;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(100) minMarginPct: number;
}
class ListingDto {
  @IsUUID() productId: string;
  @IsOptional() @IsString() @Length(1, 60) externalItemId?: string;
  @IsOptional() @IsString() @MaxLength(200) title?: string;
}
class PriceDto {
  @IsNumber(money) @Min(0.01) price: number;
  @IsString() @Length(3, 300) reason: string;
  @IsOptional() @IsBoolean() confirmLargeChange?: boolean;
}
class CategoryMapDto {
  @IsUUID() categoryId: string;
  @IsString() @Length(1, 60) externalCategoryId: string;
  @IsOptional() @IsString() @MaxLength(200) externalCategoryName?: string;
}
class SimulateDto {
  @IsUUID() productId: string;
  @IsOptional() @IsUUID() connectionId?: string;
  @IsOptional() @IsObject() fees?: Record<string, number>;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsNumber(money, { each: true }) prices?: number[];
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(99) targetMarginPct?: number;
}
class MappingDto {
  @IsString() @Length(1, 60) externalItemId: string;
  @IsUUID() productId: string;
}
class LedgerQuery {
  @IsOptional() @IsIn(['AWAITING_PAYMENT', 'IMPORTED', 'NEEDS_ATTENTION', 'CANCELLED']) status?: string;
}
class RetryDto {
  @IsOptional() @IsBoolean() confirm?: boolean;
}

@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly svc: ConnectionsService,
    private readonly jobs: JobWorker,
    private readonly importer: OrderImportService,
    private readonly catalog: ChannelCatalogService,
  ) {}

  @Get('providers') @RequirePermissions('integrations.view')
  providers() { return this.svc.providers(); }

  @Get('connections') @RequirePermissions('integrations.view')
  list(@CurrentAuth() ctx: AuthContext) { return this.svc.list(ctx); }

  @Post('connections') @RequirePermissions('integrations.manage')
  create(@CurrentAuth() ctx: AuthContext, @Body() dto: CreateConnectionDto) { return this.svc.create(ctx, dto); }

  @Get('connections/:id') @RequirePermissions('integrations.view')
  overview(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.overview(ctx, id); }

  @Put('connections/:id/config') @RequirePermissions('integrations.manage')
  config(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ConfigDto) { return this.svc.updateConfig(ctx, id, dto); }

  @Post('connections/:id/authorize') @HttpCode(200) @RequirePermissions('integrations.manage')
  authorize(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.authorize(ctx, id); }

  @Post('connections/:id/test') @HttpCode(200) @RequirePermissions('integrations.manage')
  test(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.test(ctx, id); }

  @Post('connections/:id/activate') @HttpCode(200) @RequirePermissions('integrations.manage')
  activate(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.activate(ctx, id); }

  @Post('connections/:id/pause') @HttpCode(200) @RequirePermissions('integrations.manage')
  pause(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.pause(ctx, id); }

  @Post('connections/:id/disconnect') @HttpCode(200) @RequirePermissions('integrations.manage')
  disconnect(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.disconnect(ctx, id); }

  @Post('connections/:id/webhook-secret') @HttpCode(200) @RequirePermissions('integrations.manage')
  rotate(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.rotateWebhookSecret(ctx, id); }

  @Get('connections/:id/orders') @RequirePermissions('integrations.view')
  orders(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: LedgerQuery) { return this.importer.listLedger(ctx, id, q.status); }

  @Post('connections/:id/orders/reprocess') @HttpCode(200) @RequirePermissions('integrations.manage')
  reprocessAll(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.importer.reprocess(ctx, id); }

  @Post('connections/:id/orders/:ledgerId/reprocess') @HttpCode(200) @RequirePermissions('integrations.manage')
  reprocessOne(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('ledgerId', ParseUUIDPipe) ledgerId: string) { return this.importer.reprocess(ctx, id, ledgerId); }

  @Post('connections/:id/mappings') @HttpCode(200) @RequirePermissions('integrations.manage')
  mapListing(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MappingDto) { return this.importer.mapListing(ctx, id, dto); }

  // anúncios, preços, categorias e sincronização por canal
  @Get('connections/:id/listings') @RequirePermissions('integrations.view')
  listings(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.catalog.listListings(ctx, id); }

  @Post('connections/:id/listings') @HttpCode(200) @RequirePermissions('integrations.manage')
  saveListing(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ListingDto) { return this.catalog.upsertListing(ctx, id, dto); }

  @Put('connections/:id/listings/:productId/price') @RequirePermissions('pricing.manage')
  setPrice(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('productId', ParseUUIDPipe) pid: string, @Body() dto: PriceDto) { return this.catalog.setPrice(ctx, id, pid, dto); }

  @Get('connections/:id/price-history') @RequirePermissions('pricing.view')
  priceHistory(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query('productId') productId?: string) { return this.catalog.priceHistory(ctx, id, productId); }

  @Get('connections/:id/fees') @RequirePermissions('pricing.view')
  fees(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.catalog.getFees(ctx, id); }

  @Put('connections/:id/fees') @RequirePermissions('pricing.manage')
  setFees(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: FeesDto) { return this.catalog.setFees(ctx, id, dto); }

  @Get('connections/:id/category-map') @RequirePermissions('integrations.view')
  categoryMap(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.catalog.listCategoryMap(ctx, id); }

  @Put('connections/:id/category-map') @RequirePermissions('integrations.manage')
  setCategoryMap(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CategoryMapDto) { return this.catalog.setCategoryMap(ctx, id, dto); }

  @Delete('connections/:id/category-map/:categoryId') @RequirePermissions('integrations.manage')
  removeCategoryMap(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('categoryId', ParseUUIDPipe) cid: string) { return this.catalog.removeCategoryMap(ctx, id, cid); }

  @Post('connections/:id/sync') @HttpCode(200) @RequirePermissions('integrations.manage')
  sync(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.catalog.requestSync(ctx, id); }

  @Post('pricing/simulate') @HttpCode(200) @RequirePermissions('pricing.view')
  simulate(@CurrentAuth() ctx: AuthContext, @Body() dto: SimulateDto) { return this.catalog.simulate(ctx, dto); }

  @Get('jobs') @RequirePermissions('integrations.view')
  listJobs(@CurrentAuth() ctx: AuthContext, @Query() q: JobsQuery) { return this.jobs.list(ctx, q); }

  @Post('jobs/:id/retry') @HttpCode(200) @RequirePermissions('integrations.manage')
  retry(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RetryDto) { return this.jobs.retry(ctx, id, dto.confirm === true); }

  @Get('logs') @RequirePermissions('integrations.view')
  logs(@CurrentAuth() ctx: AuthContext, @Query() q: LogsQuery) { return this.svc.logs(ctx, q); }

  /** Retorno do OAuth: rota pública, protegida pelo `state` assinado/expirável/de uso único. */
  @Public() @Get('callback')
  async callback(@Query('code') code: string | undefined, @Query('state') state: string | undefined, @Res() res: Response) {
    const web = getConfig().webOrigin;
    if (!code || !state) return res.redirect(`${web}/integracoes?error=${encodeURIComponent('Retorno de autorização incompleto.')}`);
    try {
      const r = await this.svc.callback(code, state);
      return res.redirect(`${web}/integracoes?connected=${r.connectionId}`);
    } catch (e) {
      // Só mensagens de erros esperados (HTTP) vão para a URL; falhas internas nunca expõem detalhes.
      const msg = e instanceof HttpException ? redactSecrets(String((e.getResponse() as { message?: string }).message ?? e.message)) : 'Falha ao concluir a autorização. Tente novamente.';
      return res.redirect(`${web}/integracoes?error=${encodeURIComponent(msg.slice(0, 200))}`);
    }
  }
}

/** Recepção de notificações dos marketplaces. Responde rápido e processa de forma assíncrona. */
@Injectable()
export class WebhooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly registry: ConnectorRegistry,
    private readonly queue: JobQueue,
    private readonly connections: ConnectionsService,
  ) {}

  async ingestProvider(provider: string, token: string, rawBody: Buffer, payload: unknown) {
    const expected = process.env[PROVIDER_TOKEN_ENV[provider] ?? ''] ?? '';
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    if (!expected || a.length !== b.length || !timingSafeEqual(a, b)) throw new NotFoundException();
    const connector = this.registry.get(provider);
    const body = payload && typeof payload === 'object' ? payload : { value: payload };
    const account = (body as { user_id?: unknown }).user_id;
    if (!connector || (typeof account !== 'string' && typeof account !== 'number')) return { received: true };
    const targets = await this.prisma.$queryRaw<{ tenant_id: string; id: string; status: string }[]>`SELECT tenant_id, id, status FROM find_connections_by_account(${provider}, ${String(account)})`;
    const dedupeKey = connector.webhookEventId(body, {}) ?? createHash('sha256').update(rawBody).digest('hex');
    const type = (body as { topic?: unknown }).topic;
    for (const t of targets) {
      await this.prisma.withContext({ tenantId: t.tenant_id }, async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO webhook_events (id, tenant_id, connection_id, dedupe_key, event_type, payload)
          VALUES (${randomUUID()}::uuid, ${t.tenant_id}::uuid, ${t.id}::uuid, ${dedupeKey}, ${typeof type === 'string' ? type : null}, ${JSON.stringify(body)}::jsonb)
          ON CONFLICT (connection_id, dedupe_key) DO NOTHING RETURNING id`;
        if (rows.length && (t.status === 'ACTIVE' || t.status === 'SYNC_ERROR')) {
          await this.queue.enqueue(tx, t.tenant_id, { type: 'webhook.process', connectionId: t.id, payload: { eventId: rows[0].id }, idempotencyKey: `wh:${rows[0].id}` });
        }
      });
    }
    return { received: true };
  }

  async ingest(tenantId: string, connectionId: string, rawBody: Buffer, headers: Request['headers'], payload: unknown) {
    const conn = await this.prisma.withContext({ tenantId }, (tx) => tx.marketplaceConnection.findFirst({ where: { id: connectionId, tenantId } }));
    if (!conn || conn.status === 'DISCONNECTED' || !conn.webhookSecretEnc) throw new NotFoundException();
    const connector = this.registry.get(conn.provider);
    if (!connector) throw new NotFoundException();
    const { secret } = this.crypto.decrypt<{ secret: string }>(tenantId, `webhook:${conn.id}`, conn.webhookSecretEnc);
    if (!connector.verifyWebhook({ rawBody, headers, secret })) {
      await this.connections.writeLog(tenantId, conn.id, 'webhook.rejected', { ok: false, code: 'AUTH', message: 'Assinatura inválida.' }, 0);
      throw new UnauthorizedException('Assinatura inválida.');
    }
    const body = payload && typeof payload === 'object' ? payload : { value: payload };
    const dedupeKey = connector.webhookEventId(body, headers) ?? createHash('sha256').update(rawBody).digest('hex');
    const type = (body as { topic?: unknown; type?: unknown }).topic ?? (body as { type?: unknown }).type;
    return this.prisma.withContext({ tenantId }, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO webhook_events (id, tenant_id, connection_id, dedupe_key, event_type, payload)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${conn.id}::uuid, ${dedupeKey}, ${typeof type === 'string' ? type : null}, ${JSON.stringify(body)}::jsonb)
        ON CONFLICT (connection_id, dedupe_key) DO NOTHING RETURNING id`;
      if (!rows.length) return { received: true, duplicate: true };
      // Conexão pausada guarda o evento; ao retomar, ele volta à fila.
      if (conn.status === 'ACTIVE' || conn.status === 'SYNC_ERROR') {
        await this.queue.enqueue(tx, tenantId, { type: 'webhook.process', connectionId: conn.id, payload: { eventId: rows[0].id }, idempotencyKey: `wh:${rows[0].id}` });
      }
      return { received: true, duplicate: false };
    });
  }
}

/**
 * Alguns canais (ex.: Mercado Livre) têm UM endereço de notificação por aplicativo e informam só a conta do vendedor.
 * O token na URL (variável <PROVEDOR>_WEBHOOK_TOKEN) filtra chamadas aleatórias; como o canal pode não assinar o corpo,
 * o conteúdo NUNCA é confiável: o conector só usa o recurso indicado e relê os dados na API com o token do vendedor.
 */
const PROVIDER_TOKEN_ENV: Record<string, string> = { MERCADO_LIVRE: 'ML_WEBHOOK_TOKEN' };

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly svc: WebhooksService) {}

  @Public() @Throttle({ default: { limit: 600, ttl: 60_000 } }) @HttpCode(200)
  @Post('providers/:provider/:token')
  receiveProvider(@Param('provider') provider: string, @Param('token') token: string, @Req() req: Request & { rawBody?: Buffer }, @Body() body: unknown) {
    return this.svc.ingestProvider(provider.toUpperCase(), token, req.rawBody ?? Buffer.from(''), body);
  }

  @Public() @Throttle({ default: { limit: 600, ttl: 60_000 } }) @HttpCode(200)
  @Post(':tenantId/:connectionId')
  receive(
    @Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @Req() req: Request & { rawBody?: Buffer }, @Body() body: unknown,
  ) {
    return this.svc.ingest(tenantId, connectionId, req.rawBody ?? Buffer.from(''), req.headers, body);
  }
}
