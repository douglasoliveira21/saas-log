import { splitForLimit, SplitError } from './nfce-split';

const sum = (p: { totalCents: number }[]) => p.reduce((s, x) => s + x.totalCents, 0);

describe('divisão da NFC-e pelo limite do cupom', () => {
  it('pedido abaixo do limite fica em um cupom só', () => {
    const r = splitForLimit([{ index: 1, quantity: 3, totalCents: 300000 }], 0, 999900);
    expect(r).toHaveLength(1);
    expect(r[0].totalCents).toBe(300000);
  });

  it('R$ 400.000,00 com limite de R$ 9.999,00 → 41 cupons (40 cheios + 1 de R$ 40,00), soma exata', () => {
    // 40.000 unidades de R$ 10,00
    const r = splitForLimit([{ index: 1, quantity: 40000, totalCents: 40000000 }], 0, 999900);
    expect(r).toHaveLength(41);
    expect(sum(r)).toBe(40000000);
    expect(Math.max(...r.map((p) => p.totalCents))).toBeLessThanOrEqual(999900);
    // a regra não deixa passar de R$ 9.999,00: o cupom cheio de unidades de R$ 10 fecha em R$ 9.990,00
    expect(r[0].totalCents).toBe(999000);
  });

  it('com unidades de R$ 1,00 os cupons ficam exatamente em R$ 9.999,00 e sobra R$ 40,00', () => {
    const r = splitForLimit([{ index: 1, quantity: 400000, totalCents: 40000000 }], 0, 999900);
    expect(r).toHaveLength(41);
    expect(r.slice(0, 40).every((p) => p.totalCents === 999900)).toBe(true);
    expect(r[40].totalCents).toBe(4000);
  });

  it('divide itens diferentes e preserva centavos (total/quantidade não exato)', () => {
    const items = [{ index: 1, quantity: 7, totalCents: 100001 }, { index: 2, quantity: 3, totalCents: 250000 }];
    const r = splitForLimit(items, 0, 150000);
    expect(sum(r)).toBe(350001);
    expect(r.every((p) => p.totalCents <= 150000)).toBe(true);
    for (const it of items) expect(r.flatMap((p) => p.items).filter((x) => x.index === it.index).reduce((s, x) => s + x.quantity, 0)).toBe(it.quantity);
  });

  it('frete vai no primeiro cupom e conta no limite', () => {
    const r = splitForLimit([{ index: 1, quantity: 10, totalCents: 100000 }], 5000, 60000);
    expect(r[0].freightCents).toBe(5000);
    expect(r.slice(1).every((p) => p.freightCents === 0)).toBe(true);
    expect(sum(r)).toBe(105000);
    expect(r.every((p) => p.totalCents <= 60000)).toBe(true);
  });

  it('uma única unidade acima do limite não tem como dividir', () => {
    expect(() => splitForLimit([{ index: 1, quantity: 1, totalCents: 1500000 }], 0, 999900)).toThrow(SplitError);
  });
});
