'use client';

import { FileSearch, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Dialog, EmptyState, Skeleton, useUi } from '@/components/ui';
import { api } from '@/lib/api';
import { brl, dateBr } from '@/lib/format';

interface RfqRow { id: string; number: number; status: string; createdAt: string; neededBy: string | null; items: number; suppliers: number; responded: number }
interface Sup { rfqSupplierId: string; supplierId: string; name: string; leadTimeDays: number | null; freight: number; paymentTerms: string | null; responded: boolean; pricedItems: number; complete: boolean; goods: string; total: string; prices: Record<string, number> }
interface Detail {
  id: string; number: number; status: string; warehouseId: string; neededBy: string | null; notes: string | null; orderIds: string[];
  items: { productId: string; sku: string; name: string; quantity: number; bestSupplierId: string | null; bestUnitCost: number | null }[]; suppliers: Sup[];
  bestSingleSupplierId: string | null; bestPerItem: { total: string; suppliers: number } | null;
}
interface Product { id: string; sku: string; name: string }
interface Supplier { id: string; legalName: string; active: boolean }
interface Wh { id: string; code: string; name: string; active: boolean }
const STATUS: Record<string, [string, string]> = { OPEN: ['Aberta', 'info'], CLOSED: ['Encerrada', 'ok'], CANCELLED: ['Cancelada', 'danger'] };
const num = (v: string) => { const n = Number(v.replace(',', '.')); return Number.isFinite(n) ? n : 0; };

/** Cotação entre fornecedores: pede preço a vários, compara lado a lado e gera as ordens do vencedor. */
export function RfqTab({ canCreate, onCreated }: { canCreate: boolean; onCreated: () => void }) {
  const ui = useUi();
  const [rows, setRows] = useState<RfqRow[] | null>(null);
  const [form, setForm] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const load = useCallback(() => { api<RfqRow[]>('/purchases/rfq').then(setRows).catch(() => setRows([])); }, []);
  useEffect(load, [load]);
  return (
    <div className="stack">
      {canCreate && <div className="row"><button className="btn primary" onClick={() => setForm(true)}><Plus aria-hidden />Nova cotação</button></div>}
      <section className="card">
        {!rows && <Skeleton rows={3} />}
        {rows && rows.length === 0 && <EmptyState icon={<FileSearch size={22} />} title="Nenhuma cotação">Peça preço a vários fornecedores para os mesmos itens e compare antes de comprar.</EmptyState>}
        {rows && rows.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th>Nº</th><th>Situação</th><th>Precisa até</th><th className="num">Itens</th><th>Propostas</th><th /></tr></thead>
            <tbody>{rows.map((r) => { const [l, tone] = STATUS[r.status] ?? [r.status, '']; return <tr key={r.id}><td><strong>#{r.number}</strong></td><td><span className={`badge dot ${tone}`}>{l}</span></td><td>{r.neededBy ? dateBr(r.neededBy) : '—'}</td><td className="num">{r.items}</td><td>{r.responded} de {r.suppliers} responderam</td><td><button className="btn sm" onClick={() => setOpenId(r.id)}>Abrir</button></td></tr>; })}</tbody>
          </table></div>
        )}
      </section>
      {form && <RfqForm onClose={() => setForm(false)} onSaved={(id) => { setForm(false); load(); ui.toast.ok('Cotação criada. Registre a proposta de cada fornecedor.'); setOpenId(id); }} />}
      {openId && <RfqDetail id={openId} canCreate={canCreate} onClose={() => { setOpenId(null); load(); }} onAwarded={() => { load(); onCreated(); }} />}
    </div>
  );
}

function RfqForm({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const [products, setProducts] = useState<Product[]>([]); const [suppliers, setSuppliers] = useState<Supplier[]>([]); const [whs, setWhs] = useState<Wh[]>([]);
  const [wh, setWh] = useState(''); const [needed, setNeeded] = useState(''); const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<{ productId: string; qty: string }[]>([{ productId: '', qty: '1' }]);
  const [picked, setPicked] = useState<Set<string>>(new Set()); const [error, setError] = useState('');
  useEffect(() => {
    api<{ items: Product[] }>('/products?limit=200').then((r) => setProducts(r.items)).catch(() => undefined);
    api<Supplier[]>('/suppliers').then((s) => setSuppliers(s.filter((x) => x.active))).catch(() => undefined);
    api<{ establishments: { warehouses: Wh[] }[] }[]>('/structure').then((t) => { const w = t.flatMap((c) => c.establishments.flatMap((e) => e.warehouses)).filter((x) => x.active); setWhs(w); setWh(w[0]?.id ?? ''); }).catch(() => undefined);
  }, []);
  async function save() {
    setError('');
    const items = lines.filter((l) => l.productId).map((l) => ({ productId: l.productId, quantity: Math.floor(num(l.qty)) }));
    if (!items.length) { setError('Escolha ao menos um produto.'); return; }
    if (picked.size < 1) { setError('Escolha ao menos um fornecedor (até 10).'); return; }
    try { const r = await api<{ id: string }>('/purchases/rfq', 'POST', { warehouseId: wh, neededBy: needed || undefined, notes: notes || undefined, items, supplierIds: [...picked] }); onSaved(r.id); } catch (e) { setError((e as Error).message); }
  }
  return (
    <Dialog title="Nova cotação" description="Escolha o que precisa e quem vai cotar." onClose={onClose} xl>
      <div className="modal-body">
        {error && <Alert kind="error">{error}</Alert>}
        <div className="form-grid">
          <div><label htmlFor="rq-w">Depósito de entrega</label><select id="rq-w" value={wh} onChange={(e) => setWh(e.target.value)}>{whs.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select></div>
          <div><label htmlFor="rq-n">Precisa até</label><input id="rq-n" type="date" value={needed} onChange={(e) => setNeeded(e.target.value)} /></div>
          <div><label htmlFor="rq-o">Observações</label><input id="rq-o" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        </div>
        <h3 style={{ margin: '16px 0 8px' }}>Itens</h3>
        {lines.map((l, i) => (
          <div className="row" key={i} style={{ marginBottom: 8 }}>
            <select aria-label="Produto" value={l.productId} style={{ flex: '2 1 240px', width: 'auto' }} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, productId: e.target.value } : x)))}><option value="">Produto…</option>{products.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}</select>
            <input aria-label="Quantidade" inputMode="numeric" style={{ width: 100 }} value={l.qty} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, qty: e.target.value } : x)))} />
            {lines.length > 1 && <button className="btn sm" aria-label="Remover" onClick={() => setLines(lines.filter((_, k) => k !== i))}><Trash2 aria-hidden /></button>}
          </div>
        ))}
        <button className="btn sm" onClick={() => setLines([...lines, { productId: '', qty: '1' }])}><Plus aria-hidden />Adicionar item</button>
        <h3 style={{ margin: '16px 0 8px' }}>Fornecedores que vão cotar</h3>
        <div className="row">{suppliers.map((s) => <label key={s.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" style={{ width: 'auto' }} checked={picked.has(s.id)} onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(s.id); else n.delete(s.id); setPicked(n); }} />{s.legalName}</label>)}</div>
      </div>
      <div className="modal-foot"><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>Criar cotação</button></div>
    </Dialog>
  );
}

function RfqDetail({ id, canCreate, onClose, onAwarded }: { id: string; canCreate: boolean; onClose: () => void; onAwarded: () => void }) {
  const ui = useUi();
  const [d, setD] = useState<Detail | null>(null); const [error, setError] = useState(''); const [edit, setEdit] = useState<Sup | null>(null);
  const load = useCallback(() => { api<Detail>(`/purchases/rfq/${id}`).then(setD).catch((e) => setError(e.message)); }, [id]);
  useEffect(load, [load]);
  const open = d?.status === 'OPEN' && canCreate;

  async function award(mode: 'SINGLE' | 'BEST_PER_ITEM', supplierId?: string) {
    const label = mode === 'SINGLE' ? 'Comprar tudo do fornecedor escolhido' : 'Comprar cada item pelo menor preço';
    if (!(await ui.confirm({ title: label, message: 'Serão criadas as ordens de compra com os preços cotados e a cotação será encerrada. As ordens seguem a alçada normal de aprovação.', confirmLabel: 'Gerar ordens', cancelLabel: 'Voltar' }))) return;
    try { const r = await api<{ orders: { number: number }[] }>(`/purchases/rfq/${id}/award`, 'POST', { mode, supplierId }); ui.toast.ok(`Ordens criadas: ${r.orders.map((o) => `#${o.number}`).join(', ')}.`); load(); onAwarded(); } catch (e) { setError((e as Error).message); }
  }
  async function cancel() {
    const reason = await ui.prompt({ title: 'Cancelar cotação', label: 'Motivo', confirmLabel: 'Cancelar cotação', danger: true, cancelLabel: 'Voltar' });
    if (!reason) return;
    try { await api(`/purchases/rfq/${id}/cancel`, 'POST', { reason }); load(); } catch (e) { setError((e as Error).message); }
  }

  return (
    <Dialog title={d ? `Cotação #${d.number}` : 'Cotação'} description={d && <span className={`badge dot ${STATUS[d.status]?.[1] ?? ''}`}>{STATUS[d.status]?.[0] ?? d.status}</span>} onClose={onClose} xl>
      <div className="modal-body">
        {error && <Alert kind="error">{error}</Alert>}
        {!d && !error && <Skeleton rows={4} />}
        {d && <>
          {d.notes && <p className="muted" style={{ marginTop: 0 }}>{d.notes}</p>}
          <div className="table-wrap"><table>
            <thead><tr><th>Item</th><th className="num">Qtd.</th>{d.suppliers.map((s) => <th key={s.supplierId} className="num">{s.name}{open && <div><button className="btn sm" onClick={() => setEdit(s)}>{s.responded ? 'Editar proposta' : 'Registrar proposta'}</button></div>}</th>)}</tr></thead>
            <tbody>
              {d.items.map((i) => (
                <tr key={i.productId}>
                  <td><strong>{i.name}</strong><div className="muted mono" style={{ fontSize: '0.78rem' }}>{i.sku}</div></td><td className="num">{i.quantity}</td>
                  {d.suppliers.map((s) => { const p = s.prices[i.productId]; const best = p !== undefined && i.bestSupplierId === s.supplierId; return <td key={s.supplierId} className="num" style={best ? { background: 'var(--ok-soft)', fontWeight: 650 } : undefined}>{p === undefined ? <span className="muted">—</span> : brl(p)}</td>; })}
                </tr>
              ))}
              <tr><td colSpan={2}><strong>Prazo de entrega</strong></td>{d.suppliers.map((s) => <td key={s.supplierId} className="num">{s.leadTimeDays === null ? '—' : `${s.leadTimeDays} dias`}</td>)}</tr>
              <tr><td colSpan={2}><strong>Frete</strong></td>{d.suppliers.map((s) => <td key={s.supplierId} className="num">{brl(s.freight)}</td>)}</tr>
              <tr><td colSpan={2}><strong>Total</strong></td>{d.suppliers.map((s) => <td key={s.supplierId} className="num" style={d.bestSingleSupplierId === s.supplierId ? { background: 'var(--ok-soft)', fontWeight: 700 } : undefined}>{s.pricedItems ? brl(s.total) : '—'}{!s.complete && s.pricedItems > 0 && <div className="muted" style={{ fontSize: '0.74rem' }}>cotou {s.pricedItems} de {d.items.length}</div>}</td>)}</tr>
              <tr><td colSpan={2}><strong>Condição</strong></td>{d.suppliers.map((s) => <td key={s.supplierId} className="num" style={{ fontSize: '0.82rem' }}>{s.paymentTerms ?? '—'}</td>)}</tr>
            </tbody>
          </table></div>
          <p className="muted" style={{ fontSize: '0.82rem' }}>Verde = menor preço do item / menor total entre quem cotou tudo.{d.bestPerItem ? ` Comprando cada item pelo menor preço o total seria ${brl(d.bestPerItem.total)} em ${d.bestPerItem.suppliers} fornecedor(es).` : ''}</p>
          {d.orderIds.length > 0 && <Alert kind="ok">{d.orderIds.length} ordem(ns) de compra gerada(s) por esta cotação. Veja em Ordens.</Alert>}
          {open && <div className="row">
            <button className="btn primary" disabled={!d.bestSingleSupplierId} onClick={() => award('SINGLE', d.bestSingleSupplierId ?? undefined)}>Comprar do melhor total ({d.suppliers.find((s) => s.supplierId === d.bestSingleSupplierId)?.name ?? '—'})</button>
            <button className="btn" disabled={!d.bestPerItem} onClick={() => award('BEST_PER_ITEM')}>Melhor preço por item</button>
            <button className="btn" onClick={cancel}>Cancelar cotação</button>
          </div>}
        </>}
      </div>
      {edit && d && <ProposalDialog rfqId={id} supplier={edit} items={d.items} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </Dialog>
  );
}

function ProposalDialog({ rfqId, supplier, items, onClose, onSaved }: { rfqId: string; supplier: Sup; items: Detail['items']; onClose: () => void; onSaved: () => void }) {
  const [prices, setPrices] = useState<Record<string, string>>(Object.fromEntries(items.map((i) => [i.productId, supplier.prices[i.productId] !== undefined ? String(supplier.prices[i.productId]).replace('.', ',') : ''])));
  const [lead, setLead] = useState(supplier.leadTimeDays === null ? '' : String(supplier.leadTimeDays));
  const [freight, setFreight] = useState(supplier.freight ? String(supplier.freight).replace('.', ',') : '');
  const [terms, setTerms] = useState(supplier.paymentTerms ?? ''); const [error, setError] = useState('');
  async function save() {
    setError('');
    try {
      await api(`/purchases/rfq/${rfqId}/suppliers/${supplier.supplierId}`, 'PUT', {
        leadTimeDays: lead === '' ? undefined : Math.floor(num(lead)), freight: freight === '' ? undefined : num(freight), paymentTerms: terms || undefined,
        prices: items.filter((i) => prices[i.productId] !== '').map((i) => ({ productId: i.productId, unitCost: num(prices[i.productId]) })),
      });
      onSaved();
    } catch (e) { setError((e as Error).message); }
  }
  return (
    <Dialog title={`Proposta — ${supplier.name}`} description="Preencha o que o fornecedor respondeu. Deixe vazio o item que ele não cotou." onClose={onClose}>
      <div className="modal-body">
        {error && <Alert kind="error">{error}</Alert>}
        {items.map((i) => <div key={i.productId} style={{ marginBottom: 8 }}><label htmlFor={`pp-${i.productId}`}>{i.sku} — {i.name} ({i.quantity} un.) · preço unitário (R$)</label><input id={`pp-${i.productId}`} inputMode="decimal" value={prices[i.productId]} onChange={(e) => setPrices({ ...prices, [i.productId]: e.target.value })} /></div>)}
        <div className="form-grid">
          <div><label htmlFor="pp-l">Prazo de entrega (dias)</label><input id="pp-l" inputMode="numeric" value={lead} onChange={(e) => setLead(e.target.value.replace(/\D/g, ''))} /></div>
          <div><label htmlFor="pp-f">Frete (R$)</label><input id="pp-f" inputMode="decimal" value={freight} onChange={(e) => setFreight(e.target.value)} /></div>
          <div><label htmlFor="pp-t">Condição de pagamento</label><input id="pp-t" maxLength={200} value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="Ex.: 30/60 dias" /></div>
        </div>
      </div>
      <div className="modal-foot"><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>Salvar proposta</button></div>
    </Dialog>
  );
}
