import { Injectable } from '@nestjs/common';
import { SefazDirectProvider } from './sefaz/sefaz-direct.provider';
import { pfxToPem } from './sefaz/pfx';
import { Prisma } from '@prisma/client';
import { CryptoService } from '../integrations/crypto.service';
import { FocusNfeProvider } from './focus-nfe.provider';
import {
  CancelResult, ConsultResult, EventInput, FiscalEnvironment, FiscalModel, FiscalProvider, InutInput, NullFiscalProvider, OutgoingDocument, ProviderCtx, TransmitInput, TransmitResult, ValidationIssue,
} from './fiscal-provider';

type Tx = Prisma.TransactionClient;
export type ProviderName = 'FOCUS_NFE' | 'SEFAZ_DIRECT';
export const PROVIDERS: Record<ProviderName, string> = { FOCUS_NFE: 'Focus NFe', SEFAZ_DIRECT: 'Emissão direta na SEFAZ' };

/** Token do provedor (Focus) por ambiente e/ou CSC da NFC-e por ambiente (emissão direta). */
export interface StoredCreds { homologacao?: string; producao?: string; csc?: { homologacao?: { id: string; token: string }; producao?: { id: string; token: string } } }

/** Escolhe o provedor de cada chamada pelo estabelecimento (cada empresa usa a própria conta). Sem credencial, nada é transmitido. */
@Injectable()
export class FiscalProviderRouter implements FiscalProvider {
  readonly name = 'roteador';
  private readonly focus = new FocusNfeProvider();
  private readonly direct = new SefazDirectProvider();
  private readonly none = new NullFiscalProvider();

  private pick(ctx?: ProviderCtx): FiscalProvider { return ctx?.providerName === 'FOCUS_NFE' ? this.focus : ctx?.providerName === 'SEFAZ_DIRECT' ? this.direct : this.none; }
  needsDocumentFor(ctx: ProviderCtx) { return !!this.pick(ctx).needsDocument; }

  numberingFor(ctx: ProviderCtx) { return this.pick(ctx).numbering ?? 'SYSTEM'; }
  isConfigured(ctx?: ProviderCtx) { return this.pick(ctx).isConfigured(ctx); }
  transmit(input: TransmitInput, ctx?: ProviderCtx): Promise<TransmitResult> { return this.pick(ctx).transmit(input, ctx); }
  consult(key: string, env: FiscalEnvironment, ctx?: ProviderCtx): Promise<ConsultResult> { return this.pick(ctx).consult(key, env, ctx); }
  async validate(doc: OutgoingDocument, ctx: ProviderCtx): Promise<ValidationIssue[]> { return (await this.pick(ctx).validate?.(doc, ctx)) ?? []; }
  async cancel(ref: string, reason: string, ctx: ProviderCtx, doc?: { accessKey?: string | null; protocol?: string | null }): Promise<CancelResult> {
    const p = this.pick(ctx);
    return p.cancel ? p.cancel(ref, reason, ctx, doc) : { kind: 'UNAVAILABLE', reason: 'O provedor configurado não suporta cancelamento por aqui.' };
  }
  async sendEvent(p: EventInput, ctx: ProviderCtx) {
    const impl = this.pick(ctx);
    return impl.sendEvent ? impl.sendEvent(p, ctx) : { kind: 'UNAVAILABLE' as const, reason: 'O provedor configurado não envia carta de correção nem manifestação por aqui: use o painel do provedor ou a emissão direta.' };
  }

  async inutilize(p: InutInput, ctx: ProviderCtx) {
    const impl = this.pick(ctx);
    return impl.inutilize ? impl.inutilize(p, ctx) : { kind: 'UNAVAILABLE' as const, reason: 'O provedor configurado não suporta inutilização por aqui.' };
  }
  download(path: string, ctx: ProviderCtx) {
    const p = this.pick(ctx);
    if (!p.download) throw new Error('O provedor configurado não permite baixar arquivos.');
    return p.download(path, ctx);
  }
  async ping(ctx: ProviderCtx) { const p = this.pick(ctx); return p.ping ? p.ping(ctx) : { ok: false, message: 'Nenhum provedor configurado.' }; }
}

/** Monta o contexto de uma chamada ao provedor (decifra o token do ambiente do documento). */
@Injectable()
export class ProviderContextService {
  constructor(private readonly crypto: CryptoService) {}

  static aad(establishmentId: string) { return `fiscalprov:${establishmentId}`; }

  async resolve(tx: Tx, tenantId: string, establishmentId: string, model: FiscalModel, environment: FiscalEnvironment): Promise<ProviderCtx> {
    const row = await tx.fiscalProviderCredential.findFirst({ where: { tenantId, establishmentId } });
    let token: string | null = null;
    let csc: ProviderCtx['csc'] = null;
    if (row) {
      const creds = this.crypto.decrypt<StoredCreds>(tenantId, ProviderContextService.aad(establishmentId), row.credsEnc);
      token = (environment === 'PRODUCAO' ? creds.producao : creds.homologacao) ?? null;
      csc = creds.csc?.[environment === 'PRODUCAO' ? 'producao' : 'homologacao'] ?? null;
    }
    // Só a emissão direta usa o certificado do sistema (decifrado em memória, por chamada; nunca registrado).
    let certificate: ProviderCtx['certificate'] = null;
    if (row?.provider === 'SEFAZ_DIRECT') {
      const c = await tx.fiscalCertificate.findFirst({ where: { tenantId, establishmentId, status: 'ACTIVE' } });
      if (c && c.notAfter.getTime() > Date.now()) {
        try {
          const s = this.crypto.decrypt<{ pfx: string; password: string }>(tenantId, `fiscal-cert:${c.id}`, c.pfxEnc);
          const p = pfxToPem(Buffer.from(s.pfx, 'base64'), s.password);
          certificate = { keyPem: p.keyPem, certPem: p.certPem, certBase64: p.certBase64, cnpj: p.cnpj };
        } catch { certificate = null; }
      }
    }
    const est = await tx.establishment.findFirst({ where: { id: establishmentId, tenantId }, select: { state: true } });
    return { tenantId, establishmentId, uf: est?.state?.toUpperCase() ?? null, certificate, csc, providerName: row?.provider ?? null, token, model, environment };
  }
}
