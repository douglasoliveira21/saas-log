/** Limite padrão de valor por cupom (NFC-e), em reais. Configurável por empresa (fiscal.nfceMaxValue); 0 desliga a divisão. */
export const DEFAULT_NFCE_MAX = 9999;

export interface SplitItem { index: number; quantity: number; totalCents: number }
export interface SplitPart { items: SplitItem[]; freightCents: number; totalCents: number }

export class SplitError extends Error {}

/**
 * Divide um pedido em cupons que não passam de `limitCents`. Trabalha em centavos (sem arredondamento de ponto flutuante):
 * cada unidade de um item custa `total/quantidade` (as sobras de centavo vão para as primeiras unidades) e as unidades são
 * distribuídas em ordem, de modo que a soma dos cupons é SEMPRE igual ao total do pedido. O frete vai no primeiro cupom.
 * Uma unidade nunca é partida: se uma única unidade custa mais que o limite, não há como dividir (erro).
 */
export function splitForLimit(items: SplitItem[], freightCents: number, limitCents: number): SplitPart[] {
  if (!Number.isInteger(limitCents) || limitCents <= 0) throw new SplitError('Limite por cupom inválido.');
  if (freightCents >= limitCents) throw new SplitError('O frete sozinho já atinge o limite do cupom.');
  const parts: SplitPart[] = [];
  let cur: SplitPart = { items: [], freightCents, totalCents: freightCents };
  const close = () => { parts.push(cur); cur = { items: [], freightCents: 0, totalCents: 0 }; };

  for (const it of items) {
    if (it.quantity <= 0 || it.totalCents < 0) throw new SplitError(`Item ${it.index} com quantidade ou valor inválido.`);
    const base = Math.floor(it.totalCents / it.quantity);
    const rem = it.totalCents - base * it.quantity;
    if (base + (rem > 0 ? 1 : 0) > limitCents) throw new SplitError(`Uma única unidade do item ${it.index} custa mais que o limite do cupom; não é possível dividir.`);
    let chunkQty = 0; let chunkCents = 0;
    const flush = () => { if (chunkQty) { cur.items.push({ index: it.index, quantity: chunkQty, totalCents: chunkCents }); cur.totalCents += chunkCents; chunkQty = 0; chunkCents = 0; } };
    for (let k = 0; k < it.quantity; k++) {
      const unit = base + (k < rem ? 1 : 0);
      if (cur.totalCents + chunkCents + unit > limitCents) {
        if (!cur.items.length && !chunkQty) throw new SplitError('O frete somado a uma unidade do item já passa do limite do cupom.');
        flush(); close();
      }
      chunkQty++; chunkCents += unit;
    }
    flush();
  }
  if (cur.items.length || !parts.length) parts.push(cur);
  return parts;
}
