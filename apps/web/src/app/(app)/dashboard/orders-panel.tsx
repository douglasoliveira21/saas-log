'use client';

import { AlertTriangle, ArrowRight, CheckCircle2, Clock, PackageCheck, ShoppingCart, Timer, Truck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, EmptyState, StatCard } from '@/components/ui';
import { api } from '@/lib/api';
import { brl, ORDER_STATUS } from '@/lib/format';

interface Late { id: string; number: number; status: string; channel: string; total: string; customer: string; since: string; hoursLate: number }
interface Dash {
  days: number;
  sla: { shippingHours: number; deliveryDays: number };
  status: Record<string, number>;
  cards: { newToday: number; awaitingApproval: number; toShip: number; inTransit: number; open: number; lateShipping: number; lateDelivery: number; late: number };
  period: { created: number; revenue: string; shipped: number; delivered: number; cancelled: number };
  series: { date: string; created: number; shipped: number; delivered: number }[];
  byChannel: { channel: string; orders: number; revenue: string }[];
  late: { shipping: Late[]; delivery: Late[] };
}

const CHANNEL: Record<string, string> = { DIRECT: 'Atendimento comercial', PHONE: 'Telefone', WHATSAPP: 'WhatsApp', EMAIL: 'E-mail', STORE: 'Loja física', WEB: 'Loja virtual', REPRESENTATIVE: 'Representante', MARKETPLACE: 'Marketplace' };
const FLOW = ['PENDING_APPROVAL', 'CONFIRMED', 'PICKING', 'PACKED', 'SHIPPED', 'DELIVERED', 'CLOSED', 'CANCELLED'];
const PERIODS = [[7, '7 dias'], [30, '30 dias'], [90, '90 dias']] as const;
const late = (h: number) => (h >= 48 ? `${Math.floor(h / 24)} dias` : `${h} h`);
const shortDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** Visão geral dos pedidos: o que chegou, o que precisa sair, o que está a caminho e o que passou do prazo. */
export function OrdersPanel() {
  const [days, setDays] = useState(30);
  const [d, setD] = useState<Dash | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setError('');
    api<Dash>(`/dashboard/orders?days=${days}`).then(setD).catch((e) => setError(e.message));
  }, [days]);

  const peak = Math.max(1, ...(d?.series.map((s) => s.created) ?? [1]));
  const flowMax = Math.max(1, ...FLOW.map((s) => d?.status[s] ?? 0));
  const empty = d && Object.values(d.status).every((n) => n === 0);

  return (
    <section aria-label="Pedidos" className="stack">
      <div className="card-head">
        <h2>Pedidos</h2>
        <div className="row" style={{ gap: 8 }}>
          <div className="tabs" role="tablist" aria-label="Período" style={{ margin: 0, border: 0 }}>
            {PERIODS.map(([n, l]) => <button key={n} role="tab" aria-selected={days === n} className={`tab ${days === n ? 'active' : ''}`} onClick={() => setDays(n)}>{l}</button>)}
          </div>
          <Link href="/vendas" className="btn sm ghost">Abrir pedidos <ArrowRight /></Link>
        </div>
      </div>

      {error && <Alert kind="error">{error}</Alert>}
      {!d && !error && <div className="grid cols-4">{[0, 1, 2, 3].map((i) => <div className="card" key={i}><span className="skeleton" style={{ height: 14, width: '55%', marginBottom: 12 }} /><span className="skeleton" style={{ height: 30, width: '40%' }} /></div>)}</div>}
      {empty && <EmptyState title="Ainda não há pedidos">Quando os pedidos forem criados (ou chegarem dos marketplaces), os números aparecem aqui.</EmptyState>}

      {d && !empty && (
        <>
          {d.cards.late > 0 && (
            <Alert kind="warn"><strong>{d.cards.late} pedido(s) em atraso.</strong> {d.cards.lateShipping > 0 && `${d.cards.lateShipping} aprovado(s) há mais de ${d.sla.shippingHours} h sem sair. `}{d.cards.lateDelivery > 0 && `${d.cards.lateDelivery} enviado(s) há mais de ${d.sla.deliveryDays} dias sem entrega.`}</Alert>
          )}
          <div className="grid cols-4">
            <StatCard label="Novos hoje" value={d.cards.newToday} icon={<ShoppingCart />} hint={`${d.cards.awaitingApproval} aguardando aprovação`} />
            <StatCard label="A enviar" value={d.cards.toShip} icon={<PackageCheck />} hint="Aprovados, em separação ou embalados" />
            <StatCard label="Em trânsito" value={d.cards.inTransit} icon={<Truck />} hint="Enviados e ainda não entregues" />
            <StatCard label="Em atraso" value={d.cards.late} icon={<Timer />} tone={d.cards.late ? 'danger' : 'ok'} hint={`Envio > ${d.sla.shippingHours} h · entrega > ${d.sla.deliveryDays} dias`} />
          </div>
          <div className="grid cols-4">
            <StatCard label={`Pedidos (${d.days} dias)`} value={d.period.created} icon={<ShoppingCart />} hint={`Faturamento ${brl(d.period.revenue)}`} />
            <StatCard label="Enviados no período" value={d.period.shipped} icon={<Truck />} />
            <StatCard label="Entregues no período" value={d.period.delivered} icon={<CheckCircle2 />} tone="ok" />
            <StatCard label="Cancelados no período" value={d.period.cancelled} icon={<AlertTriangle />} tone={d.period.cancelled ? 'warn' : undefined} />
          </div>

          <div className="grid cols-2">
            <div className="card">
              <div className="card-head"><h3>Pedidos por dia</h3><span className="muted">{d.period.created} no período</span></div>
              <div role="img" aria-label={`Gráfico de pedidos por dia, últimos ${d.days} dias`} style={{ display: 'flex', alignItems: 'flex-end', gap: d.days > 30 ? 1 : 3, height: 120 }}>
                {d.series.map((s) => (
                  <div key={s.date} title={`${shortDate(s.date)}: ${s.created} pedido(s), ${s.shipped} enviado(s), ${s.delivered} entregue(s)`} style={{ flex: 1, minWidth: 1, height: `${Math.max(s.created ? 6 : 2, (s.created / peak) * 100)}%`, background: s.created ? 'var(--brand)' : 'var(--border)', borderRadius: 2 }} />
                ))}
              </div>
              <div className="row muted" style={{ justifyContent: 'space-between', fontSize: '0.78rem', marginTop: 6 }}><span>{shortDate(d.series[0].date)}</span><span>{shortDate(d.series[d.series.length - 1].date)}</span></div>
            </div>

            <div className="card">
              <div className="card-head"><h3>Pedidos por situação</h3><span className="muted">agora</span></div>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
                {FLOW.map((s) => {
                  const n = d.status[s] ?? 0;
                  return (
                    <li key={s} style={{ display: 'grid', gridTemplateColumns: '150px 1fr 40px', alignItems: 'center', gap: 8, fontSize: '0.88rem' }}>
                      <span>{ORDER_STATUS[s]}</span>
                      <span className="progress" aria-hidden><span style={{ width: `${(n / flowMax) * 100}%`, background: s === 'CANCELLED' ? 'var(--danger)' : s === 'DELIVERED' || s === 'CLOSED' ? 'var(--ok)' : undefined }} /></span>
                      <strong className="num" style={{ textAlign: 'right' }}>{n}</strong>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>

          <div className="grid cols-2">
            <LateList title="Atrasados para enviar" hint={`Aprovados há mais de ${d.sla.shippingHours} h`} rows={d.late.shipping} total={d.cards.lateShipping} icon={<Clock />} />
            <LateList title="Atrasados na entrega" hint={`Enviados há mais de ${d.sla.deliveryDays} dias`} rows={d.late.delivery} total={d.cards.lateDelivery} icon={<Truck />} />
          </div>

          <div className="card">
            <div className="card-head"><h3>Por origem do pedido</h3><span className="muted">{d.days} dias</span></div>
            {d.byChannel.length === 0 ? <p className="muted" style={{ margin: 0 }}>Nenhum pedido no período.</p> : (
              <div className="table-wrap"><table>
                <thead><tr><th>Origem</th><th className="num">Pedidos</th><th className="num">Valor</th></tr></thead>
                <tbody>{d.byChannel.map((c) => <tr key={c.channel}><td>{CHANNEL[c.channel] ?? c.channel}</td><td className="num">{c.orders}</td><td className="num">{brl(c.revenue)}</td></tr>)}</tbody>
              </table></div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function LateList({ title, hint, rows, total, icon }: { title: string; hint: string; rows: Late[]; total: number; icon: React.ReactNode }) {
  return (
    <div className="card">
      <div className="card-head"><h3>{title}</h3>{total > 0 ? <span className="badge danger">{total}</span> : <span className="badge ok">Em dia</span>}</div>
      <p className="muted" style={{ margin: '0 0 8px', fontSize: '0.84rem' }}>{hint}</p>
      {rows.length === 0 ? <p className="muted" style={{ margin: 0 }}>Nenhum pedido nesta situação. 🎉</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Pedido</th><th>Cliente</th><th>Situação</th><th className="num">Atraso</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><Link href="/vendas">{icon} #{r.number}</Link></td>
                <td>{r.customer}</td>
                <td><span className="badge">{ORDER_STATUS[r.status]}</span></td>
                <td className="num">{late(r.hoursLate)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {total > rows.length && <p className="muted" style={{ margin: '8px 0 0', fontSize: '0.82rem' }}>Mostrando os {rows.length} mais antigos de {total}.</p>}
    </div>
  );
}
