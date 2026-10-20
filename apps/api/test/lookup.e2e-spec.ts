import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';

const PASSWORD = 'Senha#Segura123';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);

/** SERVIDOR SIMULADO (teste): imita BrasilAPI e ViaCEP. Prova o nosso código — não o comportamento real das APIs públicas. */
describe('Consulta de CNPJ/CEP e padronização de contatos', () => {
  let app: INestApplication;
  let fake: Server;
  const hits: string[] = [];
  let primaryDown = false;
  let viacepDown = false;
  const agent = () => request.agent(app.getHttpServer());

  beforeAll(async () => {
    fake = createServer((req, res) => {
      hits.push(req.url!);
      const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      const u = req.url!;
      if (u.startsWith('/api/cnpj/v1/')) {
        if (u.endsWith('11222333000181')) return json(200, { cnpj: '11222333000181', razao_social: 'FORNECEDOR TESTE LTDA', nome_fantasia: 'FORN TESTE', cnae_fiscal: 4744099, cnae_fiscal_descricao: 'Comércio varejista de ferragens', ddd_telefone_1: '1933334444', email: 'FORN@TESTE.COM', descricao_situacao_cadastral: 'ATIVA', descricao_identificador_matriz_filial: 'MATRIZ', cep: '13015904', logradouro: 'RUA BARAO DE JAGUARA', numero: '1000', bairro: 'CENTRO', municipio: 'CAMPINAS', uf: 'SP' });
        if (u.endsWith('45723174000110')) return json(500, { message: 'erro interno' });
        return json(404, { message: 'CNPJ não encontrado' });
      }
      if (u.startsWith('/api/cep/v2/')) {
        if (primaryDown) return json(503, {});
        if (u.endsWith('01001000')) return json(200, { cep: '01001000', state: 'SP', city: 'São Paulo', neighborhood: 'Sé', street: 'Praça da Sé' });
        return json(404, { message: 'CEP não encontrado' });
      }
      if (u.startsWith('/ws/')) {
        if (viacepDown) return json(500, {});
        if (u.includes('20040020')) return json(200, { cep: '20040-020', logradouro: 'Rua da Assembleia', bairro: 'Centro', localidade: 'Rio de Janeiro', uf: 'RJ' });
        return json(200, { erro: true });
      }
      return json(404, {});
    });
    await new Promise<void>((r) => fake.listen(0, r));
    const port = (fake.address() as { port: number }).port;
    process.env.LOOKUP_BRASILAPI_BASE = `http://127.0.0.1:${port}`;
    process.env.LOOKUP_VIACEP_BASE = `http://127.0.0.1:${port}`;
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
  });
  afterAll(async () => {
    await app.close();
    await new Promise((r) => fake.close(r));
  });

  let owner: ReturnType<typeof agent>;
  beforeAll(async () => {
    owner = agent();
    await owner.post('/api/auth/register').set(H).send({ companyName: `Co lk ${run}`, name: 'Dono Lookup', email: `lk-${run}@teste.local`, password: PASSWORD }).expect(201);
  });

  describe('CNPJ', () => {
    it('exige autenticação e valida os dígitos antes de consultar', async () => {
      await agent().get('/api/lookup/cnpj/11222333000181').expect(401);
      const before = hits.length;
      await owner.get('/api/lookup/cnpj/11222333000182').expect(400);
      await owner.get('/api/lookup/cnpj/123').expect(400);
      expect(hits.length).toBe(before); // nada foi enviado ao serviço externo
    });

    it('devolve dados normalizados (aceita máscara) e usa cache na repetição', async () => {
      const before = hits.length;
      const r = (await owner.get(`/api/lookup/cnpj/${encodeURIComponent('11.222.333/0001-81')}`).expect(200)).body;
      expect(r).toMatchObject({ cnpj: '11222333000181', legalName: 'FORNECEDOR TESTE LTDA', tradeName: 'FORN TESTE', email: 'forn@teste.com', phone: '1933334444', cnae: '4744099', active: true, branch: 'MATRIZ', source: 'BrasilAPI' });
      expect(r.address).toMatchObject({ zipCode: '13015904', street: 'Rua Barao de Jaguara', district: 'Centro', city: 'Campinas', state: 'SP' });
      expect(r.stateRegistration).toBeUndefined(); // IE e regime tributário não são inventados
      await owner.get('/api/lookup/cnpj/11222333000181').expect(200);
      expect(hits.length).toBe(before + 1);
    });

    it('CNPJ válido inexistente ⇒ 404; falha do serviço ⇒ 503 com orientação', async () => {
      const nf = await owner.get('/api/lookup/cnpj/04252011000110').expect(404);
      expect(nf.body.message).toMatch(/não encontrado/);
      const down = await owner.get('/api/lookup/cnpj/45723174000110').expect(503);
      expect(down.body.message).toMatch(/Preencha manualmente|indisponível/);
    });
  });

  describe('CEP', () => {
    it('consulta a fonte principal, valida o formato e usa cache', async () => {
      await owner.get('/api/lookup/cep/123').expect(400);
      const r = (await owner.get('/api/lookup/cep/01001-000').expect(200)).body;
      expect(r).toMatchObject({ zipCode: '01001000', street: 'Praça da Sé', district: 'Sé', city: 'São Paulo', state: 'SP', source: 'BrasilAPI' });
      const n = hits.length;
      await owner.get('/api/lookup/cep/01001000').expect(200);
      expect(hits.length).toBe(n);
    });

    it('usa o ViaCEP quando a fonte principal não conhece ou cai; ambas fora ⇒ 503; desconhecido ⇒ 404', async () => {
      expect((await owner.get('/api/lookup/cep/20040020').expect(200)).body).toMatchObject({ street: 'Rua da Assembleia', city: 'Rio de Janeiro', state: 'RJ', source: 'ViaCEP' });
      primaryDown = true;
      expect((await owner.get('/api/lookup/cep/20040020').expect(200)).body.source).toBe('ViaCEP'); // cache da consulta anterior
      await owner.get('/api/lookup/cep/30130010').expect(404); // principal fora, ViaCEP não conhece
      viacepDown = true;
      await owner.get('/api/lookup/cep/40020000').expect(503);
      primaryDown = false; viacepDown = false;
      await owner.get('/api/lookup/cep/99999999').expect(404);
    });
  });

  describe('padronização ao gravar', () => {
    it('telefone e CEP são gravados só com dígitos; telefone inválido é recusado', async () => {
      await owner.post('/api/customers').set(H).send({ kind: 'PF', name: 'Maria', phone: '99999-9999' }).expect(400);
      const c = (await owner.post('/api/customers').set(H).send({ kind: 'PJ', name: 'Cliente Máscara', document: '11.222.333/0001-81', phone: '(19) 99999-8888', zipCode: '13015-904', street: 'Rua A', city: 'Campinas', state: 'sp' }).expect(201)).body;
      expect(c).toMatchObject({ document: '11222333000181', phone: '19999998888', zipCode: '13015904', state: 'SP' });
      const s = (await owner.post('/api/suppliers').set(H).send({ legalName: 'Forn Tel', phone: '+55 (11) 3333-4444' }).expect(201)).body.id;
      const list = (await owner.get('/api/suppliers').expect(200)).body;
      expect((list.items ?? list).find((x: any) => x.id === s).phone).toBe('1133334444');
      const co = (await owner.post('/api/companies').set(H).send({ legalName: 'Empresa Tel', contactPhone: '(11) 3333-4444' }).expect(201)).body;
      expect(co.contactPhone).toBe('1133334444');
      await owner.post('/api/companies').set(H).send({ legalName: 'Empresa Ruim', contactPhone: '123' }).expect(400);
    });
  });
});
