// Registro VERSIONADO dos serviços oficiais da SEFAZ por UF, modelo, ambiente e serviço, com fonte e data da consulta.
// Regra: nada aqui é "de memória". Cada entrada cita a página oficial de onde foi copiada; UF sem entrada = NÃO ANALISADA (o conector recusa emitir).

export type SefazEnv = 'HOMOLOGACAO' | 'PRODUCAO';
export type SefazModel = '55' | '65';
export type SefazService = 'status' | 'autorizacao' | 'retAutorizacao' | 'consulta' | 'inutilizacao' | 'evento';

export type CoverageState = 'NAO_ANALISADO' | 'DOCUMENTACAO_ANALISADA' | 'EM_DESENVOLVIMENTO' | 'HOMOLOGACAO_PARCIAL' | 'HOMOLOGACAO_APROVADA' | 'PRODUCAO_HABILITADA' | 'INDISPONIVEL';

export const COVERAGE_LABEL: Record<CoverageState, string> = {
  NAO_ANALISADO: 'Não analisado', DOCUMENTACAO_ANALISADA: 'Documentação analisada', EM_DESENVOLVIMENTO: 'Em desenvolvimento', HOMOLOGACAO_PARCIAL: 'Homologação parcial',
  HOMOLOGACAO_APROVADA: 'Homologação aprovada', PRODUCAO_HABILITADA: 'Produção habilitada', INDISPONIVEL: 'Indisponível ou suspenso',
};

export const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'] as const;
export type Uf = (typeof UFS)[number];

/** Código IBGE da UF (usado na chave de acesso e em cUF). */
export const UF_IBGE: Record<Uf, string> = {
  RO: '11', AC: '12', AM: '13', RR: '14', PA: '15', AP: '16', TO: '17', MA: '21', PI: '22', CE: '23', RN: '24', PB: '25', PE: '26', AL: '27', SE: '28', BA: '29',
  MG: '31', ES: '32', RJ: '33', SP: '35', PR: '41', SC: '42', RS: '43', MS: '50', MT: '51', GO: '52', DF: '53',
};

export interface ServiceEntry {
  url: string;
  /** Versão do serviço (leiaute). */
  version: string;
  /** Página oficial de onde a URL foi copiada e a data da consulta (AAAA-MM-DD). */
  source: string;
  consultedAt: string;
}

type Key = `${Uf}:${SefazModel}:${SefazEnv}`;
export interface UfEntry {
  /** Autorizador responsável (UF própria ou ambiente virtual). */
  authorizer: string;
  services: Record<SefazService, ServiceEntry>;
  notes: string[];
}

const MG_SPED = 'https://portalsped.fazenda.mg.gov.br/spedmg/nfe/webservices/ (SPED MG, SEFAZ-MG)';
const MG_SPED_NFCE = 'https://portalsped.fazenda.mg.gov.br/spedmg/nfce/web-services/ (SPED MG, SEFAZ-MG)';
const CONSULTED = '2026-10-22';
const mk = (base: string, names: Record<SefazService, string>, source: string): Record<SefazService, ServiceEntry> =>
  Object.fromEntries((Object.keys(names) as SefazService[]).map((s) => [s, { url: `${base}${names[s]}`, version: '4.00', source, consultedAt: CONSULTED }])) as Record<SefazService, ServiceEntry>;
const NAMES: Record<SefazService, string> = {
  status: 'NFeStatusServico4', autorizacao: 'NFeAutorizacao4', retAutorizacao: 'NFeRetAutorizacao4', consulta: 'NFeConsultaProtocolo4', inutilizacao: 'NFeInutilizacao4', evento: 'NFeRecepcaoEvento4',
};

/** Entradas verificadas. Hoje: Minas Gerais (NF-e e NFC-e), copiadas do SPED MG em 22/10/2026. */
const REGISTRY = new Map<Key, UfEntry>([
  ['MG:55:PRODUCAO', { authorizer: 'SEFAZ-MG', services: mk('https://nfe.fazenda.mg.gov.br/nfe2/services/', NAMES, MG_SPED), notes: ['A página oficial não informa SVC para MG; contingência SVC não foi verificada.'] }],
  ['MG:55:HOMOLOGACAO', { authorizer: 'SEFAZ-MG', services: mk('https://hnfe.fazenda.mg.gov.br/nfe2/services/', NAMES, MG_SPED), notes: [] }],
  ['MG:65:PRODUCAO', { authorizer: 'SEFAZ-MG', services: mk('https://nfce.fazenda.mg.gov.br/nfce/services/', NAMES, MG_SPED_NFCE), notes: ['QR Code: https://portalsped.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml'] }],
  ['MG:65:HOMOLOGACAO', { authorizer: 'SEFAZ-MG', services: mk('https://hnfce.fazenda.mg.gov.br/nfce/services/', NAMES, MG_SPED_NFCE), notes: ['QR Code: https://portalsped.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml (mesmo endereço em homologação, segundo a página oficial)'] }],
]);

/** Endereços de consulta por QR Code / chave (NFC-e), por UF e ambiente; só o que foi verificado. */
export const NFCE_QRCODE: Partial<Record<Uf, Record<SefazEnv, { qrCodeUrl: string; consultaChaveUrl: string; source: string }>>> = {
  MG: {
    PRODUCAO: { qrCodeUrl: 'https://portalsped.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml', consultaChaveUrl: 'https://portalsped.fazenda.mg.gov.br/portalnfce', source: MG_SPED_NFCE },
    HOMOLOGACAO: { qrCodeUrl: 'https://portalsped.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml', consultaChaveUrl: 'https://hportalsped.fazenda.mg.gov.br/portalnfce', source: MG_SPED_NFCE },
  },
};

export class UfNotAnalyzedError extends Error {
  constructor(public readonly uf: string, public readonly model: SefazModel, public readonly env: SefazEnv) {
    super(`A emissão direta na SEFAZ ainda não foi implementada para ${uf} (${model === '55' ? 'NF-e' : 'NFC-e'}, ${env === 'PRODUCAO' ? 'produção' : 'homologação'}): os endereços oficiais não foram verificados. Use um provedor de emissão ou aguarde a cobertura desta UF.`);
  }
}

export function ufEntry(uf: string, model: SefazModel, env: SefazEnv): UfEntry {
  const e = REGISTRY.get(`${uf.toUpperCase() as Uf}:${model}:${env}`);
  if (!e) throw new UfNotAnalyzedError(uf.toUpperCase(), model, env);
  return e;
}
export const service = (uf: string, model: SefazModel, env: SefazEnv, s: SefazService) => ufEntry(uf, model, env).services[s];

/** Matriz de cobertura nacional: uma linha por UF e modelo. NENHUM estado passa de "documentação analisada" sem teste real em homologação. */
export interface CoverageRow { uf: Uf; model: SefazModel; state: CoverageState; authorizer: string | null; notes: string[]; pending: string[]; lastVerified: string | null }
export function coverage(): CoverageRow[] {
  const rows: CoverageRow[] = [];
  for (const uf of UFS) {
    for (const model of ['55', '65'] as SefazModel[]) {
      const e = REGISTRY.get(`${uf}:${model}:HOMOLOGACAO`);
      rows.push({
        uf, model,
        state: e ? 'EM_DESENVOLVIMENTO' : 'NAO_ANALISADO',
        authorizer: e?.authorizer ?? null,
        notes: e ? [...e.notes, 'Endereços verificados em fonte oficial; comunicação real ainda NÃO testada (exige certificado A1 e credenciamento).'] : [],
        pending: e
          ? ['Teste real em homologação com certificado e credenciamento', 'Verificar contingência da UF', model === '65' ? 'Verificar CSC/QR Code vigente e regras de impressão da UF' : 'Confirmar regras específicas da UF para a NF-e']
          : ['Consultar a página oficial da SEFAZ da UF (ou do autorizador virtual) e registrar os endereços', 'Verificar credenciamento, contingência e particularidades'],
        lastVerified: e ? CONSULTED : null,
      });
    }
  }
  return rows;
}
