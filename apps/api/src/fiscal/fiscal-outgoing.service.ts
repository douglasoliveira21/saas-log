import { BadRequestException, ConflictException, HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/auth';
import { isValidCnpj, isValidCpf, onlyDigits } from '../common/cnpj';
import { PrismaService } from '../prisma/prisma.service';
import { buildChave } from './chave';
import { ENGINE_VERSION, EngineOutput } from './engine';
import { FISCAL_PROVIDER, FiscalEnvironment, FiscalModel, FiscalProvider, OutgoingDocument, ProviderCtx, RemoteDoc } from './fiscal-provider';
import { ProviderContextService } from './fiscal-provider.router';
import { IbgeService } from './sefaz/ibge';
import { nfeProc } from './sefaz/messages';
import { Issue } from './nfe-xml';
import { DEFAULT_NFCE_MAX, splitForLimit, SplitError } from './nfce-split';
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
    private readonly pctx: ProviderContextService,
    private readonly ibge: IbgeService,
  ) {}

  /** Busca (FORA de transação) os municípios das UFs envolvidas, para o código IBGE do XML; só quando o estabelecimento usa emissão direta. */
  private async warmCities(ctx: AuthContext, ref: { orderId?: string; docId?: string }) {
    const ufs = await this.prisma.withContext(ctx, async (tx) => {
      const doc = ref.docId ? await tx.fiscalDocument.findFirst({ where: { id: ref.docId, tenantId: ctx.tenantId! }, select: { establishmentId: true, salesOrder: { select: { customer: { select: { state: true } } } } } }) : null;
      const order = ref.orderId ? await tx.salesOrder.findFirst({ where: { id: ref.orderId, tenantId: ctx.tenantId! }, select: { customer: { select: { state: true } }, warehouse: { select: { establishmentId: true } } } }) : null;
      const estId = doc?.establishmentId ?? order?.warehouse.establishmentId;
      if (!estId) return [];
      const direct = await tx.fiscalProviderCredential.findFirst({ where: { tenantId: ctx.tenantId!, establishmentId: estId, provider: 'SEFAZ_DIRECT' }, select: { id: true } });
      if (!direct) return [];
      const est = await tx.establishment.findFirst({ where: { id: estId, tenantId: ctx.tenantId! }, select: { state: true } });
      return [est?.state, doc?.salesOrder?.customer.state ?? order?.customer.state];
    });
    for (const uf of new Set(ufs.filter(Boolean))) await this.ibge.warm(uf);
  }

  private numberingOf(pc: ProviderCtx): 'SYSTEM' | 'PROVIDER' {
    return this.provider.numberingFor?.(pc) ?? this.provider.numbering ?? 'SYSTEM';
  }

  list(ctx: AuthContext, status?: string) {
    return this.prisma.withContext(ctx, (tx) =>
      tx.fiscalDocument.findMany({
        where: { tenantId: ctx.tenantId!, direction: 'EXIT', ...(status ? { status } : {}) }, orderBy: { createdAt: 'desc' }, take: 100,
        select: { id: true, model: true, status: true, splitIndex: true, splitTotal: true, number: true, series: true, accessKey: true, environment: true, totalInvoice: true, salesOrderId: true, issues: true, authProtocol: true, createdAt: true, salesOrder: { select: { number: true, customer: { select: { name: true } } } } },
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

  async prepare(ctx: AuthContext, dto: { salesOrderId: string; establishmentId?: string; model?: FiscalModel; paymentMethod?: string }) {
    await this.warmCities(ctx, { orderId: dto.salesOrderId });
    return this.prisma.withContext(ctx, async (tx) => {
      const order = await tx.salesOrder.findFirst({
        where: { id: dto.salesOrderId, tenantId: ctx.tenantId! },
        include: { customer: true, items: { include: { product: true }, orderBy: { id: 'asc' } } },
      });
      if (!order) throw new NotFoundException('Pedido não encontrado.');
      if (['DRAFT', 'PENDING_APPROVAL', 'CANCELLED'].includes(order.status)) throw new ConflictException(`Pedido "${order.status}" não pode ser faturado.`);
      const existingDocs = await tx.fiscalDocument.findMany({ where: { tenantId: ctx.tenantId!, salesOrderId: order.id, direction: 'EXIT', NOT: { status: 'CANCELLED' } }, orderBy: [{ splitIndex: 'asc' }, { createdAt: 'asc' }] });
      if (existingDocs.length) return { id: existingDocs[0].id, ids: existingDocs.map((d) => d.id), existing: true, status: existingDocs[0].status, parts: existingDocs.length };
      // O documento segue o que foi escolhido na venda (NF-e = 55, NFC-e = 65); sem escolha, NF-e.
      const model: FiscalModel = dto.model ?? (order.fiscalDocType === 'NFCE' ? '65' : '55');

      const est = dto.establishmentId
        ? await tx.establishment.findFirst({ where: { id: dto.establishmentId, tenantId: ctx.tenantId!, active: true }, include: { company: true } })
        : await tx.establishment.findFirst({ where: { tenantId: ctx.tenantId!, active: true }, include: { company: true }, orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }] });
      if (!est) throw new BadRequestException('Estabelecimento emissor não encontrado.');
      const cfg = await tx.fiscalConfiguration.upsert({ where: { tenantId_establishmentId: { tenantId: ctx.tenantId!, establishmentId: est.id } }, create: { tenantId: ctx.tenantId!, establishmentId: est.id }, update: {} });

      // NFC-e: cada cupom tem um valor máximo (configurável). Acima dele o pedido vira vários cupons, sem perder nem sobrar centavos.
      const toCents = (v: unknown) => Math.round(Number(v) * 100);
      let groups: { items: { index: number; quantity: number; totalCents: number }[]; freightCents: number }[] = [{ items: order.items.map((i, n) => ({ index: n, quantity: i.quantity, totalCents: toCents(i.total) })), freightCents: toCents(order.shipping) }];
      if (model === '65') {
        const setting = await tx.tenantSetting.findFirst({ where: { tenantId: ctx.tenantId!, key: 'fiscal.nfceMaxValue' } });
        const maxValue = typeof setting?.value === 'number' ? setting.value : DEFAULT_NFCE_MAX;
        if (maxValue > 0 && toCents(order.total) > Math.round(maxValue * 100)) {
          try { groups = splitForLimit(groups[0].items, groups[0].freightCents, Math.round(maxValue * 100)); } catch (e) { if (e instanceof SplitError) throw new ConflictException(`Não foi possível dividir em cupons: ${e.message}`); throw e; }
        }
      }

      const docs: { id: string; status: string; issues?: Issue[] }[] = [];
      for (const [gi, g] of groups.entries()) {
        const products = g.items.reduce((s, x) => s + x.totalCents, 0);
        const doc = await tx.fiscalDocument.create({
          data: {
            tenantId: ctx.tenantId!, direction: 'EXIT', model, status: 'DRAFT', providerState: (dto.paymentMethod ?? order.paymentMethod) ? { paymentMethod: dto.paymentMethod ?? order.paymentMethod } : {}, environment: cfg.environment, establishmentId: est.id, series: cfg.nfeSeries,
            emitterDoc: est.cnpj ? onlyDigits(est.cnpj) : null, emitterName: est.company.legalName, emitterUf: est.state, recipientDoc: order.customer.document,
            totalProducts: (products / 100).toFixed(2), totalInvoice: ((products + g.freightCents) / 100).toFixed(2), totalFreight: (g.freightCents / 100).toFixed(2), salesOrderId: order.id, importedById: ctx.userId,
            ...(groups.length > 1 ? { splitIndex: gi + 1, splitTotal: groups.length } : {}),
          },
        });
        await tx.fiscalDocumentItem.createMany({
          data: g.items.map((x, idx) => {
            const i = order.items[x.index];
            return {
              tenantId: ctx.tenantId!, documentId: doc.id, line: idx + 1, supplierCode: i.product.sku, gtin: i.product.barcode, description: i.product.name, ncm: i.product.ncm, unit: i.product.saleUnit,
              quantity: x.quantity.toFixed(4), unitValue: (x.totalCents / 100 / x.quantity).toFixed(6), totalValue: (x.totalCents / 100).toFixed(2), declaredTax: {}, productId: i.productId,
            };
          }),
        });
        const res = await this.evaluate(tx, ctx, doc.id);
        docs.push({ id: doc.id, status: res.status, issues: res.issues });
      }
      await this.audit.record(tx, ctx, { action: 'fiscal.outgoing_prepared', entity: 'fiscal_document', entityId: docs[0].id, metadata: { salesOrderId: order.id, parts: docs.length, documentIds: docs.map((d) => d.id), status: docs[0].status } });
      return { id: docs[0].id, ids: docs.map((d) => d.id), existing: false, status: docs[0].status, issues: docs[0].issues, parts: docs.length };
    });
  }

  async revalidate(ctx: AuthContext, id: string) {
    await this.warmCities(ctx, { docId: id });
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
    const model = doc.model as FiscalModel;
    const env = (cfg.environment as FiscalEnvironment) ?? 'HOMOLOGACAO';
    const pc = await this.pctx.resolve(tx, ctx.tenantId!, est.id, model, env);
    const numbering = this.numberingOf(pc);
    const issues: Issue[] = [];
    const add = (severity: Issue['severity'], code: string, message: string) => issues.push({ severity, code, message });

    if (!est.cnpj || !isValidCnpj(est.cnpj)) add('BLOCKING', 'ESTABLISHMENT_DATA', 'Estabelecimento sem CNPJ válido.');
    if (!est.stateRegistration) add('BLOCKING', 'ESTABLISHMENT_DATA', 'Estabelecimento sem inscrição estadual.');
    if (!est.state) add('BLOCKING', 'ESTABLISHMENT_DATA', 'Estabelecimento sem UF.');
    if (!est.company.taxRegime) add('BLOCKING', 'ESTABLISHMENT_DATA', 'Regime tributário da empresa não informado.');
    if (model === '55') {
      const docOk = !!cust.document && (isValidCnpj(cust.document) || isValidCpf(cust.document));
      if (!docOk) add('BLOCKING', 'CUSTOMER_DATA', 'Cliente sem CPF/CNPJ válido.');
      if (!cust.street || !cust.city || !cust.state || !cust.zipCode) add('BLOCKING', 'CUSTOMER_DATA', 'Endereço do cliente incompleto (logradouro, município, UF e CEP).');
    } else if (cust.document && !(isValidCnpj(cust.document) || isValidCpf(cust.document))) {
      add('BLOCKING', 'CUSTOMER_DATA', 'O CPF/CNPJ do cliente é inválido (na NFC-e ele é opcional: remova ou corrija).');
    }
    if (numbering === 'PROVIDER') {
      // O provedor assina com o certificado cadastrado NELE (e guarda o CSC da NFC-e): o sistema não consegue conferir isso daqui.
      add('INFO', 'PROVIDER_CERTIFICATE', `O certificado digital A1${model === '65' ? ' e o CSC da NFC-e' : ''} ficam no painel do provedor: confira lá antes de transmitir.`);
    } else {
      const cert = await tx.fiscalCertificate.findFirst({ where: { tenantId: ctx.tenantId!, establishmentId: est.id, status: 'ACTIVE' } });
      if (!cert) add('BLOCKING', 'CERTIFICATE', 'Certificado digital A1 não cadastrado para o estabelecimento.');
      else if (cert.notAfter.getTime() <= Date.now()) add('BLOCKING', 'CERTIFICATE', 'Certificado digital vencido.');
    }
    if (cfg.environment === 'PRODUCAO' && cfg.status !== 'APPROVED') add('BLOCKING', 'CONFIG_NOT_APPROVED', 'Produção exige a configuração fiscal validada pelo contador.');
    if (!this.provider.isConfigured(pc)) add('INFO', 'PROVIDER_NOT_CONFIGURED', 'Nenhum provedor de transmissão está configurado para este estabelecimento: o documento pode ser validado, mas não transmitido.');

    // NFC-e sem endereço do consumidor = operação interna (destino = UF do emitente)
    const out: EngineOutput = await this.rules.compute(tx, ctx.tenantId!, {
      operation: 'SALE', date: new Date(), originUf: est.state, destUf: cust.state ?? (model === '65' ? est.state : null), regime: est.company.taxRegime, recipientKind: null,
      items: doc.items.map((i) => ({ key: String(i.line), ncm: i.ncm, productOrigin: i.product?.taxOrigin ?? null, value: Number(i.totalValue) })),
    });
    for (const p of out.pendencies) add('BLOCKING', `TAX_${p.code}`, p.itemKey ? `Item ${p.itemKey}: ${p.message}` : p.message);
    for (const r of out.items) {
      const line = Number(r.key);
      const it = doc.items.find((x) => x.line === line)!;
      await tx.fiscalDocumentItem.update({ where: { id: it.id }, data: { cfop: r.cfop, declaredTax: JSON.parse(JSON.stringify(r)) as Prisma.InputJsonValue } });
    }
    // Pendências que só o provedor conhece (ex.: tributos que o conector ainda não envia).
    if (this.provider.isConfigured(pc) && this.provider.validate) {
      const items = await tx.fiscalDocumentItem.findMany({ where: { documentId: docId, tenantId: ctx.tenantId! }, orderBy: { line: 'asc' } });
      const built = this.buildDocument({ ...doc, items: items.map((i) => ({ ...i, product: doc.items.find((x) => x.line === i.line)?.product ?? null })) }, est, cust, model, env);
      for (const v of await this.provider.validate(built, pc)) add('BLOCKING', v.code, v.message);
    }
    const calc = await tx.taxCalculation.create({
      data: {
        tenantId: ctx.tenantId!, operation: 'SALE', engineVersion: ENGINE_VERSION, inputs: { documentId: docId, salesOrderId: doc.salesOrderId, originUf: est.state, destUf: cust.state ?? (model === '65' ? est.state : null), regime: est.company.taxRegime } as Prisma.InputJsonValue,
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
    await this.warmCities(ctx, { docId: id });
    const prep = await this.prisma.withContext(ctx, async (tx) => {
      const doc = await this.lock(tx, ctx, id);
      const est = await tx.establishment.findFirstOrThrow({ where: { id: doc.establishmentId!, tenantId: ctx.tenantId! }, include: { company: true } });
      const cfg = await tx.fiscalConfiguration.findFirstOrThrow({ where: { tenantId: ctx.tenantId!, establishmentId: est.id } });
      const model = doc.model as FiscalModel;
      const env = cfg.environment as FiscalEnvironment;
      const pc = await this.pctx.resolve(tx, ctx.tenantId!, est.id, model, env);
      if (!this.provider.isConfigured(pc)) {
        throw new HttpException({ message: 'Nenhum provedor de transmissão configurado para este estabelecimento: o documento não foi enviado e nenhum número foi consumido.', code: 'NOT_CONFIGURED' }, HttpStatus.FAILED_DEPENDENCY);
      }
      if (doc.status === 'PENDING_CONSULT') throw new ConflictException('A resposta da transmissão anterior é desconhecida: use "Consultar situação" antes de qualquer reenvio (reenviar poderia duplicar a nota).');
      if (doc.status === 'TRANSMITTING') throw new ConflictException('Transmissão em andamento.');
      if (doc.status === 'AUTHORIZED') throw new ConflictException('Documento já autorizado.');
      if (!['READY_TO_TRANSMIT', 'COMMUNICATION_FAILURE'].includes(doc.status)) throw new ConflictException(`Documento "${doc.status}" não pode ser transmitido: ${doc.status === 'REJECTED' ? 'corrija e revalide primeiro' : 'resolva as pendências'}.`);
      if (doc.status === 'READY_TO_TRANSMIT') {
        const fresh = await this.evaluate(tx, ctx, id); // última checagem antes de consumir numeração
        if (fresh.blocking) throw new ConflictException({ message: 'O documento deixou de estar apto para transmissão.', issues: fresh.issues });
      }
      const numbering = this.numberingOf(pc);
      let { number, accessKey, series } = doc;
      let issuedAtReserved: Date | null = null;
      if (numbering === 'SYSTEM') {
        if (!number || !accessKey) {
          // Numeração atômica e nunca reutilizada.
          const rows = await tx.$queryRaw<{ last: number }[]>`
            INSERT INTO fiscal_series (tenant_id, establishment_id, model, series, environment, last) VALUES (${ctx.tenantId}::uuid, ${est.id}::uuid, ${model}, ${cfg.nfeSeries}, ${cfg.environment}, 1)
            ON CONFLICT (tenant_id, establishment_id, model, series, environment) DO UPDATE SET last = fiscal_series.last + 1 RETURNING last`;
          number = rows[0].last;
          series = cfg.nfeSeries;
          const at = doc.issuedAt ?? new Date();
          accessKey = buildChave({ uf: est.state!, issuedAt: at, cnpj: onlyDigits(est.cnpj!), model, series, number });
          issuedAtReserved = at;
        }
      }
      // Com numeração do provedor a referência é o id do documento: reenviar com ela nunca cria uma segunda nota.
      // Com provedor que numera: NFC-e aceita no máximo ~5 min de diferença, então a data é a de cada tentativa. Com numeração nossa, a data fica
      // atrelada à chave reservada (o AAMM da chave tem de bater com dhEmi).
      const issuedAt = numbering === 'PROVIDER' ? new Date() : (issuedAtReserved ?? doc.issuedAt ?? new Date());
      await tx.fiscalDocument.update({ where: { id }, data: { status: 'TRANSMITTING', number, series, accessKey, issuedAt, environment: cfg.environment } });
      await this.audit.record(tx, ctx, { action: 'fiscal.transmit_started', entity: 'fiscal_document', entityId: id, metadata: { model, numbering, number, series, accessKey, environment: cfg.environment } });
      let document: OutgoingDocument | undefined;
      if (numbering === 'PROVIDER' || this.provider.needsDocumentFor?.(pc)) {
        const items = await tx.fiscalDocumentItem.findMany({ where: { documentId: id, tenantId: ctx.tenantId! }, orderBy: { line: 'asc' } });
        const full = await tx.fiscalDocument.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId! }, include: { salesOrder: { include: { customer: true } } } });
        const products = await tx.product.findMany({ where: { tenantId: ctx.tenantId!, id: { in: items.map((i) => i.productId!).filter(Boolean) } } });
        document = this.buildDocument({ ...full, items: items.map((i) => ({ ...i, product: products.find((p) => p.id === i.productId) ?? null })) }, est, full.salesOrder!.customer, model, env);
      }
      return { accessKey: accessKey ?? '', environment: env, pc, document, numbering };
    });

    let result;
    try {
      result = await this.provider.transmit({ accessKey: prep.accessKey, environment: prep.environment, documentId: id, document: prep.document }, prep.pc);
    } catch {
      result = { kind: 'TIMEOUT' as const }; // exceção após o envio é tratada como resposta desconhecida (conservador)
    }
    return this.apply(ctx, id, prep.accessKey, result, prep.pc);
  }

  /** Monta o documento neutro (a partir do que o motor tributário gravou nos itens) que o provedor converte para o formato dele. */
  private buildDocument(
    doc: { id: string; number?: number | null; series?: number | null; accessKey?: string | null; salesOrder: { channel: string; notes: string | null; number: number } | null; issuedAt: Date | null; totalProducts: Prisma.Decimal | null; totalFreight: Prisma.Decimal | null; totalInvoice: Prisma.Decimal | null; providerState: Prisma.JsonValue;
           items: { line: number; supplierCode: string | null; description: string; ncm: string | null; cfop: string | null; unit: string | null; quantity: Prisma.Decimal; unitValue: Prisma.Decimal; totalValue: Prisma.Decimal; declaredTax: Prisma.JsonValue; product: { taxOrigin: number | null } | null }[] },
    est: Prisma.EstablishmentGetPayload<{ include: { company: true } }>,
    cust: Prisma.CustomerGetPayload<object>, model: FiscalModel, environment: FiscalEnvironment,
  ): OutgoingDocument {
    const channel = doc.salesOrder?.channel ?? 'DIRECT';
    const taxOf = (i: (typeof doc.items)[number], code: string) => (((i.declaredTax as { taxes?: Record<string, { cst?: string; csosn?: string; amount?: number; base?: number; ratePct?: number }> } | null)?.taxes ?? {})[code]);
    const det = (i: (typeof doc.items)[number], code: string) => ({ base: taxOf(i, code)?.base ?? 0, rate: taxOf(i, code)?.ratePct ?? 0, amount: taxOf(i, code)?.amount ?? 0 });
    const state = (doc.providerState ?? {}) as { paymentMethod?: string };
    const total = Number(doc.totalInvoice ?? 0);
    const regime = est.company.taxRegime === 'MEI' ? 4 : est.company.taxRegime === 'SIMPLES_NACIONAL' ? 1 : 3;
    const cDoc = (cust.document ?? '').replace(/\D/g, '');
    return {
      ref: doc.id, number: doc.number ?? undefined, series: doc.series ?? undefined, accessKey: doc.accessKey ?? undefined, model, environment, issuedAt: doc.issuedAt ?? new Date(),
      presence: model === '65' ? (channel === 'STORE' ? 'COUNTER' : 'DELIVERY') : channel === 'STORE' ? 'COUNTER' : channel === 'WEB' ? 'INTERNET' : channel === 'PHONE' ? 'PHONE' : 'OTHER',
      destination: est.state && cust.state && est.state !== cust.state.toUpperCase() ? 2 : 1,
      finalConsumer: cust.kind === 'PF' || model === '65',
      emitter: { cnpj: onlyDigits(est.cnpj ?? ''), name: est.company.legalName, tradeName: est.company.tradeName, street: est.street ?? '', number: est.number ?? 'SN', district: est.district ?? '', city: est.city ?? '', cMun: this.ibge.lookup(est.city, est.state), uf: est.state ?? '', zip: onlyDigits(est.zipCode ?? ''), ie: est.stateRegistration ?? '', regime: regime as 1 | 3 | 4, cnae: est.cnae ? onlyDigits(est.cnae) : null },
      recipient: cDoc || cust.name ? {
        document: cDoc || null, name: cust.name, ie: cust.stateRegistration, ieIndicator: cust.stateRegistration ? 1 : cust.kind === 'PF' ? 9 : 2,
        street: cust.street, number: cust.number ?? 'SN', district: cust.district, city: cust.city, cMun: this.ibge.lookup(cust.city, cust.state), uf: cust.state?.toUpperCase() ?? null, zip: onlyDigits(cust.zipCode ?? '') || null, phone: onlyDigits(cust.phone ?? '') || null, email: cust.email,
      } : null,
      items: doc.items.map((i) => ({
        line: i.line, sku: i.supplierCode ?? String(i.line), description: i.description, ncm: i.ncm ?? '', cfop: i.cfop ?? '', unit: i.unit ?? 'UN', quantity: Number(i.quantity), unitValue: Number(i.unitValue), total: Number(i.totalValue),
        origin: i.product?.taxOrigin ?? null,
        icmsCode: taxOf(i, 'ICMS')?.csosn ?? taxOf(i, 'ICMS')?.cst ?? null, pisCst: taxOf(i, 'PIS')?.cst ?? null, cofinsCst: taxOf(i, 'COFINS')?.cst ?? null,
        taxAmounts: { icms: taxOf(i, 'ICMS')?.amount ?? 0, pis: taxOf(i, 'PIS')?.amount ?? 0, cofins: taxOf(i, 'COFINS')?.amount ?? 0 },
        tax: { icms: det(i, 'ICMS'), pis: det(i, 'PIS'), cofins: det(i, 'COFINS') },
      })),
      totals: { products: Number(doc.totalProducts ?? 0), freight: Number(doc.totalFreight ?? 0), total },
      payments: state.paymentMethod ? [{ method: state.paymentMethod, amount: total }] : [],
      additionalInfo: doc.salesOrder ? `Pedido ${doc.salesOrder.number}` : null,
    };
  }

  async consult(ctx: AuthContext, id: string) {
    const doc = await this.prisma.withContext(ctx, async (tx) => {
      const d = await this.lock(tx, ctx, id);
      const stale = d.status === 'TRANSMITTING' && Date.now() - d.updatedAt.getTime() > 2 * 60_000;
      if (!(['PENDING_CONSULT', 'COMMUNICATION_FAILURE'].includes(d.status) || stale)) throw new ConflictException('Não há transmissão pendente de consulta para este documento.');
      const pc = await this.pctx.resolve(tx, ctx.tenantId!, d.establishmentId!, d.model as FiscalModel, ((d.environment as FiscalEnvironment) ?? 'HOMOLOGACAO'));
      if (this.numberingOf(pc) === 'SYSTEM' && !d.accessKey) throw new ConflictException('Não há transmissão pendente de consulta para este documento.');
      return Object.assign(d, { pc });
    });
    const key = this.numberingOf(doc.pc) === 'PROVIDER' ? doc.id : doc.accessKey!;
    const r = await this.provider.consult(key, (doc.environment as FiscalEnvironment) ?? 'HOMOLOGACAO', doc.pc);
    return this.prisma.withContext(ctx, async (tx) => {
      await this.lock(tx, ctx, id);
      let status = doc.status;
      const data: Prisma.FiscalDocumentUpdateInput = {};
      if (r.kind === 'AUTHORIZED') {
        status = 'AUTHORIZED'; data.authProtocol = r.protocol; data.authStatusCode = r.statusCode; data.authenticity = 'VERIFIED';
        if (r.remote) await this.storeRemote(tx, ctx, id, doc.pc, r.remote, data);
        if (r.protXml) {
          const signed = await tx.fiscalXmlFile.findFirst({ where: { tenantId: ctx.tenantId!, documentId: id, kind: 'SIGNED' }, orderBy: { createdAt: 'desc' } });
          if (signed && !(await tx.fiscalXmlFile.findFirst({ where: { tenantId: ctx.tenantId!, documentId: id, kind: 'AUTHORIZED' }, select: { id: true } }))) {
            const proc = nfeProc(signed.content, r.protXml);
            await tx.fiscalXmlFile.create({ data: { tenantId: ctx.tenantId!, documentId: id, kind: 'AUTHORIZED', sha256: (await import('node:crypto')).createHash('sha256').update(proc).digest('hex'), content: proc, source: 'sefaz-consulta', createdById: ctx.userId } });
          }
        }
      }
      else if (r.kind === 'CANCELLED') { status = 'CANCELLED'; data.authStatusCode = r.statusCode ?? null; }
      else if (r.kind === 'REJECTED') { status = 'REJECTED'; data.authStatusCode = r.statusCode; data.issues = [{ severity: 'BLOCKING', code: 'SEFAZ_REJECTION', message: `Rejeição ${r.statusCode}: ${r.reason}` }]; }
      else if (r.kind === 'NOT_FOUND') status = 'READY_TO_TRANSMIT'; // a chave não existe no provedor: reenvio seguro com a MESMA numeração
      await tx.fiscalDocument.update({ where: { id }, data: { ...data, status } });
      await this.audit.record(tx, ctx, { action: 'fiscal.consulted', entity: 'fiscal_document', entityId: id, metadata: { result: r.kind, status } });
      return { id, status, result: r.kind };
    });
  }

  private async storeSigned(tx: Tx, ctx: AuthContext, id: string, xml: string) {
    if (await tx.fiscalXmlFile.findFirst({ where: { tenantId: ctx.tenantId!, documentId: id, kind: 'SIGNED' }, select: { id: true } })) return;
    await tx.fiscalXmlFile.create({ data: { tenantId: ctx.tenantId!, documentId: id, kind: 'SIGNED', sha256: (await import('node:crypto')).createHash('sha256').update(xml).digest('hex'), content: xml, source: 'assinado antes do envio', createdById: ctx.userId } });
  }

  /** Guarda numeração/chave e os caminhos de XML/DANFE devolvidos pelo provedor; o XML autorizado é copiado para o nosso arquivo (guarda legal). */
  private async storeRemote(tx: Tx, ctx: AuthContext, id: string, pc: ProviderCtx, remote: RemoteDoc, data: Prisma.FiscalDocumentUpdateInput) {
    if (remote.accessKey) data.accessKey = remote.accessKey;
    if (remote.number !== undefined && Number.isFinite(remote.number)) data.number = remote.number;
    if (remote.series !== undefined && Number.isFinite(remote.series)) data.series = remote.series;
    const prev = ((await tx.fiscalDocument.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId! }, select: { providerState: true } })).providerState ?? {}) as Record<string, unknown>;
    data.providerState = { ...prev, xmlPath: remote.xmlPath ?? null, danfePath: remote.danfePath ?? null, qrCodeUrl: remote.qrCodeUrl ?? null, consultUrl: remote.consultUrl ?? null } as Prisma.InputJsonValue;
    if (remote.xmlPath && this.provider.download && !(await tx.fiscalXmlFile.findFirst({ where: { tenantId: ctx.tenantId!, documentId: id, kind: 'AUTHORIZED' }, select: { id: true } }))) {
      try {
        const f = await this.provider.download(remote.xmlPath, pc);
        const xml = f.content.toString('utf8');
        if (xml.trimStart().startsWith('<')) {
          await tx.fiscalXmlFile.create({ data: { tenantId: ctx.tenantId!, documentId: id, kind: 'AUTHORIZED', sha256: (await import('node:crypto')).createHash('sha256').update(xml).digest('hex'), content: xml, source: 'provider', createdById: ctx.userId } });
        }
      } catch { /* a nota está autorizada mesmo assim; o XML pode ser baixado depois pelo link guardado */ }
    }
  }

  private apply(ctx: AuthContext, id: string, accessKey: string, r: Awaited<ReturnType<FiscalProvider['transmit']>>, pc: ProviderCtx) {
    return this.prisma.withContext(ctx, async (tx) => {
      const data: Prisma.FiscalDocumentUpdateInput = {};
      let status: string;
      if ('signedXml' in r && r.signedXml) await this.storeSigned(tx, ctx, id, r.signedXml);
      switch (r.kind) {
        case 'AUTHORIZED':
          status = 'AUTHORIZED'; data.authProtocol = r.protocol; data.authStatusCode = r.statusCode; data.authenticity = 'VERIFIED';
          if (r.remote) await this.storeRemote(tx, ctx, id, pc, r.remote, data);
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

  /** Inutiliza uma faixa de numeração não usada (emissão direta). Fica registrada com o protocolo; só se a SEFAZ confirmar. */
  async inutilize(ctx: AuthContext, dto: { establishmentId: string; model: FiscalModel; series: number; from: number; to: number; reason: string }) {
    const pc = await this.prisma.withContext(ctx, async (tx) => {
      const est = await tx.establishment.findFirst({ where: { id: dto.establishmentId, tenantId: ctx.tenantId! } });
      if (!est) throw new NotFoundException('Estabelecimento não encontrado.');
      const cfg = await tx.fiscalConfiguration.findFirst({ where: { tenantId: ctx.tenantId!, establishmentId: est.id } });
      const pc = await this.pctx.resolve(tx, ctx.tenantId!, est.id, dto.model, ((cfg?.environment as FiscalEnvironment) ?? 'HOMOLOGACAO'));
      if (!this.provider.inutilize || !this.provider.isConfigured(pc)) throw new HttpException({ message: 'Inutilização só está disponível na emissão direta na SEFAZ, com certificado configurado.', code: 'NOT_SUPPORTED' }, HttpStatus.FAILED_DEPENDENCY);
      // Não inutiliza número que já virou nota (nem a faixa que o sistema já consumiu além do último reservado).
      const used = await tx.fiscalDocument.count({ where: { tenantId: ctx.tenantId!, establishmentId: est.id, model: dto.model, series: dto.series, number: { gte: dto.from, lte: dto.to }, NOT: { status: 'CANCELLED' } } });
      if (used) throw new ConflictException('Há nota(s) emitida(s) ou em andamento nessa faixa: só numeração sem nota pode ser inutilizada.');
      return pc;
    });
    const r = await this.provider.inutilize!({ model: dto.model, series: dto.series, from: dto.from, to: dto.to, reason: dto.reason.trim() }, pc);
    if (r.kind !== 'OK') throw new ConflictException(r.kind === 'REJECTED' ? `Inutilização recusada (${r.statusCode}): ${r.reason}` : r.reason);
    return this.prisma.withContext(ctx, async (tx) => {
      const row = await tx.fiscalVoid.create({ data: { tenantId: ctx.tenantId!, establishmentId: dto.establishmentId, model: dto.model, series: dto.series, fromNumber: dto.from, toNumber: dto.to, environment: pc.environment, reason: dto.reason.trim(), protocol: r.protocol, statusCode: r.statusCode, createdById: ctx.userId } });
      await this.audit.record(tx, ctx, { action: 'fiscal.numbering_voided', entity: 'fiscal_void', entityId: row.id, metadata: { model: dto.model, series: dto.series, from: dto.from, to: dto.to, protocol: r.protocol } });
      return row;
    });
  }

  voids(ctx: AuthContext) {
    return this.prisma.withContext(ctx, (tx) => tx.fiscalVoid.findMany({ where: { tenantId: ctx.tenantId! }, orderBy: { createdAt: 'desc' }, take: 100 }));
  }

  /** Cancela uma nota autorizada no provedor/SEFAZ (prazo e regras são do provedor/estado). A nota some da fila de faturamento do pedido. */
  async cancel(ctx: AuthContext, id: string, reason: string) {
    const ref = await this.prisma.withContext(ctx, async (tx) => {
      const d = await this.lock(tx, ctx, id);
      if (d.status !== 'AUTHORIZED') throw new ConflictException('Só é possível cancelar uma nota autorizada.');
      const pc = await this.pctx.resolve(tx, ctx.tenantId!, d.establishmentId!, d.model as FiscalModel, (d.environment as FiscalEnvironment) ?? 'HOMOLOGACAO');
      if (!this.provider.cancel || !this.provider.isConfigured(pc)) {
        throw new HttpException({ message: 'O provedor configurado não permite cancelar por aqui: faça o cancelamento no provedor/SEFAZ.', code: 'NOT_SUPPORTED' }, HttpStatus.FAILED_DEPENDENCY);
      }
      return { id: d.id, pc, accessKey: d.accessKey, protocol: d.authProtocol };
    });
    const r = await this.provider.cancel!(ref.id, reason.trim(), ref.pc, { accessKey: ref.accessKey, protocol: ref.protocol });
    return this.prisma.withContext(ctx, async (tx) => {
      await this.lock(tx, ctx, id);
      if (r.kind === 'CANCELLED') {
        const prev = ((await tx.fiscalDocument.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId! }, select: { providerState: true } })).providerState ?? {}) as Record<string, unknown>;
        await tx.fiscalDocument.update({ where: { id }, data: { status: 'CANCELLED', authStatusCode: r.statusCode, providerState: { ...prev, cancelReason: reason.trim(), cancelXmlPath: r.xmlPath ?? null } as Prisma.InputJsonValue } });
        await this.audit.record(tx, ctx, { action: 'fiscal.cancelled', entity: 'fiscal_document', entityId: id, metadata: { reason: reason.trim(), statusCode: r.statusCode } });
        return { id, status: 'CANCELLED' as const };
      }
      await this.audit.record(tx, ctx, { action: 'fiscal.cancel_failed', entity: 'fiscal_document', entityId: id, metadata: { result: r.kind } });
      throw new ConflictException(r.kind === 'REJECTED' ? `Cancelamento recusado (${r.statusCode}): ${r.reason}` : r.reason);
    });
  }

  /** DANFE (do provedor) ou XML autorizado (cópia guardada aqui; se faltar, baixa do provedor). */
  async file(ctx: AuthContext, id: string, kind: 'danfe' | 'xml') {
    const d = await this.prisma.withContext(ctx, async (tx) => {
      const doc = await tx.fiscalDocument.findFirst({ where: { id, tenantId: ctx.tenantId!, direction: 'EXIT' } });
      if (!doc) throw new NotFoundException('Documento não encontrado.');
      const xml = await tx.fiscalXmlFile.findFirst({ where: { tenantId: ctx.tenantId!, documentId: id, kind: 'AUTHORIZED' }, orderBy: { createdAt: 'desc' } });
      const pc = await this.pctx.resolve(tx, ctx.tenantId!, doc.establishmentId!, doc.model as FiscalModel, (doc.environment as FiscalEnvironment) ?? 'HOMOLOGACAO');
      return { doc, xml, pc };
    });
    const st = (d.doc.providerState ?? {}) as { xmlPath?: string | null; danfePath?: string | null };
    if (kind === 'xml' && d.xml) return { content: Buffer.from(d.xml.content, 'utf8'), contentType: 'application/xml; charset=utf-8', name: `nfe-${d.doc.accessKey ?? d.doc.id}.xml` };
    const p = kind === 'xml' ? st.xmlPath : st.danfePath;
    if (!p || !this.provider.download) throw new NotFoundException(kind === 'xml' ? 'XML não disponível para este documento.' : 'DANFE não disponível: o documento ainda não foi autorizado por um provedor.');
    try {
      const f = await this.provider.download(p, d.pc);
      return { content: f.content, contentType: kind === 'xml' ? 'application/xml; charset=utf-8' : f.contentType, name: `${kind === 'xml' ? 'nfe' : 'danfe'}-${d.doc.accessKey ?? d.doc.id}.${kind === 'xml' ? 'xml' : /pdf/.test(f.contentType) ? 'pdf' : 'html'}` };
    } catch (e) {
      throw new HttpException({ message: `Não foi possível baixar o arquivo do provedor: ${(e as Error).message}`, code: 'PROVIDER_DOWNLOAD' }, HttpStatus.BAD_GATEWAY);
    }
  }

  private async lock(tx: Tx, ctx: Pick<AuthContext, 'tenantId'>, id: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM fiscal_documents WHERE id = ${id}::uuid AND tenant_id = ${ctx.tenantId}::uuid AND direction = 'EXIT' FOR UPDATE`;
    if (!rows.length) throw new NotFoundException('Documento não encontrado.');
    return tx.fiscalDocument.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId! } });
  }
}
