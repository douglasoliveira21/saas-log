import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectionConfig, ConnectionsService } from './connections.service';
import { RETRYABLE } from './connector';
import { redactSecrets } from './crypto.service';
import { JobQueue } from './job-queue';
import { breakEvenPrice, checkPrice, evaluate, FeeProfile, normalizeFees, priceForMargin, publishableQty } from './pricing';

type Tx = Prisma.TransactionClient;
const num = (d: Prisma.Decimal | null | undefined) => (d === null || d === undefined ? null : Number(d));

export type SyncOutcome = { ok: true; result: Record<string, unknown> } | { ok: false; retryable: boolean; message: string; retryAfterMs?: number };

/** Anúncios, preços e categorias por canal + sincronização de estoque/preço (idempotente: só envia o que mudou). */
@Injectable()
export class ChannelCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly connections: ConnectionsService,
    private readonly queue: JobQueue,
  ) {}

  private async conn(tx: Tx, ctx: Pick<AuthContext, 'tenantId'>, id: string) {
    const c = await tx.marketplaceConnection.findFirst({ where: { id, tenantId: ctx.tenantId! } });
    if (!c) throw new NotFoundException('Conexão não encontrada.');
    return c;
  }

  // ───────────── anúncios ─────────────

  listListings(ctx: AuthContext, connectionId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const c = await this.conn(tx, ctx, connectionId);
      const cfg = c.config as ConnectionConfig;
      const fees = normalizeFees((c.config as { fees?: unknown }).fees);
      const seeCosts = ctx.permissions.has('pricing.view');
      const rows = await tx.channelListing.findMany({
        where: { tenantId: ctx.tenantId!, connectionId }, orderBy: { createdAt: 'asc' },
        include: { product: { select: { sku: true, name: true, costPrice: true, extraCost: true, minPrice: true } } },
      });
      const avail = await this.availability(tx, ctx.tenantId!, c.warehouseId, rows.map((r) => r.productId));
      return rows.map((r) => {
        const a = avail.get(r.productId) ?? 0;
        const price = num(r.price);
        const cost = num(r.product.costPrice);
        return {
          productId: r.productId, sku: r.product.sku, name: r.product.name, externalItemId: r.externalItemId, title: r.title, status: r.status,
          price, lastPublishedPrice: num(r.lastPublishedPrice), lastPublishedQty: r.lastPublishedQty, syncStatus: r.syncStatus, syncError: r.syncError, lastSyncAt: r.lastSyncAt,
          availableQty: a, publishableQty: publishableQty(a, cfg),
          ...(seeCosts ? { minPrice: num(r.product.minPrice), margin: price !== null && cost !== null ? evaluate(price, { cost, extraCost: num(r.product.extraCost) ?? 0 }, fees) : null } : {}),
        };
      });
    });
  }

  upsertListing(ctx: AuthContext, connectionId: string, dto: { productId: string; externalItemId?: string; title?: string }) {
    return this.prisma.withContext(ctx, async (tx) => {
      const c = await this.conn(tx, ctx, connectionId);
      if (c.status === 'DISCONNECTED') throw new ConflictException('Conexão desconectada.');
      if (!(await tx.product.findFirst({ where: { id: dto.productId, tenantId: ctx.tenantId!, kind: 'PHYSICAL', active: true }, select: { id: true } }))) throw new BadRequestException('Produto inválido, inativo ou não físico.');
      const current = await tx.channelListing.findUnique({ where: { connectionId_productId: { connectionId, productId: dto.productId } } });
      const ext = dto.externalItemId?.trim() || null;
      if (ext) {
        const taken = await tx.channelListing.findFirst({ where: { connectionId, externalItemId: ext, NOT: { productId: dto.productId } } });
        if (taken) throw new ConflictException('Este anúncio do canal já está vinculado a outro produto.');
      }
      const data = { externalItemId: ext, title: dto.title ?? current?.title ?? null, status: ext ? 'LINKED' : 'DRAFT' };
      const row = current
        ? await tx.channelListing.update({ where: { id: current.id }, data })
        : await tx.channelListing.create({ data: { tenantId: ctx.tenantId!, connectionId, productId: dto.productId, ...data } });
      // O vínculo alimenta a importação de pedidos (anúncio → produto).
      if (current?.externalItemId && current.externalItemId !== ext) {
        await tx.externalEntityMapping.updateMany({ where: { connectionId, entityType: 'LISTING', externalId: current.externalItemId }, data: { internalId: null } });
      }
      if (ext) {
        await tx.externalEntityMapping.upsert({
          where: { connectionId_entityType_externalId: { connectionId, entityType: 'LISTING', externalId: ext } },
          create: { tenantId: ctx.tenantId!, connectionId, entityType: 'LISTING', externalId: ext, internalId: dto.productId },
          update: { internalId: dto.productId },
        });
      }
      await this.audit.record(tx, ctx, { action: 'channel_listing.saved', entity: 'marketplace_connection', entityId: connectionId, metadata: { productId: dto.productId, externalItemId: ext } });
      return { id: row.id };
    });
  }

  // ───────────── preços ─────────────

  getFees(ctx: AuthContext, connectionId: string) {
    return this.prisma.withContext(ctx, async (tx) => normalizeFees(((await this.conn(tx, ctx, connectionId)).config as { fees?: unknown }).fees));
  }

  setFees(ctx: AuthContext, connectionId: string, fees: FeeProfile) {
    return this.prisma.withContext(ctx, async (tx) => {
      const c = await this.conn(tx, ctx, connectionId);
      const before = normalizeFees((c.config as { fees?: unknown }).fees);
      await tx.marketplaceConnection.update({ where: { id: connectionId }, data: { config: { ...(c.config as object), fees } as unknown as Prisma.InputJsonValue } });
      await this.audit.record(tx, ctx, { action: 'pricing.fees_changed', entity: 'marketplace_connection', entityId: connectionId, metadata: { before, after: fees } });
      return fees;
    });
  }

  /** Define o preço aprovado do anúncio, validando piso do produto e margem mínima do canal. Registra histórico. */
  setPrice(ctx: AuthContext, connectionId: string, productId: string, dto: { price: number; reason: string; confirmLargeChange?: boolean }) {
    return this.prisma.withContext(ctx, async (tx) => {
      const c = await this.conn(tx, ctx, connectionId);
      const listing = await tx.channelListing.findUnique({ where: { connectionId_productId: { connectionId, productId } }, include: { product: true } });
      if (!listing) throw new NotFoundException('Crie o anúncio deste produto no canal antes de definir o preço.');
      const fees = normalizeFees((c.config as { fees?: unknown }).fees);
      const p = listing.product;
      const check = checkPrice(dto.price, { cost: num(p.costPrice), extraCost: num(p.extraCost), minPrice: num(p.minPrice) }, fees);
      if (!check.ok) throw new UnprocessableEntityException({ message: check.reason, evaluation: check.evaluation });
      const prev = num(listing.price);
      if (prev && Math.abs(dto.price - prev) / prev > 0.2 && !dto.confirmLargeChange) {
        throw new ConflictException({ message: 'Variação de preço acima de 20%: confirme explicitamente a alteração.', requiresConfirmation: true, from: prev, to: dto.price });
      }
      await tx.channelListing.update({ where: { id: listing.id }, data: { price: dto.price.toFixed(2) } });
      await tx.priceHistory.create({
        data: { tenantId: ctx.tenantId!, productId, connectionId, oldPrice: prev === null ? null : prev.toFixed(2), newPrice: dto.price.toFixed(2), marginPct: check.evaluation ? check.evaluation.marginPct.toFixed(2) : null, reason: dto.reason, userId: ctx.userId },
      });
      await this.audit.record(tx, ctx, { action: 'pricing.channel_price_set', entity: 'product', entityId: productId, metadata: { connectionId, from: prev, to: dto.price, marginPct: check.evaluation?.marginPct ?? null, reason: dto.reason } });
      return { price: dto.price, evaluation: check.evaluation, appliesAt: c.config && (c.config as ConnectionConfig).priceSync ? 'próxima sincronização' : 'não será enviado ao canal (envio de preços desligado na conexão)' };
    });
  }

  priceHistory(ctx: AuthContext, connectionId: string, productId?: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      await this.conn(tx, ctx, connectionId);
      const rows = await tx.priceHistory.findMany({ where: { tenantId: ctx.tenantId!, connectionId, ...(productId ? { productId } : {}) }, orderBy: { id: 'desc' }, take: 100 });
      return rows.map((r) => ({ ...r, id: r.id.toString() }));
    });
  }

  // ───────────── categorias ─────────────

  listCategoryMap(ctx: AuthContext, connectionId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      await this.conn(tx, ctx, connectionId);
      return tx.channelCategoryMapping.findMany({ where: { tenantId: ctx.tenantId!, connectionId }, include: { category: { select: { name: true } } }, orderBy: { createdAt: 'asc' } });
    });
  }

  setCategoryMap(ctx: AuthContext, connectionId: string, dto: { categoryId: string; externalCategoryId: string; externalCategoryName?: string }) {
    return this.prisma.withContext(ctx, async (tx) => {
      await this.conn(tx, ctx, connectionId);
      if (!(await tx.productCategory.findFirst({ where: { id: dto.categoryId, tenantId: ctx.tenantId! }, select: { id: true } }))) throw new BadRequestException('Categoria inválida.');
      const row = await tx.channelCategoryMapping.upsert({
        where: { connectionId_categoryId: { connectionId, categoryId: dto.categoryId } },
        create: { tenantId: ctx.tenantId!, connectionId, categoryId: dto.categoryId, externalCategoryId: dto.externalCategoryId.trim(), externalCategoryName: dto.externalCategoryName },
        update: { externalCategoryId: dto.externalCategoryId.trim(), externalCategoryName: dto.externalCategoryName },
      });
      await this.audit.record(tx, ctx, { action: 'channel_category.mapped', entity: 'marketplace_connection', entityId: connectionId, metadata: { categoryId: dto.categoryId, externalCategoryId: dto.externalCategoryId } });
      return row;
    });
  }

  removeCategoryMap(ctx: AuthContext, connectionId: string, categoryId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const n = await tx.$executeRaw`DELETE FROM channel_category_mappings WHERE tenant_id = ${ctx.tenantId}::uuid AND connection_id = ${connectionId}::uuid AND category_id = ${categoryId}::uuid`;
      if (!n) throw new NotFoundException('Mapeamento não encontrado.');
      await this.audit.record(tx, ctx, { action: 'channel_category.unmapped', entity: 'marketplace_connection', entityId: connectionId, metadata: { categoryId } });
      return { ok: true };
    });
  }

  // ───────────── sincronização ─────────────

  requestSync(ctx: AuthContext, connectionId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const c = await this.conn(tx, ctx, connectionId);
      if (!['ACTIVE', 'SYNC_ERROR'].includes(c.status)) throw new ConflictException('Ative a conexão para sincronizar anúncios.');
      const job = await this.queue.enqueue(tx, ctx.tenantId!, { type: 'channel.sync', connectionId, idempotencyKey: `sync-manual:${connectionId}:${Math.floor(Date.now() / 30_000)}` });
      return { jobId: job.id, alreadyQueued: !job.created };
    });
  }

  private async availability(tx: Tx, tenantId: string, warehouseId: string | null, productIds: string[]): Promise<Map<string, number>> {
    if (!warehouseId || !productIds.length) return new Map();
    const rows = await tx.stockBalance.findMany({ where: { tenantId, warehouseId, productId: { in: productIds } } });
    return new Map(rows.map((b) => [b.productId, b.onHand - b.reserved - b.blocked]));
  }

  /**
   * Envia ao canal apenas o que mudou desde o último envio (estoque publicável e preço aprovado). Repetir é seguro.
   * Conectores sem a operação (NOT_IMPLEMENTED/UNSUPPORTED) deixam o anúncio como BLOCKED — nunca "sincronizado".
   */
  async sync(tenantId: string, connectionId: string): Promise<SyncOutcome> {
    const ctx = { tenantId };
    const loaded = await this.prisma.withContext(ctx, async (tx) => {
      const c = await tx.marketplaceConnection.findFirst({ where: { id: connectionId, tenantId } });
      if (!c) return null;
      const listings = await tx.channelListing.findMany({ where: { tenantId, connectionId, externalItemId: { not: null }, status: 'LINKED' }, include: { product: true }, orderBy: { createdAt: 'asc' } });
      return { c, listings, avail: await this.availability(tx, tenantId, c.warehouseId, listings.map((l) => l.productId)) };
    });
    if (!loaded) return { ok: false, retryable: false, message: 'Conexão não encontrada.' };
    const { c, listings, avail } = loaded;
    const cfg = c.config as ConnectionConfig;
    const fees = normalizeFees((c.config as { fees?: unknown }).fees);
    if (!cfg.stockSync && !cfg.priceSync) return { ok: true, result: { skipped: 'envio de estoque e preço desligado na conexão' } };
    if (!c.warehouseId) return { ok: true, result: { skipped: 'depósito de origem não definido' } };

    const sum = { checked: listings.length, stockSent: 0, priceSent: 0, unchanged: 0, blocked: 0, errors: 0 };
    for (const l of listings) {
      const update: Prisma.ChannelListingUncheckedUpdateInput = {};
      const notes: string[] = [];
      let blocked: string | null = null;
      let failed: string | null = null;
      let touched = false;

      const qty = cfg.stockSync ? publishableQty(avail.get(l.productId) ?? 0, cfg) : null;
      if (qty !== null && qty !== l.lastPublishedQty) {
        touched = true;
        const r = await this.connections.call(tenantId, connectionId, 'updateInventory', (cn, cc) => cn.updateInventory(cc, { externalId: l.externalItemId!, quantity: qty }));
        if (r.ok) { update.lastPublishedQty = qty; sum.stockSent++; }
        else if (r.code === 'NOT_IMPLEMENTED' || r.code === 'UNSUPPORTED') blocked = r.message;
        else if (RETRYABLE.includes(r.code)) { await this.persist(tenantId, l.id, update); return { ok: false, retryable: true, message: `${r.code}: ${r.message}`, retryAfterMs: r.retryAfterMs }; }
        else if (r.code === 'AUTH') return { ok: false, retryable: false, message: `AUTH: ${r.message}` };
        else failed = `estoque: ${r.message}`;
      }

      const price = cfg.priceSync ? num(l.price) : null;
      if (price !== null && price !== num(l.lastPublishedPrice)) {
        // Revalida no momento do envio: custo/tarifas podem ter mudado desde a aprovação.
        const check = checkPrice(price, { cost: num(l.product.costPrice), extraCost: num(l.product.extraCost), minPrice: num(l.product.minPrice) }, fees);
        if (!check.ok) { failed = `preço não enviado: ${check.reason}`; touched = true; }
        else {
          touched = true;
          const r = await this.connections.call(tenantId, connectionId, 'updatePrice', (cn, cc) => cn.updatePrice(cc, { externalId: l.externalItemId!, price }));
          if (r.ok) { update.lastPublishedPrice = price.toFixed(2); sum.priceSent++; }
          else if (r.code === 'NOT_IMPLEMENTED' || r.code === 'UNSUPPORTED') blocked = blocked ?? r.message;
          else if (RETRYABLE.includes(r.code)) { await this.persist(tenantId, l.id, update); return { ok: false, retryable: true, message: `${r.code}: ${r.message}`, retryAfterMs: r.retryAfterMs }; }
          else if (r.code === 'AUTH') return { ok: false, retryable: false, message: `AUTH: ${r.message}` };
          else failed = `preço: ${r.message}`;
        }
      }

      if (!touched) { sum.unchanged++; continue; }
      if (blocked) { sum.blocked++; notes.push(blocked); }
      if (failed) { sum.errors++; notes.push(failed); }
      update.syncStatus = failed ? 'ERROR' : blocked ? 'BLOCKED' : 'OK';
      update.syncError = notes.length ? redactSecrets(notes.join(' | ')).slice(0, 500) : null;
      update.lastSyncAt = new Date();
      await this.persist(tenantId, l.id, update);
    }
    return { ok: true, result: sum };
  }

  private persist(tenantId: string, id: string, data: Prisma.ChannelListingUncheckedUpdateInput) {
    if (!Object.keys(data).length) return Promise.resolve();
    return this.prisma.withContext({ tenantId }, (tx) => tx.channelListing.update({ where: { id }, data }));
  }
}
