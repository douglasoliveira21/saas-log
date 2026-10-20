'use client';

import { Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { brl, dateBr, PURCHASE_STATUS } from '@/lib/format';
import { useUi, PageHeader, Alert, Skeleton } from '@/components/ui';
import { useSession } from '@/lib/session';

interface Row { id: string; number: number; status: string; total: string; expectedDate: string | null; createdAt: string; supplier: { legalName: string }; warehouse: { code: string } }
interface Detail extends Row {
  freight: string; notes: string | null; supplierId: string; warehouseId: string;
  items: { id: string; productId: string; qtyOrdered: number; qtyReceived: number; unitCost: string; product: { sku: string; name: string } }[];
  receipts: { id: string; status: string; createdAt: string; note: string | null; items: { quantity: number; unitCost: string; product: { sku: string } }[] }[];
}
interface Product { id: string; sku: string; name: string; costPrice: string | null }
interface Supplier { id: string; legalName: string; active: boolean }
interface Suggestion { productId: string; sku: string; name: string; supplier: string | null; available: number; onOrder: number; suggestedQty: number; reason: string }
interface Line { productId: string; quantity: string; unitCost: string }

const num = (v: string) => Number(v.replace(',', '.'));

export default function ComprasPage() {
  const { can } = useSession();
  const ui = useUi();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [sugs, setSugs] = useState<Suggestion[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [whs, setWhs] = useState<{ id: string; code: string; name: string; active: boolean }[]>([]);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [form, setForm] = useState<{ id?: string } | null>(null);
  const [meta, setMeta] = useState({ supplierId: '', warehouseId: '', freight: '', expectedDate: '' });
  const [lines, setLines] = useState<Line[]>([{ productId: '', quantity: '1', unitCost: '' }]);
  const [recv, setRecv] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    api<{ items: Row[] }>('/purchases?limit=100').then((r) => setRows(r.items)).catch((e) => setError(e.message));
    api<Suggestion[]>('/purchases/suggestions').then(setSugs).catch(() => undefined);
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    api<{ items: Product[] }>('/products?limit=200').then((r) => setProducts(r.items)).catch(() => undefined);
    api<Supplier[]>('/suppliers').then((s) => setSuppliers(s.filter((x) => x.active))).catch(() => undefined);
    api<{ establishments: { warehouses: { id: string; code: string; name: string; active: boolean }[] }[] }[]>('/structure').then((t) => setWhs(t.flatMap((c) => c.establishments.flatMap((e) => e.warehouses)).filter((w) => w.active))).catch(() => undefined);
  }, []);

  const open = useCallback(async (id: string) => { setError(''); setRecv({}); try { setDetail(await api<Detail>(`/purchases/${id}`)); } catch (e) { setError((e as Error).message); } }, []);
  const act = async (fn: () => Promise<unknown>, message: string) => {
    setError(''); setOk('');
    try { await fn(); setOk(message); load(); if (detail) await open(detail.id); } catch (e) { setError((e as Error).message); }
  };
  const ask = async (q: string, fn: (reason: string) => Promise<unknown>, message: string) => { const r = await ui.prompt({ title: q.replace(/:$/, ''), label: 'Motivo', multiline: true, confirmLabel: 'Confirmar' }); if (r) void act(() => fn(r), message); };

  function startForm(d?: Detail, product?: Suggestion) {
    setForm({ id: d?.id });
    setMeta(d ? { supplierId: d.supplierId, warehouseId: d.warehouseId, freight: String(Number(d.freight) || ''), expectedDate: d.expectedDate?.slice(0, 10) ?? '' } : { supplierId: suppliers[0]?.id ?? '', warehouseId: whs[0]?.id ?? '', freight: '', expectedDate: '' });
    setLines(d ? d.items.map((i) => ({ productId: i.productId, quantity: String(i.qtyOrdered), unitCost: i.unitCost })) : product ? [{ productId: product.productId, quantity: String(product.suggestedQty), unitCost: products.find((p) => p.id === product.productId)?.costPrice ?? '' }] : [{ productId: '', quantity: '1', unitCost: '' }]);
  }

  async function save() {
    setError(''); setOk('');
    const body = {
      supplierId: meta.supplierId, warehouseId: meta.warehouseId, freight: meta.freight ? num(meta.freight) : 0, expectedDate: meta.expectedDate || undefined,
      items: lines.filter((l) => l.productId).map((l) => ({ productId: l.productId, quantity: Number(l.quantity), unitCost: num(l.unitCost || '0') })),
    };
    try {
      const r = form?.id ? await api<{ id: string }>(`/purchases/${form.id}`, 'PUT', body) : await api<{ id: string }>('/purchases', 'POST', body);
      setForm(null); setOk('Ordem salva como rascunho.'); load(); await open(r.id);
    } catch (e) { setError((e as Error).message); }
  }

  const receive = () => detail && act(() => api(`/purchases/${detail.id}/receipts`, 'POST', {
    idempotencyKey: crypto.randomUUID(),
    items: Object.entries(recv).filter(([, v]) => Number(v) > 0).map(([productId, v]) => ({ productId, quantity: Number(v) })),
  }), 'Recebimento registrado e estoque atualizado.');

  const setLine = (i: number, patch: Partial<Line>) => setLines(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));

  return (
    <>
      <PageHeader title="Compras" description={<>Ordens até o limite configurado são aprovadas na hora; acima dele, aguardam alçada. A conferência com o XML da nota está em Fiscal e as contas a pagar, em Financeiro.</>} actions={<>
          {can('purchases.create') && <button className="btn primary" onClick={() => startForm()} disabled={!suppliers.length || !whs.length}><Plus aria-hidden />Ordem de compra</button>}
        </>} />
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}
      {!suppliers.length && can('purchases.create') && <div className="alert">Cadastre um fornecedor para criar ordens de compra.</div>}

      {sugs.length > 0 && (
        <section className="card" style={{ marginBottom: 16 }}>
          <h2>Sugestões de reposição ({sugs.length})</h2>
          <div className="table-wrap"><table>
            <thead><tr><th>Produto</th><th>Disponível</th><th>Em compra</th><th>Sugerido</th><th>Justificativa</th><th /></tr></thead>
            <tbody>{sugs.map((s) => (
              <tr key={s.productId}><td>{s.sku} — {s.name}{s.supplier && <span className="muted"> · {s.supplier}</span>}</td><td>{s.available}</td><td>{s.onOrder}</td><td><strong>{s.suggestedQty}</strong></td><td className="muted">{s.reason}</td>
                <td>{can('purchases.create') && <button className="btn sm" onClick={() => startForm(undefined, s)}>Criar ordem</button>}</td></tr>
            ))}</tbody>
          </table></div>
          <p className="muted" style={{ marginBottom: 0 }}>Nada é comprado automaticamente: cada ordem exige a sua revisão e as aprovações da empresa.</p>
        </section>
      )}

      {form && (
        <section className="card" style={{ marginBottom: 16 }}>
          <h2>{form.id ? 'Editar rascunho' : 'Nova ordem de compra'}</h2>
          <div className="form-grid">
            <div><label htmlFor="s">Fornecedor *</label><select id="s" value={meta.supplierId} onChange={(e) => setMeta({ ...meta, supplierId: e.target.value })}><option value="">Selecione…</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.legalName}</option>)}</select></div>
            <div><label htmlFor="w">Depósito de entrada *</label><select id="w" value={meta.warehouseId} onChange={(e) => setMeta({ ...meta, warehouseId: e.target.value })}><option value="">Selecione…</option>{whs.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select></div>
            <div><label htmlFor="f">Frete (R$)</label><input id="f" inputMode="decimal" value={meta.freight} onChange={(e) => setMeta({ ...meta, freight: e.target.value })} /></div>
            <div><label htmlFor="d">Entrega prevista</label><input id="d" type="date" value={meta.expectedDate} onChange={(e) => setMeta({ ...meta, expectedDate: e.target.value })} /></div>
          </div>
          <h2 style={{ marginTop: 16 }}>Itens</h2>
          {lines.map((l, i) => (
            <div className="row" key={i} style={{ marginBottom: 8 }}>
              <select aria-label="Produto" value={l.productId} style={{ flex: '2 1 240px', width: 'auto' }} onChange={(e) => setLine(i, { productId: e.target.value, unitCost: products.find((p) => p.id === e.target.value)?.costPrice ?? l.unitCost })}>
                <option value="">Produto…</option>{products.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}
              </select>
              <input aria-label="Quantidade" inputMode="numeric" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} style={{ width: 90 }} />
              <input aria-label="Custo unitário" inputMode="decimal" placeholder="Custo un." value={l.unitCost} onChange={(e) => setLine(i, { unitCost: e.target.value })} style={{ width: 120 }} />
              {lines.length > 1 && <button type="button" className="btn sm" onClick={() => setLines(lines.filter((_, k) => k !== i))}>Remover</button>}
            </div>
          ))}
          <button type="button" className="btn sm" onClick={() => setLines([...lines, { productId: '', quantity: '1', unitCost: '' }])}><Plus aria-hidden />item</button>
          <div className="row" style={{ marginTop: 12 }}><button className="btn primary" onClick={save}>Salvar rascunho</button><button className="btn" onClick={() => setForm(null)}>Cancelar</button></div>
        </section>
      )}

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="table-wrap"><table>
          <thead><tr><th>Nº</th><th>Fornecedor</th><th>Depósito</th><th>Situação</th><th>Total</th><th>Previsão</th><th /></tr></thead>
          <tbody>
            {!rows && !error && <tr><td colSpan={7}><Skeleton rows={3} /></td></tr>}
            {rows?.length === 0 && <tr><td colSpan={7} className="empty">Nenhuma ordem de compra ainda.</td></tr>}
            {rows?.map((o) => <tr key={o.id}><td>{o.number}</td><td>{o.supplier.legalName}</td><td>{o.warehouse.code}</td><td><span className="badge">{PURCHASE_STATUS[o.status]}</span></td><td className="num">{brl(o.total)}</td><td>{dateBr(o.expectedDate)}</td><td><button className="btn sm" onClick={() => open(o.id)}>Abrir</button></td></tr>)}
          </tbody>
        </table></div>
      </section>

      {detail && (
        <section className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2>OC {detail.number} <span className="badge">{PURCHASE_STATUS[detail.status]}</span></h2>
            <div className="row">
              {detail.status === 'DRAFT' && can('purchases.create') && <>
                <button className="btn" onClick={() => startForm(detail)}>Editar</button>
                <button className="btn primary" onClick={() => act(() => api(`/purchases/${detail.id}/submit`, 'POST'), 'Ordem enviada.')}>Enviar / solicitar aprovação</button>
              </>}
              {detail.status === 'PENDING_APPROVAL' && can('purchases.approve') && <>
                <button className="btn primary" onClick={() => act(() => api(`/purchases/${detail.id}/approve`, 'POST'), 'Ordem aprovada.')}>Aprovar</button>
                <button className="btn" onClick={() => ask('Motivo da rejeição:', (reason) => api(`/purchases/${detail.id}/reject`, 'POST', { reason }), 'Ordem devolvida a rascunho.')}>Rejeitar</button>
              </>}
              {['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(detail.status) && can('purchases.create') && <button className="btn" onClick={() => ask('Motivo do cancelamento:', (reason) => api(`/purchases/${detail.id}/cancel`, 'POST', { reason }), 'Ordem cancelada.')}>Cancelar</button>}
              {detail.status === 'PARTIALLY_RECEIVED' && can('purchases.receive') && <button className="btn" onClick={() => ask('Motivo para encerrar com saldo pendente:', (reason) => api(`/purchases/${detail.id}/close`, 'POST', { reason }), 'Ordem encerrada com pendência registrada.')}>Encerrar com pendência</button>}
            </div>
          </div>
          <p className="muted">{detail.supplier.legalName} · entrada em {detail.warehouse.code} · frete {brl(detail.freight)} · <strong>total {brl(detail.total)}</strong></p>
          <div className="table-wrap"><table>
            <thead><tr><th>Produto</th><th>Pedido</th><th>Recebido</th><th>Custo un.</th>{['APPROVED', 'PARTIALLY_RECEIVED'].includes(detail.status) && can('purchases.receive') && <th>Receber agora</th>}</tr></thead>
            <tbody>{detail.items.map((i) => (
              <tr key={i.id}><td>{i.product.sku} — {i.product.name}</td><td>{i.qtyOrdered}</td><td>{i.qtyReceived}</td><td className="num">{brl(i.unitCost)}</td>
                {['APPROVED', 'PARTIALLY_RECEIVED'].includes(detail.status) && can('purchases.receive') && <td><input type="number" min={0} max={i.qtyOrdered - i.qtyReceived} aria-label={`Receber ${i.product.sku}`} style={{ width: 90 }} value={recv[i.productId] ?? ''} onChange={(e) => setRecv({ ...recv, [i.productId]: e.target.value })} /></td>}
              </tr>
            ))}</tbody>
          </table></div>
          {['APPROVED', 'PARTIALLY_RECEIVED'].includes(detail.status) && can('purchases.receive') && <p><button className="btn primary" onClick={receive} disabled={!Object.values(recv).some((v) => Number(v) > 0)}>Registrar recebimento</button></p>}
          {detail.receipts.length > 0 && <>
            <h2>Recebimentos</h2>
            <ul>{detail.receipts.map((r) => (
              <li key={r.id}>{new Date(r.createdAt).toLocaleString('pt-BR')} — {r.items.map((i) => `${i.product.sku}: ${i.quantity}`).join(', ')} <span className={`badge ${r.status === 'POSTED' ? 'ok' : 'warn'}`}>{r.status === 'POSTED' ? 'lançado' : 'estornado'}</span>{' '}
                {r.status === 'POSTED' && can('purchases.receive') && <button className="btn sm" onClick={() => ask('Motivo do estorno:', (reason) => api(`/purchases/receipts/${r.id}/reverse`, 'POST', { reason }), 'Recebimento estornado.')}>Estornar</button>}</li>
            ))}</ul>
          </>}
        </section>
      )}
    </>
  );
}
