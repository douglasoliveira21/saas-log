import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CryptoService } from '../integrations/crypto.service';
import { FocusNfeProvider } from './focus-nfe.provider';
import {
  CancelResult, ConsultResult, FiscalEnvironment, FiscalModel, FiscalProvider, NullFiscalProvider, OutgoingDocument, ProviderCtx, TransmitInput, TransmitResult, ValidationIssue,
} from './fiscal-provider';

type Tx = Prisma.TransactionClient;
export type ProviderName = 'FOCUS_NFE';
export const PROVIDERS: Record<ProviderName, string> = { FOCUS_NFE: 'Focus NFe' };

export interface StoredCreds { homologacao?: string; producao?: string }

/** Escolhe o provedor de cada chamada pelo estabelecimento (cada empresa usa a própria conta). Sem credencial, nada é transmitido. */
@Injectable()
export class FiscalProviderRouter implements FiscalProvider {
  readonly name = 'roteador';
  private readonly focus = new FocusNfeProvider();
  private readonly none = new NullFiscalProvider();

  private pick(ctx?: ProviderCtx): FiscalProvider { return ctx?.providerName === 'FOCUS_NFE' ? this.focus : this.none; }

  numberingFor(ctx: ProviderCtx) { return this.pick(ctx).numbering ?? 'SYSTEM'; }
  isConfigured(ctx?: ProviderCtx) { return this.pick(ctx).isConfigured(ctx); }
  transmit(input: TransmitInput, ctx?: ProviderCtx): Promise<TransmitResult> { return this.pick(ctx).transmit(input, ctx); }
  consult(key: string, env: FiscalEnvironment, ctx?: ProviderCtx): Promise<ConsultResult> { return this.pick(ctx).consult(key, env, ctx); }
  validate(doc: OutgoingDocument, ctx: ProviderCtx): ValidationIssue[] { return this.pick(ctx).validate?.(doc, ctx) ?? []; }
  async cancel(ref: string, reason: string, ctx: ProviderCtx): Promise<CancelResult> {
    const p = this.pick(ctx);
    return p.cancel ? p.cancel(ref, reason, ctx) : { kind: 'UNAVAILABLE', reason: 'O provedor configurado não suporta cancelamento por aqui.' };
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
    if (row) {
      const creds = this.crypto.decrypt<StoredCreds>(tenantId, ProviderContextService.aad(establishmentId), row.credsEnc);
      token = (environment === 'PRODUCAO' ? creds.producao : creds.homologacao) ?? null;
    }
    return { tenantId, establishmentId, providerName: row?.provider ?? null, token, model, environment };
  }
}
