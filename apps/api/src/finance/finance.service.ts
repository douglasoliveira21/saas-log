import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/auth';
import { fromCents, toCents } from '../commissions/commissions.service';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';

type Tx = Prisma.TransactionClient;
export const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
const addMonths = (d: Date, n: number) => { const r = new Date(d); r.setUTCMonth(r.getUTCMonth() + n); return r; };

export interface TitleInput {
  direction: 'PAYABLE' | 'RECEIVABLE';
  description: string;
  amount: number;
  dueDate: string;
  supplierId?: string;
  customerId?: string;
  counterpartyName?: string;
  documentRef?: string;
  categoryId?: string;
  costCenterId?: string;
  issueDate?: string;
  notes?: string;
  /** SINGLE (padrão), SPLIT (parcelamento do valor total) ou RECURRING (mesmo valor todo mês). */
  mode?: 'SINGLE' | 'SPLIT' | 'RECURRING';
  count?: number;
  intervalDays?: number;
}

/** Divide `total` (centavos) em `n` partes; a última absorve o arredondamento. */
export function splitCents(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? total - base * (n - 1) : base));
}

@Injectable()
export class FinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  // ───────────── cadastros ─────────────

  async listAccounts(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const accounts = await tx.financialAccount.findMany({ where: { tenantId: ctx.tenantId! }, orderBy: { createdAt: 'asc' } });
      const sums = await tx.$queryRaw<{ account_id: string; net: string }[]>`
        SELECT s.account_id, sum(CASE t.direction WHEN 'RECEIVABLE' THEN s.amount ELSE -s.amount END) AS net
        FROM financial_settlements s JOIN financial_titles t ON t.id = s.title_id WHERE s.tenant_id = ${ctx.tenantId}::uuid GROUP BY s.account_id`;
      const byId = new Map(sums.map((s) => [s.account_id, toCents(s.net)]));
      const seeBank = ctx.permissions.has('finance.manage');
      return accounts.map((a) => ({
        id: a.id, name: a.name, kind: a.kind, active: a.active, openingBalance: a.openingBalance.toString(), openingDate: a.openingDate,
        balance: fromCents(toCents(a.openingBalance) + (byId.get(a.id) ?? 0)),
        // dados bancários: somente quem gerencia o financeiro
        ...(seeBank ? { bankName: a.bankName, agency: a.agency, accountNumber: a.accountNumber } : {}),
      }));
    });
  }

  createAccount(ctx: AuthContext, dto: { name: string; kind: string; bankName?: string; agency?: string; accountNumber?: string; openingBalance?: number; openingDate?: string }) {
    return this.prisma.withContext(ctx, async (tx) => {
      const row = await tx.financialAccount
        .create({ data: { tenantId: ctx.tenantId!, name: dto.name.trim(), kind: dto.kind, bankName: dto.bankName, agency: dto.agency, accountNumber: dto.accountNumber, openingBalance: (dto.openingBalance ?? 0).toFixed(2), openingDate: dto.openingDate ? new Date(dto.openingDate) : new Date() } })
        .catch(uniq('Já existe uma conta com este nome.'));
      await this.audit.record(tx, ctx, { action: 'finance.account_created', entity: 'financial_account', entityId: row.id, metadata: { name: row.name, kind: row.kind, openingBalance: dto.openingBalance ?? 0 } });
      return { id: row.id };
    });
  }

  setAccountActive(ctx: AuthContext, id: string, active: boolean) {
    return this.prisma.withContext(ctx, async (tx) => {
      if (!(await tx.financialAccount.findFirst({ where: { id, tenantId: ctx.tenantId! } }))) throw new NotFoundException('Conta não encontrada.');
      await tx.financialAccount.update({ where: { id }, data: { active } });
      await this.audit.record(tx, ctx, { action: active ? 'finance.account_enabled' : 'finance.account_disabled', entity: 'financial_account', entityId: id });
      return { id, active };
    });
  }

  listCategories(ctx: AuthContext) { return this.prisma.withContext(ctx, (tx) => tx.financialCategory.findMany({ where: { tenantId: ctx.tenantId! }, orderBy: { name: 'asc' } })); }
  createCategory(ctx: AuthContext, dto: { name: string; kind: string }) {
    return this.prisma.withContext(ctx, async (tx) => {
      const row = await tx.financialCategory.create({ data: { tenantId: ctx.tenantId!, name: dto.name.trim(), kind: dto.kind } }).catch(uniq('Já existe uma categoria com este nome.'));
      await this.audit.record(tx, ctx, { action: 'finance.category_created', entity: 'financial_category', entityId: row.id, metadata: dto });
      return row;
    });
  }
  listCostCenters(ctx: AuthContext) { return this.prisma.withContext(ctx, (tx) => tx.costCenter.findMany({ where: { tenantId: ctx.tenantId! }, orderBy: { name: 'asc' } })); }
  createCostCenter(ctx: AuthContext, name: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const row = await tx.costCenter.create({ data: { tenantId: ctx.tenantId!, name: name.trim() } }).catch(uniq('Já existe um centro de custo com este nome.'));
      await this.audit.record(tx, ctx, { action: 'finance.cost_center_created', entity: 'cost_center', entityId: row.id, metadata: { name } });
      return row;
    });
  }

  // ───────────── títulos ─────────────

  list(ctx: AuthContext, q: { direction?: string; status?: string; overdue?: boolean; from?: string; to?: string; search?: string; categoryId?: string; costCenterId?: string; origin?: string; limit?: number; offset?: number }) {
    return this.prisma.withContext(ctx, async (tx) => {
      const today = startOfDay(new Date());
      const where: Prisma.FinancialTitleWhereInput = {
        tenantId: ctx.tenantId!, ...(q.direction ? { direction: q.direction } : {}), ...(q.categoryId ? { categoryId: q.categoryId } : {}), ...(q.costCenterId ? { costCenterId: q.costCenterId } : {}), ...(q.origin ? { origin: q.origin } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.overdue ? { status: { in: ['OPEN', 'PARTIAL'] }, dueDate: { lt: today } } : {}),
        ...(q.from || q.to ? { dueDate: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}), ...(q.overdue ? { lt: today } : {}) } } : {}),
        ...(q.search ? { OR: [{ description: { contains: q.search, mode: 'insensitive' } }, { counterpartyName: { contains: q.search, mode: 'insensitive' } }, { documentRef: { contains: q.search, mode: 'insensitive' } }] } : {}),
      };
      const [rows, total] = await Promise.all([
        tx.financialTitle.findMany({ where, orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }], take: q.limit ?? 100, skip: q.offset ?? 0, include: { category: { select: { name: true } }, costCenter: { select: { name: true } } } }),
        tx.financialTitle.count({ where }),
      ]);
      return { total, items: rows.map((t) => this.view(t, today)) };
    });
  }

  private view(t: Prisma.FinancialTitleGetPayload<object> & { category?: { name: string } | null; costCenter?: { name: string } | null }, today = startOfDay(new Date())) {
    const outstanding = fromCents(toCents(t.amount) - toCents(t.paidPrincipal));
    const open = t.status === 'OPEN' || t.status === 'PARTIAL';
    return { ...t, outstanding, overdue: open && t.dueDate < today, daysOverdue: open && t.dueDate < today ? Math.floor((today.getTime() - t.dueDate.getTime()) / 86_400_000) : 0 };
  }

  async get(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const t = await tx.financialTitle.findFirst({ where: { id, tenantId: ctx.tenantId! }, include: { category: { select: { name: true } }, costCenter: { select: { name: true } }, settlements: { orderBy: { createdAt: 'asc' }, include: { account: { select: { name: true } } } } } });
      if (!t) throw new NotFoundException('Título não encontrado.');
      return { ...this.view(t), settlements: t.settlements };
    });
  }

  summary(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const today = startOfDay(new Date());
      const rows = await tx.$queryRaw<{ direction: string; bucket: string; total: string }[]>`
        SELECT direction,
               CASE WHEN due_date < ${today} THEN 'overdue' WHEN due_date < ${addDays(today, 8)} THEN 'next7' ELSE 'later' END AS bucket,
               sum(amount - paid_principal) AS total
        FROM financial_titles WHERE tenant_id = ${ctx.tenantId}::uuid AND status IN ('OPEN','PARTIAL') GROUP BY 1, 2`;
      const out: Record<string, Record<string, string>> = { PAYABLE: { overdue: '0.00', next7: '0.00', later: '0.00' }, RECEIVABLE: { overdue: '0.00', next7: '0.00', later: '0.00' } };
      for (const r of rows) out[r.direction][r.bucket] = Number(r.total).toFixed(2);
      return out;
    });
  }

  /** Lançamento manual: único, parcelado (divide o total) ou recorrente (mesmo valor, mensal). */
  create(ctx: AuthContext, dto: TitleInput) {
    return this.prisma.withContext(ctx, async (tx) => {
      await this.validateRefs(tx, ctx, dto);
      const mode = dto.mode ?? 'SINGLE';
      const n = mode === 'SINGLE' ? 1 : Math.max(2, Math.min(dto.count ?? 2, 60));
      const total = toCents(dto.amount);
      if (total <= 0) throw new BadRequestException('O valor deve ser positivo.');
      const parts = mode === 'SPLIT' ? splitCents(total, n) : Array(n).fill(total);
      const first = new Date(dto.dueDate);
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const due = mode === 'RECURRING' ? addMonths(first, i) : addDays(first, i * (dto.intervalDays ?? 30));
        const t = await tx.financialTitle.create({
          data: {
            tenantId: ctx.tenantId!, direction: dto.direction, description: dto.description.trim(), amount: fromCents(parts[i]), dueDate: due, issueDate: dto.issueDate ? new Date(dto.issueDate) : null,
            counterpartyKind: dto.supplierId ? 'SUPPLIER' : dto.customerId ? 'CUSTOMER' : 'OTHER', supplierId: dto.supplierId, customerId: dto.customerId, counterpartyName: dto.counterpartyName,
            documentRef: dto.documentRef, categoryId: dto.categoryId, costCenterId: dto.costCenterId, notes: dto.notes, installmentNo: i + 1, installmentTotal: n, createdById: ctx.userId,
          },
        });
        ids.push(t.id);
      }
      await this.audit.record(tx, ctx, { action: 'finance.title_created', entity: 'financial_title', entityId: ids[0], metadata: { direction: dto.direction, mode, count: n, total: fromCents(total) } });
      return { ids };
    });
  }

  private async validateRefs(tx: Tx, ctx: AuthContext, dto: { supplierId?: string; customerId?: string; categoryId?: string; costCenterId?: string }) {
    const t = ctx.tenantId!;
    if (dto.supplierId && !(await tx.supplier.findFirst({ where: { id: dto.supplierId, tenantId: t }, select: { id: true } }))) throw new BadRequestException('Fornecedor inválido.');
    if (dto.customerId && !(await tx.customer.findFirst({ where: { id: dto.customerId, tenantId: t }, select: { id: true } }))) throw new BadRequestException('Cliente inválido.');
    if (dto.categoryId && !(await tx.financialCategory.findFirst({ where: { id: dto.categoryId, tenantId: t, active: true }, select: { id: true } }))) throw new BadRequestException('Categoria inválida.');
    if (dto.costCenterId && !(await tx.costCenter.findFirst({ where: { id: dto.costCenterId, tenantId: t, active: true }, select: { id: true } }))) throw new BadRequestException('Centro de custo inválido.');
  }

  /** Aprovação de pagamento acima do limite (segregação: quem lançou não aprova, exceto o proprietário). */
  approve(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const t = await this.lock(tx, ctx, id);
      if (t.direction !== 'PAYABLE') throw new BadRequestException('Somente contas a pagar são aprovadas.');
      if (t.approvedAt) throw new ConflictException('O título já foi aprovado.');
      if (t.createdById === ctx.userId && !ctx.permissions.has('tenant.manage')) throw new ForbiddenException('A aprovação deve ser feita por outra pessoa.');
      await tx.financialTitle.update({ where: { id }, data: { approvedById: ctx.userId, approvedAt: new Date() } });
      await this.audit.record(tx, ctx, { action: 'finance.title_approved', entity: 'financial_title', entityId: id, metadata: { amount: t.amount.toString() } });
      return { id, approved: true };
    });
  }

  cancel(ctx: AuthContext, id: string, reason: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const t = await this.lock(tx, ctx, id);
      if (t.status === 'CANCELLED') throw new ConflictException('O título já está cancelado.');
      if (toCents(t.paidPrincipal) !== 0) throw new ConflictException('O título possui baixas: estorne-as antes de cancelar.');
      await tx.financialTitle.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason } });
      if (t.origin === 'COMMISSION') { await tx.salesCommission.updateMany({ where: { tenantId: ctx.tenantId!, payoutTitleId: id }, data: { payoutTitleId: null } }); await tx.goalBonus.updateMany({ where: { tenantId: ctx.tenantId!, payoutTitleId: id }, data: { payoutTitleId: null } }); } // libera as comissões
      await this.audit.record(tx, ctx, { action: 'finance.title_cancelled', entity: 'financial_title', entityId: id, metadata: { reason, origin: t.origin } });
      return { id, status: 'CANCELLED' as const };
    });
  }

  // ───────────── baixas ─────────────

  /**
   * Baixa (pagamento/recebimento) total ou parcial. principal = dinheiro − juros − multa + desconto.
   * `expectedOutstanding` (opcional) protege contra baixa duplicada por duplo clique/tela desatualizada.
   */
  settle(ctx: AuthContext, id: string, dto: { accountId: string; amount: number; interest?: number; fine?: number; discount?: number; paidAt?: string; note?: string; expectedOutstanding?: number }) {
    return this.prisma.withContext(ctx, async (tx) => {
      const t = await this.lock(tx, ctx, id);
      if (!['OPEN', 'PARTIAL'].includes(t.status)) throw new ConflictException(`O título está "${t.status}" e não aceita baixa.`);
      const account = await tx.financialAccount.findFirst({ where: { id: dto.accountId, tenantId: ctx.tenantId!, active: true } });
      if (!account) throw new BadRequestException('Conta financeira inválida ou inativa.');
      const outstanding = toCents(t.amount) - toCents(t.paidPrincipal);
      if (dto.expectedOutstanding !== undefined && toCents(dto.expectedOutstanding) !== outstanding) throw new ConflictException({ message: 'O saldo do título mudou. Recarregue e confira antes de baixar.', outstanding: fromCents(outstanding) });
      if (t.direction === 'PAYABLE') {
        const limit = Math.round((await this.settings.load(tx, ctx))['finance.paymentApprovalLimit'] * 100);
        if (toCents(t.amount) > limit && !t.approvedAt) throw new ConflictException({ message: 'Título acima do limite de aprovação: aguarde a aprovação de outra pessoa.', requiresApproval: true });
      }
      const amount = toCents(dto.amount);
      const interest = toCents(dto.interest ?? 0);
      const fine = toCents(dto.fine ?? 0);
      const discount = toCents(dto.discount ?? 0);
      const principal = amount - interest - fine + discount;
      if (amount <= 0 || principal <= 0) throw new BadRequestException('Valores inválidos: o principal baixado deve ser positivo.');
      if (principal > outstanding) throw new ConflictException(`O valor baixado (${fromCents(principal)}) excede o saldo do título (${fromCents(outstanding)}).`);
      const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
      const s = await tx.financialSettlement.create({
        data: { tenantId: ctx.tenantId!, titleId: id, accountId: dto.accountId, amount: fromCents(amount), principal: fromCents(principal), interest: fromCents(interest), fine: fromCents(fine), discount: fromCents(discount), paidAt, note: dto.note, createdById: ctx.userId },
      });
      const paid = toCents(t.paidPrincipal) + principal;
      const status = paid === toCents(t.amount) ? 'PAID' : 'PARTIAL';
      await tx.financialTitle.update({ where: { id }, data: { paidPrincipal: fromCents(paid), status } });
      if (status === 'PAID' && t.origin === 'COMMISSION') await tx.salesCommission.updateMany({ where: { tenantId: ctx.tenantId!, payoutTitleId: id, status: 'EARNED' }, data: { status: 'PAID', paidAt } });
      if (status === 'PAID' && t.origin === 'COMMISSION') await tx.goalBonus.updateMany({ where: { tenantId: ctx.tenantId!, payoutTitleId: id, status: 'EARNED' }, data: { status: 'PAID', paidAt } });
      await this.audit.record(tx, ctx, { action: t.direction === 'PAYABLE' ? 'finance.payment_made' : 'finance.receipt_received', entity: 'financial_title', entityId: id, metadata: { settlementId: s.id, amount: fromCents(amount), principal: fromCents(principal), interest: fromCents(interest), fine: fromCents(fine), discount: fromCents(discount), accountId: dto.accountId } });
      return { settlementId: s.id, status, outstanding: fromCents(toCents(t.amount) - paid) };
    });
  }

  /** Estorno auditável de uma baixa: cria lançamento inverso (a baixa original permanece no histórico). */
  reverse(ctx: AuthContext, settlementId: string, reason: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const s = await tx.financialSettlement.findFirst({ where: { id: settlementId, tenantId: ctx.tenantId! } });
      if (!s) throw new NotFoundException('Baixa não encontrada.');
      if (s.kind !== 'SETTLEMENT') throw new BadRequestException('Não é possível estornar um estorno.');
      const t = await this.lock(tx, ctx, s.titleId);
      if (await tx.bankStatementLine.findFirst({ where: { settlementId, tenantId: ctx.tenantId! } })) throw new ConflictException('A baixa está conciliada com o extrato: desfaça a conciliação primeiro.');
      const rev = await tx.financialSettlement
        .create({
          data: {
            tenantId: ctx.tenantId!, titleId: s.titleId, accountId: s.accountId, kind: 'REVERSAL', reversalOfId: s.id, amount: s.amount.negated().toString(), principal: s.principal.negated().toString(), interest: s.interest.negated().toString(),
            fine: s.fine.negated().toString(), discount: s.discount.negated().toString(), paidAt: new Date(), note: reason, createdById: ctx.userId,
          },
        })
        .catch((e) => { if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('Esta baixa já foi estornada.'); throw e; });
      const paid = toCents(t.paidPrincipal) - toCents(s.principal);
      await tx.financialTitle.update({ where: { id: s.titleId }, data: { paidPrincipal: fromCents(paid), status: t.status === 'CANCELLED' ? 'CANCELLED' : paid === 0 ? 'OPEN' : 'PARTIAL' } });
      if (t.origin === 'COMMISSION') await tx.salesCommission.updateMany({ where: { tenantId: ctx.tenantId!, payoutTitleId: s.titleId, status: 'PAID' }, data: { status: 'EARNED', paidAt: null } });
      if (t.origin === 'COMMISSION') await tx.goalBonus.updateMany({ where: { tenantId: ctx.tenantId!, payoutTitleId: s.titleId, status: 'PAID' }, data: { status: 'EARNED', paidAt: null } });
      await this.audit.record(tx, ctx, { action: 'finance.settlement_reversed', entity: 'financial_settlement', entityId: settlementId, metadata: { reversalId: rev.id, reason, amount: s.amount.toString(), titleId: s.titleId } });
      return { reversalId: rev.id, titleStatus: paid === 0 ? 'OPEN' : 'PARTIAL' };
    });
  }

  // ───────────── geração a partir de outros módulos ─────────────

  /** Contas a pagar a partir das duplicatas do XML (idempotente por nota+duplicata). */
  fromXml(ctx: AuthContext, docId: string, dto: { categoryId?: string; costCenterId?: string; dueDate?: string }) {
    return this.prisma.withContext(ctx, async (tx) => {
      const doc = await tx.fiscalDocument.findFirst({ where: { id: docId, tenantId: ctx.tenantId!, direction: 'ENTRY' } });
      if (!doc) throw new NotFoundException('Documento fiscal não encontrado.');
      if (!doc.supplierId) throw new ConflictException('Vincule o fornecedor da nota antes de gerar as contas a pagar.');
      if (doc.environment === 'HOMOLOGACAO') throw new ConflictException('Nota de homologação não gera contas a pagar.');
      await this.validateRefs(tx, ctx, { categoryId: dto.categoryId, costCenterId: dto.costCenterId });
      const dups = (doc.installments as { number: string; dueDate: string | null; value: number }[]) ?? [];
      const plan = dups.length
        ? dups.map((d, i) => ({ ref: `${doc.accessKey}:${d.number || i + 1}`, due: d.dueDate ? new Date(d.dueDate) : null, cents: toCents(d.value) }))
        : [{ ref: `${doc.accessKey}:1`, due: dto.dueDate ? new Date(dto.dueDate) : null, cents: toCents(doc.totalInvoice ?? 0) }];
      if (plan.some((p) => !p.due)) throw new BadRequestException('Alguma duplicata não tem vencimento no XML: informe `dueDate`.');
      if (plan.reduce((s, p) => s + p.cents, 0) !== toCents(doc.totalInvoice ?? 0)) throw new ConflictException('As duplicatas do XML não somam o valor da nota: lance as contas manualmente.');
      const created: string[] = [];
      let existing = 0;
      for (const [i, p] of plan.entries()) {
        const found = await tx.financialTitle.findUnique({ where: { tenantId_origin_originRef: { tenantId: ctx.tenantId!, origin: 'FISCAL_XML', originRef: p.ref } } });
        if (found) { existing++; continue; }
        const t = await tx.financialTitle.create({
          data: {
            tenantId: ctx.tenantId!, direction: 'PAYABLE', counterpartyKind: 'SUPPLIER', supplierId: doc.supplierId, counterpartyName: doc.emitterName, description: `NF-e ${doc.number}/${doc.series} — ${doc.emitterName ?? ''}`.trim(),
            documentRef: doc.accessKey, installmentNo: i + 1, installmentTotal: plan.length, issueDate: doc.issuedAt, dueDate: p.due!, amount: fromCents(p.cents), categoryId: dto.categoryId, costCenterId: dto.costCenterId,
            origin: 'FISCAL_XML', originRef: p.ref, createdById: ctx.userId,
          },
        });
        created.push(t.id);
      }
      await this.audit.record(tx, ctx, { action: 'finance.payables_from_xml', entity: 'fiscal_document', entityId: docId, metadata: { created: created.length, existing } });
      return { created: created.length, alreadyExisting: existing, ids: created };
    });
  }

  /** Contas a receber de um pedido (a soma das parcelas deve fechar com o total do pedido). Pedidos de marketplace entram pela conciliação. */
  fromOrder(ctx: AuthContext, orderId: string, dto: { installments?: { dueDate: string; amount: number }[]; count?: number; firstDueDate?: string; intervalDays?: number; categoryId?: string }) {
    return this.prisma.withContext(ctx, async (tx) => {
      const o = await tx.salesOrder.findFirst({ where: { id: orderId, tenantId: ctx.tenantId! }, include: { customer: { select: { name: true } } } });
      if (!o) throw new NotFoundException('Pedido não encontrado.');
      if (['DRAFT', 'PENDING_APPROVAL', 'CANCELLED'].includes(o.status)) throw new ConflictException(`Pedido "${o.status}" não gera contas a receber.`);
      if (o.channel === 'MARKETPLACE') throw new ConflictException('Pedidos de marketplace geram o recebível pela conciliação do relatório de liquidação.');
      if (await tx.financialTitle.findFirst({ where: { tenantId: ctx.tenantId!, origin: 'SALES_ORDER', originRef: { startsWith: `${orderId}:` } } })) throw new ConflictException('Este pedido já possui contas a receber geradas.');
      await this.validateRefs(tx, ctx, { categoryId: dto.categoryId });
      const total = toCents(o.total);
      let plan: { due: Date; cents: number }[];
      if (dto.installments?.length) plan = dto.installments.map((i) => ({ due: new Date(i.dueDate), cents: toCents(i.amount) }));
      else {
        if (!dto.firstDueDate) throw new BadRequestException('Informe as parcelas ou `firstDueDate`.');
        const n = Math.max(1, Math.min(dto.count ?? 1, 36));
        plan = splitCents(total, n).map((cents, i) => ({ due: addDays(new Date(dto.firstDueDate!), i * (dto.intervalDays ?? 30)), cents }));
      }
      if (plan.reduce((s, p) => s + p.cents, 0) !== total) throw new ConflictException(`As parcelas devem somar o total do pedido (${fromCents(total)}).`);
      const ids: string[] = [];
      for (const [i, p] of plan.entries()) {
        const t = await tx.financialTitle.create({
          data: {
            tenantId: ctx.tenantId!, direction: 'RECEIVABLE', counterpartyKind: 'CUSTOMER', customerId: o.customerId, counterpartyName: o.customer.name, description: `Pedido ${o.number} — ${o.customer.name}`, documentRef: String(o.number),
            installmentNo: i + 1, installmentTotal: plan.length, issueDate: new Date(), dueDate: p.due, amount: fromCents(p.cents), categoryId: dto.categoryId, origin: 'SALES_ORDER', originRef: `${orderId}:${i + 1}`, createdById: ctx.userId,
          },
        });
        ids.push(t.id);
      }
      await this.audit.record(tx, ctx, { action: 'finance.receivables_from_order', entity: 'sales_order', entityId: orderId, metadata: { count: ids.length, total: fromCents(total) } });
      return { ids };
    });
  }

  /** Repasse de comissões: vira uma conta a pagar; as comissões só ficam PAGAS quando o título for quitado. */
  commissionPayout(ctx: AuthContext, dto: { salespersonId: string; dueDate: string; categoryId?: string; costCenterId?: string }) {
    return this.prisma.withContext(ctx, async (tx) => {
      const sp = await tx.salesperson.findFirst({ where: { id: dto.salespersonId, tenantId: ctx.tenantId! } });
      if (!sp) throw new NotFoundException('Vendedor não encontrado.');
      await this.validateRefs(tx, ctx, { categoryId: dto.categoryId, costCenterId: dto.costCenterId });
      const rows = await tx.$queryRaw<{ id: string; amount: string }[]>`
        SELECT id, amount FROM sales_commissions WHERE tenant_id = ${ctx.tenantId}::uuid AND salesperson_id = ${dto.salespersonId}::uuid AND status = 'EARNED' AND payout_title_id IS NULL FOR UPDATE`;
      const bonuses = await tx.goalBonus.findMany({ where: { tenantId: ctx.tenantId!, salespersonId: dto.salespersonId, status: 'EARNED', payoutTitleId: null } });
      const total = rows.reduce((s, r) => s + toCents(r.amount), 0) + bonuses.reduce((s, b) => s + toCents(b.amount), 0);
      if (!rows.length && !bonuses.length) throw new ConflictException('Não há comissões aprovadas pendentes de repasse.');
      if (total <= 0) throw new ConflictException('O saldo aprovado é negativo ou zero (estornos): será descontado em repasses futuros.');
      const title = await tx.financialTitle.create({
        data: {
          tenantId: ctx.tenantId!, direction: 'PAYABLE', counterpartyKind: 'SALESPERSON', salespersonId: sp.id, counterpartyName: sp.name, description: `Comissões — ${sp.name}`, dueDate: new Date(dto.dueDate), amount: fromCents(total),
          categoryId: dto.categoryId, costCenterId: dto.costCenterId, origin: 'COMMISSION', originRef: `payout:${randomUUID()}`, createdById: ctx.userId,
        },
      });
      await tx.salesCommission.updateMany({ where: { id: { in: rows.map((r) => r.id) }, tenantId: ctx.tenantId! }, data: { payoutTitleId: title.id } });
      if (bonuses.length) await tx.goalBonus.updateMany({ where: { id: { in: bonuses.map((b) => b.id) }, tenantId: ctx.tenantId! }, data: { payoutTitleId: title.id } });
      await this.audit.record(tx, ctx, { action: 'finance.commission_payout_created', entity: 'financial_title', entityId: title.id, metadata: { salespersonId: sp.id, entries: rows.length, total: fromCents(total) } });
      return { titleId: title.id, entries: rows.length, total: fromCents(total) };
    });
  }

  private async lock(tx: Tx, ctx: Pick<AuthContext, 'tenantId'>, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM financial_titles WHERE id = ${id}::uuid AND tenant_id = ${ctx.tenantId}::uuid FOR UPDATE`;
    if (!rows.length) throw new NotFoundException('Título não encontrado.');
    return tx.financialTitle.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId! } });
  }
}

function uniq(message: string) {
  return (e: unknown): never => {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException(message);
    throw e;
  };
}
