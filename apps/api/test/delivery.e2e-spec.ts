import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import sharp from 'sharp';
import { AppModule, configureApp } from '../src/app.module';

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);
let seq = 0;
const uid = () => `${run}${++seq}`;
const day = (n = 0) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** JPEG real (ruído aleatório ⇒ bytes únicos e tamanho realista de foto). */
async function photo(w = 900, h = 700): Promise<string> {
  const raw = randomBytes(w * h * 3);
  return (await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 60 }).toBuffer()).toString('base64');
}

describe('Roteirização e confirmação de entrega pelo motorista (canhoto obrigatório)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  const agent = () => request.agent(app.getHttpServer());
  type Agent = ReturnType<typeof agent>;
  interface T { owner: Agent; tenantId: string; wh: string; productId: string; shipper: Agent; seller: Agent; drivers: Record<string, { agent: Agent; id: string }> }

  async function login(email: string) { const a = agent(); await a.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200); return a; }

  async function setup(label: string): Promise<T> {
    const owner = agent();
    const reg = await owner.post('/api/auth/register').set(H).send({ companyName: `Co ${label} ${run}`, name: `Dono ${label}`, email: `${label}-${run}@teste.local`, password: PASSWORD }).expect(201);
    const company = await owner.post('/api/companies').set(H).send({ legalName: `${label} LTDA` }).expect(201);
    const est = await owner.post('/api/establishments').set(H).send({ companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz' }).expect(201);
    const wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
    const roles = Object.fromEntries((await owner.get('/api/roles').expect(200)).body.map((r: any) => [r.key, r.id]));
    const user = async (role: string) => { const email = `${role}-${uid()}@teste.local`; await owner.post('/api/users').set(H).send({ name: `U ${role}`, email, password: PASSWORD, roleId: roles[role] }).expect(201); return login(email); };
    const productId = (await owner.post('/api/products').set(H).send({ sku: `RT-${uid()}`, name: 'Produto', suggestedPrice: 50, costPrice: 10 }).expect(201)).body.id as string;
    await owner.post('/api/stock/movements').set(H).send({ productId, warehouseId: wh, type: 'PURCHASE_ENTRY', quantity: 1000 }).expect(201);
    return { owner, tenantId: reg.body.tenantId, wh, productId, shipper: await user('shipper'), seller: await user('salesperson'), drivers: {} };
  }

  async function addDriver(t: T, key: string) {
    const email = `drv-${key}-${uid()}@teste.local`;
    const d = await t.owner.post('/api/delivery/drivers').set(H).send({ name: `Motorista ${key}`, email, password: PASSWORD, phone: '19999990000', plate: 'abc1d23', vehicle: 'Fiorino' }).expect(201);
    t.drivers[key] = { agent: await login(email), id: d.body.id };
    return d.body;
  }

  const customer = async (t: T, extra: object = {}) =>
    (await t.owner.post('/api/customers').set(H).send({ kind: 'PF', name: `Cliente ${uid()}`, street: 'Rua das Flores', number: '100', district: 'Centro', city: 'Campinas', state: 'SP', zipCode: '13010-000', ...extra }).expect(201)).body.id as string;

  /** Pedido embalado, pronto para entrega. */
  async function packed(t: T, customerId: string, status: 'PACKED' | 'SHIPPED' = 'PACKED') {
    const o = (await t.owner.post('/api/sales/orders').set(H).send({ customerId, warehouseId: t.wh, items: [{ productId: t.productId, quantity: 2, unitPrice: 50 }] }).expect(201)).body;
    await t.owner.post(`/api/sales/orders/${o.id}/submit`).set(H).expect(200);
    for (const to of status === 'SHIPPED' ? ['PICKING', 'PACKED', 'SHIPPED'] : ['PICKING', 'PACKED']) await t.owner.post(`/api/sales/orders/${o.id}/advance`).set(H).send({ to }).expect(200);
    return o.id as string;
  }
  const route = async (t: T, driverKey: string, orderIds: string[], extra: object = {}) =>
    (await t.shipper.post('/api/delivery/routes').set(H).send({ routeDate: day(), driverId: t.drivers[driverKey].id, orderIds, ...extra }).expect(201)).body;
  const orderStatus = async (t: T, id: string) => (await t.owner.get(`/api/sales/orders/${id}`).expect(200)).body.status as string;
  const stockOnHand = async (t: T) => ((await t.owner.get(`/api/stock/balances/${t.productId}`).expect(200)).body as any[])[0].onHand as number;
  const deliver = (t: T, key: string, stopId: string, body: object) => t.drivers[key].agent.post(`/api/delivery/my/stops/${stopId}/deliver`).set(H).send(body);

  let A: T;
  let B: T;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    await admin.plan.update({ where: { code: 'trial' }, data: { limits: { users: 100, establishments: 20, warehouses: 20 } } });
    A = await setup('rtA');
    B = await setup('rtB');
    await addDriver(A, 'joao');
    await addDriver(A, 'maria');
    await addDriver(B, 'bia');
  });
  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  describe('permissões e motoristas', () => {
    it('cada perfil só acessa o que é seu', async () => {
      await A.seller.get('/api/delivery/routes').expect(403);
      await A.seller.post('/api/delivery/routes').set(H).send({}).expect(403);
      await A.shipper.get('/api/delivery/routes').expect(200);
      await A.shipper.get('/api/delivery/drivers').expect(200);
      await A.drivers.joao.agent.get('/api/delivery/routes').expect(403); // motorista não vê as rotas dos outros
      await A.drivers.joao.agent.get('/api/delivery/drivers').expect(403);
      await A.drivers.joao.agent.get('/api/delivery/my/routes').expect(200);
      await A.shipper.get('/api/delivery/my/routes').expect(403);
      await request(app.getHttpServer()).get('/api/delivery/my/routes').expect(401);
    });

    it('o motorista é cadastrado com acesso próprio, placa normalizada, e e-mail repetido é recusado', async () => {
      const list = (await A.shipper.get('/api/delivery/drivers').expect(200)).body as any[];
      expect(list.find((d) => d.id === A.drivers.joao.id)).toMatchObject({ name: 'Motorista joao', plate: 'ABC1D23', vehicle: 'Fiorino', active: true, openRoutes: 0 });
      await A.owner.post('/api/delivery/drivers').set(H).send({ name: 'Outro', email: `drv-joao-x@teste.local`, password: 'curta' }).expect(400); // senha fraca/curta
      const email = `dup-${uid()}@teste.local`;
      await A.owner.post('/api/delivery/drivers').set(H).send({ name: 'Dup', email, password: PASSWORD }).expect(201);
      await A.owner.post('/api/delivery/drivers').set(H).send({ name: 'Dup 2', email, password: PASSWORD }).expect(409);
    });
  });

  describe('montar a rota', () => {
    it('lista só pedidos embalados/expedidos que ainda não estão em rota, com endereço', async () => {
      const c = await customer(A);
      const ok = await packed(A, c);
      const draft = (await A.owner.post('/api/sales/orders').set(H).send({ customerId: c, warehouseId: A.wh, items: [{ productId: A.productId, quantity: 1, unitPrice: 50 }] }).expect(201)).body.id;
      const list = (await A.shipper.get('/api/delivery/eligible-orders').expect(200)).body as any[];
      expect(list.map((o) => o.id)).toContain(ok);
      expect(list.map((o) => o.id)).not.toContain(draft);
      expect(list.find((o) => o.id === ok)).toMatchObject({ status: 'PACKED', addressComplete: true, city: 'Campinas', state: 'SP' });
      expect(list.find((o) => o.id === ok).address).toContain('Rua das Flores, 100');
      await route(A, 'joao', [ok]);
      expect(((await A.shipper.get('/api/delivery/eligible-orders').expect(200)).body as any[]).map((o) => o.id)).not.toContain(ok);
    });

    it('ordena por região (UF, cidade, CEP, nesta ordem) e respeita a ordem manual quando pedido', async () => {
      const rj = await packed(A, await customer(A, { city: 'Rio de Janeiro', state: 'RJ', zipCode: '20000-000' }));
      const far = await packed(A, await customer(A, { zipCode: '13099-000' }));
      const near = await packed(A, await customer(A, { zipCode: '13001-000' }));
      const auto = await route(A, 'maria', [rj, far, near]);
      expect(auto.stops.map((s: any) => s.salesOrderId)).toEqual([rj, near, far]); // RJ antes de SP; dentro de Campinas, pelo CEP
      expect(auto.stops.map((s: any) => s.sequence)).toEqual([1, 2, 3]);
      expect(auto.status).toBe('PLANNED');
      expect(auto.totals).toMatchObject({ stops: 3, pending: 3 });

      const rj2 = await packed(A, await customer(A, { city: 'Rio de Janeiro', state: 'RJ', zipCode: '20000-000' }));
      const near2 = await packed(A, await customer(A, { zipCode: '13001-000' }));
      const manual = await route(A, 'maria', [rj2, near2], { autoSort: false });
      expect(manual.stops.map((s: any) => s.salesOrderId)).toEqual([rj2, near2]);
    });

    it('recusa pedido fora de condição, repetido, em outra rota, de outra empresa e motorista inválido', async () => {
      const c = await customer(A);
      const draft = (await A.owner.post('/api/sales/orders').set(H).send({ customerId: c, warehouseId: A.wh, items: [{ productId: A.productId, quantity: 1, unitPrice: 50 }] }).expect(201)).body.id;
      await A.shipper.post('/api/delivery/routes').set(H).send({ routeDate: day(), driverId: A.drivers.joao.id, orderIds: [draft] }).expect(409);
      const o = await packed(A, c);
      await A.shipper.post('/api/delivery/routes').set(H).send({ routeDate: day(), driverId: A.drivers.joao.id, orderIds: [o, o] }).expect(400);
      await route(A, 'joao', [o]);
      await A.shipper.post('/api/delivery/routes').set(H).send({ routeDate: day(), driverId: A.drivers.maria.id, orderIds: [o] }).expect(409); // já pendente em outra rota
      const foreign = await packed(B, await customer(B));
      await A.shipper.post('/api/delivery/routes').set(H).send({ routeDate: day(), driverId: A.drivers.joao.id, orderIds: [foreign] }).expect(400);
      await A.shipper.post('/api/delivery/routes').set(H).send({ routeDate: day(), driverId: B.drivers.bia.id, orderIds: [await packed(A, c)] }).expect(400); // motorista de outra empresa
      await A.shipper.post('/api/delivery/routes').set(H).send({ routeDate: 'ontem', driverId: A.drivers.joao.id, orderIds: [o] }).expect(400);
    });

    it('reordena as paradas pendentes e rejeita lista incompleta; remove e adiciona parada', async () => {
      const a = await packed(A, await customer(A, { zipCode: '13001-000' }));
      const b = await packed(A, await customer(A, { zipCode: '13002-000' }));
      const c = await packed(A, await customer(A, { zipCode: '13003-000' }));
      const r = await route(A, 'joao', [a, b, c]);
      const ids = r.stops.map((s: any) => s.id);
      const swapped = (await A.shipper.put(`/api/delivery/routes/${r.id}/order`).set(H).send({ stopIds: [ids[2], ids[0], ids[1]] }).expect(200)).body;
      expect(swapped.stops.map((s: any) => s.id)).toEqual([ids[2], ids[0], ids[1]]);
      await A.shipper.put(`/api/delivery/routes/${r.id}/order`).set(H).send({ stopIds: [ids[0], ids[1]] }).expect(400);
      await A.shipper.put(`/api/delivery/routes/${r.id}/order`).set(H).send({ stopIds: [ids[0], ids[0], ids[1]] }).expect(400);

      const removed = (await A.shipper.delete(`/api/delivery/routes/${r.id}/stops/${ids[0]}`).set(H).expect(200)).body;
      expect(removed.totals).toMatchObject({ pending: 2, cancelled: 1 });
      expect(removed.stops.filter((s: any) => s.status !== 'CANCELLED').map((s: any) => s.sequence)).toEqual([1, 2]);
      expect(((await A.shipper.get('/api/delivery/eligible-orders').expect(200)).body as any[]).map((o) => o.id)).toContain(a); // voltou para a fila
      const added = (await A.shipper.post(`/api/delivery/routes/${r.id}/stops`).set(H).send({ orderId: a }).expect(201)).body;
      expect(added.totals.pending).toBe(3);
      await A.shipper.post(`/api/delivery/routes/${r.id}/stops`).set(H).send({ orderId: a }).expect(409);
    });
  });

  describe('iniciar e entregar com o canhoto', () => {
    it('iniciar expede os pedidos (baixa estoque) e só então o motorista pode confirmar; a foto é obrigatória e validada pelos bytes', async () => {
      const o = await packed(A, await customer(A));
      const r = await route(A, 'joao', [o]);
      const stop = r.stops[0].id;
      const before = await stockOnHand(A);
      expect(await orderStatus(A, o)).toBe('PACKED');

      // rota ainda não iniciada
      expect((await deliver(A, 'joao', stop, { receiverName: 'Fulano', photo: { contentBase64: await photo() } }).expect(409)).body.message).toMatch(/não foi iniciada/);
      await A.seller.post(`/api/delivery/routes/${r.id}/start`).set(H).expect(403);
      const started = (await A.shipper.post(`/api/delivery/routes/${r.id}/start`).set(H).expect(200)).body;
      expect(started.status).toBe('IN_PROGRESS');
      expect(await orderStatus(A, o)).toBe('SHIPPED');
      expect(await stockOnHand(A)).toBe(before - 2);
      await A.shipper.post(`/api/delivery/routes/${r.id}/start`).set(H).expect(409); // não inicia duas vezes

      // sem foto, sem recebedor, arquivo falso, imagem pequena, base64 inválido
      await deliver(A, 'joao', stop, { receiverName: 'Fulano' }).expect(400);
      await deliver(A, 'joao', stop, { receiverName: 'Fulano', photo: {} }).expect(400);
      await deliver(A, 'joao', stop, { photo: { contentBase64: await photo() } }).expect(400);
      await deliver(A, 'joao', stop, { receiverName: 'Fulano', photo: { contentBase64: Buffer.from('<html>'.repeat(500)).toString('base64') } }).expect(400);
      await deliver(A, 'joao', stop, { receiverName: 'Fulano', photo: { contentBase64: await photo(300, 300) } }).expect(400); // resolução baixa
      await deliver(A, 'joao', stop, { receiverName: 'Fulano', photo: { contentBase64: '%%%não-é-base64%%%' } }).expect(400);
      expect(await orderStatus(A, o)).toBe('SHIPPED'); // nada mudou

      const img = await photo();
      const ok = (await deliver(A, 'joao', stop, { receiverName: 'Fulano de Tal', receiverDocument: '123.456.789-09', notes: 'Deixado na portaria', photo: { contentBase64: img }, lat: -22.9, lng: -47.06, accuracyM: 12.4 }).expect(200)).body;
      expect(ok).toMatchObject({ status: 'DELIVERED', replayed: false });
      expect(await orderStatus(A, o)).toBe('DELIVERED');

      const done = (await A.shipper.get(`/api/delivery/routes/${r.id}`).expect(200)).body;
      expect(done.status).toBe('COMPLETED'); // última parada resolvida conclui a rota
      expect(done.stops[0]).toMatchObject({ status: 'DELIVERED', receiverName: 'Fulano de Tal', hasProof: true, lat: -22.9 });
      const proof = await A.shipper.get(`/api/delivery/stops/${stop}/proof`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); }).expect(200);
      expect(proof.headers['content-type']).toBe('image/jpeg');
      expect(proof.headers['x-content-type-options']).toBe('nosniff');
      expect((proof.body as Buffer).equals(Buffer.from(img, 'base64'))).toBe(true);
      await A.drivers.joao.agent.get(`/api/delivery/my/stops/${stop}/proof`).expect(200);
      await A.drivers.maria.agent.get(`/api/delivery/my/stops/${stop}/proof`).expect(404); // outro motorista não vê
      await B.shipper.get(`/api/delivery/stops/${stop}/proof`).expect(404); // outra empresa não vê
      await A.seller.get(`/api/delivery/stops/${stop}/proof`).expect(403);
    });

    it('a mesma foto não vale para duas entregas; repetir o envio é idempotente; confirmar de novo com outra foto é recusado', async () => {
      const o1 = await packed(A, await customer(A)); const o2 = await packed(A, await customer(A));
      const r = await route(A, 'joao', [o1, o2], { autoSort: false });
      await A.shipper.post(`/api/delivery/routes/${r.id}/start`).set(H).expect(200);
      const [s1, s2] = r.stops.map((s: any) => s.id);
      const img = await photo();
      await deliver(A, 'joao', s1, { receiverName: 'Ana', photo: { contentBase64: img } }).expect(200);
      expect((await deliver(A, 'joao', s2, { receiverName: 'Bia', photo: { contentBase64: img } }).expect(409)).body.message).toMatch(/já foi usada/);
      expect((await deliver(A, 'joao', s1, { receiverName: 'Ana', photo: { contentBase64: img } }).expect(200)).body.replayed).toBe(true); // reenvio após falha de rede
      await deliver(A, 'joao', s1, { receiverName: 'Ana', photo: { contentBase64: await photo() } }).expect(409);
      expect(await orderStatus(A, o2)).toBe('SHIPPED');
      expect(await admin.deliveryProof.count({ where: { tenantId: A.tenantId, stopId: s1 } })).toBe(1);
    });

    it('envios simultâneos da mesma confirmação gravam um único comprovante', async () => {
      const o = await packed(A, await customer(A));
      const r = await route(A, 'joao', [o]);
      await A.shipper.post(`/api/delivery/routes/${r.id}/start`).set(H).expect(200);
      const img = await photo();
      const res = await Promise.all([1, 2, 3].map(() => deliver(A, 'joao', r.stops[0].id, { receiverName: 'Caio', photo: { contentBase64: img } })));
      expect(res.map((x) => x.status).sort()).toEqual([200, 200, 200]);
      expect(res.filter((x) => x.body.replayed === false)).toHaveLength(1);
      expect(await admin.deliveryProof.count({ where: { tenantId: A.tenantId, stopId: r.stops[0].id } })).toBe(1);
    });

    it('só o motorista da rota confirma; não conta pedido de vendedor para o escopo; outra empresa não enxerga', async () => {
      const o = await packed(A, await customer(A));
      const r = await route(A, 'joao', [o]);
      await A.shipper.post(`/api/delivery/routes/${r.id}/start`).set(H).expect(200);
      const stop = r.stops[0].id;
      await deliver(A, 'maria', stop, { receiverName: 'Xavier', photo: { contentBase64: await photo() } }).expect(404);
      await B.drivers.bia.agent.post(`/api/delivery/my/stops/${stop}/deliver`).set(H).send({ receiverName: 'Xavier', photo: { contentBase64: await photo() } }).expect(404);
      await A.shipper.post(`/api/delivery/my/stops/${stop}/deliver`).set(H).send({ receiverName: 'Xavier', photo: { contentBase64: await photo() } }).expect(403); // despachante não confirma por ele
      await A.drivers.maria.agent.get(`/api/delivery/my/routes/${r.id}`).expect(404);
      await B.shipper.get(`/api/delivery/routes/${r.id}`).expect(404);
      const mine = (await A.drivers.joao.agent.get('/api/delivery/my/routes').expect(200)).body as any[];
      expect(mine.find((x) => x.id === r.id)).toBeDefined();
      expect((await A.drivers.maria.agent.get('/api/delivery/my/routes').expect(200)).body.find((x: any) => x.id === r.id)).toBeUndefined();
      await deliver(A, 'joao', stop, { receiverName: 'Dono', photo: { contentBase64: await photo() } }).expect(200);
    });
  });

  describe('não entregue, cancelamento e conclusão', () => {
    it('"não entreguei" exige o motivo, mantém o pedido em trânsito e libera para nova rota', async () => {
      const o = await packed(A, await customer(A));
      const r = await route(A, 'joao', [o]);
      await A.shipper.post(`/api/delivery/routes/${r.id}/start`).set(H).expect(200);
      const stop = r.stops[0].id;
      const fail = (body: object) => A.drivers.joao.agent.post(`/api/delivery/my/stops/${stop}/fail`).set(H).send(body);
      await fail({}).expect(400);
      await fail({ reason: 'ab' }).expect(400);
      await fail({ reason: 'Cliente ausente', photo: { contentBase64: '@@@' } }).expect(400);
      await fail({ reason: 'Cliente ausente', photo: { contentBase64: await photo() } }).expect(200);
      expect(await orderStatus(A, o)).toBe('SHIPPED');
      const done = (await A.shipper.get(`/api/delivery/routes/${r.id}`).expect(200)).body;
      expect(done).toMatchObject({ status: 'COMPLETED' });
      expect(done.stops[0]).toMatchObject({ status: 'FAILED', failureReason: 'Cliente ausente', hasFailurePhoto: true, hasProof: false });
      await A.drivers.joao.agent.post(`/api/delivery/my/stops/${stop}/fail`).set(H).send({ reason: 'De novo' }).expect(409);
      // segunda tentativa em nova rota (o pedido já está expedido)
      expect(((await A.shipper.get('/api/delivery/eligible-orders').expect(200)).body as any[]).find((x) => x.id === o)).toMatchObject({ status: 'SHIPPED' });
      const again = await route(A, 'maria', [o]);
      await A.shipper.post(`/api/delivery/routes/${again.id}/start`).set(H).expect(200);
      await deliver(A, 'maria', again.stops[0].id, { receiverName: 'Vizinho', photo: { contentBase64: await photo() } }).expect(200);
      expect(await orderStatus(A, o)).toBe('DELIVERED');
    });

    it('cancelar rota planejada devolve os pedidos à fila; com entrega confirmada não cancela', async () => {
      const o1 = await packed(A, await customer(A)); const o2 = await packed(A, await customer(A));
      const r = await route(A, 'joao', [o1]);
      await A.shipper.post(`/api/delivery/routes/${r.id}/cancel`).set(H).send({}).expect(400); // motivo obrigatório
      const c = (await A.shipper.post(`/api/delivery/routes/${r.id}/cancel`).set(H).send({ reason: 'Veículo quebrado' }).expect(200)).body;
      expect(c).toMatchObject({ status: 'CANCELLED', cancelReason: 'Veículo quebrado' });
      expect(await orderStatus(A, o1)).toBe('PACKED');
      await A.shipper.post(`/api/delivery/routes/${r.id}/start`).set(H).expect(409);

      const r2 = await route(A, 'joao', [o1, o2], { autoSort: false });
      await A.shipper.post(`/api/delivery/routes/${r2.id}/start`).set(H).expect(200);
      await deliver(A, 'joao', r2.stops[0].id, { receiverName: 'Zé', photo: { contentBase64: await photo() } }).expect(200);
      await A.shipper.post(`/api/delivery/routes/${r2.id}/cancel`).set(H).send({ reason: 'Tentativa' }).expect(409);
    });

    it('motorista com rota aberta não pode ser inativado; inativo some das novas rotas', async () => {
      const email = `tmp-${uid()}@teste.local`;
      const d = (await A.owner.post('/api/delivery/drivers').set(H).send({ name: 'Temporário', email, password: PASSWORD }).expect(201)).body;
      const o = await packed(A, await customer(A));
      A.drivers.tmp = { agent: await login(email), id: d.id };
      const r = await route(A, 'tmp', [o]);
      await A.shipper.put(`/api/delivery/drivers/${d.id}`).set(H).send({ active: false }).expect(409);
      await A.shipper.post(`/api/delivery/routes/${r.id}/cancel`).set(H).send({ reason: 'Troca' }).expect(200);
      await A.shipper.put(`/api/delivery/drivers/${d.id}`).set(H).send({ active: false }).expect(200);
      await A.shipper.post('/api/delivery/routes').set(H).send({ routeDate: day(), driverId: d.id, orderIds: [o] }).expect(400);
      await A.drivers.tmp.agent.get('/api/delivery/my/routes').expect(403); // sem cadastro ativo de motorista
    });

    it('a trilha de auditoria registra início, entrega e comprovante (hash), e o comprovante não pode ser alterado nem apagado', async () => {
      const o = await packed(A, await customer(A));
      const r = await route(A, 'joao', [o]);
      await A.shipper.post(`/api/delivery/routes/${r.id}/start`).set(H).expect(200);
      await deliver(A, 'joao', r.stops[0].id, { receiverName: 'Auditado', photo: { contentBase64: await photo() } }).expect(200);
      const logs = await admin.auditLog.findMany({ where: { tenantId: A.tenantId, entityId: { in: [r.id, r.stops[0].id] } } });
      const actions = logs.map((l) => l.action);
      expect(actions).toEqual(expect.arrayContaining(['delivery.route_created', 'delivery.route_started', 'delivery.confirmed', 'delivery.route_completed']));
      expect(JSON.stringify(logs.find((l) => l.action === 'delivery.confirmed')!.metadata)).toMatch(/[0-9a-f]{64}/);
      const proof = await admin.deliveryProof.findFirstOrThrow({ where: { tenantId: A.tenantId, stopId: r.stops[0].id } });
      // papel de aplicação (dh_app) não tem UPDATE/DELETE sobre comprovantes
      const rows = await admin.$queryRaw<{ ok: boolean }[]>`SELECT has_table_privilege('dh_app', 'delivery_proofs', 'UPDATE') OR has_table_privilege('dh_app', 'delivery_proofs', 'DELETE') AS ok`;
      expect(rows[0].ok).toBe(false);
      expect(proof.bytes).toBeGreaterThan(2000);
    });
  });
});
