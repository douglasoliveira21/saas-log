import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export type FiscalChoice = 'NONE' | 'NFE' | 'NFCE';
export interface FiscalIssue { level: 'BLOCKER' | 'WARNING' | 'INFO'; code: string; message: string }

const digits = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '');

/**
 * Espelho do documento fiscal de um pedido (DANFE da NF-e ou cupom da NFC-e) com as pendências para emitir.
 * NÃO é um documento fiscal: não há chave, protocolo nem autorização da SEFAZ, e os tributos não são calculados aqui.
 * A emissão real depende do provedor/certificado (docs/FISCAL-BRAZIL.md).
 */
export async function buildFiscalPreview(tx: Tx, tenantId: string, orderId: string) {
  const order = await tx.salesOrder.findFirstOrThrow({
    where: { id: orderId, tenantId },
    include: {
      customer: true,
      warehouse: { include: { establishment: { include: { company: true } } } },
      items: { include: { product: { select: { sku: true, name: true, ncm: true, cest: true, taxOrigin: true, saleUnit: true, barcode: true } } }, orderBy: { id: 'asc' } },
    },
  });
  const est = order.warehouse.establishment;
  const company = est.company;
  const docType = order.fiscalDocType as FiscalChoice;
  const [config, cert] = await Promise.all([
    tx.fiscalConfiguration.findFirst({ where: { tenantId, establishmentId: est.id } }),
    tx.fiscalCertificate.findFirst({ where: { tenantId, establishmentId: est.id, status: 'ACTIVE' }, select: { notAfter: true } }),
  ]);

  const issues: FiscalIssue[] = [];
  const add = (level: FiscalIssue['level'], code: string, message: string) => issues.push({ level, code, message });
  const c = order.customer;
  const cDoc = digits(c.document);

  if (docType !== 'NONE') {
    if (!digits(est.cnpj)) add('BLOCKER', 'EMITTER_CNPJ', 'O estabelecimento emitente não tem CNPJ (Empresa → Estabelecimentos).');
    if (!est.stateRegistration) add('BLOCKER', 'EMITTER_IE', 'O estabelecimento emitente não tem inscrição estadual.');
    if (!est.street || !est.city || !est.state || !est.zipCode) add('BLOCKER', 'EMITTER_ADDRESS', 'Endereço do estabelecimento emitente incompleto.');
    if (!company.taxRegime) add('BLOCKER', 'TAX_REGIME', 'A empresa não tem regime tributário informado.');
    const noNcm = order.items.filter((i) => !/^\d{8}$/.test(i.product.ncm ?? '')).map((i) => i.product.sku);
    if (noNcm.length) add('BLOCKER', 'ITEM_NCM', `Item(ns) sem NCM de 8 dígitos: ${noNcm.join(', ')}.`);
    const noOrigin = order.items.filter((i) => i.product.taxOrigin === null).map((i) => i.product.sku);
    if (noOrigin.length) add('WARNING', 'ITEM_ORIGIN', `Item(ns) sem origem da mercadoria: ${noOrigin.join(', ')}.`);
    if (!config || config.status !== 'APPROVED') add('WARNING', 'FISCAL_CONFIG', 'A configuração fiscal do estabelecimento ainda não foi validada pelo contador (Fiscal).');
    else if (!config.documentTypes.includes(docType === 'NFE' ? 'NFE' : 'NFCE')) add('WARNING', 'DOC_TYPE_DISABLED', `${docType === 'NFE' ? 'NF-e' : 'NFC-e'} não está habilitada na configuração fiscal deste estabelecimento.`);
    if (!cert) add('WARNING', 'CERTIFICATE', 'O estabelecimento não tem certificado digital A1 ativo.');
    add('INFO', 'NOT_ISSUED', 'Este é um espelho para conferência: a transmissão à SEFAZ ainda não está disponível neste sistema, então não há chave de acesso, protocolo nem valor fiscal.');
  }
  if (docType === 'NFE') {
    if (!cDoc) add('BLOCKER', 'RECIPIENT_DOC', 'NF-e exige CPF ou CNPJ do destinatário (cadastre no cliente).');
    if (!c.street || !c.city || !c.state || !c.zipCode) add('BLOCKER', 'RECIPIENT_ADDRESS', 'NF-e exige o endereço completo do destinatário (cadastre no cliente).');
  }
  if (docType === 'NFCE') {
    if (cDoc.length === 14) add('WARNING', 'NFCE_B2B', 'NFC-e é para consumidor final (venda presencial). Venda para empresa normalmente exige NF-e.');
  }

  return {
    mode: 'ESPELHO' as const,
    docType,
    ready: docType !== 'NONE' && !issues.some((i) => i.level === 'BLOCKER'),
    issues,
    order: { id: order.id, number: order.number, status: order.status, createdAt: order.createdAt.toISOString() },
    emitter: {
      legalName: company.legalName, tradeName: company.tradeName, cnpj: est.cnpj, stateRegistration: est.stateRegistration,
      taxRegime: company.taxRegime, street: est.street, number: est.number, complement: est.complement, district: est.district,
      city: est.city, state: est.state, zipCode: est.zipCode, environment: config?.environment ?? null, series: config?.nfeSeries ?? null,
    },
    recipient: {
      name: c.name, document: c.document, kind: c.kind, stateRegistration: c.stateRegistration, email: c.email, phone: c.phone,
      street: c.street, number: c.number, district: c.district, city: c.city, state: c.state, zipCode: c.zipCode,
    },
    items: order.items.map((i, n) => ({
      line: n + 1, sku: i.product.sku, name: i.product.name, ncm: i.product.ncm, cest: i.product.cest, gtin: i.product.barcode, unit: i.product.saleUnit,
      quantity: i.quantity, unitPrice: i.unitPrice.toString(), discountPct: i.discountPct.toString(), total: i.total.toString(),
    })),
    totals: { subtotal: order.subtotal.toString(), discount: order.discountTotal.toString(), shipping: order.shipping.toString(), total: order.total.toString() },
  };
}
