import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';
import { readImageInfo } from '../src/catalog/image';
import { signedMediaUrl } from '../src/catalog/product-images.service';

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);
let seq = 0;
const uid = () => `${run}${++seq}`;

// Imagens sintéticas: só o cabeçalho real de cada formato (suficiente para a validação de tipo e dimensões).
function png(w: number, h: number, size = 400) {
  const b = Buffer.alloc(size, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}
function jpeg(w: number, h: number, size = 400) {
  const b = Buffer.alloc(size, 0);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]).copy(b, 0); // SOI + APP0
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03]).copy(b, 20); // SOF0
  return b;
}
function webp(w: number, h: number, size = 400) {
  const b = Buffer.alloc(size, 0);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(size - 8, 4); b.write('WEBP', 8, 'latin1'); b.write('VP8X', 12, 'latin1'); b.writeUInt32LE(10, 16);
  b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
  return b;
}
const b64 = (b: Buffer) => b.toString('base64');
const bin = (r: any, cb: any) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); };

describe('Fotos do produto, URL pública assinada e qualidade do cadastro', () => {
  let app: INestApplication;
  const agent = () => request.agent(app.getHttpServer());
  type Agent = ReturnType<typeof agent>;
  let A: Agent; let B: Agent; let sales: Agent;

  const product = async (who = A, extra: object = {}) => (await who.post('/api/products').set(H).send({ sku: `M-${uid()}`, name: 'Parafuso sextavado M8 aço zincado', ...extra }).expect(201)).body.id as string;
  const add = (id: string, buf: Buffer, type = 'image/png', who = A) => who.post(`/api/products/${id}/images`).set(H).send({ contentType: type, contentBase64: b64(buf) });
  const list = async (id: string) => (await A.get(`/api/products/${id}/images`).expect(200)).body as any[];

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    A = agent(); B = agent(); sales = agent();
    await A.post('/api/auth/register').set(H).send({ companyName: `Co md A ${run}`, name: 'Dono A', email: `mdA-${run}@teste.local`, password: PASSWORD }).expect(201);
    await B.post('/api/auth/register').set(H).send({ companyName: `Co md B ${run}`, name: 'Dono B', email: `mdB-${run}@teste.local`, password: PASSWORD }).expect(201);
    const roles = Object.fromEntries((await A.get('/api/roles').expect(200)).body.map((r: any) => [r.key, r.id]));
    await A.post('/api/users').set(H).send({ name: 'Vendedor', email: `mdS-${run}@teste.local`, password: PASSWORD, roleId: roles.salesperson }).expect(201);
    await sales.post('/api/auth/login').set(H).send({ email: `mdS-${run}@teste.local`, password: PASSWORD }).expect(200);
  });
  afterAll(async () => { await app.close(); });

  it('lê tipo e dimensões de PNG, JPEG e WebP direto dos bytes', () => {
    expect(readImageInfo(png(640, 480))).toEqual({ type: 'image/png', width: 640, height: 480 });
    expect(readImageInfo(jpeg(1200, 900))).toEqual({ type: 'image/jpeg', width: 1200, height: 900 });
    expect(readImageInfo(webp(800, 800))).toEqual({ type: 'image/webp', width: 800, height: 800 });
    expect(readImageInfo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'.padEnd(300)))).toBeNull();
  });

  it('envia fotos, a primeira é a principal; reordena, remove e a próxima assume', async () => {
    const id = await product();
    const a = (await add(id, png(1000, 1000)).expect(201)).body;
    const b = (await add(id, jpeg(800, 600), 'image/jpeg').expect(201)).body;
    const c = (await add(id, webp(700, 700), 'image/webp').expect(201)).body;
    let imgs = await list(id);
    expect(imgs.map((i) => [i.id, i.main, i.width])).toEqual([[a.id, true, 1000], [b.id, false, 800], [c.id, false, 700]]);
    await A.put(`/api/products/${id}/images/order`).set(H).send({ ids: [c.id, a.id, b.id] }).expect(200);
    expect((await list(id)).map((i) => i.id)).toEqual([c.id, a.id, b.id]);
    await A.put(`/api/products/${id}/images/order`).set(H).send({ ids: [c.id, a.id] }).expect(400); // incompleta
    await A.put(`/api/products/${id}/images/order`).set(H).send({ ids: [c.id, c.id, a.id] }).expect(400); // repetida
    await A.delete(`/api/products/${id}/images/${c.id}`).set(H).expect(200); // remove a principal
    imgs = await list(id);
    expect(imgs.map((i) => [i.id, i.position, i.main])).toEqual([[a.id, 0, true], [b.id, 1, false]]);
    await A.patch(`/api/products/${id}/images/${a.id}`).set(H).send({ alt: 'Parafuso em fundo branco' }).expect(200);
    expect((await list(id))[0].alt).toBe('Parafuso em fundo branco');
  });

  it('recusa SVG disfarçado, tipo divergente, arquivo grande, dimensões absurdas e excesso de fotos', async () => {
    const id = await product();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">'.padEnd(300, ' ') + '</svg>');
    await add(id, svg).expect(400);
    await add(id, png(500, 500), 'image/jpeg').expect(400);
    await add(id, png(500, 500, 3 * 1024 * 1024 + 10)).expect(400);
    await add(id, png(9000, 9000)).expect(400);
    await A.post(`/api/products/${id}/images`).set(H).send({ contentType: 'image/png', contentBase64: '###' }).expect(400);
    for (let i = 0; i < 12; i++) await add(id, png(600 + i, 600)).expect(201);
    await add(id, png(700, 700)).expect(409);
    expect(await list(id)).toHaveLength(12);
  });

  it('envios simultâneos não passam do limite de 12 fotos', async () => {
    const id = await product();
    const res = await Promise.all(Array.from({ length: 16 }, (_, i) => add(id, png(600 + i, 600))));
    expect(res.filter((r) => r.status === 201)).toHaveLength(12);
    expect(res.filter((r) => r.status === 409)).toHaveLength(4);
    expect((await list(id)).map((i) => i.position)).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });

  it('serve a foto autenticada; vendedor vê mas não altera; outro tenant não enxerga', async () => {
    const id = await product();
    const img = png(900, 900, 500);
    const { id: imageId } = (await add(id, img).expect(201)).body;
    const r = await A.get(`/api/products/${id}/images/${imageId}/file`).buffer(true).parse(bin).expect(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect((r.body as Buffer).equals(img)).toBe(true);
    await sales.get(`/api/products/${id}/images/${imageId}/file`).expect(200);
    await add(id, png(600, 600), 'image/png', sales).expect(403);
    await sales.delete(`/api/products/${id}/images/${imageId}`).set(H).expect(403);
    await B.get(`/api/products/${id}/images/${imageId}/file`).expect(404);
    await B.get(`/api/products/${id}/images`).expect(404);
    await add(id, png(600, 600), 'image/png', B).expect(404);
    await agent().get(`/api/products/${id}/images/${imageId}/file`).expect(401);
  });

  it('URL pública assinada: serve sem login, recusa assinatura adulterada, outra imagem e link expirado', async () => {
    const id = await product();
    const img = jpeg(1000, 1000, 600);
    const one = (await add(id, img, 'image/jpeg').expect(201)).body.id as string;
    const other = (await add(id, png(600, 600)).expect(201)).body.id as string;
    const url = new URL(signedMediaUrl(one, 3600));
    const path = `${url.pathname}${url.search}`;
    const ok = await agent().get(path).buffer(true).parse(bin).expect(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    expect(ok.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect((ok.body as Buffer).equals(img)).toBe(true);
    await agent().get(path.replace(/s=.{3}/, 's=AAA')).expect(404); // assinatura adulterada
    await agent().get(`/api/media/${other}${url.search}`).expect(404); // assinatura de outra imagem
    await agent().get(`/api/media/${one}?e=${url.searchParams.get('e')}`).expect(400); // sem assinatura
    const spy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 3600 * 1000);
    try { await agent().get(path).expect(404); } finally { spy.mockRestore(); } // expirado
  });

  it('qualidade do cadastro: aponta o que falta e fica pronto quando os obrigatórios estão atendidos', async () => {
    const id = await product(A, { name: 'Curto' });
    let q = (await A.get(`/api/products/${id}/quality`).expect(200)).body;
    expect(q.ready).toBe(false);
    const failed = (k: string) => q.items.find((i: any) => i.key === k).ok === false;
    for (const k of ['title', 'photo', 'brand', 'category', 'price', 'shipping']) expect(failed(k)).toBe(true);
    expect(q.score).toBeLessThan(30);

    const cat = (await A.post('/api/categories').set(H).send({ name: `Ferragens ${uid()}` }).expect(201)).body.id;
    await A.patch(`/api/products/${id}`).set(H).send({
      name: 'Parafuso sextavado M8 x 40 aço zincado', brand: 'Acme', model: 'PS-840', barcode: '7891234567895', categoryId: cat, suggestedPrice: 3.9, grossWeightG: 20, heightMm: 10, widthMm: 10, lengthMm: 40,
      description: 'D'.repeat(120), attributes: [{ name: 'Material', value: 'Aço' }, { name: 'Acabamento', value: 'Zincado' }, { name: 'Rosca', value: 'M8' }], condition: 'NEW', warrantyMonths: 3,
    }).expect(200);
    await add(id, png(1200, 1200)).expect(201);
    await add(id, png(800, 800)).expect(201);
    await add(id, png(800, 800)).expect(201);
    q = (await A.get(`/api/products/${id}/quality`).expect(200)).body;
    expect(q.items.filter((i: any) => !i.ok).map((i: any) => i.key)).toEqual([]);
    expect(q.ready).toBe(true);
    expect(q.score).toBe(100);
    await B.get(`/api/products/${id}/quality`).expect(404);
  });

  it('novos campos de anúncio: título, condição, garantia, fabricante e ficha técnica validados', async () => {
    const id = await product(A, { title: 'Parafuso M8', condition: 'USED', warrantyMonths: 6, mpn: 'ABC-1', attributes: [{ name: 'Cor', value: 'Prata' }] });
    const p = (await A.get(`/api/products/${id}`).expect(200)).body;
    expect(p).toMatchObject({ title: 'Parafuso M8', condition: 'USED', warrantyMonths: 6, mpn: 'ABC-1', attributes: [{ name: 'Cor', value: 'Prata' }] });
    await A.patch(`/api/products/${id}`).set(H).send({ condition: 'BROKEN' }).expect(400);
    await A.patch(`/api/products/${id}`).set(H).send({ condition: null }).expect(400);
    await A.patch(`/api/products/${id}`).set(H).send({ attributes: [{ name: '', value: 'x' }] }).expect(400);
    await A.patch(`/api/products/${id}`).set(H).send({ attributes: Array.from({ length: 51 }, (_, i) => ({ name: `n${i}`, value: 'v' })) }).expect(400);
    await A.patch(`/api/products/${id}`).set(H).send({ warrantyMonths: 999 }).expect(400);
    const row = ((await A.get('/api/products?limit=200').expect(200)).body.items as any[]).find((x) => x.id === id);
    expect(row._count.images).toBe(0);
  });
});
