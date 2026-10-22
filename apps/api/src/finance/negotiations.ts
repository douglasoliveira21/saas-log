import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { fromCents, toCents } from '../commissions/commissions.service';
import { PrismaService } from '../prisma/prisma.service';
import { localToday } from '../sales/cutoff';
import { SettingsService } from '../settings/settings.service';
import { boletoPlan } from '../sales/payment';

type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;
const money = { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false } as const;

class CreateDto {
  @IsUUID() customerId: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(200) @IsUUID('all', { each: true }) titleIds: string[];
  @IsOptional() @IsNumber(money) @Min(0) @Max(1e9) interest?: number;
  @IsOptional() @IsNumber(money) @Min(0) @Max(1e9) fine?: number;
  @IsOptional() @IsNumber(money) @Min(0) @Max(1e9) discount?: number;
  @IsInt() @Min(1) @Max(36) installments: number;
  @IsDateString() firstDueDate: string;
  @IsOptional() @IsInt() @Min(1) @Max(365) intervalDays?: number;
  @IsOptional() @IsString() @MaxLength(500) notes?: string;
}
class CancelDto { @IsString() @IsNotEmpty() @MaxLength(300) reason: string; }

/**
 * Negociação de dívida: os títulos vencidos escolhidos são substituídos por novas parcelas (boleto) com juros, multa e desconto.
 * Os originais ficam CANCELADOS ("renegociado") — sem baixa de dinheiro — e voltam a abrir se a negociação for desfeita.
 * Só entram títulos SEM pagamento parcial (para não mexer em caixa já recebido).
 * Não emite boleto bancário nem nota fiscal: gera as contas a receber (parcelas) e mostra as notas das vendas de origem.
 */
@Injectable()
export class NegotiationsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService) {}

  /** Títulos a receber em aberto do cliente que podem entrar numa negociação. */
  openTitles(ctx: AuthContext, customerId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const today = new Date(`${localToday()}T00:00:00Z`);
      const rows = await tx.financialTitle.findMany({
        where: { tenantId: ctx.tenantId!, direction: 'RECEIVABLE', customerId, status: { in: ['OPEN', 'PARTIAL'] } },
        orderBy: { dueDate: 'asc' }, select: { id: true, description: true, documentRef: true, installmentNo: true, installmentTotal: true, dueDate: true, amount: true, paidPrincipal: true },
      });
      return rows.map((t) => ({
        ...t, outstanding: fromCents(toCents(t.amount) - toCents(t.paidPrincipal)), daysLate: Math.max(0, Math.floor((today.getTime() - t.dueDate.getTime()) / DAY)),
        eligible: toCents(t.paidPrincipal) === 0, reason: toCents(t.paidPrincipal) > 0 ? 'Tem pagamento parcial: quite ou estorne antes de negociar.' : null,
      }));
    });
  }

  list(ctx: AuthContext, customerId?: string) {
    return this.prisma.withContext(ctx, (tx) =>
      tx.negotiation.findMany({
        where: { tenantId: ctx.tenantId!, ...(customerId ? { customerId } : {}) }, orderBy: { number: 'desc' }, take: 100,
        include: { customer: { select: { name: true } }, _count: { select: { titles: true } } },
      }),
    );
  }

  get(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const n = await tx.negotiation.findFirst({ where: { id, tenantId: ctx.tenantId! }, include: { customer: { select: { id: true, name: true, document: true } }, titles: { include: { title: { select: { id: true, description: true, installmentNo: true, installmentTotal: true, dueDate: true, amount: true, status: true, originRef: true, origin: true } } } } } });
      if (!n) throw new NotFoundException('Negociação não encontrada.');
      const installments = await tx.financialTitle.findMany({
        where: { tenantId: ctx.tenantId!, origin: 'NEGOTIATION', originRef: { startsWith: `${n.id}:` } }, orderBy: { installmentNo: 'asc' },
        select: { id: true, installmentNo: true, installmentTotal: true, dueDate: true, amount: true, status: true, paidPrincipal: true },
      });
      // Notas das vendas de origem (as notas de mercadoria já emitidas ou ainda por emitir).
      const orderIds = [...new Set(n.titles.map((x) => x.title).filter((t) => t.origin === 'SALES_ORDER' && t.originRef).map((t) => t.originRef!.split(':')[0]))];
      const orders = orderIds.length
        ? await tx.salesOrder.findMany({ where: { tenantId: ctx.tenantId!, id: { in: orderIds } }, select: { id: true, number: true, fiscalDocType: true, fiscalDocuments: { where: { NOT: { status: 'CANCELLED' } }, orderBy: [{ splitIndex: 'asc' }, { createdAt: 'asc' }], select: { id: true, model: true, status: true, number: true, series: true, splitIndex: true, splitTotal: true } } }, orderBy: { number: 'asc' } })
        : [];
      return { ...n, installmentsList: installments, orders };
    });
  }

  create(ctx: AuthContext, dto: CreateDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      const customer = await tx.customer.findFirst({ where: { id: dto.customerId, tenantId: ctx.tenantId! }, select: { id: true, name: true } });
      if (!customer) throw new BadRequestException('Cliente não encontrado.');
      const ids = [...new Set(dto.titleIds)];
      // trava os títulos para duas negociações simultâneas não pegarem o mesmo
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM financial_titles WHERE tenant_id = ${ctx.tenantId}::uuid AND id = ANY(${ids}::uuid[]) FOR UPDATE`;
      if (locked.length !== ids.length) throw new BadRequestException('Algum título informado não existe.');
      const titles = await tx.financialTitle.findMany({ where: { tenantId: ctx.tenantId!, id: { in: ids } } });
      for (const t of titles) {
        if (t.direction !== 'RECEIVABLE' || t.customerId !== customer.id) throw new BadRequestException('Todos os títulos devem ser contas a receber do cliente escolhido.');
        if (t.status !== 'OPEN') throw new ConflictException(`O título "${t.description}" não está em aberto${t.status === 'PARTIAL' ? ' (tem pagamento parcial: quite ou estorne antes de negociar)' : ''}.`);
        if (toCents(t.paidPrincipal) > 0) throw new ConflictException(`O título "${t.description}" tem pagamento parcial: quite ou estorne antes de negociar.`);
      }
      const original = titles.reduce((s, t) => s + toCents(t.amount), 0);
      const interest = toCents(dto.interest ?? 0); const fine = toCents(dto.fine ?? 0); const discount = toCents(dto.discount ?? 0);
      if (discount > original + interest + fine) throw new BadRequestException('O desconto não pode ser maior que o valor devido.');
      const total = original + interest + fine - discount;
      if (total <= 0) throw new BadRequestException('O valor negociado deve ser maior que zero.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dto.firstDueDate) || Number.isNaN(Date.parse(dto.firstDueDate))) throw new BadRequestException('Informe o vencimento da primeira parcela (AAAA-MM-DD).');
      if (dto.firstDueDate < localToday()) throw new BadRequestException('O vencimento da primeira parcela não pode ser anterior a hoje.');
      const interval = dto.intervalDays ?? 30;
      const number = await this.settings.nextNumber(tx, ctx, 'negotiation');
      const first = new Date(`${dto.firstDueDate}T00:00:00Z`);
      const neg = await tx.negotiation.create({
        data: {
          tenantId: ctx.tenantId!, number, customerId: customer.id, originalAmount: fromCents(original), interest: fromCents(interest), fine: fromCents(fine), discount: fromCents(discount), totalAmount: fromCents(total),
          installments: dto.installments, firstDueDate: first, intervalDays: interval, notes: dto.notes?.trim() || undefined, createdById: ctx.userId,
        },
      });
      await tx.negotiationTitle.createMany({ data: titles.map((t) => ({ tenantId: ctx.tenantId!, negotiationId: neg.id, titleId: t.id, amount: t.amount, dueDate: t.dueDate })) });
      // os originais saem do atraso sem baixa de dinheiro
      await tx.financialTitle.updateMany({ where: { tenantId: ctx.tenantId!, id: { in: ids } }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: `Renegociado na negociação ${number}` } });
      const plan = boletoPlan(total, dto.installments, first, interval);
      for (const [i, p] of plan.entries()) {
        await tx.financialTitle.create({
          data: {
            tenantId: ctx.tenantId!, direction: 'RECEIVABLE', counterpartyKind: 'CUSTOMER', customerId: customer.id, counterpartyName: customer.name, description: `Negociação ${number} — ${customer.name} (boleto)`,
            documentRef: `N${number}`, installmentNo: i + 1, installmentTotal: plan.length, issueDate: new Date(), dueDate: p.due, amount: fromCents(p.cents), origin: 'NEGOTIATION', originRef: `${neg.id}:${i + 1}`, createdById: ctx.userId,
          },
        });
      }
      await this.audit.record(tx, ctx, { action: 'finance.negotiation_created', entity: 'negotiation', entityId: neg.id, metadata: { number, customerId: customer.id, titles: ids.length, original: fromCents(original), interest: fromCents(interest), fine: fromCents(fine), discount: fromCents(discount), total: fromCents(total), installments: dto.installments } });
      return { id: neg.id, number, total: fromCents(total) };
    });
  }

  /** Desfaz a negociação: cancela as parcelas novas (nenhuma pode ter pagamento) e reabre os títulos originais. */
  cancel(ctx: AuthContext, id: string, reason: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      await tx.$queryRaw`SELECT id FROM negotiations WHERE id = ${id}::uuid AND tenant_id = ${ctx.tenantId}::uuid FOR UPDATE`;
      const n = await tx.negotiation.findFirst({ where: { id, tenantId: ctx.tenantId! }, include: { titles: true } });
      if (!n) throw new NotFoundException('Negociação não encontrada.');
      if (n.status === 'CANCELLED') throw new ConflictException('A negociação já foi desfeita.');
      const news = await tx.financialTitle.findMany({ where: { tenantId: ctx.tenantId!, origin: 'NEGOTIATION', originRef: { startsWith: `${n.id}:` } } });
      if (news.some((t) => toCents(t.paidPrincipal) > 0)) throw new ConflictException('Há parcelas desta negociação já pagas: estorne a baixa no Financeiro antes de desfazer.');
      await tx.financialTitle.updateMany({ where: { tenantId: ctx.tenantId!, id: { in: news.map((t) => t.id) } }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: `Negociação ${n.number} desfeita: ${reason}` } });
      await tx.financialTitle.updateMany({ where: { tenantId: ctx.tenantId!, id: { in: n.titles.map((t) => t.titleId) } }, data: { status: 'OPEN', cancelledAt: null, cancelReason: null } });
      await tx.negotiation.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason } });
      await this.audit.record(tx, ctx, { action: 'finance.negotiation_cancelled', entity: 'negotiation', entityId: id, metadata: { number: n.number, reason } });
      return { id, status: 'CANCELLED' as const };
    });
  }
}

@Controller('finance/negotiations')
export class NegotiationsController {
  constructor(private readonly svc: NegotiationsService) {}

  @Get() @RequirePermissions('finance.view')
  list(@CurrentAuth() ctx: AuthContext) { return this.svc.list(ctx); }

  @Get('open-titles/:customerId') @RequirePermissions('finance.view')
  openTitles(@CurrentAuth() ctx: AuthContext, @Param('customerId', ParseUUIDPipe) customerId: string) { return this.svc.openTitles(ctx, customerId); }

  @Get(':id') @RequirePermissions('finance.view')
  get(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.svc.get(ctx, id); }

  @Post() @RequirePermissions('finance.manage')
  create(@CurrentAuth() ctx: AuthContext, @Body() dto: CreateDto) { return this.svc.create(ctx, dto); }

  @Post(':id/cancel') @HttpCode(200) @RequirePermissions('finance.manage')
  cancel(@CurrentAuth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelDto) { return this.svc.cancel(ctx, id, dto.reason); }
}
