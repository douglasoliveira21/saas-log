'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { brl, dateBr, ORDER_STATUS } from '@/lib/format';
import { useSession } from '@/lib/session';

interface OrderRow { id: string; number: number; status: string; channel: string; total: string; createdAt: string; customer: { name: string }; salesperson: { name: string } | null }
interface Detail extends OrderRow {
  customerId: string; warehouseId: string; notes?: string | null; subtotal: string; discountTotal: string; shipping: string; approvalReason: string | null; cancelReason: string | null; warehouse: { code: string };
  items: { id: string; productId: string; quantity: number; unitPrice: string; discountPct: string; total: string; returnedQty: number; product: { sku: string; name: string } }[];
}
interface Product { id: string; sku: string; name: string; suggestedPrice: string | null }
interface Customer { id: string; name: string }
interface Warehouse { id: string; code: string; name: string; active: boolean }
interface Line { productId: string; quantity: string; unitPrice: string; discountPct: string }

const CHANNELS: [string, string][] = [['DIRECT', 'Atendimento comercial'], ['WHATSAPP', 'WhatsApp'], ['PHONE', 'Telefone'], ['EMAIL', 'E-mail'], ['STORE', 'Loja física'], ['WEB', 'Loja virtual'], ['REPRESENTATIVE', 'Representante']];
const NEXT: Record<string, [string, string]> = { CONFIRMED: ['PICKING', 'Iniciar separação'], PICKING: ['PACKED', 'Marcar embalado'], PACKED: ['SHIPPED', 'Expedir (baixa estoque)'], SHIPPED: ['DELIVERED', 'Confirmar entrega'], DELIVERED: ['CLOSED', 'Encerrar'] };
const num = (v: string) => (v.trim() === '' ? undefined : Number(v.replace(',', '.')));

export default function VendasPage() {
  const { can } = useSession();
  const [rows, setRows] = useState<OrderRow[] | null>(null);
  const [status, setStatus] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [form, setForm] = useState<{ id?: string } | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [whs, setWhs] = useState<Warehouse[]>([]);
  const [lines, setLines] = useState<Line[]>([{ productId: '', quantity: '1', unitPrice: '', discountPct: '' }]);
  const [meta, setMeta] = useState({ customerId: '', warehouseId: '', channel: 'DIRECT', shipping: '', notes: '' });

  const load = useCallback(() => {
    api<{ items: OrderRow[] }>(`/sales/orders?limit=100${status ? `&status=${status}` : ''}`).then((r) => setRows(r.items)).catch((e) => setError(e.message));
  }, [status]);
  useEffect(load, [load]);
  useEffect(() => {
    api<{ items: Product[] }>('/products?limit=200').then((r) => setProducts(r.items)).catch(() => undefined);
    api<Customer[]>('/customers').then(setCustomers).catch(() => undefined);
    api<{ establishments: { warehouses: Warehouse[] }[] }[]>('/structure').then((t) => setWhs(t.flatMap((c) => c.establishments.flatMap((e) => e.warehouses)).filter((w) => w.active))).catch(() => undefined);
  }, []);

  const open = useCallback(async (id: string) => { setError(''); try { setDetail(await api<Detail>(`/sales/orders/${id}`)); } catch (e) { setError((e as Error).message); } }, []);

  const act = async (fn: () => Promise<unknown>, message: string) => {
    setError(''); setOk('');
    try { await fn(); setOk(message); load(); if (detail) await open(detail.id); } catch (e) { setError((e as Error).message); }
  };

  function startForm(d?: Detail) {
    setForm({ id: d?.id });
    setMeta(d ? { customerId: d.customerId, warehouseId: d.warehouseId, channel: d.channel, shipping: String(Number(d.shipping) || ''), notes: d.notes ?? '' } : { customerId: customers[0]?.id ?? '', warehouseId: whs[0]?.id ?? '', channel: 'DIRECT', shipping: '', notes: '' });
    setLines(d ? d.items.map((i) => ({ productId: i.productId, quantity: String(i.quantity), unitPrice: i.unitPrice, discountPct: String(Number(i.discountPct) || '') })) : [{ productId: '', quantity: '1', unitPrice: '', discountPct: '' }]);
  }

  async function save() {
    setError(''); setOk('');
    const body = {
      ...meta, shipping: num(meta.shipping) ?? 0, notes: meta.notes || undefined,
      items: lines.filter((l) => l.productId).map((l) => ({ productId: l.productId, quantity: Number(l.quantity), unitPrice: num(l.unitPrice), discountPct: num(l.discountPct) })),
    };
    try {
      const r = form?.id ? await api<{ id: string }>(`/sales/orders/${form.id}`, 'PUT', body) : await api<{ id: string }>('/sales/orders', 'POST', body);
      setForm(null); setOk('Pedido salvo como rascunho.'); load(); await open(r.id);
    } catch (e) { setError((e as Error).message); }
  }

  const setLine = (i: number, patch: Partial<Line>) => setLines(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));

  async function doReturn(d: Detail) {
    const reason = window.prompt('Motivo da devolução:');
    if (!reason) return;
    const items = d.items.map((i) => ({ i, q: Number(window.prompt(`${i.product.sku} — devolver quantas unidades? (vendido ${i.quantity}, já devolvido ${i.returnedQty})`, '0') ?? 0) })).filter((x) => x.q > 0);
    if (!items.length) return;
    const restock = window.confirm('Repor as unidades no estoque? (OK = sim, Cancelar = avariado/descartado)');
    await act(() => api(`/sales/orders/${d.id}/returns`, 'POST', { reason, restock, items: items.map((x) => ({ orderItemId: x.i.id, quantity: x.q })) }), 'Devolução registrada.');
  }

  const cancel = async (d: Detail) => {
    const reason = window.prompt('Motivo do cancelamento:');
    if (reason) await act(() => api(`/sales/orders/${d.id}/cancel`, 'POST', { reason }), 'Pedido cancelado.');
  };

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div><h1>Vendas e pedidos</h1><p className="muted">Confirmar reserva o estoque; expedir baixa o físico. Pagamento e faturamento chegam com Financeiro e Fiscal.</p></div>
        {can('sales.create') && <button className="btn primary" onClick={() => startForm()} disabled={!customers.length || !whs.length}>+ Pedido</button>}
      </div>
      {error && <div className="alert error" role="alert">{error}</div>}
      {ok && <div className="alert ok" role="status">{ok}</div>}
      {!customers.length && can('sales.create') && <div className="alert">Cadastre ao menos um cliente em “Clientes” para criar pedidos.</div>}

      {form && (
        <section className="card" style={{ marginBottom: 16 }}>
          <h2>{form.id ? 'Editar rascunho' : 'Novo pedido'}</h2>
          <div className="form-grid">
            <div><label htmlFor="c">Cliente *</label><select id="c" value={meta.customerId} onChange={(e) => setMeta({ ...meta, customerId: e.target.value })}><option value="">Selecione…</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            <div><label htmlFor="w">Depósito de saída *</label><select id="w" value={meta.warehouseId} onChange={(e) => setMeta({ ...meta, warehouseId: e.target.value })}><option value="">Selecione…</option>{whs.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select></div>
            <div><label htmlFor="ch">Origem</label><select id="ch" value={meta.channel} onChange={(e) => setMeta({ ...meta, channel: e.target.value })}>{CHANNELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            <div><label htmlFor="sh">Frete (R$)</label><input id="sh" inputMode="decimal" value={meta.shipping} onChange={(e) => setMeta({ ...meta, shipping: e.target.value })} /></div>
          </div>
          <h2 style={{ marginTop: 16 }}>Itens</h2>
          {lines.map((l, i) => (
            <div className="row" key={i} style={{ marginBottom: 8 }}>
              <select aria-label="Produto" value={l.productId} style={{ flex: '2 1 240px', width: 'auto' }} onChange={(e) => { const p = products.find((x) => x.id === e.target.value); setLine(i, { productId: e.target.value, unitPrice: p?.suggestedPrice ?? l.unitPrice }); }}>
                <option value="">Produto…</option>{products.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}
              </select>
              <input aria-label="Quantidade" inputMode="numeric" placeholder="Qtd." value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} style={{ width: 80 }} />
              <input aria-label="Preço unitário" inputMode="decimal" placeholder="Preço" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} style={{ width: 110 }} />
              <input aria-label="Desconto %" inputMode="decimal" placeholder="Desc. %" value={l.discountPct} onChange={(e) => setLine(i, { discountPct: e.target.value })} style={{ width: 90 }} />
              {lines.length > 1 && <button type="button" className="btn sm" onClick={() => setLines(lines.filter((_, k) => k !== i))}>Remover</button>}
            </div>
          ))}
          <div className="row"><button type="button" className="btn sm" onClick={() => setLines([...lines, { productId: '', quantity: '1', unitPrice: '', discountPct: '' }])}>+ item</button></div>
          <div className="row" style={{ marginTop: 12 }}><button className="btn primary" onClick={save}>Salvar rascunho</button><button className="btn" onClick={() => setForm(null)}>Cancelar</button></div>
        </section>
      )}

      <section className="card" style={{ marginBottom: 16 }}>
        <select aria-label="Filtrar por situação" value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 240, marginBottom: 12 }}>
          <option value="">Todas as situações</option>{Object.entries(ORDER_STATUS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Nº</th><th>Cliente</th><th>Vendedor</th><th>Situação</th><th>Total</th><th>Data</th><th /></tr></thead>
            <tbody>
              {!rows && !error && <tr><td colSpan={7} className="muted">Carregando…</td></tr>}
              {rows?.length === 0 && <tr><td colSpan={7} className="empty">Nenhum pedido encontrado.</td></tr>}
              {rows?.map((o) => (
                <tr key={o.id}><td>{o.number}</td><td>{o.customer.name}</td><td>{o.salesperson?.name ?? '—'}</td><td><span className="badge">{ORDER_STATUS[o.status]}</span></td><td>{brl(o.total)}</td><td>{dateBr(o.createdAt)}</td><td><button className="btn sm" onClick={() => open(o.id)}>Abrir</button></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {detail && (
        <section className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2>Pedido {detail.number} <span className="badge">{ORDER_STATUS[detail.status]}</span></h2>
            <div className="row">
              {detail.status === 'DRAFT' && can('sales.create') && <>
                <button className="btn" onClick={() => startForm(detail)}>Editar</button>
                <button className="btn primary" onClick={() => act(async () => { const r = await api<{ status: string; reasons: string[] }>(`/sales/orders/${detail.id}/submit`, 'POST'); if (r.status === 'PENDING_APPROVAL') throw new Error(`Enviado para aprovação: ${r.reasons.join('; ')}`); }, 'Pedido confirmado e estoque reservado.')}>Confirmar pedido</button>
              </>}
              {detail.status === 'PENDING_APPROVAL' && can('sales.approve') && <>
                <button className="btn primary" onClick={() => act(() => api(`/sales/orders/${detail.id}/approve`, 'POST'), 'Pedido aprovado e confirmado.')}>Aprovar</button>
                <button className="btn" onClick={() => { const r = window.prompt('Motivo da rejeição:'); if (r) void act(() => api(`/sales/orders/${detail.id}/reject`, 'POST', { reason: r }), 'Pedido devolvido a rascunho.'); }}>Rejeitar</button>
              </>}
              {NEXT[detail.status] && can('sales.fulfill') && <button className="btn primary" onClick={() => act(() => api(`/sales/orders/${detail.id}/advance`, 'POST', { to: NEXT[detail.status][0] }), 'Situação atualizada.')}>{NEXT[detail.status][1]}</button>}
              {['DRAFT', 'PENDING_APPROVAL', 'CONFIRMED', 'PICKING', 'PACKED'].includes(detail.status) && can('sales.create') && <button className="btn" onClick={() => cancel(detail)}>Cancelar</button>}
              {['SHIPPED', 'DELIVERED', 'CLOSED'].includes(detail.status) && can('sales.return') && <button className="btn" onClick={() => doReturn(detail)}>Registrar devolução</button>}
            </div>
          </div>
          <p className="muted">{detail.customer.name} · depósito {detail.warehouse.code} · vendedor {detail.salesperson?.name ?? '—'}</p>
          {detail.approvalReason && <div className="alert">{detail.approvalReason}</div>}
          {detail.cancelReason && <div className="alert error">Cancelado: {detail.cancelReason}</div>}
          <div className="table-wrap">
            <table>
              <thead><tr><th>Produto</th><th>Qtd.</th><th>Preço</th><th>Desc.</th><th>Total</th><th>Devolvido</th></tr></thead>
              <tbody>{detail.items.map((i) => <tr key={i.id}><td>{i.product.sku} — {i.product.name}</td><td>{i.quantity}</td><td>{brl(i.unitPrice)}</td><td>{Number(i.discountPct)}%</td><td>{brl(i.total)}</td><td>{i.returnedQty}</td></tr>)}</tbody>
            </table>
          </div>
          <p style={{ textAlign: 'right', marginBottom: 0 }}>Subtotal {brl(detail.subtotal)} · Descontos {brl(detail.discountTotal)} · Frete {brl(detail.shipping)} · <strong>Total {brl(detail.total)}</strong></p>
        </section>
      )}
    </>
  );
}
