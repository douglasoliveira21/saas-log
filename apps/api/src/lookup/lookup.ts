/** Funções puras de normalização (sem rede), testáveis isoladamente. */

const SMALL = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'a', 'o', 'para', 'com']);
const KEEP_UPPER = /^(?:[IVXLCDM]{2,}|SN|S\/N|LTDA|ME|EPP|MEI|SA|S\/A|BR|CEP|CNPJ|CPF|[A-Z]{2}-\d+)$/;

/** "AVENIDA PAULISTA" → "Avenida Paulista"; preposições em minúsculas; siglas e numerais romanos preservados. */
export function titleCase(input: string | null | undefined): string | undefined {
  const s = (input ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return undefined;
  return s
    .toLowerCase()
    .split(' ')
    .map((w, i) => {
      const up = w.toUpperCase();
      if (KEEP_UPPER.test(up) && w.length <= 5) return up;
      if (i > 0 && SMALL.has(w)) return w;
      return w.replace(/(^|[-/(])(\p{L})/gu, (_m, p, c: string) => p + c.toUpperCase());
    })
    .join(' ');
}

export const onlyDigits = (v: string | null | undefined): string => (v ?? '').replace(/\D/g, '');

/** Telefone brasileiro: aceita 10 ou 11 dígitos (com DDD), opcionalmente com 55 na frente. Retorna só dígitos ou null. */
export function normalizePhone(v: string | null | undefined): string | null {
  let d = onlyDigits(v);
  if (!d) return null;
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  return d.length === 10 || d.length === 11 ? d : null;
}

export interface CnpjInfo {
  cnpj: string;
  legalName: string;
  tradeName?: string;
  email?: string;
  phone?: string;
  cnae?: string;
  cnaeDescription?: string;
  status: string;
  active: boolean;
  branch: 'MATRIZ' | 'FILIAL' | null;
  openedAt?: string;
  address: { zipCode?: string; street?: string; number?: string; complement?: string; district?: string; city?: string; state?: string };
  source: string;
}

type Raw = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Converte a resposta da BrasilAPI (/cnpj/v1) para o formato interno. Não deduz regime tributário nem inscrição estadual. */
export function mapBrasilApiCnpj(r: Raw): CnpjInfo {
  const cnae = r.cnae_fiscal != null ? String(r.cnae_fiscal).padStart(7, '0') : undefined;
  const phone = normalizePhone(str(r.ddd_telefone_1) ?? str(r.ddd_telefone_2)) ?? undefined;
  const status = str(r.descricao_situacao_cadastral) ?? 'DESCONHECIDA';
  const identifier = str(r.descricao_identificador_matriz_filial)?.toUpperCase();
  return {
    cnpj: onlyDigits(String(r.cnpj ?? '')),
    legalName: str(r.razao_social) ?? '',
    tradeName: str(r.nome_fantasia) ? str(r.nome_fantasia) : undefined,
    email: str(r.email)?.toLowerCase(),
    phone,
    cnae,
    cnaeDescription: str(r.cnae_fiscal_descricao),
    status,
    active: status.toUpperCase() === 'ATIVA',
    branch: identifier === 'MATRIZ' ? 'MATRIZ' : identifier === 'FILIAL' ? 'FILIAL' : null,
    openedAt: str(r.data_inicio_atividade),
    address: {
      zipCode: onlyDigits(String(r.cep ?? '')) || undefined,
      street: titleCase([str(r.descricao_tipo_de_logradouro) && !String(r.logradouro ?? '').toUpperCase().startsWith(String(r.descricao_tipo_de_logradouro).toUpperCase()) ? str(r.descricao_tipo_de_logradouro) : '', str(r.logradouro)].filter(Boolean).join(' ')),
      number: ['SN', 'S/N'].includes(str(r.numero)?.toUpperCase() ?? '') ? 'S/N' : str(r.numero),
      complement: titleCase(str(r.complemento)),
      district: titleCase(str(r.bairro)),
      city: titleCase(str(r.municipio)),
      state: str(r.uf)?.toUpperCase(),
    },
    source: 'BrasilAPI',
  };
}

export interface CepInfo { zipCode: string; street?: string; district?: string; city?: string; state?: string; source: string }

/** BrasilAPI /cep/v2: { cep, state, city, neighborhood, street } */
export function mapBrasilApiCep(r: Raw): CepInfo {
  return { zipCode: onlyDigits(String(r.cep ?? '')), street: titleCase(str(r.street)), district: titleCase(str(r.neighborhood)), city: titleCase(str(r.city)), state: str(r.state)?.toUpperCase(), source: 'BrasilAPI' };
}

/** ViaCEP: { cep, logradouro, bairro, localidade, uf } ou { erro: true } */
export function mapViaCep(r: Raw): CepInfo | null {
  if (r.erro) return null;
  return { zipCode: onlyDigits(String(r.cep ?? '')), street: titleCase(str(r.logradouro)), district: titleCase(str(r.bairro)), city: titleCase(str(r.localidade)), state: str(r.uf)?.toUpperCase(), source: 'ViaCEP' };
}
