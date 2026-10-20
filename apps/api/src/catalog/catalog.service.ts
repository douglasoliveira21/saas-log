import { assertWithinPlan } from '../billing/limits';
import { normalizeContact } from '../common/phone';
import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/auth';
import { onlyDigits } from '../common/cnpj';
import { PrismaService } from '../prisma/prisma.service';
import { StockService } from '../stock/stock.service';
import {
  CreateCategoryDto, CreateProductDto, CreateSupplierDto, ImportDto, LinkSupplierDto, ProductQuery, UpdateProductDto, UpdateSupplierDto,
} from './catalog.dto';
import { mapImportRows, RowError } from './csv';

function conflict(e: unknown, message: string): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException(message);
  throw e;
}

const withFiscalFlag = <T extends { ncm: string | null }>(p: T) => ({ ...p, fiscalPending: !p.ncm });

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly stock: StockService,
  ) {}

  // ───────────── categorias ─────────────
  listCategories(ctx: AuthContext) {
    return this.prisma.withContext(ctx, (tx) => tx.productCategory.findMany({ where: { tenantId: ctx.tenantId! }, orderBy: { name: 'asc' } }));
  }

  createCategory(ctx: AuthContext, dto: CreateCategoryDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      const row = await tx.productCategory
        .create({ data: { tenantId: ctx.tenantId!, name: dto.name.trim() } })
        .catch((e) => conflict(e, 'Já existe uma categoria com este nome.'));
      await this.audit.record(tx, ctx, { action: 'category.created', entity: 'category', entityId: row.id, metadata: { name: row.name } });
      return row;
    });
  }

  // ───────────── produtos ─────────────
  async listProducts(ctx: AuthContext, q: ProductQuery) {
    const where: Prisma.ProductWhereInput = {
      tenantId: ctx.tenantId!,
      ...(q.categoryId ? { categoryId: q.categoryId } : {}),
      ...(q.fiscal === 'pending' ? { ncm: null } : {}),
      ...(q.search
        ? { OR: [{ sku: { contains: q.search, mode: 'insensitive' } }, { name: { contains: q.search, mode: 'insensitive' } }, { barcode: { contains: q.search } }] }
        : {}),
    };
    return this.prisma.withContext(ctx, async (tx) => {
      const [items, total] = await Promise.all([
        tx.product.findMany({
          where, orderBy: { name: 'asc' }, take: q.limit ?? 50, skip: q.offset ?? 0,
          select: { id: true, sku: true, name: true, barcode: true, brand: true, saleUnit: true, costPrice: true, suggestedPrice: true, minStock: true, ncm: true, active: true, category: { select: { name: true } } },
        }),
        tx.product.count({ where }),
      ]);
      return { total, items: items.map(withFiscalFlag) };
    });
  }

  getProduct(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const p = await tx.product.findFirst({
        where: { id, tenantId: ctx.tenantId! },
        include: { category: true, suppliers: { include: { supplier: { select: { legalName: true, tradeName: true } } } } },
      });
      if (!p) throw new NotFoundException('Produto não encontrado.');
      return withFiscalFlag(p);
    });
  }

  createProduct(ctx: AuthContext, dto: CreateProductDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      await this.assertCategory(tx, ctx, dto.categoryId);
      await assertWithinPlan(tx, ctx.tenantId!, 'products');
      const row = await tx.product
        .create({ data: { ...dto, tenantId: ctx.tenantId! } })
        .catch((e) => conflict(e, 'Já existe um produto com este SKU ou código de barras.'));
      await this.audit.record(tx, ctx, { action: 'product.created', entity: 'product', entityId: row.id, metadata: { sku: row.sku } });
      return withFiscalFlag(row);
    });
  }

  updateProduct(ctx: AuthContext, id: string, dto: UpdateProductDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      const current = await tx.product.findFirst({ where: { id, tenantId: ctx.tenantId! } });
      if (!current) throw new NotFoundException('Produto não encontrado.');
      await this.assertCategory(tx, ctx, dto.categoryId);
      const row = await tx.product.update({ where: { id }, data: dto }).catch((e) => conflict(e, 'Já existe um produto com este código de barras.'));
      // Preço/custo/fiscal são campos sensíveis: registramos o antes e o depois.
      const sensitive = ['costPrice', 'extraCost', 'suggestedPrice', 'minPrice', 'ncm', 'cest', 'taxOrigin', 'taxGtin'] as const;
      const changes = sensitive
        .filter((k) => dto[k] !== undefined && String(dto[k]) !== String(current[k] ?? ''))
        .map((k) => ({ field: k, from: current[k]?.toString() ?? null, to: String(dto[k]) }));
      await this.audit.record(tx, ctx, {
        action: changes.length ? 'product.sensitive_updated' : 'product.updated', entity: 'product', entityId: id,
        metadata: { fields: Object.keys(dto), changes },
      });
      return withFiscalFlag(row);
    });
  }

  linkSupplier(ctx: AuthContext, productId: string, dto: LinkSupplierDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      const [p, s] = await Promise.all([
        tx.product.findFirst({ where: { id: productId, tenantId: ctx.tenantId! }, select: { id: true } }),
        tx.supplier.findFirst({ where: { id: dto.supplierId, tenantId: ctx.tenantId! }, select: { id: true } }),
      ]);
      if (!p) throw new NotFoundException('Produto não encontrado.');
      if (!s) throw new NotFoundException('Fornecedor não encontrado.');
      if (dto.isMain) await tx.productSupplier.updateMany({ where: { productId, tenantId: ctx.tenantId! }, data: { isMain: false } });
      await tx.$executeRaw`DELETE FROM product_suppliers WHERE product_id = ${productId}::uuid AND supplier_id = ${dto.supplierId}::uuid`;
      await tx.productSupplier.create({ data: { tenantId: ctx.tenantId!, productId, supplierId: dto.supplierId, supplierSku: dto.supplierSku, lastPrice: dto.lastPrice, isMain: dto.isMain ?? false } });
      await this.audit.record(tx, ctx, { action: 'product.supplier_linked', entity: 'product', entityId: productId, metadata: { supplierId: dto.supplierId } });
      return { ok: true };
    });
  }

  unlinkSupplier(ctx: AuthContext, productId: string, supplierId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const n = await tx.$executeRaw`DELETE FROM product_suppliers WHERE tenant_id = ${ctx.tenantId}::uuid AND product_id = ${productId}::uuid AND supplier_id = ${supplierId}::uuid`;
      if (!n) throw new NotFoundException('Vínculo não encontrado.');
      await this.audit.record(tx, ctx, { action: 'product.supplier_unlinked', entity: 'product', entityId: productId, metadata: { supplierId } });
      return { ok: true };
    });
  }

  // ───────────── importação por planilha (CSV) ─────────────
  async importCsv(ctx: AuthContext, dto: ImportDto) {
    const { rows, errors: parseErrors } = mapImportRows(dto.csv);
    const result = await this.prisma.withContext(ctx, async (tx) => {
      const errors: RowError[] = [...parseErrors];
      if (!rows.length) return { created: 0, updated: 0, initialized: 0, errors, committed: false, rows: [] as typeof rows };
      const canInit = ctx.permissions.has('stock.adjust');
      const skus = rows.map((r) => r.sku);
      const existing = new Map((await tx.product.findMany({ where: { tenantId: ctx.tenantId!, sku: { in: skus } }, select: { id: true, sku: true } })).map((p) => [p.sku, p.id]));
      const barcodes = rows.map((r) => r.barcode).filter((b): b is string => !!b);
      const owners = new Map((await tx.product.findMany({ where: { tenantId: ctx.tenantId!, barcode: { in: barcodes } }, select: { sku: true, barcode: true } })).map((p) => [p.barcode!, p.sku]));
      const seenBarcodes = new Map<string, string>();
      const whs = new Map((await tx.warehouse.findMany({ where: { tenantId: ctx.tenantId!, active: true }, select: { id: true, code: true } })).map((w) => [w.code, w.id]));

      const valid = rows.filter((r) => {
        const problems: string[] = [];
        if (r.barcode) {
          if (!/^\d{8,14}$/.test(r.barcode)) problems.push('código de barras inválido');
          else if (owners.has(r.barcode) && owners.get(r.barcode) !== r.sku) problems.push(`código de barras já usado pelo SKU ${owners.get(r.barcode)}`);
          else if (seenBarcodes.has(r.barcode)) problems.push(`código de barras repetido no arquivo (SKU ${seenBarcodes.get(r.barcode)})`);
          else seenBarcodes.set(r.barcode, r.sku);
        }
        if (r.warehouseCode && !whs.has(r.warehouseCode)) problems.push(`depósito ${r.warehouseCode} não encontrado`);
        if (r.initialStock !== undefined && !canInit) problems.push('saldo inicial exige a permissão de ajuste de estoque');
        if (problems.length) errors.push({ line: r.line, message: problems.join('; ') });
        return !problems.length;
      });
      const newProducts = valid.filter((r) => !existing.has(r.sku)).length;
      if (newProducts && !dto.dryRun && !(errors.length && !dto.skipInvalid)) await assertWithinPlan(tx, ctx.tenantId!, 'products', newProducts);
      if ((errors.length && !dto.skipInvalid) || dto.dryRun) {
        const created = valid.filter((r) => !existing.has(r.sku)).length;
        return { created, updated: valid.length - created, initialized: valid.filter((r) => r.initialStock).length, errors, committed: false, rows: valid };
      }

      const batch = randomUUID();
      const catIds = new Map((await tx.productCategory.findMany({ where: { tenantId: ctx.tenantId! } })).map((c) => [c.name.toLowerCase(), c.id]));
      let created = 0, updated = 0, initialized = 0;
      for (const r of valid) {
        let categoryId: string | undefined;
        if (r.category) {
          categoryId = catIds.get(r.category.toLowerCase());
          if (!categoryId) {
            categoryId = (await tx.productCategory.create({ data: { tenantId: ctx.tenantId!, name: r.category } })).id;
            catIds.set(r.category.toLowerCase(), categoryId);
          }
        }
        const data = {
          name: r.name, barcode: r.barcode, brand: r.brand, manufacturer: r.manufacturer, categoryId, saleUnit: r.saleUnit,
          costPrice: r.costPrice, suggestedPrice: r.suggestedPrice, minPrice: r.minPrice, minStock: r.minStock, ncm: r.ncm, cest: r.cest,
        };
        let productId = existing.get(r.sku);
        if (productId) { await tx.product.update({ where: { id: productId }, data }); updated++; }
        else { productId = (await tx.product.create({ data: { ...data, sku: r.sku, tenantId: ctx.tenantId! } })).id; created++; }
        if (r.initialStock && r.warehouseCode) {
          const warehouseId = whs.get(r.warehouseCode)!;
          await this.stock.ensureBalance(tx, ctx, productId, warehouseId);
          const [bal] = await tx.$queryRaw<{ on_hand: number }[]>`SELECT on_hand FROM stock_balances WHERE product_id = ${productId}::uuid AND warehouse_id = ${warehouseId}::uuid AND tenant_id = ${ctx.tenantId}::uuid FOR UPDATE`;
          if (bal.on_hand !== 0) { errors.push({ line: r.line, message: 'saldo inicial ignorado: o produto já possui saldo no depósito' }); continue; }
          await this.stock.applyMovement(tx, ctx, {
            productId, warehouseId, type: 'ADJUSTMENT', quantity: r.initialStock, reason: 'Saldo inicial (importação)',
            reference: `importacao:${batch}`, idempotencyKey: `import:${batch}:${r.sku}`,
          });
          initialized++;
        }
      }
      await this.audit.record(tx, ctx, { action: 'products.imported', entity: 'product', metadata: { batch, created, updated, initialized, skipped: errors.length } });
      return { created, updated, initialized, errors, committed: true, rows: valid };
    });
    const { rows: _omit, ...summary } = result;
    if (!summary.committed && !dto.dryRun) {
      throw new UnprocessableEntityException({ message: 'A planilha contém erros. Corrija-os ou use "ignorar linhas inválidas".', ...summary });
    }
    return summary;
  }

  // ───────────── fornecedores ─────────────
  listSuppliers(ctx: AuthContext, search?: string) {
    return this.prisma.withContext(ctx, (tx) =>
      tx.supplier.findMany({
        where: { tenantId: ctx.tenantId!, ...(search ? { OR: [{ legalName: { contains: search, mode: 'insensitive' } }, { tradeName: { contains: search, mode: 'insensitive' } }, { document: { contains: onlyDigits(search) || '∅' } }] } : {}) },
        orderBy: { legalName: 'asc' }, take: 200,
      }),
    );
  }

  createSupplier(ctx: AuthContext, dto: CreateSupplierDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      const row = await tx.supplier
        .create({ data: { ...normalizeContact(dto), document: dto.document ? onlyDigits(dto.document) : undefined, tenantId: ctx.tenantId! } })
        .catch((e) => conflict(e, 'Já existe um fornecedor com este documento.'));
      await this.audit.record(tx, ctx, { action: 'supplier.created', entity: 'supplier', entityId: row.id, metadata: { legalName: row.legalName } });
      return row;
    });
  }

  updateSupplier(ctx: AuthContext, id: string, dto: UpdateSupplierDto) {
    return this.prisma.withContext(ctx, async (tx) => {
      if (!(await tx.supplier.findFirst({ where: { id, tenantId: ctx.tenantId! }, select: { id: true } }))) throw new NotFoundException('Fornecedor não encontrado.');
      const row = await tx.supplier
        .update({ where: { id }, data: { ...normalizeContact(dto), document: dto.document ? onlyDigits(dto.document) : undefined } })
        .catch((e) => conflict(e, 'Já existe um fornecedor com este documento.'));
      await this.audit.record(tx, ctx, { action: 'supplier.updated', entity: 'supplier', entityId: id, metadata: { fields: Object.keys(dto) } });
      return row;
    });
  }

  private async assertCategory(tx: Prisma.TransactionClient, ctx: AuthContext, categoryId?: string) {
    if (categoryId && !(await tx.productCategory.findFirst({ where: { id: categoryId, tenantId: ctx.tenantId! }, select: { id: true } }))) {
      throw new BadRequestException('Categoria inválida.');
    }
  }
}
