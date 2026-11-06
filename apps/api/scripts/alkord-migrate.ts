import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { hashPassword } from '../src/common/password';
import { loadEnv } from '../src/config/app.config';

loadEnv();

type AnyRow = Record<string, any>;
const key = process.env.ALKORD_APP_KEY;
const secret = process.env.ALKORD_APP_SECRET;
const tenantName = process.env.MIGRATION_TENANT ?? 'GEBER DISTRIBUIDORA';
const warehouseCode = process.env.MIGRATION_WAREHOUSE ?? 'CD01';
const apiBase = 'https://api.alkord.com.br';
if (!key || !secret) throw new Error('Defina ALKORD_APP_KEY e ALKORD_APP_SECRET apenas no ambiente de execução.');

const source = async (path: string, params: Record<string, string> = {}) => {
  const url = new URL(`${apiBase}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let last = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(url, { headers: { 'application-key': key!, 'application-secret': secret! } });
    if (r.ok) return r.json() as Promise<{ TOTAL_REGISTROS?: number; REGISTROS?: AnyRow[] }>;
    last = r.status;
    if (![429, 500, 502, 503, 504].includes(r.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  throw new Error(`Alkord ${path}: HTTP ${last}`);
};

async function all(path: string) {
  const out: AnyRow[] = []; let start = 0;
  for (;;) {
    const page = await source(path, { registro_inicial: String(start), numero_registros: '100' });
    const rows = page.REGISTROS ?? []; out.push(...rows);
    if (!rows.length || out.length >= Number(page.TOTAL_REGISTROS ?? out.length)) return out;
    start += rows.length;
  }
}

const date = (v: unknown) => {
  if (!v) return undefined;
  const d = new Date(String(v).replace(' ', 'T') + (String(v).includes('Z') ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? undefined : d;
};
const dec = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(v));
const int = (v: unknown) => Math.max(0, Math.round(dec(v)));
const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '') || undefined;
const text = (v: unknown) => {
  const value = String(v ?? '').trim();
  return value || undefined;
};
const json = (v: unknown) => v as Prisma.InputJsonValue;

function primaryAddress(row: AnyRow) {
  const addresses = Array.isArray(row.ENDERECOS) ? row.ENDERECOS.filter((address: AnyRow) => address?.EXCLUIDO !== 'S') : [];
  return addresses.find((address: AnyRow) => address.PRINCIPAL === 'S')
    ?? addresses.find((address: AnyRow) => address.TIPO === 'E')
    ?? addresses.find((address: AnyRow) => address.TIPO === 'B')
    ?? addresses[0];
}

function customerData(row: AnyRow) {
  const address = primaryAddress(row);
  const city = address?.CIDADE;
  const state = address?.ESTADO;
  const email = Array.isArray(row.EMAILS)
    ? row.EMAILS.find((item: AnyRow) => item?.PRINCIPAL === 'S' && item?.EXCLUIDO !== 'S') ?? row.EMAILS.find((item: AnyRow) => item?.EXCLUIDO !== 'S')
    : undefined;
  const phone = Array.isArray(row.TELEFONES)
    ? row.TELEFONES.find((item: AnyRow) => item?.PRINCIPAL === 'S' && item?.EXCLUIDO !== 'S') ?? row.TELEFONES.find((item: AnyRow) => item?.EXCLUIDO !== 'S')
    : undefined;
  const data: AnyRow = {
    name: String(row.NOME).trim(),
    kind: digits(row.DOCUMENTO)?.length === 11 ? 'PF' : 'PJ',
    document: digits(row.DOCUMENTO) ?? null,
    email: text(email?.EMAIL) ?? null,
    phone: text(phone?.TELEFONE ?? phone?.NUMERO) ?? null,
  };
  const addressFields: AnyRow = {
    zipCode: digits(address?.CEP),
    street: text(address?.ENDERECO ?? address?.LOGRADOURO),
    number: text(address?.NUMERO),
    district: text(address?.BAIRRO),
    city: text(city?.NOME ?? address?.CIDADE),
    state: text(state?.SIGLA ?? address?.UF)?.toUpperCase(),
    ibgeCode: text(city?.CODIGO_IBGE ?? city?.IBGE ?? address?.CODIGO_IBGE),
  };
  for (const [field, value] of Object.entries(addressFields)) {
    if (value !== undefined) data[field] = value;
  }
  return data;
}

async function main() {
  const direct = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
  const runtime = new PrismaService();
  await runtime.$connect();
  const tenant = await direct.tenant.findFirst({ where: { name: { contains: tenantName, mode: 'insensitive' } }, select: { id: true, name: true } });
  if (!tenant) throw new Error(`Tenant não encontrado: ${tenantName}`);
  const owner = await direct.membership.findFirst({ where: { tenantId: tenant.id, role: { key: 'owner' } }, select: { userId: true } });
  if (!owner) throw new Error('O tenant não possui usuário proprietário.');
  const warehouse = await direct.warehouse.findFirst({ where: { tenantId: tenant.id, code: warehouseCode }, select: { id: true, code: true } });
  if (!warehouse) throw new Error(`Depósito não encontrado: ${warehouseCode}`);
  await direct.$disconnect();

  const ctx = { tenantId: tenant.id, userId: owner.userId };
  const [products, customers, sales, invoices] = await Promise.all([all('produtos'), all('clientes'), all('atendimentos'), all('notas_fiscais_emitidas')]);
  const productMap = new Map<number, string>();
  const customerMap = new Map<number, string>();
  let productCount = 0, stockCount = 0, customerCount = 0, salesCount = 0, invoiceCount = 0;

  await runtime.withContext(ctx, async (tx) => {
    for (const row of customers) {
      const sourceId = Number(row.CODIGO); if (!sourceId || !row.NOME) continue;
      const document = digits(row.DOCUMENTO);
      const existingLegacy = await tx.legacyImportRecord.findUnique({ where: { tenantId_kind_externalId: { tenantId: tenant.id, kind: 'ALKORD_CUSTOMER', externalId: String(sourceId) } } });
      let customerId = (existingLegacy?.payload as AnyRow | null)?.targetId as string | undefined;
      if (!customerId) {
        const existing = document ? await tx.customer.findFirst({ where: { tenantId: tenant.id, document }, select: { id: true } }) : null;
        customerId = existing?.id;
      }
      const data = customerData(row);
      if (customerId) await tx.customer.update({ where: { id: customerId }, data });
      else customerId = (await tx.customer.create({ data: { tenantId: tenant.id, ...data } as Prisma.CustomerUncheckedCreateInput })).id;
      customerMap.set(sourceId, customerId);
      await tx.legacyImportRecord.upsert({ where: { tenantId_kind_externalId: { tenantId: tenant.id, kind: 'ALKORD_CUSTOMER', externalId: String(sourceId) } }, create: { tenantId: tenant.id, externalId: String(sourceId), kind: 'ALKORD_CUSTOMER', description: data.name, payload: json({ sourceId, targetId: customerId, source: row }) }, update: { description: data.name, payload: json({ sourceId, targetId: customerId, source: row }) } });
      customerCount++;
    }
    for (const row of products) {
      const sourceId = Number(row.CODIGO); if (!sourceId || !row.NOME) continue;
      const sku = `ALKORD-${sourceId}`;
      const category = row.CATEGORIA?.NOME ? await tx.productCategory.upsert({ where: { tenantId_name: { tenantId: tenant.id, name: String(row.CATEGORIA.NOME).trim() } }, create: { tenantId: tenant.id, name: String(row.CATEGORIA.NOME).trim() }, update: {} }) : null;
      const price = row.PRECOS?.find((x: AnyRow) => Number(x.UNIDADE) === 0) ?? row.PRECOS?.[0];
      const data = { name: String(row.NOME).trim(), barcode: digits(row.CODIGO_BARRAS) ?? null, brand: row.FABRICANTE?.NOME ?? null, categoryId: category?.id ?? null, saleUnit: row.UNIDADE_MEDIDA_VENDA?.SIGLA ?? 'UN', purchaseUnit: row.UNIDADE_MEDIDA_COMPRA?.SIGLA ?? 'UN', suggestedPrice: dec(price?.PRECO_VENDA), costPrice: dec(price?.PRECO_CUSTO), ncm: digits(row.NCM) ?? null, cest: digits(row.CEST) ?? null } as any;
      const existing = await tx.product.findUnique({ where: { tenantId_sku: { tenantId: tenant.id, sku } }, select: { id: true } });
      const productId = existing ? (await tx.product.update({ where: { id: existing.id }, data })).id : (await tx.product.create({ data: { tenantId: tenant.id, sku, ...data } })).id;
      productMap.set(sourceId, productId); productCount++;
      const qty = (row.ESTOQUES ?? []).filter((x: AnyRow) => Number(x.LOCALIZACAO) === 0 || Number(x.UNIDADE) === 1).reduce((n: number, x: AnyRow) => n + int(x.QUANTIDADE_ATUAL), 0);
      const balance = await tx.stockBalance.findUnique({ where: { productId_warehouseId: { productId, warehouseId: warehouse.id } } });
      if (!balance || balance.onHand !== qty) {
        await tx.stockBalance.upsert({ where: { productId_warehouseId: { productId, warehouseId: warehouse.id } }, create: { tenantId: tenant.id, productId, warehouseId: warehouse.id, onHand: qty }, update: { onHand: qty } });
        await tx.stockMovement.create({ data: { tenantId: tenant.id, productId, warehouseId: warehouse.id, type: 'ADJUSTMENT', quantity: qty - (balance?.onHand ?? 0), balanceBefore: balance?.onHand ?? 0, balanceAfter: qty, reason: 'Migração Alkord', reference: `ALKORD:${sourceId}`, idempotencyKey: `alkord-stock:${sourceId}:${warehouse.id}`, createdById: owner.userId } });
        stockCount++;
      }
    }
  });

  for (const row of sales) {
    const sourceId = Number(row.CODIGO); if (!sourceId || !row.ITENS?.length) continue;
    await runtime.withContext(ctx, async (tx) => {
      const customerId = customerMap.get(Number(row.CLIENTE?.CODIGO)) ?? (await tx.customer.create({ data: { tenantId: tenant.id, kind: 'PJ', name: row.CLIENTE?.NOME ?? 'Cliente Alkord' } })).id;
      const existing = await tx.salesOrder.findUnique({ where: { tenantId_externalSource_externalRef: { tenantId: tenant.id, externalSource: 'ALKORD', externalRef: String(sourceId) } }, select: { id: true } });
      const canceled = ['CANCELADO', 'CANCELADA', '9', '5'].includes(String(row.SITUACAO).toUpperCase());
      const data = { customerId, warehouseId: warehouse.id, channel: 'DIRECT' as const, status: canceled ? 'CANCELLED' as const : 'CLOSED' as const, subtotal: dec(row.TOTAL_PRODUTOS), total: dec(row.TOTAL), discountTotal: dec(row.TOTAL_DESCONTO_VALOR), shipping: dec(row.FRETE_VALOR), notes: row.TEXTOS?.OBSERVACAO ?? null, externalSource: 'ALKORD', externalRef: String(sourceId), createdById: owner.userId, confirmedAt: date(row.DATA), createdAt: date(row.DATA) ?? new Date(), cancelledAt: canceled ? date(row.DATA) : null };
      const order = existing ? await tx.salesOrder.update({ where: { id: existing.id }, data }) : await tx.salesOrder.create({ data: { tenantId: tenant.id, number: sourceId, ...data } });
      if (!existing) for (const [i, item] of row.ITENS.entries()) { const productId = productMap.get(Number(item.PRODUTO?.CODIGO)); if (!productId) continue; await tx.salesOrderItem.create({ data: { tenantId: tenant.id, orderId: order.id, productId, quantity: int(item.QUANTIDADE), unitPrice: dec(item.VALOR_UNITARIO), discountPct: dec(item.DESCONTO_PERCENTUAL), total: dec(item.VALOR_TOTAL) } }); }
      salesCount++;
    });
  }

  for (const row of invoices) {
    const sourceId = Number(row.CODIGO); if (!sourceId) continue;
    const xml = row.NFE?.XML;
    await runtime.withContext(ctx, async (tx) => {
      const accessKey = String(row.NFE?.CHAVE_ACESSO ?? `ALKORD-${sourceId}`);
      const existing = await tx.fiscalDocument.findUnique({ where: { tenantId_accessKey: { tenantId: tenant.id, accessKey } }, select: { id: true } });
      const status = row.SITUACAO === 'E' ? 'AUTHORIZED' : row.SITUACAO === 'C' ? 'CANCELLED' : 'IMPORTED';
      const doc = existing ? await tx.fiscalDocument.update({ where: { id: existing.id }, data: { status, number: Number(row.NUMERO) || null, series: Number(row.SERIE) || null, issuedAt: date(row.DATA_EMISSAO), accessKey, authenticity: 'UNVERIFIED', providerState: json({ source: 'ALKORD', sourceId, status: row.SITUACAO }) } }) : await tx.fiscalDocument.create({ data: { tenantId: tenant.id, direction: 'EXIT', model: '55', status, number: Number(row.NUMERO) || null, series: Number(row.SERIE) || null, issuedAt: date(row.DATA_EMISSAO), accessKey, authenticity: 'UNVERIFIED', providerState: json({ source: 'ALKORD', sourceId, status: row.SITUACAO }) } });
      if (xml && !(await tx.fiscalXmlFile.findFirst({ where: { tenantId: tenant.id, documentId: doc.id, kind: 'AUTHORIZED' }, select: { id: true } }))) await tx.fiscalXmlFile.create({ data: { tenantId: tenant.id, documentId: doc.id, kind: 'AUTHORIZED', sha256: createHash('sha256').update(String(xml)).digest('hex'), content: String(xml), source: `Alkord NF ${sourceId}`, createdById: owner.userId } });
      invoiceCount++;
    });
  }
  await runtime.$disconnect();
  console.log(JSON.stringify({ tenant: tenant.name, warehouse: warehouse.code, source: { products: products.length, customers: customers.length, sales: sales.length, invoices: invoices.length }, imported: { products: productCount, stockBalances: stockCount, customers: customerCount, sales: salesCount, invoices: invoiceCount }, note: 'Fotos e usuários não foram importados: a API Alkord não os disponibiliza.' }, null, 2));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
