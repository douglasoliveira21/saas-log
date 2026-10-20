import type { CommissionRule } from '@prisma/client';
import { commissionCents, pickRule, RuleContext } from './commissions.service';
import { lineCents } from '../sales/sales.service';

const rule = (o: Partial<CommissionRule>): CommissionRule =>
  ({
    id: 'r', tenantId: 't', name: 'r', salespersonId: null, categoryId: null, productId: null, customerId: null, channel: null, kind: 'PERCENT',
    percent: 1 as never, fixedAmount: null, priority: 0, validFrom: null, validTo: null, active: true, createdAt: new Date(2026, 0, 1), ...o,
  }) as CommissionRule;

const ctx: RuleContext = { salespersonId: 's1', categoryId: 'c1', productId: 'p1', customerId: 'k1', channel: 'DIRECT', at: new Date(2026, 5, 1) };

describe('seleção de regra de comissão', () => {
  it('maior prioridade vence; empate decide pela especificidade; inativas e fora da vigência não valem', () => {
    const general = rule({ id: 'g' });
    const cat = rule({ id: 'c', categoryId: 'c1' });
    const catSeller = rule({ id: 'cs', categoryId: 'c1', salespersonId: 's1' });
    const prio = rule({ id: 'p', priority: 5, productId: 'p1' });
    expect(pickRule([general, cat, catSeller], ctx)?.id).toBe('cs');
    expect(pickRule([general, cat, catSeller, prio], ctx)?.id).toBe('p');
    expect(pickRule([rule({ id: 'x', active: false })], ctx)).toBeNull();
    expect(pickRule([rule({ id: 'x', validTo: new Date(2026, 0, 31) })], ctx)).toBeNull();
    expect(pickRule([rule({ id: 'x', salespersonId: 'outra' })], ctx)).toBeNull();
    expect(pickRule([rule({ id: 'x', channel: 'WEB' })], ctx)).toBeNull();
  });
});

describe('cálculos em centavos', () => {
  it('comissão percentual com 4 casas e valor fixo por unidade', () => {
    expect(commissionCents(rule({ percent: 5 as never }), 9999, 3)).toBe(500);
    expect(commissionCents(rule({ percent: 2.5 as never }), 10000, 1)).toBe(250);
    expect(commissionCents(rule({ kind: 'FIXED_PER_UNIT', fixedAmount: 1.5 as never }), 0, 4)).toBe(600);
  });
  it('total da linha com desconto percentual', () => {
    expect(lineCents(5000, 2, 10)).toBe(9000);
    expect(lineCents(3333, 3, 0)).toBe(9999);
    expect(lineCents(1000, 1, 33.33)).toBe(667);
  });
});
