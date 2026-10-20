import { BadRequestException, ConflictException, HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/auth';
import { isValidCnpj, isValidCpf, onlyDigits } from '../common/cnpj';
import { PrismaService } from '../prisma/prisma.service';
import { buildChave } from './chave';
import { ENGINE_VERSION, EngineOutput } from './engine';
import { FISCAL_PROVIDER, FiscalProvider } from './fiscal-provider';
import { Issue } from './nfe-xml';
import { TaxRulesService } from './tax-rules.service';

type Tx = Prisma.TransactionClient;
const OPEN_FOR_EDIT = ['PENDING_VALIDATION', 'READY_TO_TRANSMIT', 'REJECTED'];

/**
 * Documentos fiscais de SAÍDA (NF-e 55) — preparação e máquina de estados.
 * NÃO gera XML, NÃO assina e NÃO transmite por conta própria: isso depende do provedor/biblioteca (pendente) e do certificado.
 * O que existe aqui garante que, quando houver provedor, nada seja emitido em duplicidade nem marcado como autorizado sem confirmação.
 */
@Injectable()
export class FiscalOutgoingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly rules: TaxRulesService,
    @Inject(FISCAL_PROVIDER) private readonly provider: FiscalProvider,
  ) {}

  list(ctx: AuthContext, status?: string) {
    return this.prisma.withContext(ctx, (tx) =>
      tx.fiscalDocument.findMany({
        where: { tenantId: ctx.tenantId!, direction: 'EXIT', ...(status ? { status } : {}) }, orderBy: { createdAt: 'desc' }, take: 100,
        select: { id: true, status: true, number: true, series: true, accessKey: true, environment: true, totalInvoice: true, salesOrderId: true, issues: true, authProtocol: true, createdAt: true, salesOrder: { select: { number: true, customer: { select: { name: true } } } } },
      }),
    );
  }

  get(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const d = await tx.fiscalDocument.findFirst({
        where: { id, tenantId: ctx.tenantId!, direction: 'EXIT' },
        include: { items: { orderBy: { line: 'asc' } }, salesOrder: { select: { number: true, customer: { select: { name: true, document: true } } } } },
      });
      if (!d) throw new NotFoundException('Documento não encontrado.');
      const calc = d.calculationId ? await tx.taxCalculation.findFirst({ where: { id: d.calculationId, tenantId: ctx.tenantId! } }) : null;
      return { ...d, calculation: calc ? { id: calc.id, engineVersion: calc.engineVersion, ruleVersionIds: calc.ruleVersionIds, pendencies: calc.pendencies } : null };
    });
  }

  // ───────────── preparação ─────────────

  async prepare(ctx: AuthContext, dto: { salesOrderId: string; establishmentId?: string }) {
    return this.prisma.withContext(ctx, async (tx) => {
      const order = await tx.salesOrder.findFirst({
        where: { id: dto.salesOrderId, tenantId: ctx.tenantId! },
        include: { customer: true, items: { include: { product: true }, orderBy: { id: 'asc' } } },
      });
      if (!order) throw new NotFoundException('Pedido não encontrado.');
      if (['DRAFT', 'PENDING_APPROVAL', 'CANCELLED'].includes(order.status)) throw new ConflictException(`Pedido "${order.status}" não pode ser faturado.`);
      const existing = await tx.fiscalDocument.findFirst({ where: { tenantId: ctx.tenantId!, salesOrderId: order.id, direction: 'EXIT', NOT: { status: 'CANCELLED' } } });
      if (existing) return { id: existing.id, existing: true, status: existing.status };

      const est = dto.establishmentId
        ? await tx.establishment.findFirst({ where: { id: dto.establishmentId, tenantId: ctx.tenantId!, active: true }, include: { company: true } })
        : await tx.establishment.findFirst({ where: { tenantId: ctx.tenantId!, active: true }, include: { company: true }, orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }] });
      if (!est) throw new BadRequestException('Estabelecimento emissor não encontrado.');
      const cfg = await tx.fiscalConfiguration.upsert({ where: { tenantId_establishmentId: { tenantId: ctx.tenantId!, establishmentId: est.id } }, create: { tenantId: ctx.tenantId!, establishmentId: est.id }, update: {} });

      const doc = await tx.fiscalDocument.create({
        data: {
          tenantId: ctx.tenantId!, direction: 'EXIT', model: '55', status: 'DRAFT', environment: cfg.environment, establishmentId: est.id, series: cfg.nfeSeries,
          emitterDoc: est.cnpj ? onlyDigits(est.cnpj) : null, emitterName: est.company.legalName, emitterUf: est.state, recipientDoc: order.customer.document,
          totalProducts: order.items.reduce((s, i) => s + Number(i.total), 0).toFixed(2), totalInvoice: order.total, totalFreight: order.shipping, salesOrderId: order.id, importedById: ctx.userId,
        },
      });
      await tx.fiscalDocumentItem.createMany({
        data: order.items.map((i, idx) => ({
          tenantId: ctx.tenantId!, documentId: doc.id, line: idx + 1, supplierCode: i.product.sku, gtin: i.product.barcode, description: i.product.name, ncm: i.product.ncm, unit: i.product.saleUnit,
          quantity: i.quantity.toFixed(4), unitValue: (Number(i.total) / i.quantity).toFixed(6), totalValue: i.total.toString(), declaredTax: {}, productId: i.productId,
        })),
      });
      const res = await this.evaluate(tx, ctx, doc.id);
      await this.audit.record(tx, ctx, { action: 'fiscal.outgoing_prepared', entity: 'fiscal_document', entityId: doc.id, metadata: { salesOrderId: order.id, status: res.status, blocking: res.blocking } });
      return { id: doc.id, existing: false, status: res.status, issues: res.issues };
    });
  }

  async revalidate(ctx: AuthContext, id: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const doc = await this.lock(tx, ctx, id);
      if (!OPEN_FOR_EDIT.includes(doc.status)) throw new ConflictException(`Documento "${doc.status}" não pode ser revalidado.`);
      const res = await this.evaluate(tx, ctx, id);
      await this.audit.record(tx, ctx, { action: 'fiscal.outgoing_revalidated', entity: 'fiscal_document', entityId: id, metadata: { status: res.status } });
      return { id, status: res.status, issues: res.issues };
    });
  }

  /** Recalcula impostos (motor), confere dados do destinatário/emissor/certificado e define o status de validação. */
  private async evaluate(tx: Tx, ctx: AuthContext, docId: string): Promise<{ status: string; issues: Issue[]; blocking: number }> {
    const doc = await tx.fiscalDocument.findFirstOrThrow({ where: { id: docId, tenantId: ctx.tenantId! }, include: { items: { include: { product: true }, orderBy: { line: 'asc' } }, salesOrder: { include: { customer: true } } } });
    const est = await tx.establishment.findFirstOrThrow({ where: { id: doc.establishmentId!, tenantId: ctx.tenantId! }, include: { company: true } });
    const cfg = await tx.fiscalConfiguration.findFirstOrThrow({ where: { tenantId: ctx.tenantId!, establishmentId: est.id } });
    const cust = doc.salesOrder!.customer;
    const issues: Issue[] = [];
    const add = (severity: Issue['severity'], code: string, message: string) => issues.push({ severity, code, message });

    if (!est.cnpj || !isValidCnpj(est.cnpj)) add('BLOCKING', 'ESTABLISHMENT_DATA', 'Estabelecimento sem CNPJ válido.');
    if (!est.stateRegistration) add('BLOCKING', 'ESTABLISHMENT_DATA', 'Estabelecimento sem inscrição estadual.');
    if (!est.state) add('BLOCKING', 'ESTABLISHMENT_DATA', 'Estabelecimento sem UF.');
    if (!est.company.taxRegime) add('BLOCKING', 'ESTABLISHMENT_DATA', 'Regime tributário da empresa não informado.');
    const docOk = !!cust.document && (isValidCnpj(cust.document) || isValidCpf(cust.document));
    if (!docOk) add('BLOCKING', 'CUSTOMER_DATA', 'Cliente sem CPF/CNPJ válido.');
    if (!cust.street || !cust.city || !cust.state || !cust.zipCode) add('BLOCKING', 'CUSTOMER_DATA', 'Endereço do cliente incompleto (logradouro, município, UF e CEP).');
    const cert = await tx.fiscalCertificate.findFirst({ where: { tenantId: ctx.tenantId!, establishmentId: est.id, status: 'ACTIVE' } });
    if (!cert) add('BLOCKING', 'CERTIFICATE', 'Certificado digital A1 não cadastrado para o estabelecimento.');
    else if (cert.notAfter.getTime() <= Date.now()) add('BLOCKING', 'CERTIFICATE', 'Certificado digital vencido.');
    if (cfg.environment === 'PRODUCAO' && cfg.status !== 'APPROVED') add('BLOCKING', 'CONFIG_NOT_APPROVED', 'Produção exige a configuração fiscal validada pelo contador.');
    if (!this.provider.isConfigured()) add('INFO', 'PROVIDER_NOT_CONFIGURED', 'Nenhum provedor de transmissão está configurado: o documento pode ser validado, mas não transmitido.');

    const out: EngineOutput = await this.rules.compute(tx, ctx.tenantId!, {
      operation: 'SALE', date: new Date(), originUf: est.state, destUf: cust.state, regime: est.company.taxRegime, recipientKind: null,
      items: doc.items.map((i) => ({ key: String(i.line), ncm: i.ncm, productOrigin: i.product?.taxOrigin ?? null, value: Number(i.totalValue) })),
    });
    for (const p of out.pendencies) add('BLOCKING', `TAX_${p.code}`, p.itemKey ? `Item ${p.itemKey}: ${p.message}` : p.message);
    for (const r of out.items) {
      const line = Number(r.key);
      const it = doc.items.find((x) => x.line === line)!;
      await tx.fiscalDocumentItem.update({ where: { id: it.id }, data: { cfop: r.cfop, declaredTax: JSON.parse(JSON.stringify(r)) as Prisma.InputJsonValue } });
    }
    const calc = await tx.taxCalculation.create({
      data: {
        tenantId: ctx.tenantId!, operation: 'SALE', engineVersion: ENGINE_VERSION, inputs: { documentId: docId, salesOrderId: doc.salesOrderId, originUf: est.state, destUf: cust.state, regime: est.company.taxRegime } as Prisma.InputJsonValue,
        outputs: JSON.parse(JSON.stringify(out)) as Prisma.InputJsonValue, ruleVersionIds: out.rulesUsed.map((r) => r.versionId), pendencies: out.pendencies as unknown as Prisma.InputJsonValue, createdById: ctx.userId,
      },
    });
    const blocking = issues.filter((i) => i.severity === 'BLOCKING').length;
    // Rejeição anterior continua visível até a revalidação limpar os impeditivos.
    const status = blocking ? 'PENDING_VALIDATION' : 'READY_TO_TRANSMIT';
    await tx.fiscalDocument.update({ where: { id: docId }, data: { status, issues: issues as unknown as Prisma.InputJsonValue, calculationId: calc.id } });
    return { status, issues, blocking };
  }

  // ───────────── transmissão (máquina de estados) ─────────────

  /**
   * Nunca "autoriza" por conta própria. Sequência: (1) reserva número + chave e marca TRANSMITTING (transação curta);
   * (2) chama o provedor SEM transação aberta; (3) grava o resultado. Timeout ⇒ PENDING_CONSULT: proibido retransmitir,
   * só consultar pela chave — evita emissão duplicada.
   */
  async transmit(ctx: AuthContext, id: string) {
    if (!this.provider.isConfigured()) {
      throw new HttpException({ message: 'Nenhum provedor de transmissão configurado nesta instalação: o documento não foi enviado e nenhum número foi consumido.', code: 'NOT_CONFIGURED' }, HttpStatus.FAILED_DEPENDENCY);
    }
    const prep = await this.prisma.withContext(ctx, async (tx) => {
      const doc = await this.lock(tx, ctx, id);
      if (doc.status === 'PENDING_CONSULT') throw new ConflictException('A resposta da transmissão anterior é desconhecida: use "Consultar situação" antes de qualquer reenvio (reenviar poderia duplicar a nota).');
      if (doc.status === 'TRANSMITTING') throw new ConflictException('Transmissão em andamento.');
      if (doc.status === 'AUTHORIZED') throw new ConflictException('Documento já autorizado.');
      if (!['READY_TO_TRANSMIT', 'COMMUNICATION_FAILURE'].includes(doc.status)) throw new ConflictException(`Documento "${doc.status}" não pode ser transmitido: ${doc.status === 'REJECTED' ? 'corrija e revalide primeiro' : 'resolva as pendências'}.`);
      if (doc.status === 'READY_TO_TRANSMIT') {
        const fresh = await this.evaluate(tx, ctx, id); // última checagem antes de consumir numeração
        if (fresh.blocking) throw new ConflictException({ message: 'O documento deixou de estar apto para transmissão.', issues: fresh.issues });
      }
      const est = await tx.establishment.findFirstOrThrow({ where: { id: doc.establishmentId!, tenantId: ctx.tenantId! } });
      const cfg = await tx.fiscalConfiguration.findFirstOrThrow({ where: { tenantId: ctx.tenantId!, establishmentId: est.id } });
      let { number, accessKey, series } = doc;
      if (!number || !accessKey) {
        // Numeração atômica e nunca reutilizada.
        const rows = await tx.$queryRaw<{ last: number }[]>`
          INSERT INTO fiscal_series (tenant_id, establishment_id, model, series, environment, last) VALUES (${ctx.tenantId}::uuid, ${est.id}::uuid, '55', ${cfg.nfeSeries}, ${cfg.environment}, 1)
          ON CONFLICT (tenant_id, establishment_id, model, series, environment) DO UPDATE SET last = fiscal_series.last + 1 RETURNING last`;
        number = rows[0].last;
        series = cfg.nfeSeries;
        accessKey = buildChave({ uf: est.state!, issuedAt: new Date(), cnpj: onlyDigits(est.cnpj!), series, number });
      }
      await tx.fiscalDocument.update({ where: { id }, data: { status: 'TRANSMITTING', number, series, accessKey, issuedAt: doc.issuedAt ?? new Date(), environment: cfg.environment } });
      await this.audit.record(tx, ctx, { action: 'fiscal.transmit_started', entity: 'fiscal_document', entityId: id, metadata: { number, series, accessKey, environment: cfg.environment } });
      return { accessKey: accessKey!, environment: cfg.environment as 'HOMOLOGACAO' | 'PRODUCAO' };
    });

    let result;
    try {
      result = await this.provider.transmit({ accessKey: prep.accessKey, environment: prep.environment, documentId: id });
    } catch {
      result = { kind: 'TIMEOUT' as const }; // exceção após o envio é tratada como resposta desconhecida (conservador)
    }
    return this.apply(ctx, id, prep.accessKey, result);
  }

  async consult(ctx: AuthContext, id: string) {
    if (!this.provider.isConfigured()) throw new HttpException({ message: 'Nenhum provedor de transmissão configurado.', code: 'NOT_CONFIGURED' }, HttpStatus.FAILED_DEPENDENCY);
    const doc = await this.prisma.withContext(ctx, async (tx) => {
      const d = await this.lock(tx, ctx, id);
      const stale = d.status === 'TRANSMITTING' && Date.now() - d.updatedAt.getTime() > 2 * 60_000;
      if (!d.accessKey || !(['PENDING_CONSULT', 'COMMUNICATION_FAILURE'].includes(d.status) || stale)) throw new ConflictException('Não há transmissão pendente de consulta para este documento.');
      return d;
    });
    const r = await this.provider.consult(doc.accessKey!, (doc.environment as 'HOMOLOGACAO' | 'PRODUCAO') ?? 'HOMOLOGACAO');
    return this.prisma.withContext(ctx, async (tx) => {
      await this.lock(tx, ctx, id);
      let status = doc.status;
      const data: Prisma.FiscalDocumentUpdateInput = {};
      if (r.kind === 'AUTHORIZED') { status = 'AUTHORIZED'; data.authProtocol = r.protocol; data.authStatusCode = r.statusCode; data.authenticity = 'VERIFIED'; }
      else if (r.kind === 'REJECTED') { status = 'REJECTED'; data.authStatusCode = r.statusCode; data.issues = [{ severity: 'BLOCKING', code: 'SEFAZ_REJECTION', message: `Rejeição ${r.statusCode}: ${r.reason}` }]; }
      else if (r.kind === 'NOT_FOUND') status = 'READY_TO_TRANSMIT'; // a chave não existe no provedor: reenvio seguro com a MESMA numeração
      await tx.fiscalDocument.update({ where: { id }, data: { ...data, status } });
      await this.audit.record(tx, ctx, { action: 'fiscal.consulted', entity: 'fiscal_document', entityId: id, metadata: { result: r.kind, status } });
      return { id, status, result: r.kind };
    });
  }

  private apply(ctx: AuthContext, id: string, accessKey: string, r: Awaited<ReturnType<FiscalProvider['transmit']>>) {
    return this.prisma.withContext(ctx, async (tx) => {
      const data: Prisma.FiscalDocumentUpdateInput = {};
      let status: string;
      switch (r.kind) {
        case 'AUTHORIZED':
          status = 'AUTHORIZED'; data.authProtocol = r.protocol; data.authStatusCode = r.statusCode; data.authenticity = 'VERIFIED';
          if (r.xml) await tx.fiscalXmlFile.create({ data: { tenantId: ctx.tenantId!, documentId: id, kind: 'AUTHORIZED', sha256: (await import('node:crypto')).createHash('sha256').update(r.xml).digest('hex'), content: r.xml, createdById: ctx.userId } });
          break;
        case 'REJECTED':
          status = 'REJECTED'; data.authStatusCode = r.statusCode; data.issues = [{ severity: 'BLOCKING', code: 'SEFAZ_REJECTION', message: `Rejeição ${r.statusCode}: ${r.reason}` }];
          break;
        case 'TIMEOUT':
          status = 'PENDING_CONSULT';
          break;
        default:
          status = 'COMMUNICATION_FAILURE'; data.providerState = { lastError: r.reason };
      }
      await tx.fiscalDocument.update({ where: { id }, data: { ...data, status } });
      await this.audit.record(tx, ctx, { action: 'fiscal.transmit_result', entity: 'fiscal_document', entityId: id, metadata: { accessKey, result: r.kind, status } });
      return { id, status, accessKey };
    });
  }

  private async lock(tx: Tx, ctx: Pick<AuthContext, 'tenantId'>, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM fiscal_documents WHERE id = ${id}::uuid AND tenant_id = ${ctx.tenantId}::uuid AND direction = 'EXIT' FOR UPDATE`;
    if (!rows.length) throw new NotFoundException('Documento não encontrado.');
    return tx.fiscalDocument.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId! } });
  }
}
