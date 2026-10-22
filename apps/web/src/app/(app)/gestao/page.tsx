'use client';

import { AlertTriangle, Boxes, PackageX, ShoppingBasket, Target, TrendingUp, Trophy, Wallet } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, EmptyState, PageHeader, Skeleton, StatCard, useUi } from '@/components/ui';
import { api } from '@/lib/api';
import { brl } from '@/lib/format';
import { useSession } from '@/lib/session';

type Tab = 'metas' | 'margem' | 'estoque' | 'orcamento';
const TABS: [Tab, string][] = [['metas', 'Metas e ranking'], ['margem', 'Margem'], ['estoque', 'Giro e ruptura'], ['orcamento', 'Orçamento']];
const today = () => new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - 3 * 3_600_000 - n * 86_400_000).toISOString().slice(0, 10);
const num = (v: string) => { const n = Number(v.replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const fmtPct = (v: number | null) => (v === null ? '—' : `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`);

export default function GestaoPage() {
  const [tab, setTab] = useState<Tab>('metas');
  return (
    <>
      <PageHeader title="Metas e indicadores" description="Acompanhe as metas dos vendedores, a margem real, o giro do estoque e o orçamento financeiro." />
      <div className="tabs" role="tablist">{TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      {tab === 'metas' && <Goals />}
      {tab === 'margem' && <Margin />}
      {tab === 'estoque' && <StockHealth />}
      {tab === 'orcamento' && <Budget />}
    </>
  );
}

function Basis({ children }: { children: string }) { return <p className="muted" style={{ fontSize: '0.8rem' }}>{children}</p>; }

// ───────────── metas ─────────────
interface GoalRow { salespersonId: string; name: string; goal: string | null; achieved: string; returns: string; orders: number; pct: number | null; projected: string; projectedPct: number | null; missing: string | null; rank: number }
interface GoalsData { period: string; daysElapsed: number; daysTotal: number; rows: GoalRow[]; totals: { goal: string; achieved: string; pct: number | null }; basis: string }

function Goals() {
  const { can } = useSession();
  const ui = useUi();
  const manage = can('management.manage');
  const [period, setPeriod] = useState(today().slice(0, 7));
  const [d, setD] = useState<GoalsData | null>(null);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const load = useCallback(() => { setD(null); api<GoalsData>(`/management/goals?period=${period}`).then((r) => { setD(r); setEdit(Object.fromEntries(r.rows.map((x) => [x.salespersonId, x.goal ? String(Number(x.goal)).replace('.', ',') : '']))); }).catch((e) => setError(e.message)); }, [period]);
  useEffect(load, [load]);

  async function save() {
    if (!d) return;
    try {
      await api('/management/goals', 'PUT', { period, items: d.rows.filter((r) => edit[r.salespersonId] !== '' || r.goal).map((r) => ({ salespersonId: r.salespersonId, amount: num(edit[r.salespersonId] || '0') })) });
      ui.toast.ok('Metas salvas.'); load();
    } catch (e) { setError((e as Error).message); }
  }
  const dirty = d?.rows.some((r) => (edit[r.salespersonId] ?? '') !== (r.goal ? String(Number(r.goal)).replace('.', ',') : ''));

  return (
    <div className="stack">
      {error && <Alert kind="error">{error}</Alert>}
      <div className="toolbar"><div><label htmlFor="g-p" className="muted" style={{ fontSize: '0.8rem' }}>Mês</label><input id="g-p" type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} /></div></div>
      {!d && !error && <Skeleton rows={4} />}
      {d && <>
        <div className="grid cols-4">
          <StatCard label="Meta do mês" value={brl(d.totals.goal)} icon={<Target />} hint={`${d.daysElapsed} de ${d.daysTotal} dias`} />
          <StatCard label="Vendido" value={brl(d.totals.achieved)} icon={<ShoppingBasket />} tone="ok" />
          <StatCard label="Atingido" value={fmtPct(d.totals.pct)} icon={<TrendingUp />} tone={d.totals.pct !== null && d.totals.pct >= 100 ? 'ok' : undefined} />
          <StatCard label="Líder do mês" value={d.rows[0] && Number(d.rows[0].achieved) > 0 ? d.rows[0].name : '—'} icon={<Trophy />} />
        </div>
        <section className="card">
          {d.rows.length === 0 ? <EmptyState title="Nenhum vendedor ativo">Cadastre vendedores em “Vendedores e comissões”.</EmptyState> : (
            <div className="table-wrap"><table>
              <thead><tr><th>#</th><th>Vendedor</th><th className="num">Meta (R$)</th><th className="num">Vendido</th><th style={{ minWidth: 150 }}>Atingido</th><th className="num">Projeção</th><th className="num">Falta</th></tr></thead>
              <tbody>{d.rows.map((r) => (
                <tr key={r.salespersonId}>
                  <td>{r.rank === 1 && Number(r.achieved) > 0 ? <Trophy size={16} aria-label="1º lugar" /> : r.rank}</td>
                  <td><strong>{r.name}</strong><div className="muted" style={{ fontSize: '0.78rem' }}>{r.orders} pedido(s){Number(r.returns) > 0 ? ` · devoluções ${brl(r.returns)}` : ''}</div></td>
                  <td className="num">{manage ? <input aria-label={`Meta de ${r.name}`} inputMode="decimal" style={{ width: 120, textAlign: 'right' }} placeholder="0,00" value={edit[r.salespersonId] ?? ''} onChange={(e) => setEdit({ ...edit, [r.salespersonId]: e.target.value })} /> : r.goal ? brl(r.goal) : '—'}</td>
                  <td className="num">{brl(r.achieved)}</td>
                  <td>{r.pct === null ? <span className="muted">sem meta</span> : <><div className="progress" aria-hidden><span style={{ width: `${Math.min(100, r.pct)}%`, background: r.pct >= 100 ? 'var(--ok)' : undefined }} /></div><span style={{ fontSize: '0.8rem' }}>{fmtPct(r.pct)}</span></>}</td>
                  <td className="num">{r.projectedPct === null ? '—' : <span className={`badge ${r.projectedPct >= 100 ? 'ok' : 'warn'}`}>{fmtPct(r.projectedPct)}</span>}</td>
                  <td className="num">{r.missing === null ? '—' : Number(r.missing) > 0 ? brl(r.missing) : <span className="badge ok">meta batida</span>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          {manage && d.rows.length > 0 && <div className="row" style={{ marginTop: 12 }}><button className="btn primary" disabled={!dirty} onClick={save}>Salvar metas</button></div>}
        </section>
        <Basis>{d.basis}</Basis>
      </>}
    </div>
  );
}

// ───────────── margem ─────────────
interface MarginItem { key: string; label: string; sub: string; date: string | null; quantity: number; orders: number; revenue: string; cost: string; margin: string; marginPct: number | null; itemsWithoutCost: number }
interface MarginData { by: string; items: MarginItem[]; truncated: boolean; totals: { revenue: string; cost: string; margin: string; marginPct: number | null; itemsWithoutCost: number }; basis: string }

function Margin() {
  const [from, setFrom] = useState(daysAgo(30)); const [to, setTo] = useState(today());
  const [by, setBy] = useState<'product' | 'customer' | 'order'>('product');
  const [d, setD] = useState<MarginData | null>(null); const [error, setError] = useState('');
  useEffect(() => { setD(null); setError(''); api<MarginData>(`/management/margin?from=${from}&to=${to}&by=${by}`).then(setD).catch((e) => setError(e.message)); }, [from, to, by]);
  return (
    <div className="stack">
      {error && <Alert kind="error">{error}</Alert>}
      <div className="toolbar">
        <div><label htmlFor="m-f" className="muted" style={{ fontSize: '0.8rem' }}>De</label><input id="m-f" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label htmlFor="m-t" className="muted" style={{ fontSize: '0.8rem' }}>Até</label><input id="m-t" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <div><label htmlFor="m-b" className="muted" style={{ fontSize: '0.8rem' }}>Ver por</label><select id="m-b" value={by} onChange={(e) => setBy(e.target.value as typeof by)}><option value="product">Produto</option><option value="customer">Cliente</option><option value="order">Pedido</option></select></div>
      </div>
      {!d && !error && <Skeleton rows={4} />}
      {d && <>
        <div className="grid cols-4">
          <StatCard label="Vendas expedidas" value={brl(d.totals.revenue)} icon={<ShoppingBasket />} />
          <StatCard label="Custo das mercadorias" value={brl(d.totals.cost)} icon={<Boxes />} />
          <StatCard label="Margem" value={brl(d.totals.margin)} icon={<Wallet />} tone={Number(d.totals.margin) < 0 ? 'danger' : 'ok'} />
          <StatCard label="Margem %" value={fmtPct(d.totals.marginPct)} icon={<TrendingUp />} />
        </div>
        {d.totals.itemsWithoutCost > 0 && <Alert kind="warn">{d.totals.itemsWithoutCost} item(ns) vendido(s) sem custo cadastrado entraram com custo zero: a margem desses está superestimada. Cadastre o custo em Produtos.</Alert>}
        <section className="card">
          {d.items.length === 0 ? <EmptyState title="Nenhuma venda expedida neste período" /> : (
            <div className="table-wrap"><table>
              <thead><tr><th>{by === 'product' ? 'Produto' : by === 'customer' ? 'Cliente' : 'Pedido'}</th><th className="num">Qtd.</th><th className="num">Venda</th><th className="num">Custo</th><th className="num">Margem</th><th className="num">%</th></tr></thead>
              <tbody>{d.items.map((i) => (
                <tr key={i.key}>
                  <td><strong>{i.label}</strong><div className="muted" style={{ fontSize: '0.78rem' }}>{[i.sub, i.date].filter(Boolean).join(' · ')}{i.itemsWithoutCost ? ' · sem custo' : ''}</div></td>
                  <td className="num">{i.quantity}</td><td className="num">{brl(i.revenue)}</td><td className="num">{brl(i.cost)}</td>
                  <td className="num">{brl(i.margin)}</td>
                  <td className="num"><span className={`badge ${i.marginPct === null ? '' : i.marginPct < 0 ? 'danger' : i.marginPct < 10 ? 'warn' : 'ok'}`}>{fmtPct(i.marginPct)}</span></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          {d.truncated && <p className="muted">Mostrando os 500 maiores; reduza o período para ver os demais.</p>}
        </section>
        <Basis>{d.basis}</Basis>
      </>}
    </div>
  );
}

// ───────────── giro, ruptura e previsão ─────────────
interface HealthItem { productId: string; sku: string; name: string; onHand: number; available: number; sold: number; avgDaily: number; coverageDays: number | null; turnover: number | null; forecast30: number; suggestedPurchase: number; leadDays: number; status: string; abc: string }
interface HealthData { days: number; summary: { products: number; ruptura: number; critico: number; atencao: number; semGiro: number; stockValue: number; purchaseSuggestedUnits: number; classA: number }; items: HealthItem[]; basis: string }
const HSTATUS: Record<string, [string, string]> = { RUPTURA: ['Ruptura', 'danger'], CRITICO: ['Crítico', 'danger'], ATENCAO: ['Atenção', 'warn'], SEM_GIRO: ['Sem giro', ''], OK: ['Ok', 'ok'] };

function StockHealth() {
  const [days, setDays] = useState('90'); const [lead, setLead] = useState('7'); const [filter, setFilter] = useState('');
  const [d, setD] = useState<HealthData | null>(null); const [error, setError] = useState('');
  useEffect(() => { setD(null); setError(''); api<HealthData>(`/management/stock-health?days=${days}&leadDays=${Number(lead) || 7}`).then(setD).catch((e) => setError(e.message)); }, [days, lead]);
  const items = useMemo(() => (d?.items ?? []).filter((i) => !filter || i.status === filter), [d, filter]);
  return (
    <div className="stack">
      {error && <Alert kind="error">{error}</Alert>}
      <div className="toolbar">
        <div><label htmlFor="s-d" className="muted" style={{ fontSize: '0.8rem' }}>Base de vendas</label><select id="s-d" value={days} onChange={(e) => setDays(e.target.value)}><option value="30">Últimos 30 dias</option><option value="60">Últimos 60 dias</option><option value="90">Últimos 90 dias</option><option value="180">Últimos 180 dias</option></select></div>
        <div><label htmlFor="s-l" className="muted" style={{ fontSize: '0.8rem' }}>Prazo de reposição padrão (dias)</label><input id="s-l" inputMode="numeric" value={lead} onChange={(e) => setLead(e.target.value.replace(/\D/g, ''))} style={{ maxWidth: 120 }} /></div>
        <div><label htmlFor="s-f" className="muted" style={{ fontSize: '0.8rem' }}>Situação</label><select id="s-f" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="">Todas</option>{Object.entries(HSTATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select></div>
      </div>
      {!d && !error && <Skeleton rows={4} />}
      {d && <>
        <div className="grid cols-4">
          <StatCard label="Em ruptura" value={d.summary.ruptura} icon={<PackageX />} tone={d.summary.ruptura ? 'danger' : undefined} hint="vendem e estão sem estoque" />
          <StatCard label="Críticos" value={d.summary.critico} icon={<AlertTriangle />} tone={d.summary.critico ? 'warn' : undefined} hint="acabam antes da reposição" />
          <StatCard label="Sem giro" value={d.summary.semGiro} icon={<Boxes />} hint="estoque parado, sem venda" />
          <StatCard label="Compra sugerida" value={`${d.summary.purchaseSuggestedUnits} un.`} icon={<ShoppingBasket />} hint={`estoque: ${brl(d.summary.stockValue)}`} />
        </div>
        <section className="card">
          {items.length === 0 ? <EmptyState title="Nenhum produto nesta situação" /> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Produto</th><th>Situação</th><th className="num">Disponível</th><th className="num">Vendido</th><th className="num">Cobertura</th><th className="num">Giro</th><th className="num">Previsão 30d</th><th className="num">Comprar</th><th>ABC</th></tr></thead>
              <tbody>{items.map((i) => { const [l, tone] = HSTATUS[i.status] ?? [i.status, '']; return (
                <tr key={i.productId}>
                  <td><strong>{i.name}</strong><div className="muted mono" style={{ fontSize: '0.78rem' }}>{i.sku}</div></td>
                  <td><span className={`badge ${tone}`}>{l}</span></td>
                  <td className="num">{i.available}</td><td className="num">{i.sold}</td>
                  <td className="num">{i.coverageDays === null ? '—' : `${Math.round(i.coverageDays)} d`}<div className="muted" style={{ fontSize: '0.74rem' }}>reposição {i.leadDays} d</div></td>
                  <td className="num">{i.turnover === null ? '—' : `${i.turnover.toLocaleString('pt-BR')}x`}</td>
                  <td className="num">{i.forecast30}</td>
                  <td className="num">{i.suggestedPurchase > 0 ? <strong>{i.suggestedPurchase}</strong> : '—'}</td>
                  <td><span className={`badge ${i.abc === 'A' ? 'brand' : ''}`}>{i.abc}</span></td>
                </tr>
              ); })}</tbody>
            </table></div>
          )}
        </section>
        <Basis>{d.basis}</Basis>
      </>}
    </div>
  );
}

// ───────────── orçamento ─────────────
interface BudgetRow { lineKey: string; label: string; kind: string; expense: boolean; months: { period: string; budget: string | null; realized: string; variance: string | null }[] }
interface BudgetData { year: string; months: string[]; rows: BudgetRow[]; basis: string }

function Budget() {
  const { can } = useSession();
  const ui = useUi();
  const manage = can('management.manage');
  const [year, setYear] = useState(today().slice(0, 4));
  const [month, setMonth] = useState(today().slice(0, 7));
  const [d, setD] = useState<BudgetData | null>(null); const [edit, setEdit] = useState<Record<string, string>>({}); const [error, setError] = useState('');
  const load = useCallback(() => { setD(null); api<BudgetData>(`/management/budget?year=${year}`).then(setD).catch((e) => setError(e.message)); }, [year]);
  useEffect(load, [load]);
  useEffect(() => { if (!month.startsWith(year)) setMonth(`${year}-01`); }, [year, month]);
  useEffect(() => { if (d) setEdit(Object.fromEntries(d.rows.map((r) => { const m = r.months.find((x) => x.period === month); return [r.lineKey, m?.budget ? String(Number(m.budget)).replace('.', ',') : '']; }))); }, [d, month]);

  const orig = (r: BudgetRow) => { const b = r.months.find((x) => x.period === month)?.budget; return b ? String(Number(b)).replace('.', ',') : ''; };
  const dirty = d?.rows.some((r) => (edit[r.lineKey] ?? '') !== orig(r));
  async function save() {
    if (!d) return;
    try {
      await api('/management/budget', 'PUT', { lines: d.rows.filter((r) => (edit[r.lineKey] ?? '') !== orig(r)).map((r) => ({ lineKey: r.lineKey, period: month, amount: num(edit[r.lineKey] || '0') })) });
      ui.toast.ok('Orçamento salvo.'); load();
    } catch (e) { setError((e as Error).message); }
  }
  const years = [Number(today().slice(0, 4)) - 1, Number(today().slice(0, 4)), Number(today().slice(0, 4)) + 1];
  return (
    <div className="stack">
      {error && <Alert kind="error">{error}</Alert>}
      <div className="toolbar">
        <div><label htmlFor="b-y" className="muted" style={{ fontSize: '0.8rem' }}>Ano</label><select id="b-y" value={year} onChange={(e) => setYear(e.target.value)}>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select></div>
        <div><label htmlFor="b-m" className="muted" style={{ fontSize: '0.8rem' }}>Mês para orçar</label><select id="b-m" value={month} onChange={(e) => setMonth(e.target.value)}>{(d?.months ?? []).map((m) => <option key={m} value={m}>{new Date(`${m}-15T12:00:00Z`).toLocaleDateString('pt-BR', { month: 'long', timeZone: 'UTC' })}</option>)}</select></div>
      </div>
      {!d && !error && <Skeleton rows={4} />}
      {d && <>
        <section className="card">
          <div className="table-wrap"><table>
            <thead><tr><th>Linha</th><th className="num">Orçado no mês (R$)</th><th className="num">Realizado no mês</th><th className="num">Variação</th><th className="num">Ano: orçado</th><th className="num">Ano: realizado</th></tr></thead>
            <tbody>{d.rows.map((r) => {
              const m = r.months.find((x) => x.period === month)!;
              const yb = r.months.reduce((s, x) => s + Number(x.budget ?? 0), 0); const yr = r.months.reduce((s, x) => s + Number(x.realized), 0);
              const v = m.variance === null ? null : Number(m.variance);
              const bad = v !== null && v !== 0 && (r.expense ? v > 0 : v < 0);
              return (
                <tr key={r.lineKey}>
                  <td><strong>{r.label}</strong>{r.lineKey !== 'SALES' && r.lineKey !== 'NONE' && <div className="muted" style={{ fontSize: '0.74rem' }}>{r.kind}</div>}</td>
                  <td className="num">{manage ? <input aria-label={`Orçado de ${r.label}`} inputMode="decimal" style={{ width: 120, textAlign: 'right' }} placeholder="0,00" value={edit[r.lineKey] ?? ''} onChange={(e) => setEdit({ ...edit, [r.lineKey]: e.target.value })} /> : m.budget ? brl(m.budget) : '—'}</td>
                  <td className="num">{brl(m.realized)}</td>
                  <td className="num">{v === null ? '—' : <span className={`badge ${bad ? 'danger' : v === 0 ? '' : 'ok'}`}>{v > 0 ? '+' : ''}{brl(v)}</span>}</td>
                  <td className="num">{yb ? brl(yb) : '—'}</td><td className="num">{brl(yr)}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
          {manage && <div className="row" style={{ marginTop: 12 }}><button className="btn primary" disabled={!dirty} onClick={save}>Salvar orçamento do mês</button></div>}
        </section>
        <Basis>{d.basis}</Basis>
      </>}
    </div>
  );
}
