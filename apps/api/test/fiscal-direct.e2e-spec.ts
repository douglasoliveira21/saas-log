import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as forge from 'node-forge';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';
import { isValidChave } from '../src/fiscal/chave';
import { resetCaCache } from '../src/fiscal/sefaz/soap';
import { verifySignature } from '../src/fiscal/sefaz/signature';
import { validateAgainst } from '../src/fiscal/sefaz/xsd';
import { MockSefaz, startMockIbge } from './fixtures/mock-sefaz';

/**
 * ATENÇÃO: o servidor de teste IMITA a forma dos serviços da SEFAZ (SOAP 1.2 + TLS mútuo) mas NÃO é a SEFAZ. Ele valida o XML recebido contra o XSD
 * e a assinatura; as respostas são as que cada teste manda. Prova o NOSSO código, não que a SEFAZ real autorize a nota. Nenhuma comunicação real
 * com a SEFAZ foi feita (exige certificado A1 ICP-Brasil e credenciamento).
 */
const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);
let seq = 0;
const uid = () => `${run}${++seq}`;
const EST_CNPJ = '45723174000110';

const pfxCache = new Map<string, string>();
/** Certificado de TESTE com RSA de 2048 bits (o TLS do Node recusa chave de cliente menor; os A1 reais têm 2048). Gerado uma vez por titular. */
function makePfx(cn: string, password = 'p'): string {
  const hit = pfxCache.get(cn);
  if (hit) return hit;
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey; cert.serialNumber = '0' + Math.floor(Math.random() * 1e9).toString(16);
  cert.validity.notBefore = new Date(Date.now() - 86_400_000); cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
  const attrs = [{ name: 'commonName', value: cn }, { name: 'countryName', value: 'BR' }];
  cert.setSubject(attrs); cert.setIssuer(attrs); cert.sign(keys.privateKey, forge.md.sha256.create());
  const out = Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' })).getBytes(), 'binary').toString('base64');
  pfxCache.set(cn, out);
  return out;
}
function cnpj(): string {
  const base = Array.from({ length: 12 }, () => Math.floor(Math.random() * 10));
  const dv = (n: number[]) => { const w = n.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const s = n.reduce((a, x, i) => a + x * w[i], 0) % 11; return s < 2 ? 0 : 11 - s; };
  const d1 = dv(base); return [...base, d1, dv([...base, d1])].join('');
}

describe('Emissão direta na SEFAZ (MG) com servidor de teste: NF-e, NFC-e, cancelamento e inutilização', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  const sefaz = new MockSefaz();
  let ibge: Awaited<ReturnType<typeof startMockIbge>>;
  const agent = () => request.agent(app.getHttpServer());
  type Agent = ReturnType<typeof agent>;
  interface T { owner: Agent; tenantId: string; est: string; wh: string; fiscal: Agent; accountant: Agent }

  async function setup(label: string, uf = 'MG'): Promise<T> {
    const owner = agent();
    const reg = await owner.post('/api/auth/register').set(H).send({ companyName: `Co ${label} ${run}`, name: `Dono ${label}`, email: `${label}-${run}@teste.local`, password: PASSWORD }).expect(201);
    const company = await owner.post('/api/companies').set(H).send({ legalName: `${label} LTDA`, tradeName: label, taxRegime: 'SIMPLES_NACIONAL' }).expect(201);
    const mg = uf === 'MG';
    const est = await owner.post('/api/establishments').set(H).send({ companyId: company.body.id, kind: 'MATRIZ', name: 'Matriz', cnpj: EST_CNPJ, stateRegistration: '0623079040081', cnae: '4744-0/99', zipCode: mg ? '30110-000' : '13000-000', city: mg ? 'Belo Horizonte' : 'Campinas', state: uf, street: 'Rua A', number: '1', district: 'Centro' }).expect(201);
    const wh = (await owner.post('/api/warehouses').set(H).send({ establishmentId: est.body.id, code: 'CD01', name: 'Depósito' }).expect(201)).body.id;
    const roles = Object.fromEntries((await owner.get('/api/roles').expect(200)).body.map((r: any) => [r.key, r.id]));
    const user = async (k: string) => { const email = `${k}-${uid()}@teste.local`; await owner.post('/api/users').set(H).send({ name: `U ${k}`, email, password: PASSWORD, roleId: roles[k] }).expect(201); const a = agent(); await a.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200); return a; };
    return { owner, tenantId: reg.body.tenantId, est: est.body.id, wh, fiscal: await user('fiscal'), accountant: await user('accountant') };
  }

  async function approveRule(t: T, origin: string, dest: string, taxes: object = { ICMS: { csosn: '102', ratePct: 0 }, PIS: { cst: '49', ratePct: 0 }, COFINS: { cst: '49', ratePct: 0 } }) {
    const c = (await t.fiscal.post('/api/fiscal/rules').set(H).send({ rule: { name: `Venda ${origin}→${dest} ${uid()}`, operation: 'SALE', originUf: origin, destUf: dest }, version: { validFrom: '2026-01-01T00:00:00Z', sourceReference: 'Parecer contábil 12/2026 – simulado', config: { cfop: origin === dest ? '5102' : '6102', taxes } } }).expect(201)).body;
    await t.fiscal.post(`/api/fiscal/rules/versions/${c.versionId}/submit`).set(H).expect(200);
    await t.accountant.post(`/api/fiscal/rules/versions/${c.versionId}/approve`).set(H).expect(200);
  }
  const upload = (t: T, cn = `EMPRESA TESTE:${EST_CNPJ}`) => t.fiscal.post(`/api/fiscal/establishments/${t.est}/certificate`).set(H).send({ pfxBase64: makePfx(cn), password: 'p' });
  const useDirect = (t: T, extra: object = {}) => t.fiscal.put(`/api/fiscal/establishments/${t.est}/provider`).set(H).send({ provider: 'SEFAZ_DIRECT', ...extra });

  async function order(t: T, type: 'NFE' | 'NFCE') {
    const customerId = type === 'NFE'
      ? (await t.owner.post('/api/customers').set(H).send({ kind: 'PJ', name: 'Cliente PJ', document: cnpj(), zipCode: '20000-000', street: 'Rua B', number: '2', district: 'Centro', city: 'Rio de Janeiro', state: 'RJ', email: 'c@teste.com' }).expect(201)).body.id
      : (await t.owner.post('/api/customers').set(H).send({ kind: 'PF', name: `Consumidor ${uid()}` }).expect(201)).body.id;
    const p = (await t.owner.post('/api/products').set(H).send({ sku: `SD-${uid()}`, name: 'Parafuso M8', costPrice: 10, suggestedPrice: 50, ncm: '73181500', taxOrigin: 0 }).expect(201)).body.id as string;
    await t.owner.post('/api/stock/movements').set(H).send({ productId: p, warehouseId: t.wh, type: 'PURCHASE_ENTRY', quantity: 500 }).expect(201);
    const o = (await t.owner.post('/api/sales/orders').set(H).send({ customerId, warehouseId: t.wh, fiscalDocType: type, shipping: type === 'NFE' ? 10 : 0, items: [{ productId: p, quantity: 3, unitPrice: 33.33 }] }).expect(201)).body.id as string;
    await t.owner.post(`/api/sales/orders/${o}/submit`).set(H).expect(200);
    return o;
  }
  const prepare = (t: T, salesOrderId: string, extra: object = {}) => t.fiscal.post('/api/fiscal/outgoing/prepare').set(H).send({ salesOrderId, paymentMethod: 'PIX', ...extra });
  const doc = async (t: T, id: string) => (await t.fiscal.get(`/api/fiscal/outgoing/${id}`).expect(200)).body;
  const transmit = (t: T, id: string) => t.fiscal.post(`/api/fiscal/outgoing/${id}/transmit`).set(H);
  const consult = (t: T, id: string) => t.fiscal.post(`/api/fiscal/outgoing/${id}/consult`).set(H);
  const codes = (d: any, level?: string) => (d.issues as any[]).filter((i) => !level || i.severity === level).map((i) => i.code);
  const posts = () => sefaz.calls.filter((c) => c.path.endsWith('NFeAutorizacao4'));
  const xmlOf = async (id: string, kind = 'AUTHORIZED') => (await admin.fiscalXmlFile.findFirst({ where: { documentId: id, kind }, orderBy: { createdAt: 'desc' } }))?.content;

  let A: T;
  beforeAll(async () => {
    await sefaz.start();
    ibge = await startMockIbge();
    Object.assign(process.env, {
      FISCAL_SEFAZ_URL_OVERRIDE: JSON.stringify({ base: sefaz.base }), FISCAL_SEFAZ_CA_FILE: sefaz.caFile, IBGE_API_BASE: ibge.base,
      FISCAL_SEFAZ_POLL_ATTEMPTS: '2', FISCAL_SEFAZ_POLL_DELAY_MS: '5',
    });
    resetCaCache();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    admin = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
    await admin.plan.update({ where: { code: 'trial' }, data: { limits: { users: 100, establishments: 20, warehouses: 20 } } });
    A = await setup('sdA');
    await approveRule(A, 'MG', 'RJ');
    await approveRule(A, 'MG', 'MG');
  }, 60_000);
  afterAll(async () => {
    for (const k of ['FISCAL_SEFAZ_URL_OVERRIDE', 'FISCAL_SEFAZ_CA_FILE', 'IBGE_API_BASE', 'FISCAL_SEFAZ_POLL_ATTEMPTS', 'FISCAL_SEFAZ_POLL_DELAY_MS']) delete process.env[k];
    resetCaCache();
    await admin.$disconnect();
    await app.close();
    await sefaz.stop();
    ibge.server.close();
  });
  beforeEach(() => { sefaz.mode = 'authorize'; sefaz.calls.length = 0; });

  describe('cobertura nacional e configuração', () => {
    it('a matriz traz as 27 UFs × 2 modelos; só MG tem endereços verificados e nenhuma UF passa de "em desenvolvimento"', async () => {
      const r = (await A.fiscal.get('/api/fiscal/sefaz/coverage').expect(200)).body;
      expect(r.rows).toHaveLength(54);
      expect(new Set(r.rows.map((x: any) => x.uf)).size).toBe(27);
      const mg = r.rows.filter((x: any) => x.uf === 'MG');
      expect(mg.map((x: any) => x.state)).toEqual(['EM_DESENVOLVIMENTO', 'EM_DESENVOLVIMENTO']);
      expect(mg[0].lastVerified).toBe('2026-10-22');
      expect(r.rows.filter((x: any) => x.uf !== 'MG').every((x: any) => x.state === 'NAO_ANALISADO' && x.pending.length > 0)).toBe(true);
      expect(r.rows.some((x: any) => ['HOMOLOGACAO_APROVADA', 'PRODUCAO_HABILITADA'].includes(x.state))).toBe(false);
      expect(r.schemas.source).toMatch(/NÃO é o download oficial/);
      await request(app.getHttpServer()).get('/api/fiscal/sefaz/coverage').expect(401);
    });

    it('configura a emissão direta e o CSC (nunca devolvido); valida o CSC e exige permissão', async () => {
      await A.accountant.put(`/api/fiscal/establishments/${A.est}/provider`).set(H).send({ provider: 'SEFAZ_DIRECT' }).expect(403);
      await useDirect(A, { cscHomologacao: { id: 'x', token: 'ABC123456' } }).expect(400);
      await useDirect(A, { cscHomologacao: { id: '1', token: 'curto' } }).expect(400);
      const ok = await useDirect(A, { cscHomologacao: { id: '1', token: 'CSC-SECRETO-123456' } }).expect(200);
      expect(ok.body.provider).toBe('SEFAZ_DIRECT');
      const got = (await A.fiscal.get(`/api/fiscal/establishments/${A.est}/provider`).expect(200)).body;
      expect(got.csc.homologacao).toEqual({ configured: true, id: '1', hint: '…3456' });
      expect(JSON.stringify(got)).not.toContain('CSC-SECRETO');
      const row = await admin.fiscalProviderCredential.findFirstOrThrow({ where: { tenantId: A.tenantId } });
      expect(row.credsEnc).not.toContain('CSC-SECRETO');
    });

    it('o teste de comunicação consulta o status do serviço da UF usando o certificado A1 (TLS mútuo)', async () => {
      const before = (await A.fiscal.post(`/api/fiscal/establishments/${A.est}/provider/test`).set(H).send({}).expect(200)).body;
      expect(before.ok).toBe(false);
      expect(before.message).toMatch(/certificado/i);
      await upload(A).expect(201);
      const r = (await A.fiscal.post(`/api/fiscal/establishments/${A.est}/provider/test`).set(H).send({}).expect(200)).body;
      expect(r).toMatchObject({ ok: true });
      expect(r.message).toMatch(/serviço em operação/);
      const call = sefaz.calls.find((c) => c.path.endsWith('NFeStatusServico4'))!;
      expect(call.path).toBe('/nfe2/services/NFeStatusServico4'); // caminho oficial do SPED MG, só a base foi trocada
      expect(call.clientCn).toBe(`EMPRESA TESTE:${EST_CNPJ}`); // o certificado do estabelecimento foi o apresentado
      expect(call.action).toContain('application/soap+xml');
      expect(call.action).toContain('http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4/nfeStatusServicoNF');
      expect(call.body).toContain('<cUF>31</cUF>');
    });
  });

  describe('NF-e (modelo 55)', () => {
    it('monta, valida no XSD, assina, envia ao serviço certo e só marca autorizada com o protocolo; guarda o nfeProc', async () => {
      const o = await order(A, 'NFE');
      const p = (await prepare(A, o).expect(200)).body;
      const ready = await doc(A, p.id);
      expect(ready).toMatchObject({ model: '55', status: 'READY_TO_TRANSMIT' });
      expect(codes(ready, 'BLOCKING')).toEqual([]);

      const r = (await transmit(A, p.id).expect(200)).body;
      expect(r.status).toBe('AUTHORIZED');
      expect(posts()).toHaveLength(1);
      const call = posts()[0];
      expect(call.path).toBe('/nfe2/services/NFeAutorizacao4');
      expect(call.xmlValid).toBe(true); // o lote enviado é válido no XSD enviNFe
      expect(call.sigValid).toBe(true); // assinatura confere
      expect(call.xsdErrors).toEqual([]);
      expect(call.clientCn).toBe(`EMPRESA TESTE:${EST_CNPJ}`);
      expect(call.body).toContain('<indSinc>1</indSinc>');
      expect(call.body).toContain('NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL'); // destinatário em homologação
      expect(call.body).toContain('<cMunFG>3106200</cMunFG>'); // código IBGE de Belo Horizonte (API de municípios)
      expect(call.body).toContain('<cMun>3304557</cMun>'); // Rio de Janeiro
      expect(call.body).toContain('<vFrete>10.00</vFrete>');

      const d = await doc(A, p.id);
      expect(d.status).toBe('AUTHORIZED');
      expect(d.authProtocol).toMatch(/^13126/);
      expect(d.authenticity).toBe('VERIFIED');
      expect(isValidChave(d.accessKey)).toBe(true);
      expect(d.accessKey.slice(0, 2)).toBe('31'); // MG
      expect(d.accessKey.slice(20, 22)).toBe('55');
      expect(d.number).toBeGreaterThan(0);
      expect(await admin.fiscalSeries.count({ where: { tenantId: A.tenantId, model: '55' } })).toBe(1); // numeração do sistema, atômica

      const proc = (await xmlOf(p.id))!;
      expect(proc.startsWith('<nfeProc')).toBe(true);
      expect(proc).toContain('<protNFe');
      expect((await validateAgainst('procNFe_v4.00.xsd', proc)).errors).toEqual([]);
      expect(verifySignature(proc).valid).toBe(true);
      expect(await xmlOf(p.id, 'SIGNED')).toBeDefined();
      await transmit(A, p.id).expect(409);

      const xml = await A.fiscal.get(`/api/fiscal/outgoing/${p.id}/file?kind=xml`).expect(200);
      expect(xml.text).toContain(d.accessKey);
      expect(JSON.stringify(d)).not.toContain('PRIVATE KEY');
    });

    it('o XML nunca é enviado se o leiaute o recusa: NCM inválido bloqueia antes e a validação mostra o erro do XSD', async () => {
      const o = await order(A, 'NFE');
      const p = (await prepare(A, o).expect(200)).body;
      await admin.fiscalDocumentItem.updateMany({ where: { documentId: p.id }, data: { ncm: '123' } });
      await A.fiscal.post(`/api/fiscal/outgoing/${p.id}/revalidate`).set(H).expect(200);
      const d = await doc(A, p.id);
      expect(d.status).toBe('PENDING_VALIDATION');
      expect(codes(d, 'BLOCKING').some((c) => c === 'SEFAZ_XSD' || c === 'FOCUS_NCM_CFOP')).toBe(true);
      expect(posts()).toHaveLength(0);
      await transmit(A, p.id).expect(409);
    });

    it('rejeição e denegação voltam com o motivo oficial da SEFAZ e não autorizam', async () => {
      sefaz.mode = 'reject';
      const p = (await prepare(A, await order(A, 'NFE')).expect(200)).body;
      expect((await transmit(A, p.id).expect(200)).body.status).toBe('REJECTED');
      let d = await doc(A, p.id);
      expect(d.authStatusCode).toBe('539');
      expect(d.issues[0].message).toMatch(/Rejeição 539: Rejeicao: Duplicidade/);
      expect(await xmlOf(p.id)).toBeUndefined();

      sefaz.mode = 'denied';
      const p2 = (await prepare(A, await order(A, 'NFE')).expect(200)).body;
      expect((await transmit(A, p2.id).expect(200)).body.status).toBe('REJECTED');
      d = await doc(A, p2.id);
      expect(d.authStatusCode).toBe('301');
      expect(d.issues[0].message).toMatch(/Denegada/);
    });

    it('lote recebido (103) é acompanhado pelo recibo até autorizar', async () => {
      sefaz.mode = 'receipt';
      const p = (await prepare(A, await order(A, 'NFE')).expect(200)).body;
      expect((await transmit(A, p.id).expect(200)).body.status).toBe('AUTHORIZED');
      expect(sefaz.calls.some((c) => c.path.endsWith('NFeRetAutorizacao4'))).toBe(true);
      expect(posts()).toHaveLength(1);
    });

    it('processamento sem resposta final: não reenvia; a consulta pela chave autoriza e monta o nfeProc, sem novo número', async () => {
      sefaz.mode = 'stuck';
      const p = (await prepare(A, await order(A, 'NFE')).expect(200)).body;
      expect((await transmit(A, p.id).expect(200)).body.status).toBe('PENDING_CONSULT');
      const before = await doc(A, p.id);
      await transmit(A, p.id).expect(409); // proibido reenviar
      expect(posts()).toHaveLength(1);

      // a SEFAZ passou a conhecer a nota (autorizou depois)
      const key = before.accessKey as string;
      sefaz.known.set(key, { protocol: '131260000000555', prot: `<protNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>MG</verAplic><chNFe>${key}</chNFe><dhRecbto>2026-10-22T10:00:00-03:00</dhRecbto><nProt>131260000000555</nProt><digVal>AAAAAAAAAAAAAAAAAAAAAAAAAAA=</digVal><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe>` });
      const c = (await consult(A, p.id).expect(200)).body;
      expect(c).toMatchObject({ status: 'AUTHORIZED', result: 'AUTHORIZED' });
      const d = await doc(A, p.id);
      expect(d.authProtocol).toBe('131260000000555');
      expect(d.accessKey).toBe(before.accessKey);
      expect(d.number).toBe(before.number);
      const proc = (await xmlOf(p.id))!;
      expect(proc).toContain('131260000000555');
      expect((await validateAgainst('procNFe_v4.00.xsd', proc)).errors).toEqual([]);
      expect(posts()).toHaveLength(1);
    });

    it('falha de conexão ANTES do envio libera tentar de novo com a MESMA numeração; consulta "não consta" também libera', async () => {
      sefaz.mode = 'down'; // derruba a conexão depois do TLS: a requisição pode ter chegado ⇒ resposta desconhecida
      const p = (await prepare(A, await order(A, 'NFE')).expect(200)).body;
      expect((await transmit(A, p.id).expect(200)).body.status).toBe('PENDING_CONSULT');
      const first = await doc(A, p.id);
      sefaz.mode = 'authorize';
      expect((await consult(A, p.id).expect(200)).body).toMatchObject({ status: 'READY_TO_TRANSMIT', result: 'NOT_FOUND' });
      expect((await transmit(A, p.id).expect(200)).body.status).toBe('AUTHORIZED');
      const d = await doc(A, p.id);
      expect(d.accessKey).toBe(first.accessKey); // mesma chave e mesmo número: nada foi consumido a mais
      expect(d.number).toBe(first.number);
    });

    it('duas transmissões simultâneas enviam UMA vez e consomem um único número', async () => {
      const p = (await prepare(A, await order(A, 'NFE')).expect(200)).body;
      const before = (await admin.fiscalSeries.findFirst({ where: { tenantId: A.tenantId, model: '55' } }))!.last;
      const res = await Promise.all([transmit(A, p.id), transmit(A, p.id), transmit(A, p.id)]);
      expect(res.filter((r) => r.status === 200)).toHaveLength(1);
      expect(res.filter((r) => r.status === 409)).toHaveLength(2);
      expect(posts()).toHaveLength(1);
      expect((await admin.fiscalSeries.findFirst({ where: { tenantId: A.tenantId, model: '55' } }))!.last).toBe(before + 1);
    });
  });

  describe('cancelamento e inutilização', () => {
    it('cancela por evento assinado (110111), só autorizada, com justificativa de 15+ caracteres', async () => {
      const p = (await prepare(A, await order(A, 'NFE')).expect(200)).body;
      await A.fiscal.post(`/api/fiscal/outgoing/${p.id}/cancel`).set(H).send({ reason: 'Erro de digitação do pedido' }).expect(409); // ainda não autorizada
      await transmit(A, p.id).expect(200);
      await A.fiscal.post(`/api/fiscal/outgoing/${p.id}/cancel`).set(H).send({ reason: 'curta' }).expect(400);
      sefaz.calls.length = 0;
      expect((await A.fiscal.post(`/api/fiscal/outgoing/${p.id}/cancel`).set(H).send({ reason: 'Erro de digitação do pedido' }).expect(200)).body.status).toBe('CANCELLED');
      const ev = sefaz.calls.find((c) => c.path.endsWith('NFeRecepcaoEvento4'))!;
      expect(ev.xmlValid).toBe(true);
      expect(ev.sigValid).toBe(true);
      expect(ev.body).toContain('<tpEvento>110111</tpEvento>');
      expect(ev.body).toContain('<descEvento>Cancelamento</descEvento>');
      expect(ev.body).toMatch(/<nProt>13126\d+<\/nProt>/);
      expect((await doc(A, p.id)).status).toBe('CANCELLED');
      await A.fiscal.post(`/api/fiscal/outgoing/${p.id}/cancel`).set(H).send({ reason: 'Erro de digitação do pedido' }).expect(409);
    });

    it('inutiliza faixa sem nota, registra o protocolo e recusa faixa que já virou nota', async () => {
      const used = (await doc(A, (await (async () => { const p = (await prepare(A, await order(A, 'NFE')).expect(200)).body; await transmit(A, p.id).expect(200); return p; })()).id));
      await A.fiscal.post('/api/fiscal/inutilizacao').set(H).send({ establishmentId: A.est, model: '55', series: used.series, from: used.number, to: used.number, reason: 'Numeração pulada por erro' }).expect(409);
      const free = used.number + 50;
      sefaz.calls.length = 0;
      const r = (await A.fiscal.post('/api/fiscal/inutilizacao').set(H).send({ establishmentId: A.est, model: '55', series: used.series, from: free, to: free + 2, reason: 'Numeração pulada por erro' }).expect(200)).body;
      expect(r).toMatchObject({ fromNumber: free, toNumber: free + 2, protocol: '131260000000777', statusCode: '102' });
      const c = sefaz.calls.find((x) => x.path.endsWith('NFeInutilizacao4'))!;
      expect(c.xmlValid).toBe(true);
      expect(c.sigValid).toBe(true);
      expect((await A.fiscal.get('/api/fiscal/inutilizacao').expect(200)).body).toHaveLength(1);
      await A.fiscal.post('/api/fiscal/inutilizacao').set(H).send({ establishmentId: A.est, model: '55', series: 1, from: 5, to: 6, reason: 'curta' }).expect(400);
    });
  });

  describe('NFC-e (modelo 65)', () => {
    it('exige CSC; com CSC gera o QR Code (versão 2.00), assina depois do infNFeSupl e autoriza', async () => {
      const T = await setup('sdN');
      await approveRule(T, 'MG', 'MG');
      await upload(T).expect(201);
      await useDirect(T).expect(200); // sem CSC
      const o = await order(T, 'NFCE');
      const p = (await prepare(T, o).expect(200)).body;
      expect(codes(await doc(T, p.id), 'BLOCKING')).toContain('SEFAZ_CSC');
      await useDirect(T, { cscHomologacao: { id: '1', token: 'CSC-SECRETO-123456' } }).expect(200);
      await T.fiscal.post(`/api/fiscal/outgoing/${p.id}/revalidate`).set(H).expect(200);
      expect(codes(await doc(T, p.id), 'BLOCKING')).toEqual([]);

      sefaz.calls.length = 0;
      expect((await transmit(T, p.id).expect(200)).body.status).toBe('AUTHORIZED');
      const call = posts()[0];
      expect(call.path).toBe('/nfce/services/NFeAutorizacao4'); // serviço da NFC-e de MG (host próprio)
      expect(call.xmlValid).toBe(true);
      expect(call.sigValid).toBe(true);
      expect(call.body).toContain('<mod>65</mod>');
      expect(call.body).toContain('<tpImp>4</tpImp>');
      expect(call.body).toContain('NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL');
      expect(call.body).toMatch(/<qrCode>https:\/\/portalsped\.fazenda\.mg\.gov\.br\/portalnfce\/sistema\/qrcode\.xhtml\?p=\d{44}\|2\|2\|1\|[0-9A-F]{40}<\/qrCode>/);
      expect(call.body.indexOf('</infNFeSupl>')).toBeLessThan(call.body.indexOf('<Signature'));
      const d = await doc(T, p.id);
      expect(d.accessKey.slice(20, 22)).toBe('65');
      expect(await admin.fiscalSeries.count({ where: { tenantId: T.tenantId, model: '65' } })).toBe(1);
    });
  });

  describe('UF sem cobertura e segurança', () => {
    it('estabelecimento fora de MG é bloqueado com a explicação (nada é enviado)', async () => {
      const T = await setup('sdS', 'SP');
      await approveRule(T, 'SP', 'RJ');
      await upload(T).expect(201);
      await useDirect(T).expect(200);
      const p = (await prepare(T, await order(T, 'NFE')).expect(200)).body;
      const d = await doc(T, p.id);
      expect(d.status).toBe('PENDING_VALIDATION');
      expect(codes(d, 'BLOCKING')).toContain('SEFAZ_UF');
      expect((d.issues as any[]).find((i) => i.code === 'SEFAZ_UF').message).toMatch(/ainda não foi implementada para SP/);
      await transmit(T, p.id).expect(409);
      expect(sefaz.calls).toHaveLength(0);
      expect((await T.fiscal.post(`/api/fiscal/establishments/${T.est}/provider/test`).set(H).send({}).expect(200)).body.ok).toBe(false);
    });

    it('sem certificado a emissão direta não transmite (424) e sem provedor nada é consumido; certificado de uma empresa não serve a outra', async () => {
      const T = await setup('sdC');
      await approveRule(T, 'MG', 'RJ');
      await useDirect(T).expect(200); // sem certificado
      const p = (await prepare(T, await order(T, 'NFE')).expect(200)).body;
      expect(codes(await doc(T, p.id), 'INFO')).toContain('PROVIDER_NOT_CONFIGURED');
      expect((await transmit(T, p.id).expect(424)).body.code).toBe('NOT_CONFIGURED');
      expect(await admin.fiscalSeries.count({ where: { tenantId: T.tenantId } })).toBe(0);
      await A.fiscal.get(`/api/fiscal/outgoing/${p.id}`).expect(404); // isolamento entre empresas
      expect(sefaz.calls).toHaveLength(0);
    });
  });
});
