import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';
import { SandboxConnector } from '../src/integrations/providers';
import { buildItemBody, MercadoLivreConnector, normalizeItem } from '../src/integrations/mercado-livre.connector';
import { downloadChannelImage, isPrivateAddress } from '../src/integrations/image-download';

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);
let seq = 0;
const uid = () => `${run}${++seq}`;

function png(w: number, h: number, size = 400) {
  const b = Buffer.alloc(size, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}
const b64 = (b: Buffer) => b.toString('base64');
/** GTIN-13 válido e único por chamada (o código de barras é único por tenant). */
let gtinSeq = 0;
const gtin = () => {
  const base = `789${String(Date.now() % 1e6).padStart(6, '0')}${String(++gtinSeq).padStart(3, '0')}`;
  const sum = base.split('').reduce((a, d, i) => a + Number(d) * (i % 2 ? 3 : 1), 0);
  return base + ((10 - (sum % 10)) % 10);
};
const stateOf = (url: string) => new URL(url).searchParams.get('state')!;

/** Servidores SIMULADOS (teste): a loja de fotos do "canal" e a API do Mercado Livre. Provam o nosso código, não o comportamento real do canal. */
describe('Produtos nos dois sentidos: importar do canal e publicar no canal', () => {
  let app: INestApplication;
  let imgServer: Server;
  let imgBase = '';
  const agent = () => request.agent(app.getHttpServer());
  type Agent = ReturnType<typeof agent>;
  interface T { owner: Agent; tenantId: string; wh: string; roles: Record<string, string> }
  let A: T; let B: T; let sales: Agent;

  async function setup(label: string): Promise<T> {
    const owner = agent();
    const reg = await owner.post('/api/auth/register').set(H).send({ companyName: `Co ${label} ${run}`, name: `Dono ${label}`, email: `${label}-${run}@teste.local`, password: PASSWORD }).expect(201);
    const company = await owner.post('/api/companies').set(H).send({ legalName: `${label} LTDA` }).expect(201);
    const est = await owner.post('/api/establishments').set(H).send({ companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz' }).expect(201);
    const wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
    const roles = Object.fromEntries((await owner.get('/api/roles').expect(200)).body.map((r: any) => [r.key, r.id]));
    return { owner, tenantId: reg.body.tenantId, wh, roles };
  }

  /** Conexão SANDBOX ativa, com catálogo/comportamento simulados em `config.sandbox`. */
  async function sandbox(t: T, sbx: object = {}) {
    const id = (await t.owner.post('/api/integrations/connections').set(H).send({ provider: 'SANDBOX', label: `sbx ${uid()}` }).expect(201)).body.id as string;
    await t.owner.put(`/api/integrations/connections/${id}/config`).set(H).send({ warehouseId: t.wh, stockSync: true, priceSync: true, sandbox: sbx }).expect(200);
    const auth = (await t.owner.post(`/api/integrations/connections/${id}/authorize`).set(H).expect(200)).body;
    await request(app.getHttpServer()).get(`/api/integrations/callback?code=sandbox-code&state=${encodeURIComponent(stateOf(auth.authorizationUrl))}`).expect(302);
    await t.owner.post(`/api/integrations/connections/${id}/test`).set(H).expect(200);
    await t.owner.post(`/api/integrations/connections/${id}/activate`).set(H).expect(200);
    return id;
  }
  const items = async (t: T, conn: string, qs = '') => (await t.owner.get(`/api/integrations/connections/${conn}/catalog/items${qs}`).expect(200)).body as { counts: Record<string, number>; items: any[] };
  const product = async (t: T, extra: object = {}) => (await t.owner.post('/api/products').set(H).send({ sku: `CP-${uid()}`, name: 'Produto de teste', ...extra }).expect(201)).body.id as string;

  beforeAll(async () => {
    imgServer = createServer((req, res) => {
      if (req.url!.startsWith('/ok')) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png(800, 800)); }
      else if (req.url!.startsWith('/small')) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png(300, 300)); }
      else if (req.url!.startsWith('/redirect')) { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }); res.end(); }
      else if (req.url!.startsWith('/html')) { res.writeHead(200, { 'content-type': 'image/png' }); res.end('<html>'.padEnd(300, 'x')); }
      else { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => imgServer.listen(0, '127.0.0.1', r));
    imgBase = `http://127.0.0.1:${(imgServer.address() as { port: number }).port}`;
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    A = await setup('cpA');
    B = await setup('cpB');
    const roles = A.roles;
    const email = `cpS-${run}@teste.local`;
    await A.owner.post('/api/users').set(H).send({ name: 'Vendedor', email, password: PASSWORD, roleId: roles.salesperson }).expect(201);
    sales = agent();
    await sales.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200);
  });
  afterAll(async () => { await app.close(); await new Promise((r) => imgServer.close(r)); });

  // ───────────────────────── canal → base ─────────────────────────
  describe('importar do canal para a base', () => {
    it('varre o catálogo em várias páginas, casa por SKU/GTIN e é idempotente', async () => {
      const bySku = await product(A, { sku: 'SKU-EXISTE', name: 'Já cadastrado' });
      const g1 = gtin();
      const byGtin = await product(A, { barcode: g1, sku: `G-${uid()}` });
      const catalog = [
        { externalId: 'MLB1', title: 'Item novo um', sku: 'NOVO-1', price: 10.5, quantity: 3 },
        { externalId: 'MLB2', title: 'Item com SKU existente', sku: 'sku-existe', price: 20 }, // casa ignorando maiúsculas
        { externalId: 'MLB3', title: 'Item com GTIN existente', gtin: g1, price: 30 },
        { externalId: 'MLB4', title: 'Item sem SKU', price: 40 },
        { externalId: 'MLB5', title: 'Item cinco', sku: 'NOVO-5', price: 50 },
      ];
      const conn = await sandbox(A, { catalog, pageSize: 2 });
      const r = (await A.owner.post(`/api/integrations/connections/${conn}/catalog/scan`).set(H).send({}).expect(201)).body;
      expect(r).toMatchObject({ scanned: 5, created: 5, matched: 2, nextCursor: null });
      const l = await items(A, conn);
      expect(l.counts).toEqual({ NEW: 5 });
      const m2 = l.items.find((i) => i.externalId === 'MLB2');
      expect(m2).toMatchObject({ matchedBy: 'SKU', status: 'NEW' });
      expect(m2.product.id).toBe(bySku);
      expect(l.items.find((i) => i.externalId === 'MLB3')).toMatchObject({ matchedBy: 'GTIN' });
      expect(l.items.find((i) => i.externalId === 'MLB3').product.id).toBe(byGtin);
      const again = (await A.owner.post(`/api/integrations/connections/${conn}/catalog/scan`).set(H).send({}).expect(201)).body;
      expect(again).toMatchObject({ scanned: 5, created: 0, updated: 5 });
      expect((await items(A, conn, '?q=cinco')).items).toHaveLength(1);
    });

    it('importa o anúncio como produto novo, com descrição, ficha técnica e fotos, e deixa tudo vinculado', async () => {
      const g2 = gtin();
      const catalog = [{
        externalId: 'MLB100', title: 'Parafuso Sextavado M8 Aço Zincado', sku: `IMP-${uid()}`, gtin: g2, brand: 'Acme', model: 'PS-8', price: 3.9, quantity: 100, condition: 'USED',
        description: 'Descrição completa vinda do canal.', attributes: [{ name: 'Cor', value: 'Prata' }, { name: 'Material', value: 'Aço' }],
        pictures: [`${imgBase}/ok/1.png`, `${imgBase}/ok/2.png`, `${imgBase}/small/3.png`],
      }];
      const conn = await sandbox(A, { catalog });
      await A.owner.post(`/api/integrations/connections/${conn}/catalog/scan`).set(H).send({}).expect(201);
      const item = (await items(A, conn)).items[0];
      expect(item.pictureCount).toBe(3);
      const r = (await A.owner.post(`/api/integrations/connections/${conn}/catalog/items/${item.id}/import`).set(H).expect(201)).body;
      expect(r.warnings).toEqual([]);
      const p = (await A.owner.get(`/api/products/${r.productId}`).expect(200)).body;
      expect(p).toMatchObject({ name: catalog[0].title, title: catalog[0].title, brand: 'Acme', model: 'PS-8', barcode: g2, description: 'Descrição completa vinda do canal.', condition: 'USED', suggestedPrice: '3.9' });
      expect(p.attributes).toEqual([{ name: 'Cor', value: 'Prata' }, { name: 'Material', value: 'Aço' }]);
      const imgs = (await A.owner.get(`/api/products/${r.productId}/images`).expect(200)).body as any[];
      expect(imgs).toHaveLength(3);
      expect(imgs[0]).toMatchObject({ main: true, width: 800, height: 800 });
      expect(imgs[0].sourceUrl).toContain('/ok/1.png');
      const lst = (await A.owner.get(`/api/integrations/connections/${conn}/listings`).expect(200)).body as any[];
      expect(lst.find((x) => x.productId === r.productId)).toMatchObject({ externalItemId: 'MLB100', status: 'LINKED', price: 3.9 });
      expect((await items(A, conn)).items[0]).toMatchObject({ status: 'IMPORTED' });
      await A.owner.post(`/api/integrations/connections/${conn}/catalog/items/${item.id}/import`).set(H).expect(409); // não importa duas vezes
      expect(((await A.owner.get('/api/audit?action=channel_item.imported&limit=5').expect(200)).body.items as any[]).length).toBeGreaterThan(0);
    });

    it('conflito de SKU/GTIN pede vínculo; vincular liga o anúncio ao produto existente e não duplica', async () => {
      const existing = await product(A, { sku: 'LIGAR-1', name: 'Produto que já existe' });
      const conn = await sandbox(A, { catalog: [{ externalId: 'MLB200', title: 'Mesmo produto no canal', sku: 'LIGAR-1', price: 12 }] });
      await A.owner.post(`/api/integrations/connections/${conn}/catalog/scan`).set(H).send({}).expect(201);
      const item = (await items(A, conn)).items[0];
      const clash = await A.owner.post(`/api/integrations/connections/${conn}/catalog/items/${item.id}/import`).set(H).expect(409);
      expect(clash.body.message).toMatch(/Vincule/);
      expect(clash.body.productId).toBe(existing);
      await A.owner.post(`/api/integrations/connections/${conn}/catalog/items/${item.id}/link`).set(H).send({ productId: existing }).expect(201);
      expect((await items(A, conn)).items[0]).toMatchObject({ status: 'LINKED', matchedBy: 'MANUAL' });
      const lst = (await A.owner.get(`/api/integrations/connections/${conn}/listings`).expect(200)).body as any[];
      expect(lst.find((x) => x.productId === existing)).toMatchObject({ externalItemId: 'MLB200', status: 'LINKED', price: 12 });
      await A.owner.post(`/api/integrations/connections/${conn}/catalog/items/${item.id}/link`).set(H).send({ productId: existing }).expect(409);
      // varrer de novo não desfaz o vínculo
      await A.owner.post(`/api/integrations/connections/${conn}/catalog/scan`).set(H).send({}).expect(201);
      expect((await items(A, conn)).items[0].status).toBe('LINKED');
    });

    it('fotos perigosas ou inválidas não entram (domínio, redirecionamento, HTML disfarçado) e o produto ainda é criado com aviso', async () => {
      const catalog = [{ externalId: 'MLB300', title: 'Produto com fotos ruins', sku: `FR-${uid()}`, pictures: ['https://exemplo-malicioso.test/x.png', `${imgBase}/redirect/a.png`, `${imgBase}/html/b.png`, `${imgBase}/404/c.png`, `${imgBase}/ok/d.png`] }];
      const conn = await sandbox(A, { catalog });
      await A.owner.post(`/api/integrations/connections/${conn}/catalog/scan`).set(H).send({}).expect(201);
      const item = (await items(A, conn)).items[0];
      const r = (await A.owner.post(`/api/integrations/connections/${conn}/catalog/items/${item.id}/import`).set(H).expect(201)).body;
      expect(r.warnings).toHaveLength(4);
      expect(r.warnings.join(' ')).toMatch(/domínio da foto não permitido/);
      expect(((await A.owner.get(`/api/products/${r.productId}/images`).expect(200)).body as any[])).toHaveLength(1);
    });

    it('importar todos os novos: aproveita o que dá, informa o que falhou e não mexe nos que já têm correspondência', async () => {
      await product(A, { sku: 'EM-LOTE-2' });
      const catalog = [
        { externalId: 'L1', title: 'Lote um', sku: `LT-${uid()}`, price: 1 },
        { externalId: 'L2', title: 'Lote dois (SKU existe)', sku: 'EM-LOTE-2', price: 2 },
        { externalId: 'L3', title: 'Lote três', sku: `LT-${uid()}`, price: 3 },
      ];
      const conn = await sandbox(A, { catalog });
      await A.owner.post(`/api/integrations/connections/${conn}/catalog/scan`).set(H).send({}).expect(201);
      const r = (await A.owner.post(`/api/integrations/connections/${conn}/catalog/import-new`).set(H).expect(201)).body;
      expect(r).toMatchObject({ processed: 2, imported: 2, failed: 0 }); // L2 tem correspondência: fica para decisão manual
      const l = await items(A, conn);
      expect(l.counts).toEqual({ IMPORTED: 2, NEW: 1 });
      expect(l.items.find((i) => i.externalId === 'L2').status).toBe('NEW');
    });

    it('ignorar e reativar; falha do canal vira erro claro; leitura exige permissão; tenants isolados', async () => {
      const conn = await sandbox(A, { catalog: [{ externalId: 'IG1', title: 'Item para ignorar', sku: `IG-${uid()}` }] });
      await A.owner.post(`/api/integrations/connections/${conn}/catalog/scan`).set(H).send({}).expect(201);
      const id = (await items(A, conn)).items[0].id;
      await A.owner.post(`/api/integrations/connections/${conn}/catalog/items/${id}/ignore`).set(H).send({ ignore: true }).expect(201);
      expect((await items(A, conn, '?status=IGNORED')).items).toHaveLength(1);
      await A.owner.post(`/api/integrations/connections/${conn}/catalog/items/${id}/ignore`).set(H).send({ ignore: false }).expect(201);
      expect((await items(A, conn)).items[0].status).toBe('NEW');

      const bad = await sandbox(A, { catalogError: 'unavailable' });
      const e = await A.owner.post(`/api/integrations/connections/${bad}/catalog/scan`).set(H).send({}).expect(502);
      expect(e.body.code).toBe('UNAVAILABLE');

      await sales.post(`/api/integrations/connections/${conn}/catalog/scan`).set(H).send({}).expect(403);
      await sales.post(`/api/integrations/connections/${conn}/catalog/items/${id}/import`).set(H).expect(403);
      await B.owner.get(`/api/integrations/connections/${conn}/catalog/items`).expect(404);
      await B.owner.post(`/api/integrations/connections/${conn}/catalog/scan`).set(H).send({}).expect(404);
      await B.owner.post(`/api/integrations/connections/${conn}/catalog/items/${id}/import`).set(H).expect(404);
    });

    it('canal que ainda não lê catálogo (Amazon, planejado) devolve 501 explícito', async () => {
      const id = (await A.owner.post('/api/integrations/connections').set(H).send({ provider: 'AMAZON', label: `amz ${uid()}` }).expect(201)).body.id;
      // não conectada: a chamada nem sai do servidor
      const r = await A.owner.post(`/api/integrations/connections/${id}/catalog/scan`).set(H).send({}).expect((res) => { if (![424, 501].includes(res.status)) throw new Error(`status ${res.status}`); });
      expect(r.body.code).toMatch(/NOT_CONFIGURED|NOT_IMPLEMENTED/);
    });
  });

  // ───────────────────────── base → canal ─────────────────────────
  describe('publicar no canal a partir do cadastro', () => {
    async function readyProduct(t: T, conn: string, extra: object = {}) {
      const cat = (await t.owner.post('/api/categories').set(H).send({ name: `Cat ${uid()}` }).expect(201)).body.id as string;
      const id = await product(t, { name: 'Parafuso sextavado M8 x 40 aço zincado', title: 'Parafuso Sextavado M8 x 40 Aço Zincado', brand: 'Acme', model: 'PS-840', barcode: gtin(), suggestedPrice: 3.9, categoryId: cat, description: 'Descrição do produto para o anúncio.', condition: 'NEW', warrantyMonths: 3, attributes: [{ name: 'Material', value: 'Aço' }], grossWeightG: 20, heightMm: 10, widthMm: 10, lengthMm: 40, ...extra });
      await t.owner.put(`/api/integrations/connections/${conn}/category-map`).set(H).send({ categoryId: cat, externalCategoryId: 'MLB-1234', externalCategoryName: 'Parafusos' }).expect(200);
      await t.owner.post('/api/stock/movements').set(H).send({ productId: id, warehouseId: t.wh, type: 'PURCHASE_ENTRY', quantity: 50 }).expect(201);
      await t.owner.post(`/api/products/${id}/images`).set(H).send({ contentType: 'image/png', contentBase64: b64(png(1000, 1000)) }).expect(201);
      await t.owner.post(`/api/products/${id}/images`).set(H).send({ contentType: 'image/png', contentBase64: b64(png(800, 800, 500)) }).expect(201);
      return id;
    }
    const preview = (t: T, id: string, conn: string) => t.owner.post(`/api/products/${id}/channels/${conn}/preview`).set(H);
    const publish = (t: T, id: string, conn: string, who: Agent = t.owner) => who.post(`/api/products/${id}/channels/${conn}/publish`).set(H);

    it('pré-visualiza o anúncio completo e publica; o canal recebe fotos por URL assinada, na ordem, e o vínculo fica gravado', async () => {
      const conn = await sandbox(A);
      const id = await readyProduct(A, conn);
      const pv = (await preview(A, id, conn).expect(201)).body;
      expect(pv.problems).toEqual([]);
      expect(pv.canPublish).toBe(true);
      expect(pv.draft).toMatchObject({ title: 'Parafuso Sextavado M8 x 40 Aço Zincado', price: 3.9, quantity: 50, brand: 'Acme', gtin: expect.stringMatching(/^789\d{10}$/), categoryId: 'MLB-1234', warrantyMonths: 3 });
      expect(pv.draft.pictures).toHaveLength(2);
      const before = SandboxConnector.published.length;
      const r = (await publish(A, id, conn).expect(201)).body;
      expect(r.externalItemId).toMatch(/^SBX-L-/);
      expect(SandboxConnector.published.length).toBe(before + 1);
      const sent = SandboxConnector.published.at(-1)!.draft;
      expect(sent.pictures.map((p) => p.width)).toEqual([1000, 800]);
      expect(sent.pictures[0].url).toMatch(/\/api\/media\/[0-9a-f-]{36}\?e=\d+&s=/);
      const pic = await agent().get(new URL(sent.pictures[0].url).pathname + new URL(sent.pictures[0].url).search).expect(200); // o canal consegue baixar a foto
      expect(pic.headers['content-type']).toBe('image/png');
      const lst = (await A.owner.get(`/api/integrations/connections/${conn}/listings`).expect(200)).body as any[];
      expect(lst.find((x) => x.productId === id)).toMatchObject({ externalItemId: r.externalItemId, status: 'LINKED', price: 3.9, lastPublishedQty: 50, syncStatus: 'OK' });
      const ch = (await A.owner.get(`/api/products/${id}/channels`).expect(200)).body.find((c: any) => c.connectionId === conn);
      expect(ch).toMatchObject({ canPublish: true, listing: { externalItemId: r.externalItemId } });
      expect((await items(A, conn)).items.find((i) => i.externalId === r.externalItemId)).toMatchObject({ status: 'LINKED' });
      await publish(A, id, conn).expect(422); // já publicado
      expect(((await A.owner.get('/api/audit?action=channel_listing.published&limit=5').expect(200)).body.items as any[]).length).toBeGreaterThan(0);
    });

    it('bloqueia com a lista do que falta: sem foto, sem categoria do canal, sem preço, título longo demais', async () => {
      const conn = await sandbox(A);
      const bare = await product(A, { name: 'Produto sem nada' });
      const pv = (await preview(A, bare, conn).expect(201)).body;
      expect(pv.canPublish).toBe(false);
      expect(pv.problems.join(' ')).toMatch(/preço/);
      expect(pv.problems.join(' ')).toMatch(/foto/);
      expect(pv.problems.join(' ')).toMatch(/categoria do canal/);
      expect(pv.warnings.join(' ')).toMatch(/marca/);
      const r = await publish(A, bare, conn).expect(422);
      expect(r.body.problems.length).toBeGreaterThanOrEqual(3);

      const long = await readyProduct(A, conn, { title: 'T'.repeat(80) });
      expect((await preview(A, long, conn).expect(201)).body.problems.join(' ')).toMatch(/60 caracteres/);
    });

    it('recusa do canal vira erro claro e marca o anúncio com erro; depois de corrigir, publica; resultado incerto orienta a localizar antes de repetir', async () => {
      const conn = await sandbox(A, { publish: 'validation' });
      const id = await readyProduct(A, conn);
      const bad = await publish(A, id, conn).expect(400);
      expect(bad.body.message).toMatch(/categoria inválida/);
      let l = ((await A.owner.get(`/api/integrations/connections/${conn}/listings`).expect(200)).body as any[]).find((x) => x.productId === id);
      expect(l).toMatchObject({ syncStatus: 'ERROR', externalItemId: null });
      await A.owner.put(`/api/integrations/connections/${conn}/config`).set(H).send({ sandbox: { publish: 'unavailable' } }).expect(200);
      const unc = await publish(A, id, conn).expect(502);
      expect(unc.body.message).toMatch(/Importar do canal/);
      await A.owner.put(`/api/integrations/connections/${conn}/config`).set(H).send({ sandbox: {} }).expect(200);
      await publish(A, id, conn).expect(201);
      l = ((await A.owner.get(`/api/integrations/connections/${conn}/listings`).expect(200)).body as any[]).find((x) => x.productId === id);
      expect(l).toMatchObject({ status: 'LINKED', syncStatus: 'OK' });
    });

    it('publicações simultâneas do mesmo produto no mesmo canal: só uma cria o anúncio', async () => {
      const conn = await sandbox(A);
      const id = await readyProduct(A, conn);
      const before = SandboxConnector.published.length;
      const res = await Promise.all([publish(A, id, conn), publish(A, id, conn), publish(A, id, conn)]);
      expect(res.filter((r) => r.status === 201)).toHaveLength(1);
      expect(res.filter((r) => r.status !== 201).every((r) => [409, 422].includes(r.status))).toBe(true);
      expect(SandboxConnector.published.length).toBe(before + 1);
    });

    it('permissão, isolamento e canal sem publicação', async () => {
      const conn = await sandbox(A);
      const id = await readyProduct(A, conn);
      await publish(A, id, conn, sales).expect(403);
      await B.owner.post(`/api/products/${id}/channels/${conn}/preview`).set(H).expect(404);
      await publish(B, id, conn).expect(404);
      await B.owner.get(`/api/products/${id}/channels`).expect(404);
      const amz = (await A.owner.post('/api/integrations/connections').set(H).send({ provider: 'AMAZON', label: `amz ${uid()}` }).expect(201)).body.id;
      const pv = (await preview(A, id, amz).expect(201)).body;
      expect(pv.canPublish).toBe(false);
      expect(pv.problems.join(' ')).toMatch(/ainda não permite publicar/);
      const ch = (await A.owner.get(`/api/products/${id}/channels`).expect(200)).body.find((c: any) => c.connectionId === amz);
      expect(ch.canPublish).toBe(false);
    });
  });

  // ───────────────────────── SSRF e Mercado Livre (simulado) ─────────────────────────
  describe('defesas e conector do Mercado Livre', () => {
    it('downloadChannelImage recusa domínio fora da lista, HTTP, credenciais na URL e redirecionamento', async () => {
      await expect(downloadChannelImage('https://evil.test/a.png', ['mlstatic.com'])).rejects.toThrow(/não permitido/);
      await expect(downloadChannelImage('http://http2.mlstatic.com/a.png', ['mlstatic.com'])).rejects.toThrow(/HTTPS/);
      await expect(downloadChannelImage('https://user:pw@http2.mlstatic.com/a.png', ['mlstatic.com'])).rejects.toThrow(/credenciais/);
      await expect(downloadChannelImage('https://mlstatic.com.evil.test/a.png', ['mlstatic.com'])).rejects.toThrow(/não permitido/);
      await expect(downloadChannelImage(`${imgBase}/redirect/x.png`, ['127.0.0.1'])).rejects.toThrow(/302/);
      expect((await downloadChannelImage(`${imgBase}/ok/x.png`, ['127.0.0.1'])).length).toBe(400);
      expect(['127.0.0.1', '10.1.2.3', '192.168.0.9', '169.254.169.254', '172.20.0.1', '100.64.0.1', '::1', 'fd00::1'].every(isPrivateAddress)).toBe(true);
      expect(['8.8.8.8', '200.147.67.142', '2606:4700::1111'].some(isPrivateAddress)).toBe(false);
    });

    it('normaliza anúncio do ML e monta o corpo do POST /items com SKU, marca, GTIN, fotos e garantia', () => {
      const item = normalizeItem({
        id: 'MLB123', title: 'Parafuso M8', price: 3.9, available_quantity: 7, condition: 'new', status: 'active', permalink: 'https://produto.mercadolivre.com.br/MLB-123', category_id: 'MLB1234', seller_custom_field: 'SKU-9',
        pictures: [{ secure_url: 'https://http2.mlstatic.com/D_1.jpg' }, { url: 'http://http2.mlstatic.com/D_2.jpg' }],
        attributes: [{ id: 'BRAND', name: 'Marca', value_name: 'Acme' }, { id: 'GTIN', name: 'GTIN', value_name: '7891234567895' }, { id: 'COLOR', name: 'Cor', value_name: 'Prata' }, { id: 'MODEL', name: 'Modelo', value_name: 'PS-8' }],
      })!;
      expect(item).toMatchObject({ externalId: 'MLB123', sku: 'SKU-9', gtin: '7891234567895', brand: 'Acme', model: 'PS-8', price: 3.9, quantity: 7, condition: 'NEW', categoryId: 'MLB1234' });
      expect(item.pictures).toEqual(['https://http2.mlstatic.com/D_1.jpg', 'http://http2.mlstatic.com/D_2.jpg']);
      expect(item.attributes).toEqual([{ name: 'Cor', value: 'Prata' }]);
      expect(normalizeItem({ id: 'X' })).toBeNull();
      const body = buildItemBody({ sku: 'SKU-9', title: 'Parafuso M8', description: 'Texto', price: 3.9, quantity: 7, condition: 'USED', brand: 'Acme', gtin: '7891234567895', warrantyMonths: 3, categoryId: 'MLB1234', attributes: [{ name: 'Cor', value: 'Prata' }], pictures: [{ url: 'https://x/1', width: 1000, height: 1000 }] }) as any;
      expect(body).toMatchObject({ title: 'Parafuso M8', category_id: 'MLB1234', price: 3.9, currency_id: 'BRL', available_quantity: 7, condition: 'used', seller_custom_field: 'SKU-9', pictures: [{ source: 'https://x/1' }] });
      expect(body.attributes).toEqual(expect.arrayContaining([{ id: 'BRAND', value_name: 'Acme' }, { id: 'GTIN', value_name: '7891234567895' }, { id: 'SELLER_SKU', value_name: 'SKU-9' }]));
      expect(body.description.plain_text).toMatch(/Ficha técnica:\n- Cor: Prata/);
      expect(body.sale_terms).toEqual(expect.arrayContaining([{ id: 'WARRANTY_TIME', value_name: '3 meses' }]));
    });

    it('conector ML: varre anúncios por rolagem + multiget, lê descrição e mantém a publicação desligada por padrão', async () => {
      const calls: string[] = [];
      const ml = createServer((req, res) => {
        calls.push(`${req.method} ${req.url}`);
        const json = (b: unknown, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
        const u = req.url!;
        if (u.startsWith('/users/555/items/search')) return json(u.includes('scroll_id=S1') ? { results: [], scroll_id: 'S1' } : { results: ['MLB1', 'MLB2'], scroll_id: 'S1', paging: { total: 2 } });
        if (u.startsWith('/items?ids=')) return json([{ code: 200, body: { id: 'MLB1', title: 'Um', price: 1 } }, { code: 404, body: {} }, { code: 200, body: { id: 'MLB2', title: 'Dois', price: 2, seller_custom_field: 'S2' } }]);
        if (u === '/items/MLB2/description') return json({ plain_text: 'Texto do anúncio' });
        if (u === '/items/MLB2') return json({ id: 'MLB2', title: 'Dois', price: 2 });
        return json({ message: 'not found' }, 404);
      });
      await new Promise<void>((r) => ml.listen(0, '127.0.0.1', r));
      const prev = process.env.ML_API_BASE;
      process.env.ML_API_BASE = `http://127.0.0.1:${(ml.address() as { port: number }).port}`;
      try {
        const c = new MercadoLivreConnector();
        const ctx = { connectionId: 'c', tenantId: 't', credentials: { accessToken: 'tok' }, config: {}, externalAccountId: '555' };
        const p1 = await c.fetchProducts(ctx, {});
        expect(p1.ok && p1.data.products.map((p) => p.externalId)).toEqual(['MLB1', 'MLB2']);
        expect(p1.ok && p1.data.nextCursor).toBe('S1');
        const p2 = await c.fetchProducts(ctx, { cursor: 'S1' });
        expect(p2.ok && p2.data.products).toEqual([]);
        expect(p2.ok && p2.data.nextCursor).toBeUndefined(); // fim da varredura
        const d = await c.fetchProductDetail(ctx, { externalId: 'MLB2' });
        expect(d.ok && d.data.description).toBe('Texto do anúncio');
        expect((await c.fetchProductDetail(ctx, { externalId: '../etc' })).ok).toBe(false);
        expect(calls.some((x) => x.includes('search_type=scan'))).toBe(true);
        // publicação desligada por padrão: nenhuma chamada de criação é feita
        const pub = await c.publishProduct(ctx, { productId: 'p', payload: { sku: 's', title: 't', description: '', price: 1, quantity: 1, condition: 'NEW', attributes: [], pictures: [] }, idempotencyKey: 'k' });
        expect(!pub.ok && pub.code).toBe('NOT_CONFIGURED');
        expect(calls.some((x) => x.startsWith('POST'))).toBe(false);
        expect(c.getCapabilities()).toMatchObject({ catalog: 'IMPLEMENTED_UNVERIFIED', publishing: 'PLANNED' });
      } finally {
        if (prev === undefined) delete process.env.ML_API_BASE; else process.env.ML_API_BASE = prev;
        await new Promise((r) => ml.close(r));
      }
    });
  });
});
