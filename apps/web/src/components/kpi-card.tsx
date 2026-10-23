'use client';

import type { ReactNode } from 'react';
import { MagicCard } from '@/components/magicui/magic-card';
import { NumberTicker } from '@/components/magicui/number-ticker';

type Tone = 'ok' | 'warn' | 'danger' | undefined;
const COLOR: Record<string, [string, string]> = { ok: ['var(--ok)', 'var(--info)'], warn: ['var(--warn)', 'var(--danger)'], danger: ['var(--danger)', 'var(--warn)'], brand: ['var(--brand)', 'var(--info)'] };

/** Valor que "conta" até o número final: inteiros, moeda "R$ 1.234,56" e "12,5%". Qualquer outro texto aparece como veio. */
export function AnimatedValue({ value }: { value: ReactNode }) {
  if (typeof value === 'number' && Number.isFinite(value)) return <NumberTicker value={value} />;
  if (typeof value === 'string') {
    const money = /^(-?)R\$\s?([\d.]+),(\d{2})$/.exec(value.trim());
    if (money) return <>{money[1]}R$ <NumberTicker value={Number(`${money[2].replace(/\./g, '')}.${money[3]}`)} decimalPlaces={2} /></>;
    const pct = /^(-?[\d.]+)(?:,(\d+))?\s?%$/.exec(value.trim());
    if (pct) { const d = pct[2]?.length ?? 0; return <><NumberTicker value={Number(`${pct[1].replace(/\./g, '')}${d ? `.${pct[2]}` : ''}`)} decimalPlaces={d} />%</>; }
  }
  return <>{value}</>;
}

/** Cartão de indicador com brilho que acompanha o mouse e número animado (Magic UI). */
export function KpiCard({ label, value, icon, hint, tone }: { label: string; value: ReactNode; icon?: ReactNode; hint?: ReactNode; tone?: Tone }) {
  const [from, to] = COLOR[tone ?? 'brand'];
  return (
    <MagicCard className="kpi-card" gradientColor="var(--brand-soft)" gradientFrom={from} gradientTo={to} gradientOpacity={0.9} gradientSize={180}>
      <div className={`stat kpi ${tone ?? ''}`}>
        <div className="label"><span>{label}</span>{icon && <span className="stat-ico" aria-hidden>{icon}</span>}</div>
        <div className="n"><AnimatedValue value={value} /></div>
        {hint && <div className="hint">{hint}</div>}
      </div>
    </MagicCard>
  );
}
