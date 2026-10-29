'use client';

import { ChevronRight, MapPin, Navigation, PackageCheck, Truck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { NAV, NAV_GROUPS } from '@/lib/nav';
import { useSession } from '@/lib/session';

interface MyRoute { id: string; number: number; status: string; totals: { stops: number; pending: number; delivered: number; failed: number; cancelled: number }; stops: { id: string; sequence: number; status: string; customerName: string; address: string }[] }
interface Overview { stages: { waiting: number; picking: number; packed: number; shipped: number }; late: number; dueToday: number }

/** Início do aplicativo: saudação, o que importa para o perfil de quem entrou e todos os módulos liberados. */
export function AppHome() {
  const { me, can } = useSession();
  const [routes, setRoutes] = useState<MyRoute[] | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const isDriver = can('delivery.perform') && !can('routes.view');
  const isDispatch = can('sales.fulfill');
  useEffect(() => { if (can('delivery.perform')) api<MyRoute[]>('/delivery/my/routes').then(setRoutes).catch(() => setRoutes([])); }, [can]);
  useEffect(() => { if (isDispatch) api<Overview>('/dispatch/overview').then(setOv).catch(() => undefined); }, [isDispatch]);

  const route = routes?.find((r) => r.status === 'IN_PROGRESS') ?? routes?.[0];
  const next = route?.stops.filter((s) => s.status === 'PENDING').slice(0, 2) ?? [];
  const done = route ? route.totals.delivered + route.totals.failed : 0;
  const total = route ? route.totals.stops - route.totals.cancelled : 0;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';

  const sections = useMemo(() => NAV_GROUPS.map((g) => ({ group: g, items: NAV.filter((n) => n.group === g && can(n.permission) && n.implemented) })).filter((s) => s.items.length), [can]);

  return (
    <div className="app-home">
      <div className="app-hero">
        <span className="gold-logo" role="img" aria-label="DistribuiHub" />
        <h2>{greet}, {me.user.name.split(' ')[0]}</h2>
        <p>{me.role?.name ?? ''} · {me.tenant?.name}</p>
      </div>

      {can('delivery.perform') && (
        <section className="app-card gold" aria-label="Rota de hoje">
          <div className="app-card-head"><Navigation aria-hidden /><strong>{route ? `Rota #${route.number}` : 'Rota de hoje'}</strong>{route && <span className="app-chip">{route.status === 'IN_PROGRESS' ? 'Em andamento' : route.status === 'COMPLETED' ? 'Concluída' : 'Aguardando saída'}</span>}</div>
          {!routes && <p className="app-muted">Carregando…</p>}
          {routes && !route && <p className="app-muted">Nenhuma rota para você agora. Quando o despachante criar uma, ela aparece aqui.</p>}
          {route && <>
            <div className="app-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label="Entregas feitas"><span style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>
            <p className="app-muted">{route.totals.delivered} entregue(s) · {route.totals.failed} não entregue(s) · {route.totals.pending} pendente(s)</p>
            {next.map((s) => (
              <div className="app-stop" key={s.id}><span className="app-n">{s.sequence}</span><div><strong>{s.customerName}</strong><div className="app-muted"><MapPin size={12} aria-hidden /> {s.address}</div></div></div>
            ))}
            <Link className="app-cta" href="/motorista">{isDriver ? 'Abrir minhas entregas' : 'Ver entregas'}<ChevronRight aria-hidden /></Link>
          </>}
        </section>
      )}

      {isDispatch && ov && (
        <section className="app-card" aria-label="Fila da expedição">
          <div className="app-card-head"><Truck aria-hidden /><strong>Expedição agora</strong>{ov.late > 0 && <span className="app-chip bad">{ov.late} atrasado(s)</span>}</div>
          <div className="app-kpis">
            <div><b>{ov.stages.waiting}</b><small>Aguardando</small></div>
            <div><b>{ov.stages.picking}</b><small>Separando</small></div>
            <div><b>{ov.stages.packed}</b><small>Prontos</small></div>
            <div><b>{ov.dueToday}</b><small>Saem hoje</small></div>
          </div>
          <Link className="app-cta" href="/expedicao">Abrir a fila<ChevronRight aria-hidden /></Link>
        </section>
      )}

      {sections.map((s) => (
        <section key={s.group} aria-label={s.group}>
          <h3 className="app-sec">{s.group === 'Geral' ? 'Painel' : s.group}</h3>
          <div className="app-list">
            {s.items.map((n) => {
              const Icon = n.icon;
              return <Link key={n.href} href={n.href} className="app-row"><span className="app-ico"><Icon aria-hidden /></span><span className="app-lbl">{n.label}</span><ChevronRight className="app-go" aria-hidden /></Link>;
            })}
          </div>
        </section>
      ))}
      <p className="app-muted" style={{ textAlign: 'center', margin: '18px 0 4px' }}><PackageCheck size={12} aria-hidden /> DistribuiHub</p>
    </div>
  );
}
