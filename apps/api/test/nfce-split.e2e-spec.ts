import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);
let seq = 0;
const uid = () => `${run}${++seq}`;

describe('NFC-e dividida pelo limite de valor do cupom', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let owner: ReturnType<typeof request.agent>;
  let wh: string;
  let tenantId: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    owner = request.agent(app.getHttpServer());
    const reg = await owner.post('/api/auth/register').set(H).send({ companyName: `Co split ${run}`, name: 'Dono', email: `split-${run}@teste.local`, password: PASSWORD }).expect(201);
    tenantId = reg.body.tenantId;
    const company = await owner.post('/api/companies').set(H).send({ legalName: 'Split LTDA', taxRegime: 'SIMPLES_NACIONAL' }).expect(201);
    const est = await owner.post('/api/establishments').set(H).send({ companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz', cnpj: '45723174000110', stateRegistration: '111222333444', cnae: '4744-0/99', zipCode: '13000-000', city: 'Campinas', state: 'SP', street: 'Rua A', number: '1' }).expect(201);
    wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
  });
  afterAll(async () => { await admin.$disconnect(); await app.close(); });

  async function confirmedOrder(qty: number, price: number, fiscalDocType: 'NFCE' | 'NFE' = 'NFCE', shipping = 0) {
    const p = (await owner.post('/api/products').set(H).send({ sku: `SP-${uid()}`, name: 'Item', suggestedPrice: price, costPrice: 1, ncm: '73181500' }).expect(201)).body.id;
    await owner.post('/api/stock/movements').set(H).send({ productId: p, warehouseId: wh, type: 'PURCHASE_ENTRY', quantity: qty }).expect(201);
    const c = (await owner.post('/api/customers').set(H).send({ kind: 'PF', name: `Cli ${uid()}` }).expect(201)).body.id;
    const o = (await owner.post('/api/sales/orders').set(H).send({ customerId: c, warehouseId: wh, fiscalDocType, shipping, items: [{ productId: p, quantity: qty, unitPrice: price }] }).expect(201)).body.id;
    await owner.post(`/api/sales/orders/${o}/submit`).set(H).expect(200);
    return o as string;
  }
  const docsOf = (orderId: string) => admin.fiscalDocument.findMany({ where: { salesOrderId: orderId }, include: { items: true }, orderBy: { splitIndex: 'asc' } });

  it('o limite padrão é R$ 9.999,00 e pode ser alterado (0 desliga)', async () => {
    expect((await owner.get('/api/settings').expect(200)).body['fiscal.nfceMaxValue']).toBe(9999);
    await owner.put('/api/settings').set(H).send({ 'fiscal.nfceMaxValue': -1 }).expect(400);
    await owner.put('/api/settings').set(H).send({ 'fiscal.nfceMaxValue': 'x' }).expect(400);
  });

  it('pedido de R$ 400.000,00 em NFC-e vira 41 cupons, nenhum acima de R$ 9.999,00, somando exatamente o pedido', async () => {
    const o = await confirmedOrder(40000, 10); // 40.000 × R$ 10,00
    const r = (await owner.post('/api/fiscal/outgoing/prepare').set(H).send({ salesOrderId: o }).expect(200)).body;
    expect(r.parts).toBe(41);
    expect(r.ids).toHaveLength(41);
    const docs = await docsOf(o);
    expect(docs).toHaveLength(41);
    expect(docs.every((d) => d.model === '65')).toBe(true);
    expect(docs.map((d) => [d.splitIndex, d.splitTotal])[0]).toEqual([1, 41]);
    expect(docs[40].splitIndex).toBe(41);
    for (const d of docs) expect(Number(d.totalInvoice)).toBeLessThanOrEqual(9999);
    const total = docs.reduce((s, d) => s + Math.round(Number(d.totalInvoice) * 100), 0);
    expect(total).toBe(40000000);
    // cada cupom: total do cabeçalho = soma dos itens
    for (const d of docs) expect(d.items.reduce((s, i) => s + Math.round(Number(i.totalValue) * 100), 0)).toBe(Math.round(Number(d.totalProducts) * 100));
    expect(docs.reduce((s, d) => s + d.items.reduce((q, i) => q + Number(i.quantity), 0), 0)).toBe(40000);

    // preparar de novo não duplica: devolve os mesmos cupons
    const again = (await owner.post('/api/fiscal/outgoing/prepare').set(H).send({ salesOrderId: o }).expect(200)).body;
    expect(again).toMatchObject({ existing: true, parts: 41 });
    expect(again.ids).toEqual(r.ids);
    expect(await docsOf(o)).toHaveLength(41);

    const list = (await owner.get('/api/fiscal/outgoing').expect(200)).body as any[];
    expect(list.filter((d) => d.salesOrderId === o && d.splitTotal === 41)).toHaveLength(41);
  }, 60000);

  it('pedido dentro do limite continua com um cupom só (sem numeração de parte)', async () => {
    const o = await confirmedOrder(3, 100);
    const r = (await owner.post('/api/fiscal/outgoing/prepare').set(H).send({ salesOrderId: o }).expect(200)).body;
    expect(r.parts).toBe(1);
    const docs = await docsOf(o);
    expect(docs).toHaveLength(1);
    expect(docs[0].splitIndex).toBeNull();
    expect(Number(docs[0].totalInvoice)).toBe(300);
  });

  it('NF-e não é dividida, mesmo acima do valor', async () => {
    const o = await confirmedOrder(100, 500, 'NFE'); // R$ 50.000,00
    const r = (await owner.post('/api/fiscal/outgoing/prepare').set(H).send({ salesOrderId: o }).expect(200)).body;
    expect(r.parts).toBe(1);
    expect(Number((await docsOf(o))[0].totalInvoice)).toBe(50000);
  });

  it('o frete entra no primeiro cupom e o limite é respeitado', async () => {
    const o = await confirmedOrder(5, 4000, 'NFCE', 100); // R$ 20.000,00 + R$ 100,00 de frete
    const r = (await owner.post('/api/fiscal/outgoing/prepare').set(H).send({ salesOrderId: o }).expect(200)).body;
    const docs = await docsOf(o);
    expect(r.parts).toBe(docs.length);
    expect(docs.length).toBeGreaterThan(1);
    expect(Number(docs[0].totalFreight)).toBe(100);
    expect(docs.slice(1).every((d) => Number(d.totalFreight) === 0)).toBe(true);
    expect(docs.reduce((s, d) => s + Math.round(Number(d.totalInvoice) * 100), 0)).toBe(2010000);
    for (const d of docs) expect(Number(d.totalInvoice)).toBeLessThanOrEqual(9999);
  });

  it('uma unidade acima do limite não pode ser dividida: recusa e não cria nada', async () => {
    const o = await confirmedOrder(1, 15000);
    const res = await owner.post('/api/fiscal/outgoing/prepare').set(H).send({ salesOrderId: o }).expect(409);
    expect(JSON.stringify(res.body)).toMatch(/dividir/);
    expect(await docsOf(o)).toHaveLength(0);
  });

  it('com o limite alterado para R$ 20.000,00 o mesmo tipo de pedido cabe em um cupom; com 0 não divide', async () => {
    await owner.put('/api/settings').set(H).send({ 'fiscal.nfceMaxValue': 20000 }).expect(200);
    const a = await confirmedOrder(1, 15000);
    expect((await owner.post('/api/fiscal/outgoing/prepare').set(H).send({ salesOrderId: a }).expect(200)).body.parts).toBe(1);
    await owner.put('/api/settings').set(H).send({ 'fiscal.nfceMaxValue': 0 }).expect(200);
    const b = await confirmedOrder(10, 5000);
    expect((await owner.post('/api/fiscal/outgoing/prepare').set(H).send({ salesOrderId: b }).expect(200)).body.parts).toBe(1);
    await owner.put('/api/settings').set(H).send({ 'fiscal.nfceMaxValue': 9999 }).expect(200);
    void tenantId;
  });
});
