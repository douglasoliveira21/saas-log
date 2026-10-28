'use client';

import { AlertTriangle, ArrowRight, Boxes, Clock, PackageCheck, Scale, Timer, Truck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Alert, StatCard } from '@/components/ui';
import { api } from '@/lib/api';

export interface DispatchAlert { key: string; severity: 'danger' | 'warn' | 'info'; title: string; detail: string; count: number; orders: { id: string; number: number }[] }
export interface Overview {
  today: string; cutoff: string | null; minutesToCutoff: number | null; slaHours: number; requireCheck: boolean;
  stages: { waiting: number; picking: number; packed: number; shipped: number; delivered: number };
  late: number; dueToday: number; rush: number; divergent: number; stuck: number; shippedToday: number; avgHoursToShip: number | null;
  series: { date: string; shipped: number }[]; alerts: DispatchAlert[]; weightOpenKg: number;
}

const FUNNEL: [keyof Overview['stages'], string, string][] = [['waiting', 'Aguardando separação', 'var(--dv-2)'], ['picking', 'Em separação', 'var(--dv-1)'], ['packed', 'Embalados (prontos)', 'var(--dv-3)'], ['shipped', 'Expedidos (7 dias)', 'var(--dv-7)'], ['delivered', 'Entregues (3 dias)', 'var(--ok)']];
const SEV: Record<string, string> = { danger: 'var(--danger)', warn: 'var(--warn)', info: 'var(--info)' };
const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** Painel da expedição: números por etapa, alertas com os pedidos envolvidos, funil e expedições por dia. */
export function PainelTab({ onOpenQueue }: { onOpenQueue: (filter: string, search?: string) => void }) {
  const [ov, setOv] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => { api<Overview>('/dispatch/overview').then((o) => { setOv(o); setError(''); }).catch((e) => setError(e.message)); }, []);
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  if (error) return <Alert kind="error">{error}</Alert>;
  if (!ov) return <div className="card"><span className="skeleton" style={{ height: 120, width: '100%' }} /></div>;
  const maxStage = Math.max(1, ...Object.values(ov.stages));
  const maxDay = Math.max(1, ...ov.series.map((s) => s.shipped));
  const cutoffLeft = ov.minutesToCutoff;

  return (
    <div className="stack">
      {ov.cutoff && cutoffLeft !== null && (
        <Alert kind={cutoffLeft <= 0 ? 'warn' : cutoffLeft <= 60 ? 'warn' : 'info'}>
          <strong>Horário de corte {ov.cutoff}:</strong> {cutoffLeft > 0 ? `faltam ${Math.floor(cutoffLeft / 60)} h ${cutoffLeft % 60} min. Pedidos confirmados depois disso saem no próximo dia útil.` : 'já passou. Pedidos confirmados agora saem no próximo dia útil.'}
        </Alert>
      )}

      <section aria-label="Indicadores" className="grid cols-4">
        <StatCard label="Aguardando separação" value={ov.stages.waiting} icon={<Boxes />} hint="Confirmados em Vendas" />
        <StatCard label="Em separação" value={ov.stages.picking} icon={<Clock />} />
        <StatCard label="Prontos para expedir" value={ov.stages.packed} icon={<PackageCheck />} tone="ok" hint="Embalados" />
        <StatCard label="Expedidos hoje" value={ov.shippedToday} icon={<Truck />} />
        <StatCard label="Atrasados" value={ov.late} icon={<AlertTriangle />} tone={ov.late ? 'danger' : undefined} hint={`Saída vencida ou > ${ov.slaHours} h`} />
        <StatCard label="Saem hoje" value={ov.dueToday} icon={<Timer />} tone={ov.dueToday ? 'warn' : undefined} />
        <StatCard label="Tempo até expedir" value={ov.avgHoursToShip === null ? '—' : `${String(ov.avgHoursToShip).replace('.', ',')} h`} icon={<Timer />} hint="Média dos últimos 7 dias" />
        <StatCard label="Peso em aberto" value={`${String(ov.weightOpenKg).replace('.', ',')} kg`} icon={<Scale />} hint="Ainda não expedido" />
      </section>

      <section aria-label="Alertas">
        <div className="card-head"><h2>Alertas da expedição</h2><button className="btn sm ghost" onClick={() => onOpenQueue('')}>Abrir a fila <ArrowRight /></button></div>
        {ov.alerts.length === 0 ? <div className="card empty">Tudo em dia: nenhum alerta no momento. 🎉</div> : (
          <div className="stack" style={{ gap: 10 }}>
            {ov.alerts.map((a) => (
              <div key={a.key} className="card dispatch-alert" style={{ borderLeft: `4px solid ${SEV[a.severity]}` }}>
                <div className="row" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0 }}>
                    <strong>{a.title}</strong> <span className={`badge ${a.severity === 'danger' ? 'danger' : a.severity === 'warn' ? 'warn' : 'info'}`}>{a.count}</span>
                    <div className="muted" style={{ fontSize: '0.86rem' }}>{a.detail}</div>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    {a.orders.map((o) => <button key={o.id} className="btn sm" onClick={() => onOpenQueue(a.key, String(o.number))}>#{o.number}</button>)}
                    {a.count > a.orders.length && <span className="muted">+{a.count - a.orders.length}</span>}
                    <button className="btn sm primary" onClick={() => onOpenQueue(a.key)}>Ver todos</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        <section className="card" aria-label="Funil">
          <h2>Pedidos por etapa</h2>
          <div className="stack" style={{ gap: 10 }}>
            {FUNNEL.map(([k, label, color]) => (
              <div key={k}>
                <div className="row" style={{ justifyContent: 'space-between' }}><span>{label}</span><strong>{ov.stages[k]}</strong></div>
                <div className="progress" aria-hidden><span style={{ width: `${(ov.stages[k] / maxStage) * 100}%`, background: color }} /></div>
              </div>
            ))}
          </div>
        </section>
        <section className="card" aria-label="Expedições por dia">
          <h2>Expedidos por dia <span className="muted" style={{ fontWeight: 400 }}>(7 dias)</span></h2>
          <svg viewBox="0 0 320 150" width="100%" role="img" aria-label="Pedidos expedidos por dia nos últimos 7 dias" style={{ display: 'block' }}>
            {[0, 0.5, 1].map((f) => <line key={f} x1="24" x2="316" y1={120 - f * 100} y2={120 - f * 100} stroke="var(--border)" />)}
            <text x="20" y="124" textAnchor="end" fontSize="9" fill="var(--muted)">0</text>
            <text x="20" y="24" textAnchor="end" fontSize="9" fill="var(--muted)">{maxDay}</text>
            {ov.series.map((s, i) => {
              const w = 292 / 7; const h = (s.shipped / maxDay) * 100; const x = 24 + i * w + w * 0.2;
              return (
                <g key={s.date}>
                  <rect x={x} y={120 - h} width={w * 0.6} height={Math.max(h, 1.5)} rx="3" fill="var(--dv-1)"><title>{dm(s.date)}: {s.shipped} expedido(s)</title></rect>
                  {s.shipped > 0 && <text x={x + w * 0.3} y={116 - h} textAnchor="middle" fontSize="9" fill="var(--text-2)">{s.shipped}</text>}
                  <text x={x + w * 0.3} y="138" textAnchor="middle" fontSize="9" fill="var(--muted)">{dm(s.date)}</text>
                </g>
              );
            })}
          </svg>
        </section>
      </div>
    </div>
  );
}
