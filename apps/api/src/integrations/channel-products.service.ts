import { Body, ConflictException, Controller, Get, HttpException, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Query, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { CatalogService } from '../catalog/catalog.service';
import { ProductImagesService } from '../catalog/product-images.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelCatalogService } from './channel-catalog.service';
import { ConnectionConfig, ConnectionsService, throwFor } from './connections.service';
import { ExternalProduct, ItemDraft } from './connector';
import { redactSecrets } from './crypto.service';
import { downloadChannelImage } from './image-download';
import { publishableQty } from './pricing';
import { ConnectorRegistry } from './providers';

type Tx = Prisma.TransactionClient;
const PAGES_PER_CALL = 5;
const MAX_BULK = 25;
const dec = (n: number | undefined) => (n === undefined || !Number.isFinite(n) ? null : n.toFixed(2));

class ScanDto { @IsOptional() @IsString() @MaxLength(500) cursor?: string; }
class LinkDto { @IsUUID() productId: string; }
class IgnoreDto { @IsBoolean() ignore: boolean; }
class ItemsQuery { @IsOptional() @IsIn(['NEW', 'LINKED', 'IMPORTED', 'IGNORED']) status?: string; @IsOptional() @IsString() @MaxLength(80) q?: string; }

/**
 * Elo entre o cadastro de produtos e os anúncios do canal, nos dois sentidos:
 *  • canal → base: varre os anúncios do canal (leitura), mostra o que ainda não existe na base e permite importar (com fotos) ou vincular;
 *  • base → canal: monta o anúncio a partir do produto, mostra a pré-visualização com os bloqueios e publica.
 * Nada é criado sem ação do usuário, e o que o canal não oferece (ou não foi validado) fica explícito.
 */
@Injectable()
export class ChannelProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly connections: ConnectionsService,
    private readonly registry: ConnectorRegistry,
    private readonly catalog: CatalogService,
    private readonly listings: ChannelCatalogService,
    private readonly images: ProductImagesService,
  ) {}

  private async conn(tx: Tx, ctx: Pick<AuthContext, 'tenantId'>, id: string) {
    const c = await tx.marketplaceConnection.findFirst({ where: { id, tenantId: ctx.tenantId! } });
    if (!c) throw new NotFoundException('Conexão não encontrada.');
    return c;
  }

  // ───────────── canal → base ─────────────

  /** Lê até 5 páginas do canal e atualiza a lista de itens. Repetir é seguro. Devolve `nextCursor` quando ainda há mais. */
  async scan(ctx: AuthContext, connectionId: string, cursor?: string) {
    await this.prisma.withContext(ctx, async (tx) => {
      const c = await this.conn(tx, ctx, connectionId);
      if (c.status === 'DISCONNECTED') throw new ConflictException('Conexão desconectada.');
    });
    const tenantId = ctx.tenantId!;
    let cur = cursor;
    const sum = { scanned: 0, created: 0, updated: 0, matched: 0 };
    for (let page = 0; page < PAGES_PER_CALL; page++) {
      const r = await this.connections.call(tenantId, connectionId, 'fetchProducts', (c, cc) => c.fetchProducts(cc, { cursor: cur }));
      if (!r.ok) throwFor(r);
      await this.prisma.withContext(ctx, async (tx) => {
        for (const p of r.data.products) {
          const out = await this.upsertItem(tx, tenantId, connectionId, p);
          sum.scanned++;
          if (out.created) sum.created++; else sum.updated++;
          if (out.matched) sum.matched++;
        }
      });
      cur = r.data.nextCursor;
      if (!cur) break;
    }
    await this.prisma.withContext(ctx, (tx) => this.audit.record(tx, ctx, { action: 'channel_catalog.scanned', entity: 'marketplace_connection', entityId: connectionId, metadata: sum }));
    return { ...sum, nextCursor: cur ?? null };
  }

  private async upsertItem(tx: Tx, tenantId: string, connectionId: string, p: ExternalProduct) {
    const existing = await tx.channelItem.findUnique({ where: { connectionId_externalId: { connectionId, externalId: p.externalId } } });
    const listing = await tx.channelListing.findFirst({ where: { connectionId, externalItemId: p.externalId }, select: { productId: true } });
    let productId: string | null = null;
    let matchedBy: string | null = null;
    let status = existing?.status ?? 'NEW';
    if (listing) { productId = listing.productId; status = status === 'IMPORTED' ? 'IMPORTED' : 'LINKED'; }
    else if (existing && existing.status !== 'NEW') { productId = existing.productId; matchedBy = existing.matchedBy; }
    else {
      const bySku = p.sku ? await tx.product.findFirst({ where: { tenantId, sku: { equals: p.sku, mode: 'insensitive' } }, select: { id: true } }) : null;
      const byGtin = !bySku && p.gtin ? await tx.product.findFirst({ where: { tenantId, barcode: p.gtin }, select: { id: true } }) : null;
      productId = bySku?.id ?? byGtin?.id ?? null;
      matchedBy = bySku ? 'SKU' : byGtin ? 'GTIN' : null;
    }
    const snapshot = { ...p, raw: undefined } as unknown as Prisma.InputJsonValue;
    const data = { title: p.title.slice(0, 300), sku: p.sku ?? null, gtin: p.gtin ?? null, price: dec(p.price), quantity: p.quantity ?? null, channelStatus: p.status ?? null, permalink: p.permalink ?? null, snapshot, status, productId, matchedBy, lastSeenAt: new Date() };
    if (existing) { await tx.channelItem.update({ where: { id: existing.id }, data }); return { created: false, matched: !!matchedBy }; }
    await tx.channelItem.create({ data: { tenantId, connectionId, externalId: p.externalId, ...data } });
    return { created: true, matched: !!matchedBy };
  }

  list(ctx: AuthContext, connectionId: string, q: ItemsQuery) {
    return this.prisma.withContext(ctx, async (tx) => {
      await this.conn(tx, ctx, connectionId);
      const where: Prisma.ChannelItemWhereInput = { tenantId: ctx.tenantId!, connectionId, ...(q.status ? { status: q.status } : {}), ...(q.q ? { OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { sku: { contains: q.q, mode: 'insensitive' } }, { externalId: { contains: q.q } }] } : {}) };
      const [items, groups] = await Promise.all([
        tx.channelItem.findMany({ where, orderBy: [{ status: 'asc' }, { title: 'asc' }], take: 200 }),
        tx.channelItem.groupBy({ by: ['status'], where: { tenantId: ctx.tenantId!, connectionId }, _count: true }),
      ]);
      const prods = await tx.product.findMany({ where: { tenantId: ctx.tenantId!, id: { in: items.map((i) => i.productId).filter((x): x is string => !!x) } }, select: { id: true, sku: true, name: true } });
      const byId = new Map(prods.map((p) => [p.id, p]));
      const pics = (s: unknown) => (Array.isArray((s as { pictures?: unknown })?.pictures) ? ((s as { pictures: string[] }).pictures.length) : 0);
      return {
        counts: Object.fromEntries(groups.map((g) => [g.status, g._count])),
        items: items.map((i) => ({
          id: i.id, externalId: i.externalId, title: i.title, sku: i.sku, gtin: i.gtin, price: i.price?.toString() ?? null, quantity: i.quantity, channelStatus: i.channelStatus, permalink: i.permalink,
          status: i.status, matchedBy: i.matchedBy, pictureCount: pics(i.snapshot), product: i.productId ? byId.get(i.productId) ?? null : null, lastSeenAt: i.lastSeenAt,
        })),
      };
    });
  }

  /** Cria o produto a partir do anúncio (com fotos) e o vincula ao anúncio. Se já existe produto com o mesmo SKU/GTIN, pede para vincular. */
  async importItem(ctx: AuthContext, connectionId: string, itemId: string) {
    const tenantId = ctx.tenantId!;
    const { item, provider } = await this.prisma.withContext(ctx, async (tx) => {
      const c = await this.conn(tx, ctx, connectionId);
      const it = await tx.channelItem.findFirst({ where: { id: itemId, connectionId, tenantId } });
      if (!it) throw new NotFoundException('Item do canal não encontrado.');
      return { item: it, provider: c.provider };
    });
    if (item.status === 'IMPORTED' || item.status === 'LINKED') throw new ConflictException('Este anúncio já está ligado a um produto.');
    const snap = item.snapshot as unknown as ExternalProduct;

    // Descrição completa (chamada separada, melhor esforço).
    let detail: ExternalProduct = snap;
    const d = await this.connections.call(tenantId, connectionId, 'fetchProductDetail', (c, cc) => c.fetchProductDetail(cc, { externalId: item.externalId }));
    if (d.ok) detail = { ...snap, ...d.data };
    else if (d.code === 'AUTH' || d.code === 'RATE_LIMIT') throwFor(d);

    const sku = (detail.sku ?? '').trim() || `${provider.slice(0, 4)}-${item.externalId}`.replace(/[^A-Za-z0-9._\-/]/g, '').slice(0, 60);
    const clash = await this.prisma.withContext(ctx, async (tx) => ({
      sku: await tx.product.findFirst({ where: { tenantId, sku: { equals: sku, mode: 'insensitive' } }, select: { id: true, sku: true } }),
      gtin: detail.gtin ? await tx.product.findFirst({ where: { tenantId, barcode: detail.gtin }, select: { id: true, sku: true } }) : null,
    }));
    if (clash.sku || clash.gtin) throw new ConflictException({ message: `Já existe um produto com este ${clash.sku ? 'SKU' : 'GTIN'} (${(clash.sku ?? clash.gtin)!.sku}). Vincule o anúncio a ele em vez de importar.`, productId: (clash.sku ?? clash.gtin)!.id });

    const created = await this.catalog.createProduct(ctx, {
      sku, name: detail.title.slice(0, 200), title: detail.title.slice(0, 150), description: detail.description?.slice(0, 5000), brand: detail.brand?.slice(0, 100), model: detail.model?.slice(0, 100),
      barcode: detail.gtin ?? undefined, condition: detail.condition ?? 'NEW', suggestedPrice: detail.price && detail.price > 0 ? detail.price : undefined,
      attributes: (detail.attributes ?? []).slice(0, 50).map((a) => ({ name: a.name.slice(0, 60), value: a.value.slice(0, 255) })),
    } as never) as { id: string };

    const hosts = this.registry.get(provider)?.info.imageHosts ?? [];
    const warnings: string[] = [];
    for (const [i, url] of (detail.pictures ?? []).slice(0, 12).entries()) {
      try {
        const buffer = await downloadChannelImage(url, hosts);
        await this.images.add(ctx, created.id, { buffer, sourceUrl: url.slice(0, 500) });
      } catch (e) { warnings.push(`Foto ${i + 1} não importada: ${e instanceof HttpException ? JSON.stringify(e.getResponse()) : (e as Error).message}`); }
    }
    await this.listings.upsertListing(ctx, connectionId, { productId: created.id, externalItemId: item.externalId, title: detail.title.slice(0, 300) });
    await this.prisma.withContext(ctx, async (tx) => {
      if (detail.price && detail.price > 0) await tx.channelListing.updateMany({ where: { connectionId, productId: created.id }, data: { price: dec(detail.price) } });
      await tx.channelItem.update({ where: { id: item.id }, data: { status: 'IMPORTED', productId: created.id, matchedBy: null } });
      await this.audit.record(tx, ctx, { action: 'channel_item.imported', entity: 'product', entityId: created.id, metadata: { connectionId, externalId: item.externalId, photos: (detail.pictures ?? []).length - warnings.length, warnings: warnings.length } });
    });
    return { productId: created.id, sku, warnings };
  }

  async linkItem(ctx: AuthContext, connectionId: string, itemId: string, productId: string) {
    const item = await this.prisma.withContext(ctx, (tx) => tx.channelItem.findFirst({ where: { id: itemId, connectionId, tenantId: ctx.tenantId! } }));
    if (!item) throw new NotFoundException('Item do canal não encontrado.');
    if (item.status === 'IMPORTED' || item.status === 'LINKED') throw new ConflictException('Este anúncio já está ligado a um produto.');
    await this.listings.upsertListing(ctx, connectionId, { productId, externalItemId: item.externalId, title: item.title ?? undefined });
    await this.prisma.withContext(ctx, async (tx) => {
      if (item.price) await tx.channelListing.updateMany({ where: { connectionId, productId, price: null }, data: { price: item.price } });
      await tx.channelItem.update({ where: { id: item.id }, data: { status: 'LINKED', productId, matchedBy: 'MANUAL' } });
      await this.audit.record(tx, ctx, { action: 'channel_item.linked', entity: 'product', entityId: productId, metadata: { connectionId, externalId: item.externalId } });
    });
    return { ok: true };
  }

  async ignoreItem(ctx: AuthContext, connectionId: string, itemId: string, ignore: boolean) {
    return this.prisma.withContext(ctx, async (tx) => {
      const item = await tx.channelItem.findFirst({ where: { id: itemId, connectionId, tenantId: ctx.tenantId! } });
      if (!item) throw new NotFoundException('Item do canal não encontrado.');
      if (['IMPORTED', 'LINKED'].includes(item.status)) throw new ConflictException('Este anúncio já está ligado a um produto.');
      await tx.channelItem.update({ where: { id: item.id }, data: { status: ignore ? 'IGNORED' : 'NEW' } });
      return { ok: true };
    });
  }

  /** Importa os itens novos SEM conflito de SKU/GTIN (até 25 por vez). Cada item é independente: um erro não derruba os demais. */
  async importNew(ctx: AuthContext, connectionId: string) {
    const items = await this.prisma.withContext(ctx, (tx) => tx.channelItem.findMany({ where: { tenantId: ctx.tenantId!, connectionId, status: 'NEW', productId: null }, orderBy: { createdAt: 'asc' }, take: MAX_BULK, select: { id: true, externalId: true, title: true } }));
    const results: { externalId: string; title: string | null; ok: boolean; productId?: string; error?: string }[] = [];
    for (const it of items) {
      try { const r = await this.importItem(ctx, connectionId, it.id); results.push({ externalId: it.externalId, title: it.title, ok: true, productId: r.productId }); }
      catch (e) { results.push({ externalId: it.externalId, title: it.title, ok: false, error: e instanceof HttpException ? String((e.getResponse() as { message?: string }).message ?? e.message) : (e as Error).message }); }
    }
    return { processed: results.length, imported: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  }

  // ───────────── base → canal ─────────────

  /** Situação do produto em cada conexão (para o editor do produto). */
  channelsOf(ctx: AuthContext, productId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      if (!(await tx.product.findFirst({ where: { id: productId, tenantId: ctx.tenantId! }, select: { id: true } }))) throw new NotFoundException('Produto não encontrado.');
      const conns = await tx.marketplaceConnection.findMany({ where: { tenantId: ctx.tenantId!, status: { not: 'DISCONNECTED' } }, orderBy: { createdAt: 'asc' }, select: { id: true, label: true, provider: true, status: true } });
      const lst = await tx.channelListing.findMany({ where: { tenantId: ctx.tenantId!, productId } });
      return conns.map((c) => {
        const l = lst.find((x) => x.connectionId === c.id);
        const caps = this.registry.get(c.provider)?.getCapabilities();
        return {
          connectionId: c.id, label: c.label, provider: c.provider, displayName: this.registry.get(c.provider)?.info.displayName ?? c.provider, status: c.status,
          canPublish: !!caps && caps.publishing !== 'PLANNED' && caps.publishing !== 'UNSUPPORTED', publishingSupport: caps?.publishing ?? 'PLANNED',
          listing: l ? { externalItemId: l.externalItemId, status: l.status, price: l.price?.toString() ?? null, syncStatus: l.syncStatus, syncError: l.syncError } : null,
        };
      });
    });
  }

  /** Monta o anúncio a partir do cadastro e lista o que impede de publicar. Não chama o canal. */
  async draft(ctx: AuthContext, productId: string, connectionId: string) {
    const tenantId = ctx.tenantId!;
    const loaded = await this.prisma.withContext(ctx, async (tx) => {
      const c = await this.conn(tx, ctx, connectionId);
      const p = await tx.product.findFirst({ where: { id: productId, tenantId } });
      if (!p) throw new NotFoundException('Produto não encontrado.');
      const listing = await tx.channelListing.findUnique({ where: { connectionId_productId: { connectionId, productId } } });
      const map = p.categoryId ? await tx.channelCategoryMapping.findFirst({ where: { tenantId, connectionId, categoryId: p.categoryId } }) : null;
      const bal = c.warehouseId ? await tx.stockBalance.findFirst({ where: { tenantId, warehouseId: c.warehouseId, productId } }) : null;
      return { c, p, listing, map, avail: bal ? bal.onHand - bal.reserved - bal.blocked : 0 };
    });
    const { c, p, listing, map, avail } = loaded;
    const connector = this.registry.get(c.provider);
    const cfg = c.config as ConnectionConfig;
    const price = listing?.price ? Number(listing.price) : p.suggestedPrice ? Number(p.suggestedPrice) : 0;
    const pics = await this.images.publicUrls(ctx, productId);
    const draft: ItemDraft = {
      sku: p.sku, title: (p.title?.trim() || p.name).slice(0, 150), description: (p.description?.trim() || p.shortDescription?.trim() || ''), price, quantity: publishableQty(avail, cfg), condition: (p.condition as ItemDraft['condition']) ?? 'NEW',
      brand: p.brand ?? undefined, model: p.model ?? undefined, gtin: p.barcode ?? undefined, mpn: p.mpn ?? undefined, warrantyMonths: p.warrantyMonths ?? undefined, categoryId: map?.externalCategoryId,
      attributes: (Array.isArray(p.attributes) ? (p.attributes as { name: string; value: string }[]) : []).filter((a) => a?.name && a?.value),
      pictures: pics.map((x) => ({ url: x.url, width: x.width, height: x.height })), weightG: p.grossWeightG ?? p.netWeightG ?? undefined, heightMm: p.heightMm ?? undefined, widthMm: p.widthMm ?? undefined, lengthMm: p.lengthMm ?? undefined,
      channelConfig: cfg as Record<string, unknown>,
    };
    const problems: string[] = [];
    const warnings: string[] = [];
    if (!(price > 0)) problems.push('Defina o preço de venda (preço aprovado do canal em Preços e margens, ou o preço sugerido do produto).');
    if (!draft.pictures.length) problems.push('Envie ao menos uma foto do produto.');
    if (!draft.categoryId) problems.push('Falta a categoria do canal: mapeie a categoria do produto em Marketplaces → Categorias.');
    if (!draft.title || draft.title.length < 5) problems.push('O título é curto demais.');
    if (!draft.description) warnings.push('Sem descrição: o anúncio será publicado só com título e ficha técnica.');
    if (!draft.brand) warnings.push('Sem marca: muitas categorias exigem marca e o canal pode recusar.');
    if (!draft.gtin) warnings.push('Sem GTIN/EAN: o canal pode recusar ou reduzir a visibilidade.');
    if (draft.quantity <= 0) warnings.push('Estoque publicável zerado: o anúncio nasceria sem unidades disponíveis.');
    const caps = connector?.getCapabilities();
    const canPublish = !!caps && caps.publishing !== 'PLANNED' && caps.publishing !== 'UNSUPPORTED';
    if (canPublish) for (const x of connector?.validateDraft?.(draft) ?? []) problems.push(x); // regras do canal só importam se ele publica
    if (!canPublish) problems.push(`${connector?.info.displayName ?? 'Este canal'} ainda não permite publicar por aqui (publicação "${caps?.publishing === 'UNSUPPORTED' ? 'não suportada' : 'planejada'}").`);
    if (listing?.externalItemId) problems.push(`Este produto já está ligado ao anúncio ${listing.externalItemId}.`);
    return { draft: { ...draft, channelConfig: undefined }, problems: [...new Set(problems)], warnings, canPublish: problems.length === 0, listingId: listing?.id ?? null };
  }

  /** Publica no canal. Ação do usuário (não automática): uma publicação por vez por produto/canal; resultado incerto é tratado sem duplicar. */
  async publish(ctx: AuthContext, productId: string, connectionId: string) {
    const tenantId = ctx.tenantId!;
    const d = await this.draft(ctx, productId, connectionId);
    if (!d.canPublish) throw new UnprocessableEntityException({ message: 'O anúncio ainda não pode ser publicado.', problems: d.problems });
    const conn = await this.prisma.withContext(ctx, (tx) => this.conn(tx, ctx, connectionId));
    if (conn.status !== 'ACTIVE') throw new ConflictException('Ative a conexão antes de publicar.');
    const full = await this.fullDraft(ctx, productId, connectionId);

    // Garante o registro do anúncio e "reserva" a publicação de forma atômica.
    const listingId = await this.prisma.withContext(ctx, async (tx) => {
      const l = await tx.channelListing.upsert({ where: { connectionId_productId: { connectionId, productId } }, create: { tenantId, connectionId, productId, status: 'DRAFT', title: d.draft.title }, update: {} });
      const claimed = await tx.$executeRaw`UPDATE channel_listings SET sync_status = 'PUBLISHING', sync_error = NULL, updated_at = now()
        WHERE id = ${l.id}::uuid AND tenant_id = ${tenantId}::uuid AND external_item_id IS NULL AND (sync_status IS DISTINCT FROM 'PUBLISHING' OR updated_at < now() - interval '2 minutes')`;
      if (!claimed) throw new ConflictException(l.externalItemId ? 'Este produto já está publicado neste canal.' : 'Já existe uma publicação em andamento para este produto neste canal.');
      return l.id;
    });

    const r = await this.connections.call(tenantId, connectionId, 'publishProduct', (c, cc) => c.publishProduct(cc, { productId, payload: full, idempotencyKey: `publish:${connectionId}:${productId}:${listingId}` }));
    if (!r.ok) {
      const uncertain = r.code === 'UNAVAILABLE' || r.code === 'ERROR';
      const note = uncertain ? `${r.message} — se o tempo esgotou, o anúncio pode ter sido criado: use "Importar do canal" para localizá-lo antes de tentar de novo.` : r.message;
      await this.prisma.withContext(ctx, (tx) => tx.channelListing.update({ where: { id: listingId }, data: { syncStatus: 'ERROR', syncError: redactSecrets(note).slice(0, 500) } }));
      throwFor({ ...r, message: note });
    }
    await this.listings.upsertListing(ctx, connectionId, { productId, externalItemId: r.data.externalId, title: d.draft.title });
    await this.prisma.withContext(ctx, async (tx) => {
      await tx.channelListing.update({ where: { id: listingId }, data: { price: dec(d.draft.price), lastPublishedPrice: dec(d.draft.price), lastPublishedQty: d.draft.quantity, syncStatus: 'OK', syncError: null, lastSyncAt: new Date() } });
      await tx.channelItem.upsert({
        where: { connectionId_externalId: { connectionId, externalId: r.data.externalId } },
        create: { tenantId, connectionId, externalId: r.data.externalId, title: d.draft.title, sku: d.draft.sku, gtin: d.draft.gtin ?? null, price: dec(d.draft.price), quantity: d.draft.quantity, permalink: r.data.permalink ?? null, status: 'LINKED', productId },
        update: { status: 'LINKED', productId, permalink: r.data.permalink ?? null },
      });
      await this.audit.record(tx, ctx, { action: 'channel_listing.published', entity: 'product', entityId: productId, metadata: { connectionId, externalItemId: r.data.externalId, price: d.draft.price, quantity: d.draft.quantity, photos: d.draft.pictures.length } });
    });
    return { externalItemId: r.data.externalId, permalink: r.data.permalink ?? null, warnings: d.warnings };
  }

  /** O rascunho completo (com a configuração do canal) para o conector; a versão exibida ao usuário omite a configuração. */
  private async fullDraft(ctx: AuthContext, productId: string, connectionId: string): Promise<ItemDraft> {
    const conn = await this.prisma.withContext(ctx, (tx) => this.conn(tx, ctx, connectionId));
    const d = await this.draft(ctx, productId, connectionId);
    return { ...d.draft, channelConfig: conn.config as Record<string, unknown> };
  }
}

@Controller()
export class ChannelProductsController {
  constructor(private readonly svc: ChannelProductsService) {}

  @Post('integrations/connections/:id/catalog/scan') @RequirePermissions('integrations.manage')
  scan(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ScanDto) { return this.svc.scan(ctx, id, dto.cursor); }

  @Get('integrations/connections/:id/catalog/items') @RequirePermissions('integrations.view', 'products.view')
  items(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: ItemsQuery) { return this.svc.list(ctx, id, q); }

  @Post('integrations/connections/:id/catalog/items/:itemId/import') @RequirePermissions('integrations.manage', 'products.manage')
  import(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string) { return this.svc.importItem(ctx, id, itemId); }

  @Post('integrations/connections/:id/catalog/items/:itemId/link') @RequirePermissions('integrations.manage', 'products.manage')
  link(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string, @Body() dto: LinkDto) { return this.svc.linkItem(ctx, id, itemId, dto.productId); }

  @Post('integrations/connections/:id/catalog/items/:itemId/ignore') @RequirePermissions('integrations.manage')
  ignore(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string, @Body() dto: IgnoreDto) { return this.svc.ignoreItem(ctx, id, itemId, dto.ignore); }

  @Post('integrations/connections/:id/catalog/import-new') @RequirePermissions('integrations.manage', 'products.manage')
  importNew(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.importNew(ctx, id); }

  @Get('products/:id/channels') @RequirePermissions('products.view', 'integrations.view')
  channels(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.channelsOf(ctx, id); }

  @Post('products/:id/channels/:connectionId/preview') @RequirePermissions('products.view', 'integrations.view')
  preview(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('connectionId', ParseUUIDPipe) cid: string) { return this.svc.draft(ctx, id, cid); }

  @Post('products/:id/channels/:connectionId/publish') @RequirePermissions('products.manage', 'integrations.manage')
  publish(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('connectionId', ParseUUIDPipe) cid: string) { return this.svc.publish(ctx, id, cid); }
}
