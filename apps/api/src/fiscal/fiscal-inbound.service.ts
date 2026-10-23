import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/auth';
import { isValidCnpj, onlyDigits } from '../common/cnpj';
import { PrismaService } from '../prisma/prisma.service';
import { PurchasingService } from '../purchasing/purchasing.service';
import { FISCAL_PROVIDER, FiscalEnvironment, FiscalProvider } from './fiscal-provider';
import { ProviderContextService } from './fiscal-provider.router';
import { MANIFEST } from './sefaz/messages';
import { Issue, NfeParseError, parseNfe, validateNfe } from './nfe-xml';

type Tx = Prisma.TransactionClient;
const dec = (v: Prisma.Decimal | null | undefined) => (v === null || v === undefined ? 0 : Number(v));

/** Converte a quantidade comercial do XML para unidades de estoque do produto (regra explícita; fora dela exige revisão). */
export function toStockQty(qty: number, xmlUnit: string, p: { saleUnit: string; purchaseUnit: string; unitConversion: number }): { qty: number | null; reason?: string } {
  const u = xmlUnit.trim().toUpperCase();
  const converted = u === p.saleUnit.toUpperCase() ? qty : u === p.purchaseUnit.toUpperCase() ? qty * p.unitConversion : null;
  if (converted === null) return { qty: null, reason: `Unidade "${xmlUnit}" não corresponde à unidade de venda (${p.saleUnit}) nem à de compra (${p.purchaseUnit}) do produto.` };
  if (!Number.isInteger(converted)) return { qty: null, reason: `Quantidade convertida (${converted}) não é inteira.` };
  return { qty: converted };
}

export type LineStatus = 'OK' | 'NO_PRODUCT' | 'NEEDS_REVIEW' | 'NOT_IN_PO' | 'QTY_EXCEEDS_PENDING' | 'QTY_PARTIAL' | 'COST_DIVERGENT';

@Injectable()
export class FiscalInboundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly purchasing: PurchasingService,
    @Inject(FISCAL_PROVIDER) private readonly provider: FiscalProvider,
    private readonly pctx: ProviderContextService,
  ) {}

  // ───────────── importação ─────────────

  async importXml(ctx: AuthContext, dto: { xml: string; source?: string }) {
    let parsed;
    try {
      parsed = parseNfe(dto.xml);
    } catch (e) {
      if (e instanceof NfeParseError) throw new BadRequestException(e.message);
      throw e;
    }
    const run = () => this.prisma.withContext(ctx, async (tx) => {
      const ests = await tx.establishment.findMany({ where: { tenantId: ctx.tenantId!, active: true, cnpj: { not: null } }, select: { id: true, cnpj: true } });
      const issues: Issue[] = validateNfe(parsed, { establishmentDocs: ests.map((e) => onlyDigits(e.cnpj!)) });
      const blocking = issues.filter((i) => i.severity === 'BLOCKING');
      if (blocking.length) {
        // Registra a tentativa e sinaliza; a exceção sai depois do commit (senão a auditoria seria desfeita).
        await this.audit.record(tx, ctx, { action: 'fiscal.xml_rejected', entity: 'fiscal_document', metadata: { accessKey: parsed.accessKey, codes: blocking.map((b) => b.code) } });
        return { rejected: true as const, issues };
      }
      const dup = await tx.fiscalDocument.findUnique({ where: { tenantId_accessKey: { tenantId: ctx.tenantId!, accessKey: parsed.accessKey } }, select: { id: true } });
      if (dup) throw new ConflictException({ message: 'Esta nota já foi importada.', documentId: dup.id });

      const est = ests.find((e) => onlyDigits(e.cnpj!) === parsed.recipient.doc)!;
      const supplier = await tx.supplier.findFirst({ where: { tenantId: ctx.tenantId!, document: parsed.emitter.doc } });
      const doc = await tx.fiscalDocument.create({
        data: {
          tenantId: ctx.tenantId!, direction: 'ENTRY', model: parsed.model, status: 'IMPORTED', accessKey: parsed.accessKey, series: parsed.series, number: parsed.number,
          environment: parsed.environment, issuedAt: parsed.issuedAt, establishmentId: est.id, emitterDoc: parsed.emitter.doc, emitterName: parsed.emitter.name, emitterUf: parsed.emitter.uf,
          recipientDoc: parsed.recipient.doc, totalProducts: parsed.totals.vProd.toFixed(2), totalInvoice: parsed.totals.vNF.toFixed(2), totalFreight: parsed.totals.vFrete.toFixed(2),
          authProtocol: parsed.protocol?.number ?? null, authStatusCode: parsed.protocol?.statusCode ?? null, authenticity: 'UNVERIFIED',
          issues: issues as unknown as Prisma.InputJsonValue, installments: parsed.installments as unknown as Prisma.InputJsonValue, supplierId: supplier?.id ?? null, importedById: ctx.userId,
        },
      });
      await tx.fiscalXmlFile.create({ data: { tenantId: ctx.tenantId!, documentId: doc.id, kind: 'RECEIVED', sha256: createHash('sha256').update(dto.xml).digest('hex'), content: dto.xml, source: dto.source, createdById: ctx.userId } });

      let matched = 0;
      for (const it of parsed.items) {
        const product = await this.matchProduct(tx, ctx.tenantId!, supplier?.id ?? null, it.supplierCode, it.gtin);
        const conv = product ? toStockQty(it.quantity, it.unit, product.p) : null;
        if (product) matched++;
        await tx.fiscalDocumentItem.create({
          data: {
            tenantId: ctx.tenantId!, documentId: doc.id, line: it.line, supplierCode: it.supplierCode, gtin: it.gtin, description: it.description, ncm: it.ncm, cfop: it.cfop, unit: it.unit,
            quantity: it.quantity.toFixed(4), unitValue: it.unitValue.toFixed(6), totalValue: it.totalValue.toFixed(2), declaredTax: it.declaredTax as Prisma.InputJsonValue,
            productId: product?.p.id ?? null, matchedBy: product?.by ?? null, stockQty: conv?.qty ?? null,
          },
        });
      }
      await this.audit.record(tx, ctx, { action: 'fiscal.xml_imported', entity: 'fiscal_document', entityId: doc.id, metadata: { accessKey: parsed.accessKey, number: parsed.number, series: parsed.series, emitter: parsed.emitter.doc, items: parsed.items.length, matched } });
      return { id: doc.id, accessKey: parsed.accessKey, supplierFound: !!supplier, items: parsed.items.length, matched, issues };
    });
    try {
      const res = await run();
      if ('rejected' in res) throw new UnprocessableEntityException({ message: 'O XML não pode ser importado: há problemas bloqueantes.', issues: res.issues });
      return res;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const dup = await this.prisma.withContext(ctx, (tx) => tx.fiscalDocument.findUnique({ where: { tenantId_accessKey: { tenantId: ctx.tenantId!, accessKey: parsed.accessKey } }, select: { id: true } }));
        throw new ConflictException({ message: 'Esta nota já foi importada.', documentId: dup?.id });
      }
      throw e;
    }
  }

  private async matchProduct(tx: Tx, tenantId: string, supplierId: string | null, supplierCode: string, gtin: string | null) {
    const sel = { id: true, saleUnit: true, purchaseUnit: true, unitConversion: true } as const;
    if (supplierId && supplierCode) {
      const link = await tx.productSupplier.findFirst({ where: { tenantId, supplierId, supplierSku: supplierCode }, include: { product: { select: sel } } });
      if (link) return { p: link.product, by: 'SUPPLIER_CODE' as const };
    }
    if (gtin) {
      const p = await tx.product.findFirst({ where: { tenantId, barcode: gtin, active: true }, select: sel });
      if (p) return { p, by: 'GTIN' as const };
    }
    return null;
  }

  // ───────────── manifestação do destinatário ─────────────

  /**
   * Manifestação do destinatário sobre uma nota recebida (ciência, confirmação, desconhecimento ou operação não realizada), enviada ao
   * Ambiente Nacional com o certificado A1 do estabelecimento destinatário. Exige emissão direta configurada para o estabelecimento.
   */
  async manifest(ctx: AuthContext, id: string, action: string, justification?: string) {
    const cfg = MANIFEST[action];
    if (!cfg) throw new BadRequestException('Tipo de manifestação inválido (ciência, confirmação, desconhecimento ou operação não realizada).');
    if (cfg.needsReason && (justification ?? '').trim().length < 15) throw new BadRequestException('Operação não realizada exige justificativa de 15 a 255 caracteres.');
    const ref = await this.prisma.withContext(ctx, async (tx) => {
      const d = await tx.fiscalDocument.findFirst({ where: { id, tenantId: ctx.tenantId!, direction: 'ENTRY' } });
      if (!d) throw new NotFoundException('Nota recebida não encontrada.');
      if (!d.accessKey || d.model !== '55') throw new ConflictException('A manifestação do destinatário vale para NF-e (modelo 55) com chave de acesso.');
      if (!d.establishmentId) throw new ConflictException('Nota sem estabelecimento destinatário.');
      const est = await tx.establishment.findFirst({ where: { id: d.establishmentId, tenantId: ctx.tenantId! }, select: { cnpj: true } });
      const pc = await this.pctx.resolve(tx, ctx.tenantId!, d.establishmentId, '55', ((await tx.fiscalConfiguration.findFirst({ where: { tenantId: ctx.tenantId!, establishmentId: d.establishmentId } }))?.environment as FiscalEnvironment) ?? 'HOMOLOGACAO');
      if (!this.provider.sendEvent || !this.provider.isConfigured(pc) || pc.providerName !== 'SEFAZ_DIRECT') throw new HttpException({ message: 'A manifestação do destinatário exige a emissão direta na SEFAZ configurada (com certificado A1) neste estabelecimento.', code: 'NOT_SUPPORTED' }, HttpStatus.FAILED_DEPENDENCY);
      const prior = await tx.fiscalEvent.findFirst({ where: { tenantId: ctx.tenantId!, documentId: id, tpEvento: cfg.tp, status: 'REGISTERED' } });
      if (prior) throw new ConflictException(`Esta manifestação (${cfg.label}) já foi registrada para a nota.`);
      return { pc, accessKey: d.accessKey, cnpj: onlyDigits(est?.cnpj ?? d.recipientDoc ?? '') };
    });
    const r = await this.provider.sendEvent!({ kind: 'MANIFEST', accessKey: ref.accessKey, seq: 1, action: action as 'CIENCIA', text: justification?.trim(), cnpj: ref.cnpj }, ref.pc);
    return this.prisma.withContext(ctx, async (tx) => {
      const ok = r.kind === 'REGISTERED';
      const ev = await tx.fiscalEvent.create({ data: { tenantId: ctx.tenantId!, documentId: id, kind: 'MANIFEST', tpEvento: cfg.tp, seq: 1, text: justification?.trim() ?? null, status: ok ? 'REGISTERED' : 'REJECTED', statusCode: r.kind === 'UNAVAILABLE' ? null : r.statusCode, protocol: ok ? r.protocol : null, message: ok ? null : r.reason, createdById: ctx.userId } });
      await this.audit.record(tx, ctx, { action: ok ? 'fiscal.manifest_registered' : 'fiscal.manifest_failed', entity: 'fiscal_document', entityId: id, metadata: { action, result: r.kind, statusCode: r.kind === 'UNAVAILABLE' ? null : r.statusCode } });
      if (r.kind === 'REGISTERED') return { id: ev.id, action, protocol: r.protocol, statusCode: r.statusCode };
      throw new ConflictException(r.kind === 'REJECTED' ? `Manifestação recusada (${r.statusCode}): ${r.reason}` : r.reason);
    });
  }

  events(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      if (!(await tx.fiscalDocument.findFirst({ where: { id, tenantId: ctx.tenantId!, direction: 'ENTRY' }, select: { id: true } }))) throw new NotFoundException('Nota recebida não encontrada.');
      return tx.fiscalEvent.findMany({ where: { tenantId: ctx.tenantId!, documentId: id }, orderBy: { createdAt: 'desc' }, select: { id: true, kind: true, tpEvento: true, seq: true, text: true, status: true, statusCode: true, protocol: true, message: true, createdAt: true } });
    });
  }

  // ───────────── consulta ─────────────

  list(ctx: AuthContext, status?: string) {
    return this.prisma.withContext(ctx, (tx) =>
      tx.fiscalDocument.findMany({
        where: { tenantId: ctx.tenantId!, direction: 'ENTRY', ...(status ? { status } : {}) }, orderBy: { createdAt: 'desc' }, take: 100,
        select: { id: true, accessKey: true, number: true, series: true, status: true, emitterName: true, emitterDoc: true, totalInvoice: true, issuedAt: true, environment: true, supplierId: true, purchaseOrderId: true, issues: true, createdAt: true },
      }),
    );
  }

  get(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const d = await tx.fiscalDocument.findFirst({
        where: { id, tenantId: ctx.tenantId!, direction: 'ENTRY' },
        include: {
          items: { orderBy: { line: 'asc' }, include: { product: { select: { sku: true, name: true } } } },
          xmlFiles: { select: { id: true, kind: true, sha256: true, source: true, createdAt: true } },
          supplier: { select: { legalName: true } },
        },
      });
      if (!d) throw new NotFoundException('Documento não encontrado.');
      return d;
    });
  }

  /** Download do XML original (auditado: contém dados comerciais sensíveis). */
  async xml(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const f = await tx.fiscalXmlFile.findFirst({ where: { documentId: id, tenantId: ctx.tenantId! }, orderBy: { createdAt: 'asc' } });
      if (!f) throw new NotFoundException('XML não encontrado.');
      await this.audit.record(tx, ctx, { action: 'fiscal.xml_viewed', entity: 'fiscal_document', entityId: id, metadata: { sha256: f.sha256 } });
      return { sha256: f.sha256, content: f.content };
    });
  }

  // ───────────── vínculos ─────────────

  linkItem(ctx: AuthContext, docId: string, line: number, productId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const doc = await this.doc(tx, ctx, docId);
      if (doc.status !== 'IMPORTED') throw new ConflictException('A nota já foi recebida.');
      const item = await tx.fiscalDocumentItem.findFirst({ where: { documentId: docId, line, tenantId: ctx.tenantId! } });
      if (!item) throw new NotFoundException('Item não encontrado.');
      const p = await tx.product.findFirst({ where: { id: productId, tenantId: ctx.tenantId!, kind: 'PHYSICAL', active: true }, select: { id: true, saleUnit: true, purchaseUnit: true, unitConversion: true } });
      if (!p) throw new BadRequestException('Produto inválido, inativo ou não físico.');
      const conv = toStockQty(dec(item.quantity), item.unit ?? '', p);
      await tx.fiscalDocumentItem.update({ where: { id: item.id }, data: { productId, matchedBy: 'MANUAL', stockQty: conv.qty } });
      // Memoriza o código do fornecedor para as próximas notas.
      if (doc.supplierId && item.supplierCode) {
        await tx.productSupplier.upsert({
          where: { productId_supplierId: { productId, supplierId: doc.supplierId } },
          create: { tenantId: ctx.tenantId!, productId, supplierId: doc.supplierId, supplierSku: item.supplierCode },
          update: { supplierSku: item.supplierCode },
        });
      }
      await this.audit.record(tx, ctx, { action: 'fiscal.item_linked', entity: 'fiscal_document', entityId: docId, metadata: { line, productId } });
      return { line, productId, stockQty: conv.qty, warning: conv.reason ?? null };
    });
  }

  createSupplier(ctx: AuthContext, docId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      if (!ctx.permissions.has('suppliers.manage')) throw new ForbiddenException('Você não tem permissão para cadastrar fornecedores.');
      const doc = await this.doc(tx, ctx, docId);
      if (doc.supplierId) throw new ConflictException('O fornecedor já está vinculado.');
      if (!doc.emitterDoc) throw new BadRequestException('Documento sem emitente.');
      const existing = await tx.supplier.findFirst({ where: { tenantId: ctx.tenantId!, document: doc.emitterDoc } });
      const supplier = existing ?? (await tx.supplier.create({ data: { tenantId: ctx.tenantId!, legalName: doc.emitterName ?? doc.emitterDoc, document: isValidCnpj(doc.emitterDoc) || doc.emitterDoc.length === 11 ? doc.emitterDoc : null } }));
      await tx.fiscalDocument.update({ where: { id: docId }, data: { supplierId: supplier.id } });
      // Reaplica o vínculo automático por GTIN/código agora que há fornecedor.
      const items = await tx.fiscalDocumentItem.findMany({ where: { documentId: docId, tenantId: ctx.tenantId!, productId: null } });
      for (const it of items) {
        const m = await this.matchProduct(tx, ctx.tenantId!, supplier.id, it.supplierCode ?? '', it.gtin);
        if (m) await tx.fiscalDocumentItem.update({ where: { id: it.id }, data: { productId: m.p.id, matchedBy: m.by, stockQty: toStockQty(dec(it.quantity), it.unit ?? '', m.p).qty } });
      }
      await this.audit.record(tx, ctx, { action: 'fiscal.supplier_from_xml', entity: 'supplier', entityId: supplier.id, metadata: { documentId: docId, created: !existing } });
      return { supplierId: supplier.id, created: !existing };
    });
  }

  // ───────────── conciliação com a ordem de compra ─────────────

  /** Sem `purchaseOrderId`, sugere as ordens em aberto do fornecedor (por cobertura dos itens). */
  reconcile(ctx: AuthContext, docId: string, purchaseOrderId?: string) {
    return this.prisma.withContext(ctx, (tx) => this.reconcileTx(tx, ctx, docId, purchaseOrderId));
  }

  private async reconcileTx(tx: Tx, ctx: AuthContext, docId: string, purchaseOrderId?: string) {
    const doc = await tx.fiscalDocument.findFirst({ where: { id: docId, tenantId: ctx.tenantId!, direction: 'ENTRY' }, include: { items: { orderBy: { line: 'asc' } } } });
    if (!doc) throw new NotFoundException('Documento não encontrado.');
    const productIds = doc.items.map((i) => i.productId).filter((p): p is string => !!p);
    const open = await tx.purchaseOrder.findMany({
      where: { tenantId: ctx.tenantId!, status: { in: ['APPROVED', 'PARTIALLY_RECEIVED'] }, ...(doc.supplierId ? { supplierId: doc.supplierId } : { id: '00000000-0000-0000-0000-000000000000' }) },
      include: { items: true }, orderBy: { number: 'desc' },
    });
    const suggestions = open.map((po) => ({ id: po.id, number: po.number, total: po.total.toString(), coverage: productIds.filter((p) => po.items.some((i) => i.productId === p && i.qtyOrdered > i.qtyReceived)).length })).sort((a, b) => b.coverage - a.coverage);
    if (!purchaseOrderId) return { document: { id: doc.id, number: doc.number, supplierId: doc.supplierId, status: doc.status }, suggestions };

    const po = await tx.purchaseOrder.findFirst({ where: { id: purchaseOrderId, tenantId: ctx.tenantId! }, include: { items: { include: { product: { select: { sku: true } } } } } });
    if (!po) throw new NotFoundException('Ordem de compra não encontrada.');
    if (doc.supplierId && po.supplierId !== doc.supplierId) throw new ConflictException('A ordem de compra é de outro fornecedor.');
    if (!['APPROVED', 'PARTIALLY_RECEIVED'].includes(po.status)) throw new ConflictException(`A ordem está "${po.status}" e não aceita recebimento.`);

    const lines = doc.items.map((it) => {
      const poItem = po.items.find((x) => x.productId === it.productId);
      const base = { line: it.line, description: it.description, productId: it.productId, nfQty: it.stockQty, nfUnitCost: it.stockQty ? Math.round((dec(it.totalValue) / it.stockQty) * 10000) / 10000 : null };
      if (!it.productId) return { ...base, status: 'NO_PRODUCT' as LineStatus, detail: 'Item sem produto vinculado.' };
      if (it.stockQty === null) return { ...base, status: 'NEEDS_REVIEW' as LineStatus, detail: 'Unidade/quantidade não convertida para o estoque: revise o vínculo do item.' };
      if (!poItem) return { ...base, status: 'NOT_IN_PO' as LineStatus, detail: 'Produto não consta na ordem de compra.' };
      const pending = poItem.qtyOrdered - poItem.qtyReceived;
      const poCost = dec(poItem.unitCost);
      const costDiff = poCost > 0 && base.nfUnitCost !== null ? (base.nfUnitCost - poCost) / poCost : 0;
      const common = { ...base, poPending: pending, poUnitCost: poCost, costDiffPct: Math.round(costDiff * 10000) / 100 };
      if (it.stockQty > pending) return { ...common, status: 'QTY_EXCEEDS_PENDING' as LineStatus, detail: `Quantidade da nota (${it.stockQty}) maior que o pendente na ordem (${pending}).` };
      if (Math.abs(costDiff) > 0.005) return { ...common, status: 'COST_DIVERGENT' as LineStatus, detail: `Custo unitário da nota difere ${(costDiff * 100).toFixed(2)}% do combinado na ordem.` };
      if (it.stockQty < pending) return { ...common, status: 'QTY_PARTIAL' as LineStatus, detail: `Entrega parcial: faltam ${pending - it.stockQty} unidade(s).` };
      return { ...common, status: 'OK' as LineStatus, detail: 'Conforme a ordem de compra.' };
    });
    const notDelivered = po.items.filter((p) => p.qtyOrdered > p.qtyReceived && !doc.items.some((i) => i.productId === p.productId)).map((p) => ({ productId: p.productId, sku: p.product.sku, pending: p.qtyOrdered - p.qtyReceived }));
    const blocking = lines.filter((l) => ['NO_PRODUCT', 'NEEDS_REVIEW', 'NOT_IN_PO', 'QTY_EXCEEDS_PENDING'].includes(l.status));
    return {
      document: { id: doc.id, number: doc.number, supplierId: doc.supplierId, status: doc.status, totalInvoice: doc.totalInvoice?.toString() },
      purchaseOrder: { id: po.id, number: po.number, total: po.total.toString(), status: po.status },
      lines, notDelivered, suggestions,
      costDivergent: lines.some((l) => l.status === 'COST_DIVERGENT'),
      canReceive: blocking.length === 0 && doc.status === 'IMPORTED' && !!doc.supplierId,
      blockers: blocking.map((b) => `Item ${b.line}: ${b.detail}`),
    };
  }

  // ───────────── recebimento ─────────────

  /**
   * Gera o recebimento físico da ordem a partir da nota (quantidades e custos do XML). Idempotente pela chave de acesso.
   * Divergência de custo exige confirmação explícita. Notas de homologação nunca geram recebimento.
   */
  async receive(ctx: AuthContext, docId: string, dto: { purchaseOrderId: string; acceptCostDivergence?: boolean }) {
    if (!ctx.permissions.has('purchases.receive')) throw new ForbiddenException('Você não tem permissão para registrar recebimentos.');
    const pre = await this.prisma.withContext(ctx, async (tx) => {
      const doc = await this.doc(tx, ctx, docId);
      if (doc.environment === 'HOMOLOGACAO') throw new UnprocessableEntityException('Nota emitida em homologação não tem valor fiscal e não pode gerar recebimento.');
      if (doc.status !== 'IMPORTED') throw new ConflictException('A nota já foi recebida.');
      if (!doc.supplierId) throw new ConflictException('Vincule ou cadastre o fornecedor da nota antes de receber.');
      const rec = await this.reconcileTx(tx, ctx, docId, dto.purchaseOrderId);
      if (!('lines' in rec) || !rec.canReceive) throw new ConflictException({ message: 'A conciliação com a ordem de compra tem pendências.', blockers: 'blockers' in rec ? rec.blockers : [] });
      if (rec.costDivergent && !dto.acceptCostDivergence) throw new ConflictException({ message: 'Há divergência de custo em relação à ordem de compra: confirme explicitamente para receber.', requiresCostConfirmation: true, lines: rec.lines.filter((l) => l.status === 'COST_DIVERGENT') });
      const attempt = (await tx.goodsReceipt.count({ where: { tenantId: ctx.tenantId!, idempotencyKey: { startsWith: `nfe:${doc.accessKey}:` } } })) + 1;
      return { doc, rec, attempt };
    });

    const items = pre.rec.lines.filter((l) => l.nfQty && l.productId).map((l) => ({ productId: l.productId!, quantity: l.nfQty!, unitCost: l.nfUnitCost!, note: `NF-e ${pre.doc.number}/${pre.doc.series}` }));
    const result = await this.purchasing.receive(ctx, dto.purchaseOrderId, {
      idempotencyKey: `nfe:${pre.doc.accessKey}:${pre.attempt}`, note: `NF-e ${pre.doc.number}/${pre.doc.series} — chave ${pre.doc.accessKey}`, items,
    });
    await this.prisma.withContext(ctx, async (tx) => {
      await tx.fiscalDocument.update({ where: { id: docId }, data: { status: 'RECEIVED', purchaseOrderId: dto.purchaseOrderId, receiptId: result.receipt.id } });
      await this.audit.record(tx, ctx, { action: 'fiscal.xml_received', entity: 'fiscal_document', entityId: docId, metadata: { purchaseOrderId: dto.purchaseOrderId, receiptId: result.receipt.id, costDivergenceAccepted: !!dto.acceptCostDivergence } });
    });
    return { documentId: docId, receiptId: result.receipt.id, replayed: result.replayed };
  }

  private async doc(tx: Tx, ctx: Pick<AuthContext, 'tenantId'>, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM fiscal_documents WHERE id = ${id}::uuid AND tenant_id = ${ctx.tenantId}::uuid AND direction = 'ENTRY' FOR UPDATE`;
    if (!rows.length) throw new NotFoundException('Documento não encontrado.');
    return tx.fiscalDocument.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId! } });
  }
}

