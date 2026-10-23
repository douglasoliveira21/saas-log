'use client';

import { useEffect, useRef, useState } from 'react';
import { MagicCard } from '@/components/magicui/magic-card';
import { Alert } from '@/components/ui';
import { api } from '@/lib/api';
import { brl } from '@/lib/format';

interface Bar { id: string | null; name: string; total: number; orders?: number; quantity?: number; sku?: string }
interface Charts { days: number; totalSold: number; orders: number; topCustomers: Bar[]; topProducts: Bar[]; bySalesperson: Bar[]; basis: string }
const PERIODS = [[7, '7 dias'], [30, '30 dias'], [90, '90 dias'], [365, '12 meses']] as const;
const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi` : n >= 1_000 ? `${(n / 1_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : String(Math.round(n)));
const niceMax = (v: number) => { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };

type Tip = { x: number; y: number; title: string; lines: string[] } | null;

/** Barras verticais: o nome só aparece ao passar o mouse (ou focar com o teclado); abaixo de cada barra fica só a posição no ranking. */
function BarChart({ data, label, unit, wide = false }: { data: Bar[]; label: string; unit: string; wide?: boolean }) {
  const [tip, setTip] = useState<Tip>(null);
  const ref = useRef<HTMLDivElement>(null);
  const W = wide ? 1120 : 560; const H = 230; const L = 46; const B = 28; const T = 12; const R = 8;
  const max = niceMax(Math.max(...data.map((d) => d.total), 0));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const bw = (W - L - R) / Math.max(data.length, 1);
  const barW = Math.min(44, bw * 0.62);
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const show = (e: { clientX: number; clientY: number }, d: Bar, i: number) => {
    const r = ref.current!.getBoundingClientRect();
    setTip({ x: e.clientX - r.left, y: e.clientY - r.top - 10, title: `${i + 1}º · ${d.name}`, lines: [brl(d.total), `${d.orders ?? 0} pedido(s)`] });
  };
  return (
    <div className="dv-wrap" ref={ref} onMouseLeave={() => setTip(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label} style={{ display: 'block' }}>
        {ticks.map((t) => (
          <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} /><text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize="10" fill="var(--muted)">{compact(t)}</text></g>
        ))}
        {data.map((d, i) => {
          const x = L + bw * i + (bw - barW) / 2; const h = Math.max(2, y(0) - y(d.total));
          return (
            <g key={`${d.id}-${i}`}>
              <rect x={L + bw * i} y={T} width={bw} height={H - T - B} fill="transparent" onMouseMove={(e) => show(e, d, i)} onMouseEnter={(e) => show(e, d, i)} />
              <path className="dv-bar" tabIndex={0} aria-label={`${i + 1}º ${d.name}: ${brl(d.total)}`}
                d={`M${x},${y(0)} V${y(0) - h + 4} Q${x},${y(0) - h} ${x + 4},${y(0) - h} H${x + barW - 4} Q${x + barW},${y(0) - h} ${x + barW},${y(0) - h + 4} V${y(0)} Z`} fill="var(--dv-1)"
                onMouseMove={(e) => show(e, d, i)} onFocus={() => { const r = ref.current!.getBoundingClientRect(); setTip({ x: x + barW / 2 + 0 * r.left, y: y(d.total), title: `${i + 1}º · ${d.name}`, lines: [brl(d.total), `${d.orders ?? 0} pedido(s)`] }); }} onBlur={() => setTip(null)} />
              <text x={x + barW / 2} y={H - 10} textAnchor="middle" fontSize="11" fill="var(--muted)">{i + 1}º</text>
            </g>
          );
        })}
        <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} stroke="var(--border-strong)" strokeWidth={1} />
      </svg>
      {tip && <div className="dv-tip" role="status" style={{ left: Math.max(tip.x, 90), top: Math.max(tip.y, 40) }}><b>{tip.title}</b>{tip.lines.map((l) => <span key={l} style={{ display: 'block', color: 'var(--text-2)' }}>{l}</span>)}</div>}
      <p className="muted" style={{ margin: '4px 0 0', fontSize: '0.76rem' }}>{unit}</p>
    </div>
  );
}

/** Pizza: fatias na ordem fixa da paleta (a última, “Outros”, em cinza). Nome e valor ao passar o mouse e na legenda ao lado. */
function PieChart({ data, label }: { data: Bar[]; label: string }) {
  const [hot, setHot] = useState<number | null>(null);
  const total = data.reduce((s, d) => s + d.total, 0);
  const R = 82; const C = 100;
  let acc = 0;
  const colorOf = (d: Bar, i: number) => (d.id === null ? 'var(--dv-other)' : `var(--dv-${(i % 8) + 1})`);
  const slices = data.map((d, i) => {
    const a0 = (acc / total) * Math.PI * 2 - Math.PI / 2; acc += d.total; const a1 = (acc / total) * Math.PI * 2 - Math.PI / 2;
    const large = a1 - a0 > Math.PI ? 1 : 0; const pt = (a: number, r: number) => [C + r * Math.cos(a), C + r * Math.sin(a)];
    const [x0, y0] = pt(a0, R); const [x1, y1] = pt(a1, R);
    const path = data.length === 1 ? `M${C},${C - R} A${R},${R} 0 1 1 ${C - 0.01},${C - R} Z` : `M${C},${C} L${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1} Z`;
    return { d, i, path };
  });
  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
      <svg viewBox="0 0 200 200" width={200} height={200} role="img" aria-label={label} style={{ flex: 'none' }} onMouseLeave={() => setHot(null)}>
        {slices.map(({ d, i, path }) => (
          <path key={`${d.id}-${i}`} d={path} fill={colorOf(d, i)} stroke="var(--surface)" strokeWidth={2} tabIndex={0} aria-label={`${d.name}: ${brl(d.total)} (${((d.total / total) * 100).toFixed(1)}%)`}
            style={{ opacity: hot === null || hot === i ? 1 : 0.4, transition: 'opacity .12s', outline: 'none', transform: hot === i ? 'scale(1.03)' : undefined, transformOrigin: '100px 100px' }}
            onMouseEnter={() => setHot(i)} onFocus={() => setHot(i)} onBlur={() => setHot(null)} />
        ))}
        {hot !== null && <g pointerEvents="none"><circle cx={C} cy={C} r={42} fill="var(--surface)" /><text x={C} y={C - 2} textAnchor="middle" fontSize="15" fontWeight="650" fill="var(--text)">{((data[hot].total / total) * 100).toFixed(1).replace('.', ',')}%</text><text x={C} y={C + 15} textAnchor="middle" fontSize="10" fill="var(--muted)">{compact(data[hot].total)}</text></g>}
      </svg>
      <ul className="dv-legend" style={{ flex: 1, minWidth: 180 }}>
        {data.map((d, i) => (
          <li key={`${d.id}-${i}`} onMouseEnter={() => setHot(i)} onMouseLeave={() => setHot(null)} style={{ fontWeight: hot === i ? 600 : 400 }} title={`${d.name} — ${brl(d.total)}${d.quantity ? ` · ${d.quantity} un.` : ''}`}>
            <span className="sw" style={{ background: colorOf(d, i) }} /><span className="nm">{d.name}</span><span className="muted" style={{ flex: 'none' }}>{((d.total / total) * 100).toFixed(0)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChartCard({ title, children, wide = false }: { title: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <MagicCard className="chart-card" gradientColor="var(--brand-soft)" gradientFrom="var(--brand)" gradientTo="var(--info)" gradientOpacity={0.55} gradientSize={260}>
      <div className="chart-in" style={wide ? undefined : undefined}><h3>{title}</h3>{children}</div>
    </MagicCard>
  );
}

/** Painel de gráficos de venda do dashboard: clientes que mais compraram, produtos mais vendidos e ranking de vendedores. */
export function SalesCharts() {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<Charts | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { setData(null); api<Charts>(`/dashboard/sales-charts?days=${days}`).then(setData).catch((e) => setError(e.message)); }, [days]);

  return (
    <section aria-label="Gráficos de vendas">
      <div className="card-head">
        <h2>Vendas por cliente, produto e vendedor</h2>
        <div className="row" role="group" aria-label="Período">{PERIODS.map(([d, l]) => <button key={d} className={`btn sm ${days === d ? 'primary' : 'ghost'}`} aria-pressed={days === d} onClick={() => setDays(d)}>{l}</button>)}</div>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {!data && !error && <div className="card"><span className="skeleton" style={{ height: 220, width: '100%' }} /></div>}
      {data && data.orders === 0 && <div className="card empty">Nenhuma venda confirmada nos últimos {PERIODS.find(([d]) => d === days)?.[1]}.</div>}
      {data && data.orders > 0 && (
        <>
          <p className="muted" style={{ margin: '0 0 8px' }}>{brl(data.totalSold)} em {data.orders} pedido(s). {data.basis}</p>
          <div className="grid cols-2 charts-grid" style={{ alignItems: 'start' }}>
            <ChartCard title="Clientes com maior valor em vendas"><BarChart data={data.topCustomers} label="Clientes com maior valor em vendas" unit="Posição no ranking (passe o mouse na barra para ver o cliente) · valores em R$" /></ChartCard>
            <ChartCard title="Produtos com maior venda"><PieChart data={data.topProducts} label="Produtos com maior venda, em pizza" /></ChartCard>
            <ChartCard title="Ranking de vendas por vendedor" wide><BarChart data={data.bySalesperson} label="Ranking de vendas por vendedor" wide unit="Posição no ranking (passe o mouse na barra para ver o vendedor) · valores em R$" /></ChartCard>
          </div>
          <details style={{ marginTop: 8 }}><summary className="muted">Ver como tabela</summary>
            <div className="table-wrap"><table><thead><tr><th>Cliente</th><th className="num">Vendido</th><th>Vendedor</th><th className="num">Vendido</th></tr></thead>
              <tbody>{Array.from({ length: Math.max(data.topCustomers.length, data.bySalesperson.length) }).map((_, i) => (
                <tr key={i}><td>{data.topCustomers[i]?.name ?? ''}</td><td className="num">{data.topCustomers[i] ? brl(data.topCustomers[i].total) : ''}</td><td>{data.bySalesperson[i]?.name ?? ''}</td><td className="num">{data.bySalesperson[i] ? brl(data.bySalesperson[i].total) : ''}</td></tr>
              ))}</tbody></table></div>
          </details>
        </>
      )}
    </section>
  );
}
