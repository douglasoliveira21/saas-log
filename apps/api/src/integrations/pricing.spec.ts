import { breakEvenPrice, checkPrice, evaluate, FeeProfile, normalizeFees, priceForMargin, publishableQty } from './pricing';

const fees: FeeProfile = { commissionPct: 16, paymentPct: 4, taxPct: 6, fixedFee: 6, shippingSubsidy: 10, packaging: 2, minMarginPct: 10 };
const cost = { cost: 50, extraCost: 2 };

describe('preço e margem por canal', () => {
  it('avalia resultado, margem sobre a venda e markup sobre o custo (conceitos distintos)', () => {
    const e = evaluate(150, cost, fees);
    // 26% de 150 = 39; fixos = 52 + 6 + 10 + 2 = 70; resultado = 150 − 39 − 70 = 41
    expect(e).toMatchObject({ percentDeductions: 39, fixedCosts: 70, contribution: 41 });
    expect(e.marginPct).toBe(27.33);
    expect(e.markupPct).toBe(78.85);
  });

  it('preço de equilíbrio dá resultado zero', () => {
    const be = breakEvenPrice(cost, fees)!;
    expect(be).toBe(94.6); // 70 / 0,74 = 94,5946… arredondado para cima (nunca abaixo do equilíbrio)
    expect(Math.abs(evaluate(be, cost, fees).contribution)).toBeLessThan(0.05);
  });

  it('preço recomendado entrega pelo menos a margem desejada sobre a venda', () => {
    const p = priceForMargin(20, cost, fees)!;
    expect(p).toBe(129.63); // 70 / (1 − 0,26 − 0,20) = 129,629…
    expect(evaluate(p, cost, fees).marginPct).toBeGreaterThanOrEqual(20);
    expect(evaluate(p - 0.01, cost, fees).marginPct).toBeLessThan(20.01);
  });

  it('meta impossível (percentuais + margem ≥ 100%) não gera preço', () => {
    expect(priceForMargin(75, cost, fees)).toBeNull();
    expect(priceForMargin(74, cost, fees)).toBeNull();
  });

  it('sem tarifas informadas nada é presumido', () => {
    const f = normalizeFees(undefined);
    expect(f).toEqual({ commissionPct: 0, paymentPct: 0, taxPct: 0, fixedFee: 0, shippingSubsidy: 0, packaging: 0, minMarginPct: 0 });
    expect(normalizeFees({ commissionPct: -5, taxPct: 'x' }).commissionPct).toBe(0);
  });

  it('proteções: piso do produto, margem mínima e custo ausente', () => {
    const p = { cost: 50, extraCost: 2, minPrice: 100 };
    expect(checkPrice(90, p, fees)).toMatchObject({ ok: false, reason: expect.stringMatching(/mínimo autorizado/) });
    expect(checkPrice(105, p, fees)).toMatchObject({ ok: false, reason: expect.stringMatching(/margem mínima/) });
    expect(checkPrice(150, p, fees).ok).toBe(true);
    expect(checkPrice(0, p, fees).ok).toBe(false);
    expect(checkPrice(10, { cost: null, extraCost: null, minPrice: null }, fees)).toMatchObject({ ok: false, reason: expect.stringMatching(/sem custo/) });
    expect(checkPrice(10, { cost: null, extraCost: null, minPrice: null }, { ...fees, minMarginPct: 0 }).ok).toBe(true);
  });
});

describe('estoque publicável por canal', () => {
  it('desconta a segurança e respeita o teto de publicação, nunca negativo', () => {
    expect(publishableQty(100 - 8 - 2, { safetyStock: 5 })).toBe(85); // exemplo da especificação: 100 físico, 8 reservado, 2 bloqueado, 5 segurança
    expect(publishableQty(85, { safetyStock: 5, maxPublished: 50 })).toBe(50);
    expect(publishableQty(3, { safetyStock: 5 })).toBe(0);
    expect(publishableQty(10, {})).toBe(10);
    expect(publishableQty(10, { maxPublished: 0 })).toBe(0);
  });
});
