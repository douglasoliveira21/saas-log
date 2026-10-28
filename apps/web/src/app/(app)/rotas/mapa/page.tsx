'use client';

import { Gauge, MapPinOff, Navigation, RefreshCw, Route as RouteIcon, SignalZero, Timer } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LiveMap, type MapLine, type MapMarker } from '@/components/live-map';
import { Alert, EmptyState, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

type Flag = 'GPS_OFF' | 'NO_SIGNAL' | 'OFF_ROUTE' | 'STOPPED';
interface LiveStop { id: string; sequence: number; status: string; customer: string; address: string; lat: number | null; lng: number | null }
interface LiveRoute {
  routeId: string; number: number; startedAt: string | null;
  driver: { id: string; name: string; phone: string | null }; vehicle: { plate: string | null; description: string | null } | null;
  position: { lat: number | null; lng: number | null; accuracyM: number | null; speedKmh: number | null; recordedAt: string | null; ageSeconds: number; source: string } | null;
  gps: { enabled: boolean; permission: string | null } | null; flags: Flag[]; offRouteM: number | null;
  progress: { total: number; delivered: number; failed: number; pending: number };
  next: { stopId: string; sequence: number; customer: string; address: string; distanceM: number | null; etaMinutes: number | null } | null;
  plan: { calculated: boolean; distanceM: number | null; durationS: number | null };
  stops: LiveStop[];
}
interface Track { trail: { lat: number; lng: number }[]; points: number; travelledM: number; plan: { geometry: [number, number][] }; stops: LiveStop[] }

const FLAG_TEXT: Record<Flag, string> = { GPS_OFF: 'GPS desligado ou bloqueado', NO_SIGNAL: 'Sem sinal', OFF_ROUTE: 'Fora da rota', STOPPED: 'Parado há muito tempo' };
const km = (m: number | null) => (m === null ? '—' : m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`);
const ago = (s: number) => (s < 90 ? 'agora há pouco' : s < 3600 ? `há ${Math.round(s / 60)} min` : `há ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);

/** Mapa ao vivo da gestão: onde está cada motorista com rota em andamento, o trajeto planejado, a trilha percorrida e os alertas. */
export default function MapaAoVivoPage() {
  const { can } = useSession();
  const [routes, setRoutes] = useState<LiveRoute[] | null>(null);
  const [sel, setSel] = useState('');
  const [track, setTrack] = useState<Track | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [updated, setUpdated] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try { setRoutes(await api<LiveRoute[]>('/delivery/tracking')); setUpdated(new Date()); setError(''); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); const id = setInterval(() => void load(), 10_000); return () => clearInterval(id); }, [load]);

  const current = routes?.find((r) => r.routeId === sel) ?? null;
  const selected = current?.routeId ?? '';
  useEffect(() => {
    if (!selected) { setTrack(null); return; }
    let dead = false;
    const get = () => api<Track>(`/delivery/routes/${selected}/track`).then((t) => { if (!dead) setTrack(t); }).catch(() => undefined);
    void get(); const id = setInterval(get, 10_000);
    return () => { dead = true; clearInterval(id); };
  }, [selected]);

  async function plan(id: string) {
    setBusy(true); setNote(''); setError('');
    try {
      const r = await api<{ geocoded: number; notFound: number; errors: number; routeCalculated: boolean; routingConfigured: boolean }>(`/delivery/routes/${id}/plan`, 'POST');
      setNote(`${r.geocoded} endereço(s) localizado(s)${r.notFound ? `, ${r.notFound} não encontrado(s)` : ''}${r.errors ? `, ${r.errors} com erro de consulta` : ''}. ${r.routeCalculated ? 'Trajeto calculado.' : r.routingConfigured ? 'O trajeto não pôde ser calculado agora.' : 'O trajeto pelas ruas não foi calculado porque a chave do serviço de rotas (ORS_API_KEY) não está configurada.'}`);
      await load(); setTrack(await api<Track>(`/delivery/routes/${id}/track`));
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  const alerts = useMemo(() => (routes ?? []).flatMap((r) => r.flags.map((f) => ({ r, f }))), [routes]);

  const { markers, lines, fitKey } = useMemo(() => {
    const markers: MapMarker[] = []; const lines: MapLine[] = [];
    for (const r of routes ?? []) {
      if (r.position?.lat == null || r.position.lng == null) continue;
      const bad = r.flags.includes('GPS_OFF') || r.flags.includes('OFF_ROUTE');
      const warn = r.flags.length > 0;
      markers.push({ id: `d-${r.routeId}`, kind: 'driver', lat: r.position.lat, lng: r.position.lng, tag: r.driver.name.trim().charAt(0).toUpperCase(), tone: bad ? 'bad' : warn ? 'warn' : 'ok', title: r.driver.name, detail: `Rota #${r.number} · ${r.position.speedKmh ?? 0} km/h · ${ago(r.position.ageSeconds)}`, onClick: () => setSel(r.routeId) });
    }
    if (current && track) {
      if (track.plan.geometry.length > 1) lines.push({ id: 'plan', kind: 'plan', points: track.plan.geometry });
      if (track.trail.length > 1) lines.push({ id: 'trail', kind: 'trail', points: track.trail.map((p) => [p.lat, p.lng]) });
      for (const s of track.stops) {
        if (s.lat == null || s.lng == null) continue;
        markers.push({ id: `s-${s.id}`, kind: 'stop', lat: s.lat, lng: s.lng, tag: String(s.sequence), tone: s.status === 'DELIVERED' ? 'ok' : s.status === 'FAILED' ? 'bad' : 'brand', title: `${s.sequence}. ${s.customer}`, detail: s.address });
      }
    }
    return { markers, lines, fitKey: selected || 'all' };
  }, [routes, track, current, selected]);

  return (
    <>
      <PageHeader
        title="Mapa ao vivo"
        description="Onde está cada motorista com rota em andamento, o trajeto planejado e a trilha percorrida. A localização só é registrada enquanto a rota está em andamento."
        actions={<><Link className="btn" href="/rotas"><RouteIcon aria-hidden />Rotas e entregas</Link><button className="btn" onClick={() => void load()}><RefreshCw aria-hidden />Atualizar</button></>}
      />
      {error && <Alert kind="error">{error}</Alert>}
      {note && <Alert kind="info">{note}</Alert>}

      {alerts.length > 0 && (
        <section className="card dispatch-alert" aria-label="Alertas dos motoristas" style={{ marginBottom: 12 }}>
          <strong>Alertas ({alerts.length})</strong>
          <ul className="live-alerts">
            {alerts.map(({ r, f }) => (
              <li key={`${r.routeId}-${f}`}>
                <button type="button" className="link" onClick={() => setSel(r.routeId)}>
                  <span className={`badge ${f === 'OFF_ROUTE' || f === 'GPS_OFF' ? 'danger' : 'warn'}`}>{FLAG_TEXT[f]}</span> {r.driver.name} · rota #{r.number}
                  {f === 'OFF_ROUTE' && r.offRouteM ? ` · a ${km(r.offRouteM)} do trajeto` : ''}{f === 'NO_SIGNAL' && r.position ? ` · última posição ${ago(r.position.ageSeconds)}` : ''}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {routes && routes.length === 0 && <EmptyState icon={<Navigation size={22} />} title="Nenhuma rota em andamento">Quando uma rota for iniciada em <Link href="/rotas">Rotas e entregas</Link>, o motorista aparece aqui em tempo real.</EmptyState>}

      {routes && routes.length > 0 && (
        <div className="live-grid">
          <div className="live-list" aria-label="Rotas em andamento">
            {routes.map((r) => (
              <article key={r.routeId} className={`card live-card ${r.routeId === selected ? 'sel' : ''} ${r.flags.length ? 'has-flag' : ''}`}>
                <button type="button" className="live-card-btn" onClick={() => setSel(r.routeId === selected ? '' : r.routeId)} aria-pressed={r.routeId === selected}>
                  <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                    <strong>{r.driver.name}</strong><span className="muted">Rota #{r.number}</span>
                  </div>
                  <div className="muted" style={{ fontSize: '0.84rem' }}>{[r.vehicle?.plate, r.vehicle?.description].filter(Boolean).join(' · ') || 'Sem veículo informado'}</div>
                  <div className="progress" style={{ margin: '6px 0' }} role="progressbar" aria-valuemin={0} aria-valuemax={r.progress.total} aria-valuenow={r.progress.delivered + r.progress.failed} aria-label="Entregas feitas"><span style={{ width: `${r.progress.total ? ((r.progress.delivered + r.progress.failed) / r.progress.total) * 100 : 0}%` }} /></div>
                  <div className="muted" style={{ fontSize: '0.82rem' }}>{r.progress.delivered} entregue(s), {r.progress.failed} não entregue(s), {r.progress.pending} pendente(s)</div>
                  <div className="live-flags">
                    {r.flags.length === 0 && <span className="badge ok">Tudo certo</span>}
                    {r.flags.map((f) => <span key={f} className={`badge ${f === 'OFF_ROUTE' || f === 'GPS_OFF' ? 'danger' : 'warn'}`}>{f === 'NO_SIGNAL' ? <SignalZero size={12} aria-hidden /> : f === 'STOPPED' ? <Timer size={12} aria-hidden /> : <MapPinOff size={12} aria-hidden />}{FLAG_TEXT[f]}</span>)}
                  </div>
                  {r.position?.lat != null && <div className="muted" style={{ fontSize: '0.8rem' }}><Gauge size={12} aria-hidden style={{ verticalAlign: '-2px' }} /> {r.position.speedKmh ?? 0} km/h · posição {ago(r.position.ageSeconds)}{r.position.source === 'WEB' ? ' · pelo navegador' : ''}</div>}
                  {r.next && <div style={{ fontSize: '0.84rem', marginTop: 4 }}>Próxima: <strong>{r.next.sequence}. {r.next.customer}</strong>{r.next.distanceM !== null && <> — {km(r.next.distanceM)} em linha reta, cerca de {r.next.etaMinutes} min</>}</div>}
                </button>
                {r.routeId === selected && (
                  <div className="live-detail">
                    {r.driver.phone && <a className="btn sm" href={`tel:${r.driver.phone}`}>Ligar para o motorista</a>}
                    {can('routes.manage') && <button className={`btn sm ${busy ? 'loading' : ''}`} disabled={busy} onClick={() => void plan(r.routeId)}>{r.plan.calculated ? 'Recalcular trajeto' : 'Calcular trajeto'}</button>}
                    {track && <span className="muted" style={{ fontSize: '0.8rem' }}>Percorrido: {km(track.travelledM)} ({track.points} pontos){r.plan.distanceM ? ` · planejado: ${km(r.plan.distanceM)}` : ''}</span>}
                    {!r.plan.calculated && <span className="muted" style={{ fontSize: '0.8rem' }}>Trajeto pelas ruas ainda não calculado: o mapa mostra só as paradas e a posição.</span>}
                  </div>
                )}
              </article>
            ))}
          </div>
          <div className="live-map-col">
            <LiveMap markers={markers} lines={lines} fitKey={fitKey} height={560} label="Mapa dos motoristas em andamento" />
            <div className="muted" style={{ fontSize: '0.8rem', marginTop: 6 }}>Atualiza a cada 10 segundos{updated ? ` · última atualização ${updated.toLocaleTimeString('pt-BR')}` : ''}. Linha azul: trajeto planejado · pontilhada: trilha percorrida.</div>
          </div>
        </div>
      )}
    </>
  );
}
