'use client';

import { AlertTriangle, CalendarClock, Layers } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Alert, EmptyState, Skeleton, StatCard, useUi } from '@/components/ui';
import { api } from '@/lib/api';
import { dateBr } from '@/lib/format';

interface Lot { id: string; productId: string; sku: string; name: string; warehouse: string; warehouseId: string; code: string; expiresAt: string | null; daysLeft: number | null; onHand: number; status: string }
interface Data { soonDays: number; summary: { lots: number; expiredUnits: number; expiredLots: number; soonUnits: number; soonLots: number }; items: Lot[] }
interface Prod { id: string; sku: string; name: string; trackLots: boolean }
const STATUS: Record<string, [string, string]> = { VENCIDO: ['Vencido', 'danger'], A_VENCER: ['A vencer', 'warn'], OK: ['Dentro da validade', 'ok'], SEM_VALIDADE: ['Sem validade', ''] };

/** Lotes e validade (PEPS/FEFO): o que vence primeiro sai primeiro; lote vencido não é vendido. */
export function LotsTab({ canAdjust }: { canAdjust: boolean }) {
  const ui = useUi();
  const [status, setStatus] = useState('');
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [prods, setProds] = useState<Prod[]>([]);
  const load = useCallback(() => { api<Data>(`/stock/lots${status ? `?status=${status}` : ''}`).then(setD).catch((e) => setError(e.message)); }, [status]);
  useEffect(load, [load]);
  useEffect(() => {
    if (q.trim().length < 2) { setProds([]); return; }
    const t = setTimeout(() => api<{ items: Prod[] }>(`/products?search=${encodeURIComponent(q.trim())}&limit=8`).then((r) => setProds(r.items)).catch(() => undefined), 250);
    return () => clearTimeout(t);
  }, [q]);

  async function toggle(p: Prod) {
    const on = !p.trackLots;
    if (!(await ui.confirm({ title: on ? 'Ligar controle de lote?' : 'Desligar controle de lote?', message: on ? 'O saldo atual vira o lote LEGADO (sem validade). A partir daí toda entrada exige lote e a saída é pelo que vence primeiro.' : 'Só é possível com o saldo em lotes zerado.', confirmLabel: on ? 'Ligar' : 'Desligar', cancelLabel: 'Voltar' }))) return;
    try {
      await api(`/stock/lots/tracking/${p.id}`, 'PUT', { enabled: on });
      ui.toast.ok(on ? 'Controle de lote ligado.' : 'Controle de lote desligado.');
      setProds(prods.map((x) => (x.id === p.id ? { ...x, trackLots: on } : x))); load();
    } catch (e) { ui.toast.error((e as Error).message); }
  }
  async function writeOff(l: Lot) {
    const reason = await ui.prompt({ title: `Baixa do lote ${l.code}`, message: `Dar baixa de ${l.onHand} unidade(s) de ${l.sku} como perda. Fica registrado no histórico.`, label: 'Motivo', confirmLabel: 'Dar baixa', danger: true, cancelLabel: 'Voltar' });
    if (!reason) return;
    try {
      await api('/stock/movements', 'POST', { productId: l.productId, warehouseId: l.warehouseId, type: 'LOSS', quantity: l.onHand, reason, lotId: l.id, idempotencyKey: crypto.randomUUID() });
      ui.toast.ok('Baixa registrada.'); load();
    } catch (e) { ui.toast.error((e as Error).message); }
  }

  return (
    <div className="stack">
      {error && <Alert kind="error">{error}</Alert>}
      {d && (
        <div className="grid cols-4">
          <StatCard label="Lotes com saldo" value={d.summary.lots} icon={<Layers />} />
          <StatCard label="Vencidos" value={`${d.summary.expiredUnits} un.`} icon={<AlertTriangle />} tone={d.summary.expiredUnits ? 'danger' : undefined} hint={`${d.summary.expiredLots} lote(s): não podem ser vendidos`} />
          <StatCard label={`A vencer em ${d.soonDays} dias`} value={`${d.summary.soonUnits} un.`} icon={<CalendarClock />} tone={d.summary.soonUnits ? 'warn' : undefined} hint={`${d.summary.soonLots} lote(s)`} />
        </div>
      )}
      {canAdjust && (
        <section className="card" aria-label="Controle de lote por produto">
          <h2>Produtos com controle de lote</h2>
          <p className="muted" style={{ marginTop: 0 }}>Para alimentos, bebidas e remédios. Busque o produto para ligar ou desligar o controle.</p>
          <input aria-label="Buscar produto" placeholder="Nome ou SKU…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 340 }} />
          {prods.map((p) => (
            <div key={p.id} className="row" style={{ marginTop: 8 }}>
              <span>{p.sku} — {p.name}</span>
              <span className={`badge ${p.trackLots ? 'ok' : ''}`}>{p.trackLots ? 'Controla lote' : 'Sem controle'}</span>
              <button className="btn sm" onClick={() => toggle(p)}>{p.trackLots ? 'Desligar' : 'Ligar controle de lote'}</button>
            </div>
          ))}
        </section>
      )}
      <section className="card">
        <div className="toolbar">
          <select aria-label="Situação" value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 220 }}>
            <option value="">Todos os lotes</option><option value="VENCIDO">Vencidos</option><option value="A_VENCER">A vencer</option><option value="OK">Dentro da validade</option><option value="SEM_VALIDADE">Sem validade</option>
          </select>
        </div>
        {!d && !error && <Skeleton rows={4} />}
        {d && d.items.length === 0 && <EmptyState icon={<Layers size={22} />} title="Nenhum lote nesta visão">Ligue o controle de lote em um produto e dê entrada informando o lote e a validade.</EmptyState>}
        {d && d.items.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th>Produto</th><th>Depósito</th><th>Lote</th><th>Validade</th><th className="num">Saldo</th><th>Situação</th><th /></tr></thead>
            <tbody>{d.items.map((l) => {
              const [label, tone] = STATUS[l.status] ?? [l.status, ''];
              return (
                <tr key={l.id}>
                  <td><strong>{l.name}</strong><div className="muted mono" style={{ fontSize: '0.78rem' }}>{l.sku}</div></td>
                  <td>{l.warehouse}</td><td className="mono">{l.code}</td>
                  <td>{l.expiresAt ? dateBr(l.expiresAt) : '—'}{l.daysLeft !== null && <div className="muted" style={{ fontSize: '0.76rem' }}>{l.daysLeft < 0 ? `venceu há ${-l.daysLeft} dia(s)` : l.daysLeft === 0 ? 'vence hoje' : `faltam ${l.daysLeft} dia(s)`}</div>}</td>
                  <td className="num">{l.onHand}</td><td><span className={`badge ${tone}`}>{label}</span></td>
                  <td>{canAdjust && l.status === 'VENCIDO' && <button className="btn sm" onClick={() => writeOff(l)}>Dar baixa</button>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}
