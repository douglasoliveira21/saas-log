'use client';

import { FileText, Plus, Printer, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Dialog, EmptyState, PageHeader, Skeleton, useUi } from '@/components/ui';
import { api } from '@/lib/api';
import { brl, dateBr } from '@/lib/format';
import { PAYMENT_LABEL } from '@/lib/order-flow';
import { useSession } from '@/lib/session';
import { printQuote } from './print';

interface QuoteRow { id: string; number: number; displayStatus: string; validUntil: string; total: string; createdAt: string; customer: { name: string } }
interface QuoteDetail extends QuoteRow {
  expired: boolean; status: string; customerId: string; warehouseId: string; paymentMethod: string | null; notes: string | null; subtotal: string; discountTotal: string; shipping: string; lostReason: string | null;
  customer: { id: string; name: string; document: string | null; phone: string | null; email: string | null };
  items: { id: string; productId: string; quantity: number; unitPrice: string; discountPct: string; total: string; product: { sku: string; name: string; saleUnit: string } }[];
  order: { id: string; number: number; status: string } | null;
}
interface Product { id: string; sku: string; name: string; suggestedPrice: string | null }
interface Customer { id: string; name: string }
interface Warehouse { id: string; code: string; name: string; active: boolean }
interface Line { productId: string; quantity: string; unitPrice: string; discountPct: string }

const STATUS: Record<string, [string, string]> = { OPEN: ['Em aberto', 'info'], CONVERTED: ['Virou pedido', 'ok'], LOST: ['Perdido', 'danger'], EXPIRED: ['Vencido', 'warn'] };
const num = (v: string) => (v.trim() === '' ? undefined : Number(v.replace(',', '.')));
const emptyLine = (): Line => ({ productId: '', quantity: '1', unitPrice: '', discountPct: '' });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export default function OrcamentosPage() {
  const { can } = useSession();
  const ui = useUi();
  const [rows, setRows] = useState<QuoteRow[] | null>(null);
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState<QuoteDetail | null>(null);
  const [form, setForm] = useState<{ id?: string } | null>(null);
  const [convert, setConvert] = useState<QuoteDetail | null>(null);
  const [error, setError] = useState('');
  const [products, setProducts] = useState<Product[]>([]); const [customers, setCustomers] = useState<Customer[]>([]); const [whs, setWhs] = useState<Warehouse[]>([]);

  const load = useCallback(() => { api<QuoteRow[]>(`/quotes${filter ? `?status=${filter}` : ''}`).then(setRows).catch((e) => setError(e.message)); }, [filter]);
  useEffect(load, [load]);
  useEffect(() => {
    api<{ items: Product[] }>('/products?limit=200').then((r) => setProducts(r.items)).catch(() => undefined);
    api<Customer[]>('/customers').then(setCustomers).catch(() => undefined);
    api<{ establishments: { warehouses: Warehouse[] }[] }[]>('/structure').then((t) => setWhs(t.flatMap((c) => c.establishments.flatMap((e) => e.warehouses)).filter((w) => w.active))).catch(() => undefined);
  }, []);
  const open = useCallback(async (id: string) => { setError(''); try { setDetail(await api<QuoteDetail>(`/quotes/${id}`)); } catch (e) { setError((e as Error).message); } }, []);
  const shown = useMemo(() => (rows ?? []).filter((r) => !q.trim() || String(r.number).includes(q.trim()) || r.customer.name.toLowerCase().includes(q.trim().toLowerCase())), [rows, q]);

  async function lost(d: QuoteDetail) {
    const reason = await ui.prompt({ title: 'Marcar como perdido', label: 'Motivo (ex.: fechou com concorrente)', confirmLabel: 'Marcar como perdido', danger: true, cancelLabel: 'Voltar' });
    if (!reason) return;
    try { await api(`/quotes/${d.id}/lost`, 'POST', { reason }); ui.toast.ok('Orçamento marcado como perdido.'); load(); await open(d.id); } catch (e) { setError((e as Error).message); }
  }
  async function print(d: QuoteDetail) {
    try { if (!(await printQuote(d.id))) ui.toast.error('Libere pop-ups para imprimir.'); } catch (e) { ui.toast.error((e as Error).message); }
  }

  return (
    <>
      <PageHeader title="Orçamentos" description="Monte uma proposta com preços fixos e validade. Se o cliente aceitar, converta em pedido com um clique, sem digitar de novo." actions={can('sales.create') && <button className="btn primary" onClick={() => setForm({})} disabled={!customers.length || !whs.length}><Plus aria-hidden />Novo orçamento</button>} />
      {error && <Alert kind="error">{error}</Alert>}
      <section className="card">
        <div className="toolbar">
          <div className="search"><Search aria-hidden /><input aria-label="Buscar orçamento" placeholder="Buscar por nº ou cliente…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <select aria-label="Situação" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 200 }}><option value="">Todas as situações</option><option value="OPEN">Em aberto</option><option value="EXPIRED">Vencidos</option><option value="CONVERTED">Viraram pedido</option><option value="LOST">Perdidos</option></select>
        </div>
        {!rows && !error && <Skeleton rows={4} />}
        {rows && shown.length === 0 && <EmptyState icon={<FileText size={22} />} title="Nenhum orçamento">Crie um orçamento para o cliente decidir; ao aceitar, vire pedido.</EmptyState>}
        {rows && shown.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th>Nº</th><th>Cliente</th><th>Situação</th><th>Válido até</th><th className="num">Total</th><th /></tr></thead>
            <tbody>{shown.map((r) => { const [l, tone] = STATUS[r.displayStatus] ?? [r.displayStatus, '']; return (
              <tr key={r.id}><td><strong>#{r.number}</strong></td><td>{r.customer.name}</td><td><span className={`badge dot ${tone}`}>{l}</span></td><td>{dateBr(r.validUntil)}</td><td className="num">{brl(r.total)}</td><td><button className="btn sm" onClick={() => open(r.id)}>Abrir</button></td></tr>
            ); })}</tbody>
          </table></div>
        )}
      </section>

      {detail && (() => {
        const [l, tone] = STATUS[detail.displayStatus] ?? [detail.displayStatus, ''];
        const canAct = detail.status === 'OPEN' && can('sales.create');
        return (
          <Dialog title={`Orçamento #${detail.number}`} description={<span className={`badge dot ${tone}`}>{l}</span>} onClose={() => setDetail(null)} xl>
            <div className="modal-body">
              {error && <Alert kind="error">{error}</Alert>}
              <div className="row" style={{ marginBottom: 14 }}>
                {canAct && !detail.expired && <button className="btn primary" onClick={() => setConvert(detail)}>Converter em pedido</button>}
                {canAct && <button className="btn" onClick={() => { setDetail(null); setForm({ id: detail.id }); }}>{detail.expired ? 'Renovar / editar' : 'Editar'}</button>}
                <button className="btn" onClick={() => print(detail)}><Printer aria-hidden />Imprimir proposta</button>
                {canAct && <button className="btn" onClick={() => lost(detail)}>Perdido</button>}
              </div>
              {detail.expired && <Alert kind="warn">Orçamento vencido em {dateBr(detail.validUntil)}. Use “Renovar / editar” para nova validade e conferir os preços.</Alert>}
              {detail.order && <Alert kind="ok">Virou o pedido #{detail.order.number}. Veja em Vendas e pedidos.</Alert>}
              {detail.lostReason && <Alert kind="error">Perdido: {detail.lostReason}</Alert>}
              <div className="meta" style={{ marginBottom: 12 }}><span><b>Cliente:</b> {detail.customer.name}</span><span><b>Válido até:</b> {dateBr(detail.validUntil)}</span>{detail.paymentMethod && <span><b>Pagamento previsto:</b> {PAYMENT_LABEL[detail.paymentMethod]}</span>}</div>
              <div className="table-wrap"><table>
                <thead><tr><th>Produto</th><th>Qtd.</th><th className="num">Preço</th><th>Desc.</th><th className="num">Total</th></tr></thead>
                <tbody>{detail.items.map((i) => <tr key={i.id}><td>{i.product.sku} — {i.product.name}</td><td>{i.quantity}</td><td className="num">{brl(i.unitPrice)}</td><td>{Number(i.discountPct)}%</td><td className="num">{brl(i.total)}</td></tr>)}</tbody>
              </table></div>
              <div className="totals-bar" style={{ marginTop: 12 }}><span>Produtos {brl(detail.subtotal)}</span><span>Descontos − {brl(detail.discountTotal)}</span><span>Frete {brl(detail.shipping)}</span><span className="grand">Total {brl(detail.total)}</span></div>
              {detail.notes && <p className="muted">{detail.notes}</p>}
            </div>
          </Dialog>
        );
      })()}

      {form && <QuoteForm id={form.id} products={products} customers={customers} whs={whs} onClose={() => setForm(null)} onSaved={async (id) => { setForm(null); load(); ui.toast.ok('Orçamento salvo.'); await open(id); }} />}
      {convert && <ConvertDialog quote={convert} onClose={() => setConvert(null)} onDone={async (r) => { setConvert(null); load(); await open(convert.id); ui.toast.ok(r.orderStatus === 'CONFIRMED' ? `Pedido #${r.orderNumber} criado e confirmado.` : r.orderStatus === 'PENDING_APPROVAL' ? `Pedido #${r.orderNumber} criado e enviado para aprovação: ${r.reasons.join('; ')}` : `Pedido #${r.orderNumber} criado como rascunho.`); }} />}
    </>
  );
}

function QuoteForm({ id, products, customers, whs, onClose, onSaved }: { id?: string; products: Product[]; customers: Customer[]; whs: Warehouse[]; onClose: () => void; onSaved: (id: string) => void }) {
  const [meta, setMeta] = useState({ customerId: customers[0]?.id ?? '', warehouseId: whs[0]?.id ?? '', validDays: '7', paymentMethod: '', shipping: '', notes: '' });
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!id) return;
    api<QuoteDetail>(`/quotes/${id}`).then((d) => { setMeta({ customerId: d.customerId, warehouseId: d.warehouseId, validDays: '7', paymentMethod: d.paymentMethod ?? '', shipping: String(Number(d.shipping) || ''), notes: d.notes ?? '' }); setLines(d.items.map((i) => ({ productId: i.productId, quantity: String(i.quantity), unitPrice: i.unitPrice, discountPct: String(Number(i.discountPct) || '') }))); }).catch((e) => setError(e.message));
  }, [id]);
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const calc = lines.map((l) => { const g = (Number(l.quantity) || 0) * (num(l.unitPrice) ?? 0); return g * (1 - (num(l.discountPct) ?? 0) / 100); });
  const total = calc.reduce((a, b) => a + b, 0) + (num(meta.shipping) ?? 0);

  async function save() {
    setError('');
    const items = lines.filter((l) => l.productId).map((l) => ({ productId: l.productId, quantity: Number(l.quantity), unitPrice: num(l.unitPrice), discountPct: num(l.discountPct) }));
    if (!items.length) { setError('Escolha ao menos um produto.'); return; }
    const body = { customerId: meta.customerId, warehouseId: meta.warehouseId, validDays: Number(meta.validDays) || 7, shipping: num(meta.shipping) ?? 0, notes: meta.notes || undefined, ...(meta.paymentMethod ? { paymentMethod: meta.paymentMethod } : {}), items };
    try { const r = id ? await api<{ id: string }>(`/quotes/${id}`, 'PUT', body) : await api<{ id: string }>('/quotes', 'POST', body); onSaved(r.id); } catch (e) { setError((e as Error).message); }
  }
  return (
    <Dialog title={id ? 'Editar orçamento' : 'Novo orçamento'} description="Preços e descontos ficam fixos até a validade. O estoque não é reservado." onClose={onClose} xl>
      <div className="modal-body">
        {error && <Alert kind="error">{error}</Alert>}
        <div className="form-grid">
          <div><label htmlFor="q-c">Cliente *</label><select id="q-c" value={meta.customerId} onChange={(e) => setMeta({ ...meta, customerId: e.target.value })}>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
          <div><label htmlFor="q-w">Depósito de saída *</label><select id="q-w" value={meta.warehouseId} onChange={(e) => setMeta({ ...meta, warehouseId: e.target.value })}>{whs.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select></div>
          <div><label htmlFor="q-v">Validade (dias a partir de hoje)</label><input id="q-v" inputMode="numeric" value={meta.validDays} onChange={(e) => setMeta({ ...meta, validDays: e.target.value.replace(/\D/g, '') })} /></div>
          <div><label htmlFor="q-p">Pagamento previsto</label><select id="q-p" value={meta.paymentMethod} onChange={(e) => setMeta({ ...meta, paymentMethod: e.target.value })}><option value="">A definir</option>{Object.entries(PAYMENT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
          <div><label htmlFor="q-s">Frete (R$)</label><input id="q-s" inputMode="decimal" placeholder="0,00" value={meta.shipping} onChange={(e) => setMeta({ ...meta, shipping: e.target.value })} /></div>
        </div>
        <h3 style={{ margin: '16px 0 8px' }}>Produtos</h3>
        <div className="line-grid head" aria-hidden><span>Produto</span><span>Qtd.</span><span>Preço (R$)</span><span>Desc. %</span><span style={{ textAlign: 'right' }}>Total</span><span /></div>
        {lines.map((l, i) => (
          <div className="line-grid" key={i}>
            <select aria-label="Produto" value={l.productId} onChange={(e) => { const p = products.find((x) => x.id === e.target.value); set(i, { productId: e.target.value, unitPrice: p?.suggestedPrice ?? l.unitPrice }); }}><option value="">Escolha o produto…</option>{products.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}</select>
            <input aria-label="Quantidade" inputMode="numeric" value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} />
            <input aria-label="Preço unitário" inputMode="decimal" placeholder="0,00" value={l.unitPrice} onChange={(e) => set(i, { unitPrice: e.target.value })} />
            <input aria-label="Desconto %" inputMode="decimal" placeholder="0" value={l.discountPct} onChange={(e) => set(i, { discountPct: e.target.value })} />
            <span className="tot">{brl(calc[i])}</span>
            {lines.length > 1 ? <button type="button" className="btn sm" aria-label="Remover item" onClick={() => setLines(lines.filter((_, k) => k !== i))}><Trash2 aria-hidden /></button> : <span />}
          </div>
        ))}
        <button type="button" className="btn sm" onClick={() => setLines([...lines, emptyLine()])}><Plus aria-hidden />Adicionar produto</button>
        <div style={{ marginTop: 12 }}><label htmlFor="q-n">Observações para o cliente</label><input id="q-n" maxLength={1000} value={meta.notes} onChange={(e) => setMeta({ ...meta, notes: e.target.value })} /></div>
        <div className="totals-bar" style={{ marginTop: 12 }} aria-live="polite"><span className="grand">Total {brl(total)}</span></div>
      </div>
      <div className="modal-foot"><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>Salvar orçamento</button></div>
    </Dialog>
  );
}

function ConvertDialog({ quote, onClose, onDone }: { quote: QuoteDetail; onClose: () => void; onDone: (r: { orderId: string; orderNumber: number; orderStatus: string; reasons: string[] }) => void }) {
  const [f, setF] = useState({ paymentMethod: quote.paymentMethod ?? '', installments: '1', firstDueDate: '', confirm: true });
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function go() {
    setError('');
    if (!f.paymentMethod) { setError('Escolha a forma de pagamento.'); return; }
    if (f.paymentMethod === 'BOLETO' && !f.firstDueDate) { setError('Boleto: informe o vencimento da primeira parcela.'); return; }
    setBusy(true);
    try { onDone(await api(`/quotes/${quote.id}/convert`, 'POST', { paymentMethod: f.paymentMethod, confirm: f.confirm, ...(f.paymentMethod === 'BOLETO' ? { installments: Number(f.installments) || 1, firstDueDate: f.firstDueDate } : {}) })); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }
  return (
    <Dialog title={`Converter orçamento #${quote.number} em pedido`} description={`Os mesmos itens e preços (${brl(quote.total)}) viram um pedido.`} onClose={onClose}>
      <div className="modal-body">
        {error && <Alert kind="error">{error}</Alert>}
        <div className="form-grid">
          <div><label htmlFor="cv-p">Forma de pagamento *</label><select id="cv-p" value={f.paymentMethod} onChange={(e) => setF({ ...f, paymentMethod: e.target.value })}><option value="">Selecione…</option>{Object.entries(PAYMENT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
          {f.paymentMethod === 'BOLETO' && <>
            <div><label htmlFor="cv-n">Parcelas</label><select id="cv-n" value={f.installments} onChange={(e) => setF({ ...f, installments: e.target.value })}>{Array.from({ length: 12 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}x</option>)}</select></div>
            <div><label htmlFor="cv-d">Vencimento da 1ª parcela *</label><input id="cv-d" type="date" min={new Date().toISOString().slice(0, 10)} value={f.firstDueDate} onChange={(e) => setF({ ...f, firstDueDate: e.target.value })} /></div>
          </>}
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}><input type="checkbox" checked={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.checked })} style={{ width: 'auto' }} />Confirmar o pedido agora (reserva o estoque)</label>
        <p className="muted" style={{ fontSize: '0.82rem' }}>Se o estoque faltar, o limite de crédito estourar ou o desconto passar da política, o pedido segue para aprovação ou fica como rascunho, com o motivo.</p>
      </div>
      <div className="modal-foot"><button className="btn" onClick={onClose}>Cancelar</button><button className={`btn primary ${busy ? 'loading' : ''}`} disabled={busy} onClick={go}>Criar pedido</button></div>
    </Dialog>
  );
}
