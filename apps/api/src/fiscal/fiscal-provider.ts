// Contrato com o provedor/biblioteca de transmissão de documentos fiscais (assinatura + webservices da SEFAZ).
// Provedor implementado: Focus NFe (focus-nfe.provider.ts). Sem provedor configurado, `NullFiscalProvider` NUNCA simula autorização.

export const FISCAL_PROVIDER = Symbol('FISCAL_PROVIDER');

export type FiscalEnvironment = 'HOMOLOGACAO' | 'PRODUCAO';
export type FiscalModel = '55' | '65';

/** Credenciais e identificação do estabelecimento para uma chamada (o token vem decifrado, nunca é registrado em log). */
export interface ProviderCtx {
  tenantId: string;
  /** UF do estabelecimento emitente. */
  uf: string | null;
  /** Certificado A1 do estabelecimento (só para provedores que assinam por conta própria). */
  certificate: { keyPem: string; certPem: string; certBase64: string; cnpj: string | null } | null;
  /** CSC da NFC-e (id + código), quando configurado para emissão direta. */
  csc: { id: string; token: string } | null;
  establishmentId: string;
  providerName: string | null;
  token: string | null;
  model: FiscalModel;
  environment: FiscalEnvironment;
}

export interface OutgoingItem {
  line: number;
  sku: string;
  description: string;
  ncm: string;
  cfop: string;
  unit: string;
  quantity: number;
  unitValue: number;
  total: number;
  origin: number | null;
  /** Códigos vindos do motor tributário (regras aprovadas pelo contador). */
  icmsCode: string | null; // CSOSN (Simples) ou CST
  pisCst: string | null;
  cofinsCst: string | null;
  /** Valores calculados pelo motor: o conector só envia o que consegue mapear; se algum for > 0, a nota é bloqueada na validação. */
  taxAmounts: { icms: number; pis: number; cofins: number };
  /** Base, alíquota e valor de cada tributo (para provedores que montam o XML). */
  tax?: { icms: { base: number; rate: number; amount: number }; pis: { base: number; rate: number; amount: number }; cofins: { base: number; rate: number; amount: number } };
}

/** Documento de saída neutro (não depende do provedor); cada provedor converte para o seu formato. */
export interface OutgoingDocument {
  ref: string;
  /** Numeração do sistema (emissão direta): número, série e chave reservados antes do envio. */
  number?: number;
  series?: number;
  accessKey?: string;
  model: FiscalModel;
  environment: FiscalEnvironment;
  issuedAt: Date;
  presence: 'COUNTER' | 'DELIVERY' | 'INTERNET' | 'PHONE' | 'OTHER';
  destination: 1 | 2 | 3; // 1 interna · 2 interestadual · 3 exterior
  finalConsumer: boolean;
  emitter: { cnpj: string; name: string; tradeName: string | null; street: string; number: string; district: string; city: string; cMun: string | null; uf: string; zip: string; ie: string; regime: 1 | 3 | 4; cnae: string | null };
  recipient: { document: string | null; name: string | null; ie: string | null; ieIndicator: 1 | 2 | 9; street: string | null; number: string | null; district: string | null; city: string | null; cMun: string | null; uf: string | null; zip: string | null; phone: string | null; email: string | null } | null;
  items: OutgoingItem[];
  totals: { products: number; freight: number; total: number };
  payments: { method: string; amount: number }[];
  additionalInfo: string | null;
  /** NF-e de devolução de venda: chaves das notas originais (entrada própria, finNFe 4). */
  returnOf?: string[];
}

export interface TransmitInput {
  accessKey: string;
  environment: FiscalEnvironment;
  documentId: string;
  /** Dados completos para provedores que montam o XML por conta própria. */
  document?: OutgoingDocument;
}

export type TransmitResult =
  | { kind: 'AUTHORIZED'; protocol: string; statusCode: string; xml?: string; remote?: RemoteDoc; signedXml?: string }
  | { kind: 'REJECTED'; statusCode: string; reason: string; signedXml?: string }
  | { kind: 'TIMEOUT'; signedXml?: string } // enviado, resposta desconhecida: NÃO retransmitir; consultar pela referência
  | { kind: 'UNAVAILABLE'; reason: string }; // falha antes de o provedor aceitar o envio

/** Dados que o provedor devolve ao autorizar (numeração e arquivos). */
export interface RemoteDoc { accessKey?: string; number?: number; series?: number; xmlPath?: string; danfePath?: string; qrCodeUrl?: string; consultUrl?: string }

export type ConsultResult =
  | { kind: 'AUTHORIZED'; protocol: string; statusCode: string; remote?: RemoteDoc; protXml?: string }
  | { kind: 'REJECTED'; statusCode: string; reason: string }
  | { kind: 'CANCELLED'; statusCode?: string; xmlPath?: string }
  | { kind: 'NOT_FOUND' } // o provedor/SEFAZ não conhece a referência: pode retransmitir
  | { kind: 'UNKNOWN' };

export type CancelResult = { kind: 'CANCELLED'; statusCode: string; xmlPath?: string } | { kind: 'REJECTED'; statusCode: string; reason: string } | { kind: 'UNAVAILABLE'; reason: string };

/** Evento fiscal de uma nota: carta de correção (CC-e) ou manifestação do destinatário. */
export interface EventInput { kind: 'CCE' | 'MANIFEST'; accessKey: string; seq: number; text?: string; action?: 'CIENCIA' | 'CONFIRMACAO' | 'DESCONHECIMENTO' | 'NAO_REALIZADA'; cnpj: string }
export type EventResult = { kind: 'REGISTERED'; statusCode: string; protocol: string } | { kind: 'REJECTED'; statusCode: string; reason: string } | { kind: 'UNAVAILABLE'; reason: string };

export interface ValidationIssue { code: string; message: string }

export interface FiscalProvider {
  readonly name: string;
  /** SYSTEM: o sistema reserva número e chave (padrão). PROVIDER: o provedor numera e devolve a chave ao autorizar. */
  readonly numbering?: 'SYSTEM' | 'PROVIDER';
  numberingFor?(ctx: ProviderCtx): 'SYSTEM' | 'PROVIDER';
  isConfigured(ctx?: ProviderCtx): boolean;
  /** Deve ser idempotente pela chave de acesso (ou pela referência, quando o provedor numera). */
  transmit(input: TransmitInput, ctx?: ProviderCtx): Promise<TransmitResult>;
  consult(key: string, environment: FiscalEnvironment, ctx?: ProviderCtx): Promise<ConsultResult>;
  /** Pendências que só este provedor conhece (ex.: tributos que o conector ainda não mapeia). */
  validate?(doc: OutgoingDocument, ctx: ProviderCtx): ValidationIssue[] | Promise<ValidationIssue[]>;
  /** Verdadeiro quando o provedor monta o XML por conta própria e precisa do documento completo (com número, série e chave reservados). */
  readonly needsDocument?: boolean;
  needsDocumentFor?(ctx: ProviderCtx): boolean;
  cancel?(ref: string, reason: string, ctx: ProviderCtx, doc?: { accessKey?: string | null; protocol?: string | null }): Promise<CancelResult>;
  /** Carta de correção e manifestação do destinatário (emissão direta). */
  sendEvent?(p: EventInput, ctx: ProviderCtx): Promise<EventResult>;
  /** Inutilização de faixa de numeração (emissão direta). */
  inutilize?(p: InutInput, ctx: ProviderCtx): Promise<{ kind: 'OK'; protocol: string; statusCode: string } | { kind: 'REJECTED'; statusCode: string; reason: string } | { kind: 'UNAVAILABLE'; reason: string }>;
  /** Baixa XML/DANFE do provedor (caminho relativo devolvido por ele). */
  download?(path: string, ctx: ProviderCtx): Promise<{ content: Buffer; contentType: string }>;
  /** Confere se o token funciona, sem emitir nada. */
  ping?(ctx: ProviderCtx): Promise<{ ok: boolean; message: string }>;
}

export interface InutInput { model: FiscalModel; series: number; from: number; to: number; reason: string }

export class NullFiscalProvider implements FiscalProvider {
  readonly name = 'nenhum';
  isConfigured() { return false; }
  transmit(): Promise<TransmitResult> { return Promise.resolve({ kind: 'UNAVAILABLE', reason: 'Nenhum provedor de transmissão configurado.' }); }
  consult(): Promise<ConsultResult> { return Promise.resolve({ kind: 'UNKNOWN' }); }
}
