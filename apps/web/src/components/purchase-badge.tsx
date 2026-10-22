import { dateBr } from '@/lib/format';

export type PurchaseType = 'NEW' | 'ACTIVE' | 'RETURNING';
export interface PurchaseInfo { type: PurchaseType; lastPurchaseAt: string | null; daysSince: number | null; orders: number; totalSpent: string; inactiveAfterDays: number }

const TONE: Record<PurchaseType, string> = { NEW: 'brand', ACTIVE: 'ok', RETURNING: 'warn' };
/** Rótulos no momento da compra (selo do pedido). */
const AT_SALE: Record<PurchaseType, string> = { NEW: 'Cliente novo · 1ª compra', ACTIVE: 'Cliente ativo', RETURNING: 'Voltou a comprar' };
/** Rótulos na lista de clientes (situação de hoje). */
const NOW: Record<PurchaseType, string> = { NEW: 'Novo · nunca comprou', ACTIVE: 'Ativo', RETURNING: 'Inativo' };

/** Selo do perfil do cliente. `at="sale"` = o que ele era quando comprou; `at="now"` = situação atual. */
export function PurchaseBadge({ type, daysSince, at = 'sale' }: { type: PurchaseType | null | undefined; daysSince?: number | null; at?: 'sale' | 'now' }) {
  if (!type) return null;
  const label = (at === 'sale' ? AT_SALE : NOW)[type];
  const title = type === 'RETURNING' && daysSince != null ? (at === 'sale' ? `Estava há ${daysSince} dias sem comprar` : `Há ${daysSince} dias sem comprar`) : undefined;
  return <span className={`badge ${TONE[type]}`} title={title}>{label}{at === 'now' && type === 'RETURNING' && daysSince != null ? ` · ${daysSince} dias` : ''}</span>;
}

/** Frase de apoio para o vendedor na hora do pedido. */
export function purchaseHint(p: PurchaseInfo): string {
  if (p.type === 'NEW') return 'Primeira compra deste cliente.';
  const last = `última compra em ${dateBr(p.lastPurchaseAt)} (há ${p.daysSince} dia${p.daysSince === 1 ? '' : 's'})`;
  if (p.type === 'ACTIVE') return `Cliente ativo: ${last}; ${p.orders} pedido${p.orders === 1 ? '' : 's'} no histórico.`;
  return `Cliente que voltou: ${last}, mais de ${p.inactiveAfterDays} dias sem comprar.`;
}
