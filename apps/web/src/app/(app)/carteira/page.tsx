'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { brl, dateBr, docOrDash, formatPhone } from '@/lib/format';
import { Alert, PageHeader, Skeleton, StatCard, useUi } from '@/components/ui';
import { useSession } from '@/lib/session';

interface Summary { canSeeAll: boolean; mineId: string | null; salespeople: { id: string; name: string; customers: number; sold90d: string }[]; unassigned: number }
interface Item { id: string; name: string; kind: string; document: string | null; phone: string | null; email: string | null; city: string | null; state: string | null; priceTable: string; salespersonId: string | null; salespersonName: string | null; orders: number; lastPurchaseAt: string | null; daysSinceLastPurchase: number | null; sold12m: string; openBalance: string }

/** Carteira de clientes: cada vendedor vê a sua; administrador/gerente vê a de qualquer vendedor e transfere clientes. */
export default function CarteiraPage() {
  const { can } = useSession();
  const ui = useUi();
  const [sum, setSum] = useState<Summary | null>(null);
  const [owner, setOwner] = useState<string>(''); // '' = todos (só admin), 'none' = sem carteira, ou id
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<Item[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  const loadSum = useCallback(() => { api<Summary>('/portfolio/summary').then(setSum).catch((e) => setError(e.message)); }, []);
  useEffect(loadSum, [loadSum]);
  const load = useCallback(() => {
    const qs = new URLSearchParams(); if (owner) qs.set('salespersonId', owner); if (search.trim()) qs.set('search', search.trim());
    api<{ items: Item[] }>(`/portfolio${qs.size ? `?${qs}` : ''}`).then((r) => { setItems(r.items); setPicked(new Set()); }).catch((e) => setError(e.message));
  }, [owner, search]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const totals = useMemo(() => ({ sold: (items ?? []).reduce((s, i) => s + Number(i.sold12m), 0), open: (items ?? []).reduce((s, i) => s + Number(i.openBalance), 0), idle: (items ?? []).filter((i) => (i.daysSinceLastPurchase ?? 999) > 60).length }), [items]);
  const canTransfer = !!sum?.canSeeAll && can('customers.manage');

  async function transfer() {
    if (!sum || picked.size === 0) return;
    const opts = [{ value: '', label: 'Sem carteira' }, ...sum.salespeople.map((s) => ({ value: s.id, label: s.name }))];
    const r = await ui.form({ title: `Transferir ${picked.size} cliente(s)`, confirmLabel: 'Transferir', fields: [{ name: 'to', label: 'Para o vendedor', type: 'select', defaultValue: '', options: opts }] });
    if (!r) return;
    setError(''); setOk('');
    try { const res = await api<{ moved: number }>('/portfolio/transfer', 'PUT', { customerIds: [...picked], salespersonId: r.to ? String(r.to) : null }); setOk(`${res.moved} cliente(s) transferido(s).`); load(); loadSum(); } catch (e) { setError((e as Error).message); }
  }

  return (
    <>
      <PageHeader title="Carteira de clientes" description={sum?.canSeeAll ? <>Os clientes de cada vendedor. Cliente novo entra na carteira de quem cadastrou, ou de quem faz a primeira venda.</> : <>Seus clientes, com histórico de compra e saldo em aberto.</>} />
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}

      {sum?.canSeeAll && (
        <section className="card" style={{ marginBottom: 16 }} aria-label="Vendedores">
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className={`btn sm ${owner === '' ? 'primary' : ''}`} onClick={() => setOwner('')}>Todos</button>
            {sum.salespeople.map((s) => <button key={s.id} className={`btn sm ${owner === s.id ? 'primary' : ''}`} onClick={() => setOwner(s.id)}>{s.name} · {s.customers}</button>)}
            <button className={`btn sm ${owner === 'none' ? 'primary' : ''}`} onClick={() => setOwner('none')}>Sem carteira · {sum.unassigned}</button>
          </div>
        </section>
      )}

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <StatCard label="Clientes" value={items?.length ?? '—'} />
        <StatCard label="Vendido em 12 meses" value={brl(totals.sold)} />
        <StatCard label="Saldo em aberto" value={brl(totals.open)} tone={totals.open > 0 ? 'warn' : undefined} />
        <StatCard label="Sem comprar há +60 dias" value={totals.idle} tone={totals.idle ? 'warn' : undefined} />
      </div>

      <section className="card">
        <div className="row" style={{ marginBottom: 12, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <input aria-label="Buscar na carteira" placeholder="Buscar por nome ou documento" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 320 }} />
          {canTransfer && <button className="btn" disabled={picked.size === 0} onClick={transfer}>Transferir selecionados ({picked.size})</button>}
        </div>
        {!items && !error && <Skeleton rows={4} />}
        {items && items.length === 0 && <p className="muted">{sum && !sum.canSeeAll && !sum.mineId ? 'Você ainda não tem carteira: ela é criada quando você cadastra um cliente ou faz uma venda.' : 'Nenhum cliente nesta carteira.'}</p>}
        {items && items.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr>{canTransfer && <th style={{ width: 32 }}><input type="checkbox" aria-label="Selecionar todos" checked={picked.size === items.length} onChange={(e) => setPicked(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())} /></th>}<th>Cliente</th><th>Contato</th><th>Local</th>{sum?.canSeeAll && <th>Vendedor</th>}<th className="num">Pedidos</th><th>Última compra</th><th className="num">12 meses</th><th className="num">Em aberto</th></tr></thead>
            <tbody>{items.map((i) => (
              <tr key={i.id}>
                {canTransfer && <td><input type="checkbox" aria-label={`Selecionar ${i.name}`} checked={picked.has(i.id)} onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(i.id); else n.delete(i.id); setPicked(n); }} /></td>}
                <td>{i.name}{i.priceTable === 'WHOLESALE' && <span className="badge" style={{ marginLeft: 6 }}>atacado</span>}<div className="muted" style={{ fontSize: '0.78rem' }}>{docOrDash(i.document)}</div></td>
                <td className="contact-cell">{i.email || i.phone ? <>{i.email && <div className="ct-line" title={i.email}>{i.email}</div>}{i.phone && <div className="ct-line nowrap">{formatPhone(i.phone)}</div>}</> : '—'}</td>
                <td>{[i.city, i.state].filter(Boolean).join('/') || '—'}</td>
                {sum?.canSeeAll && <td>{i.salespersonName ?? <span className="muted">sem carteira</span>}</td>}
                <td className="num">{i.orders}</td>
                <td>{i.lastPurchaseAt ? <>{dateBr(i.lastPurchaseAt)}<div className={`muted`} style={{ fontSize: '0.78rem' }}>há {i.daysSinceLastPurchase} dia(s)</div></> : <span className="badge warn">nunca comprou</span>}</td>
                <td className="num">{brl(i.sold12m)}</td>
                <td className="num">{Number(i.openBalance) > 0 ? <strong>{brl(i.openBalance)}</strong> : '—'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {items && items.length >= 300 && <p className="muted" style={{ fontSize: '0.8rem' }}>Mostrando os 300 primeiros. Use a busca para achar os demais.</p>}
      </section>
    </>
  );
}
