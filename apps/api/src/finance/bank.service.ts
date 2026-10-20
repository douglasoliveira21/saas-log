import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/auth';
import { toCents } from '../commissions/commissions.service';
import { PrismaService } from '../prisma/prisma.service';
import { parseOfx, parseStatementCsv } from './ofx';

const MAX_LINES = 5000;

/** Conciliação bancária assistida: importa o extrato (OFX/CSV) e sugere/confirma o par com as baixas do sistema. */
@Injectable()
export class BankService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async importStatement(ctx: AuthContext, accountId: string, dto: { format: 'OFX' | 'CSV'; content: string }) {
    const parsed = dto.format === 'OFX' ? parseOfx(dto.content) : parseStatementCsv(dto.content);
    if (parsed.lines.length > MAX_LINES) throw new BadRequestException(`Limite de ${MAX_LINES} lançamentos por arquivo.`);
    return this.prisma.withContext(ctx, async (tx) => {
      if (!(await tx.financialAccount.findFirst({ where: { id: accountId, tenantId: ctx.tenantId! } }))) throw new NotFoundException('Conta não encontrada.');
      const batch = randomUUID();
      let imported = 0;
      for (const l of parsed.lines) {
        const r = await tx.$executeRaw`
          INSERT INTO bank_statement_lines (id, tenant_id, account_id, fitid, posted_at, amount, description, batch)
          VALUES (${randomUUID()}::uuid, ${ctx.tenantId}::uuid, ${accountId}::uuid, ${l.fitid}, ${l.postedAt}, ${l.amount.toFixed(2)}::numeric, ${l.description}, ${batch})
          ON CONFLICT (account_id, fitid) DO NOTHING`;
        imported += r;
      }
      await this.audit.record(tx, ctx, { action: 'finance.statement_imported', entity: 'financial_account', entityId: accountId, metadata: { format: dto.format, imported, duplicates: parsed.lines.length - imported, errors: parsed.errors.length } });
      return { imported, duplicates: parsed.lines.length - imported, errors: parsed.errors };
    });
  }

  /** Linhas do extrato com sugestões: baixas da mesma conta, mesmo valor (com sinal) e data até 3 dias de distância. */
  async lines(ctx: AuthContext, accountId: string, matched?: boolean) {
    return this.prisma.withContext(ctx, async (tx) => {
      const rows = await tx.bankStatementLine.findMany({
        where: { tenantId: ctx.tenantId!, accountId, ...(matched === undefined ? {} : { settlementId: matched ? { not: null } : null }) },
        orderBy: { postedAt: 'desc' }, take: 300,
      });
      const free = await tx.$queryRaw<{ id: string; signed: string; paid_at: Date; description: string }[]>`
        SELECT s.id, (CASE t.direction WHEN 'RECEIVABLE' THEN s.amount ELSE -s.amount END) AS signed, s.paid_at, t.description
        FROM financial_settlements s JOIN financial_titles t ON t.id = s.title_id
        WHERE s.tenant_id = ${ctx.tenantId}::uuid AND s.account_id = ${accountId}::uuid
          AND NOT EXISTS (SELECT 1 FROM bank_statement_lines b WHERE b.settlement_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM financial_settlements r WHERE r.reversal_of_id = s.id) AND s.kind = 'SETTLEMENT'`;
      return rows.map((l) => ({
        ...l, amount: l.amount.toString(),
        suggestions: l.settlementId ? [] : free.filter((f) => toCents(f.signed) === toCents(l.amount) && Math.abs(f.paid_at.getTime() - l.postedAt.getTime()) <= 3 * 86_400_000).slice(0, 3).map((f) => ({ settlementId: f.id, description: f.description, paidAt: f.paid_at })),
      }));
    });
  }

  async match(ctx: AuthContext, lineId: string, settlementId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const line = await tx.bankStatementLine.findFirst({ where: { id: lineId, tenantId: ctx.tenantId! } });
      if (!line) throw new NotFoundException('Lançamento do extrato não encontrado.');
      if (line.settlementId) throw new ConflictException('Este lançamento já está conciliado.');
      const s = await tx.financialSettlement.findFirst({ where: { id: settlementId, tenantId: ctx.tenantId! }, include: { title: { select: { direction: true } } } });
      if (!s || s.kind !== 'SETTLEMENT') throw new NotFoundException('Baixa não encontrada.');
      if (s.accountId !== line.accountId) throw new ConflictException('A baixa pertence a outra conta financeira.');
      if (await tx.financialSettlement.findFirst({ where: { reversalOfId: s.id } })) throw new ConflictException('A baixa foi estornada.');
      const signed = (s.title.direction === 'RECEIVABLE' ? 1 : -1) * toCents(s.amount);
      if (signed !== toCents(line.amount)) throw new ConflictException(`Valores diferentes: extrato ${line.amount.toString()} × baixa ${(signed / 100).toFixed(2)}. Ajuste a baixa (estorno e novo lançamento) ou concilie outra.`);
      await tx.bankStatementLine.update({ where: { id: lineId }, data: { settlementId, matchedAt: new Date(), matchedById: ctx.userId } }).catch((e) => {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('Esta baixa já está conciliada com outro lançamento.');
        throw e;
      });
      await this.audit.record(tx, ctx, { action: 'finance.bank_matched', entity: 'bank_statement_line', entityId: lineId, metadata: { settlementId } });
      return { lineId, settlementId };
    });
  }

  async unmatch(ctx: AuthContext, lineId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const line = await tx.bankStatementLine.findFirst({ where: { id: lineId, tenantId: ctx.tenantId! } });
      if (!line?.settlementId) throw new NotFoundException('Conciliação não encontrada.');
      await tx.bankStatementLine.update({ where: { id: lineId }, data: { settlementId: null, matchedAt: null, matchedById: null } });
      await this.audit.record(tx, ctx, { action: 'finance.bank_unmatched', entity: 'bank_statement_line', entityId: lineId, metadata: { settlementId: line.settlementId } });
      return { lineId };
    });
  }
}
