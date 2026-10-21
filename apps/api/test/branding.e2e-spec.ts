import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);

/** PNG sintético: assinatura + IHDR com a dimensão pedida + preenchimento (suficiente para a validação de cabeçalho, não precisa ser desenhável). */
function fakePng(w = 200, h = 80, size = 400): Buffer {
  const b = Buffer.alloc(size, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}
const b64 = (b: Buffer) => b.toString('base64');

describe('Logotipo do tenant', () => {
  let app: INestApplication;
  const agent = () => request.agent(app.getHttpServer());
  type Agent = ReturnType<typeof agent>;
  let A: Agent; let B: Agent; let sales: Agent;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    A = agent(); B = agent(); sales = agent();
    await A.post('/api/auth/register').set(H).send({ companyName: `Co brA ${run}`, name: 'Dono A', email: `brA-${run}@teste.local`, password: PASSWORD }).expect(201);
    await B.post('/api/auth/register').set(H).send({ companyName: `Co brB ${run}`, name: 'Dono B', email: `brB-${run}@teste.local`, password: PASSWORD }).expect(201);
    const roles = Object.fromEntries((await A.get('/api/roles').expect(200)).body.map((r: any) => [r.key, r.id]));
    await A.post('/api/users').set(H).send({ name: 'Vendedor', email: `brS-${run}@teste.local`, password: PASSWORD, roleId: roles.salesperson }).expect(201);
    await sales.post('/api/auth/login').set(H).send({ email: `brS-${run}@teste.local`, password: PASSWORD }).expect(200);
  });
  afterAll(async () => { await app.close(); });

  it('sem logotipo: 404 e o perfil do tenant não aponta versão', async () => {
    await A.get('/api/branding/logo').expect(404);
    expect((await A.get('/api/auth/me').expect(200)).body.tenant.logoVersion).toBeNull();
  });

  it('envia, serve com cabeçalhos seguros e informa a versão no perfil', async () => {
    const png = fakePng();
    const put = (await A.put('/api/branding/logo').set(H).send({ contentType: 'image/png', contentBase64: b64(png) }).expect(200)).body;
    expect(put.version).toBeGreaterThan(0);
    const res = await A.get('/api/branding/logo').buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect((res.body as Buffer).equals(png)).toBe(true);
    expect((await A.get('/api/auth/me').expect(200)).body.tenant.logoVersion).toBe(put.version);
  });

  it('recusa SVG/HTML disfarçado, tipo divergente, base64 inválido, arquivo grande demais e dimensões absurdas', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">' + ' '.repeat(200) + '</svg>');
    await A.put('/api/branding/logo').set(H).send({ contentType: 'image/png', contentBase64: b64(svg) }).expect(400);
    await A.put('/api/branding/logo').set(H).send({ contentType: 'image/svg+xml', contentBase64: b64(svg) }).expect(400);
    await A.put('/api/branding/logo').set(H).send({ contentType: 'image/jpeg', contentBase64: b64(fakePng()) }).expect(400); // é PNG, não JPEG
    await A.put('/api/branding/logo').set(H).send({ contentType: 'image/png', contentBase64: '***não é base64***' }).expect(400);
    await A.put('/api/branding/logo').set(H).send({ contentType: 'image/png', contentBase64: b64(fakePng(200, 80, 1_200_000)) }).expect(400);
    await A.put('/api/branding/logo').set(H).send({ contentType: 'image/png', contentBase64: b64(fakePng(9000, 9000)) }).expect(400);
    await A.put('/api/branding/logo').set(H).send({ contentType: 'image/png', contentBase64: b64(Buffer.alloc(20)) }).expect(400);
  });

  it('qualquer membro vê o logotipo, só quem gerencia a empresa altera ou remove', async () => {
    await sales.get('/api/branding/logo').expect(200);
    await sales.put('/api/branding/logo').set(H).send({ contentType: 'image/png', contentBase64: b64(fakePng(100, 100)) }).expect(403);
    await sales.delete('/api/branding/logo').set(H).expect(403);
    await agent().get('/api/branding/logo').expect(401);
  });

  it('isola os tenants: o logotipo de A não aparece nem é afetado por B', async () => {
    await B.get('/api/branding/logo').expect(404);
    await B.put('/api/branding/logo').set(H).send({ contentType: 'image/png', contentBase64: b64(fakePng(64, 64, 300)) }).expect(200);
    const a = await A.get('/api/branding/logo').buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
    expect((a.body as Buffer).length).toBe(400);
    await B.delete('/api/branding/logo').set(H).expect(200);
    await A.get('/api/branding/logo').expect(200);
  });

  it('remove, audita e volta a 404', async () => {
    await A.delete('/api/branding/logo').set(H).expect(200);
    await A.delete('/api/branding/logo').set(H).expect(404);
    await A.get('/api/branding/logo').expect(404);
    expect((await A.get('/api/auth/me').expect(200)).body.tenant.logoVersion).toBeNull();
    for (const action of ['branding.logo_updated', 'branding.logo_removed']) {
      expect(((await A.get(`/api/audit?action=${action}&limit=5`).expect(200)).body.items as any[]).length).toBeGreaterThan(0);
    }
  });
});
