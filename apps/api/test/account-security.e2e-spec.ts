import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';
import { Mailer } from '../src/notify/mailer';
import { totpAt } from '../src/notify/totp';

const PASSWORD = 'Senha#Segura123';
const NEW_PASSWORD = 'Outra#Senha456';
const H = { 'x-dh-csrf': '1' };
const run = Date.now().toString(36);

describe('Conta e segurança: recuperação de senha, convite por e-mail e segundo fator', () => {
  let app: INestApplication;
  const agent = () => request.agent(app.getHttpServer());
  type Agent = ReturnType<typeof agent>;
  let owner: Agent; let ownerEmail: string; let tenantId: string;
  const mailTo = (to: string) => Mailer.outbox.filter((m) => m.to === to);
  const tokenIn = (text: string, key = 'token') => decodeURIComponent(new RegExp(`${key}=([^\\s&"]+)`).exec(text)![1]);

  async function register(label: string) {
    const a = agent(); const email = `${label}-${run}@teste.local`;
    const r = await a.post('/api/auth/register').set(H).send({ companyName: `Co ${label} ${run}`, name: `Dono ${label}`, email, password: PASSWORD }).expect(201);
    return { a, email, tenantId: r.body.tenantId as string };
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.listen(0);
    ({ a: owner, email: ownerEmail, tenantId } = await register('acc'));
  }, 60_000);
  afterAll(async () => { await app.close(); });
  beforeEach(() => { Mailer.outbox.length = 0; Mailer.failNext = null; });

  describe('recuperação de senha', () => {
    it('responde igual para e-mail desconhecido (nada é enviado) e envia o link para o cadastrado', async () => {
      const a = await agent().post('/api/auth/forgot-password').set(H).send({ email: `ninguem-${run}@teste.local` }).expect(200);
      const b = await agent().post('/api/auth/forgot-password').set(H).send({ email: ownerEmail }).expect(200);
      expect(a.body).toEqual(b.body);
      expect(Mailer.outbox).toHaveLength(1);
      expect(Mailer.outbox[0].to).toBe(ownerEmail);
      expect(Mailer.outbox[0].text).toContain('/redefinir-senha?token=');
    });

    it('troca a senha com o link: política de senha, uso único, encerra sessões e a senha antiga deixa de valer', async () => {
      const u = await register('rec');
      Mailer.outbox.length = 0;
      await agent().post('/api/auth/forgot-password').set(H).send({ email: u.email }).expect(200);
      const token = tokenIn(mailTo(u.email)[0].text);
      await agent().post('/api/auth/reset-password').set(H).send({ token, password: '123' }).expect(400); // fraca
      await agent().post('/api/auth/reset-password').set(H).send({ token: 'invalido', password: NEW_PASSWORD }).expect(400);
      await agent().post('/api/auth/reset-password').set(H).send({ token, password: NEW_PASSWORD }).expect(200);
      await agent().post('/api/auth/reset-password').set(H).send({ token, password: 'Mais#Uma789' }).expect(400); // uso único
      await agent().post('/api/auth/login').set(H).send({ email: u.email, password: PASSWORD }).expect(401);
      await agent().post('/api/auth/login').set(H).send({ email: u.email, password: NEW_PASSWORD }).expect(200);
      await u.a.post('/api/auth/refresh').set(H).expect(401); // sessão antiga encerrada
    });

    it('limita a 3 pedidos por hora por usuário', async () => {
      const u = await register('lim');
      Mailer.outbox.length = 0;
      for (let i = 0; i < 5; i++) await agent().post('/api/auth/forgot-password').set(H).send({ email: u.email }).expect(i < 4 ? 200 : 200);
      expect(mailTo(u.email).length).toBe(3);
    });
  });

  describe('convite de usuário por e-mail', () => {
    let roleId: string;
    beforeAll(async () => {
      roleId = (await owner.get('/api/roles').expect(200)).body.find((r: any) => r.key === 'salesperson').id;
    });

    it('convida, o convidado define a senha, entra com o papel certo e o link só vale uma vez', async () => {
      const email = `conv-${run}@teste.local`;
      const r = (await owner.post('/api/users/invites').set(H).send({ name: 'Convidada', email, roleId }).expect(200)).body;
      expect(r.emailSent).toBe(true);
      const token = tokenIn(mailTo(email)[0].text);
      expect(token.startsWith(tenantId)).toBe(true);
      expect((await owner.get('/api/users/invites').expect(200)).body.map((i: any) => i.email)).toContain(email);
      const info = (await agent().post('/api/auth/invite/preview').set(H).send({ token }).expect(200)).body;
      expect(info).toMatchObject({ email, existingUser: false });
      await agent().post('/api/auth/invite/accept').set(H).send({ token, password: 'fraca' }).expect(400);
      await agent().post('/api/auth/invite/accept').set(H).send({ token, password: PASSWORD }).expect(200);
      await agent().post('/api/auth/invite/accept').set(H).send({ token, password: PASSWORD }).expect(400); // já usado
      const guest = agent();
      await guest.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200);
      const me = (await guest.get('/api/auth/me').expect(200)).body;
      expect(me.role.key).toBe('salesperson');
      expect((await owner.get('/api/users/invites').expect(200)).body.map((i: any) => i.email)).not.toContain(email);
      await owner.post('/api/users/invites').set(H).send({ name: 'Convidada', email, roleId }).expect(409); // já é membro
      await guest.get('/api/users/invites').expect(403); // sem permissão de gerir usuários
    });

    it('revogado ou reenviado invalida o link anterior; se o e-mail falhar, o administrador recebe o link', async () => {
      const email = `rev-${run}@teste.local`;
      await owner.post('/api/users/invites').set(H).send({ name: 'Rev', email, roleId }).expect(200);
      const first = tokenIn(mailTo(email)[0].text);
      await owner.post('/api/users/invites').set(H).send({ name: 'Rev', email, roleId }).expect(200); // reenvio
      await agent().post('/api/auth/invite/accept').set(H).send({ token: first, password: PASSWORD }).expect(400);
      const second = tokenIn(mailTo(email)[1].text);
      const list = (await owner.get('/api/users/invites').expect(200)).body.filter((i: any) => i.email === email);
      expect(list).toHaveLength(1);
      await owner.delete(`/api/users/invites/${list[0].id}`).set(H).expect(200);
      await agent().post('/api/auth/invite/accept').set(H).send({ token: second, password: PASSWORD }).expect(400);

      Mailer.failNext = 'servidor de e-mail fora do ar';
      const email2 = `falha-${run}@teste.local`;
      const r = (await owner.post('/api/users/invites').set(H).send({ name: 'Falha', email: email2, roleId }).expect(200)).body;
      expect(r).toMatchObject({ emailSent: false, reason: expect.stringContaining('fora do ar') });
      expect(r.link).toContain('/convite?token=');
    });

    it('papel acima do seu não pode ser convidado e o token de uma empresa não vale em outra', async () => {
      const ownerRole = (await owner.get('/api/roles').expect(200)).body.find((r: any) => r.key === 'owner').id;
      const other = await register('outra');
      const rolesB = (await other.a.get('/api/roles').expect(200)).body;
      // convidado comum tentando convidar com papel de outra empresa
      await owner.post('/api/users/invites').set(H).send({ name: 'X', email: `x-${run}@teste.local`, roleId: rolesB[0].id }).expect(400);
      expect(ownerRole).toBeTruthy();
      const email = `cross-${run}@teste.local`;
      await owner.post('/api/users/invites').set(H).send({ name: 'Cross', email, roleId }).expect(200);
      const token = tokenIn(mailTo(email)[0].text);
      const forged = `${other.tenantId}.${token.split('.').slice(1).join('.')}`;
      await agent().post('/api/auth/invite/accept').set(H).send({ token: forged, password: PASSWORD }).expect(400);
      await agent().post('/api/auth/invite/preview').set(H).send({ token: 'lixo' }).expect(400);
    });
  });

  describe('segundo fator (aplicativo autenticador)', () => {
    it('ativa com o QR code, exige o código no login, aceita código de recuperação uma vez e bloqueia reuso do mesmo código', async () => {
      const u = await register('mfa');
      expect((await u.a.get('/api/auth/mfa').expect(200)).body.enabled).toBe(false);
      await u.a.post('/api/auth/mfa/enable').set(H).send({ code: '123456' }).expect(400); // sem configurar
      const setup = (await u.a.post('/api/auth/mfa/setup').set(H).expect(200)).body;
      expect(setup.qrDataUrl).toMatch(/^data:image\/png;base64,/);
      expect(setup.otpauthUrl).toContain(setup.secret);
      await u.a.post('/api/auth/mfa/enable').set(H).send({ code: '000000' }).expect(400);
      const { recoveryCodes } = (await u.a.post('/api/auth/mfa/enable').set(H).send({ code: totpAt(setup.secret, Date.now()) }).expect(200)).body;
      expect(recoveryCodes).toHaveLength(8);
      expect((await u.a.get('/api/auth/mfa').expect(200)).body).toMatchObject({ enabled: true, recoveryCodesLeft: 8 });
      expect((await u.a.get('/api/auth/me').expect(200)).body.user.mfaEnabled).toBe(true);

      // login: a senha sozinha não abre sessão
      const a = agent();
      const step1 = (await a.post('/api/auth/login').set(H).send({ email: u.email, password: PASSWORD }).expect(200)).body;
      expect(step1.mfaRequired).toBe(true);
      expect(step1.mfaToken).toBeTruthy();
      await a.get('/api/auth/me').expect(401);
      await a.post('/api/auth/mfa/verify').set(H).send({ mfaToken: step1.mfaToken, code: '000000' }).expect(401);
      await a.post('/api/auth/mfa/verify').set(H).send({ mfaToken: 'lixo', code: '000000' }).expect(401);
      const next = totpAt(setup.secret, Date.now() + 30_000); // janela seguinte (a atual já foi usada na ativação)
      await a.post('/api/auth/mfa/verify').set(H).send({ mfaToken: step1.mfaToken, code: next }).expect(200);
      await a.get('/api/auth/me').expect(200);
      // o mesmo código não vale de novo
      const b = agent();
      const again = (await b.post('/api/auth/login').set(H).send({ email: u.email, password: PASSWORD }).expect(200)).body;
      await b.post('/api/auth/mfa/verify').set(H).send({ mfaToken: again.mfaToken, code: next }).expect(401);

      // código de recuperação: vale uma vez
      const c = agent();
      const t3 = (await c.post('/api/auth/login').set(H).send({ email: u.email, password: PASSWORD }).expect(200)).body.mfaToken;
      await c.post('/api/auth/mfa/verify').set(H).send({ mfaToken: t3, code: recoveryCodes[0] }).expect(200);
      const d = agent();
      const t4 = (await d.post('/api/auth/login').set(H).send({ email: u.email, password: PASSWORD }).expect(200)).body.mfaToken;
      await d.post('/api/auth/mfa/verify').set(H).send({ mfaToken: t4, code: recoveryCodes[0] }).expect(401);
      expect((await u.a.get('/api/auth/mfa').expect(200)).body.recoveryCodesLeft).toBe(7);
    });

    it('desativar exige senha e código; depois o login volta a ser só com a senha. O token do 2º passo não serve como sessão', async () => {
      const u = await register('mfa2');
      const setup = (await u.a.post('/api/auth/mfa/setup').set(H).expect(200)).body;
      await u.a.post('/api/auth/mfa/enable').set(H).send({ code: totpAt(setup.secret, Date.now()) }).expect(200);
      const a = agent();
      const { mfaToken } = (await a.post('/api/auth/login').set(H).send({ email: u.email, password: PASSWORD }).expect(200)).body;
      await agent().get('/api/auth/me').set('Authorization', `Bearer ${mfaToken}`).expect(401);
      await u.a.post('/api/auth/mfa/disable').set(H).send({ password: 'errada', code: totpAt(setup.secret, Date.now() + 30_000) }).expect(401);
      await u.a.post('/api/auth/mfa/disable').set(H).send({ password: PASSWORD, code: '000000' }).expect(401);
      await u.a.post('/api/auth/mfa/disable').set(H).send({ password: PASSWORD, code: totpAt(setup.secret, Date.now() + 30_000) }).expect(200);
      const r = (await agent().post('/api/auth/login').set(H).send({ email: u.email, password: PASSWORD }).expect(200)).body;
      expect(r.mfaRequired).toBeUndefined();
    });

    it('erros repetidos bloqueiam a conta por alguns minutos', async () => {
      const u = await register('mfa3');
      const setup = (await u.a.post('/api/auth/mfa/setup').set(H).expect(200)).body;
      await u.a.post('/api/auth/mfa/enable').set(H).send({ code: totpAt(setup.secret, Date.now()) }).expect(200);
      const a = agent();
      const { mfaToken } = (await a.post('/api/auth/login').set(H).send({ email: u.email, password: PASSWORD }).expect(200)).body;
      for (let i = 0; i < 5; i++) await a.post('/api/auth/mfa/verify').set(H).send({ mfaToken, code: '000000' }).expect(401);
      await a.post('/api/auth/mfa/verify').set(H).send({ mfaToken, code: totpAt(setup.secret, Date.now() + 30_000) }).expect(429);
    });
  });

  describe('perfil, troca de senha e foto', () => {
    const fakePng = (size = 400, w = 200, h = 200) => { const b = Buffer.alloc(size, 7); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };

    it('edita nome e telefone, valida e reflete em /me; o e-mail não muda por aqui', async () => {
      const u = await register('prof');
      await u.a.patch('/api/auth/profile').set(H).send({ name: 'Maria Souza', phone: '(11) 98888-7777' }).expect(200);
      const me = (await u.a.get('/api/auth/me').expect(200)).body.user;
      expect(me).toMatchObject({ name: 'Maria Souza', phone: '11988887777', email: u.email });
      await u.a.patch('/api/auth/profile').set(H).send({ name: 'A' }).expect(400);
      await u.a.patch('/api/auth/profile').set(H).send({ phone: '123' }).expect(400);
      await u.a.patch('/api/auth/profile').set(H).send({}).expect(400);
      await u.a.patch('/api/auth/profile').set(H).send({ email: 'outro@x.com' }).expect(400); // campo desconhecido é recusado
      await u.a.patch('/api/auth/profile').set(H).send({ phone: '' }).expect(200);
      expect((await u.a.get('/api/auth/me').expect(200)).body.user.phone).toBeNull();
    });

    it('troca a senha exigindo a atual, encerra as outras sessões e mantém a de agora', async () => {
      const u = await register('pwd');
      const other = agent(); await other.post('/api/auth/login').set(H).send({ email: u.email, password: PASSWORD }).expect(200);
      await u.a.post('/api/auth/change-password').set(H).send({ currentPassword: 'errada', newPassword: NEW_PASSWORD }).expect(401);
      await u.a.post('/api/auth/change-password').set(H).send({ currentPassword: PASSWORD, newPassword: '123' }).expect(400);
      await u.a.post('/api/auth/change-password').set(H).send({ currentPassword: PASSWORD, newPassword: PASSWORD }).expect(400);
      await u.a.post('/api/auth/change-password').set(H).send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(200);
      await u.a.post('/api/auth/refresh').set(H).expect(200); // esta sessão continua
      await other.post('/api/auth/refresh').set(H).expect(401); // a outra caiu
      await agent().post('/api/auth/login').set(H).send({ email: u.email, password: PASSWORD }).expect(401);
      await agent().post('/api/auth/login').set(H).send({ email: u.email, password: NEW_PASSWORD }).expect(200);
    });

    it('erros repetidos na senha atual bloqueiam por alguns minutos', async () => {
      const u = await register('pwd2');
      for (let i = 0; i < 5; i++) await u.a.post('/api/auth/change-password').set(H).send({ currentPassword: 'errada', newPassword: NEW_PASSWORD }).expect(401);
      await u.a.post('/api/auth/change-password').set(H).send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }).expect(429);
    });

    it('foto de perfil: valida tipo/tamanho, aparece em /me, colegas da empresa veem e estranhos não; remover apaga', async () => {
      const u = await register('foto');
      const b64 = (b: Buffer) => b.toString('base64');
      await u.a.get('/api/auth/avatar').expect(404);
      await u.a.put('/api/auth/avatar').set(H).send({ contentType: 'image/png', contentBase64: b64(fakePng()) }).expect(200);
      await u.a.put('/api/auth/avatar').set(H).send({ contentType: 'image/jpeg', contentBase64: b64(fakePng()) }).expect(400); // é PNG
      await u.a.put('/api/auth/avatar').set(H).send({ contentType: 'image/png', contentBase64: b64(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'.padEnd(200, ' '))) }).expect(400);
      await u.a.put('/api/auth/avatar').set(H).send({ contentType: 'image/png', contentBase64: b64(fakePng(600 * 1024)) }).expect(400); // grande demais
      await u.a.put('/api/auth/avatar').set(H).send({ contentType: 'image/png', contentBase64: b64(fakePng(400, 3000, 3000)) }).expect(400);
      await u.a.put('/api/auth/avatar').set(H).send({ contentType: 'image/png', contentBase64: '***' }).expect(400);
      const me = (await u.a.get('/api/auth/me').expect(200)).body.user;
      expect(me.avatarVersion).toEqual(expect.any(Number));
      const res = await u.a.get('/api/auth/avatar').expect(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect((res.body as Buffer).equals(fakePng())).toBe(true);
      // colega da mesma empresa
      const roles = Object.fromEntries((await u.a.get('/api/roles').expect(200)).body.map((r: any) => [r.key, r.id]));
      const email = `colega-${run}@teste.local`;
      await u.a.post('/api/users').set(H).send({ name: 'Colega', email, password: PASSWORD, roleId: roles.admin }).expect(201);
      const colega = agent(); await colega.post('/api/auth/login').set(H).send({ email, password: PASSWORD }).expect(200);
      await colega.get(`/api/auth/avatar/${me.id}`).expect(200);
      const stranger = await register('estranho');
      await stranger.a.get(`/api/auth/avatar/${me.id}`).expect(404);
      await u.a.delete('/api/auth/avatar').set(H).expect(200);
      await u.a.get('/api/auth/avatar').expect(404);
      await u.a.delete('/api/auth/avatar').set(H).expect(404);
      expect((await u.a.get('/api/auth/me').expect(200)).body.user.avatarVersion).toBeNull();
    });
  });
});
