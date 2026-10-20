'use client';

import { siAliexpress, siEbay, siEtsy, siShopee, siShopify, siTiktok, siVtex, siWoocommerce, type SimpleIcon } from 'simple-icons';
import { useEffect, useState } from 'react';

interface Brand { icon?: SimpleIcon; bg?: string; fg?: string; text?: string }

/**
 * Marcas com ícone vetorial genérico (pacote simple-icons) ou, quando não há, uma sigla na cor da marca.
 * Os nomes e logotipos pertencem aos respectivos titulares e aparecem apenas para identificar o canal.
 * Logotipos oficiais colocados em public/marketplaces/<chave>.svg|png têm prioridade (ver LEIAME.txt lá).
 */
const BRANDS: Record<string, Brand> = {
  SHOPEE: { icon: siShopee }, ALIEXPRESS: { icon: siAliexpress }, TIKTOK_SHOP: { icon: siTiktok }, EBAY: { icon: siEbay }, ETSY: { icon: siEtsy },
  SHOPIFY: { icon: siShopify }, WOOCOMMERCE: { icon: siWoocommerce }, VTEX: { icon: siVtex },
  MERCADO_LIVRE: { bg: '#FFE600', fg: '#2D3277', text: 'ML' }, AMAZON: { bg: '#232F3E', fg: '#FF9900', text: 'a' }, MAGALU: { bg: '#0086FF', fg: '#FFFFFF', text: 'M' },
  AMERICANAS: { bg: '#E60014', fg: '#FFFFFF', text: 'A' }, CASAS_BAHIA: { bg: '#0A4EA3', fg: '#FFFFFF', text: 'CB' }, OLX: { bg: '#6E0AD6', fg: '#FFFFFF', text: 'OLX' },
  WALMART: { bg: '#0071CE', fg: '#FFFFFF', text: 'W' }, BLING: { bg: '#3FA535', fg: '#FFFFFF', text: 'B' },
};

let officialCache: Promise<Record<string, string>> | null = null;
function loadOfficial() {
  officialCache ??= fetch('/logos').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return officialCache;
}

export function MarketplaceLogo({ provider, name, size = 44 }: { provider: string; name: string; size?: number }) {
  const [official, setOfficial] = useState<string | null>(null);
  useEffect(() => { let on = true; void loadOfficial().then((m) => { if (on) setOfficial(m[provider.toLowerCase()] ?? null); }); return () => { on = false; }; }, [provider]);

  const box = { width: size, height: size, borderRadius: Math.round(size * 0.22), flex: 'none' as const, display: 'grid', placeItems: 'center', border: '1px solid var(--border)', overflow: 'hidden' };
  if (official) {
    // eslint-disable-next-line @next/next/no-img-element
    return <span style={{ ...box, background: '#fff', padding: 6 }}><img src={official} alt={`Logotipo ${name}`} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} /></span>;
  }
  const b = BRANDS[provider];
  if (b?.icon) {
    return <span style={{ ...box, background: '#fff' }} role="img" aria-label={`Logotipo ${name}`}><svg viewBox="0 0 24 24" width={size * 0.58} height={size * 0.58} aria-hidden><path d={b.icon.path} fill={`#${b.icon.hex}`} /></svg></span>;
  }
  const text = b?.text ?? name.replace(/[^A-Za-zÀ-ú ]/g, '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
  return <span style={{ ...box, background: b?.bg ?? '#334155', color: b?.fg ?? '#fff', fontWeight: 800, fontSize: size * (text.length > 2 ? 0.28 : 0.38), letterSpacing: '-0.02em' }} role="img" aria-label={`Ícone ${name}`}>{text}</span>;
}
