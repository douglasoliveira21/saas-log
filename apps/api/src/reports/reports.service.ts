import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthContext, systemContext } from '../common/auth';
import { JobQueue } from '../integrations/job-queue';
import { JobWorker } from '../integrations/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { StatementsService } from '../finance/statements.service';
import { Cell, Column, toCsv, toXlsx } from './export';

type Tx = Prisma.TransactionClient;
type Row = Record<string, Cell>;
export type Filters = { [k: string]: string | undefined };

const SYNC_LIMIT = 5000;
const ASYNC_LIMIT = 100_000;
const KEEP_DAYS = 3;
const ymd = (v: Date | null) => (v ? v.toISOString().slice(0, 10) : null);

interface ReportDef {
  title: string;
  /** Permissão do módulo de origem, exigida além de reports.view. */
  permission: string;
  columns: Column[];
  filters: string[];
  fetch(tx: Tx, ctx: AuthContext, f: Filters, limit: number): Promise<Row[]>;
}

const period = (f: Filters) => {
  const from = f.from ? new Date(f.from) : new Date(Date.now() - 30 * 86_400_000);
  const to = f.to ? new Date(f.to) : new Date();
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from) throw new BadRequestException('Período inválido.');
  return { from, to: new Date(to.getTime() + 86_400_000) };
};

@Injectable()
export class ReportsService {
  private readonly defs: Record<string, ReportDef>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly statements: StatementsService,
    private readonly queue: JobQueue,
    worker: JobWorker,
  ) {
    this.defs = this.build();
    worker.register('report.export', { automatic: false, safeToRetry: true, run: (j) => this.runExportJob(j.tenant_id, String(j.payload.exportId)) });
  }

  private build(): Record<string, ReportDef> {
    return {
      sales: {
        title: 'Vendas por pedido', permission: 'sales.view_all', filters: ['from', 'to', 'status'],
        columns: [{ key: 'number', label: 'Pedido' }, { key: 'date', label: 'Data' }, { key: 'status', label: 'Status' }, { key: 'channel', label: 'Canal' }, { key: 'customer', label: 'Cliente' }, { key: 'salesperson', label: 'Vendedor' }, { key: 'subtotal', label: 'Subtotal' }, { key: 'discount', label: 'Desconto' }, { key: 'shipping', label: 'Frete' }, { key: 'total', label: 'Total' }],
        fetch: async (tx, ctx, f, limit) => {
          const { from, to } = period(f);
          const rows = await tx.salesOrder.findMany({
            where: { tenantId: ctx.tenantId!, createdAt: { gte: from, lt: to }, ...(f.status ? { status: f.status as never } : {}) },
            orderBy: { createdAt: 'desc' }, take: limit, include: { customer: { select: { name: true } }, salesperson: { select: { name: true } } },
          });
          return rows.map((o) => ({ number: o.number, date: ymd(o.createdAt), status: o.status, channel: o.channel, customer: o.customer.name, salesperson: o.salesperson?.name ?? '', subtotal: Number(o.subtotal), discount: Number(o.discountTotal), shipping: Number(o.shipping), total: Number(o.total) }));
        },
      },
      stock: {
        title: 'Posição de estoque', permission: 'stock.view', filters: ['warehouseId'],
        columns: [{ key: 'sku', label: 'SKU' }, { key: 'name', label: 'Produto' }, { key: 'warehouse', label: 'Depósito' }, { key: 'onHand', label: 'Físico' }, { key: 'reserved', label: 'Reservado' }, { key: 'available', label: 'Disponível' }, { key: 'cost', label: 'Custo unit.' }, { key: 'value', label: 'Valor em estoque' }],
        fetch: async (tx, ctx, f, limit) => {
          const rows = await tx.stockBalance.findMany({
            where: { tenantId: ctx.tenantId!, ...(f.warehouseId ? { warehouseId: f.warehouseId } : {}) }, take: limit,
            include: { product: { select: { sku: true, name: true, costPrice: true, extraCost: true } }, warehouse: { select: { name: true } } }, orderBy: { product: { sku: 'asc' } },
          });
          return rows.map((b) => {
            const cost = Number(b.product.costPrice ?? 0) + Number(b.product.extraCost ?? 0);
            return { sku: b.product.sku, name: b.product.name, warehouse: b.warehouse.name, onHand: b.onHand, reserved: b.reserved, available: b.onHand - b.reserved - b.blocked, cost: b.product.costPrice === null ? null : Math.round(cost * 100) / 100, value: b.product.costPrice === null ? null : Math.round(cost * b.onHand * 100) / 100 };
          });
        },
      },
      receivables: titleReport('RECEIVABLE', 'Contas a receber', 'Cliente / origem'),
      payables: titleReport('PAYABLE', 'Contas a pagar', 'Fornecedor / favorecido'),
      commissions: {
        title: 'Comissões', permission: 'commissions.manage', filters: ['from', 'to', 'status'],
        columns: [{ key: 'date', label: 'Data' }, { key: 'salesperson', label: 'Vendedor' }, { key: 'order', label: 'Pedido' }, { key: 'kind', label: 'Tipo' }, { key: 'status', label: 'Status' }, { key: 'base', label: 'Base' }, { key: 'amount', label: 'Comissão' }],
        fetch: async (tx, ctx, f, limit) => {
          const { from, to } = period(f);
          const rows = await tx.salesCommission.findMany({
            where: { tenantId: ctx.tenantId!, createdAt: { gte: from, lt: to }, ...(f.status ? { status: f.status as never } : {}) }, orderBy: { createdAt: 'desc' }, take: limit,
            include: { order: { select: { number: true } }, salesperson: { select: { name: true } } },
          });
          return rows.map((c) => ({ date: ymd(c.createdAt), salesperson: c.salesperson.name, order: c.order.number, kind: c.kind, status: c.status, base: Number(c.base), amount: Number(c.amount) }));
        },
      },
      marketplace: {
        title: 'Liquidação de marketplaces', permission: 'finance.reconcile', filters: ['status'],
        columns: [{ key: 'report', label: 'Relatório' }, { key: 'order', label: 'Pedido no canal' }, { key: 'status', label: 'Status' }, { key: 'gross', label: 'Bruto' }, { key: 'fees', label: 'Tarifas' }, { key: 'shipping', label: 'Frete' }, { key: 'refunds', label: 'Reembolsos' }, { key: 'net', label: 'Líquido' }, { key: 'expected', label: 'Previsto' }, { key: 'received', label: 'Recebido' }],
        fetch: async (tx, ctx, f, limit) => {
          const rows = await tx.marketplaceSettlement.findMany({ where: { tenantId: ctx.tenantId!, ...(f.status ? { status: f.status } : {}) }, orderBy: { createdAt: 'desc' }, take: limit });
          return rows.map((m) => ({ report: m.reportRef, order: m.externalOrderId, status: m.status, gross: Number(m.gross), fees: Number(m.commission) + Number(m.fixedFee) + Number(m.paymentFee), shipping: Number(m.shipping), refunds: Number(m.refunds), net: Number(m.netReported), expected: ymd(m.expectedDate), received: ymd(m.receivedDate) }));
        },
      },
      cashflow: {
        title: 'Fluxo de caixa', permission: 'finance.view', filters: ['from', 'to', 'granularity', 'accountId'],
        columns: [{ key: 'start', label: 'De' }, { key: 'end', label: 'Até' }, { key: 'realizedIn', label: 'Entradas realizadas' }, { key: 'realizedOut', label: 'Saídas realizadas' }, { key: 'pendingIn', label: 'A receber' }, { key: 'pendingOut', label: 'A pagar' }, { key: 'marketplaceExpectedIn', label: 'Marketplaces previstos' }, { key: 'closingBalance', label: 'Saldo final' }],
        fetch: async (_tx, ctx, f) => {
          const r = await this.statements.cashflow(ctx, { from: f.from ?? ymd(new Date())!, to: f.to ?? ymd(new Date(Date.now() + 30 * 86_400_000))!, granularity: (f.granularity as never) ?? 'week', accountId: f.accountId });
          return r.rows.map((x) => ({ ...x, realizedIn: Number(x.realizedIn), realizedOut: Number(x.realizedOut), pendingIn: Number(x.pendingIn), pendingOut: Number(x.pendingOut), marketplaceExpectedIn: Number(x.marketplaceExpectedIn), closingBalance: Number(x.closingBalance) }));
        },
      },
      dre: {
        title: 'DRE gerencial', permission: 'finance.view', filters: ['from', 'to'],
        columns: [{ key: 'label', label: 'Linha' }, { key: 'amount', label: 'Valor' }, { key: 'pct', label: '% da receita líquida' }],
        fetch: async (_tx, ctx, f) => {
          const to = f.to ?? ymd(new Date())!;
          const r = await this.statements.dre(ctx, { from: f.from ?? ymd(new Date(Date.now() - 30 * 86_400_000))!, to });
          return [...r.lines.map((l) => ({ label: l.label, amount: Number(l.amount), pct: l.pctOfNetRevenue })), { label: 'Base de cálculo', amount: null, pct: null }, { label: r.basis, amount: null, pct: null }];
        },
      },
    };
  }

  list(ctx: AuthContext) {
    return Object.entries(this.defs)
      .filter(([, d]) => ctx.permissions.has(d.permission))
      .map(([key, d]) => ({ key, title: d.title, columns: d.columns, filters: d.filters, canExport: ctx.permissions.has('reports.export') }));
  }

  private def(ctx: AuthContext, key: string): ReportDef {
    const d = this.defs[key];
    if (!d) throw new NotFoundException('Relatório inexistente.');
    if (!ctx.permissions.has(d.permission)) throw new ForbiddenException('Sem permissão para os dados deste relatório.');
    return d;
  }

  async preview(ctx: AuthContext, key: string, f: Filters) {
    const d = this.def(ctx, key);
    const rows = await this.prisma.withContext(ctx, (tx) => d.fetch(tx, ctx, f, 200));
    return { key, title: d.title, columns: d.columns, rows, truncated: rows.length >= 200 };
  }

  /** Até 5.000 linhas: arquivo na hora. Acima: job em segundo plano e download posterior. */
  async export(ctx: AuthContext, key: string, f: Filters, format: 'csv' | 'xlsx') {
    const d = this.def(ctx, key);
    if (format !== 'csv' && format !== 'xlsx') throw new BadRequestException('Formato inválido (csv ou xlsx).');
    const rows = await this.prisma.withContext(ctx, (tx) => d.fetch(tx, ctx, f, SYNC_LIMIT + 1));
    if (rows.length <= SYNC_LIMIT) {
      await this.prisma.withContext(ctx, (tx) => this.audit.record(tx, ctx, { action: 'report.exported', entity: 'report', entityId: key, metadata: { format, rows: rows.length, filters: f, mode: 'sync' } }));
      return { mode: 'sync' as const, ...this.build_file(key, d, rows, format) };
    }
    const id = await this.prisma.withContext(ctx, async (tx) => {
      const exp = await tx.reportExport.create({ data: { tenantId: ctx.tenantId!, report: key, format, filters: f as Prisma.InputJsonValue, createdById: ctx.userId, expiresAt: new Date(Date.now() + KEEP_DAYS * 86_400_000) } });
      await this.queue.enqueue(tx, ctx.tenantId!, { type: 'report.export', payload: { exportId: exp.id }, idempotencyKey: `report-export:${exp.id}` });
      await this.audit.record(tx, ctx, { action: 'report.exported', entity: 'report', entityId: key, metadata: { format, filters: f, mode: 'async', exportId: exp.id } });
      return exp.id;
    });
    return { mode: 'async' as const, exportId: id };
  }

  private build_file(key: string, d: ReportDef, rows: Row[], format: 'csv' | 'xlsx') {
    const stamp = new Date().toISOString().slice(0, 10);
    return format === 'csv'
      ? { fileName: `${key}-${stamp}.csv`, contentType: 'text/csv; charset=utf-8', content: toCsv(d.columns, rows), rowCount: rows.length }
      : { fileName: `${key}-${stamp}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: toXlsx(d.title, d.columns, rows), rowCount: rows.length };
  }

  /** Executa o export pedido por um usuário: os dados são lidos com as permissões de quem pediu (revalidadas no download). */
  private async runExportJob(tenantId: string, exportId: string) {
    const sys = systemContext(tenantId);
    try {
      return await this.prisma.withContext(sys, async (tx) => {
        const exp = await tx.reportExport.findFirst({ where: { id: exportId, tenantId } });
        if (!exp) return { ok: false as const, retryable: false, message: 'Exportação não encontrada.' };
        if (exp.status === 'READY') return { ok: true as const };
        const d = this.defs[exp.report];
        const rows = await d.fetch(tx, sys, exp.filters as Filters, ASYNC_LIMIT + 1);
        if (rows.length > ASYNC_LIMIT) {
          await tx.reportExport.update({ where: { id: exportId }, data: { status: 'FAILED', error: `Mais de ${ASYNC_LIMIT} linhas: refine os filtros.` } });
          return { ok: false as const, retryable: false, message: 'Relatório grande demais.' };
        }
        const file = this.build_file(exp.report, d, rows, exp.format as 'csv' | 'xlsx');
        await tx.reportExport.update({ where: { id: exportId }, data: { status: 'READY', rowCount: file.rowCount, fileName: file.fileName, content: new Uint8Array(file.content) } });
        return { ok: true as const, result: { rows: file.rowCount } };
      });
    } catch (e) {
      return { ok: false as const, retryable: true, message: (e as Error).message };
    }
  }

  exports(ctx: AuthContext) {
    return this.prisma.withContext(ctx, (tx) =>
      tx.reportExport.findMany({ where: { tenantId: ctx.tenantId!, createdById: ctx.userId }, orderBy: { createdAt: 'desc' }, take: 30, select: { id: true, report: true, format: true, status: true, rowCount: true, fileName: true, error: true, createdAt: true, expiresAt: true } }));
  }

  async download(ctx: AuthContext, exportId: string) {
    const exp = await this.prisma.withContext(ctx, (tx) => tx.reportExport.findFirst({ where: { id: exportId, tenantId: ctx.tenantId!, createdById: ctx.userId } }));
    if (!exp) throw new NotFoundException('Exportação não encontrada.');
    this.def(ctx, exp.report); // permissão do relatório continua valendo no download
    if (exp.expiresAt < new Date()) throw new ConflictException('Exportação expirada: gere novamente.');
    if (exp.status !== 'READY' || !exp.content) throw new ConflictException(exp.status === 'FAILED' ? (exp.error ?? 'A exportação falhou.') : 'A exportação ainda está sendo preparada.');
    return { fileName: exp.fileName!, contentType: exp.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: Buffer.from(exp.content) };
  }
}

function titleReport(direction: 'PAYABLE' | 'RECEIVABLE', title: string, partyLabel: string): ReportDef {
  return {
    title, permission: 'finance.view', filters: ['from', 'to', 'status'],
    columns: [{ key: 'due', label: 'Vencimento' }, { key: 'party', label: partyLabel }, { key: 'description', label: 'Descrição' }, { key: 'doc', label: 'Documento' }, { key: 'installment', label: 'Parcela' }, { key: 'status', label: 'Status' }, { key: 'amount', label: 'Valor' }, { key: 'paid', label: 'Baixado' }, { key: 'outstanding', label: 'Em aberto' }, { key: 'daysLate', label: 'Dias em atraso' }, { key: 'category', label: 'Categoria' }],
    async fetch(tx, ctx, f, limit) {
      const { from, to } = period({ from: f.from ?? '2000-01-01', to: f.to ?? '2100-01-01' });
      const today = new Date();
      const rows = await tx.financialTitle.findMany({
        where: { tenantId: ctx.tenantId!, direction, dueDate: { gte: from, lt: to }, ...(f.status ? { status: f.status } : {}) }, orderBy: { dueDate: 'asc' }, take: limit,
        include: { category: { select: { name: true } } },
      });
      const sup = await tx.supplier.findMany({ where: { tenantId: ctx.tenantId!, id: { in: rows.map((r) => r.supplierId).filter((x): x is string => !!x) } }, select: { id: true, legalName: true } });
      const cus = await tx.customer.findMany({ where: { tenantId: ctx.tenantId!, id: { in: rows.map((r) => r.customerId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
      const names = new Map<string, string>([...sup.map((x) => [x.id, x.legalName] as const), ...cus.map((x) => [x.id, x.name] as const)]);
      return rows.map((t) => {
        const out = Math.round((Number(t.amount) - Number(t.paidPrincipal)) * 100) / 100;
        const open = t.status === 'OPEN' || t.status === 'PARTIAL';
        return {
          due: ymd(t.dueDate), party: (t.supplierId && names.get(t.supplierId)) || (t.customerId && names.get(t.customerId)) || t.counterpartyName || '', description: t.description, doc: t.documentRef ?? '',
          installment: `${t.installmentNo}/${t.installmentTotal}`, status: t.status, amount: Number(t.amount), paid: Number(t.paidPrincipal), outstanding: open ? out : 0,
          daysLate: open && t.dueDate < today ? Math.floor((today.getTime() - t.dueDate.getTime()) / 86_400_000) : 0, category: t.category?.name ?? '',
        };
      });
    },
  };
}
