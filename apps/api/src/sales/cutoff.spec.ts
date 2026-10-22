import { classifyPurchase } from '../customers/purchase-profile';
import { computeDispatch } from './cutoff';

// America/Sao_Paulo = UTC-3. 2026-10-21 é quarta-feira.
const at = (iso: string) => new Date(iso);

describe('horário de corte', () => {
  it('antes do corte sai no mesmo dia; no horário exato ou depois, no próximo dia útil', () => {
    expect(computeDispatch(at('2026-10-21T18:59:00Z'), '16:00', true)).toEqual({ dispatchDate: '2026-10-21', deferred: false, today: '2026-10-21' });
    expect(computeDispatch(at('2026-10-21T19:00:00Z'), '16:00', true)).toEqual({ dispatchDate: '2026-10-22', deferred: true, today: '2026-10-21' });
    expect(computeDispatch(at('2026-10-21T23:30:00Z'), '16:00', true).dispatchDate).toBe('2026-10-22');
  });

  it('usa a data local (madrugada em UTC ainda é o dia anterior no Brasil)', () => {
    // 02:00Z de quinta = 23:00 de quarta no Brasil → depois do corte de quarta → quinta
    expect(computeDispatch(at('2026-10-22T02:00:00Z'), '16:00', true)).toMatchObject({ today: '2026-10-21', dispatchDate: '2026-10-22' });
    // 12:00Z = 09:00 local
    expect(computeDispatch(at('2026-10-22T12:00:00Z'), '16:00', true)).toMatchObject({ today: '2026-10-22', dispatchDate: '2026-10-22', deferred: false });
  });

  it('só dias úteis: sexta depois do corte, sábado e domingo saem na segunda', () => {
    expect(computeDispatch(at('2026-10-23T20:00:00Z'), '16:00', true).dispatchDate).toBe('2026-10-26'); // sexta 17:00
    expect(computeDispatch(at('2026-10-24T13:00:00Z'), '16:00', true)).toMatchObject({ dispatchDate: '2026-10-26', deferred: true }); // sábado 10:00
    expect(computeDispatch(at('2026-10-25T13:00:00Z'), '16:00', true).dispatchDate).toBe('2026-10-26');
    expect(computeDispatch(at('2026-10-23T17:00:00Z'), '16:00', true).dispatchDate).toBe('2026-10-23'); // sexta 14:00
  });

  it('sem restringir a dias úteis, sábado antes do corte sai no sábado', () => {
    expect(computeDispatch(at('2026-10-24T13:00:00Z'), '16:00', false)).toMatchObject({ dispatchDate: '2026-10-24', deferred: false });
    expect(computeDispatch(at('2026-10-24T20:00:00Z'), '16:00', false).dispatchDate).toBe('2026-10-25');
  });

  it('recusa horário inválido', () => {
    expect(() => computeDispatch(new Date(), '25:00', true)).toThrow();
    expect(() => computeDispatch(new Date(), '16h', true)).toThrow();
  });
});

describe('perfil de compra do cliente', () => {
  const now = new Date('2026-10-21T12:00:00Z');
  const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);

  it('sem compras é cliente novo', () => {
    expect(classifyPurchase(null, now, 60)).toEqual({ type: 'NEW', daysSince: null });
  });
  it('comprou dentro do prazo é ativo (inclusive no limite)', () => {
    expect(classifyPurchase(ago(5), now, 60)).toEqual({ type: 'ACTIVE', daysSince: 5 });
    expect(classifyPurchase(ago(60), now, 60).type).toBe('ACTIVE');
  });
  it('mais dias que o prazo sem comprar = voltou a comprar', () => {
    expect(classifyPurchase(ago(61), now, 60)).toEqual({ type: 'RETURNING', daysSince: 61 });
    expect(classifyPurchase(ago(400), now, 60).type).toBe('RETURNING');
  });
  it('o prazo configurado muda a classificação', () => {
    expect(classifyPurchase(ago(40), now, 30).type).toBe('RETURNING');
    expect(classifyPurchase(ago(40), now, 90).type).toBe('ACTIVE');
  });
});
