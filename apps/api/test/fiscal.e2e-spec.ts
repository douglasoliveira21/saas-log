import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as forge from 'node-forge';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';
import { isValidChave, parseChave } from '../src/fiscal/chave';
import { ConsultResult, FISCAL_PROVIDER, FiscalProvider, TransmitInput, TransmitResult } from '../src/fiscal/fiscal-provider';
import { CryptoService } from '../src/integrations/crypto.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { buildNfeXml, FixtureItem } from './fixtures/nfe';

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);
let seq = 0;
const uid = () => `${run}${++seq}`;
const EST_CNPJ = '45723174000110';
const SUP_CNPJ = '11222333000181';

/** Provedor de transmissão SIMULADO (teste): permite exercitar a máquina de estados sem SEFAZ. Não existe em produção. */
class ScriptedProvider implements FiscalProvider {
  name = 'scripted';
  configured = true;
  transmitBehavior: TransmitResult | 'THROW' = { kind: 'AUTHORIZED', protocol: '135260000000001', statusCode: '100' };
  consultBehavior: ConsultResult = { kind: 'UNKNOWN' };
  delayMs = 0;
  transmitted: string[] = [];
  consulted: string[] = [];
  isConfigured() { return this.configured; }
  async transmit(i: TransmitInput): Promise<TransmitResult> {
    this.transmitted.push(i.accessKey);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.transmitBehavior === 'THROW') throw new Error('socket hang up');
    return this.transmitBehavior;
  }
  async consult(key: string): Promise<ConsultResult> { this.consulted.push(key); return this.consultBehavior; }
}

function makePfx(opts: { cn: string; password: string; notAfterDays?: number; notBeforeDays?: number }): string {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '0' + Math.floor(Math.random() * 1e9).toString(16);
  cert.validity.notBefore = new Date(Date.now() - (opts.notBeforeDays ?? 1) * 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + (opts.notAfterDays ?? 365) * 86_400_000);
  const attrs = [{ name: 'commonName', value: opts.cn }, { name: 'countryName', value: 'BR' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], opts.password, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary').toString('base64');
}

describe('Fase 6 — fiscal: configuração, certificado, XML recebido, motor e saída', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: PrismaClient;
  let crypto: CryptoService;
  const provider = new ScriptedProvider();
  const agent = () => request.agent(app.getHttpServer());
  type Agent = ReturnType<typeof agent>;
  interface T { owner: Agent; tenantId: string; companyId: string; est: string; wh: string; users: Record<string, Agent>; roles: Record<string, string> }

  async function addUser(t: T, roleKey: string) {
    const email = `${roleKey}-${uid()}@teste.local`;
    await t.owner.post('/api/users').set(H).send({ name: `Usuario ${roleKey}`, email, password: PASSWORD, roleId: t.roles[roleKey] }).expect(201);
    const a = agent();
    await a.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200);
    return a;
  }

  async function setup(label: string, opts: { complete?: boolean } = {}): Promise<T> {
    const owner = agent();
    const reg = await owner.post('/api/auth/register').set(H).send({ companyName: `Co ${label} ${run}`, name: `Dono ${label}`, email: `${label}-${run}@teste.local`, password: PASSWORD }).expect(201);
    const company = await owner.post('/api/companies').set(H).send({ legalName: `${label} LTDA`, ...(opts.complete === false ? {} : { taxRegime: 'SIMPLES_NACIONAL' }) }).expect(201);
    const est = await owner.post('/api/establishments').set(H).send({
      companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz', cnpj: EST_CNPJ,
      ...(opts.complete === false ? {} : { stateRegistration: '111222333444', cnae: '4744-0/99', zipCode: '13000-000', city: 'Campinas', state: 'SP', street: 'Rua A', number: '1' }),
    }).expect(201);
    const wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
    const roles = Object.fromEntries((await owner.get('/api/roles').expect(200)).body.map((r: any) => [r.key, r.id]));
    const t: T = { owner, tenantId: reg.body.tenantId, companyId: company.body.id, est: est.body.id, wh, users: {}, roles };
    for (const k of ['fiscal', 'accountant', 'buyer', 'ops_manager', 'stock_operator']) t.users[k] = await addUser(t, k);
    return t;
  }

  const product = async (t: T, extra: object = {}, stock = 0) => {
    const id = (await t.owner.post('/api/products').set(H).send({ sku: `FX-${uid()}`, name: 'Produto fiscal', costPrice: 10, suggestedPrice: 50, ncm: '73181500', taxOrigin: 0, ...extra }).expect(201)).body.id as string;
    if (stock) await t.owner.post('/api/stock/movements').set(H).send({ productId: id, warehouseId: t.wh, type: 'PURCHASE_ENTRY', quantity: stock }).expect(201);
    return id;
  };
  const supplier = async (t: T, document = SUP_CNPJ) => (await t.owner.post('/api/suppliers').set(H).send({ legalName: 'Fornecedor Teste Ltda', document }).expect(201)).body.id as string;
  const purchaseOrder = async (t: T, supplierId: string, items: { productId: string; quantity: number; unitCost: number }[]) => {
    const po = (await t.users.buyer.post('/api/purchases').set(H).send({ supplierId, warehouseId: t.wh, items }).expect(201)).body.id as string;
    await t.users.buyer.post(`/api/purchases/${po}/submit`).set(H).expect(200);
    return po;
  };
  const importXml = (t: T, xml: string, who: Agent = t.users.ops_manager) => who.post('/api/fiscal/inbound/import').set(H).send({ xml, source: 'teste.xml' });
  const nfe = (items: FixtureItem[], extra: object = {}) => buildNfeXml({ emitterCnpj: SUP_CNPJ, recipientCnpj: EST_CNPJ, number: Math.floor(Math.random() * 9e6) + 1, items, ...extra });
  const balance = async (t: T, productId: string) => ((await t.owner.get(`/api/stock/balances/${productId}`).expect(200)).body[0] ?? { onHand: 0 });
  const jsonOf = (r: { body: unknown }) => JSON.stringify(r.body);

  let A: T;
  let B: T;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(FISCAL_PROVIDER).useValue(provider).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    prisma = app.get(PrismaService);
    crypto = app.get(CryptoService);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    await admin.plan.update({ where: { code: 'trial' }, data: { limits: { users: 100, establishments: 20, warehouses: 20 } } });
    A = await setup('fisA');
    B = await setup('fisB');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  // ───────────────────────── configuração, assistente e certificado ─────────────────────────
  describe('assistente de configuração e certificado A1', () => {
    it('mostra o que impede homologação/produção, sem presumir nada, e gera perguntas para o contador', async () => {
      const C = await setup('fisC', { complete: false });
      provider.configured = false; // instalação sem provedor de transmissão
      const r = (await C.users.fiscal.get(`/api/fiscal/establishments/${C.est}/config`).expect(200)).body;
      const by = Object.fromEntries(r.readiness.map((i: any) => [i.key, i]));
      for (const k of ['ie', 'address', 'regime', 'certificate', 'tax_rules', 'provider']) expect(by[k].status).toBe('BLOCKING');
      expect(by.cnpj.status).toBe('OK');
      expect(by.provider.detail).toMatch(/token do provedor/);
      expect(r.readyForHomologation).toBe(false);
      expect(r.readyForProduction).toBe(false);
      provider.configured = true;
      expect(r.blockingForProduction).toEqual(expect.arrayContaining(['Certificado digital A1 válido', 'Regras tributárias aprovadas e vigentes']));
      expect(r.questionsForAccountant.join(' ')).toMatch(/regime tributário/i);
      expect(r.config).toMatchObject({ environment: 'HOMOLOGACAO', status: 'DRAFT' }); // padrão seguro
      // completar o cadastro resolve os itens correspondentes
      await C.owner.patch(`/api/establishments/${C.est}`).set(H).send({ stateRegistration: '123', zipCode: '13000-000', city: 'Campinas', state: 'SP', cnae: '4744-0/99' }).expect(200);
      await C.owner.patch(`/api/companies/${C.companyId}`).set(H).send({ taxRegime: 'LUCRO_PRESUMIDO' }).expect(200);
      const r2 = (await C.users.fiscal.get(`/api/fiscal/establishments/${C.est}/config`).expect(200)).body;
      const by2 = Object.fromEntries(r2.readiness.map((i: any) => [i.key, i.status]));
      expect([by2.ie, by2.address, by2.regime, by2.cnae]).toEqual(['OK', 'OK', 'OK', 'OK']);
      await C.users.stock_operator.get(`/api/fiscal/establishments/${C.est}/config`).expect(403);
    });

    it('certificado A1: valida senha/validade/chave privada, guarda CIFRADO, expõe só metadados e substitui o anterior apagando o segredo', async () => {
      const pfx = makePfx({ cn: `EMPRESA TESTE:${EST_CNPJ}`, password: 'senha-do-pfx' });
      const up = (b64: string, password: string, who: Agent = A.users.fiscal) => who.post(`/api/fiscal/establishments/${A.est}/certificate`).set(H).send({ pfxBase64: b64, password });
      await up(pfx, 'senha-errada').expect(422);
      await up(Buffer.from('lixo qualquer').toString('base64'), 'x').expect(422);
      await up(makePfx({ cn: `VENCIDO:${EST_CNPJ}`, password: 'p', notAfterDays: -5, notBeforeDays: 400 }), 'p').expect(422);
      await up(pfx, 'senha-do-pfx', A.users.ops_manager).expect(403);
      const ok = (await up(pfx, 'senha-do-pfx').expect(201)).body;
      expect(ok).toMatchObject({ cnpj: EST_CNPJ, expired: false, expiringSoon: false, warnings: [] });
      expect(ok.subject).toContain('EMPRESA TESTE');
      expect(jsonOf({ body: ok })).not.toMatch(/senha-do-pfx|pfxEnc|pfxBase64/);

      const row = await admin.fiscalCertificate.findFirstOrThrow({ where: { tenantId: A.tenantId, status: 'ACTIVE' } });
      expect(row.pfxEnc).toMatch(/^v1\./);
      expect(row.pfxEnc).not.toContain(pfx.slice(0, 40));
      expect(crypto.decrypt<{ password: string }>(A.tenantId, `fiscal-cert:${row.id}`, row.pfxEnc).password).toBe('senha-do-pfx');
      expect(() => crypto.decrypt(B.tenantId, `fiscal-cert:${row.id}`, row.pfxEnc)).toThrow(); // outro tenant não decifra

      const cfg = (await A.users.fiscal.get(`/api/fiscal/establishments/${A.est}/config`).expect(200)).body;
      expect(jsonOf({ body: cfg })).not.toMatch(/senha-do-pfx|pfxEnc/);
      expect(cfg.certificate.id).toBe(row.id);
      expect(cfg.readiness.find((i: any) => i.key === 'certificate').status).toBe('OK');

      // substituir: o anterior vira REPLACED e o segredo é apagado
      const second = makePfx({ cn: `EMPRESA TESTE:${EST_CNPJ}`, password: 'outra-senha' });
      const r2 = (await up(second, 'outra-senha').expect(201)).body;
      expect(r2.id).not.toBe(row.id);
      const old = await admin.fiscalCertificate.findUniqueOrThrow({ where: { id: row.id } });
      expect(old).toMatchObject({ status: 'REPLACED', pfxEnc: '' });
      expect(await admin.fiscalCertificate.count({ where: { tenantId: A.tenantId, status: 'ACTIVE' } })).toBe(1);

      const audit = JSON.stringify((await A.owner.get('/api/audit?action=fiscal.certificate_uploaded').expect(200)).body);
      expect(audit).not.toMatch(/senha|password|pfx/i);
      expect(audit).toContain(r2.fingerprint);
    });

    it('avisa certificado de outro CNPJ e a proximidade do vencimento (indicador do painel)', async () => {
      const C = await setup('fisD');
      const r = (await C.users.fiscal.post(`/api/fiscal/establishments/${C.est}/certificate`).set(H).send({ pfxBase64: makePfx({ cn: 'OUTRA EMPRESA:99999999000191', password: 'p', notAfterDays: 10 }), password: 'p' }).expect(201)).body;
      expect(r.warnings.join(' ')).toMatch(/mesma raiz/);
      expect(r).toMatchObject({ expiringSoon: true });
      expect((await C.users.fiscal.get('/api/fiscal/metrics').expect(200)).body.certificatesExpiringSoon).toBe(1);
    });

    it('fluxo de validação do contador: mudanças invalidam a aprovação; quem configura não aprova', async () => {
      const C = await setup('fisE');
      const url = `/api/fiscal/establishments/${C.est}/config`;
      await C.users.fiscal.post(`${url}/submit`).set(H).expect(400); // sem contador informado
      await C.users.fiscal.put(url).set(H).send({ accountantName: 'Maria Contadora', accountantEmail: 'maria@contabil.test', environment: 'PRODUCAO' }).expect(200);
      const sub = (await C.users.fiscal.post(`${url}/submit`).set(H).expect(200)).body;
      expect(sub.status).toBe('PENDING_ACCOUNTANT');
      expect(sub.questionsForAccountant.length).toBeGreaterThan(0);
      await C.users.fiscal.post(`${url}/approve`).set(H).expect(403);
      await C.users.accountant.post(`${url}/approve`).set(H).expect(200);
      expect((await C.users.fiscal.get(url).expect(200)).body.config).toMatchObject({ status: 'APPROVED', environment: 'PRODUCAO' });
      await C.users.accountant.post(`${url}/approve`).set(H).expect(409);
      await C.users.fiscal.put(url).set(H).send({ nfeSeries: 2 }).expect(200); // qualquer mudança reabre a validação
      expect((await C.users.fiscal.get(url).expect(200)).body.config).toMatchObject({ status: 'DRAFT', approvedAt: null });
      await C.users.fiscal.put(url).set(H).send({ nfeSeries: 0 }).expect(400);
      await C.users.fiscal.put(url).set(H).send({ environment: 'TESTE' }).expect(400);
      const acts = (await C.owner.get('/api/audit?limit=100').expect(200)).body.items.map((i: any) => i.action);
      expect(acts).toEqual(expect.arrayContaining(['fiscal.config_changed', 'fiscal.config_submitted', 'fiscal.config_approved']));
    });
  });

  // ───────────────────────── XML recebido ─────────────────────────
  describe('importação e validação de XML recebido', () => {
    it('importa NF-e válida: guarda o XML com hash, vincula fornecedor e produto por GTIN, preserva avisos de autenticidade', async () => {
      const sup = await supplier(A);
      const p = await product(A, { barcode: '7891234567895' });
      const { xml, key } = nfe([{ code: 'FORN-1', name: 'Parafuso', qty: 10, price: 2.5, gtin: '7891234567895' }], { installments: [25] });
      const r = (await importXml(A, xml).expect(201)).body;
      expect(r).toMatchObject({ supplierFound: true, items: 1, matched: 1, accessKey: key });
      expect(r.issues.map((i: any) => i.code)).toEqual(['AUTHENTICITY_UNVERIFIED']);
      const doc = (await A.users.fiscal.get(`/api/fiscal/inbound/${r.id}`).expect(200)).body;
      expect(doc).toMatchObject({ status: 'IMPORTED', authenticity: 'UNVERIFIED', supplierId: sup, environment: 'PRODUCAO' });
      expect(doc.items[0]).toMatchObject({ productId: p, matchedBy: 'GTIN', stockQty: 10 });
      const x = (await A.users.fiscal.get(`/api/fiscal/inbound/${r.id}/xml`).expect(200)).body;
      expect(x.content).toBe(xml);
      expect(x.sha256).toBe(doc.xmlFiles[0].sha256);
      expect((await A.owner.get('/api/audit?action=fiscal.xml_viewed').expect(200)).body.items.length).toBeGreaterThan(0);
      await expect(prisma.withContext({ tenantId: A.tenantId }, (tx) => tx.fiscalXmlFile.deleteMany({}))).rejects.toThrow(); // retenção
      await expect(prisma.withContext({ tenantId: A.tenantId }, (tx) => tx.fiscalDocumentItem.updateMany({ where: { documentId: r.id }, data: { quantity: '999' } }))).rejects.toThrow(); // dados do XML imutáveis
    });

    it('duplicidade: reimportar (inclusive em paralelo) não cria outro documento', async () => {
      const { xml } = nfe([{ code: 'D1', name: 'Item', qty: 1, price: 10 }]);
      const first = await importXml(A, xml).expect(201);
      const rs = await Promise.all([1, 2, 3].map(() => importXml(A, xml)));
      expect(rs.every((r) => r.status === 409 && r.body.documentId === first.body.id)).toBe(true);
      const par = nfe([{ code: 'D2', name: 'Item', qty: 1, price: 10 }]);
      const many = await Promise.all([1, 2, 3, 4].map(() => importXml(A, par.xml)));
      expect(many.filter((r) => r.status === 201)).toHaveLength(1);
      expect(many.filter((r) => r.status === 409)).toHaveLength(3);
      expect(await admin.fiscalDocument.count({ where: { tenantId: A.tenantId, accessKey: par.key } })).toBe(1);
    });

    it('rejeita (422, sem gravar) destinatário estranho, chave inválida/inconsistente, nota não autorizada e totais quebrados', async () => {
      const before = await admin.fiscalDocument.count({ where: { tenantId: A.tenantId } });
      const bad = async (xml: string, code: string) => {
        const r = await importXml(A, xml).expect(422);
        expect(r.body.issues.map((i: any) => i.code)).toContain(code);
      };
      await bad(buildNfeXml({ emitterCnpj: SUP_CNPJ, recipientCnpj: '99999999000199', number: 7001, items: [{ code: 'X', name: 'x', qty: 1, price: 1 }] }).xml, 'RECIPIENT_NOT_ESTABLISHMENT');
      await bad(nfe([{ code: 'X', name: 'x', qty: 1, price: 1 }], { badKeyDv: true }).xml, 'KEY_INVALID');
      await bad(nfe([{ code: 'X', name: 'x', qty: 1, price: 1 }], { wrongKeyCnpj: true }).xml, 'KEY_MISMATCH');
      await bad(nfe([{ code: 'X', name: 'x', qty: 1, price: 1 }], { protocol: { cStat: '110' } }).xml, 'NOT_AUTHORIZED');
      await bad(nfe([{ code: 'X', name: 'x', qty: 1, price: 1 }], { breakTotal: true }).xml, 'TOTAL_PRODUCTS_MISMATCH');
      expect(await admin.fiscalDocument.count({ where: { tenantId: A.tenantId } })).toBe(before);
      expect((await A.owner.get('/api/audit?action=fiscal.xml_rejected').expect(200)).body.items.length).toBeGreaterThanOrEqual(5);
    });

    it('rejeita lixo, não-NF-e e XML com DOCTYPE/ENTITY (XXE); exige permissão', async () => {
      await importXml(A, 'não é xml').expect(400);
      await importXml(A, '<a><b/></a>').expect(400);
      await importXml(A, '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><NFe><infNFe/></NFe>').expect(400);
      await importXml(A, nfe([{ code: 'P', name: 'x', qty: 1, price: 1 }]).xml, A.users.stock_operator).expect(403);
      await B.users.ops_manager.post('/api/fiscal/inbound/import').set(H).send({ xml: nfe([{ code: 'P', name: 'x', qty: 1, price: 1 }]).xml }).expect(201); // mesmo CNPJ em outro tenant é independente
    });

    it('vínculo manual memoriza o código do fornecedor; unidade de compra converte para o estoque; unidade desconhecida pede revisão', async () => {
      const sup = await supplier(A, '11444777000161');
      const p = await product(A, { purchaseUnit: 'CX', unitConversion: 12, saleUnit: 'UN' });
      const p3 = await product(A, { purchaseUnit: 'UN', saleUnit: 'UN' });
      const xml1 = buildNfeXml({ emitterCnpj: '11444777000161', recipientCnpj: EST_CNPJ, number: 8001, items: [{ code: 'CX-77', name: 'Caixa', qty: 2, price: 120, unit: 'CX' }, { code: 'KG-1', name: 'Granel', qty: 3, price: 5, unit: 'KG' }] });
      const r = (await importXml(A, xml1.xml).expect(201)).body;
      expect(r.matched).toBe(0);
      const link = (line: number, productId = p) => A.users.ops_manager.put(`/api/fiscal/inbound/${r.id}/items/${line}/product`).set(H).send({ productId });
      expect((await link(1).expect(200)).body).toMatchObject({ stockQty: 24, warning: null });
      expect((await link(2, p3).expect(200)).body).toMatchObject({ stockQty: null });
      expect((await link(2, p3).expect(200)).body.warning).toMatch(/Unidade "KG"/);
      // próxima nota do mesmo fornecedor já vincula pelo código memorizado
      const xml2 = buildNfeXml({ emitterCnpj: '11444777000161', recipientCnpj: EST_CNPJ, number: 8002, items: [{ code: 'CX-77', name: 'Caixa', qty: 1, price: 120, unit: 'CX' }] });
      const r2 = (await importXml(A, xml2.xml).expect(201)).body;
      expect(r2.matched).toBe(1);
      expect((await A.users.fiscal.get(`/api/fiscal/inbound/${r2.id}`)).body.items[0]).toMatchObject({ matchedBy: 'SUPPLIER_CODE', stockQty: 12 });
      void sup;
    });

    it('cria fornecedor a partir do emitente (exige permissão de fornecedores) e revincula os itens', async () => {
      const cnpj = '00000000000191';
      const p = await product(A, { barcode: '4006381333931' });
      const r = (await importXml(A, buildNfeXml({ emitterCnpj: cnpj, recipientCnpj: EST_CNPJ, number: 9001, items: [{ code: 'Z1', name: 'Item', qty: 1, price: 9, gtin: '4006381333931' }] }).xml).expect(201)).body;
      expect(r).toMatchObject({ supplierFound: false, matched: 1 });
      await A.users.fiscal.post(`/api/fiscal/inbound/${r.id}/supplier`).set(H).expect(403); // fiscal importa XML mas não cadastra fornecedores
      const s = (await A.owner.post(`/api/fiscal/inbound/${r.id}/supplier`).set(H).expect(200)).body;
      expect(s.created).toBe(true);
      await A.owner.post(`/api/fiscal/inbound/${r.id}/supplier`).set(H).expect(409);
      expect((await A.owner.get(`/api/fiscal/inbound/${r.id}`)).body.supplierId).toBe(s.supplierId);
      void p;
    });
  });

  // ───────────────────────── conciliação e recebimento ─────────────────────────
  describe('conciliação com a ordem de compra e recebimento', () => {
    it('compara nota × OC (quantidade, custo, itens fora da OC) e bloqueia o recebimento com pendências', async () => {
      const sup = await supplier(A, '11444777000161').catch(async () => (await A.owner.get('/api/suppliers?search=11444777000161')).body[0].id);
      const pOk = await product(A, { barcode: '7891000200018' });
      const pExtra = await product(A, { barcode: '7891000300022' });
      const pMissing = await product(A);
      const po = await purchaseOrder(A, sup, [{ productId: pOk, quantity: 10, unitCost: 2.5 }, { productId: pMissing, quantity: 4, unitCost: 3 }]);
      const xml = buildNfeXml({ emitterCnpj: '11444777000161', recipientCnpj: EST_CNPJ, number: 9100 + (seq % 50), items: [{ code: 'A', name: 'ok', qty: 10, price: 2.5, gtin: '7891000200018' }, { code: 'B', name: 'fora da OC', qty: 1, price: 9, gtin: '7891000300022' }] });
      const r = (await importXml(A, xml.xml).expect(201)).body;
      const sug = (await A.users.ops_manager.get(`/api/fiscal/inbound/${r.id}/reconcile`).expect(200)).body;
      expect(sug.suggestions.find((s: any) => s.id === po)).toMatchObject({ coverage: 1 });
      const rec = (await A.users.ops_manager.get(`/api/fiscal/inbound/${r.id}/reconcile?purchaseOrderId=${po}`).expect(200)).body;
      expect(rec.lines.map((l: any) => l.status)).toEqual(['OK', 'NOT_IN_PO']);
      expect(rec.notDelivered).toEqual([expect.objectContaining({ pending: 4 })]);
      expect(rec.canReceive).toBe(false);
      const blocked = await A.users.ops_manager.post(`/api/fiscal/inbound/${r.id}/receive`).set(H).send({ purchaseOrderId: po }).expect(409);
      expect(blocked.body.blockers.join(' ')).toMatch(/não consta na ordem/);
      expect(await balance(A, pOk)).toMatchObject({ onHand: 0 });
      void pExtra;
    });

    it('recebe a nota: entrada no estoque com custo do XML, OC atualizada, idempotente, divergência de custo exige confirmação e estorno reabre a nota', async () => {
      const sup = await supplier(A, '33000167000101');
      const p = await product(A, { costPrice: 2, barcode: '7898927219016' }, 0);
      const po = await purchaseOrder(A, sup, [{ productId: p, quantity: 10, unitCost: 2.5 }]);
      const key = (n: number, price: number, qty = 6) => buildNfeXml({ emitterCnpj: '33000167000101', recipientCnpj: EST_CNPJ, number: n, items: [{ code: 'R1', name: 'Item', qty, price, gtin: '7898927219016' }] });
      const x1 = key(9201, 2.5);
      const doc = (await importXml(A, x1.xml).expect(201)).body.id as string;
      const rcv = () => A.users.ops_manager.post(`/api/fiscal/inbound/${doc}/receive`).set(H).send({ purchaseOrderId: po });
      await A.users.buyer.post(`/api/fiscal/inbound/${doc}/receive`).set(H).send({ purchaseOrderId: po }).expect(403); // sem permissão de recebimento
      const rs = await Promise.all([rcv(), rcv(), rcv()]);
      const okRs = rs.filter((r) => r.status === 200);
      expect(okRs.length).toBeGreaterThanOrEqual(1);
      expect(new Set(okRs.map((r) => r.body.receiptId)).size).toBe(1);
      expect(await balance(A, p)).toMatchObject({ onHand: 6 });
      expect(await admin.goodsReceipt.count({ where: { tenantId: A.tenantId, purchaseId: po } })).toBe(1);
      expect((await A.users.ops_manager.get(`/api/purchases/${po}`)).body.status).toBe('PARTIALLY_RECEIVED');
      expect(Number((await A.owner.get(`/api/products/${p}`)).body.costPrice)).toBe(2.5); // custo médio com o custo do XML
      await rcv().expect(409); // já recebida
      const done = (await A.users.fiscal.get(`/api/fiscal/inbound/${doc}`).expect(200)).body;
      expect(done).toMatchObject({ status: 'RECEIVED', purchaseOrderId: po });

      // segunda nota com custo 10% acima: precisa de confirmação explícita
      const doc2 = (await importXml(A, key(9202, 2.75, 4).xml).expect(201)).body.id as string;
      const recv2 = (accept?: boolean) => A.users.ops_manager.post(`/api/fiscal/inbound/${doc2}/receive`).set(H).send({ purchaseOrderId: po, acceptCostDivergence: accept });
      const need = await recv2().expect(409);
      expect(need.body.requiresCostConfirmation).toBe(true);
      expect(await balance(A, p)).toMatchObject({ onHand: 6 });
      await recv2(true).expect(200);
      expect(await balance(A, p)).toMatchObject({ onHand: 10 });
      expect((await A.users.ops_manager.get(`/api/purchases/${po}`)).body.status).toBe('RECEIVED');

      // estornar o recebimento da primeira nota reabre a nota para novo recebimento
      const receiptId = done.receiptId as string;
      await A.users.ops_manager.post(`/api/purchases/receipts/${receiptId}/reverse`).set(H).send({ reason: 'lançamento duplicado' }).expect(200);
      expect((await A.users.fiscal.get(`/api/fiscal/inbound/${doc}`).expect(200)).body.status).toBe('IMPORTED');
      expect(await balance(A, p)).toMatchObject({ onHand: 4 });
      const again = await rcv().expect(200);
      expect(again.body.receiptId).not.toBe(receiptId);
      expect(await balance(A, p)).toMatchObject({ onHand: 10 });
    });

    it('quantidade acima do pendente e nota de homologação não geram recebimento; sem fornecedor exige vínculo', async () => {
      const sup = await supplier(A, '44000167000101').catch(() => '');
      void sup;
      const p = await product(A, { barcode: '7891000100103' });
      const s2 = (await A.owner.post('/api/suppliers').set(H).send({ legalName: 'Outro Forn', document: '04252011000110' }).expect(201)).body.id;
      const po = await purchaseOrder(A, s2, [{ productId: p, quantity: 5, unitCost: 4 }]);
      const mk = (n: number, qty: number, extra: object = {}) => buildNfeXml({ emitterCnpj: '04252011000110', recipientCnpj: EST_CNPJ, number: n, items: [{ code: 'Q', name: 'x', qty, price: 4, gtin: '7891000100103' }], ...extra });
      const over = (await importXml(A, mk(9301, 9).xml).expect(201)).body.id;
      const o = await A.users.ops_manager.post(`/api/fiscal/inbound/${over}/receive`).set(H).send({ purchaseOrderId: po }).expect(409);
      expect(o.body.blockers.join(' ')).toMatch(/maior que o pendente/);
      const hom = (await importXml(A, mk(9302, 2, { env: 2 }).xml).expect(201)).body;
      expect(hom.issues.map((i: any) => i.code)).toContain('HOMOLOGATION_DOCUMENT');
      await A.users.ops_manager.post(`/api/fiscal/inbound/${hom.id}/receive`).set(H).send({ purchaseOrderId: po }).expect(422);
      const noSup = (await importXml(A, buildNfeXml({ emitterCnpj: '60746948000112', recipientCnpj: EST_CNPJ, number: 9303, items: [{ code: 'N', name: 'x', qty: 1, price: 1 }] }).xml).expect(201)).body.id;
      await A.users.ops_manager.post(`/api/fiscal/inbound/${noSup}/receive`).set(H).send({ purchaseOrderId: po }).expect(409);
      expect(await balance(A, p)).toMatchObject({ onHand: 0 });
    });

    it('isolamento: o outro tenant não vê nem concilia os documentos', async () => {
      const { xml } = nfe([{ code: 'ISO', name: 'x', qty: 1, price: 1 }]);
      const id = (await importXml(A, xml).expect(201)).body.id;
      await B.users.fiscal.get(`/api/fiscal/inbound/${id}`).expect(404);
      await B.users.fiscal.get(`/api/fiscal/inbound/${id}/xml`).expect(404);
      await B.users.ops_manager.get(`/api/fiscal/inbound/${id}/reconcile`).expect(404);
      expect(JSON.stringify((await B.users.fiscal.get('/api/fiscal/inbound').expect(200)).body)).not.toContain(id);
    });
  });

  // ───────────────────────── regras e motor ─────────────────────────
  describe('motor fiscal versionado', () => {
    const rule = (extra: object = {}) => ({
      rule: { name: `Venda SP→RJ ${uid()}`, operation: 'SALE', originUf: 'SP', destUf: 'RJ', ...extra },
      version: { validFrom: '2026-01-01T00:00:00Z', sourceReference: 'Parecer contábil 12/2026 – simulado', config: { cfop: '6102', taxes: { ICMS: { csosn: '102', ratePct: 12 }, PIS: { cst: '01', ratePct: 1.65 } } } },
    });
    const calc = (t: T, body: object = {}, who: Agent = t.users.fiscal) =>
      who.post('/api/fiscal/engine/calculate').set(H).send({ operation: 'SALE', date: '2026-06-01', originUf: 'SP', destUf: 'RJ', regime: 'SIMPLES_NACIONAL', items: [{ key: 'a', ncm: '73181500', value: 200 }], ...body });

    it('valida o formato da regra, exige fonte e não usa regras em rascunho', async () => {
      const C = await setup('fisF');
      const create = (r: any) => C.users.fiscal.post('/api/fiscal/rules').set(H).send(r);
      await create({ ...rule(), version: { ...rule().version, sourceReference: 'curto' } }).expect(400);
      await create({ ...rule(), version: { ...rule().version, config: { cfop: '61', taxes: { ICMS: { ratePct: 12 } } } } }).expect(400);
      await create({ ...rule(), version: { ...rule().version, config: { taxes: { ICMS: { ratePct: 120 } } } } }).expect(400);
      await create({ ...rule(), version: { ...rule().version, config: { taxes: { icms: { ratePct: 1 } } } } }).expect(400);
      await create({ ...rule(), version: { ...rule().version, config: { taxes: { ICMS: { cst: '00' } } } } }).expect(400); // alíquota obrigatória
      const ok = (await create(rule()).expect(201)).body;
      const r = (await calc(C).expect(200)).body;
      expect(r.ready).toBe(false);
      expect(r.pendencies[0].code).toBe('NO_RULE'); // rascunho não vale
      expect(ok.versionId).toBeDefined();
    });

    it('aprovação pelo contador (outra pessoa) ativa a regra; resultado é rastreável; versão aprovada é imutável (aplicação e banco)', async () => {
      const C = await setup('fisG');
      const created = (await C.users.fiscal.post('/api/fiscal/rules').set(H).send(rule()).expect(201)).body;
      const v = created.versionId;
      await C.users.accountant.post(`/api/fiscal/rules/versions/${v}/approve`).set(H).expect(409); // não enviada
      await C.users.fiscal.post(`/api/fiscal/rules/versions/${v}/submit`).set(H).expect(200);
      await C.users.fiscal.post(`/api/fiscal/rules/versions/${v}/approve`).set(H).expect(403); // sem permissão de aprovar
      await C.users.accountant.post(`/api/fiscal/rules/versions/${v}/approve`).set(H).expect(200);
      const r = (await calc(C).expect(200)).body;
      expect(r.ready).toBe(true);
      expect(r.items[0]).toMatchObject({ cfop: '6102', taxes: { ICMS: { base: 200, ratePct: 12, amount: 24, csosn: '102' }, PIS: { amount: 3.3 } } });
      expect(r.rulesUsed[0]).toMatchObject({ versionId: v, version: 1, sourceReference: expect.stringContaining('Parecer') });
      expect(r.engineVersion).toBe('1.0.0');
      await C.users.fiscal.put(`/api/fiscal/rules/versions/${v}`).set(H).send({ config: { taxes: { ICMS: { csosn: '102', ratePct: 99 } } } }).expect(409);
      await expect(prisma.withContext({ tenantId: C.tenantId }, (tx) => tx.taxRuleVersion.update({ where: { id: v }, data: { config: { taxes: { ICMS: { ratePct: 99 } } } } }))).rejects.toThrow(/imutável/);
      const acts = (await C.owner.get('/api/audit?limit=100').expect(200)).body.items.map((i: any) => i.action);
      expect(acts).toEqual(expect.arrayContaining(['tax_rule.created', 'tax_rule.submitted', 'tax_rule.approved']));
    });

    it('nova versão substitui a anterior sem reescrever o passado: cálculo na data antiga usa a versão antiga', async () => {
      const C = await setup('fisH');
      const created = (await C.users.fiscal.post('/api/fiscal/rules').set(H).send(rule()).expect(201)).body;
      await C.users.fiscal.post(`/api/fiscal/rules/versions/${created.versionId}/submit`).set(H).expect(200);
      await C.users.accountant.post(`/api/fiscal/rules/versions/${created.versionId}/approve`).set(H).expect(200);
      const v2 = (await C.users.fiscal.post(`/api/fiscal/rules/${created.ruleId}/versions`).set(H).send({ validFrom: '2026-07-01T00:00:00Z', sourceReference: 'Parecer contábil 20/2026 – simulado', config: { cfop: '6102', taxes: { ICMS: { csosn: '102', ratePct: 7 } } } }).expect(201)).body;
      await C.users.fiscal.post(`/api/fiscal/rules/${created.ruleId}/versions`).set(H).send({ validFrom: '2026-08-01T00:00:00Z', sourceReference: 'Parecer contábil 21/2026 – simulado', config: { taxes: { ICMS: { ratePct: 1 } } } }).expect(409); // já há rascunho
      await C.users.fiscal.post(`/api/fiscal/rules/versions/${v2.versionId}/submit`).set(H).expect(200);
      await C.users.accountant.post(`/api/fiscal/rules/versions/${v2.versionId}/approve`).set(H).expect(200);
      expect((await calc(C, { date: '2026-06-15' }).expect(200)).body.items[0].taxes.ICMS.amount).toBe(24); // 12% — versão 1
      expect((await calc(C, { date: '2026-07-15' }).expect(200)).body.items[0].taxes.ICMS.amount).toBe(14); // 7% — versão 2
      const versions = (await C.users.fiscal.get('/api/fiscal/rules').expect(200)).body[0].versions;
      expect(versions.map((x: any) => [x.version, x.status])).toEqual([[2, 'APPROVED'], [1, 'SUPERSEDED']]);
      expect(new Date(versions[1].validTo).getTime()).toBe(new Date('2026-07-01T00:00:00Z').getTime() - 1);
    });

    it('rejeição devolve ao rascunho; ST/DIFAL viram pendência; ambiguidade é detectada; desativar remove a regra', async () => {
      const C = await setup('fisI');
      const r1 = (await C.users.fiscal.post('/api/fiscal/rules').set(H).send(rule({ name: 'R1' })).expect(201)).body;
      await C.users.fiscal.post(`/api/fiscal/rules/versions/${r1.versionId}/submit`).set(H).expect(200);
      await C.users.accountant.post(`/api/fiscal/rules/versions/${r1.versionId}/reject`).set(H).send({ reason: 'faltou CST' }).expect(200);
      expect((await C.users.fiscal.get('/api/fiscal/rules').expect(200)).body[0].versions[0].status).toBe('DRAFT');
      await C.users.fiscal.post(`/api/fiscal/rules/versions/${r1.versionId}/submit`).set(H).expect(200);
      await C.users.accountant.post(`/api/fiscal/rules/versions/${r1.versionId}/approve`).set(H).expect(200);

      const st = rule({ name: 'ST', ncmPrefix: '7318' });
      st.version.config = { cfop: '6403', taxes: { ICMS_ST: { kind: 'ST', ratePct: 18 } } } as any;
      const r2 = (await C.users.fiscal.post('/api/fiscal/rules').set(H).send(st).expect(201)).body;
      await C.users.fiscal.post(`/api/fiscal/rules/versions/${r2.versionId}/submit`).set(H).expect(200);
      await C.users.accountant.post(`/api/fiscal/rules/versions/${r2.versionId}/approve`).set(H).expect(200);
      const r = (await calc(C).expect(200)).body;
      expect(r.pendencies.map((p: any) => p.code)).toContain('UNSUPPORTED_TAX');
      expect(r.ready).toBe(false);

      await C.users.fiscal.put(`/api/fiscal/rules/${r2.ruleId}/active`).set(H).send({ active: false }).expect(200);
      expect((await calc(C).expect(200)).body.ready).toBe(true);
      await C.users.fiscal.put(`/api/fiscal/rules/${r1.ruleId}/active`).set(H).send({ active: false }).expect(200);
      expect((await calc(C).expect(200)).body.pendencies[0].code).toBe('NO_RULE');
    });

    it('snapshot reprodutível (exige permissão de emissão) e isolamento das regras entre empresas', async () => {
      const C = await setup('fisJ');
      const c = (await C.users.fiscal.post('/api/fiscal/rules').set(H).send(rule()).expect(201)).body;
      await C.users.fiscal.post(`/api/fiscal/rules/versions/${c.versionId}/submit`).set(H).expect(200);
      await C.users.accountant.post(`/api/fiscal/rules/versions/${c.versionId}/approve`).set(H).expect(200);
      await calc(C, { persist: true }, C.users.accountant).expect(403);
      const first = (await calc(C, { persist: true }).expect(200)).body;
      const snap = await admin.taxCalculation.findUniqueOrThrow({ where: { id: first.calculationId } });
      expect(snap).toMatchObject({ engineVersion: '1.0.0', ruleVersionIds: [c.versionId], operation: 'SALE' });
      const again = (await calc(C).expect(200)).body;
      expect(again.items).toEqual(first.items);
      expect(again.totals).toEqual(first.totals);
      // outro tenant não enxerga as regras de C
      expect((await calc(B).expect(200)).body.pendencies[0].code).toBe('NO_RULE');
      await expect(prisma.withContext({ tenantId: C.tenantId }, (tx) => tx.taxCalculation.deleteMany({}))).rejects.toThrow(); // snapshot imutável
    });
  });

  // ───────────────────────── nota de saída ─────────────────────────
  describe('documento fiscal de saída: preparação e máquina de estados', () => {
    interface Ctx { t: T; orderId: string; docId?: string }

    /** Empresa pronta para emitir (cert + regra aprovada + dados completos) e um pedido confirmado. */
    async function ready(label: string, o: { withRule?: boolean; withCert?: boolean; customerOk?: boolean } = {}): Promise<Ctx> {
      const t = await setup(label);
      if (o.withCert !== false) await t.users.fiscal.post(`/api/fiscal/establishments/${t.est}/certificate`).set(H).send({ pfxBase64: makePfx({ cn: `EMPRESA:${EST_CNPJ}`, password: 'p' }), password: 'p' }).expect(201);
      if (o.withRule !== false) {
        const c = (await t.users.fiscal.post('/api/fiscal/rules').set(H).send({ rule: { name: 'Venda SP→RJ', operation: 'SALE', originUf: 'SP', destUf: 'RJ' }, version: { validFrom: '2026-01-01T00:00:00Z', sourceReference: 'Parecer contábil – simulado', config: { cfop: '6102', taxes: { ICMS: { csosn: '102', ratePct: 12 } } } } }).expect(201)).body;
        await t.users.fiscal.post(`/api/fiscal/rules/versions/${c.versionId}/submit`).set(H).expect(200);
        await t.users.accountant.post(`/api/fiscal/rules/versions/${c.versionId}/approve`).set(H).expect(200);
      }
      const cust = (await t.owner.post('/api/customers').set(H).send({
        kind: 'PJ', name: 'Cliente Fiscal', document: '04252011000110',
        ...(o.customerOk === false ? {} : { zipCode: '20000-000', street: 'Rua B', number: '2', city: 'Rio de Janeiro', state: 'RJ' }),
      }).expect(201)).body.id;
      const p = await product(t, {}, 50);
      const order = (await t.owner.post('/api/sales/orders').set(H).send({ customerId: cust, warehouseId: t.wh, items: [{ productId: p, quantity: 2, unitPrice: 50 }] }).expect(201)).body.id;
      await t.owner.post(`/api/sales/orders/${order}/submit`).set(H).expect(200);
      return { t, orderId: order };
    }
    const prepare = (c: Ctx, who: Agent = c.t.users.fiscal) => who.post('/api/fiscal/outgoing/prepare').set(H).send({ salesOrderId: c.orderId });
    const tx = (c: Ctx) => c.t.users.fiscal.post(`/api/fiscal/outgoing/${c.docId}/transmit`).set(H);
    const dbDoc = (c: Ctx) => admin.fiscalDocument.findUniqueOrThrow({ where: { id: c.docId! } });
    const series = async (t: T, env = 'HOMOLOGACAO') => (await admin.fiscalSeries.findFirst({ where: { tenantId: t.tenantId, environment: env } }))?.last ?? 0;
    async function prepared(label: string, o: Parameters<typeof ready>[1] = {}) {
      const c = await ready(label, o);
      c.docId = (await prepare(c).expect(200)).body.id;
      return c;
    }
    beforeEach(() => { provider.configured = true; provider.transmitBehavior = { kind: 'AUTHORIZED', protocol: '135260000000001', statusCode: '100' }; provider.consultBehavior = { kind: 'UNKNOWN' }; provider.delayMs = 0; provider.transmitted.length = 0; provider.consulted.length = 0; });

    it('prepara a nota a partir do pedido: pendências explícitas, idempotente por pedido, pedido em rascunho não fatura', async () => {
      const c = await ready('fisK', { withRule: false, withCert: false, customerOk: false });
      provider.configured = false;
      const r = (await prepare(c).expect(200)).body;
      expect(r).toMatchObject({ existing: false, status: 'PENDING_VALIDATION' });
      const codes = r.issues.map((i: any) => i.code);
      expect(codes).toEqual(expect.arrayContaining(['CUSTOMER_DATA', 'CERTIFICATE', 'TAX_MISSING_DATA', 'TAX_NO_RULE', 'PROVIDER_NOT_CONFIGURED']));
      expect((await prepare(c).expect(200)).body).toMatchObject({ existing: true, id: r.id });
      expect(await admin.fiscalDocument.count({ where: { tenantId: c.t.tenantId, salesOrderId: c.orderId } })).toBe(1);
      const draft = (await c.t.owner.post('/api/sales/orders').set(H).send({ customerId: (await c.t.owner.get('/api/customers')).body[0].id, warehouseId: c.t.wh, items: [{ productId: (await product(c.t)), quantity: 1 }] }).expect(201)).body.id;
      await c.t.users.fiscal.post('/api/fiscal/outgoing/prepare').set(H).send({ salesOrderId: draft }).expect(409);
      await prepare(c, c.t.users.ops_manager).expect(403);
      await B.users.fiscal.post('/api/fiscal/outgoing/prepare').set(H).send({ salesOrderId: c.orderId }).expect(404);
    });

    it('completando os dados e regras, a nota fica pronta, com impostos e CFOP do motor e retrato do cálculo; sem provedor NÃO transmite nem consome numeração', async () => {
      const c = await prepared('fisL');
      const d = (await c.t.users.fiscal.get(`/api/fiscal/outgoing/${c.docId}`).expect(200)).body;
      expect(d.status).toBe('READY_TO_TRANSMIT');
      expect(d.items[0]).toMatchObject({ cfop: '6102', ncm: '73181500' });
      expect(d.items[0].declaredTax.taxes.ICMS).toMatchObject({ base: 100, ratePct: 12, amount: 12 });
      expect(d.calculation).toMatchObject({ engineVersion: '1.0.0' });
      expect(d.number).toBeNull();
      provider.configured = false;
      const r = await tx(c).expect(424);
      expect(r.body.code).toBe('NOT_CONFIGURED');
      expect(await dbDoc(c)).toMatchObject({ status: 'READY_TO_TRANSMIT', number: null, accessKey: null });
      expect(await series(c.t)).toBe(0);
      expect(provider.transmitted).toHaveLength(0);
    });

    it('transmissão autorizada: numeração sequencial atômica, chave válida e consistente, não reautoriza', async () => {
      const c1 = await prepared('fisM');
      const r = (await tx(c1).expect(200)).body;
      expect(r.status).toBe('AUTHORIZED');
      const doc = await dbDoc(c1);
      expect(doc).toMatchObject({ number: 1, series: 1, authProtocol: '135260000000001', status: 'AUTHORIZED' });
      expect(isValidChave(doc.accessKey!)).toBe(true);
      expect(parseChave(doc.accessKey!)).toMatchObject({ uf: 'SP', cnpj: EST_CNPJ, model: '55', series: 1, number: 1 });
      await tx(c1).expect(409);
      expect(provider.transmitted).toEqual([doc.accessKey]);
      // segundo documento da mesma empresa recebe o próximo número
      const o2 = await (async () => {
        const p = await product(c1.t, {}, 5);
        const cust = (await c1.t.owner.get('/api/customers')).body[0].id;
        const id = (await c1.t.owner.post('/api/sales/orders').set(H).send({ customerId: cust, warehouseId: c1.t.wh, items: [{ productId: p, quantity: 1, unitPrice: 20 }] }).expect(201)).body.id;
        await c1.t.owner.post(`/api/sales/orders/${id}/submit`).set(H).expect(200);
        return id;
      })();
      const c2: Ctx = { t: c1.t, orderId: o2 };
      c2.docId = (await prepare(c2).expect(200)).body.id;
      await tx(c2).expect(200);
      expect((await dbDoc(c2)).number).toBe(2);
      expect(await series(c1.t)).toBe(2);
    });

    it('cliques/chamadas simultâneas não emitem duas vezes nem consomem dois números', async () => {
      const c = await prepared('fisN');
      provider.delayMs = 120;
      const rs = await Promise.all([1, 2, 3, 4].map(() => tx(c)));
      expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 409)).toHaveLength(3);
      expect(provider.transmitted).toHaveLength(1);
      expect(await series(c.t)).toBe(1);
      expect((await dbDoc(c)).status).toBe('AUTHORIZED');
    });

    it('TIMEOUT: não retransmite (só consulta), a consulta resolve sem novo número; NOT_FOUND libera reenvio com a MESMA numeração', async () => {
      const c = await prepared('fisO');
      provider.transmitBehavior = { kind: 'TIMEOUT' };
      expect((await tx(c).expect(200)).body.status).toBe('PENDING_CONSULT');
      const sent = await dbDoc(c);
      const resp = await tx(c).expect(409);
      expect(resp.body.message).toMatch(/Consultar situação/);
      expect(provider.transmitted).toHaveLength(1);

      provider.consultBehavior = { kind: 'UNKNOWN' };
      expect((await c.t.users.fiscal.post(`/api/fiscal/outgoing/${c.docId}/consult`).set(H).expect(200)).body.status).toBe('PENDING_CONSULT');
      provider.consultBehavior = { kind: 'NOT_FOUND' };
      expect((await c.t.users.fiscal.post(`/api/fiscal/outgoing/${c.docId}/consult`).set(H).expect(200)).body.status).toBe('READY_TO_TRANSMIT');
      provider.transmitBehavior = { kind: 'AUTHORIZED', protocol: '135260000000777', statusCode: '100' };
      await tx(c).expect(200);
      const final = await dbDoc(c);
      expect(final).toMatchObject({ status: 'AUTHORIZED', number: sent.number, accessKey: sent.accessKey });
      expect(await series(c.t)).toBe(1); // um único número consumido
      expect(provider.transmitted).toEqual([sent.accessKey, sent.accessKey]);
    });

    it('exceção do provedor após o envio é tratada como resposta desconhecida; consulta autoriza sem reenviar', async () => {
      const c = await prepared('fisP');
      provider.transmitBehavior = 'THROW';
      expect((await tx(c).expect(200)).body.status).toBe('PENDING_CONSULT');
      provider.consultBehavior = { kind: 'AUTHORIZED', protocol: '135260000000888', statusCode: '100' };
      expect((await c.t.users.fiscal.post(`/api/fiscal/outgoing/${c.docId}/consult`).set(H).expect(200)).body.status).toBe('AUTHORIZED');
      expect(provider.transmitted).toHaveLength(1);
      expect(await dbDoc(c)).toMatchObject({ authProtocol: '135260000000888', authenticity: 'VERIFIED' });
      await c.t.users.fiscal.post(`/api/fiscal/outgoing/${c.docId}/consult`).set(H).expect(409);
    });

    it('rejeição exige correção e revalidação; reenvio mantém a numeração. Indisponibilidade permite nova tentativa', async () => {
      const c = await prepared('fisQ');
      provider.transmitBehavior = { kind: 'REJECTED', statusCode: '539', reason: 'Duplicidade de NF-e' };
      expect((await tx(c).expect(200)).body.status).toBe('REJECTED');
      const doc = await dbDoc(c);
      expect(JSON.stringify(doc.issues)).toMatch(/Rejeição 539/);
      await tx(c).expect(409); // corrigir e revalidar primeiro
      expect((await c.t.users.fiscal.post(`/api/fiscal/outgoing/${c.docId}/revalidate`).set(H).expect(200)).body.status).toBe('READY_TO_TRANSMIT');
      provider.transmitBehavior = { kind: 'UNAVAILABLE', reason: 'SEFAZ fora do ar' };
      expect((await tx(c).expect(200)).body.status).toBe('COMMUNICATION_FAILURE');
      provider.transmitBehavior = { kind: 'AUTHORIZED', protocol: '135260000000999', statusCode: '100' };
      expect((await tx(c).expect(200)).body.status).toBe('AUTHORIZED');
      expect((await dbDoc(c)).number).toBe(doc.number);
      expect(await series(c.t)).toBe(1);
    });

    it('produção exige configuração validada pelo contador; certificado vencido e dados quebrados bloqueiam antes de consumir número', async () => {
      const c = await prepared('fisR');
      await c.t.users.fiscal.put(`/api/fiscal/establishments/${c.t.est}/config`).set(H).send({ environment: 'PRODUCAO', accountantName: 'Contadora', accountantEmail: 'c@contabil.test' }).expect(200);
      const reval = (await c.t.users.fiscal.post(`/api/fiscal/outgoing/${c.docId}/revalidate`).set(H).expect(200)).body;
      expect(reval.status).toBe('PENDING_VALIDATION');
      expect(reval.issues.map((i: any) => i.code)).toContain('CONFIG_NOT_APPROVED');
      await tx(c).expect(409);
      await c.t.users.fiscal.post(`/api/fiscal/establishments/${c.t.est}/config/submit`).set(H).expect(200);
      await c.t.users.accountant.post(`/api/fiscal/establishments/${c.t.est}/config/approve`).set(H).expect(200);
      expect((await c.t.users.fiscal.post(`/api/fiscal/outgoing/${c.docId}/revalidate`).set(H).expect(200)).body.status).toBe('READY_TO_TRANSMIT');
      // o certificado vence entre a validação e a transmissão
      await admin.fiscalCertificate.updateMany({ where: { tenantId: c.t.tenantId, status: 'ACTIVE' }, data: { notAfter: new Date(Date.now() - 1000) } });
      const r = await tx(c).expect(409);
      expect(JSON.stringify(r.body.issues)).toMatch(/vencido/);
      expect(await series(c.t, 'PRODUCAO')).toBe(0);
      expect(provider.transmitted).toHaveLength(0);
    });

    it('listagens, indicadores e isolamento da saída', async () => {
      const c = await prepared('fisS');
      await tx(c).expect(200);
      const list = (await c.t.users.fiscal.get('/api/fiscal/outgoing?status=AUTHORIZED').expect(200)).body;
      expect(list.map((d: any) => d.id)).toContain(c.docId);
      await B.users.fiscal.get(`/api/fiscal/outgoing/${c.docId}`).expect(404);
      await B.users.fiscal.post(`/api/fiscal/outgoing/${c.docId}/transmit`).set(H).expect(404);
      await B.users.fiscal.post(`/api/fiscal/outgoing/${c.docId}/consult`).set(H).expect(409).catch(() => undefined);
      const m = (await c.t.users.fiscal.get('/api/fiscal/metrics').expect(200)).body;
      expect(m).toMatchObject({ xmlAwaitingReceipt: 0, outgoingReady: 0 });
      const trail = (await c.t.owner.get('/api/audit?limit=100').expect(200)).body.items.map((i: any) => i.action);
      expect(trail).toEqual(expect.arrayContaining(['fiscal.outgoing_prepared', 'fiscal.transmit_started', 'fiscal.transmit_result']));
    });
  });
});
