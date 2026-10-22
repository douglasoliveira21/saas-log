import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';

/**
 * ATENÇÃO: o servidor abaixo SIMULA o Focus NFe conforme as páginas oficiais lidas (docs/FISCAL-PROVIDER.md). Estes testes provam o
 * comportamento do NOSSO código diante dessas respostas; não provam que a API real se comporta assim nem que a SEFAZ autoriza a nota.
 */
type Mode = 'sync' | 'async' | 'stuck' | 'rejected' | 'schema' | 'down' | 'pending';
class MockFocus {
  server!: Server;
  base = '';
  token = 'TOKEN-HOMOLOG-1234';
  mode: Mode = 'async';
  requests: { method: string; path: string; ref: string | null; body: any; auth: string | null }[] = [];
  notes = new Map<string, { kind: string; body: any; polls: number; cancelled?: boolean }>();
  n = 0;
  evilPath = false;

  async start() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop() { return new Promise<void>((r) => this.server.close(() => r())); }

  private auth(authHeader: string | null) { return authHeader === `Basic ${Buffer.from(`${this.token}:`).toString('base64')}`; }

  private authorized(ref: string, kind: string) {
    const n = ++this.n;
    const key = `35${'2610'}45723174000110${kind === 'nfce' ? '65' : '55'}001${String(n).padStart(9, '0')}1${String(10000000 + n)}${n % 10}`.slice(0, 44);
    return {
      cnpj_emitente: '45723174000110', ref, status: 'autorizado', status_sefaz: '100', mensagem_sefaz: 'Autorizado o uso da NF-e', chave_nfe: key, numero: String(n), serie: '1',
      caminho_xml_nota_fiscal: this.evilPath ? '//evil.example.com/x.xml' : `/arquivos/xml/${ref}.xml`, caminho_danfe: `/arquivos/danfe/${ref}.pdf`,
      ...(kind === 'nfce' ? { qrcode_url: `https://www.exemplo.gov.br/nfce?p=${key}`, url_consulta_nf: 'https://www.exemplo.gov.br/consulta' } : {}),
    };
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, this.base);
    const raw = await new Promise<string>((ok) => { let s = ''; req.on('data', (d) => (s += d)).on('end', () => ok(s)); });
    const body = raw ? JSON.parse(raw) : null;
    const auth = (req.headers.authorization as string | undefined) ?? null;
    const ref = url.searchParams.get('ref');
    this.requests.push({ method: req.method!, path: url.pathname, ref, body, auth });
    const send = (status: number, json: unknown, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(typeof json === 'string' ? json : JSON.stringify(json)); };
    if (!this.auth(auth)) return send(401, 'HTTP Basic: Access denied.', 'text/html');

    const m = url.pathname.match(/^\/v2\/(nfe|nfce)(?:\/([^/]+))?$/);
    if (m && req.method === 'POST' && ref) {
      const kind = m[1];
      if (this.mode === 'down') return send(503, { codigo: 'indisponivel', mensagem: 'Serviço indisponível' });
      if (this.mode === 'schema') return send(422, { codigo: 'erro_validacao_schema', mensagem: 'Erro de validação', erros: [{ campo: 'cep_destinatario', mensagem: 'CEP inválido' }] });
      if (this.mode === 'pending') return send(422, { codigo: 'already_processed', mensagem: 'Nota já processada' });
      const existing = this.notes.get(ref);
      if (!existing) this.notes.set(ref, { kind, body, polls: 0 });
      if (this.mode === 'rejected') { this.notes.set(ref, { kind, body, polls: 99, cancelled: false }); return send(kind === 'nfce' ? 201 : 202, { cnpj_emitente: '45723174000110', ref, status: 'erro_autorizacao', status_sefaz: '598', mensagem_sefaz: 'Rejeição: NF-e emitida em ambiente de homologação com Razão Social do destinatário diferente de NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO' }); }
      if (kind === 'nfce' || this.mode === 'sync') return send(201, this.authorized(ref, kind));
      return send(202, { cnpj_emitente: '45723174000110', ref, status: 'processando_autorizacao' });
    }
    if (m && m[2] && req.method === 'GET') {
      const note = this.notes.get(decodeURIComponent(m[2]));
      if (!note) return send(404, { codigo: 'nao_encontrado', mensagem: 'Nota fiscal não encontrada' });
      note.polls++;
      if (note.cancelled) return send(200, { ref: m[2], status: 'cancelado', status_sefaz: '135', caminho_xml_cancelamento: `/arquivos/xml/${m[2]}-canc.xml` });
      if (this.mode === 'stuck' || (this.mode === 'async' && note.polls < 2)) return send(200, { ref: m[2], status: 'processando_autorizacao' });
      return send(200, { ...this.authorized(m[2], note.kind), protocolo_nota_fiscal: { numero_protocolo: '135260000000001' } });
    }
    if (m && m[2] && req.method === 'DELETE') {
      const note = this.notes.get(m[2]);
      if (!note) return send(404, { codigo: 'nao_encontrado', mensagem: 'não encontrada' });
      if (!body?.justificativa || String(body.justificativa).length < 15) return send(400, { codigo: 'requisicao_invalida', mensagem: 'justificativa deve ter de 15 a 255 caracteres' });
      note.cancelled = true;
      return send(200, { status: 'cancelado', status_sefaz: '135', mensagem_sefaz: 'Evento registrado e vinculado a NF-e', caminho_xml_cancelamento: `/arquivos/xml/${m[2]}-canc.xml` });
    }
    const f = url.pathname.match(/^\/arquivos\/(xml|danfe)\/(.+)$/);
    if (f) return f[1] === 'xml' ? send(200, `<?xml version="1.0"?><nfeProc><NFe><infNFe Id="NFe-${f[2]}"/></NFe></nfeProc>`, 'application/xml') : send(200, '%PDF-1.4 danfe simulado', 'application/pdf');
    return send(404, { codigo: 'nao_encontrado', mensagem: 'rota inexistente no simulador' });
  }
}

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);
let seq = 0;
const uid = () => `${run}${++seq}`;
const EST_CNPJ = '45723174000110';

describe('Emissão fiscal por provedor (Focus NFe simulado): NF-e e NFC-e', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  const focus = new MockFocus();
  const agent = () => request.agent(app.getHttpServer());
  type Agent = ReturnType<typeof agent>;
  interface T { owner: Agent; tenantId: string; est: string; wh: string; fiscal: Agent; accountant: Agent; buyer: Agent }

  async function setup(label: string): Promise<T> {
    const owner = agent();
    const reg = await owner.post('/api/auth/register').set(H).send({ companyName: `Co ${label} ${run}`, name: `Dono ${label}`, email: `${label}-${run}@teste.local`, password: PASSWORD }).expect(201);
    const company = await owner.post('/api/companies').set(H).send({ legalName: `${label} LTDA`, taxRegime: 'SIMPLES_NACIONAL' }).expect(201);
    const est = await owner.post('/api/establishments').set(H).send({ companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz', cnpj: EST_CNPJ, stateRegistration: '111222333444', cnae: '4744-0/99', zipCode: '13000-000', city: 'Campinas', state: 'SP', street: 'Rua A', number: '1', district: 'Centro' }).expect(201);
    const wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
    const roles = Object.fromEntries((await owner.get('/api/roles').expect(200)).body.map((r: any) => [r.key, r.id]));
    const user = async (k: string) => { const email = `${k}-${uid()}@teste.local`; await owner.post('/api/users').set(H).send({ name: `U ${k}`, email, password: PASSWORD, roleId: roles[k] }).expect(201); const a = agent(); await a.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200); return a; };
    return { owner, tenantId: reg.body.tenantId, est: est.body.id, wh, fiscal: await user('fiscal'), accountant: await user('accountant'), buyer: await user('buyer') };
  }

  /** Regra aprovada pelo contador: Simples, CSOSN 102 e PIS/COFINS CST 49, tudo sem valor (o que este conector sabe enviar). */
  async function approveRule(t: T, taxes: object = { ICMS: { csosn: '102', ratePct: 0 }, PIS: { cst: '49', ratePct: 0 }, COFINS: { cst: '49', ratePct: 0 } }, destUf = 'RJ') {
    const c = (await t.fiscal.post('/api/fiscal/rules').set(H).send({ rule: { name: `Venda SP→${destUf} ${uid()}`, operation: 'SALE', originUf: 'SP', destUf }, version: { validFrom: '2026-01-01T00:00:00Z', sourceReference: 'Parecer contábil 12/2026 – simulado', config: { cfop: destUf === 'SP' ? '5102' : '6102', taxes } } }).expect(201)).body;
    await t.fiscal.post(`/api/fiscal/rules/versions/${c.versionId}/submit`).set(H).expect(200);
    await t.accountant.post(`/api/fiscal/rules/versions/${c.versionId}/approve`).set(H).expect(200);
    return c;
  }

  const customerPJ = (t: T) => t.owner.post('/api/customers').set(H).send({ kind: 'PJ', name: 'Cliente PJ', document: `0425201100${String(1000 + (seq++ % 9000))}`.slice(0, 14), zipCode: '20000-000', street: 'Rua B', number: '2', district: 'Centro', city: 'Rio de Janeiro', state: 'RJ' });
  const product = async (t: T) => {
    const id = (await t.owner.post('/api/products').set(H).send({ sku: `FP-${uid()}`, name: 'Parafuso M8', costPrice: 10, suggestedPrice: 50, ncm: '73181500', taxOrigin: 0 }).expect(201)).body.id as string;
    await t.owner.post('/api/stock/movements').set(H).send({ productId: id, warehouseId: t.wh, type: 'PURCHASE_ENTRY', quantity: 500 }).expect(201);
    return id;
  };
  /** Pedido confirmado; `pj` = cliente com CNPJ e endereço (NF-e); senão consumidor sem cadastro fiscal (NFC-e). */
  async function order(t: T, fiscalDocType: 'NFE' | 'NFCE', pj = fiscalDocType === 'NFE') {
    let customerId: string;
    if (pj) {
      // CNPJ válido e único por empresa: usa um gerador simples com dígitos verificadores corretos
      customerId = (await t.owner.post('/api/customers').set(H).send({ kind: 'PJ', name: 'Cliente PJ', document: cnpj(), zipCode: '20000-000', street: 'Rua B', number: '2', district: 'Centro', city: 'Rio de Janeiro', state: 'RJ', phone: '(21) 99999-0000' }).expect(201)).body.id;
    } else {
      customerId = (await t.owner.post('/api/customers').set(H).send({ kind: 'PF', name: `Consumidor ${uid()}` }).expect(201)).body.id;
    }
    const p = await product(t);
    const o = (await t.owner.post('/api/sales/orders').set(H).send({ customerId, warehouseId: t.wh, fiscalDocType, items: [{ productId: p, quantity: 2, unitPrice: 50 }] }).expect(201)).body.id as string;
    await t.owner.post(`/api/sales/orders/${o}/submit`).set(H).expect(200);
    return o;
  }
  const prepare = (t: T, salesOrderId: string, extra: object = {}) => t.fiscal.post('/api/fiscal/outgoing/prepare').set(H).send({ salesOrderId, ...extra });
  const doc = async (t: T, id: string) => (await t.fiscal.get(`/api/fiscal/outgoing/${id}`).expect(200)).body;
  const transmit = (t: T, id: string) => t.fiscal.post(`/api/fiscal/outgoing/${id}/transmit`).set(H);
  const setToken = (t: T, token = focus.token) => t.fiscal.put(`/api/fiscal/establishments/${t.est}/provider`).set(H).send({ provider: 'FOCUS_NFE', tokenHomologacao: token });
  const issues = (d: any, level?: string) => (d.issues as any[]).filter((i) => !level || i.severity === level).map((i) => i.code);

  let A: T;
  let B: T;
  beforeAll(async () => {
    await focus.start();
    Object.assign(process.env, { FOCUS_NFE_BASE_HOMOLOGACAO: focus.base, FOCUS_NFE_POLL_ATTEMPTS: '3', FOCUS_NFE_POLL_DELAY_MS: '5' });
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    await admin.plan.update({ where: { code: 'trial' }, data: { limits: { users: 100, establishments: 20, warehouses: 20 } } });
    A = await setup('fpA');
    B = await setup('fpB');
    await approveRule(A); await approveRule(B);
    await approveRule(A, undefined, 'SP'); // NFC-e sem endereço do consumidor é operação interna (SP→SP)
  });
  afterAll(async () => {
    for (const k of ['FOCUS_NFE_BASE_HOMOLOGACAO', 'FOCUS_NFE_POLL_ATTEMPTS', 'FOCUS_NFE_POLL_DELAY_MS']) delete process.env[k];
    await admin.$disconnect();
    await app.close();
    await focus.stop();
  });
  beforeEach(() => { focus.mode = 'async'; focus.evilPath = false; focus.requests.length = 0; });

  describe('token do provedor', () => {
    it('guarda cifrado, nunca devolve, valida e exige permissão de gerenciar o fiscal', async () => {
      await A.buyer.put(`/api/fiscal/establishments/${A.est}/provider`).set(H).send({ provider: 'FOCUS_NFE', tokenHomologacao: focus.token }).expect(403);
      await A.accountant.put(`/api/fiscal/establishments/${A.est}/provider`).set(H).send({ provider: 'FOCUS_NFE', tokenHomologacao: focus.token }).expect(403);
      await A.fiscal.put(`/api/fiscal/establishments/${A.est}/provider`).set(H).send({ provider: 'FOCUS_NFE' }).expect(400); // sem token
      await A.fiscal.put(`/api/fiscal/establishments/${A.est}/provider`).set(H).send({ provider: 'FOCUS_NFE', tokenHomologacao: 'curto' }).expect(400);
      await A.fiscal.put(`/api/fiscal/establishments/${A.est}/provider`).set(H).send({ provider: 'FOCUS_NFE', tokenHomologacao: 'tem espaço no meio' }).expect(400);
      await A.fiscal.put(`/api/fiscal/establishments/${A.est}/provider`).set(H).send({ provider: 'OUTRO', tokenHomologacao: focus.token }).expect(400);
      const saved = (await setToken(A).expect(200)).body;
      expect(saved.homologacao).toEqual({ configured: true, hint: '…1234' });
      expect(saved.producao.configured).toBe(false);
      const got = (await A.fiscal.get(`/api/fiscal/establishments/${A.est}/provider`).expect(200)).body;
      expect(JSON.stringify(got)).not.toContain(focus.token);
      expect(got).toMatchObject({ provider: 'FOCUS_NFE', providerName: 'Focus NFe' });
      const row = await admin.fiscalProviderCredential.findFirstOrThrow({ where: { tenantId: A.tenantId } });
      expect(row.credsEnc).not.toContain(focus.token); // cifrado em repouso
      const cfg = (await A.fiscal.get(`/api/fiscal/establishments/${A.est}/config`).expect(200)).body;
      expect(JSON.stringify(cfg)).not.toContain(row.credsEnc);
      const audits = await admin.auditLog.findMany({ where: { tenantId: A.tenantId, action: 'fiscal.provider_configured' } });
      expect(audits).toHaveLength(1);
      expect(JSON.stringify(audits[0].metadata)).not.toContain(focus.token);
      await B.fiscal.get(`/api/fiscal/establishments/${A.est}/provider`).expect(404); // outra empresa
    });

    it('testa o token sem emitir nada: aceito, recusado e sem token no ambiente', async () => {
      const ok = (await A.fiscal.post(`/api/fiscal/establishments/${A.est}/provider/test`).set(H).send({}).expect(200)).body;
      expect(ok).toMatchObject({ ok: true, environment: 'HOMOLOGACAO' });
      expect(focus.requests.every((r) => r.method === 'GET')).toBe(true);
      const prod = (await A.fiscal.post(`/api/fiscal/establishments/${A.est}/provider/test`).set(H).send({ environment: 'PRODUCAO' }).expect(200)).body;
      expect(prod).toMatchObject({ ok: false, message: expect.stringMatching(/Nenhum token/) });
      await A.fiscal.put(`/api/fiscal/establishments/${A.est}/provider`).set(H).send({ provider: 'FOCUS_NFE', tokenHomologacao: 'TOKEN-ERRADO-0000' }).expect(200);
      expect((await A.fiscal.post(`/api/fiscal/establishments/${A.est}/provider/test`).set(H).send({}).expect(200)).body).toMatchObject({ ok: false, message: expect.stringMatching(/recusado/) });
      await setToken(A).expect(200); // volta ao token bom
    });

    it('sem token a assistente bloqueia e transmitir responde 424 sem consumir número; com token o certificado passa a ser do provedor', async () => {
      const before = (await B.fiscal.get(`/api/fiscal/establishments/${B.est}/config`).expect(200)).body;
      expect(before.readiness.find((r: any) => r.key === 'provider').status).toBe('BLOCKING');
      expect(before.readiness.find((r: any) => r.key === 'certificate').status).toBe('BLOCKING');
      const o = await order(B, 'NFE');
      const p = (await prepare(B, o).expect(200)).body;
      expect(issues(await doc(B, p.id), 'INFO')).toContain('PROVIDER_NOT_CONFIGURED');
      const r = await transmit(B, p.id).expect(424);
      expect(r.body.code).toBe('NOT_CONFIGURED');
      expect(await admin.fiscalSeries.count({ where: { tenantId: B.tenantId } })).toBe(0);

      const after = (await A.fiscal.get(`/api/fiscal/establishments/${A.est}/config`).expect(200)).body;
      expect(after.readiness.find((r: any) => r.key === 'provider').status).toBe('OK');
      expect(after.readiness.find((r: any) => r.key === 'certificate').status).toBe('OK');
    });
  });

  describe('NF-e (modelo 55)', () => {
    it('envia o documento com a referência do pedido, o provedor numera e a nota autorizada guarda chave, XML e DANFE', async () => {
      const o = await order(A, 'NFE');
      const p = (await prepare(A, o).expect(200)).body;
      const ready = await doc(A, p.id);
      expect(ready).toMatchObject({ model: '55', status: 'READY_TO_TRANSMIT' });
      expect(issues(ready, 'BLOCKING')).toEqual([]);
      expect(issues(ready, 'INFO')).toContain('PROVIDER_CERTIFICATE'); // certificado e CSC ficam no provedor

      const r = (await transmit(A, p.id).expect(200)).body;
      expect(r.status).toBe('AUTHORIZED');
      const sent = focus.requests.find((q) => q.method === 'POST')!;
      expect(sent.path).toBe('/v2/nfe');
      expect(sent.ref).toBe(p.id);
      expect(sent.auth).toBe(`Basic ${Buffer.from(`${focus.token}:`).toString('base64')}`);
      expect(sent.body).toMatchObject({
        natureza_operacao: 'VENDA DE MERCADORIA', tipo_documento: 1, finalidade_emissao: 1, local_destino: 2, consumidor_final: 0,
        cnpj_emitente: EST_CNPJ, nome_emitente: expect.stringContaining('fpA'), inscricao_estadual_emitente: '111222333444', regime_tributario_emitente: 1, uf_emitente: 'SP', municipio_emitente: 'Campinas',
        nome_destinatario: 'Cliente PJ', uf_destinatario: 'RJ', cep_destinatario: '20000000', indicador_inscricao_estadual_destinatario: 2,
        valor_produtos: 100, valor_total: 100, modalidade_frete: 9,
      });
      expect(sent.body.items).toHaveLength(1);
      expect(sent.body.items[0]).toMatchObject({ numero_item: 1, cfop: '6102', codigo_ncm: '73181500', unidade_comercial: 'UN', quantidade_comercial: 2, valor_unitario_comercial: 50, valor_bruto: 100, icms_origem: 0, icms_situacao_tributaria: '102', pis_situacao_tributaria: '49', cofins_situacao_tributaria: '49' });
      expect(sent.body.formas_pagamento).toEqual([]); // sem forma informada (a NF-e exige: ver o teste de pendência abaixo)
      expect(sent.body).not.toHaveProperty('numero'); // quem numera é o provedor
      expect(sent.body).not.toHaveProperty('serie');

      const d = await doc(A, p.id);
      expect(d).toMatchObject({ status: 'AUTHORIZED', authenticity: 'VERIFIED' });
      expect(d.accessKey).toHaveLength(44);
      expect(d.number).toBeGreaterThan(0);
      expect(d.providerState.danfePath).toBe(`/arquivos/danfe/${p.id}.pdf`);
      expect(await admin.fiscalSeries.count({ where: { tenantId: A.tenantId } })).toBe(0); // nenhuma numeração do sistema consumida
      expect(await admin.fiscalXmlFile.count({ where: { tenantId: A.tenantId, documentId: p.id, kind: 'AUTHORIZED' } })).toBe(1);
      const xml = await A.fiscal.get(`/api/fiscal/outgoing/${p.id}/file?kind=xml`).expect(200);
      expect(xml.headers['content-type']).toMatch(/xml/);
      expect(xml.headers['x-content-type-options']).toBe('nosniff');
      expect(xml.text).toContain('<nfeProc>');
      const danfe = await A.fiscal.get(`/api/fiscal/outgoing/${p.id}/file?kind=danfe`).expect(200);
      expect(danfe.headers['content-type']).toMatch(/pdf/);
      await B.fiscal.get(`/api/fiscal/outgoing/${p.id}/file?kind=xml`).expect(404);
      await request(app.getHttpServer()).get(`/api/fiscal/outgoing/${p.id}/file?kind=xml`).expect(401);
      await transmit(A, p.id).expect(409); // já autorizada
    });

    it('envia a forma de pagamento escolhida', async () => {
      const o = await order(A, 'NFE');
      const p = (await prepare(A, o, { paymentMethod: 'BOLETO' }).expect(200)).body;
      await transmit(A, p.id).expect(200);
      expect(focus.requests.find((q) => q.method === 'POST')!.body.formas_pagamento).toEqual([{ forma_pagamento: '15', valor_pagamento: 100 }]);
    });

    it('timeout/processando: não retransmite; a consulta pela referência autoriza sem novo envio', async () => {
      focus.mode = 'stuck';
      const o = await order(A, 'NFE');
      const p = (await prepare(A, o).expect(200)).body;
      expect((await transmit(A, p.id).expect(200)).body.status).toBe('PENDING_CONSULT');
      const posts = () => focus.requests.filter((q) => q.method === 'POST').length;
      expect(posts()).toBe(1);
      await transmit(A, p.id).expect(409); // proibido reenviar antes de consultar
      expect((await A.fiscal.post(`/api/fiscal/outgoing/${p.id}/consult`).set(H).expect(200)).body.status).toBe('PENDING_CONSULT'); // ainda processando
      focus.mode = 'async';
      const c = (await A.fiscal.post(`/api/fiscal/outgoing/${p.id}/consult`).set(H).expect(200)).body;
      expect(c).toMatchObject({ status: 'AUTHORIZED', result: 'AUTHORIZED' });
      expect(posts()).toBe(1);
      const d = await doc(A, p.id);
      expect(d.authProtocol).toBe('135260000000001');
      expect(d.accessKey).toHaveLength(44);
    });

    it('referência desconhecida no provedor libera o reenvio seguro; "já processada" vira consulta, não nota nova', async () => {
      focus.mode = 'down';
      const o = await order(A, 'NFE');
      const p = (await prepare(A, o).expect(200)).body;
      expect((await transmit(A, p.id).expect(200)).body.status).toBe('PENDING_CONSULT'); // 503: resposta desconhecida
      focus.mode = 'async';
      expect((await A.fiscal.post(`/api/fiscal/outgoing/${p.id}/consult`).set(H).expect(200)).body).toMatchObject({ status: 'READY_TO_TRANSMIT', result: 'NOT_FOUND' });
      expect((await transmit(A, p.id).expect(200)).body.status).toBe('AUTHORIZED');
      expect(focus.notes.size).toBeGreaterThan(0);

      focus.mode = 'pending';
      const o2 = await order(A, 'NFE');
      const p2 = (await prepare(A, o2).expect(200)).body;
      focus.notes.set(p2.id, { kind: 'nfe', body: {}, polls: 1 }); // o provedor já tem essa referência
      focus.mode = 'pending';
      expect((await transmit(A, p2.id).expect(200)).body.status).toBe('AUTHORIZED');
    });

    it('rejeição da SEFAZ/validação do provedor volta com o motivo e permite corrigir e reenviar', async () => {
      focus.mode = 'schema';
      const o = await order(A, 'NFE');
      const p = (await prepare(A, o).expect(200)).body;
      expect((await transmit(A, p.id).expect(200)).body.status).toBe('REJECTED');
      const d = await doc(A, p.id);
      expect(d.issues[0]).toMatchObject({ code: 'SEFAZ_REJECTION' });
      expect(d.issues[0].message).toMatch(/cep_destinatario: CEP inválido/);
      focus.mode = 'rejected';
      await A.fiscal.post(`/api/fiscal/outgoing/${p.id}/revalidate`).set(H).expect(200);
      expect((await transmit(A, p.id).expect(200)).body.status).toBe('REJECTED');
      expect((await doc(A, p.id)).authStatusCode).toBe('598');
      focus.mode = 'async';
      await A.fiscal.post(`/api/fiscal/outgoing/${p.id}/revalidate`).set(H).expect(200);
      expect((await transmit(A, p.id).expect(200)).body.status).toBe('AUTHORIZED');
    });

    it('token recusado pelo provedor não consome nada e deixa a nota para tentar de novo', async () => {
      const o = await order(A, 'NFE');
      const p = (await prepare(A, o).expect(200)).body;
      await A.fiscal.put(`/api/fiscal/establishments/${A.est}/provider`).set(H).send({ provider: 'FOCUS_NFE', tokenHomologacao: 'TOKEN-ERRADO-0000' }).expect(200);
      expect((await transmit(A, p.id).expect(200)).body.status).toBe('COMMUNICATION_FAILURE');
      expect(JSON.stringify((await doc(A, p.id)).providerState)).toMatch(/recusou o token/);
      await setToken(A).expect(200);
      expect((await transmit(A, p.id).expect(200)).body.status).toBe('AUTHORIZED');
    });

    it('tributo com valor (base/alíquota) é bloqueado na validação em vez de ser enviado incompleto', async () => {
      const T = await setup('fpC'); await setToken(T);
      await approveRule(T, { ICMS: { cst: '00', ratePct: 12 }, PIS: { cst: '01', ratePct: 1.65 }, COFINS: { cst: '01', ratePct: 7.6 } });
      const p = (await prepare(T, await order(T, 'NFE')).expect(200)).body;
      const d = await doc(T, p.id);
      expect(d.status).toBe('PENDING_VALIDATION');
      expect(issues(d, 'BLOCKING')).toContain('FOCUS_TAX_AMOUNTS');
      expect((await transmit(T, p.id).expect(409)).body.message).toBeDefined();
      expect(focus.requests.filter((q) => q.method === 'POST')).toHaveLength(0);
    });

    it('regra sem CST de PIS/COFINS ou item sem NCM bloqueia a NF-e', async () => {
      const T = await setup('fpD'); await setToken(T);
      await approveRule(T, { ICMS: { csosn: '102', ratePct: 0 } });
      const p = (await prepare(T, await order(T, 'NFE')).expect(200)).body;
      expect(issues(await doc(T, p.id), 'BLOCKING')).toContain('FOCUS_PIS_COFINS');
    });
  });

  describe('NFC-e (modelo 65)', () => {
    it('exige a forma de pagamento; consumidor sem cadastro é aceito; emissão síncrona devolve QR Code e consulta', async () => {
      const o = await order(A, 'NFCE');
      const p = (await prepare(A, o).expect(200)).body;
      const d0 = await doc(A, p.id);
      expect(d0).toMatchObject({ model: '65', status: 'PENDING_VALIDATION' });
      expect(issues(d0, 'BLOCKING')).toEqual(['FOCUS_PAYMENT']); // sem destinatário/endereço: não exigidos na NFC-e
      const again = (await prepare(A, o, { paymentMethod: 'PIX' }).expect(200)).body;
      expect(again.existing).toBe(true); // a forma de pagamento vale na primeira preparação

      const o2 = await order(A, 'NFCE');
      const p2 = (await prepare(A, o2, { paymentMethod: 'PIX' }).expect(200)).body;
      expect(issues(await doc(A, p2.id), 'BLOCKING')).toEqual([]);
      expect((await transmit(A, p2.id).expect(200)).body.status).toBe('AUTHORIZED');
      const sent = focus.requests.find((q) => q.method === 'POST')!;
      expect(sent.path).toBe('/v2/nfce');
      expect(sent.body).toMatchObject({ natureza_operacao: 'VENDA AO CONSUMIDOR', cnpj_emitente: EST_CNPJ, presenca_comprador: 4, modalidade_frete: 9, local_destino: 1 });
      expect(sent.body.formas_pagamento).toEqual([{ forma_pagamento: '17', valor_pagamento: 100 }]);
      expect(sent.body.items[0]).toMatchObject({ icms_origem: 0, icms_situacao_tributaria: '102', quantidade_tributavel: 2, unidade_tributavel: 'UN' });
      expect(sent.body.items[0]).not.toHaveProperty('pis_situacao_tributaria'); // não faz parte da NFC-e
      expect(sent.body).not.toHaveProperty('cpf_destinatario');
      expect(sent.body.data_emissao).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-03:00$/);
      const d = await doc(A, p2.id);
      expect(d.providerState.qrCodeUrl).toContain('nfce?p=');
      expect(d.accessKey).toHaveLength(44);
      expect(await admin.fiscalSeries.count({ where: { tenantId: A.tenantId, model: '65' } })).toBe(0);
    });

    it('NFC-e rejeitada na resposta 201 (status erro_autorizacao) é tratada como rejeição, não como sucesso', async () => {
      focus.mode = 'rejected';
      const p = (await prepare(A, await order(A, 'NFCE'), { paymentMethod: 'CASH' }).expect(200)).body;
      expect((await transmit(A, p.id).expect(200)).body.status).toBe('REJECTED');
      expect((await doc(A, p.id)).authStatusCode).toBe('598');
    });
  });

  describe('cancelamento e arquivos', () => {
    it('cancela nota autorizada (justificativa de 15+ caracteres) e libera o pedido para nova nota; só autorizada cancela', async () => {
      const o = await order(A, 'NFE');
      const p = (await prepare(A, o).expect(200)).body;
      await A.fiscal.post(`/api/fiscal/outgoing/${p.id}/cancel`).set(H).send({ reason: 'Erro de digitação da quantidade' }).expect(409); // ainda não autorizada
      await transmit(A, p.id).expect(200);
      await A.fiscal.post(`/api/fiscal/outgoing/${p.id}/cancel`).set(H).send({ reason: 'curta' }).expect(400);
      await A.buyer.post(`/api/fiscal/outgoing/${p.id}/cancel`).set(H).send({ reason: 'Erro de digitação da quantidade' }).expect(403);
      await B.fiscal.post(`/api/fiscal/outgoing/${p.id}/cancel`).set(H).send({ reason: 'Erro de digitação da quantidade' }).expect(404);
      expect((await A.fiscal.post(`/api/fiscal/outgoing/${p.id}/cancel`).set(H).send({ reason: 'Erro de digitação da quantidade' }).expect(200)).body.status).toBe('CANCELLED');
      expect(focus.requests.find((q) => q.method === 'DELETE')!.body).toEqual({ justificativa: 'Erro de digitação da quantidade' });
      const d = await doc(A, p.id);
      expect(d.status).toBe('CANCELLED');
      expect(d.providerState.cancelReason).toBe('Erro de digitação da quantidade');
      const again = (await prepare(A, o).expect(200)).body;
      expect(again.existing).toBe(false); // pedido pode ser faturado de novo
      await A.fiscal.post(`/api/fiscal/outgoing/${p.id}/cancel`).set(H).send({ reason: 'Erro de digitação da quantidade' }).expect(409); // já cancelada
    });

    it('nunca baixa arquivo de outro servidor: caminho vindo do provedor é validado', async () => {
      focus.evilPath = true;
      const p = (await prepare(A, await order(A, 'NFE')).expect(200)).body;
      expect((await transmit(A, p.id).expect(200)).body.status).toBe('AUTHORIZED'); // a nota autoriza mesmo sem o XML
      expect(await admin.fiscalXmlFile.count({ where: { tenantId: A.tenantId, documentId: p.id } })).toBe(0);
      const r = await A.fiscal.get(`/api/fiscal/outgoing/${p.id}/file?kind=xml`);
      expect([502, 404]).toContain(r.status);
      expect(focus.requests.some((q) => q.path.includes('evil'))).toBe(false);
    });
  });
});

/** CNPJ válido aleatório (para não colidir entre clientes da mesma empresa). */
function cnpj(): string {
  const base = Array.from({ length: 12 }, () => Math.floor(Math.random() * 10));
  const dv = (nums: number[]) => { const w = nums.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const s = nums.reduce((a, n, i) => a + n * w[i], 0) % 11; return s < 2 ? 0 : 11 - s; };
  const d1 = dv(base); const d2 = dv([...base, d1]);
  return [...base, d1, d2].join('');
}
