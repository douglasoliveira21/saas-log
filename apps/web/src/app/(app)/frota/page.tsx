'use client';

import { Fuel, Plus, Route as RouteIcon, Truck, Wallet } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, EmptyState, PageHeader, Skeleton, StatCard, useUi } from '@/components/ui';
import { api } from '@/lib/api';
import { brl, dateBr } from '@/lib/format';
import { useSession } from '@/lib/session';

type Tab = 'veiculos' | 'custos' | 'resumo';
interface Vehicle { id: string; plate: string; description: string; kind: string; capacityKg: number | null; active: boolean; routes: number; notes: string | null }
interface Cost { id: string; plate: string; kind: string; kindLabel: string; amount: string; date: string; note: string | null; routeId: string | null }
interface Summary {
  from: string; to: string; basis: string; kinds: Record<string, string>;
  rows: { vehicleId: string; plate: string; description: string; routes: number; delivered: number; cost: string; byKind: Record<string, string>; costPerDelivery: string | null; sales: string; costOverSalesPct: number | null }[];
  totals: { cost: string; delivered: number; sales: string; costPerDelivery: string | null; costOverSalesPct: number | null };
}
const KINDS: [string, string][] = [['FUEL', 'Combustível'], ['TOLL', 'Pedágio'], ['MAINTENANCE', 'Manutenção'], ['DRIVER', 'Motorista'], ['INSURANCE', 'Seguro'], ['OTHER', 'Outros']];
const VKIND: Record<string, string> = { MOTORCYCLE: 'Moto', VAN: 'Furgão/Van', TRUCK: 'Caminhão', OTHER: 'Outro' };
const today = () => new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - 3 * 3_600_000 - n * 86_400_000).toISOString().slice(0, 10);

export default function FrotaPage() {
  const { can } = useSession();
  const [tab, setTab] = useState<Tab>('veiculos');
  const manage = can('routes.manage');
  return (
    <>
      <PageHeader title="Frota e carga" description="Veículos, capacidade de carga e quanto custa cada viagem e entrega." />
      <div className="tabs" role="tablist">{([['veiculos', 'Veículos'], ['custos', 'Custos'], ['resumo', 'Custo por entrega']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'veiculos' && <Vehicles manage={manage} />}
      {tab === 'custos' && <Costs manage={manage} />}
      {tab === 'resumo' && <SummaryTab />}
    </>
  );
}

function Vehicles({ manage }: { manage: boolean }) {
  const ui = useUi();
  const [rows, setRows] = useState<Vehicle[] | null>(null); const [error, setError] = useState('');
  const load = useCallback(() => { api<Vehicle[]>('/fleet/vehicles').then(setRows).catch((e) => setError(e.message)); }, []);
  useEffect(load, [load]);
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = e.currentTarget; const f = new FormData(form); setError('');
    try {
      await api('/fleet/vehicles', 'POST', { plate: String(f.get('plate')), description: String(f.get('description')), kind: String(f.get('kind')), capacityKg: f.get('capacity') ? Number(f.get('capacity')) : undefined });
      form.reset(); ui.toast.ok('Veículo cadastrado.'); load();
    } catch (err) { setError((err as Error).message); }
  }
  return (
    <div className="stack">
      {error && <Alert kind="error">{error}</Alert>}
      {manage && (
        <form className="card" onSubmit={create}>
          <h2>Novo veículo</h2>
          <div className="form-grid">
            <div><label htmlFor="v-p">Placa *</label><input id="v-p" name="plate" required maxLength={8} placeholder="ABC1D23" style={{ textTransform: 'uppercase' }} /></div>
            <div><label htmlFor="v-d">Descrição *</label><input id="v-d" name="description" required maxLength={100} placeholder="Ex.: Fiorino branca" /></div>
            <div><label htmlFor="v-k">Tipo</label><select id="v-k" name="kind" defaultValue="VAN">{Object.entries(VKIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            <div><label htmlFor="v-c">Capacidade de carga (kg)</label><input id="v-c" name="capacity" inputMode="numeric" placeholder="Ex.: 650" /></div>
          </div>
          <div className="row" style={{ marginTop: 12 }}><button className="btn primary"><Plus aria-hidden />Cadastrar veículo</button></div>
        </form>
      )}
      <section className="card">
        {!rows && !error && <Skeleton rows={3} />}
        {rows && rows.length === 0 && <EmptyState icon={<Truck size={22} />} title="Nenhum veículo cadastrado">Cadastre os veículos para conferir o peso de cada viagem e lançar os custos.</EmptyState>}
        {rows && rows.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th>Placa</th><th>Descrição</th><th>Tipo</th><th className="num">Capacidade</th><th className="num">Viagens</th><th>Situação</th><th /></tr></thead>
            <tbody>{rows.map((v) => (
              <tr key={v.id} style={v.active ? undefined : { opacity: 0.55 }}>
                <td className="mono"><strong>{v.plate}</strong></td><td>{v.description}</td><td>{VKIND[v.kind] ?? v.kind}</td><td className="num">{v.capacityKg ? `${v.capacityKg} kg` : '—'}</td><td className="num">{v.routes}</td>
                <td><span className={`badge ${v.active ? 'ok' : ''}`}>{v.active ? 'Ativo' : 'Inativo'}</span></td>
                <td>{manage && <button className="btn sm" onClick={async () => { try { await api(`/fleet/vehicles/${v.id}`, 'PUT', { active: !v.active }); load(); } catch (e) { ui.toast.error((e as Error).message); } }}>{v.active ? 'Desativar' : 'Ativar'}</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}

function Costs({ manage }: { manage: boolean }) {
  const ui = useUi();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]); const [rows, setRows] = useState<Cost[] | null>(null); const [error, setError] = useState('');
  const [from, setFrom] = useState(daysAgo(30)); const [to, setTo] = useState(today());
  const load = useCallback(() => { api<Cost[]>(`/fleet/costs?from=${from}&to=${to}`).then(setRows).catch((e) => setError(e.message)); }, [from, to]);
  useEffect(load, [load]);
  useEffect(() => { api<Vehicle[]>('/fleet/vehicles').then((v) => setVehicles(v.filter((x) => x.active))).catch(() => undefined); }, []);
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = e.currentTarget; const f = new FormData(form); setError('');
    try {
      await api('/fleet/costs', 'POST', { vehicleId: String(f.get('vehicleId')), kind: String(f.get('kind')), amount: Number(String(f.get('amount')).replace(',', '.')), date: String(f.get('date')), note: String(f.get('note') || '') || undefined });
      form.reset(); ui.toast.ok('Custo lançado.'); load();
    } catch (err) { setError((err as Error).message); }
  }
  const total = (rows ?? []).reduce((s, r) => s + Number(r.amount), 0);
  return (
    <div className="stack">
      {error && <Alert kind="error">{error}</Alert>}
      {manage && (
        <form className="card" onSubmit={add}>
          <h2>Lançar custo</h2>
          <p className="muted" style={{ marginTop: 0 }}>Para ligar o custo a uma viagem específica, lance pela própria viagem em Rotas e entregas.</p>
          <div className="form-grid">
            <div><label htmlFor="c-v">Veículo *</label><select id="c-v" name="vehicleId" required>{vehicles.map((v) => <option key={v.id} value={v.id}>{v.plate} — {v.description}</option>)}</select></div>
            <div><label htmlFor="c-k">Tipo *</label><select id="c-k" name="kind">{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            <div><label htmlFor="c-a">Valor (R$) *</label><input id="c-a" name="amount" inputMode="decimal" required /></div>
            <div><label htmlFor="c-d">Data *</label><input id="c-d" name="date" type="date" required max={today()} defaultValue={today()} /></div>
            <div><label htmlFor="c-n">Observação</label><input id="c-n" name="note" maxLength={200} /></div>
          </div>
          <div className="row" style={{ marginTop: 12 }}><button className="btn primary" disabled={!vehicles.length}><Fuel aria-hidden />Lançar custo</button></div>
        </form>
      )}
      <section className="card">
        <div className="toolbar">
          <div><label htmlFor="cs-f" className="muted" style={{ fontSize: '0.8rem' }}>De</label><input id="cs-f" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div><label htmlFor="cs-t" className="muted" style={{ fontSize: '0.8rem' }}>Até</label><input id="cs-t" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          <span className="muted" style={{ marginLeft: 'auto' }}>Total do período: <strong>{brl(total)}</strong></span>
        </div>
        {!rows && !error && <Skeleton rows={3} />}
        {rows && rows.length === 0 && <EmptyState icon={<Wallet size={22} />} title="Nenhum custo no período" />}
        {rows && rows.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th>Data</th><th>Veículo</th><th>Tipo</th><th>Observação</th><th className="num">Valor</th></tr></thead>
            <tbody>{rows.map((c) => <tr key={c.id}><td>{dateBr(c.date)}</td><td className="mono">{c.plate}</td><td>{c.kindLabel}{c.routeId && <span className="badge brand" style={{ marginLeft: 6 }}>viagem</span>}</td><td className="muted">{c.note ?? '—'}</td><td className="num">{brl(c.amount)}</td></tr>)}</tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}

function SummaryTab() {
  const [from, setFrom] = useState(daysAgo(30)); const [to, setTo] = useState(today());
  const [d, setD] = useState<Summary | null>(null); const [error, setError] = useState('');
  useEffect(() => { setD(null); api<Summary>(`/fleet/summary?from=${from}&to=${to}`).then(setD).catch((e) => setError(e.message)); }, [from, to]);
  return (
    <div className="stack">
      {error && <Alert kind="error">{error}</Alert>}
      <div className="toolbar">
        <div><label htmlFor="rs-f" className="muted" style={{ fontSize: '0.8rem' }}>De</label><input id="rs-f" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label htmlFor="rs-t" className="muted" style={{ fontSize: '0.8rem' }}>Até</label><input id="rs-t" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
      </div>
      {!d && !error && <Skeleton rows={3} />}
      {d && <>
        <div className="grid cols-4">
          <StatCard label="Custo da frota" value={brl(d.totals.cost)} icon={<Wallet />} />
          <StatCard label="Entregas feitas" value={d.totals.delivered} icon={<RouteIcon />} />
          <StatCard label="Custo por entrega" value={d.totals.costPerDelivery ? brl(d.totals.costPerDelivery) : '—'} icon={<Truck />} />
          <StatCard label="Custo sobre as vendas" value={d.totals.costOverSalesPct === null ? '—' : `${d.totals.costOverSalesPct.toLocaleString('pt-BR')}%`} icon={<Fuel />} hint={`vendas entregues ${brl(d.totals.sales)}`} />
        </div>
        <section className="card">
          {d.rows.length === 0 ? <EmptyState title="Sem viagens com veículo nem custos neste período">Defina o veículo de cada viagem em Rotas e entregas e lance os custos.</EmptyState> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Veículo</th><th className="num">Viagens</th><th className="num">Entregas</th><th className="num">Custo</th><th>Composição</th><th className="num">Por entrega</th><th className="num">% das vendas</th></tr></thead>
              <tbody>{d.rows.map((r) => (
                <tr key={r.vehicleId}>
                  <td><strong className="mono">{r.plate}</strong><div className="muted" style={{ fontSize: '0.78rem' }}>{r.description}</div></td>
                  <td className="num">{r.routes}</td><td className="num">{r.delivered}</td><td className="num">{brl(r.cost)}</td>
                  <td className="muted" style={{ fontSize: '0.8rem' }}>{Object.entries(r.byKind).map(([k, v]) => `${d.kinds[k] ?? k} ${brl(v)}`).join(' · ') || '—'}</td>
                  <td className="num">{r.costPerDelivery ? brl(r.costPerDelivery) : '—'}</td><td className="num">{r.costOverSalesPct === null ? '—' : `${r.costOverSalesPct.toLocaleString('pt-BR')}%`}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
        <p className="muted" style={{ fontSize: '0.8rem' }}>{d.basis}</p>
      </>}
    </div>
  );
}
