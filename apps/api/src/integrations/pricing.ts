// Cálculo de preço e margem por canal (funções puras, em centavos).
// IMPORTANTE: nenhum percentual é presumido. Comissão, tarifas e imposto vêm do perfil informado pelo usuário;
// o motor fiscal (Fase 6) substituirá o campo `taxPct` por cálculo tributário rastreável. Até lá `taxPct` é apenas
// uma estimativa informada, e a tela deve apresentá-la como tal.

export interface FeeProfile {
  commissionPct: number; // comissão do canal (% sobre o preço)
  paymentPct: number; // tarifa de pagamento (% sobre o preço)
  taxPct: number; // tributos estimados informados (% sobre o preço) — NÃO calculados pelo sistema
  fixedFee: number; // tarifa fixa por pedido (R$)
  shippingSubsidy: number; // frete subsidiado pelo vendedor (R$)
  packaging: number; // embalagem (R$)
  minMarginPct: number; // margem mínima de contribuição sobre a venda (%)
}

export const EMPTY_FEES: FeeProfile = { commissionPct: 0, paymentPct: 0, taxPct: 0, fixedFee: 0, shippingSubsidy: 0, packaging: 0, minMarginPct: 0 };

export function normalizeFees(raw: unknown): FeeProfile {
  const r = (raw ?? {}) as Partial<Record<keyof FeeProfile, unknown>>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    commissionPct: n(r.commissionPct), paymentPct: n(r.paymentPct), taxPct: n(r.taxPct), fixedFee: n(r.fixedFee),
    shippingSubsidy: n(r.shippingSubsidy), packaging: n(r.packaging), minMarginPct: n(r.minMarginPct),
  };
}

const c = (reais: number) => Math.round(reais * 100);
const r2 = (cents: number) => Math.round(cents) / 100;

export interface Evaluation {
  price: number;
  percentDeductions: number; // R$ retidos em % (comissão + pagamento + tributos estimados)
  fixedCosts: number; // custo do produto + tarifa fixa + frete + embalagem
  contribution: number; // resultado por unidade
  marginPct: number; // margem de contribuição sobre a VENDA
  markupPct: number | null; // sobre o CUSTO do produto (diferente de margem)
}

export interface CostInput {
  cost: number; // custo de aquisição
  extraCost: number; // custo adicional de recebimento
}

export const percentTotal = (f: FeeProfile) => f.commissionPct + f.paymentPct + f.taxPct;
export const fixedTotal = (cost: CostInput, f: FeeProfile) => cost.cost + cost.extraCost + f.fixedFee + f.shippingSubsidy + f.packaging;

export function evaluate(price: number, cost: CostInput, f: FeeProfile): Evaluation {
  const p = c(price);
  const pct = Math.round((p * percentTotal(f)) / 100);
  const fixed = c(fixedTotal(cost, f));
  const contribution = p - pct - fixed;
  const base = c(cost.cost + cost.extraCost);
  return {
    price: r2(p), percentDeductions: r2(pct), fixedCosts: r2(fixed), contribution: r2(contribution),
    marginPct: p > 0 ? Math.round((contribution / p) * 10000) / 100 : 0,
    markupPct: base > 0 ? Math.round((contribution / base) * 10000) / 100 : null,
  };
}

/** Preço de equilíbrio (resultado zero). Null se os percentuais consomem 100% do preço. */
export function breakEvenPrice(cost: CostInput, f: FeeProfile): number | null {
  return priceForMargin(0, cost, f);
}

/**
 * Preço que entrega a margem desejada SOBRE A VENDA:
 *   preço = custos fixos / (1 − %variáveis − margem)
 * Null quando %variáveis + margem >= 100% (meta impossível). Arredonda para cima ao centavo para não ficar abaixo da meta.
 */
export function priceForMargin(marginPct: number, cost: CostInput, f: FeeProfile): number | null {
  const denom = 1 - (percentTotal(f) + marginPct) / 100;
  if (denom <= 0.0001) return null;
  return Math.ceil((c(fixedTotal(cost, f)) / denom) - 1e-9) / 100;
}

export type PriceCheck = { ok: true; evaluation: Evaluation | null } | { ok: false; reason: string; evaluation: Evaluation | null };

/** Proteções de preço: piso do produto e margem mínima do canal. */
export function checkPrice(price: number, p: { cost: number | null; extraCost: number | null; minPrice: number | null }, f: FeeProfile): PriceCheck {
  if (!(price > 0)) return { ok: false, reason: 'O preço deve ser maior que zero.', evaluation: null };
  if (p.minPrice !== null && c(price) < c(p.minPrice)) return { ok: false, reason: `Preço abaixo do mínimo autorizado do produto (R$ ${p.minPrice.toFixed(2)}).`, evaluation: null };
  if (p.cost === null) {
    return f.minMarginPct > 0
      ? { ok: false, reason: 'Produto sem custo cadastrado: não é possível garantir a margem mínima do canal.', evaluation: null }
      : { ok: true, evaluation: null };
  }
  const ev = evaluate(price, { cost: p.cost, extraCost: p.extraCost ?? 0 }, f);
  if (ev.marginPct < f.minMarginPct) return { ok: false, reason: `Margem de ${ev.marginPct.toFixed(2)}% abaixo da margem mínima do canal (${f.minMarginPct}%).`, evaluation: ev };
  return { ok: true, evaluation: ev };
}

/**
 * Quantidade a publicar no canal. Regra documentada (docs/INVENTORY.md):
 *   publicável = max(0, disponível do depósito − estoque de segurança), limitada por `maxPublished` quando definido.
 * `disponível` = físico − reservado − bloqueado (já considera reservas de pedidos de qualquer canal).
 */
export function publishableQty(available: number, cfg: { safetyStock?: number; maxPublished?: number | null }): number {
  const raw = Math.max(0, available - Math.max(0, cfg.safetyStock ?? 0));
  return cfg.maxPublished != null ? Math.min(raw, Math.max(0, cfg.maxPublished)) : raw;
}
