import { BadRequestException, Body, Controller, Get, HttpCode, Injectable, Post, Query } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { parseCsv, parseDecimal } from '../catalog/csv';
import { AuthContext, CurrentAuth, RequirePermissions } from '../common/auth';
import { onlyDigits } from '../common/cnpj';
import { PrismaService } from '../prisma/prisma.service';

const ENTITIES = ['PRODUCTS', 'CUSTOMERS', 'SUPPLIERS', 'STOCK', 'OPEN_TITLES', 'HISTORY'] as const;
type Entity = (typeof ENTITIES)[number];
type Row = Record<string, string>;
type ImportError = { line: number; message: string };

const normalize = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const value = (row: Row, ...keys: string[]) => keys.map((k) => row[normalize(k)]).find((v) => v !== undefined && v !== '')?.trim();
const date = (v?: string) => {
  if (!v) return undefined;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00Z` : v;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

function rowsOf(csv: string): { rows: Row[]; errors: ImportError[] } {
  const table = parseCsv(csv);
  if (table.length < 2) return { rows: [], errors: [{ line: 1, message: 'Arquivo vazio ou sem dados.' }] };
  if (table.length > 5001) return { rows: [], errors: [{ line: 1, message: 'Limite de 5.000 linhas por execução.' }] };
  const headers = table[0].map(normalize);
  if (new Set(headers).size !== headers.length || headers.some((h) => !h)) return { rows: [], errors: [{ line: 1, message: 'Cabeçalhos vazios ou duplicados.' }] };
  return {
    rows: table.slice(1).map((cells) => Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? '').trim()]))),
    errors: [],
  };
}

class SearchQuery {
  @IsString() @MaxLength(80) q: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
}
class ImportDto {
  @IsIn(ENTITIES) entity: Entity;
  @IsString() @MaxLength(5_500_000) csv: string;
  @IsOptional() @IsString() @MaxLength(180) fileName?: string;
  @IsOptional() @IsBoolean() dryRun?: boolean;
}

@Injectable()
export class WorkspaceService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  onboarding(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const [companies, establishments, warehouses, users, certificates, approvedFiscal, taxRules, migrations, done] = await Promise.all([
        tx.company.count({ where: { tenantId: ctx.tenantId!, active: true } }),
        tx.establishment.count({ where: { tenantId: ctx.tenantId!, active: true } }),
        tx.warehouse.count({ where: { tenantId: ctx.tenantId!, active: true } }),
        tx.membership.count({ where: { tenantId: ctx.tenantId!, status: 'ACTIVE' } }),
        tx.fiscalCertificate.count({ where: { tenantId: ctx.tenantId!, status: 'ACTIVE', notAfter: { gt: new Date() } } }),
        tx.fiscalConfiguration.count({ where: { tenantId: ctx.tenantId!, status: 'APPROVED' } }),
        tx.taxRule.count({ where: { tenantId: ctx.tenantId!, active: true, versions: { some: { status: 'APPROVED' } } } }),
        tx.migrationRun.count({ where: { tenantId: ctx.tenantId!, status: 'COMPLETED' } }),
        tx.tenantSetting.findUnique({ where: { tenantId_key: { tenantId: ctx.tenantId!, key: 'onboarding.completedAt' } } }),
      ]);
      const steps = [
        { key: 'company', title: 'Empresa e estabelecimento', description: 'Dados jurídicos, endereço e regime tributário.', href: '/empresa', complete: companies > 0 && establishments > 0 },
        { key: 'warehouse', title: 'Depósitos', description: 'Ao menos um depósito operacional.', href: '/empresa', complete: warehouses > 0 },
        { key: 'users', title: 'Equipe e permissões', description: 'Convide a equipe e confira os papéis.', href: '/usuarios', complete: users > 1 },
        { key: 'certificate', title: 'Certificado fiscal', description: 'Certificado A1 válido para emissão.', href: '/fiscal', complete: certificates > 0 },
        { key: 'fiscal', title: 'Configuração e regras fiscais', description: 'Configuração e ao menos uma regra aprovadas.', href: '/fiscal', complete: approvedFiscal > 0 && taxRules > 0 },
        { key: 'migration', title: 'Importação inicial', description: 'Migre cadastros e saldos do sistema anterior.', href: '/migracao', complete: migrations > 0 },
      ];
      return { steps, completed: steps.filter((s) => s.complete).length, total: steps.length, dismissedAt: done?.value ?? null };
    });
  }

  completeOnboarding(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const at = new Date().toISOString();
      await tx.tenantSetting.upsert({ where: { tenantId_key: { tenantId: ctx.tenantId!, key: 'onboarding.completedAt' } }, create: { tenantId: ctx.tenantId!, key: 'onboarding.completedAt', value: at }, update: { value: at } });
      await this.audit.record(tx, ctx, { action: 'onboarding.completed', entity: 'tenant', entityId: ctx.tenantId! });
      return { completedAt: at };
    });
  }

  search(ctx: AuthContext, q: string, limit = 8) {
    const term = q.trim();
    if (term.length < 2) throw new BadRequestException('Digite ao menos 2 caracteres.');
    return this.prisma.withContext(ctx, async (tx) => {
      const groups: { type: string; label: string; items: unknown[] }[] = [];
      if (ctx.permissions.has('products.view')) groups.push({ type: 'product', label: 'Produtos', items: await tx.product.findMany({ where: { tenantId: ctx.tenantId!, OR: [{ name: { contains: term, mode: 'insensitive' } }, { sku: { contains: term, mode: 'insensitive' } }, { barcode: { contains: term } }] }, select: { id: true, name: true, sku: true }, take: limit }).then((xs) => xs.map((x) => ({ ...x, title: x.name, subtitle: x.sku, href: `/produtos/${x.id}` }))) });
      if (ctx.permissions.has('customers.view')) groups.push({ type: 'customer', label: 'Clientes', items: await tx.customer.findMany({ where: { tenantId: ctx.tenantId!, OR: [{ name: { contains: term, mode: 'insensitive' } }, { document: { contains: onlyDigits(term) || '∅' } }] }, select: { id: true, name: true, document: true }, take: limit }).then((xs) => xs.map((x) => ({ ...x, title: x.name, subtitle: x.document, href: `/clientes?search=${encodeURIComponent(x.name)}` }))) });
      if (ctx.permissions.has('suppliers.view')) groups.push({ type: 'supplier', label: 'Fornecedores', items: await tx.supplier.findMany({ where: { tenantId: ctx.tenantId!, OR: [{ legalName: { contains: term, mode: 'insensitive' } }, { tradeName: { contains: term, mode: 'insensitive' } }, { document: { contains: onlyDigits(term) || '∅' } }] }, select: { id: true, legalName: true, tradeName: true, document: true }, take: limit }).then((xs) => xs.map((x) => ({ ...x, title: x.tradeName ?? x.legalName, subtitle: x.document, href: `/fornecedores?search=${encodeURIComponent(x.legalName)}` }))) });
      if (ctx.permissions.has('sales.view')) groups.push({ type: 'order', label: 'Pedidos', items: await tx.salesOrder.findMany({ where: { tenantId: ctx.tenantId!, OR: [{ number: /^\d+$/.test(term) ? Number(term) : -1 }, { customer: { name: { contains: term, mode: 'insensitive' } } }] }, select: { id: true, number: true, status: true, customer: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: limit }).then((xs) => xs.map((x) => ({ id: x.id, title: `Pedido #${x.number}`, subtitle: `${x.customer.name} · ${x.status}`, href: `/vendas?order=${x.id}` }))) });
      if (ctx.permissions.has('finance.view')) groups.push({ type: 'title', label: 'Financeiro', items: await tx.financialTitle.findMany({ where: { tenantId: ctx.tenantId!, OR: [{ description: { contains: term, mode: 'insensitive' } }, { counterpartyName: { contains: term, mode: 'insensitive' } }, { documentRef: { contains: term, mode: 'insensitive' } }] }, select: { id: true, description: true, direction: true, status: true }, take: limit }).then((xs) => xs.map((x) => ({ id: x.id, title: x.description, subtitle: `${x.direction} · ${x.status}`, href: `/financeiro?title=${x.id}` }))) });
      return { query: term, groups: groups.filter((g) => g.items.length), total: groups.reduce((n, g) => n + g.items.length, 0) };
    });
  }

  listRuns(ctx: AuthContext) {
    return this.prisma.withContext(ctx, (tx) => tx.migrationRun.findMany({ where: { tenantId: ctx.tenantId! }, orderBy: { createdAt: 'desc' }, take: 50 }));
  }

  async migrate(ctx: AuthContext, dto: ImportDto) {
    const parsed = rowsOf(dto.csv);
    const errors: ImportError[] = [...parsed.errors];
    const dryRun = dto.dryRun !== false;
    const outcome = await this.prisma.withContext(ctx, async (tx) => {
      const stats = { created: 0, updated: 0 };
      if (!parsed.rows.length) return stats;
      for (let i = 0; i < parsed.rows.length; i++) {
        const row = parsed.rows[i]; const line = i + 2;
        try { await this.importRow(tx, ctx, dto.entity, row, dryRun, stats); }
        catch (e) { errors.push({ line, message: (e as Error).message.slice(0, 300) }); }
        if (errors.length >= 100) break;
      }
      if (!dryRun && errors.length) throw new BadRequestException({ message: 'A importação não foi aplicada porque há linhas inválidas.', errors });
      return stats;
    }).catch(async (e) => {
      if (e instanceof BadRequestException) return { created: 0, updated: 0 };
      throw e;
    });
    const committed = !dryRun && errors.length === 0;
    const run = await this.prisma.withContext(ctx, async (tx) => {
      const r = await tx.migrationRun.create({ data: { id: randomUUID(), tenantId: ctx.tenantId!, entity: dto.entity, fileName: dto.fileName, dryRun, status: committed ? 'COMPLETED' : 'VALIDATED', totalRows: parsed.rows.length, created: outcome.created, updated: outcome.updated, rejected: errors.length, errors: errors as unknown as Prisma.InputJsonValue, createdById: ctx.userId } });
      await this.audit.record(tx, ctx, { action: committed ? 'migration.committed' : 'migration.validated', entity: 'migration_run', entityId: r.id, metadata: { entity: dto.entity, rows: parsed.rows.length, created: outcome.created, updated: outcome.updated, rejected: errors.length, fileName: dto.fileName } });
      return r;
    });
    return { runId: run.id, entity: dto.entity, dryRun, committed, total: parsed.rows.length, ...outcome, rejected: errors.length, errors };
  }

  private async importRow(tx: Prisma.TransactionClient, ctx: AuthContext, entity: Entity, r: Row, dry: boolean, stats: { created: number; updated: number }) {
    const tenantId = ctx.tenantId!;
    if (entity === 'PRODUCTS') {
      const sku = value(r, 'sku', 'codigo'); const name = value(r, 'nome', 'produto', 'descricao');
      if (!sku || !name) throw new Error('SKU e nome são obrigatórios.');
      const existing = await tx.product.findUnique({ where: { tenantId_sku: { tenantId, sku } }, select: { id: true } });
      const num = (k: string) => { const v = value(r, k); if (!v) return undefined; const n = parseDecimal(v); if (!Number.isFinite(n) || n < 0) throw new Error(`${k} inválido.`); return n; };
      const data = { name, barcode: value(r, 'codigo_de_barras', 'ean', 'gtin'), brand: value(r, 'marca'), costPrice: num('custo'), suggestedPrice: num('preco_venda'), minStock: num('estoque_minimo') ? Math.floor(num('estoque_minimo')!) : undefined, ncm: onlyDigits(value(r, 'ncm') ?? '') || undefined };
      if (!dry) existing ? await tx.product.update({ where: { id: existing.id }, data }) : await tx.product.create({ data: { tenantId, sku, ...data } });
      existing ? stats.updated++ : stats.created++; return;
    }
    if (entity === 'CUSTOMERS') {
      const external = value(r, 'id', 'codigo', 'external_id'); const document = onlyDigits(value(r, 'documento', 'cpf_cnpj', 'cnpj', 'cpf') ?? '') || undefined; const name = value(r, 'nome', 'razao_social');
      if (!name || (!document && !external)) throw new Error('Nome e documento ou ID externo são obrigatórios.');
      const existing = document ? await tx.customer.findFirst({ where: { tenantId, document }, select: { id: true } }) : null;
      const data = { name, kind: document?.length === 11 ? 'PF' as const : 'PJ' as const, document, email: value(r, 'email'), phone: value(r, 'telefone'), city: value(r, 'cidade'), state: value(r, 'uf')?.toUpperCase() };
      if (!dry) existing ? await tx.customer.update({ where: { id: existing.id }, data }) : await tx.customer.create({ data: { tenantId, ...data } });
      existing ? stats.updated++ : stats.created++; return;
    }
    if (entity === 'SUPPLIERS') {
      const document = onlyDigits(value(r, 'documento', 'cnpj', 'cpf_cnpj') ?? '') || undefined; const legalName = value(r, 'razao_social', 'nome');
      if (!legalName || !document) throw new Error('Razão social e documento são obrigatórios.');
      const existing = await tx.supplier.findFirst({ where: { tenantId, document }, select: { id: true } });
      const data = { legalName, tradeName: value(r, 'nome_fantasia'), document, email: value(r, 'email'), phone: value(r, 'telefone'), paymentTerms: value(r, 'condicao_pagamento') };
      if (!dry) existing ? await tx.supplier.update({ where: { id: existing.id }, data }) : await tx.supplier.create({ data: { tenantId, ...data } });
      existing ? stats.updated++ : stats.created++; return;
    }
    if (entity === 'STOCK') {
      const sku = value(r, 'sku', 'produto'); const code = value(r, 'deposito', 'warehouse'); const raw = value(r, 'quantidade', 'saldo'); const qty = raw ? parseDecimal(raw) : NaN;
      if (!sku || !code || !Number.isInteger(qty) || qty < 0) throw new Error('SKU, depósito e quantidade inteira não negativa são obrigatórios.');
      const [p, w] = await Promise.all([tx.product.findUnique({ where: { tenantId_sku: { tenantId, sku } }, select: { id: true } }), tx.warehouse.findUnique({ where: { tenantId_code: { tenantId, code: code.toUpperCase() } }, select: { id: true } })]);
      if (!p || !w) throw new Error('Produto ou depósito não encontrado.');
      const cur = await tx.stockBalance.findUnique({ where: { productId_warehouseId: { productId: p.id, warehouseId: w.id } } });
      const before = cur?.onHand ?? 0; const delta = qty - before;
      if (!dry && delta) {
        await tx.stockBalance.upsert({ where: { productId_warehouseId: { productId: p.id, warehouseId: w.id } }, create: { tenantId, productId: p.id, warehouseId: w.id, onHand: qty }, update: { onHand: qty } });
        await tx.stockMovement.create({ data: { tenantId, productId: p.id, warehouseId: w.id, type: 'ADJUSTMENT', quantity: delta, balanceBefore: before, balanceAfter: qty, reason: 'Migração inicial auditada', reference: 'MIGRATION', createdById: ctx.userId } });
      }
      cur ? stats.updated++ : stats.created++; return;
    }
    if (entity === 'OPEN_TITLES') {
      const externalId = value(r, 'id', 'codigo', 'external_id'); const description = value(r, 'descricao'); const raw = value(r, 'valor'); const amount = raw ? parseDecimal(raw) : NaN; const due = date(value(r, 'vencimento')); const directionRaw = value(r, 'tipo', 'direcao')?.toUpperCase(); const direction = ['PAGAR', 'PAYABLE', 'P'].includes(directionRaw ?? '') ? 'PAYABLE' : ['RECEBER', 'RECEIVABLE', 'R'].includes(directionRaw ?? '') ? 'RECEIVABLE' : null;
      if (!externalId || !description || !direction || !due || !(amount > 0)) throw new Error('ID, tipo (pagar/receber), descrição, valor e vencimento válidos são obrigatórios.');
      const existing = await tx.financialTitle.findUnique({ where: { tenantId_origin_originRef: { tenantId, origin: 'MIGRATION', originRef: externalId } }, select: { id: true } });
      const data = { direction, description, amount, dueDate: due, issueDate: date(value(r, 'emissao')), counterpartyName: value(r, 'cliente_fornecedor', 'pessoa'), documentRef: value(r, 'documento'), origin: 'MIGRATION', originRef: externalId, createdById: ctx.userId };
      if (!dry) existing ? await tx.financialTitle.update({ where: { id: existing.id }, data }) : await tx.financialTitle.create({ data: { tenantId, ...data } });
      existing ? stats.updated++ : stats.created++; return;
    }
    const externalId = value(r, 'id', 'codigo', 'external_id'); const kind = value(r, 'tipo', 'kind')?.toUpperCase();
    if (!externalId || !kind) throw new Error('ID externo e tipo são obrigatórios.');
    const existing = await tx.legacyImportRecord.findUnique({ where: { tenantId_kind_externalId: { tenantId, kind, externalId } }, select: { id: true } });
    const rawAmount = value(r, 'valor'); const amount = rawAmount ? parseDecimal(rawAmount) : undefined;
    const data = { occurredAt: date(value(r, 'data')), description: value(r, 'descricao'), amount: Number.isFinite(amount) ? amount : undefined, payload: r as Prisma.InputJsonValue };
    if (!dry) existing ? await tx.legacyImportRecord.update({ where: { id: existing.id }, data }) : await tx.legacyImportRecord.create({ data: { tenantId, externalId, kind, ...data } });
    existing ? stats.updated++ : stats.created++;
  }
}

@Controller()
export class WorkspaceController {
  constructor(private readonly svc: WorkspaceService) {}
  @Get('onboarding') @RequirePermissions('company.manage') status(@CurrentAuth() ctx: AuthContext) { return this.svc.onboarding(ctx); }
  @Post('onboarding/complete') @HttpCode(200) @RequirePermissions('company.manage') complete(@CurrentAuth() ctx: AuthContext) { return this.svc.completeOnboarding(ctx); }
  @Get('search') @RequirePermissions('company.view') search(@CurrentAuth() ctx: AuthContext, @Query() q: SearchQuery) { return this.svc.search(ctx, q.q, q.limit); }
  @Get('migration/runs') @RequirePermissions('migration.manage') runs(@CurrentAuth() ctx: AuthContext) { return this.svc.listRuns(ctx); }
  @Post('migration/import') @HttpCode(200) @RequirePermissions('migration.manage') migrate(@CurrentAuth() ctx: AuthContext, @Body() dto: ImportDto) { return this.svc.migrate(ctx, dto); }
}
