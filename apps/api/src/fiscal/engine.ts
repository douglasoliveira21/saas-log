// Motor fiscal: seleciona a regra APROVADA e vigente cadastrada pelo próprio tenant e aplica seus parâmetros.
// O sistema NÃO traz alíquotas, CSTs ou CFOPs pré-cadastrados: sem regra aprovada o resultado é uma PENDÊNCIA, nunca um palpite.
// Puro e determinístico: mesmas entradas + mesmas versões de regra = mesma saída (reprodutível).

export const ENGINE_VERSION = '1.2.0';

export type Operation = 'PURCHASE' | 'SALE' | 'RETURN_SALE' | 'RETURN_PURCHASE' | 'TRANSFER' | 'OTHER';

export interface TaxParam {
  cst?: string;
  csosn?: string;
  /** Classificação tributária oficial do IBS/CBS (cClassTrib, 6 dígitos). */
  classCode?: string;
  ratePct?: number;
  baseReductionPct?: number;
  /** PERCENT (padrão) é calculado; ST/DIFAL/FCP exigem base específica e ainda não são calculados pelo motor. */
  kind?: 'PERCENT' | 'ST' | 'DIFAL' | 'FCP';
}

export interface RuleConfig {
  cfop?: string;
  includeFreightInBase?: boolean;
  /** Chaves livres por tributo (ICMS, IPI, PIS, COFINS, e os da transição IBS/CBS quando regulamentados). */
  taxes: Record<string, TaxParam>;
}

export interface RuleCandidate {
  ruleId: string;
  name: string;
  operation: Operation;
  originUf: string | null;
  destUf: string | null;
  ncmPrefix: string | null;
  regime: string | null;
  productOrigin: number | null;
  recipientKind: string | null;
  priority: number;
  version: { id: string; version: number; validFrom: Date; validTo: Date | null; config: RuleConfig; sourceReference: string };
}

export interface EngineItem {
  key: string;
  ncm: string | null;
  productOrigin?: number | null;
  value: number;
  freight?: number;
  discount?: number;
}

export interface EngineInput {
  operation: Operation;
  date: Date;
  originUf: string | null;
  destUf: string | null;
  regime: string | null;
  recipientKind?: string | null;
  items: EngineItem[];
}

export interface FederalTaxDefaults {
  companyId: string;
  regime: string;
  pisRate: number;
  cofinsRate: number;
  icmsByUf: { uf: string; cst: string; ratePct?: number }[];
}

export interface Pendency { code: 'NO_RULE' | 'AMBIGUOUS_RULE' | 'UNSUPPORTED_TAX' | 'MISSING_DATA'; itemKey?: string; message: string }

export interface TaxAmount { cst?: string; csosn?: string; classCode?: string; base: number; ratePct: number; amount: number }

export interface ItemResult {
  key: string;
  ruleVersionId: string | null;
  cfop: string | null;
  taxes: Record<string, TaxAmount>;
  totalTax: number;
}

export interface EngineOutput {
  engineVersion: string;
  items: ItemResult[];
  totals: Record<string, number>;
  rulesUsed: { ruleId: string; name: string; versionId: string; version: number; validFrom: string; validTo: string | null; sourceReference: string }[];
  pendencies: Pendency[];
  ready: boolean; // true somente se TODOS os itens foram calculados sem pendência
}

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const cents = (v: number) => Math.round(v * 100);

function inVigency(v: RuleCandidate['version'], d: Date) {
  return v.validFrom <= d && (!v.validTo || v.validTo >= d);
}

function matches(r: RuleCandidate, i: EngineInput, item: EngineItem): boolean {
  return (
    r.operation === i.operation &&
    (!r.originUf || r.originUf === i.originUf) &&
    (!r.destUf || r.destUf === i.destUf) &&
    (!r.regime || r.regime === i.regime) &&
    (!r.recipientKind || r.recipientKind === (i.recipientKind ?? null)) &&
    (r.productOrigin === null || r.productOrigin === (item.productOrigin ?? null)) &&
    (!r.ncmPrefix || (item.ncm ?? '').startsWith(r.ncmPrefix)) &&
    inVigency(r.version, i.date)
  );
}

const specificity = (r: RuleCandidate) =>
  [r.originUf, r.destUf, r.regime, r.recipientKind].filter(Boolean).length + (r.productOrigin !== null ? 1 : 0) + (r.ncmPrefix ? 1 + r.ncmPrefix.length / 100 : 0);

export function calculate(input: EngineInput, rules: RuleCandidate[], federal?: FederalTaxDefaults): EngineOutput {
  let defaults: RuleCandidate | undefined;
  if (federal) {
    const icms = federal.icmsByUf.find((x) => x.uf.toUpperCase() === (input.destUf ?? '').toUpperCase());
    const icmsCode = icms?.cst.trim();
    const taxes: Record<string, TaxParam> = {
      PIS: { ratePct: federal.pisRate }, COFINS: { ratePct: federal.cofinsRate },
      ...(icms && icmsCode ? { ICMS: { ratePct: icms.ratePct ?? 0, ...(icmsCode.length === 3 ? { csosn: icmsCode } : { cst: icmsCode }) } } : {}),
    };
    defaults = {
      ruleId: `federal-tax-config:${federal.companyId}`, name: 'Configuração do menu Impostos', operation: input.operation,
      // O regime já foi validado na tela Impostos; não bloqueie por divergência
      // de cadastro antigo entre empresa e estabelecimento.
      originUf: null, destUf: input.destUf, ncmPrefix: null, regime: null, productOrigin: null, recipientKind: null, priority: 999,
      version: { id: `federal-tax-config:${federal.companyId}`, version: 1, validFrom: new Date(0), validTo: null, config: { taxes }, sourceReference: 'Fiscal > Impostos' },
    };
  }
  const pendencies: Pendency[] = [];
  const used = new Map<string, EngineOutput['rulesUsed'][number]>();
  const totals: Record<string, number> = {};
  const results: ItemResult[] = [];

  if (!input.originUf || !input.destUf) pendencies.push({ code: 'MISSING_DATA', message: 'UF de origem e de destino são necessárias para selecionar a regra.' });

  for (const item of input.items) {
    const empty: ItemResult = { key: item.key, ruleVersionId: null, cfop: null, taxes: {}, totalTax: 0 };
    if (!item.ncm) { pendencies.push({ code: 'MISSING_DATA', itemKey: item.key, message: 'Item sem NCM: cadastre a classificação fiscal.' }); results.push(empty); continue; }

    const cands = rules.filter((r) => matches(r, input, item)).sort((a, b) => b.priority - a.priority || specificity(b) - specificity(a));
    if (!cands.length && defaults) cands.push(defaults);
    if (!cands.length) {
      pendencies.push({ code: 'NO_RULE', itemKey: item.key, message: `Nenhuma regra aprovada e vigente para ${input.operation} ${input.originUf ?? '?'}→${input.destUf ?? '?'} NCM ${item.ncm}. Cadastre e aprove a regra fiscal.` });
      results.push(empty);
      continue;
    }
    if (cands.length > 1 && cands[0].priority === cands[1].priority && specificity(cands[0]) === specificity(cands[1])) {
      pendencies.push({ code: 'AMBIGUOUS_RULE', itemKey: item.key, message: `Mais de uma regra igualmente específica ("${cands[0].name}" e "${cands[1].name}"): ajuste prioridade ou escopo.` });
      results.push(empty);
      continue;
    }

    const rule = cands[0];
    const cfg = rule.version.config;
    const res: ItemResult = { key: item.key, ruleVersionId: rule.version.id, cfop: cfg.cfop ?? null, taxes: {}, totalTax: 0 };
    let blocked = false;
    const taxes = { ...defaults?.version.config.taxes, ...cfg.taxes };
    // O ICMS por UF é o padrão escolhido no menu Impostos. Um código de
    // família diferente do regime do emitente não pode substituir esse padrão.
    const defaultIcms = defaults?.version.config.taxes?.ICMS;
    const ruleIcms = cfg.taxes?.ICMS;
    const simple = input.regime === 'SIMPLES_NACIONAL' || input.regime === 'MEI';
    const matchesIcmsRegime = (tax?: TaxParam) => simple ? /^\d{3}$/.test(tax?.csosn?.trim() ?? '') : /^\d{2}$/.test(tax?.cst?.trim() ?? '');
    if (defaultIcms && matchesIcmsRegime(defaultIcms) && !matchesIcmsRegime(ruleIcms)) taxes.ICMS = defaultIcms;
    for (const [code, p] of Object.entries(taxes)) {
      if ((p.kind ?? 'PERCENT') !== 'PERCENT') {
        pendencies.push({ code: 'UNSUPPORTED_TAX', itemKey: item.key, message: `${code} (${p.kind}) exige base ou margem específica e ainda não é calculado pelo motor.` });
        blocked = true;
        continue;
      }
      const gross = item.value - (item.discount ?? 0) + (cfg.includeFreightInBase ? item.freight ?? 0 : 0);
      const base = round2(gross * (1 - (p.baseReductionPct ?? 0) / 100));
      const rate = p.ratePct ?? 0;
      const amount = round2((cents(base) * rate) / 10000);
      res.taxes[code] = { ...(p.cst ? { cst: p.cst } : {}), ...(p.csosn ? { csosn: p.csosn } : {}), ...(p.classCode ? { classCode: p.classCode } : {}), base, ratePct: rate, amount };
      res.totalTax = round2(res.totalTax + amount);
      totals[code] = round2((totals[code] ?? 0) + amount);
    }
    results.push(res);
    if (!blocked) {
      used.set(rule.version.id, {
        ruleId: rule.ruleId, name: rule.name, versionId: rule.version.id, version: rule.version.version, validFrom: rule.version.validFrom.toISOString(),
        validTo: rule.version.validTo?.toISOString() ?? null, sourceReference: rule.version.sourceReference,
      });
    }
  }

  return {
    engineVersion: ENGINE_VERSION, items: results, totals, rulesUsed: [...used.values()], pendencies,
    ready: pendencies.length === 0 && results.every((r) => r.ruleVersionId !== null),
  };
}
