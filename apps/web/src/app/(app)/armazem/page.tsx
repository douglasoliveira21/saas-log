'use client';

import { CheckCircle2, ClipboardList, Printer, ScanBarcode, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, EmptyState, PageHeader, Skeleton, useUi } from '@/components/ui';
import { api } from '@/lib/api';
import { dateBr } from '@/lib/format';
import { pickingHtml, pickSummary, type PickList } from './picking-print';

type Tab = 'separacao' | 'conferencia';
interface PickOrder { id: string; number: number; status: string; dispatchDate: string | null; warehouse: string; customer: string; items: number; lastCheck: string | null }
interface CheckInfo { orderId: string; number: number; status: string; customer: string; items: { productId: string; sku: string; name: string; barcode: string | null; expected: number }[] }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const norm = (s: string) => s.trim().toLowerCase();

export default function ArmazemPage() {
  const [tab, setTab] = useState<Tab>('separacao');
  const [orders, setOrders] = useState<PickOrder[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => { api<PickOrder[]>('/warehouse/picking/orders').then(setOrders).catch((e) => setError(e.message)); }, []);
  useEffect(load, [load]);
  return (
    <>
      <PageHeader title="Armazém" description="Separe os pedidos confirmados com a lista indicando lote e endereço, e confira com o leitor de código de barras antes de embalar." />
      {error && <Alert kind="error">{error}</Alert>}
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'separacao'} className={`tab ${tab === 'separacao' ? 'active' : ''}`} onClick={() => setTab('separacao')}>Lista de separação</button>
        <button role="tab" aria-selected={tab === 'conferencia'} className={`tab ${tab === 'conferencia' ? 'active' : ''}`} onClick={() => setTab('conferencia')}>Conferência</button>
      </div>
      {!orders && !error && <Skeleton rows={4} />}
      {orders && orders.length === 0 && <EmptyState icon={<ClipboardList size={22} />} title="Nenhum pedido para separar">Pedidos confirmados ou em separação aparecem aqui.</EmptyState>}
      {orders && orders.length > 0 && (tab === 'separacao' ? <Picking orders={orders} /> : <Check orders={orders} onChecked={load} />)}
    </>
  );
}

function Picking({ orders }: { orders: PickOrder[] }) {
  const ui = useUi();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [list, setList] = useState<PickList | null>(null);
  const [error, setError] = useState('');
  const toggle = (id: string) => { const s = new Set(sel); if (s.has(id)) s.delete(id); else s.add(id); setSel(s); };
  async function gen() {
    setError('');
    try { setList(await api<PickList>(`/warehouse/picking?orderIds=${[...sel].join(',')}`)); } catch (e) { setError((e as Error).message); setList(null); }
  }
  function print() {
    if (!list) return;
    const w = window.open('', '_blank', 'width=900,height=1100');
    if (!w) { ui.toast.error('Libere pop-ups para imprimir.'); return; }
    w.document.write(pickingHtml(list).replace('</body>', '<script>window.onload=function(){setTimeout(function(){window.print()},350)}</script></body>'));
    w.document.close();
  }
  return (
    <div className="stack">
      <section className="card">
        <h2>1. Escolha os pedidos</h2>
        <p className="muted" style={{ marginTop: 0 }}>Marque um ou mais pedidos do <strong>mesmo depósito</strong> para separar juntos (os produtos iguais são somados).</p>
        <div className="table-wrap"><table>
          <thead><tr><th /><th>Pedido</th><th>Cliente</th><th>Depósito</th><th>Saída prevista</th><th className="num">Itens</th></tr></thead>
          <tbody>{orders.map((o) => (
            <tr key={o.id}>
              <td><input type="checkbox" aria-label={`Pedido ${o.number}`} checked={sel.has(o.id)} onChange={() => toggle(o.id)} style={{ width: 'auto' }} /></td>
              <td><strong>#{o.number}</strong></td><td>{o.customer}</td><td>{o.warehouse}</td><td>{o.dispatchDate ? dateBr(o.dispatchDate) : '—'}</td><td className="num">{o.items}</td>
            </tr>
          ))}</tbody>
        </table></div>
        <div className="row" style={{ marginTop: 12 }}><button className="btn primary" disabled={!sel.size} onClick={gen}>Gerar lista de separação{sel.size ? ` (${sel.size})` : ''}</button></div>
      </section>
      {error && <Alert kind="error">{error}</Alert>}
      {list && (
        <section className="card">
          <div className="card-head"><h2>2. Lista de separação — depósito {list.warehouse}</h2><button className="btn primary" onClick={print}><Printer aria-hidden />Imprimir lista</button></div>
          {(() => { const k = pickSummary(list); return (
            <div className="mf-kpis">
              <div><b>{k.products}</b><small>Produtos</small></div><div><b>{k.units}</b><small>Unidades</small></div><div><b>{k.places}</b><small>Endereços a visitar</small></div><div className={k.short ? 'bad' : ''}><b>{k.short}</b><small>Com falta</small></div>
            </div>); })()}
          <div className="pk-orders">{list.orders.map((o) => <span key={o.id} className="badge brand" title={o.customer}>#{o.number} · {o.customer}</span>)}</div>
          <div className="table-wrap"><table>
            <thead><tr><th>Endereço</th><th>Produto</th><th>Lote / validade</th><th className="num">Qtd.</th><th>Pedidos</th></tr></thead>
            <tbody>{list.lines.flatMap((l) => l.picks.map((p, i) => {
              const d = p.expiresAt ? Math.round((Date.parse(`${p.expiresAt}T00:00:00Z`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) / 86_400_000) : null;
              return (
                <tr key={`${l.productId}-${i}`} className={i > 0 ? 'pk-cont' : ''}>
                  <td>{p.location ? <span className="pk-loc">{p.location}</span> : <span className="pk-loc none">sem endereço</span>}</td>
                  <td>{i === 0 ? <><strong>{l.name}</strong><div className="muted mono" style={{ fontSize: '0.78rem' }}>{l.sku}{l.barcode ? ` · ${l.barcode}` : ''}</div></> : ''}</td>
                  <td>{p.lotCode ? <span className="mono">{p.lotCode}</span> : '—'}{p.expiresAt && <div className={`pk-exp ${d !== null && d < 0 ? 'over' : d !== null && d <= 30 ? 'soon' : ''}`}>vence {dateBr(p.expiresAt)}{d !== null && d >= 0 && d <= 30 ? ` (${d} d)` : ''}</div>}</td>
                  <td className="num"><span className="pk-qty">{p.qty}</span> {l.unit}</td>
                  <td className="muted" style={{ fontSize: '0.8rem' }}>{i === 0 ? l.orders.map((o) => `#${o.number}: ${o.qty}`).join(' · ') : ''}{i === l.picks.length - 1 && l.shortage > 0 && <div><span className="badge danger">faltam {l.shortage} {l.unit}</span></div>}</td>
                </tr>
              );
            }))}</tbody>
          </table></div>
          {list.lines.some((l) => l.shortage > 0) && <Alert kind="warn">Algum produto não tem saldo válido suficiente (veja “Faltam” na impressão): confira o estoque e os lotes vencidos antes de separar.</Alert>}
        </section>
      )}
    </div>
  );
}

function Check({ orders, onChecked }: { orders: PickOrder[]; onChecked: () => void }) {
  const ui = useUi();
  const [orderId, setOrderId] = useState('');
  const [info, setInfo] = useState<CheckInfo | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [unknown, setUnknown] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const [result, setResult] = useState<{ status: string } | null>(null);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setInfo(null); setCounts({}); setUnknown([]); setResult(null); setFlash(null);
    if (!orderId) return;
    api<CheckInfo>(`/warehouse/check/${orderId}`).then((i) => { setInfo(i); setTimeout(() => input.current?.focus(), 50); }).catch((e) => setError(e.message));
  }, [orderId]);

  function scan(raw: string) {
    const c = norm(raw);
    if (!c || !info) return;
    const item = info.items.find((i) => (i.barcode && norm(i.barcode) === c) || norm(i.sku) === c);
    if (!item) { setUnknown((u) => [...u, raw.trim()]); setFlash({ ok: false, text: `Código ${raw.trim()} não pertence a este pedido.` }); return; }
    const next = (counts[item.productId] ?? 0) + 1;
    setCounts({ ...counts, [item.productId]: next });
    setFlash(next > item.expected ? { ok: false, text: `${item.name}: passou da quantidade (${next} de ${item.expected}).` } : { ok: true, text: `${item.name}: ${next} de ${item.expected}` });
  }
  const done = useMemo(() => !!info && info.items.every((i) => (counts[i.productId] ?? 0) === i.expected) && unknown.length === 0, [info, counts, unknown]);

  async function finish() {
    if (!info) return;
    setError('');
    try {
      const r = await api<{ status: string }>(`/warehouse/check/${info.orderId}`, 'POST', { items: info.items.map((i) => ({ productId: i.productId, counted: counts[i.productId] ?? 0 })), unknown });
      setResult(r); onChecked();
      if (r.status === 'OK') ui.toast.ok('Conferência sem divergência.'); else ui.toast.error('Conferência com divergência.');
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      {error && <Alert kind="error">{error}</Alert>}
      <section className="card">
        <label htmlFor="ck-o">Pedido a conferir</label>
        <select id="ck-o" value={orderId} onChange={(e) => setOrderId(e.target.value)}><option value="">Selecione…</option>{orders.map((o) => <option key={o.id} value={o.id}>#{o.number} — {o.customer}{o.lastCheck ? ` (última: ${o.lastCheck === 'OK' ? 'ok' : 'divergente'})` : ''}</option>)}</select>
      </section>
      {info && (
        <section className="card">
          <h2><ScanBarcode size={18} aria-hidden style={{ verticalAlign: '-3px' }} /> Pedido #{info.number} — {info.customer}</h2>
          <label htmlFor="ck-c">Leia o código de barras de cada item (ou digite e tecle Enter)</label>
          <input id="ck-c" ref={input} value={code} autoComplete="off" inputMode="text" placeholder="Aponte o leitor aqui" onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); scan(code); setCode(''); } }} disabled={!!result} />
          {flash && <div className={`alert ${flash.ok ? 'ok' : 'error'}`} role="status" style={{ marginTop: 10 }}>{flash.ok ? <CheckCircle2 aria-hidden /> : <XCircle aria-hidden />}<div>{flash.text}</div></div>}
          <div className="table-wrap" style={{ marginTop: 12 }}><table>
            <thead><tr><th>Produto</th><th className="num">Lido</th><th className="num">Pedido</th><th /></tr></thead>
            <tbody>{info.items.map((i) => {
              const n = counts[i.productId] ?? 0;
              return (
                <tr key={i.productId}>
                  <td><strong>{i.name}</strong><div className="muted mono" style={{ fontSize: '0.78rem' }}>{i.sku}{i.barcode ? ` · ${i.barcode}` : ' · sem código de barras (digite o SKU)'}</div></td>
                  <td className="num"><strong>{n}</strong></td><td className="num">{i.expected}</td>
                  <td><span className={`badge ${n === i.expected ? 'ok' : n > i.expected ? 'danger' : ''}`}>{n === i.expected ? 'Conferido' : n > i.expected ? `+${n - i.expected} a mais` : `faltam ${i.expected - n}`}</span></td>
                </tr>
              );
            })}</tbody>
          </table></div>
          {unknown.length > 0 && <Alert kind="error">Códigos lidos que não são deste pedido: {unknown.join(', ')}. Tire o item errado e recomece a conferência.</Alert>}
          {result && <Alert kind={result.status === 'OK' ? 'ok' : 'error'}>{result.status === 'OK' ? 'Pedido conferido: pode ser embalado em Vendas e pedidos.' : 'Divergência registrada. Corrija e confira de novo.'}</Alert>}
          <div className="row" style={{ marginTop: 12 }}>
            {!result && <button className={`btn ${done ? 'primary' : ''}`} onClick={finish}>{done ? 'Concluir conferência' : 'Registrar com divergência'}</button>}
            <button className="btn" onClick={() => { setCounts({}); setUnknown([]); setResult(null); setFlash(null); input.current?.focus(); }}>Recomeçar</button>
          </div>
        </section>
      )}
    </div>
  );
}
