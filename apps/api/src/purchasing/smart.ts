import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { fromCents, toCents } from '../commissions/commissions.service';
import { PrismaService } from '../prisma/prisma.service';
import { localToday } from '../sales/cutoff';
import { SettingsService } from '../settings/settings.service';
import { PurchasingService } from './purchasing.service';

type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const money4 = { maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false } as const;
const money2 = { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false } as const;

class FromSuggestionItem { @IsUUID() productId: string; @IsInt() @Min(1) @Max(1_000_000) quantity: number; @IsOptional() @IsUUID() supplierId?: string; @IsOptional() @IsNumber(money4) @Min(0) unitCost?: number }
class FromSuggestionsDto { @IsUUID() warehouseId: string; @IsArray() @ArrayMinSize(1) @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => FromSuggestionItem) items: FromSuggestionItem[] }

class RfqItemDto { @IsUUID() productId: string; @IsInt() @Min(1) @Max(1_000_000) quantity: number }
class RfqDto {
  @IsUUID() warehouseId: string;
  @IsOptional() @IsDateString() neededBy?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => RfqItemDto) items: RfqItemDto[];
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @IsUUID('all', { each: true }) supplierIds: string[];
}
class PriceDto { @IsUUID() productId: string; @IsNumber(money4) @Min(0) unitCost: number }
class ProposalDto {
  @IsOptional() @IsInt() @Min(0) @Max(365) leadTimeDays?: number;
  @IsOptional() @IsNumber(money2) @Min(0) freight?: number;
  @IsOptional() @IsString() @MaxLength(200) paymentTerms?: string;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => PriceDto) prices: PriceDto[];
}
class AwardDto { @IsString() mode: 'SINGLE' | 'BEST_PER_ITEM'; @IsOptional() @IsUUID() supplierId?: string }
class CancelDto { @IsString() @IsNotEmpty() @MaxLength(300) reason: string }
class SuggestQuery { @IsOptional() @IsString() days?: string; @IsOptional() @IsString() coverDays?: string; @IsOptional() @IsString() supplierId?: string }

/**
 * Compras inteligentes: sugestão por giro (ritmo recente pesa mais), ponto de reposição, prazo do fornecedor e curva ABC por valor de consumo;
 * geração de ordens a partir da sugestão; cotação entre fornecedores com comparação e geração das ordens vencedoras.
 * Nada é comprado sozinho: sempre nasce uma ordem em rascunho/aprovação, que segue a alçada normal de compras.
 */
@Injectable()
export class SmartPurchasingService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService, private readonly purchasing: PurchasingService) {}

  // ───────────── sugestão de compra ─────────────

  suggestions(ctx: AuthContext, q: { days?: number; coverDays?: number; supplierId?: string }) {
    const days = Math.min(365, Math.max(14, q.days ?? 90));
    const cover = Math.min(180, Math.max(1, q.coverDays ?? 30));
    return this.prisma.withContext(ctx, async (tx) => {
      const since = new Date(Date.now() - days * DAY); const since28 = new Date(Date.now() - 28 * DAY);
      const rows = await tx.$queryRaw<{
        id: string; sku: string; name: string; cost: string | null; min_stock: number; max_stock: number | null; reorder_point: number | null; lead: number | null;
        avail: number; pending: number; sold: number; sold28: number; supplier_id: string | null; supplier: string | null; last_price: string | null; supplier_sku: string | null;
      }[]>`
        SELECT p.id, p.sku, p.name, p.cost_price AS cost, p.min_stock, p.max_stock, p.reorder_point, p.lead_time_days AS lead,
          COALESCE(b.av, 0)::int AS avail,
          COALESCE((SELECT sum(i.qty_ordered - i.qty_received) FROM purchase_order_items i JOIN purchase_orders o ON o.id = i.order_id
                    WHERE i.product_id = p.id AND o.status IN ('PENDING_APPROVAL','APPROVED','PARTIALLY_RECEIVED')), 0)::int AS pending,
          COALESCE((SELECT -sum(m.quantity) FROM stock_movements m WHERE m.product_id = p.id AND m.type IN ('SALE_EXIT','RETURN_ENTRY') AND m.created_at >= ${since}), 0)::int AS sold,
          COALESCE((SELECT -sum(m.quantity) FROM stock_movements m WHERE m.product_id = p.id AND m.type IN ('SALE_EXIT','RETURN_ENTRY') AND m.created_at >= ${since28}), 0)::int AS sold28,
          ps.supplier_id, s.legal_name AS supplier, ps.last_price, ps.supplier_sku
        FROM products p
        LEFT JOIN (SELECT product_id, sum(on_hand - reserved - blocked) av FROM stock_balances GROUP BY product_id) b ON b.product_id = p.id
        LEFT JOIN LATERAL (SELECT * FROM product_suppliers x WHERE x.product_id = p.id AND x.tenant_id = p.tenant_id ORDER BY x.is_main DESC, x.last_price ASC NULLS LAST LIMIT 1) ps ON true
        LEFT JOIN suppliers s ON s.id = ps.supplier_id
        WHERE p.tenant_id = ${ctx.tenantId}::uuid AND p.active AND p.kind = 'PHYSICAL' ${q.supplierId ? Prisma.sql`AND ps.supplier_id = ${q.supplierId}::uuid` : Prisma.empty}`;
      type Out = { productId: string; sku: string; name: string; supplierId: string | null; supplier: string | null; supplierSku: string | null; available: number; onOrder: number; position: number; sold: number; dailyRate: number; coverageDays: number | null; leadDays: number; minStock: number; reorderPoint: number | null; status: string; abc: string; suggestedQty: number; unitCost: number | null; value: number; reason: string; consumptionValue: number };
      const items: Out[] = rows.map((r) => {
        const avg = Math.max(0, r.sold) / days; const recent = days >= 28 ? Math.max(0, r.sold28) / 28 : avg;
        const rate = 0.6 * recent + 0.4 * avg;
        const lead = r.lead ?? 7; const position = r.avail + r.pending;
        const trigger = Math.max(r.reorder_point ?? 0, Math.ceil(rate * lead) + r.min_stock);
        const coverage = rate > 0 ? round2(r.avail / rate) : null;
        const need = position <= trigger && (trigger > 0 || r.avail <= 0 && rate > 0);
        let qty = need ? Math.max(0, Math.ceil(rate * (lead + cover) + r.min_stock - position)) : 0;
        if (r.max_stock !== null && qty > 0) qty = Math.max(0, Math.min(qty, r.max_stock - position));
        const unitCost = r.last_price !== null ? Number(r.last_price) : r.cost !== null ? Number(r.cost) : null;
        const status = rate > 0 && r.avail <= 0 ? 'RUPTURA' : coverage !== null && coverage < lead ? 'CRITICO' : need ? 'REPOR' : 'OK';
        const reason = `Posição ${position} (disponível ${r.avail} + em compra ${r.pending}) ${need ? 'chegou ao' : 'acima do'} ponto de reposição ${trigger}; ritmo ${round2(rate)}/dia, prazo ${lead} dias${coverage !== null ? `, cobertura ${Math.round(coverage)} dias` : ''}.`;
        return { productId: r.id, sku: r.sku, name: r.name, supplierId: r.supplier_id, supplier: r.supplier, supplierSku: r.supplier_sku, available: r.avail, onOrder: r.pending, position, sold: Math.max(0, r.sold), dailyRate: round2(rate), coverageDays: coverage, leadDays: lead, minStock: r.min_stock, reorderPoint: r.reorder_point, status, abc: 'C', suggestedQty: qty, unitCost, value: unitCost === null ? 0 : round2(qty * unitCost), reason, consumptionValue: Math.max(0, r.sold) * (unitCost ?? 0) };
      });
      // curva ABC por valor consumido no período: A = 80% do valor, B = até 95%
      const total = items.reduce((s, i) => s + i.consumptionValue, 0); let acc = 0;
      for (const i of [...items].sort((a, b) => b.consumptionValue - a.consumptionValue)) { if (i.consumptionValue <= 0) continue; const before = acc; acc += i.consumptionValue; i.abc = before < total * 0.8 ? 'A' : before < total * 0.95 ? 'B' : 'C'; }
      const order: Record<string, number> = { RUPTURA: 0, CRITICO: 1, REPOR: 2, OK: 3 };
      const list = items.filter((i) => i.suggestedQty > 0).sort((a, b) => order[a.status] - order[b.status] || a.abc.localeCompare(b.abc) || (a.coverageDays ?? 1e9) - (b.coverageDays ?? 1e9));
      const bySupplier = new Map<string, { supplierId: string | null; supplier: string; items: number; value: number }>();
      for (const i of list) { const k = i.supplierId ?? 'SEM'; const g = bySupplier.get(k) ?? { supplierId: i.supplierId, supplier: i.supplier ?? 'Sem fornecedor cadastrado', items: 0, value: 0 }; g.items++; g.value = round2(g.value + i.value); bySupplier.set(k, g); }
      return {
        days, coverDays: cover,
        summary: { items: list.length, value: round2(list.reduce((s, i) => s + i.value, 0)), ruptura: list.filter((i) => i.status === 'RUPTURA').length, critico: list.filter((i) => i.status === 'CRITICO').length, withoutSupplier: list.filter((i) => !i.supplierId).length, withoutCost: list.filter((i) => i.unitCost === null).length },
        suppliers: [...bySupplier.values()].sort((a, b) => b.value - a.value), items: list.slice(0, 500),
        basis: `Vendas dos últimos ${days} dias (líquidas de devolução). Ritmo diário = 60% dos últimos 28 dias + 40% da média. Compra sugerida = ritmo × (prazo do produto, padrão 7 dias, + ${cover} dias de cobertura) + estoque mínimo − (disponível + já comprado), limitada ao estoque máximo. Só entra quem chegou ao ponto de reposição (o maior entre o cadastrado e ritmo × prazo + mínimo). Curva ABC pelo valor consumido (custo × quantidade). Custo = último preço do fornecedor principal, ou o custo do produto.`,
      };
    });
  }

  /** Gera uma ordem de compra (rascunho/aprovação, conforme a alçada) por fornecedor, tudo ou nada. */
  fromSuggestions(ctx: AuthContext, dto: FromSuggestionsDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      const ids = dto.items.map((i) => i.productId);
      if (new Set(ids).size !== ids.length) throw new BadRequestException('Produto repetido na lista.');
      const ps = await tx.productSupplier.findMany({ where: { tenantId: ctx.tenantId!, productId: { in: ids } }, orderBy: [{ isMain: 'desc' }] });
      const prods = await tx.product.findMany({ where: { tenantId: ctx.tenantId!, id: { in: ids } }, select: { id: true, sku: true, costPrice: true } });
      const groups = new Map<string, { productId: string; quantity: number; unitCost: number }[]>(); const missing: string[] = [];
      for (const it of dto.items) {
        const p = prods.find((x) => x.id === it.productId); if (!p) throw new BadRequestException('Produto não encontrado.');
        const link = ps.find((x) => x.productId === it.productId && (!it.supplierId || x.supplierId === it.supplierId)) ?? (it.supplierId ? undefined : ps.find((x) => x.productId === it.productId));
        const supplierId = it.supplierId ?? link?.supplierId;
        const cost = it.unitCost ?? (link?.lastPrice !== null && link?.lastPrice !== undefined ? Number(link.lastPrice) : p.costPrice !== null ? Number(p.costPrice) : undefined);
        if (!supplierId) { missing.push(`${p.sku} (sem fornecedor)`); continue; }
        if (cost === undefined) { missing.push(`${p.sku} (sem custo)`); continue; }
        const g = groups.get(supplierId) ?? []; g.push({ productId: it.productId, quantity: it.quantity, unitCost: cost }); groups.set(supplierId, g);
      }
      if (missing.length) throw new BadRequestException(`Não foi possível gerar: ${missing.join(', ')}. Vincule o fornecedor/custo no produto ou informe na lista.`);
      const created: { id: string; number: number; supplierId: string }[] = [];
      for (const [supplierId, items] of groups) { const r = await this.purchasing.createInTx(tx, ctx, { supplierId, warehouseId: dto.warehouseId, notes: 'Gerada pela sugestão de compra', items }); created.push({ ...r, supplierId }); }
      await this.audit.record(tx, ctx, { action: 'purchase.from_suggestions', entity: 'purchase_order', metadata: { orders: created.map((c) => c.number), items: dto.items.length } });
      return { orders: created };
    });
  }

  // ───────────── cotação entre fornecedores ─────────────

  rfqList(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const rows = await tx.rfqRequest.findMany({ where: { tenantId: ctx.tenantId! }, orderBy: { number: 'desc' }, take: 100, include: { _count: { select: { items: true, suppliers: true } }, suppliers: { select: { respondedAt: true } } } });
      return rows.map(({ _count, suppliers, ...r }) => ({ ...r, items: _count.items, suppliers: _count.suppliers, responded: suppliers.filter((s) => s.respondedAt).length }));
    });
  }

  rfqCreate(ctx: AuthContext, dto: RfqDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      if (!(await tx.warehouse.findFirst({ where: { id: dto.warehouseId, tenantId: ctx.tenantId!, active: true } }))) throw new BadRequestException('Depósito inválido ou inativo.');
      const pids = dto.items.map((i) => i.productId); const sids = [...new Set(dto.supplierIds)];
      if (new Set(pids).size !== pids.length) throw new BadRequestException('Produto repetido na cotação.');
      if ((await tx.product.count({ where: { tenantId: ctx.tenantId!, id: { in: pids }, active: true, kind: 'PHYSICAL' } })) !== pids.length) throw new BadRequestException('Produto inválido, inativo ou não físico.');
      if ((await tx.supplier.count({ where: { tenantId: ctx.tenantId!, id: { in: sids }, active: true } })) !== sids.length) throw new BadRequestException('Fornecedor inválido ou inativo.');
      const number = await this.settings.nextNumber(tx, ctx, 'rfq');
      const rfq = await tx.rfqRequest.create({ data: { tenantId: ctx.tenantId!, number, warehouseId: dto.warehouseId, neededBy: dto.neededBy ? new Date(dto.neededBy) : null, notes: dto.notes, createdById: ctx.userId } });
      await tx.rfqItem.createMany({ data: dto.items.map((i) => ({ tenantId: ctx.tenantId!, rfqId: rfq.id, productId: i.productId, quantity: i.quantity })) });
      await tx.rfqSupplier.createMany({ data: sids.map((s) => ({ tenantId: ctx.tenantId!, rfqId: rfq.id, supplierId: s })) });
      await this.audit.record(tx, ctx, { action: 'rfq.created', entity: 'rfq', entityId: rfq.id, metadata: { number, items: dto.items.length, suppliers: sids.length } });
      return { id: rfq.id, number };
    });
  }

  rfqGet(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, (tx) => this.compare(tx, ctx, id));
  }

  private async compare(tx: Tx, ctx: AuthContext, id: string) {
    const rfq = await tx.rfqRequest.findFirst({ where: { id, tenantId: ctx.tenantId! }, include: { items: { include: { product: { select: { sku: true, name: true } } }, orderBy: { id: 'asc' } }, suppliers: { include: { supplier: { select: { legalName: true } }, prices: true }, orderBy: { id: 'asc' } } } });
    if (!rfq) throw new NotFoundException('Cotação não encontrada.');
    const suppliers = rfq.suppliers.map((s) => {
      const priced = rfq.items.filter((i) => s.prices.some((p) => p.productId === i.productId));
      const goods = rfq.items.reduce((sum, i) => { const p = s.prices.find((x) => x.productId === i.productId); return p ? sum + Math.round(Number(p.unitCost) * 10000) * i.quantity : sum; }, 0); // 1/10000 de real
      const goodsCents = Math.round(goods / 100);
      return { rfqSupplierId: s.id, supplierId: s.supplierId, name: s.supplier.legalName, leadTimeDays: s.leadTimeDays, freight: Number(s.freight), paymentTerms: s.paymentTerms, notes: s.notes, responded: !!s.respondedAt, pricedItems: priced.length, complete: priced.length === rfq.items.length, goods: fromCents(goodsCents), total: fromCents(goodsCents + toCents(s.freight)), prices: Object.fromEntries(s.prices.map((p) => [p.productId, Number(p.unitCost)])) };
    });
    const items = rfq.items.map((i) => {
      const offers = suppliers.filter((s) => s.prices[i.productId] !== undefined).map((s) => ({ supplierId: s.supplierId, unitCost: s.prices[i.productId], lead: s.leadTimeDays }));
      const best = offers.length ? offers.reduce((a, b) => (b.unitCost < a.unitCost || (b.unitCost === a.unitCost && (b.lead ?? 1e9) < (a.lead ?? 1e9)) ? b : a)) : null;
      return { productId: i.productId, sku: i.product.sku, name: i.product.name, quantity: i.quantity, bestSupplierId: best?.supplierId ?? null, bestUnitCost: best?.unitCost ?? null };
    });
    const complete = suppliers.filter((s) => s.complete);
    const bestSingle = complete.length ? complete.reduce((a, b) => (Number(b.total) < Number(a.total) ? b : a)) : null;
    const used = new Set(items.map((i) => i.bestSupplierId).filter(Boolean) as string[]);
    const perItemGoods = items.reduce((sum, i) => sum + (i.bestUnitCost === null ? 0 : Math.round(i.bestUnitCost * 100) * i.quantity), 0);
    const perItemFreight = suppliers.filter((s) => used.has(s.supplierId)).reduce((sum, s) => sum + toCents(s.freight), 0);
    return {
      id: rfq.id, number: rfq.number, status: rfq.status, warehouseId: rfq.warehouseId, neededBy: rfq.neededBy, notes: rfq.notes, orderIds: rfq.orderIds as string[], createdAt: rfq.createdAt,
      items, suppliers,
      bestSingleSupplierId: bestSingle?.supplierId ?? null,
      bestPerItem: items.every((i) => i.bestSupplierId) ? { total: fromCents(perItemGoods + perItemFreight), suppliers: used.size } : null,
    };
  }

  rfqProposal(ctx: AuthContext, id: string, supplierId: string, dto: ProposalDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      const rfq = await tx.rfqRequest.findFirst({ where: { id, tenantId: ctx.tenantId! }, include: { items: true } });
      if (!rfq) throw new NotFoundException('Cotação não encontrada.');
      if (rfq.status !== 'OPEN') throw new ConflictException('Esta cotação não está aberta.');
      const rs = await tx.rfqSupplier.findFirst({ where: { rfqId: id, supplierId, tenantId: ctx.tenantId! } });
      if (!rs) throw new NotFoundException('Fornecedor não participa desta cotação.');
      if (dto.prices.some((p) => !rfq.items.some((i) => i.productId === p.productId))) throw new BadRequestException('Preço de produto que não está na cotação.');
      if (new Set(dto.prices.map((p) => p.productId)).size !== dto.prices.length) throw new BadRequestException('Produto repetido nos preços.');
      await tx.rfqPrice.deleteMany({ where: { tenantId: ctx.tenantId!, rfqSupplierId: rs.id } });
      await tx.rfqPrice.createMany({ data: dto.prices.map((p) => ({ tenantId: ctx.tenantId!, rfqSupplierId: rs.id, productId: p.productId, unitCost: p.unitCost })) });
      await tx.rfqSupplier.update({ where: { id: rs.id }, data: { leadTimeDays: dto.leadTimeDays ?? null, freight: dto.freight ?? 0, paymentTerms: dto.paymentTerms ?? null, notes: dto.notes ?? null, respondedAt: dto.prices.length ? new Date() : null } });
      await this.audit.record(tx, ctx, { action: 'rfq.proposal_saved', entity: 'rfq', entityId: id, metadata: { supplierId, prices: dto.prices.length } });
      return this.compare(tx, ctx, id);
    });
  }

  /** Fecha a cotação gerando as ordens de compra: uma só (melhor total de um fornecedor completo) ou o melhor preço de cada item. */
  rfqAward(ctx: AuthContext, id: string, dto: AwardDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      await tx.$queryRaw`SELECT id FROM rfq_requests WHERE id = ${id}::uuid AND tenant_id = ${ctx.tenantId}::uuid FOR UPDATE`;
      const c = await this.compare(tx, ctx, id);
      if (c.status !== 'OPEN') throw new ConflictException('Esta cotação já foi encerrada.');
      const plan = new Map<string, { productId: string; quantity: number; unitCost: number }[]>();
      if (dto.mode === 'SINGLE') {
        const sid = dto.supplierId ?? c.bestSingleSupplierId;
        const s = c.suppliers.find((x) => x.supplierId === sid);
        if (!s) throw new BadRequestException('Escolha o fornecedor vencedor.');
        if (!s.complete) throw new ConflictException('Este fornecedor não cotou todos os itens: use “melhor preço por item” ou complete a proposta.');
        plan.set(s.supplierId, c.items.map((i) => ({ productId: i.productId, quantity: i.quantity, unitCost: s.prices[i.productId] })));
      } else {
        if (c.items.some((i) => !i.bestSupplierId)) throw new ConflictException('Há itens sem nenhum preço cotado.');
        for (const i of c.items) { const l = plan.get(i.bestSupplierId!) ?? []; l.push({ productId: i.productId, quantity: i.quantity, unitCost: i.bestUnitCost! }); plan.set(i.bestSupplierId!, l); }
      }
      const orders: { id: string; number: number; supplierId: string }[] = [];
      for (const [supplierId, items] of plan) {
        const s = c.suppliers.find((x) => x.supplierId === supplierId)!;
        const expected = s.leadTimeDays !== null ? new Date(Date.parse(`${localToday()}T12:00:00Z`) + s.leadTimeDays * DAY).toISOString().slice(0, 10) : undefined;
        const r = await this.purchasing.createInTx(tx, ctx, { supplierId, warehouseId: c.warehouseId, expectedDate: expected, freight: s.freight, notes: `Cotação #${c.number}${s.paymentTerms ? ` · ${s.paymentTerms}` : ''}`, items });
        orders.push({ ...r, supplierId });
      }
      await tx.rfqRequest.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date(), orderIds: orders.map((o) => o.id) } });
      await this.audit.record(tx, ctx, { action: 'rfq.awarded', entity: 'rfq', entityId: id, metadata: { mode: dto.mode, orders: orders.map((o) => o.number) } });
      return { orders };
    });
  }

  rfqCancel(ctx: AuthContext, id: string, reason: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const r = await tx.rfqRequest.findFirst({ where: { id, tenantId: ctx.tenantId! } });
      if (!r) throw new NotFoundException('Cotação não encontrada.');
      if (r.status !== 'OPEN') throw new ConflictException('Só cotações abertas podem ser canceladas.');
      await tx.rfqRequest.update({ where: { id }, data: { status: 'CANCELLED', closedAt: new Date(), notes: [r.notes, `Cancelada: ${reason}`].filter(Boolean).join(' · ') } });
      await this.audit.record(tx, ctx, { action: 'rfq.cancelled', entity: 'rfq', entityId: id, metadata: { reason } });
      return { id, status: 'CANCELLED' as const };
    });
  }
}

@Controller('purchases')
export class SmartPurchasingController {
  constructor(private readonly svc: SmartPurchasingService) {}

  @Get('smart-suggestions') @RequirePermissions('purchases.view')
  suggestions(@CurrentAuth() ctx: AuthContext, @Query() q: SuggestQuery) { return this.svc.suggestions(ctx, { days: q.days ? Number(q.days) : undefined, coverDays: q.coverDays ? Number(q.coverDays) : undefined, supplierId: q.supplierId }); }

  @Post('from-suggestions') @HttpCode(200) @RequirePermissions('purchases.create')
  fromSuggestions(@CurrentAuth() ctx: AuthContext, @Body() dto: FromSuggestionsDto) { return this.svc.fromSuggestions(ctx, dto); }

  @Get('rfq') @RequirePermissions('purchases.view')
  rfqList(@CurrentAuth() ctx: AuthContext) { return this.svc.rfqList(ctx); }

  @Post('rfq') @RequirePermissions('purchases.create')
  rfqCreate(@CurrentAuth() ctx: AuthContext, @Body() dto: RfqDto) { return this.svc.rfqCreate(ctx, dto); }

  @Get('rfq/:id') @RequirePermissions('purchases.view')
  rfqGet(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.rfqGet(ctx, id); }

  @Put('rfq/:id/suppliers/:supplierId') @RequirePermissions('purchases.create')
  rfqProposal(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('supplierId', ParseUUIDPipe) supplierId: string, @Body() dto: ProposalDto) { return this.svc.rfqProposal(ctx, id, supplierId, dto); }

  @Post('rfq/:id/award') @HttpCode(200) @RequirePermissions('purchases.create')
  rfqAward(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AwardDto) { return this.svc.rfqAward(ctx, id, dto); }

  @Post('rfq/:id/cancel') @HttpCode(200) @RequirePermissions('purchases.create')
  rfqCancel(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelDto) { return this.svc.rfqCancel(ctx, id, dto.reason); }
}
