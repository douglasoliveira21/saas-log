import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);
let seq = 0;
const uid = () => `${run}${++seq}`;
const day = () => new Date().toISOString().slice(0, 10);

describe('Rastreio do motorista, geocodificação e trajeto', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let mock: Server;
  const geoCalls: string[] = [];
  let orsCalls = 0;
  const agent = () => request.agent(app.getHttpServer());
  type Agent = ReturnType<typeof agent>;
  interface T { owner: Agent; tenantId: string; wh: string; productId: string; shipper: Agent; seller: Agent; driver: Agent; driverId: string }

  async function login(email: string) { const a = agent(); await a.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200); return a; }

  async function setup(label: string): Promise<T> {
    const owner = agent();
    const reg = await owner.post('/api/auth/register').set(H).send({ companyName: `Co ${label} ${run}`, name: `Dono ${label}`, email: `${label}-${run}@teste.local`, password: PASSWORD }).expect(201);
    const company = await owner.post('/api/companies').set(H).send({ legalName: `${label} LTDA` }).expect(201);
    const est = await owner.post('/api/establishments').set(H).send({ companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz', street: 'Avenida Depósito', number: '1', city: 'Campinas', state: 'SP' }).expect(201);
    const wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
    const roles = Object.fromEntries((await owner.get('/api/roles').expect(200)).body.map((r: any) => [r.key, r.id]));
    const user = async (role: string) => { const email = `${role}-${uid()}@teste.local`; await owner.post('/api/users').set(H).send({ name: `U ${role}`, email, password: PASSWORD, roleId: roles[role] }).expect(201); return login(email); };
    const productId = (await owner.post('/api/products').set(H).send({ sku: `TR-${uid()}`, name: 'Produto', suggestedPrice: 50, costPrice: 10 }).expect(201)).body.id as string;
    await owner.post('/api/stock/movements').set(H).send({ productId, warehouseId: wh, type: 'PURCHASE_ENTRY', quantity: 1000 }).expect(201);
    const email = `drv-${uid()}@teste.local`;
    const d = await owner.post('/api/delivery/drivers').set(H).send({ name: `Motorista ${label}`, email, password: PASSWORD }).expect(201);
    return { owner, tenantId: reg.body.tenantId, wh, productId, shipper: await user('shipper'), seller: await user('salesperson'), driver: await login(email), driverId: d.body.id };
  }

  async function startedRoute(t: T, cities: string[] = ['Campinas', 'Sumaré']) {
    const orders: string[] = [];
    for (const city of cities) {
      const c = (await t.owner.post('/api/customers').set(H).send({ kind: 'PF', name: `Cliente ${uid()}`, street: 'Rua das Flores', number: '100', district: 'Centro', city, state: 'SP', zipCode: '13010-000' }).expect(201)).body.id;
      const o = (await t.owner.post('/api/sales/orders').set(H).send({ customerId: c, warehouseId: t.wh, items: [{ productId: t.productId, quantity: 1, unitPrice: 50 }] }).expect(201)).body.id;
      await t.owner.post(`/api/sales/orders/${o}/submit`).set(H).expect(200);
      for (const to of ['PICKING', 'PACKED']) await t.owner.post(`/api/sales/orders/${o}/advance`).set(H).send({ to }).expect(200);
      orders.push(o);
    }
    const r = (await t.shipper.post('/api/delivery/routes').set(H).send({ routeDate: day(), driverId: t.driverId, orderIds: orders }).expect(201)).body;
    await t.shipper.post(`/api/delivery/routes/${r.id}/start`).set(H).expect(200);
    return r.id as string;
  }

  const point = (lat: number, lng: number, agoSec = 0, extra: object = {}) => ({ lat, lng, accuracyM: 8, speedMps: 8, recordedAt: new Date(Date.now() - agoSec * 1000).toISOString(), ...extra });
  const gpsOn = { enabled: true, permission: 'granted', source: 'APP' };
  const send = (a: Agent, points: object[], gps: object = gpsOn) => a.post('/api/delivery/my/position').set(H).send({ points, gps });

  let A: T;
  let B: T;
  beforeAll(async () => {
    // geocodificador (Nominatim) e serviço de rotas (ORS) simulados
    mock = createServer((req, res) => {
      const url = new URL(req.url!, 'http://x');
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/search') {
        const q = url.searchParams.get('q') ?? '';
        geoCalls.push(q);
        if (q.includes('Inexistente')) return void res.end('[]');
        const base = q.includes('Sumaré') ? { lat: '-22.8200', lon: '-47.2700' } : q.includes('Depósito') ? { lat: '-22.9000', lon: '-47.0600' } : { lat: '-22.9050', lon: '-47.0650' };
        return void res.end(JSON.stringify([base]));
      }
      if (url.pathname === '/v2/directions/driving-car/geojson') {
        orsCalls++;
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const coords = JSON.parse(body).coordinates as [number, number][];
          res.end(JSON.stringify({ features: [{ geometry: { coordinates: coords }, properties: { summary: { distance: 12345, duration: 1800 } } }] }));
        });
        return;
      }
      res.statusCode = 404; res.end('{}');
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
    process.env.GEOCODER_URL = base; process.env.GEOCODER_MIN_GAP_MS = '0'; process.env.ORS_URL = base; process.env.ORS_API_KEY = 'chave-de-teste';

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    await admin.plan.update({ where: { code: 'trial' }, data: { limits: { users: 100, establishments: 20, warehouses: 20 } } });
    A = await setup('trA');
    B = await setup('trB');
  });
  afterAll(async () => {
    delete process.env.GEOCODER_URL; delete process.env.ORS_URL; delete process.env.ORS_API_KEY; delete process.env.GEOCODER_MIN_GAP_MS;
    await admin.$disconnect();
    await app.close();
    await new Promise((r) => mock.close(r));
  });

  describe('permissões', () => {
    it('só o motorista envia posição; a gestão vê o mapa; vendedor não vê nada', async () => {
      await send(A.shipper, [point(-22.9, -47.06)]).expect(403);
      await send(A.seller, [point(-22.9, -47.06)]).expect(403);
      await request(app.getHttpServer()).post('/api/delivery/my/position').set(H).send({ points: [], gps: gpsOn }).expect(401);
      await A.driver.get('/api/delivery/tracking').expect(403);
      await A.seller.get('/api/delivery/tracking').expect(403);
      await A.shipper.get('/api/delivery/tracking').expect(200);
      await A.driver.get('/api/delivery/my/tracking').expect(200);
      await A.shipper.get('/api/delivery/my/tracking').expect(403);
    });
  });

  describe('envio da posição', () => {
    it('sem rota em andamento guarda só o estado do GPS, nunca a trilha', async () => {
      const r = (await send(A.driver, [point(-22.9, -47.06)]).expect(200)).body;
      expect(r).toMatchObject({ accepted: 0, routeActive: false });
      expect(await admin.driverTrackPoint.count({ where: { tenantId: A.tenantId } })).toBe(0);
      expect(await admin.driverPosition.count({ where: { tenantId: A.tenantId, driverId: A.driverId } })).toBe(1);
    });

    it('valida coordenadas, horário e o formato do estado do GPS', async () => {
      await send(A.driver, [point(91, 0)]).expect(400); // latitude impossível: nenhum ponto válido
      await send(A.driver, [point(-22.9, -47.06, -3600)]).expect(400); // no futuro
      await send(A.driver, [point(-22.9, -47.06, 3 * 86_400)]).expect(400); // velho demais
      await send(A.driver, [{ lat: 'x', lng: 1, recordedAt: 'ontem' }]).expect(400);
      await send(A.driver, [point(1, 1)], { enabled: 'sim' }).expect(400);
      await send(A.driver, Array.from({ length: 61 }, (_, i) => point(-22.9, -47.06, i + 1))).expect(400);
    });

    it('com rota em andamento guarda os pontos (em lote, sem duplicar) e aponta a rota', async () => {
      const routeId = await startedRoute(A);
      const batch = [point(-22.9, -47.06, 30), point(-22.901, -47.061, 20), point(-22.902, -47.062, 10)];
      const r = (await send(A.driver, batch).expect(200)).body;
      expect(r).toMatchObject({ accepted: 3, routeActive: true, routeId });
      await send(A.driver, batch).expect(200); // reenvio do mesmo lote (rede instável)
      expect(await admin.driverTrackPoint.count({ where: { tenantId: A.tenantId, routeId } })).toBe(3);
      expect((await A.driver.get('/api/delivery/my/tracking').expect(200)).body).toMatchObject({ routeActive: true, routeId });
    });
  });

  describe('planejamento da rota (endereços e trajeto)', () => {
    it('geocodifica depósito e paradas uma única vez, guarda no banco e calcula o trajeto', async () => {
      const routeId = await startedRoute(B);
      await new Promise((r) => setTimeout(r, 400)); // o início dispara o planejamento em segundo plano
      const stops = await admin.deliveryStop.findMany({ where: { routeId }, orderBy: { sequence: 'asc' } });
      expect(stops.every((s) => s.geocodeStatus === 'OK' && s.destLat !== null)).toBe(true);
      const before = geoCalls.length;
      const again = (await B.shipper.post(`/api/delivery/routes/${routeId}/plan`).set(H).expect(200)).body;
      expect(again).toMatchObject({ geocoded: 0, routeCalculated: true, routingConfigured: true, distanceM: 12345, durationS: 1800 });
      expect(geoCalls.length).toBe(before); // nada foi consultado de novo
      const t = (await B.shipper.get(`/api/delivery/routes/${routeId}/track`).expect(200)).body;
      expect(t.plan.geometry.length).toBeGreaterThan(1);
      expect(t.stops.map((s: any) => s.lat !== null)).toEqual([true, true]);
      expect(orsCalls).toBeGreaterThan(0);
    });

    it('endereço que o serviço não acha fica marcado e a rota continua funcionando', async () => {
      const c = (await A.owner.post('/api/customers').set(H).send({ kind: 'PF', name: `Cliente ${uid()}`, street: 'Rua Inexistente', number: '1', city: 'Inexistente', state: 'SP', zipCode: '99999-999' }).expect(201)).body.id;
      const o = (await A.owner.post('/api/sales/orders').set(H).send({ customerId: c, warehouseId: A.wh, items: [{ productId: A.productId, quantity: 1, unitPrice: 50 }] }).expect(201)).body.id;
      await A.owner.post(`/api/sales/orders/${o}/submit`).set(H).expect(200);
      for (const to of ['PICKING', 'PACKED']) await A.owner.post(`/api/sales/orders/${o}/advance`).set(H).send({ to }).expect(200);
      const r = (await A.shipper.post('/api/delivery/routes').set(H).send({ routeDate: day(), driverId: A.driverId, orderIds: [o] }).expect(201)).body;
      const plan = (await A.shipper.post(`/api/delivery/routes/${r.id}/plan`).set(H).expect(200)).body;
      expect(plan.notFound).toBe(1);
      expect((await admin.deliveryStop.findFirst({ where: { routeId: r.id } }))!.geocodeStatus).toBe('NOT_FOUND');
    });

    it('sem chave do serviço de rotas não inventa trajeto', async () => {
      const key = process.env.ORS_API_KEY; delete process.env.ORS_API_KEY;
      try {
        const routeId = await startedRoute(B, ['Campinas']);
        const plan = (await B.shipper.post(`/api/delivery/routes/${routeId}/plan`).set(H).expect(200)).body;
        expect(plan).toMatchObject({ routeCalculated: false, routingConfigured: false });
        expect((await admin.deliveryRoute.findUnique({ where: { id: routeId } }))!.planGeometry).toBeNull();
      } finally { process.env.ORS_API_KEY = key; }
    });

    it('apenas a gestão da própria empresa planeja', async () => {
      const routeId = await startedRoute(A, ['Campinas']);
      await A.driver.post(`/api/delivery/routes/${routeId}/plan`).set(H).expect(403);
      await B.shipper.post(`/api/delivery/routes/${routeId}/plan`).set(H).expect(404);
    });
  });

  describe('mapa ao vivo e alertas', () => {
    let C: T; let routeId: string;
    beforeAll(async () => { C = await setup('trC'); routeId = await startedRoute(C); await C.shipper.post(`/api/delivery/routes/${routeId}/plan`).set(H).expect(200); });
    const live = async (t: T) => ((await t.shipper.get('/api/delivery/tracking').expect(200)).body as any[]);

    it('mostra a rota em andamento com progresso e próxima parada, sem posição ainda = sem sinal', async () => {
      const [r] = await live(C);
      expect(r).toMatchObject({ routeId, progress: { total: 2, pending: 2, delivered: 0 } });
      expect(r.flags).toContain('NO_SIGNAL');
      expect(r.next).toMatchObject({ sequence: 1 });
      expect(r.plan.calculated).toBe(true);
    });

    it('posição recente e em cima do trajeto: sem alertas e com a distância até a próxima parada', async () => {
      const g = (await C.shipper.get(`/api/delivery/routes/${routeId}/track`).expect(200)).body.plan.geometry as [number, number][];
      const [lat, lng] = g[0];
      await send(C.driver, [point(lat, lng, 60), point(lat, lng, 50), point(lat, lng, 40)]).expect(200);
      const [r] = await live(C);
      expect(r.flags).toEqual([]);
      expect(r.position).toMatchObject({ lat, lng });
      expect(r.next.distanceM).toBeGreaterThan(0);
      expect(r.next.etaMinutes).toBeGreaterThan(0);
    });

    it('longe do trajeto planejado nos últimos pontos: fora da rota', async () => {
      await send(C.driver, [point(-23.2, -47.4, 6), point(-23.2, -47.4, 4), point(-23.2, -47.4, 2)]).expect(200);
      const [r] = await live(C);
      expect(r.flags).toContain('OFF_ROUTE');
      expect(r.offRouteM).toBeGreaterThan(300);
    });

    it('GPS desligado ou permissão negada: alerta imediato', async () => {
      await send(C.driver, [], { enabled: false, permission: 'denied', source: 'APP' }).expect(200);
      expect((await live(C))[0].flags).toContain('GPS_OFF');
      await send(C.driver, [point(-22.9, -47.06)]).expect(200);
      expect((await live(C))[0].flags).not.toContain('GPS_OFF');
    });

    it('sem enviar nada há mais de 3 minutos: sem sinal', async () => {
      await admin.driverPosition.update({ where: { tenantId_driverId: { tenantId: C.tenantId, driverId: C.driverId } }, data: { receivedAt: new Date(Date.now() - 10 * 60_000) } });
      expect((await live(C))[0].flags).toContain('NO_SIGNAL');
    });

    it('a trilha percorrida e a distância somada aparecem no histórico da rota', async () => {
      const t = (await C.shipper.get(`/api/delivery/routes/${routeId}/track`).expect(200)).body;
      expect(t.points).toBeGreaterThanOrEqual(7);
      expect(t.travelledM).toBeGreaterThan(1000);
      expect(t.trail.length).toBe(t.points);
    });

    it('o motorista só vê o mapa da própria rota', async () => {
      await C.driver.get(`/api/delivery/my/routes/${routeId}/map`).expect(200);
      await A.driver.get(`/api/delivery/my/routes/${routeId}/map`).expect(404);
      await A.shipper.get(`/api/delivery/routes/${routeId}/track`).expect(404);
    });

    it('isolamento entre empresas: o mapa de uma não lista a outra', async () => {
      expect((await live(A)).map((r) => r.routeId)).not.toContain(routeId);
      expect((await live(C)).map((r) => r.routeId)).toContain(routeId);
    });
  });
});
