'use client';

import { AlertTriangle, PackageX, ShoppingBasket, Wallet } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Alert, EmptyState, Skeleton, StatCard, useUi } from '@/components/ui';
import { api } from '@/lib/api';
import { brl } from '@/lib/format';

interface Item { productId: string; sku: string; name: string; supplierId: string | null; supplier: string | null; available: number; onOrder: number; sold: number; dailyRate: number; coverageDays: number | null; leadDays: number; status: string; abc: string; suggestedQty: number; unitCost: number | null; value: number; reason: string }
interface Data {
  days: number; coverDays: number; basis: string;
  summary: { items: number; value: number; ruptura: number; critico: number; withoutSupplier: number; withoutCost: number };
  suppliers: { supplierId: string | null; supplier: string; items: number; value: number }[]; items: Item[];
}
interface Wh { id: string; code: string; name: string; active: boolean }
const STATUS: Record<string, [string, string]> = { RUPTURA: ['Ruptura', 'danger'], CRITICO: ['Crítico', 'danger'], REPOR: ['Repor', 'warn'], OK: ['Ok', 'ok'] };

/** Sugestão de compra por giro, ponto de reposição, prazo do fornecedor e curva ABC; gera as ordens por fornecedor. */
export function SuggestionsTab({ canCreate, onCreated }: { canCreate: boolean; onCreated: () => void }) {
  const ui = useUi();
  const [days, setDays] = useState('90'); const [cover, setCover] = useState('30');
  const [d, setD] = useState<Data | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [whs, setWhs] = useState<Wh[]>([]); const [wh, setWh] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setD(null); setError('');
    api<Data>(`/purchases/smart-suggestions?days=${days}&coverDays=${Number(cover) || 30}`).then((r) => { setD(r); setQty(Object.fromEntries(r.items.map((i) => [i.productId, String(i.suggestedQty)]))); setPicked(new Set(r.items.filter((i) => i.supplierId && i.unitCost !== null).map((i) => i.productId))); }).catch((e) => setError(e.message));
  }, [days, cover]);
  useEffect(load, [load]);
  useEffect(() => { api<{ establishments: { warehouses: Wh[] }[] }[]>('/structure').then((t) => { const w = t.flatMap((c) => c.establishments.flatMap((e) => e.warehouses)).filter((x) => x.active); setWhs(w); setWh(w[0]?.id ?? ''); }).catch(() => undefined); }, []);

  const sel = (d?.items ?? []).filter((i) => picked.has(i.productId));
  const total = sel.reduce((s, i) => s + (Number(qty[i.productId]) || 0) * (i.unitCost ?? 0), 0);
  async function generate() {
    if (!wh) { setError('Escolha o depósito de destino.'); return; }
    const items = sel.map((i) => ({ productId: i.productId, quantity: Number(qty[i.productId]) || 0 })).filter((i) => i.quantity > 0);
    if (!items.length) { setError('Marque ao menos um item com quantidade.'); return; }
    setBusy(true); setError('');
    try {
      const r = await api<{ orders: { number: number }[] }>('/purchases/from-suggestions', 'POST', { warehouseId: wh, items });
      ui.toast.ok(`${r.orders.length} ordem(ns) de compra criada(s): ${r.orders.map((o) => `#${o.number}`).join(', ')}. Confira em Ordens.`);
      onCreated(); load();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  return (
    <div className="stack">
      {error && <Alert kind="error">{error}</Alert>}
      <div className="toolbar">
        <div><label htmlFor="sg-d" className="muted" style={{ fontSize: '0.8rem' }}>Base de vendas</label><select id="sg-d" value={days} onChange={(e) => setDays(e.target.value)}><option value="30">30 dias</option><option value="60">60 dias</option><option value="90">90 dias</option><option value="180">180 dias</option></select></div>
        <div><label htmlFor="sg-c" className="muted" style={{ fontSize: '0.8rem' }}>Cobrir quantos dias além do prazo?</label><input id="sg-c" inputMode="numeric" value={cover} onChange={(e) => setCover(e.target.value.replace(/\D/g, ''))} style={{ maxWidth: 120 }} /></div>
      </div>
      {!d && !error && <Skeleton rows={4} />}
      {d && <>
        <div className="grid cols-4">
          <StatCard label="Itens a repor" value={d.summary.items} icon={<ShoppingBasket />} />
          <StatCard label="Valor estimado" value={brl(d.summary.value)} icon={<Wallet />} />
          <StatCard label="Em ruptura" value={d.summary.ruptura} icon={<PackageX />} tone={d.summary.ruptura ? 'danger' : undefined} hint="vendem e estão sem estoque" />
          <StatCard label="Críticos" value={d.summary.critico} icon={<AlertTriangle />} tone={d.summary.critico ? 'warn' : undefined} hint="acabam antes da reposição" />
        </div>
        {(d.summary.withoutSupplier > 0 || d.summary.withoutCost > 0) && <Alert kind="warn">{d.summary.withoutSupplier} item(ns) sem fornecedor cadastrado e {d.summary.withoutCost} sem custo: vincule o fornecedor no produto para poder gerar a ordem.</Alert>}
        <section className="card">
          {d.items.length === 0 ? <EmptyState title="Nada a repor agora">Nenhum produto chegou ao ponto de reposição com o ritmo de vendas atual.</EmptyState> : <>
            <div className="table-wrap"><table>
              <thead><tr><th /><th>Produto</th><th>Situação</th><th className="num">Disp.</th><th className="num">Em compra</th><th className="num">Ritmo/dia</th><th className="num">Cobertura</th><th>ABC</th><th>Fornecedor</th><th className="num">Qtd.</th><th className="num">Custo</th></tr></thead>
              <tbody>{d.items.map((i) => {
                const [l, tone] = STATUS[i.status] ?? [i.status, '']; const ok = !!i.supplierId && i.unitCost !== null;
                return (
                  <tr key={i.productId} style={ok ? undefined : { opacity: 0.6 }} title={i.reason}>
                    <td><input type="checkbox" aria-label={`Comprar ${i.sku}`} disabled={!ok} checked={picked.has(i.productId)} onChange={(e) => { const s = new Set(picked); if (e.target.checked) s.add(i.productId); else s.delete(i.productId); setPicked(s); }} style={{ width: 'auto' }} /></td>
                    <td><strong>{i.name}</strong><div className="muted mono" style={{ fontSize: '0.78rem' }}>{i.sku}</div></td>
                    <td><span className={`badge ${tone}`}>{l}</span></td>
                    <td className="num">{i.available}</td><td className="num">{i.onOrder}</td><td className="num">{i.dailyRate}</td>
                    <td className="num">{i.coverageDays === null ? '—' : `${Math.round(i.coverageDays)} d`}<div className="muted" style={{ fontSize: '0.74rem' }}>prazo {i.leadDays} d</div></td>
                    <td><span className={`badge ${i.abc === 'A' ? 'brand' : ''}`}>{i.abc}</span></td>
                    <td>{i.supplier ?? <span className="badge warn">sem fornecedor</span>}</td>
                    <td className="num"><input aria-label={`Quantidade de ${i.sku}`} inputMode="numeric" style={{ width: 80, textAlign: 'right' }} value={qty[i.productId] ?? ''} onChange={(e) => setQty({ ...qty, [i.productId]: e.target.value.replace(/\D/g, '') })} /></td>
                    <td className="num">{i.unitCost === null ? '—' : brl(i.unitCost)}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
            {canCreate && (
              <div className="row" style={{ marginTop: 12 }}>
                <div><label htmlFor="sg-w" className="muted" style={{ fontSize: '0.8rem' }}>Depósito de destino</label><select id="sg-w" value={wh} onChange={(e) => setWh(e.target.value)}>{whs.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select></div>
                <button className={`btn primary ${busy ? 'loading' : ''}`} disabled={busy || !sel.length} onClick={generate} style={{ alignSelf: 'flex-end' }}>Gerar ordens de compra ({sel.length}) · {brl(total)}</button>
              </div>
            )}
          </>}
        </section>
        <p className="muted" style={{ fontSize: '0.8rem' }}>{d.basis} Passe o mouse sobre a linha para ver o motivo.</p>
      </>}
    </div>
  );
}
