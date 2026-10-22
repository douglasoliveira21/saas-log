'use client';

import { Plus, Search, ShoppingCart, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { brl, dateBr, ORDER_STATUS } from '@/lib/format';
import { useUi, PageHeader, Alert, Skeleton, EmptyState, Dialog } from '@/components/ui';
import { boletoPreview, FLOW, PAYMENT_LABEL, STATUS_INFO, SUMMARY_GROUPS } from '@/lib/order-flow';
import { useSession } from '@/lib/session';
import { PurchaseBadge, purchaseHint, type PurchaseInfo, type PurchaseType } from '@/components/purchase-badge';
import { FISCAL_LABEL, FiscalChoicePicker, FiscalPreviewDialog, type FiscalChoice } from './fiscal';

interface OrderRow { paymentMethod?: string | null; id: string; number: number; status: string; channel: string; total: string; createdAt: string; customerType?: PurchaseType | null; dispatchDate?: string | null; dispatchDeferred?: boolean; customer: { name: string }; salesperson: { name: string } | null }
interface Detail extends OrderRow {
  customerId: string; warehouseId: string; fiscalDocType: FiscalChoice; installmentCount: number; firstDueDate: string | null; installmentIntervalDays: number; installments: { id: string; installmentNo: number; installmentTotal: number; dueDate: string; amount: string; status: string }[]; notes?: string | null; subtotal: string; discountTotal: string; shipping: string; approvalReason: string | null; cancelReason: string | null; warehouse: { code: string };
  items: { id: string; productId: string; quantity: number; unitPrice: string; discountPct: string; total: string; returnedQty: number; product: { sku: string; name: string } }[];
}
interface Product { id: string; sku: string; name: string; suggestedPrice: string | null }
interface Customer { id: string; name: string; kind?: string; document?: string | null }
interface Warehouse { id: string; code: string; name: string; active: boolean }
interface Line { productId: string; quantity: string; unitPrice: string; discountPct: string }

const CHANNELS: [string, string][] = [['DIRECT', 'Atendimento comercial'], ['WHATSAPP', 'WhatsApp'], ['PHONE', 'Telefone'], ['EMAIL', 'E-mail'], ['STORE', 'Loja física'], ['WEB', 'Loja virtual'], ['REPRESENTATIVE', 'Representante']];
const NEXT: Record<string, [string, string]> = { CONFIRMED: ['PICKING', 'Iniciar separação'], PICKING: ['PACKED', 'Marcar embalado'], PACKED: ['SHIPPED', 'Expedir (baixa estoque)'], SHIPPED: ['DELIVERED', 'Confirmar entrega'], DELIVERED: ['CLOSED', 'Encerrar'] };
const suggestFiscal = (c?: Customer): FiscalChoice | undefined => (c?.document ? (c.document.replace(/\D/g, '').length === 14 ? 'NFE' : 'NFCE') : undefined);
const num = (v: string) => (v.trim() === '' ? undefined : Number(v.replace(',', '.')));

export default function VendasPage() {
  const { can } = useSession();
  const ui = useUi();
  const [rows, setRows] = useState<OrderRow[] | null>(null);
  const [status, setStatus] = useState('');
  const [group, setGroup] = useState('');
  const [q, setQ] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [form, setForm] = useState<{ id?: string } | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [whs, setWhs] = useState<Warehouse[]>([]);
  const [lines, setLines] = useState<Line[]>([{ productId: '', quantity: '1', unitPrice: '', discountPct: '' }]);
  const [meta, setMeta] = useState({ customerId: '', warehouseId: '', channel: 'DIRECT', shipping: '', notes: '', fiscalDocType: 'NONE' as FiscalChoice, paymentMethod: '', installments: '1', firstDueDate: '', intervalDays: '30' });
  const [profile, setProfile] = useState<PurchaseInfo | null>(null);
  const [cutoff, setCutoff] = useState<{ enabled: boolean; cutoffTime: string | null; businessDaysOnly: boolean; dispatchDate: string | null; deferred: boolean } | null>(null);
  const [fiscalView, setFiscalView] = useState<{ id: string; docType: FiscalChoice } | null>(null);

  const load = useCallback(() => {
    api<{ items: OrderRow[] }>('/sales/orders?limit=100').then((r) => setRows(r.items)).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    api<{ items: Product[] }>('/products?limit=200').then((r) => setProducts(r.items)).catch(() => undefined);
    api<Customer[]>('/customers').then(setCustomers).catch(() => undefined);
    api<{ establishments: { warehouses: Warehouse[] }[] }[]>('/structure').then((t) => setWhs(t.flatMap((c) => c.establishments.flatMap((e) => e.warehouses)).filter((w) => w.active))).catch(() => undefined);
  }, []);

  useEffect(() => { api<NonNullable<typeof cutoff>>('/sales/cutoff').then(setCutoff).catch(() => undefined); }, []);
  useEffect(() => {
    setProfile(null);
    if (form && meta.customerId) api<PurchaseInfo>(`/customers/${meta.customerId}/purchase-profile`).then(setProfile).catch(() => undefined);
  }, [form, meta.customerId]);

  const open = useCallback(async (id: string) => { setError(''); try { setDetail(await api<Detail>(`/sales/orders/${id}`)); } catch (e) { setError((e as Error).message); } }, []);

  const act = async (fn: () => Promise<unknown>, message: string) => {
    setError(''); setOk('');
    try { await fn(); setOk(message); load(); if (detail) await open(detail.id); } catch (e) { setError((e as Error).message); }
  };

  function startForm(d?: Detail) {
    setForm({ id: d?.id });
    setMeta(d ? { customerId: d.customerId, warehouseId: d.warehouseId, channel: d.channel, shipping: String(Number(d.shipping) || ''), notes: d.notes ?? '', fiscalDocType: d.fiscalDocType ?? 'NONE', paymentMethod: d.paymentMethod ?? '', installments: String(d.installmentCount ?? 1), firstDueDate: d.firstDueDate?.slice(0, 10) ?? '', intervalDays: String(d.installmentIntervalDays ?? 30) } : { customerId: customers[0]?.id ?? '', warehouseId: whs[0]?.id ?? '', channel: 'DIRECT', shipping: '', notes: '', fiscalDocType: 'NONE', paymentMethod: '', installments: '1', firstDueDate: '', intervalDays: '30' });
    setLines(d ? d.items.map((i) => ({ productId: i.productId, quantity: String(i.quantity), unitPrice: i.unitPrice, discountPct: String(Number(i.discountPct) || '') })) : [{ productId: '', quantity: '1', unitPrice: '', discountPct: '' }]);
  }

  async function save() {
    setError(''); setOk('');
    if (!meta.paymentMethod) { setError('Escolha a forma de pagamento (passo 3).'); return; }
    if (meta.paymentMethod === 'BOLETO' && !meta.firstDueDate) { setError('Boleto: informe a data de vencimento da primeira parcela.'); return; }
    const { installments, firstDueDate, intervalDays, ...rest } = meta;
    const body = {
      ...rest, ...(meta.paymentMethod === 'BOLETO' ? { installments: Number(installments) || 1, firstDueDate, intervalDays: Number(intervalDays) || 30 } : {}), shipping: num(meta.shipping) ?? 0, notes: meta.notes || undefined,
      items: lines.filter((l) => l.productId).map((l) => ({ productId: l.productId, quantity: Number(l.quantity), unitPrice: num(l.unitPrice), discountPct: num(l.discountPct) })),
    };
    try {
      const r = form?.id ? await api<{ id: string }>(`/sales/orders/${form.id}`, 'PUT', body) : await api<{ id: string }>('/sales/orders', 'POST', body);
      setForm(null); setOk('Pedido salvo como rascunho.'); load(); await open(r.id);
    } catch (e) { setError((e as Error).message); }
  }

  const setLine = (i: number, patch: Partial<Line>) => setLines(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));

  async function doReturn(d: Detail) {
    const res = await ui.form({
      title: 'Registrar devolução', message: 'Informe quantas unidades de cada item voltaram.', confirmLabel: 'Registrar devolução',
      fields: [
        { name: 'reason', label: 'Motivo da devolução', type: 'textarea', required: true },
        ...d.items.map((i) => ({ name: `q_${i.id}`, label: `${i.product.sku} — vendido ${i.quantity}, já devolvido ${i.returnedQty}`, type: 'number' as const, defaultValue: 0, min: 0, max: i.quantity - i.returnedQty })),
        { name: 'restock', label: 'Destino das unidades', type: 'select' as const, defaultValue: 'yes', options: [{ value: 'yes', label: 'Repor no estoque' }, { value: 'no', label: 'Avariado/descartado (não repor)' }] },
      ],
    });
    if (!res) return;
    const reason = res.reason;
    const items = d.items.map((i) => ({ i, q: Number(res[`q_${i.id}`] || 0) })).filter((x) => x.q > 0);
    if (!items.length) { ui.toast.info('Nenhuma quantidade informada.'); return; }
    const restock = res.restock === 'yes';
    await act(() => api(`/sales/orders/${d.id}/returns`, 'POST', { reason, restock, items: items.map((x) => ({ orderItemId: x.i.id, quantity: x.q })) }), 'Devolução registrada.');
  }

  const cancel = async (d: Detail) => {
    const reason = await ui.prompt({ title: 'Cancelar pedido', message: 'As reservas de estoque serão liberadas e as comissões estornadas.', label: 'Motivo do cancelamento', danger: true, confirmLabel: 'Cancelar pedido', cancelLabel: 'Voltar' });
    if (reason) await act(() => api(`/sales/orders/${d.id}/cancel`, 'POST', { reason }), 'Pedido cancelado.');
  };

  const counts = useMemo(() => Object.fromEntries(SUMMARY_GROUPS.map((g) => [g.key, (rows ?? []).filter((o) => g.statuses.includes(o.status)).length])), [rows]);
  const shown = useMemo(() => {
    const g = SUMMARY_GROUPS.find((x) => x.key === group);
    const term = q.trim().toLowerCase();
    return (rows ?? []).filter((o) => (!g || g.statuses.includes(o.status)) && (!status || o.status === status) && (!term || String(o.number).includes(term) || o.customer.name.toLowerCase().includes(term)));
  }, [rows, group, status, q]);
  const calc = useMemo(() => {
    const items = lines.map((l) => { const qty = Number(l.quantity) || 0; const price = num(l.unitPrice) ?? 0; const disc = num(l.discountPct) ?? 0; const gross = qty * price; return { gross, total: gross * (1 - disc / 100) }; });
    const sub = items.reduce((a, x) => a + x.gross, 0); const total = items.reduce((a, x) => a + x.total, 0);
    return { items, sub, disc: sub - total, total: total + (num(meta.shipping) ?? 0) };
  }, [lines, meta.shipping]);

  const plan = meta.paymentMethod === 'BOLETO' ? boletoPreview(Math.round(calc.total * 100), Math.max(1, Math.min(36, Number(meta.installments) || 1)), meta.firstDueDate, Math.max(1, Number(meta.intervalDays) || 30)) : [];

  return (
    <>
      <PageHeader title="Vendas e pedidos" description={<>Acompanhe cada pedido do rascunho até a entrega. <strong>Confirmar</strong> reserva o estoque; <strong>expedir</strong> baixa o físico. A cobrança vai para o Financeiro e a nota fica em Fiscal.</>} actions={<>
          {can('sales.create') && <button className="btn primary" onClick={() => startForm()} disabled={!customers.length || !whs.length}><Plus aria-hidden />Novo pedido</button>}
        </>} />
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}
      {can('sales.create') && (!customers.length || !whs.length) && <Alert kind="warn">Para criar pedidos é preciso ter ao menos {!customers.length ? 'um cliente em “Clientes”' : 'um depósito ativo em “Empresa”'}.</Alert>}

      {form && (
        <section className="card" style={{ marginBottom: 16 }} aria-label={form.id ? 'Editar rascunho' : 'Novo pedido'}>
          <div className="card-head"><h2>{form.id ? 'Editar rascunho' : 'Novo pedido'}</h2></div>
          <p className="muted" style={{ marginTop: 0 }}>O pedido é salvo como rascunho: nada é reservado no estoque até você confirmar.</p>

          <div className="form-sec"><span className="num-badge">1</span><div>
            <h3>Quem compra e de onde sai</h3>
            <p className="sub">Escolha o cliente e o depósito que vai separar os produtos.</p>
            <div className="form-grid">
              <div><label htmlFor="c">Cliente *</label><select id="c" value={meta.customerId} onChange={(e) => setMeta({ ...meta, customerId: e.target.value })}><option value="">Selecione…</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
              <div><label htmlFor="w">Depósito de saída *</label><select id="w" value={meta.warehouseId} onChange={(e) => setMeta({ ...meta, warehouseId: e.target.value })}><option value="">Selecione…</option>{whs.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select></div>
              <div><label htmlFor="ch">Como o pedido chegou</label><select id="ch" value={meta.channel} onChange={(e) => setMeta({ ...meta, channel: e.target.value })}>{CHANNELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            </div>
            {profile && <div className="alert info" role="status" style={{ marginTop: 12 }}><PurchaseBadge type={profile.type} daysSince={profile.daysSince} />&nbsp;{purchaseHint(profile)}</div>}
          </div></div>

          <div className="form-sec"><span className="num-badge">2</span><div>
            <h3>Produtos</h3>
            <p className="sub">Ao escolher o produto, o preço sugerido é preenchido. Você pode ajustar o preço e dar desconto em %.</p>
            <div className="line-grid head" aria-hidden><span>Produto</span><span>Qtd.</span><span>Preço (R$)</span><span>Desc. %</span><span style={{ textAlign: 'right' }}>Total</span><span /></div>
            {lines.map((l, i) => (
              <div className="line-grid" key={i}>
                <select aria-label="Produto" value={l.productId} onChange={(e) => { const p = products.find((x) => x.id === e.target.value); setLine(i, { productId: e.target.value, unitPrice: p?.suggestedPrice ?? l.unitPrice }); }}>
                  <option value="">Escolha o produto…</option>{products.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}
                </select>
                <input aria-label="Quantidade" inputMode="numeric" placeholder="Qtd." value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
                <input aria-label="Preço unitário" inputMode="decimal" placeholder="0,00" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} />
                <input aria-label="Desconto %" inputMode="decimal" placeholder="0" value={l.discountPct} onChange={(e) => setLine(i, { discountPct: e.target.value })} />
                <span className="tot">{brl(calc.items[i]?.total ?? 0)}</span>
                {lines.length > 1 ? <button type="button" className="btn sm" aria-label="Remover item" onClick={() => setLines(lines.filter((_, k) => k !== i))}><Trash2 aria-hidden /></button> : <span />}
              </div>
            ))}
            <button type="button" className="btn sm" onClick={() => setLines([...lines, { productId: '', quantity: '1', unitPrice: '', discountPct: '' }])}><Plus aria-hidden />Adicionar produto</button>
          </div></div>

          <div className="form-sec"><span className="num-badge">3</span><div>
            <h3>Forma de pagamento</h3>
            <p className="sub">Como o cliente vai pagar. No boleto, informe em quantas parcelas e o vencimento: as contas a receber são criadas quando o pedido for confirmado.</p>
            <div className="form-grid">
              <div><label htmlFor="pm">Forma de pagamento *</label><select id="pm" value={meta.paymentMethod} onChange={(e) => setMeta({ ...meta, paymentMethod: e.target.value })}><option value="">Selecione…</option>{Object.entries(PAYMENT_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
              {meta.paymentMethod === 'BOLETO' && <>
                <div><label htmlFor="pi">Parcelas *</label><select id="pi" value={meta.installments} onChange={(e) => setMeta({ ...meta, installments: e.target.value })}>{Array.from({ length: 36 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n === 1 ? '1x (à vista no boleto)' : `${n}x`}</option>)}</select></div>
                <div><label htmlFor="pd">Vencimento da 1ª parcela *</label><input id="pd" type="date" min={new Date().toISOString().slice(0, 10)} value={meta.firstDueDate} onChange={(e) => setMeta({ ...meta, firstDueDate: e.target.value })} /></div>
                {Number(meta.installments) > 1 && <div><label htmlFor="pv">Dias entre as parcelas</label><input id="pv" inputMode="numeric" value={meta.intervalDays} onChange={(e) => setMeta({ ...meta, intervalDays: e.target.value })} /></div>}
              </>}
            </div>
            {meta.paymentMethod === 'BOLETO' && (plan.length > 0
              ? <div className="table-wrap" style={{ marginTop: 12 }}><table><thead><tr><th>Parcela</th><th>Vencimento</th><th className="num">Valor</th></tr></thead><tbody>{plan.map((p, i) => <tr key={i}><td>{i + 1}/{plan.length}</td><td>{dateBr(p.due)}</td><td className="num">{brl(p.cents / 100)}</td></tr>)}</tbody></table></div>
              : <p className="muted" style={{ marginBottom: 0 }}>Informe o vencimento para ver as parcelas.</p>)}
          </div></div>

          <div className="form-sec"><span className="num-badge">4</span><div>
            <h3>Entrega e nota fiscal</h3>
            <p className="sub">Informe o frete, se houver, e se o cliente receberá NF-e ou NFC-e.</p>
            <div className="form-grid"><div><label htmlFor="sh">Frete (R$)</label><input id="sh" inputMode="decimal" placeholder="0,00" value={meta.shipping} onChange={(e) => setMeta({ ...meta, shipping: e.target.value })} /></div></div>
            {cutoff?.enabled && cutoff.dispatchDate && (
              <div className={`alert ${cutoff.deferred ? 'warn' : 'info'}`} role="status" style={{ marginTop: 12 }}>
                <div>Horário de corte das <strong>{cutoff.cutoffTime}</strong>{cutoff.businessDaysOnly ? ' (dias úteis)' : ''}: confirmado agora, este pedido {cutoff.deferred ? <>fica para <strong>{dateBr(cutoff.dispatchDate)}</strong> (passou do corte{cutoff.businessDaysOnly ? ' ou não é dia útil' : ''})</> : <>sai <strong>hoje</strong></>}. Pedidos de marketplace não seguem este corte.</div>
              </div>
            )}
            <FiscalChoicePicker value={meta.fiscalDocType} onChange={(v) => setMeta({ ...meta, fiscalDocType: v })} suggestion={suggestFiscal(customers.find((c) => c.id === meta.customerId))} />
          </div></div>

          <div className="totals-bar" aria-live="polite">
            <span>Produtos {brl(calc.sub)}</span><span>Descontos − {brl(calc.disc)}</span><span>Frete {brl(num(meta.shipping) ?? 0)}</span><span className="grand">Total {brl(calc.total)}</span>
          </div>
          <div className="row" style={{ marginTop: 12 }}><button className="btn primary" onClick={save}>Salvar rascunho</button><button className="btn" onClick={() => setForm(null)}>Cancelar</button></div>
        </section>
      )}

      <div className="sum-grid" role="group" aria-label="Resumo dos pedidos por situação">
        {SUMMARY_GROUPS.map((g) => (
          <button key={g.key} type="button" className={`sum ${g.tone} ${group === g.key ? 'active' : ''}`} aria-pressed={group === g.key} onClick={() => { setGroup(group === g.key ? '' : g.key); setStatus(''); }}>
            <span className="n">{rows ? counts[g.key] : '—'}</span><span className="l">{g.label}</span><span className="h">{g.hint}</span>
          </button>
        ))}
      </div>

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="toolbar">
          <div className="search"><Search aria-hidden /><input aria-label="Buscar pedido" placeholder="Buscar por nº ou cliente…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <select aria-label="Filtrar por situação" value={status} onChange={(e) => { setStatus(e.target.value); setGroup(''); }} style={{ maxWidth: 220 }}>
            <option value="">Todas as situações</option>{Object.entries(ORDER_STATUS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {(group || status || q) && <button className="btn sm" onClick={() => { setGroup(''); setStatus(''); setQ(''); }}>Limpar filtros</button>}
          <span className="muted" style={{ marginLeft: 'auto', fontSize: '0.82rem' }}>{rows ? `${shown.length} de ${rows.length} pedidos` : ''}</span>
        </div>
        {!rows && !error && <Skeleton rows={4} />}
        {rows && shown.length === 0 && (rows.length === 0
          ? <EmptyState icon={<ShoppingCart size={22} />} title="Você ainda não tem pedidos" action={can('sales.create') && customers.length > 0 && whs.length > 0 ? <button className="btn primary" onClick={() => startForm()}><Plus aria-hidden />Criar o primeiro pedido</button> : undefined}>Crie um pedido para reservar estoque, expedir e emitir a nota.</EmptyState>
          : <EmptyState title="Nenhum pedido com esses filtros">Tente limpar os filtros ou buscar por outro nome.</EmptyState>)}
        {rows && shown.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Nº</th><th>Cliente</th><th>Situação</th><th className="hide-sm">O que fazer agora</th><th className="num">Total</th><th>Data</th><th /></tr></thead>
              <tbody>
                {shown.map((o) => {
                  const info = STATUS_INFO[o.status];
                  return (
                    <tr key={o.id} style={detail?.id === o.id ? { background: 'var(--brand-soft)' } : undefined}>
                      <td><strong>#{o.number}</strong></td>
                      <td>{o.customer.name} <PurchaseBadge type={o.customerType} /><div className="muted" style={{ fontSize: '0.78rem' }}>{o.salesperson?.name ?? 'sem vendedor'}</div></td>
                      <td><span className={`badge dot ${info?.tone ?? ''}`}>{ORDER_STATUS[o.status]}</span></td>
                      <td className="hide-sm muted" style={{ fontSize: '0.82rem', maxWidth: 260 }}>{info?.short}</td>
                      <td className="num">{brl(o.total)}</td><td>{dateBr(o.createdAt)}</td>
                      <td><button className="btn sm" onClick={() => open(o.id)}>Abrir</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {detail && (() => {
        const info = STATUS_INFO[detail.status];
        const at = FLOW.indexOf(detail.status === 'PENDING_APPROVAL' ? 'DRAFT' : detail.status === 'CLOSED' ? 'DELIVERED' : detail.status);
        return (
          <Dialog title={`Pedido #${detail.number}`} description={<span className={`badge dot ${info?.tone ?? ''}`}>{ORDER_STATUS[detail.status]}</span>} onClose={() => setDetail(null)} xl>
            <div className="modal-body">
            {error && <Alert kind="error">{error}</Alert>}
            {ok && <Alert kind="ok">{ok}</Alert>}
            <div className="row" style={{ marginBottom: 14 }}>
              <div className="row">
                {detail.status === 'DRAFT' && can('sales.create') && <>
                  <button className="btn" onClick={() => { setDetail(null); startForm(detail); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Editar</button>
                  <button className="btn primary" onClick={() => act(async () => { const r = await api<{ status: string; reasons: string[] }>(`/sales/orders/${detail.id}/submit`, 'POST'); if (r.status === 'PENDING_APPROVAL') throw new Error(`Enviado para aprovação: ${r.reasons.join('; ')}`); }, 'Pedido confirmado e estoque reservado.')}>Confirmar pedido</button>
                </>}
                {detail.status === 'PENDING_APPROVAL' && can('sales.approve') && <>
                  <button className="btn primary" onClick={() => act(() => api(`/sales/orders/${detail.id}/approve`, 'POST'), 'Pedido aprovado e confirmado.')}>Aprovar</button>
                  <button className="btn" onClick={async () => { const r = await ui.prompt({ title: 'Rejeitar pedido', label: 'Motivo da rejeição', multiline: true, confirmLabel: 'Rejeitar' }); if (r) void act(() => api(`/sales/orders/${detail.id}/reject`, 'POST', { reason: r }), 'Pedido devolvido a rascunho.'); }}>Rejeitar</button>
                </>}
                {NEXT[detail.status] && can('sales.fulfill') && <button className="btn primary" onClick={() => act(() => api(`/sales/orders/${detail.id}/advance`, 'POST', { to: NEXT[detail.status][0] }), 'Situação atualizada.')}>{NEXT[detail.status][1]}</button>}
                {['DRAFT', 'PENDING_APPROVAL', 'CONFIRMED', 'PICKING', 'PACKED'].includes(detail.status) && can('sales.create') && <button className="btn" onClick={() => cancel(detail)}>Cancelar pedido</button>}
                {['SHIPPED', 'DELIVERED', 'CLOSED'].includes(detail.status) && can('sales.return') && <button className="btn" onClick={() => doReturn(detail)}>Registrar devolução</button>}
              </div>
            </div>

            {detail.status !== 'CANCELLED' && (
              <ol className="journey" aria-label="Andamento do pedido">
                {FLOW.map((s, i) => <li key={s} className={i < at ? 'done' : i === at ? 'now' : ''} aria-current={i === at ? 'step' : undefined}>{i < at ? '✓ ' : ''}{ORDER_STATUS[s]}</li>)}
              </ol>
            )}
            {info && <div className="next-box"><div><strong>{detail.status === 'CANCELLED' || detail.status === 'CLOSED' ? 'Situação' : 'Próximo passo'}</strong><p>{info.meaning} {info.next}</p></div></div>}

            <div className="meta" style={{ marginBottom: 12 }}>
              <span><b>Cliente:</b> {detail.customer.name}</span><span><b>Depósito:</b> {detail.warehouse.code}</span><span><b>Vendedor:</b> {detail.salesperson?.name ?? '—'}</span><span><b>Data:</b> {dateBr(detail.createdAt)}</span>
            </div>
            <div className="row" style={{ marginBottom: 12 }}>
              <PurchaseBadge type={detail.customerType} />
              {detail.dispatchDate && <span className={`badge ${detail.dispatchDeferred ? 'warn' : ''}`} title={detail.dispatchDeferred ? 'Confirmado depois do horário de corte (ou fora de dia útil)' : 'Confirmado antes do horário de corte'}>Saída prevista: {dateBr(detail.dispatchDate)}{detail.dispatchDeferred ? ' · após o corte' : ''}</span>}
              <span className="badge">Pagamento: {detail.paymentMethod ? PAYMENT_LABEL[detail.paymentMethod] : 'não informado'}{detail.paymentMethod === 'BOLETO' ? ` em ${detail.installmentCount}x` : ''}</span>
              <span className={`badge ${detail.fiscalDocType === 'NONE' ? '' : 'brand'}`}>Documento fiscal: {FISCAL_LABEL[detail.fiscalDocType ?? 'NONE']}</span>
              <button className="btn sm" onClick={() => setFiscalView({ id: detail.id, docType: detail.fiscalDocType ?? 'NONE' })}>{detail.fiscalDocType === 'NONE' ? 'Ver modelos (NF-e e NFC-e)' : 'Ver documento'}</button>
            </div>
            {detail.paymentMethod === 'BOLETO' && (detail.installments.length > 0
              ? <div className="table-wrap" style={{ marginBottom: 12 }}><table><thead><tr><th>Parcela</th><th>Vencimento</th><th className="num">Valor</th><th>Situação</th></tr></thead><tbody>{detail.installments.map((t) => <tr key={t.id}><td>{t.installmentNo}/{t.installmentTotal}</td><td>{dateBr(t.dueDate)}</td><td className="num">{brl(t.amount)}</td><td><span className={`badge ${t.status === 'PAID' ? 'ok' : t.status === 'CANCELLED' ? 'danger' : ''}`}>{t.status === 'PAID' ? 'Paga' : t.status === 'PARTIAL' ? 'Paga em parte' : t.status === 'CANCELLED' ? 'Cancelada' : 'Em aberto'}</span></td></tr>)}</tbody></table></div>
              : detail.firstDueDate && <p className="muted" style={{ marginTop: 0 }}>Boleto em {detail.installmentCount}x, 1º vencimento em {dateBr(detail.firstDueDate)}. As contas a receber são criadas quando o pedido for confirmado.</p>)}
            {detail.approvalReason && <Alert kind="warn">{detail.approvalReason}</Alert>}
            {detail.cancelReason && <Alert kind="error">Cancelado: {detail.cancelReason}</Alert>}
            <div className="table-wrap">
              <table>
                <thead><tr><th>Produto</th><th>Qtd.</th><th className="num">Preço</th><th>Desc.</th><th className="num">Total</th><th>Devolvido</th></tr></thead>
                <tbody>{detail.items.map((i) => <tr key={i.id}><td>{i.product.sku} — {i.product.name}</td><td>{i.quantity}</td><td className="num">{brl(i.unitPrice)}</td><td>{Number(i.discountPct)}%</td><td className="num">{brl(i.total)}</td><td>{i.returnedQty}</td></tr>)}</tbody>
              </table>
            </div>
            <div className="totals-bar" style={{ marginTop: 12 }}>
              <span>Produtos {brl(detail.subtotal)}</span><span>Descontos − {brl(detail.discountTotal)}</span><span>Frete {brl(detail.shipping)}</span><span className="grand">Total {brl(detail.total)}</span>
            </div>
            </div>
          </Dialog>
        );
      })()}
      {fiscalView && <FiscalPreviewDialog orderId={fiscalView.id} docType={fiscalView.docType} onClose={() => setFiscalView(null)} />}
    </>
  );
}
