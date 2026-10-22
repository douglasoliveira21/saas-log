import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as forge from 'node-forge';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { AuthContext } from '../common/auth';
import { isValidCnpj, onlyDigits } from '../common/cnpj';
import { CryptoService } from '../integrations/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { FISCAL_PROVIDER, FiscalEnvironment, FiscalProvider } from './fiscal-provider';
import { PROVIDERS, ProviderContextService, ProviderName, StoredCreds } from './fiscal-provider.router';

type Tx = Prisma.TransactionClient;

export interface ReadinessItem {
  key: string;
  label: string;
  status: 'OK' | 'PENDING' | 'BLOCKING';
  detail?: string;
  /** Impede a emissão em homologação / em produção. */
  blocksHomologation: boolean;
  blocksProduction: boolean;
}

const MAX_PFX_BYTES = 200 * 1024;

export interface CertificateMeta {
  id: string; subject: string; cnpj: string | null; serial: string; fingerprint: string; notBefore: Date; notAfter: Date; daysToExpire: number; expired: boolean; expiringSoon: boolean;
}

// Lista explícita de campos: a linha do banco contém o PFX cifrado e nunca deve sair daqui.
const meta = (c: { id: string; subject: string; cnpj: string | null; serial: string; fingerprint: string; notBefore: Date; notAfter: Date }): CertificateMeta => {
  const days = Math.floor((c.notAfter.getTime() - Date.now()) / 86_400_000);
  return { id: c.id, subject: c.subject, cnpj: c.cnpj, serial: c.serial, fingerprint: c.fingerprint, notBefore: c.notBefore, notAfter: c.notAfter, daysToExpire: days, expired: days < 0, expiringSoon: days >= 0 && days <= 30 };
};

@Injectable()
export class FiscalConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    @Inject(FISCAL_PROVIDER) private readonly provider: FiscalProvider,
    private readonly pctx: ProviderContextService,
  ) {}

  private async establishment(tx: Tx, ctx: Pick<AuthContext, 'tenantId'>, id: string) {
    const e = await tx.establishment.findFirst({ where: { id, tenantId: ctx.tenantId! }, include: { company: true } });
    if (!e) throw new NotFoundException('Estabelecimento não encontrado.');
    return e;
  }

  async listEstablishments(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const ests = await tx.establishment.findMany({ where: { tenantId: ctx.tenantId!, active: true }, include: { company: { select: { legalName: true, taxRegime: true } } }, orderBy: { createdAt: 'asc' } });
      const cfgs = await tx.fiscalConfiguration.findMany({ where: { tenantId: ctx.tenantId! } });
      const certs = await tx.fiscalCertificate.findMany({ where: { tenantId: ctx.tenantId!, status: 'ACTIVE' } });
      return ests.map((e) => {
        const cfg = cfgs.find((c) => c.establishmentId === e.id);
        const cert = certs.find((c) => c.establishmentId === e.id);
        return { id: e.id, name: e.name, kind: e.kind, cnpj: e.cnpj, company: e.company.legalName, environment: cfg?.environment ?? 'HOMOLOGACAO', configStatus: cfg?.status ?? 'NOT_STARTED', certificate: cert ? meta(cert) : null };
      });
    });
  }

  async getConfig(ctx: AuthContext, establishmentId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const est = await this.establishment(tx, ctx, establishmentId);
      const cfg = await this.ensureConfig(tx, ctx, establishmentId);
      const cert = await tx.fiscalCertificate.findFirst({ where: { tenantId: ctx.tenantId!, establishmentId, status: 'ACTIVE' } });
      const readiness = await this.readiness(tx, ctx, est, cfg, cert);
      return {
        establishment: { id: est.id, name: est.name, cnpj: est.cnpj, stateRegistration: est.stateRegistration, cnae: est.cnae, state: est.state, taxRegime: est.company.taxRegime },
        config: cfg, certificate: cert ? meta(cert) : null, ...readiness,
      };
    });
  }

  private async ensureConfig(tx: Tx, ctx: Pick<AuthContext, 'tenantId'>, establishmentId: string) {
    return tx.fiscalConfiguration.upsert({
      where: { tenantId_establishmentId: { tenantId: ctx.tenantId!, establishmentId } },
      create: { tenantId: ctx.tenantId!, establishmentId }, update: {},
    });
  }

  async updateConfig(ctx: AuthContext, establishmentId: string, dto: { environment?: string; documentTypes?: string[]; nfeSeries?: number; accountantName?: string; accountantEmail?: string; notes?: string }) {
    return this.prisma.withContext(ctx, async (tx) => {
      await this.establishment(tx, ctx, establishmentId);
      const before = await this.ensureConfig(tx, ctx, establishmentId);
      const data = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined));
      // Qualquer mudança de parâmetro fiscal invalida a validação anterior do contador.
      const row = await tx.fiscalConfiguration.update({ where: { id: before.id }, data: { ...data, status: 'DRAFT', approvedById: null, approvedAt: null } });
      await this.audit.record(tx, ctx, { action: 'fiscal.config_changed', entity: 'fiscal_configuration', entityId: row.id, metadata: { establishmentId, before: { environment: before.environment, series: before.nfeSeries, status: before.status }, after: { ...data }, approvalReset: before.status !== 'DRAFT' } });
      return row;
    });
  }

  async submitForAccountant(ctx: AuthContext, establishmentId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const est = await this.establishment(tx, ctx, establishmentId);
      const cfg = await this.ensureConfig(tx, ctx, establishmentId);
      if (cfg.status === 'PENDING_ACCOUNTANT') throw new ConflictException('Já está aguardando a validação do contador.');
      if (!cfg.accountantName) throw new BadRequestException('Informe o contador responsável antes de enviar para validação.');
      const cert = await tx.fiscalCertificate.findFirst({ where: { tenantId: ctx.tenantId!, establishmentId, status: 'ACTIVE' } });
      const { questionsForAccountant } = await this.readiness(tx, ctx, est, cfg, cert);
      await tx.fiscalConfiguration.update({ where: { id: cfg.id }, data: { status: 'PENDING_ACCOUNTANT' } });
      await this.audit.record(tx, ctx, { action: 'fiscal.config_submitted', entity: 'fiscal_configuration', entityId: cfg.id, metadata: { establishmentId } });
      return { status: 'PENDING_ACCOUNTANT' as const, questionsForAccountant };
    });
  }

  async approve(ctx: AuthContext, establishmentId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      await this.establishment(tx, ctx, establishmentId);
      const cfg = await this.ensureConfig(tx, ctx, establishmentId);
      if (cfg.status !== 'PENDING_ACCOUNTANT') throw new ConflictException('A configuração não está aguardando validação.');
      await tx.fiscalConfiguration.update({ where: { id: cfg.id }, data: { status: 'APPROVED', approvedById: ctx.userId, approvedAt: new Date() } });
      await this.audit.record(tx, ctx, { action: 'fiscal.config_approved', entity: 'fiscal_configuration', entityId: cfg.id, metadata: { establishmentId, environment: cfg.environment } });
      return { status: 'APPROVED' as const };
    });
  }

  async reject(ctx: AuthContext, establishmentId: string, reason: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      const cfg = await this.ensureConfig(tx, ctx, establishmentId);
      if (cfg.status !== 'PENDING_ACCOUNTANT') throw new ConflictException('A configuração não está aguardando validação.');
      await tx.fiscalConfiguration.update({ where: { id: cfg.id }, data: { status: 'DRAFT', notes: `${cfg.notes ?? ''}\nDevolvida pelo contador: ${reason}`.trim() } });
      await this.audit.record(tx, ctx, { action: 'fiscal.config_rejected', entity: 'fiscal_configuration', entityId: cfg.id, metadata: { establishmentId, reason } });
      return { status: 'DRAFT' as const };
    });
  }

  // ───────────── assistente: pendências e prontidão ─────────────

  /** Resultado do assistente: o que já está apto para homologação e o que impede a produção. Nada é presumido. */
  private async readiness(
    tx: Tx, ctx: Pick<AuthContext, 'tenantId'>,
    est: Prisma.EstablishmentGetPayload<{ include: { company: true } }>,
    cfg: { environment: string; status: string; accountantName: string | null; accountantEmail: string | null },
    cert: { id: string; subject: string; cnpj: string | null; serial: string; fingerprint: string; notBefore: Date; notAfter: Date } | null,
  ) {
    const items: ReadinessItem[] = [];
    const add = (key: string, label: string, ok: boolean, o: { detail?: string; blocking?: boolean; hom?: boolean; prod?: boolean } = {}) =>
      items.push({ key, label, status: ok ? 'OK' : o.blocking === false ? 'PENDING' : 'BLOCKING', detail: ok ? undefined : o.detail, blocksHomologation: !ok && (o.hom ?? true), blocksProduction: !ok && (o.prod ?? true) });
    const questions: string[] = [];

    add('cnpj', 'CNPJ do estabelecimento', !!est.cnpj && isValidCnpj(est.cnpj), { detail: 'Informe um CNPJ válido para o estabelecimento emissor/destinatário.' });
    add('ie', 'Inscrição estadual', !!est.stateRegistration, { detail: 'Obrigatória para emitir NF-e de mercadorias.' });
    add('address', 'Endereço (UF, município e CEP)', !!(est.state && est.city && est.zipCode), { detail: 'A UF compõe a chave de acesso e a seleção de regras.' });
    add('cnae', 'CNAE', !!est.cnae, { detail: 'Informe o CNAE principal.', blocking: false, hom: false, prod: true });
    add('regime', 'Regime tributário da empresa', !!est.company.taxRegime, { detail: 'Defina o regime em Empresa e depósitos (validar com o contador).' });
    if (!est.company.taxRegime) questions.push('Qual é o regime tributário correto da empresa e desde quando?');

    const pc = await this.pctx.resolve(tx, ctx.tenantId!, est.id, '55', (cfg.environment as FiscalEnvironment) ?? 'HOMOLOGACAO');
    const providerManaged = (this.provider.numberingFor?.(pc) ?? this.provider.numbering ?? 'SYSTEM') === 'PROVIDER' && this.provider.isConfigured(pc);
    const certOk = !!cert && cert.notAfter.getTime() > Date.now();
    // Com provedor que assina por nós, o certificado A1 (e o CSC da NFC-e) ficam no painel dele; o nosso upload deixa de ser obrigatório.
    add('certificate', providerManaged ? 'Certificado digital A1 (no provedor)' : 'Certificado digital A1 válido', providerManaged || certOk, { detail: providerManaged ? 'O certificado fica no painel do provedor.' : cert ? 'Certificado vencido: envie um novo.' : 'Envie o certificado A1 (.pfx) do estabelecimento.' });
    if (cert && certOk) {
      const days = Math.floor((cert.notAfter.getTime() - Date.now()) / 86_400_000);
      add('certificate_expiry', 'Certificado com mais de 30 dias de validade', days > 30, { detail: `Vence em ${days} dia(s).`, blocking: false, hom: false, prod: false });
      if (cert.cnpj && est.cnpj && cert.cnpj.slice(0, 8) !== onlyDigits(est.cnpj).slice(0, 8)) {
        add('certificate_owner', 'Certificado pertence à mesma empresa', false, { detail: `O CNPJ do certificado (${cert.cnpj}) não confere com o do estabelecimento.`, blocking: false, hom: false, prod: true });
      }
    }

    add('accountant', 'Contador responsável informado', !!cfg.accountantName && !!cfg.accountantEmail, { detail: 'Informe nome e e-mail do contador.', blocking: false, hom: false, prod: true });
    add('approval', 'Configuração validada pelo contador', cfg.status === 'APPROVED', { detail: cfg.status === 'PENDING_ACCOUNTANT' ? 'Aguardando a validação do contador.' : 'Envie a configuração para validação do contador.', hom: false, prod: true });
    if (cfg.status !== 'APPROVED') questions.push('A configuração fiscal (ambiente, série, tipos de documento) está correta para este estabelecimento?');

    const noNcm = await tx.product.count({ where: { tenantId: ctx.tenantId!, active: true, kind: 'PHYSICAL', ncm: null } });
    const noOrigin = await tx.product.count({ where: { tenantId: ctx.tenantId!, active: true, kind: 'PHYSICAL', taxOrigin: null } });
    add('products_ncm', 'Produtos com NCM', noNcm === 0, { detail: `${noNcm} produto(s) sem NCM (cada NCM deve ser validado pelo contador).`, blocking: false, hom: false, prod: true });
    add('products_origin', 'Produtos com origem da mercadoria', noOrigin === 0, { detail: `${noOrigin} produto(s) sem origem informada.`, blocking: false, hom: false, prod: true });
    if (noNcm > 0) questions.push(`Confirme o NCM dos ${noNcm} produtos ainda sem classificação.`);

    const now = new Date();
    const approvedRules = await tx.taxRuleVersion.count({ where: { tenantId: ctx.tenantId!, status: 'APPROVED', validFrom: { lte: now }, OR: [{ validTo: null }, { validTo: { gte: now } }] } });
    add('tax_rules', 'Regras tributárias aprovadas e vigentes', approvedRules > 0, { detail: 'O sistema não traz regras prontas: cadastre-as com o contador e aprove em Regras tributárias. Sem regra, o motor devolve pendência.' });
    if (approvedRules === 0) questions.push('Quais CFOP, CST/CSOSN e alíquotas se aplicam às nossas operações de venda e compra (por UF, NCM e regime)?');

    add('provider', 'Integração de transmissão (SEFAZ/provedor)', this.provider.isConfigured(pc), { detail: 'Nenhum provedor de transmissão está configurado para este estabelecimento: informe o token do provedor (ex.: Focus NFe) na aba Configuração. Sem isso a emissão não é possível (docs/FISCAL-PROVIDER.md).' });
    questions.push('Há operações com ST, DIFAL/FCP, benefício fiscal ou substituição tributária nos nossos produtos? (o motor ainda não calcula esses itens)');
    questions.push('Como a empresa deve tratar IBS/CBS na transição da Reforma Tributária e a partir de quando?');

    return {
      readiness: items,
      readyForHomologation: !items.some((i) => i.blocksHomologation),
      readyForProduction: !items.some((i) => i.blocksProduction) && cfg.environment === 'PRODUCAO',
      blockingForProduction: items.filter((i) => i.blocksProduction).map((i) => i.label),
      questionsForAccountant: questions,
    };
  }

  // ───────────── provedor de emissão (token por estabelecimento) ─────────────

  /** Só diz O QUE está salvo (provedor e se há token por ambiente, com os últimos caracteres); o token nunca volta pela API. */
  async getProvider(ctx: AuthContext, establishmentId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      await this.establishment(tx, ctx, establishmentId);
      const row = await tx.fiscalProviderCredential.findFirst({ where: { tenantId: ctx.tenantId!, establishmentId } });
      const creds = row ? this.crypto.decrypt<StoredCreds>(ctx.tenantId!, ProviderContextService.aad(establishmentId), row.credsEnc) : null;
      const cscView = (c?: { id: string; token: string }) => ({ configured: !!c, id: c?.id ?? null, hint: c ? '…' + c.token.slice(-4) : null });
      return {
        csc: { homologacao: cscView(creds?.csc?.homologacao), producao: cscView(creds?.csc?.producao) },
        available: Object.entries(PROVIDERS).map(([key, name]) => ({ key, name })),
        provider: row?.provider ?? null, providerName: row ? PROVIDERS[row.provider as ProviderName] : null,
        homologacao: { configured: !!row?.hintHomologacao, hint: row?.hintHomologacao ?? null }, producao: { configured: !!row?.hintProducao, hint: row?.hintProducao ?? null },
      };
    });
  }

  async setProvider(ctx: AuthContext, establishmentId: string, dto: { provider: ProviderName; tokenHomologacao?: string; tokenProducao?: string; cscHomologacao?: { id: string; token: string }; cscProducao?: { id: string; token: string } }) {
    if (!(dto.provider in PROVIDERS)) throw new BadRequestException('Provedor desconhecido.');
    const clean = (t?: string) => { const v = t?.trim(); if (v && (v.length < 8 || v.length > 200 || /\s/.test(v))) throw new BadRequestException('Token inválido (sem espaços, de 8 a 200 caracteres).'); return v || undefined; };
    const th = clean(dto.tokenHomologacao); const tp = clean(dto.tokenProducao);
    return this.prisma.withContext(ctx, async (tx) => {
      await this.establishment(tx, ctx, establishmentId);
      const prev = await tx.fiscalProviderCredential.findFirst({ where: { tenantId: ctx.tenantId!, establishmentId } });
      const old = prev && prev.provider === dto.provider ? this.crypto.decrypt<StoredCreds>(ctx.tenantId!, ProviderContextService.aad(establishmentId), prev.credsEnc) : {};
      const csc = (c?: { id: string; token: string }) => { if (!c) return undefined; const id = c.id.trim(); const token = c.token.trim(); if (!/^\d{1,6}$/.test(id) || token.length < 6 || token.length > 64 || /\s/.test(token)) throw new BadRequestException('CSC inválido: informe o identificador (número) e o código, sem espaços.'); return { id, token }; };
      const next: StoredCreds = { homologacao: th ?? old.homologacao, producao: tp ?? old.producao, csc: { homologacao: csc(dto.cscHomologacao) ?? old.csc?.homologacao, producao: csc(dto.cscProducao) ?? old.csc?.producao } };
      if (dto.provider === 'FOCUS_NFE' && !next.homologacao && !next.producao) throw new BadRequestException('Informe ao menos um token.');
      const hint = (t?: string) => (t ? '…' + t.slice(-4) : null);
      const data = { provider: dto.provider, credsEnc: this.crypto.encrypt(ctx.tenantId!, ProviderContextService.aad(establishmentId), next), hintHomologacao: hint(next.homologacao), hintProducao: hint(next.producao) };
      if (prev) await tx.fiscalProviderCredential.update({ where: { id: prev.id }, data });
      else await tx.fiscalProviderCredential.create({ data: { tenantId: ctx.tenantId!, establishmentId, ...data } });
      await this.audit.record(tx, ctx, { action: 'fiscal.provider_configured', entity: 'establishment', entityId: establishmentId, metadata: { provider: dto.provider, homologacao: !!next.homologacao, producao: !!next.producao, cscHomologacao: !!next.csc?.homologacao, cscProducao: !!next.csc?.producao } });
      return { provider: dto.provider, homologacao: { configured: !!next.homologacao, hint: hint(next.homologacao) }, producao: { configured: !!next.producao, hint: hint(next.producao) } };
    });
  }

  async clearProvider(ctx: AuthContext, establishmentId: string) {
    return this.prisma.withContext(ctx, async (tx) => {
      await this.establishment(tx, ctx, establishmentId);
      const r = await tx.fiscalProviderCredential.deleteMany({ where: { tenantId: ctx.tenantId!, establishmentId } });
      if (r.count) await this.audit.record(tx, ctx, { action: 'fiscal.provider_removed', entity: 'establishment', entityId: establishmentId });
      return { removed: r.count > 0 };
    });
  }

  /** Confere se o token do ambiente escolhido é aceito pelo provedor (não emite nada). */
  async testProvider(ctx: AuthContext, establishmentId: string, environment?: FiscalEnvironment) {
    const pc = await this.prisma.withContext(ctx, async (tx) => {
      await this.establishment(tx, ctx, establishmentId);
      const cfg = await this.ensureConfig(tx, ctx, establishmentId);
      return this.pctx.resolve(tx, ctx.tenantId!, establishmentId, '55', environment ?? ((cfg.environment as FiscalEnvironment) ?? 'HOMOLOGACAO'));
    });
    if (!pc.providerName || (pc.providerName === 'FOCUS_NFE' && !pc.token)) return { ok: false, environment: pc.environment, message: 'Nenhum token salvo para este ambiente.' };
    const r = this.provider.ping ? await this.provider.ping(pc) : { ok: false, message: 'O provedor não permite teste.' };
    return { ...r, environment: pc.environment };
  }

  // ───────────── certificado A1 ─────────────

  /** Recebe o .pfx (base64) e a senha, valida e guarda CIFRADO. Só metadados voltam ao navegador; a senha nunca é registrada. */
  async uploadCertificate(ctx: AuthContext, establishmentId: string, dto: { pfxBase64: string; password: string }): Promise<CertificateMeta & { warnings: string[] }> {
    const buf = Buffer.from(dto.pfxBase64, 'base64');
    if (!buf.length || buf.length > MAX_PFX_BYTES) throw new BadRequestException('Arquivo de certificado vazio ou acima de 200 KB.');
    let parsed: { subject: string; cnpj: string | null; serial: string; fingerprint: string; notBefore: Date; notAfter: Date; keyMatches: boolean };
    try {
      parsed = this.inspect(buf, dto.password);
    } catch (e) {
      // Mensagem genérica: nunca devolver detalhes que ajudem a adivinhar senha ou ecoar conteúdo.
      throw new UnprocessableEntityException((e as Error).message.startsWith('CERT:') ? (e as Error).message.slice(5) : 'Não foi possível abrir o certificado: confira o arquivo .pfx e a senha.');
    }
    if (!parsed.keyMatches) throw new UnprocessableEntityException('O arquivo não contém a chave privada correspondente ao certificado.');
    if (parsed.notAfter.getTime() <= Date.now()) throw new UnprocessableEntityException('Certificado vencido.');
    if (parsed.notBefore.getTime() > Date.now()) throw new UnprocessableEntityException('Certificado ainda não é válido (data inicial no futuro).');

    return this.prisma.withContext(ctx, async (tx) => {
      const est = await this.establishment(tx, ctx, establishmentId);
      const id = crypto.randomUUID();
      const warnings: string[] = [];
      if (parsed.cnpj && est.cnpj && parsed.cnpj.slice(0, 8) !== onlyDigits(est.cnpj).slice(0, 8)) warnings.push('O CNPJ do certificado não pertence à mesma raiz do CNPJ do estabelecimento.');
      if (!parsed.cnpj) warnings.push('Não foi possível identificar o CNPJ no certificado.');
      // O certificado anterior deixa de existir como segredo: o blob cifrado é apagado, só ficam os metadados.
      await tx.fiscalCertificate.updateMany({ where: { tenantId: ctx.tenantId!, establishmentId, status: 'ACTIVE' }, data: { status: 'REPLACED', pfxEnc: '' } });
      const row = await tx.fiscalCertificate.create({
        data: {
          id, tenantId: ctx.tenantId!, establishmentId, subject: parsed.subject, cnpj: parsed.cnpj, serial: parsed.serial, fingerprint: parsed.fingerprint, notBefore: parsed.notBefore, notAfter: parsed.notAfter,
          pfxEnc: this.crypto.encrypt(ctx.tenantId!, `fiscal-cert:${id}`, { pfx: dto.pfxBase64, password: dto.password }), uploadedById: ctx.userId,
        },
      });
      await this.audit.record(tx, ctx, { action: 'fiscal.certificate_uploaded', entity: 'fiscal_certificate', entityId: id, metadata: { establishmentId, subject: parsed.subject, serial: parsed.serial, fingerprint: parsed.fingerprint, notAfter: parsed.notAfter.toISOString() } });
      return { ...meta(row), warnings };
    });
  }

  /** Abre o PKCS#12, localiza o certificado do titular e confere que a chave privada corresponde a ele. */
  private inspect(pfx: Buffer, password: string) {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary')));
    const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, password);
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
    const keyBags = [...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []), ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? [])];
    const key = keyBags[0]?.key as forge.pki.rsa.PrivateKey | undefined;
    if (!certBags.length) throw new Error('CERT:O arquivo não contém certificado.');
    const certs = certBags.map((b) => b.cert).filter((c): c is forge.pki.Certificate => !!c);
    const own = (key && certs.find((c) => (c.publicKey as forge.pki.rsa.PublicKey).n?.toString(16) === key.n?.toString(16))) ?? certs[0];
    const keyMatches = !!key && (own.publicKey as forge.pki.rsa.PublicKey).n?.toString(16) === key.n?.toString(16);
    const cn = own.subject.getField('CN')?.value as string | undefined;
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(own)).getBytes();
    return {
      subject: cn ?? own.subject.attributes.map((a) => `${a.shortName}=${a.value}`).join(', '),
      cnpj: (cn ?? '').match(/(\d{14})/)?.[1] ?? null,
      serial: own.serialNumber, fingerprint: createHash('sha256').update(Buffer.from(der, 'binary')).digest('hex'),
      notBefore: own.validity.notBefore, notAfter: own.validity.notAfter, keyMatches,
    };
  }

  /** Uso interno (assinatura/transmissão, quando existir provedor): devolve o PFX decifrado. Nunca exposto por rota. */
  async loadCertificateSecret(tenantId: string, establishmentId: string): Promise<{ pfx: Buffer; password: string } | null> {
    const row = await this.prisma.withContext({ tenantId }, (tx) => tx.fiscalCertificate.findFirst({ where: { tenantId, establishmentId, status: 'ACTIVE' } }));
    if (!row) return null;
    const s = this.crypto.decrypt<{ pfx: string; password: string }>(tenantId, `fiscal-cert:${row.id}`, row.pfxEnc);
    return { pfx: Buffer.from(s.pfx, 'base64'), password: s.password };
  }

  // ───────────── indicadores ─────────────

  metrics(ctx: AuthContext) {
    return this.prisma.withContext(ctx, async (tx) => {
      const soon = new Date(Date.now() + 30 * 86_400_000);
      const [certsExpiring, noNcm, pendingReceipt, withIssues, pendingEmission] = await Promise.all([
        tx.fiscalCertificate.count({ where: { tenantId: ctx.tenantId!, status: 'ACTIVE', notAfter: { lte: soon } } }),
        tx.product.count({ where: { tenantId: ctx.tenantId!, active: true, kind: 'PHYSICAL', ncm: null } }),
        tx.fiscalDocument.count({ where: { tenantId: ctx.tenantId!, direction: 'ENTRY', status: 'IMPORTED' } }),
        tx.fiscalDocument.count({ where: { tenantId: ctx.tenantId!, direction: 'EXIT', status: { in: ['PENDING_VALIDATION', 'REJECTED', 'PENDING_CONSULT', 'COMMUNICATION_FAILURE'] } } }),
        tx.fiscalDocument.count({ where: { tenantId: ctx.tenantId!, direction: 'EXIT', status: 'READY_TO_TRANSMIT' } }),
      ]);
      return { certificatesExpiringSoon: certsExpiring, productsWithoutNcm: noNcm, xmlAwaitingReceipt: pendingReceipt, outgoingWithIssues: withIssues, outgoingReady: pendingEmission };
    });
  }

  async assertCanManage(ctx: AuthContext) {
    if (!ctx.permissions.has('fiscal.manage')) throw new ForbiddenException('Você não tem permissão para esta ação.');
  }
}
