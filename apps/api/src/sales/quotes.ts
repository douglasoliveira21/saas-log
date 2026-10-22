import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { FiscalDocChoice, Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { localToday } from './cutoff';
import { PAYMENT_METHODS } from './payment';
import { SalesService } from './sales.service';

type Tx = Prisma.TransactionClient;
const money = { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false } as const;

class QuoteItemDto {
  @IsUUID() productId: string;
  @IsInt() @Min(1) @Max(1_000_000) quantity: number;
  @IsOptional() @IsNumber(money) @Min(0) unitPrice?: number;
  @IsOptional() @IsNumber(money) @Min(0) @Max(100) discountPct?: number;
}
class QuoteDto {
  @IsUUID() customerId: string;
  @IsUUID() warehouseId: string;
  @IsOptional() @IsUUID() salespersonId?: string;
  @IsOptional() @IsDateString() validUntil?: string;
  @IsOptional() @IsInt() @Min(1) @Max(180) validDays?: number;
  @IsOptional() @IsIn(PAYMENT_METHODS) paymentMethod?: (typeof PAYMENT_METHODS)[number];
  @IsOptional() @IsNumber(money) @Min(0) shipping?: number;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => QuoteItemDto) items: QuoteItemDto[];
}
class ConvertDto {
  @IsIn(PAYMENT_METHODS) paymentMethod: (typeof PAYMENT_METHODS)[number];
  @IsOptional() @IsInt() @Min(1) @Max(36) installments?: number;
  @IsOptional() @IsDateString() firstDueDate?: string;
  @IsOptional() @IsInt() @Min(1) @Max(365) intervalDays?: number;
  @IsOptional() @IsEnum(FiscalDocChoice) fiscalDocType?: FiscalDocChoice;
  @IsOptional() @IsBoolean() confirm?: boolean;
}
class LostDto { @IsString() @IsNotEmpty() @MaxLength(300) reason: string; }
class ListQuery {
  @IsOptional() @IsIn(['OPEN', 'CONVERTED', 'LOST', 'EXPIRED']) status?: string;
  @IsOptional() @IsString() @MaxLength(80) search?: string;
}

/**
 * Orçamento (cotação): fixa preços e descontos do vendedor por um prazo de validade, sem reservar estoque nem gerar cobrança.
 * Ao converter vira um pedido (rascunho ou já confirmado) com exatamente os mesmos itens e preços.
 */
@Injectable()
export class QuotesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly sales: SalesService, private readonly settings: SettingsService) {}

  private async scope(tx: Tx, ctx: AuthContext): Promise<Prisma.QuoteWhereInput> {
    if (ctx.permissions.has('sales.view_all')) return {};
    const mine = await tx.salesperson.findFirst({ where: { tenantId: ctx.tenantId!, userId: ctx.userId }, select: { id: true } });
    return { OR: [{ createdById: ctx.userId }, ...(mine ? [{ salespersonId: mine.id }] : [])] };
  }
  private view<T extends { status: string; validUntil: Date }>(q: T) {
    const expired = q.status === 'OPEN' && q.validUntil.toISOString().slice(0, 10) < localToday();
    return { ...q, expired, displayStatus: expired ? 'EXPIRED' : q.status };
  }
  private validUntil(dto: { validUntil?: string; validDays?: number }): Date {
    const iso = dto.validUntil ? dto.validUntil.slice(0, 10) : new Date(Date.parse(`${localToday()}T12:00:00Z`) + (dto.validDays ?? 7) * 86_400_000).toISOString().slice(0, 10);
    if (iso < localToday()) throw new BadRequestException('A validade do orçamento não pode ser anterior a hoje.');
    return new Date(`${iso}T00:00:00Z`);
  }

  list(ctx: AuthContext, q: ListQuery) {
    return this.prisma.withContext(ctx, async (tx) => {
      const num = q.search && /^\d+$/.test(q.search) ? Number(q.search) : undefined;
      const today = new Date(`${localToday()}T00:00:00Z`);
      const rows = await tx.quote.findMany({
        where: {
          tenantId: ctx.tenantId!, AND: [await this.scope(tx, ctx)],
          ...(q.status === 'EXPIRED' ? { status: 'OPEN', validUntil: { lt: today } } : q.status === 'OPEN' ? { status: 'OPEN', validUntil: { gte: today } } : q.status ? { status: q.status } : {}),
          ...(q.search ? { OR: [...(num ? [{ number: num }] : []), { customer: { name: { contains: q.search, mode: 'insensitive' as const } } }] } : {}),
        },
        orderBy: { number: 'desc' }, take: 200, include: { customer: { select: { name: true } } },
      });
      return rows.map((r) => this.view(r));
    });
  }

  get(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const q = await tx.quote.findFirst({
        where: { id, tenantId: ctx.tenantId!, AND: [await this.scope(tx, ctx)] },
        include: { customer: { select: { id: true, name: true, document: true, phone: true, email: true } }, items: { include: { product: { select: { sku: true, name: true, saleUnit: true } } }, orderBy: { id: 'asc' } } },
      });
      if (!q) throw new NotFoundException('Orçamento não encontrado.');
      const order = q.orderId ? await tx.salesOrder.findFirst({ where: { id: q.orderId, tenantId: ctx.tenantId! }, select: { id: true, number: true, status: true } }) : null;
      return { ...this.view(q), order };
    });
  }

  create(ctx: AuthContext, dto: QuoteDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      const validUntil = this.validUntil(dto);
      const priced = await this.sales.priceItems(tx, ctx, { customerId: dto.customerId, warehouseId: dto.warehouseId, salespersonId: dto.salespersonId, shipping: dto.shipping, items: dto.items }, { skipDelinquency: true });
      const number = await this.settings.nextNumber(tx, ctx, 'quote');
      const q = await tx.quote.create({
        data: { tenantId: ctx.tenantId!, number, customerId: dto.customerId, salespersonId: priced.salespersonId, warehouseId: dto.warehouseId, validUntil, paymentMethod: dto.paymentMethod, notes: dto.notes, createdById: ctx.userId, ...priced.totals },
      });
      await tx.quoteItem.createMany({ data: priced.rows.map((r) => ({ tenantId: ctx.tenantId!, quoteId: q.id, productId: r.productId, quantity: r.quantity, unitPrice: r.unitPrice, discountPct: r.discountPct, total: r.total })) });
      await this.audit.record(tx, ctx, { action: 'quotes.created', entity: 'quote', entityId: q.id, metadata: { number, total: priced.totals.total } });
      return { id: q.id, number };
    });
  }

  update(ctx: AuthContext, id: string, dto: QuoteDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      const q = await this.lock(tx, ctx, id);
      if (q.status !== 'OPEN') throw new ConflictException('Só orçamentos em aberto podem ser editados.');
      const validUntil = dto.validUntil || dto.validDays ? this.validUntil(dto) : q.validUntil;
      const priced = await this.sales.priceItems(tx, ctx, { customerId: dto.customerId, warehouseId: dto.warehouseId, salespersonId: dto.salespersonId, shipping: dto.shipping, items: dto.items }, { skipDelinquency: true });
      await tx.quoteItem.deleteMany({ where: { tenantId: ctx.tenantId!, quoteId: id } });
      await tx.quote.update({ where: { id }, data: { customerId: dto.customerId, warehouseId: dto.warehouseId, salespersonId: priced.salespersonId, validUntil, paymentMethod: dto.paymentMethod ?? null, notes: dto.notes ?? null, ...priced.totals } });
      await tx.quoteItem.createMany({ data: priced.rows.map((r) => ({ tenantId: ctx.tenantId!, quoteId: id, productId: r.productId, quantity: r.quantity, unitPrice: r.unitPrice, discountPct: r.discountPct, total: r.total })) });
      await this.audit.record(tx, ctx, { action: 'quotes.updated', entity: 'quote', entityId: id, metadata: { total: priced.totals.total } });
      return { id };
    });
  }

  lost(ctx: AuthContext, id: string, reason: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const q = await this.lock(tx, ctx, id);
      if (q.status !== 'OPEN') throw new ConflictException('Só orçamentos em aberto podem ser marcados como perdidos.');
      await tx.quote.update({ where: { id }, data: { status: 'LOST', lostReason: reason } });
      await this.audit.record(tx, ctx, { action: 'quotes.lost', entity: 'quote', entityId: id, metadata: { reason } });
      return { id, status: 'LOST' as const };
    });
  }

  /** Converte em pedido com os mesmos itens e preços. Tudo na mesma transação: ou vira pedido (e o orçamento fecha), ou nada muda. */
  convert(ctx: AuthContext, id: string, dto: ConvertDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      const q = await this.lock(tx, ctx, id);
      if (q.status === 'CONVERTED') throw new ConflictException('Este orçamento já virou pedido.');
      if (q.status !== 'OPEN') throw new ConflictException('Este orçamento foi marcado como perdido.');
      if (q.validUntil.toISOString().slice(0, 10) < localToday()) throw new ConflictException('Orçamento vencido: edite a validade (e confira os preços) antes de converter.');
      const items = await tx.quoteItem.findMany({ where: { tenantId: ctx.tenantId!, quoteId: id }, orderBy: { id: 'asc' } });
      const created = await this.sales.createInTx(tx, ctx, {
        customerId: q.customerId, warehouseId: q.warehouseId, salespersonId: q.salespersonId ?? undefined, shipping: Number(q.shipping), notes: [q.notes, `Orçamento #${q.number}`].filter(Boolean).join(' · '),
        paymentMethod: dto.paymentMethod, installments: dto.installments, firstDueDate: dto.firstDueDate, intervalDays: dto.intervalDays, fiscalDocType: dto.fiscalDocType,
        items: items.map((i) => ({ productId: i.productId, quantity: i.quantity, unitPrice: Number(i.unitPrice), discountPct: Number(i.discountPct) })),
      });
      let status: string = 'DRAFT'; let reasons: string[] = [];
      if (dto.confirm) { const r = await this.sales.submitInTx(tx, ctx, created.id); status = r.status; reasons = r.reasons; }
      await tx.quote.update({ where: { id }, data: { status: 'CONVERTED', orderId: created.id } });
      await this.audit.record(tx, ctx, { action: 'quotes.converted', entity: 'quote', entityId: id, metadata: { orderId: created.id, orderNumber: created.number, status } });
      return { id, orderId: created.id, orderNumber: created.number, orderStatus: status, reasons };
    });
  }

  private async lock(tx: Tx, ctx: AuthContext, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM quotes WHERE id = ${id}::uuid AND tenant_id = ${ctx.tenantId}::uuid FOR UPDATE`;
    const q = rows.length ? await tx.quote.findFirst({ where: { id, tenantId: ctx.tenantId!, AND: [await this.scope(tx, ctx)] } }) : null;
    if (!q) throw new NotFoundException('Orçamento não encontrado.');
    return q;
  }
}

@Controller('quotes')
export class QuotesController {
  constructor(private readonly svc: QuotesService) {}

  @Get() @RequirePermissions('sales.view')
  list(@CurrentAuth() ctx: AuthContext, @Query() q: ListQuery) { return this.svc.list(ctx, q); }

  @Get(':id') @RequirePermissions('sales.view')
  get(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.get(ctx, id); }

  @Post() @RequirePermissions('sales.create')
  create(@CurrentAuth() ctx: AuthContext, @Body() dto: QuoteDto) { return this.svc.create(ctx, dto); }

  @Put(':id') @RequirePermissions('sales.create')
  update(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: QuoteDto) { return this.svc.update(ctx, id, dto); }

  @Post(':id/convert') @HttpCode(200) @RequirePermissions('sales.create')
  convert(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ConvertDto) { return this.svc.convert(ctx, id, dto); }

  @Post(':id/lost') @HttpCode(200) @RequirePermissions('sales.create')
  lost(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LostDto) { return this.svc.lost(ctx, id, dto.reason); }
}
