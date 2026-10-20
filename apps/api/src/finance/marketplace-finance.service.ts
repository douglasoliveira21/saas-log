import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/auth';
import { parseCsv, parseDecimal } from '../catalog/csv';
import { fromCents, toCents } from '../commissions/commissions.service';
import { PrismaService } from '../prisma/prisma.service';
import { FinanceService } from './finance.service';

const ALIASES: Record<string, string> = {
  pedido: 'order', order_id: 'order', id_pedido: 'order', bruto: 'gross', valor_bruto: 'gross', gross: 'gross', comissao: 'commission', commission: 'commission',
  tarifa_fixa: 'fixedFee', fixed_fee: 'fixedFee', tarifa_pagamento: 'paymentFee', payment_fee: 'paymentFee', frete: 'shipping', shipping: 'shipping',
  ajustes: 'adjustments', adjustments: 'adjustments', reembolsos: 'refunds', refunds: 'refunds', liquido: 'net', net: 'net',
  data_prevista: 'expected', expected_date: 'expected', data_recebimento: 'received', received_date: 'received',
};
const norm = (h: string) => h.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const date = (v: string): Date | null => {
  const s = v.trim();
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/) ?? s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return s.includes('/') ? new Date(Date.UTC(+m[3], +m[2] - 1, +m[1])) : new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
};

export interface Divergence { code: string; message: string }

/**
 * Conciliação financeira de marketplaces a partir do RELATÓRIO DE LIQUIDAÇÃO exportado pelo canal (CSV).
 * O dinheiro recebido não é o total dos pedidos: aqui separamos bruto, tarifas, frete, reembolsos, ajustes e líquido,
 * ligamos cada linha ao pedido importado e registramos divergências. A leitura direta pela API do canal depende dos conectores (pendente).
 */
@Injectable()
export class MarketplaceFinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly finance: FinanceService,
  ) {}

  async importReport(ctx: AuthContext, connectionId: string, dto: { reportRef: string; csv: string }) {
    const table = parseCsv(dto.csv);
    if (table.length < 2) throw new BadRequestException('Arquivo vazio.');
    if (table.length - 1 > 5000) throw new BadRequestException('Limite de 5.000 linhas por relatório.');
    const head = table[0].map((h) => ALIASES[norm(h)]);
    for (const need of ['order', 'gross', 'net']) if (!head.includes(need)) throw new BadRequestException(`Coluna obrigatória ausente: ${need === 'order' ? 'pedido' : need === 'gross' ? 'bruto' : 'líquido'}.`);
    const errors: { line: number; message: string }[] = [];
    const rows: Record<string, string>[] = [];
    table.slice(1).forEach((cells, i) => {
      const r: Record<string, string> = {};
      head.forEach((k, idx) => { if (k) r[k] = (cells[idx] ?? '').trim(); });
      const bad = ['gross', 'net', 'commission', 'fixedFee', 'paymentFee', 'shipping', 'adjustments', 'refunds'].filter((k) => r[k] !== undefined && r[k] !== '' && Number.isNaN(parseDecimal(r[k])));
      if (!r.order) errors.push({ line: i + 2, message: 'pedido ausente' });
      else if (bad.length) errors.push({ line: i + 2, message: `valor inválido em ${bad.join(', ')}` });
      else rows.push(r);
    });
    return this.prisma.withContext(ctx, async (tx) => {
      if (!(await tx.marketplaceConnection.findFirst({ where: { id: connectionId, tenantId: ctx.tenantId! }, select: { id: true } }))) throw new NotFoundException('Conexão não encontrada.');
      let imported = 0;
      let duplicates = 0;
      for (const r of rows) {
        const n = (k: string) => toCents(parseDecimal(r[k] ?? '') || 0);
        const gross = n('gross'), commission = n('commission'), fixedFee = n('fixedFee'), paymentFee = n('paymentFee'), shipping = n('shipping'), adjustments = n('adjustments'), refunds = n('refunds'), net = n('net');
        const ledger = await tx.externalOrder.findUnique({ where: { connectionId_externalId: { connectionId, externalId: r.order } }, include: { salesOrder: { select: { id: true, total: true } } } });
        const issues: Divergence[] = [];
        const calc = gross - commission - fixedFee - paymentFee - shipping - refunds + adjustments;
        if (Math.abs(calc - net) > 1) issues.push({ code: 'NET_INCONSISTENT', message: `O líquido informado (${fromCents(net)}) não fecha com os componentes (${fromCents(calc)}).` });
        if (ledger?.salesOrder && Math.abs(toCents(ledger.salesOrder.total) - gross) > 1) issues.push({ code: 'GROSS_DIFFERS_FROM_ORDER', message: `Valor bruto do relatório (${fromCents(gross)}) difere do total do pedido (${ledger.salesOrder.total.toString()}).` });
        if (refunds > 0) issues.push({ code: 'HAS_REFUND', message: `Há reembolso de ${fromCents(refunds)} neste pedido: confira a devolução.` });
        const status = !ledger?.salesOrder ? 'UNLINKED' : issues.length ? 'DIVERGENT' : 'IMPORTED';
        const ins = await tx.$executeRaw`
          INSERT INTO marketplace_settlements (id, tenant_id, connection_id, report_ref, external_order_id, gross, commission, fixed_fee, payment_fee, shipping, adjustments, refunds, net_reported,
                                               expected_date, received_date, status, sales_order_id, divergence, updated_at)
          VALUES (${randomUUID()}::uuid, ${ctx.tenantId}::uuid, ${connectionId}::uuid, ${dto.reportRef}, ${r.order}, ${fromCents(gross)}::numeric, ${fromCents(commission)}::numeric, ${fromCents(fixedFee)}::numeric,
                  ${fromCents(paymentFee)}::numeric, ${fromCents(shipping)}::numeric, ${fromCents(adjustments)}::numeric, ${fromCents(refunds)}::numeric, ${fromCents(net)}::numeric,
                  ${r.expected ? date(r.expected) : null}, ${r.received ? date(r.received) : null}, ${status}, ${ledger?.salesOrder?.id ?? null}::uuid, ${JSON.stringify(issues)}::jsonb, now())
          ON CONFLICT (connection_id, report_ref, external_order_id) DO NOTHING`;
        if (ins) imported++; else duplicates++;
      }
      await this.audit.record(tx, ctx, { action: 'finance.marketplace_report_imported', entity: 'marketplace_connection', entityId: connectionId, metadata: { reportRef: dto.reportRef, imported, duplicates, errors: errors.length } });
      return { imported, duplicates, errors };
    });
  }

  list(ctx: AuthContext, connectionId: string, status?: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const where = { tenantId: ctx.tenantId!, connectionId, ...(status ? { status } : {}) };
      const [items, agg] = await Promise.all([
        tx.marketplaceSettlement.findMany({ where, orderBy: { createdAt: 'desc' }, take: 300 }),
        tx.marketplaceSettlement.groupBy({ by: ['status'], where: { tenantId: ctx.tenantId!, connectionId }, _sum: { gross: true, netReported: true, commission: true, fixedFee: true, paymentFee: true, shipping: true, refunds: true }, _count: true }),
      ]);
      return {
        items,
        summary: agg.map((a) => ({ status: a.status, lines: a._count, gross: Number(a._sum.gross ?? 0).toFixed(2), fees: fromCents(toCents(a._sum.commission ?? 0) + toCents(a._sum.fixedFee ?? 0) + toCents(a._sum.paymentFee ?? 0)), shipping: Number(a._sum.shipping ?? 0).toFixed(2), refunds: Number(a._sum.refunds ?? 0).toFixed(2), net: Number(a._sum.netReported ?? 0).toFixed(2) })),
      };
    });
  }

  /**
   * Confirma o recebimento de uma linha: cria o recebível do LÍQUIDO (origem MARKETPLACE) e o baixa na conta, na data de recebimento.
   * Divergências exigem aceite explícito, que fica registrado.
   */
  async reconcile(ctx: AuthContext, lineId: string, dto: { accountId: string; acceptDivergence?: boolean; note?: string }) {
    const line = await this.prisma.withContext(ctx, (tx) => tx.marketplaceSettlement.findFirst({ where: { id: lineId, tenantId: ctx.tenantId! } }));
    if (!line) throw new NotFoundException('Linha não encontrada.');
    if (line.status === 'RECONCILED') throw new ConflictException('Linha já conciliada.');
    if (line.status === 'UNLINKED' || !line.salesOrderId) throw new ConflictException('Linha sem pedido correspondente no ERP: importe o pedido ou vincule-o antes de conciliar.');
    if (!line.receivedDate) throw new ConflictException('O relatório ainda não informa a data de recebimento.');
    if (toCents(line.netReported) <= 0) throw new ConflictException('Líquido não positivo (estorno/cobrança): trate manualmente.');
    const issues = line.divergence as unknown as Divergence[];
    if (issues.length && !dto.acceptDivergence) throw new ConflictException({ message: 'Há divergências: confirme explicitamente para conciliar.', requiresAcceptance: true, issues });

    return this.prisma.withContext(ctx, async (tx) => {
      const locked = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM marketplace_settlements WHERE id = ${lineId}::uuid AND tenant_id = ${ctx.tenantId}::uuid FOR UPDATE`;
      if (locked[0]?.status === 'RECONCILED') throw new ConflictException('Linha já conciliada.');
      const order = await tx.salesOrder.findFirstOrThrow({ where: { id: line.salesOrderId!, tenantId: ctx.tenantId! }, select: { number: true } });
      const title = await tx.financialTitle.create({
        data: {
          tenantId: ctx.tenantId!, direction: 'RECEIVABLE', counterpartyKind: 'MARKETPLACE', connectionId: line.connectionId, counterpartyName: 'Marketplace', description: `Liquidação pedido ${order.number} (${line.externalOrderId})`,
          documentRef: line.reportRef, dueDate: line.receivedDate!, amount: line.netReported.toString(), origin: 'MARKETPLACE', originRef: `mkt:${lineId}`, createdById: ctx.userId,
        },
      });
      await tx.$queryRaw`SELECT id FROM financial_titles WHERE id = ${title.id}::uuid FOR UPDATE`;
      await this.settleInTx(tx, ctx, title.id, dto.accountId, line.netReported.toString(), line.receivedDate!, `Conciliação do relatório ${line.reportRef}`);
      await tx.marketplaceSettlement.update({ where: { id: lineId }, data: { status: 'RECONCILED', titleId: title.id, note: dto.note ?? (issues.length ? 'Divergência aceita' : null) } });
      await this.audit.record(tx, ctx, { action: 'finance.marketplace_reconciled', entity: 'marketplace_settlement', entityId: lineId, metadata: { titleId: title.id, net: line.netReported.toString(), acceptedDivergences: issues.map((i) => i.code) } });
      return { lineId, titleId: title.id };
    });
  }

  /** Baixa integral dentro da transação do chamador (mesma regra de FinanceService.settle). */
  private async settleInTx(tx: Prisma.TransactionClient, ctx: AuthContext, titleId: string, accountId: string, amount: string, paidAt: Date, note: string) {
    const account = await tx.financialAccount.findFirst({ where: { id: accountId, tenantId: ctx.tenantId!, active: true } });
    if (!account) throw new BadRequestException('Conta financeira inválida ou inativa.');
    await tx.financialSettlement.create({ data: { tenantId: ctx.tenantId!, titleId, accountId, amount, principal: amount, paidAt, note, createdById: ctx.userId } });
    await tx.financialTitle.update({ where: { id: titleId }, data: { paidPrincipal: amount, status: 'PAID' } });
  }
}
