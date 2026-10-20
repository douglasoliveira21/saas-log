// Contrato com o provedor/biblioteca de transmissão de documentos fiscais (assinatura + webservices da SEFAZ).
// A escolha do provedor (biblioteca própria vs. serviço especializado) está PENDENTE — ver docs/FISCAL-BRAZIL.md.
// Enquanto não houver implementação, `NullFiscalProvider` é usado: ele NUNCA simula autorização.

export const FISCAL_PROVIDER = Symbol('FISCAL_PROVIDER');

export interface TransmitInput {
  accessKey: string;
  environment: 'HOMOLOGACAO' | 'PRODUCAO';
  documentId: string;
}

export type TransmitResult =
  | { kind: 'AUTHORIZED'; protocol: string; statusCode: string; xml?: string }
  | { kind: 'REJECTED'; statusCode: string; reason: string }
  | { kind: 'TIMEOUT' } // enviado, resposta desconhecida: NÃO retransmitir; consultar pela chave
  | { kind: 'UNAVAILABLE'; reason: string }; // falha antes de o provedor aceitar o envio

export type ConsultResult =
  | { kind: 'AUTHORIZED'; protocol: string; statusCode: string }
  | { kind: 'REJECTED'; statusCode: string; reason: string }
  | { kind: 'NOT_FOUND' } // o provedor/SEFAZ não conhece a chave: pode retransmitir com a MESMA numeração
  | { kind: 'UNKNOWN' };

export interface FiscalProvider {
  readonly name: string;
  isConfigured(): boolean;
  /** Deve ser idempotente pela chave de acesso. */
  transmit(input: TransmitInput): Promise<TransmitResult>;
  consult(accessKey: string, environment: 'HOMOLOGACAO' | 'PRODUCAO'): Promise<ConsultResult>;
}

export class NullFiscalProvider implements FiscalProvider {
  readonly name = 'nenhum';
  isConfigured() { return false; }
  transmit(): Promise<TransmitResult> { return Promise.resolve({ kind: 'UNAVAILABLE', reason: 'Nenhum provedor de transmissão configurado.' }); }
  consult(): Promise<ConsultResult> { return Promise.resolve({ kind: 'UNKNOWN' }); }
}
