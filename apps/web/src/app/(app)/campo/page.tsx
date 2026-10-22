'use client';

import { CloudOff, RefreshCw, Search, Trash2, Wifi } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, EmptyState, PageHeader, useUi } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { brl } from '@/lib/format';
import { PAYMENT_LABEL } from '@/lib/order-flow';

interface CProduct { id: string; sku: string; name: string; price: number | null; unit: string }
interface CCustomer { id: string; name: string; document: string | null }
interface CWarehouse { id: string; code: string; name: string }
interface Cache { at: string; customers: CCustomer[]; products: CProduct[]; warehouses: CWarehouse[] }
interface QLine { productId: string; name: string; sku: string; qty: number; price: number; disc: number }
interface QItem {
  ref: string; createdAt: string; customerId: string; customerName: string; warehouseId: string; paymentMethod: string; installments: number; firstDueDate: string; notes: string; lines: QLine[];
  status: 'PENDING' | 'SENT' | 'ERROR'; message?: string; orderNumber?: number; orderStatus?: string;
}

const CACHE_KEY = 'dh_field_cache_v1';
const QUEUE_KEY = 'dh_field_queue_v1';
const read = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* armazenamento cheio ou bloqueado */ } };
const total = (lines: QLine[]) => lines.reduce((s, l) => s + l.qty * l.price * (1 - l.disc / 100), 0);
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const newRef = () => `campo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export default function CampoPage() {
  const ui = useUi();
  const [online, setOnline] = useState(true);
  const [cache, setCache] = useState<Cache | null>(null);
  const [queue, setQueue] = useState<QItem[]>([]);
  const [tab, setTab] = useState<'novo' | 'fila'>('novo');
  const [syncing, setSyncing] = useState(false);
  const [loadingCache, setLoadingCache] = useState(false);
  const queueRef = useRef<QItem[]>([]);
  queueRef.current = queue;

  const persist = useCallback((q: QItem[]) => { setQueue(q); queueRef.current = q; write(QUEUE_KEY, q); }, []);

  // carrega o que estiver guardado no aparelho e registra o modo offline
  useEffect(() => {
    setCache(read<Cache | null>(CACHE_KEY, null));
    setQueue(read<QItem[]>(QUEUE_KEY, []));
    setOnline(navigator.onLine);
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }, []);

  const refreshCache = useCallback(async (quiet = false) => {
    setLoadingCache(true);
    try {
      const products: CProduct[] = [];
      for (let off = 0; off < 5000; off += 200) {
        const r = await api<{ items: { id: string; sku: string; name: string; suggestedPrice: string | null; saleUnit: string }[]; total: number }>(`/products?limit=200&offset=${off}`);
        products.push(...r.items.map((p) => ({ id: p.id, sku: p.sku, name: p.name, price: p.suggestedPrice === null ? null : Number(p.suggestedPrice), unit: p.saleUnit })));
        if (off + 200 >= r.total) break;
      }
      const customers = (await api<{ id: string; name: string; document: string | null; active: boolean }[]>('/customers')).filter((c) => c.active !== false).map((c) => ({ id: c.id, name: c.name, document: c.document }));
      const tree = await api<{ establishments: { warehouses: { id: string; code: string; name: string; active: boolean }[] }[] }[]>('/structure');
      const warehouses = tree.flatMap((c) => c.establishments.flatMap((e) => e.warehouses)).filter((w) => w.active).map((w) => ({ id: w.id, code: w.code, name: w.name }));
      const next: Cache = { at: new Date().toISOString(), customers, products, warehouses };
      write(CACHE_KEY, next); setCache(next);
      if (!quiet) ui.toast.ok(`Dados atualizados: ${customers.length} clientes e ${products.length} produtos guardados no aparelho.`);
    } catch (e) { if (!quiet) ui.toast.error(`Não foi possível atualizar agora: ${(e as Error).message}`); }
    setLoadingCache(false);
  }, [ui]);

  const sync = useCallback(async (quiet = false) => {
    if (syncing || !navigator.onLine) return;
    const pending = queueRef.current.filter((i) => i.status !== 'SENT');
    if (!pending.length) return;
    setSyncing(true);
    let sent = 0;
    for (const item of pending) {
      try {
        const created = await api<{ id: string; number: number; duplicate?: boolean }>('/sales/orders', 'POST', {
          clientRef: item.ref, customerId: item.customerId, warehouseId: item.warehouseId, paymentMethod: item.paymentMethod,
          ...(item.paymentMethod === 'BOLETO' ? { installments: item.installments, firstDueDate: item.firstDueDate } : {}),
          notes: item.notes || undefined, items: item.lines.map((l) => ({ productId: l.productId, quantity: l.qty, unitPrice: l.price, discountPct: l.disc || undefined })),
        });
        let orderStatus = 'DRAFT'; let message = 'Pedido criado como rascunho.';
        const already = created.duplicate ? await api<{ status: string }>(`/sales/orders/${created.id}`) : null; // reenvio: o pedido já tinha chegado
        if (already && already.status !== 'DRAFT') { orderStatus = already.status; message = 'Pedido já havia sido recebido pelo escritório.'; } else try {
          const c = await api<{ status: string; reasons: string[] }>(`/sales/orders/${created.id}/submit`, 'POST');
          orderStatus = c.status; message = c.status === 'CONFIRMED' ? 'Pedido confirmado.' : `Aguardando aprovação: ${c.reasons.join('; ')}`;
        } catch (e) { message = `Criado como rascunho, mas não foi confirmado: ${(e as Error).message}`; }
        persist(queueRef.current.map((i) => (i.ref === item.ref ? { ...i, status: 'SENT', orderNumber: created.number, orderStatus, message } : i)));
        sent++;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) { if (!quiet) ui.toast.error('Sua sessão expirou. Entre de novo para enviar.'); break; }
        if (!(e instanceof ApiError)) break; // sem rede: tenta depois
        persist(queueRef.current.map((i) => (i.ref === item.ref ? { ...i, status: 'ERROR', message: e.message } : i)));
      }
    }
    setSyncing(false);
    if (sent && !quiet) ui.toast.ok(`${sent} pedido(s) enviado(s).`);
  }, [persist, syncing, ui]);

  useEffect(() => {
    const on = () => { setOnline(true); void sync(true); };
    const off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, [sync]);
  useEffect(() => { if (navigator.onLine) void refreshCache(true); }, [refreshCache]);

  const pendingCount = queue.filter((i) => i.status !== 'SENT').length;

  return (
    <>
      <PageHeader title="Venda em campo" description="Lance pedidos pelo celular, mesmo sem sinal. Os pedidos ficam guardados no aparelho e são enviados sozinhos quando a internet voltar." actions={
        <span className={`badge ${online ? 'ok' : 'warn'}`}>{online ? <><Wifi size={13} aria-hidden /> Online</> : <><CloudOff size={13} aria-hidden /> Sem internet</>}</span>
      } />
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'novo'} className={`tab ${tab === 'novo' ? 'active' : ''}`} onClick={() => setTab('novo')}>Novo pedido</button>
        <button role="tab" aria-selected={tab === 'fila'} className={`tab ${tab === 'fila' ? 'active' : ''}`} onClick={() => setTab('fila')}>Pedidos do aparelho{pendingCount ? ` (${pendingCount} a enviar)` : ''}</button>
      </div>
      {tab === 'novo' && (cache
        ? <NewOrder cache={cache} online={online} loading={loadingCache} onRefresh={() => refreshCache(false)} onSave={(item) => { persist([item, ...queueRef.current]); setTab('fila'); if (navigator.onLine) void sync(true); else ui.toast.info('Sem internet: pedido guardado no aparelho. Ele será enviado quando a conexão voltar.'); }} />
        : <EmptyState icon={<CloudOff size={22} />} title="Ainda não há dados no aparelho" action={online ? <button className="btn primary" onClick={() => refreshCache(false)} disabled={loadingCache}>Baixar clientes e produtos</button> : undefined}>{online ? 'Baixe os clientes e produtos uma vez com internet para poder vender sem sinal.' : 'Conecte-se à internet e abra esta tela para baixar os clientes e produtos.'}</EmptyState>)}
      {tab === 'fila' && <Queue queue={queue} online={online} syncing={syncing} onSync={() => sync(false)} onRemove={(ref) => persist(queue.filter((i) => i.ref !== ref))} onRetry={(ref) => { persist(queue.map((i) => (i.ref === ref ? { ...i, status: 'PENDING', message: undefined } : i))); void sync(false); }} />}
    </>
  );
}

function NewOrder({ cache, online, loading, onRefresh, onSave }: { cache: Cache; online: boolean; loading: boolean; onRefresh: () => void; onSave: (i: QItem) => void }) {
  const [customer, setCustomer] = useState<CCustomer | null>(null); const [cq, setCq] = useState('');
  const [lines, setLines] = useState<QLine[]>([]); const [pq, setPq] = useState('');
  const [warehouseId, setWarehouseId] = useState(cache.warehouses[0]?.id ?? '');
  const [pay, setPay] = useState({ method: '', installments: '1', firstDueDate: '' }); const [notes, setNotes] = useState('');
  const [error, setError] = useState('');

  const customers = useMemo(() => { const t = norm(cq.trim()); return t.length < 2 ? [] : cache.customers.filter((c) => norm(c.name).includes(t) || (c.document ?? '').includes(t)).slice(0, 8); }, [cq, cache.customers]);
  const products = useMemo(() => { const t = norm(pq.trim()); return t.length < 2 ? [] : cache.products.filter((p) => norm(p.name).includes(t) || norm(p.sku).includes(t)).slice(0, 8); }, [pq, cache.products]);
  const add = (p: CProduct) => {
    setPq('');
    setLines((ls) => ls.some((l) => l.productId === p.id) ? ls.map((l) => (l.productId === p.id ? { ...l, qty: l.qty + 1 } : l)) : [...ls, { productId: p.id, name: p.name, sku: p.sku, qty: 1, price: p.price ?? 0, disc: 0 }]);
  };
  const upd = (i: number, patch: Partial<QLine>) => setLines(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));

  function save() {
    setError('');
    if (!customer) { setError('Escolha o cliente.'); return; }
    if (!lines.length) { setError('Adicione ao menos um produto.'); return; }
    if (lines.some((l) => !(l.qty >= 1) || !(l.price > 0))) { setError('Confira a quantidade e o preço de cada produto (preço maior que zero).'); return; }
    if (!pay.method) { setError('Escolha a forma de pagamento.'); return; }
    if (pay.method === 'BOLETO' && !pay.firstDueDate) { setError('Boleto: informe o vencimento da primeira parcela.'); return; }
    onSave({ ref: newRef(), createdAt: new Date().toISOString(), customerId: customer.id, customerName: customer.name, warehouseId, paymentMethod: pay.method, installments: Number(pay.installments) || 1, firstDueDate: pay.firstDueDate, notes, lines, status: 'PENDING' });
  }

  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <p className="muted" style={{ margin: 0, fontSize: '0.82rem' }}>Dados do aparelho de {new Date(cache.at).toLocaleString('pt-BR')} · {cache.customers.length} clientes · {cache.products.length} produtos. {online && <button className="btn sm" onClick={onRefresh} disabled={loading}><RefreshCw aria-hidden />Atualizar</button>}</p>
      {error && <Alert kind="error">{error}</Alert>}
      <section className="card">
        <h2>1. Cliente</h2>
        {customer ? <div className="row"><strong>{customer.name}</strong><button className="btn sm" onClick={() => { setCustomer(null); setCq(''); }}>Trocar</button></div> : <>
          <div className="toolbar" style={{ marginBottom: 6 }}><div className="search"><Search aria-hidden /><input aria-label="Buscar cliente" placeholder="Nome ou CPF/CNPJ (2+ letras)…" value={cq} onChange={(e) => setCq(e.target.value)} /></div></div>
          {customers.map((c) => <button key={c.id} className="btn" style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 6 }} onClick={() => setCustomer(c)}>{c.name}{c.document ? <span className="muted"> · {c.document}</span> : null}</button>)}
          {cq.trim().length >= 2 && customers.length === 0 && <p className="muted">Nenhum cliente guardado com esse nome. Cadastre o cliente no escritório e atualize os dados.</p>}
        </>}
        {cache.warehouses.length > 1 && <div style={{ marginTop: 10 }}><label htmlFor="c-w">Depósito</label><select id="c-w" value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>{cache.warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select></div>}
      </section>
      <section className="card">
        <h2>2. Produtos</h2>
        <div className="toolbar" style={{ marginBottom: 6 }}><div className="search"><Search aria-hidden /><input aria-label="Buscar produto" placeholder="Nome ou SKU (2+ letras)…" value={pq} onChange={(e) => setPq(e.target.value)} /></div></div>
        {products.map((p) => <button key={p.id} className="btn" style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 6 }} onClick={() => add(p)}>{p.name} <span className="muted">· {p.sku} · {p.price === null ? 'sem preço' : brl(p.price)}</span></button>)}
        {lines.map((l, i) => (
          <div key={l.productId} style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 10 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}><strong>{l.name}</strong><button className="btn sm" aria-label={`Remover ${l.name}`} onClick={() => setLines(lines.filter((_, k) => k !== i))}><Trash2 aria-hidden /></button></div>
            <div className="form-grid">
              <div><label>Qtd.</label><input inputMode="numeric" value={l.qty || ''} onChange={(e) => upd(i, { qty: Number(e.target.value.replace(/\D/g, '')) })} /></div>
              <div><label>Preço (R$)</label><input inputMode="decimal" value={l.price || ''} onChange={(e) => upd(i, { price: Number(e.target.value.replace(',', '.')) || 0 })} /></div>
              <div><label>Desc. %</label><input inputMode="decimal" value={l.disc || ''} onChange={(e) => upd(i, { disc: Math.min(100, Number(e.target.value.replace(',', '.')) || 0) })} /></div>
            </div>
            <div className="muted" style={{ textAlign: 'right', fontSize: '0.84rem' }}>{brl(l.qty * l.price * (1 - l.disc / 100))}</div>
          </div>
        ))}
      </section>
      <section className="card">
        <h2>3. Pagamento</h2>
        <div className="form-grid">
          <div><label htmlFor="c-p">Forma de pagamento *</label><select id="c-p" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}><option value="">Selecione…</option>{Object.entries(PAYMENT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
          {pay.method === 'BOLETO' && <>
            <div><label htmlFor="c-n">Parcelas</label><select id="c-n" value={pay.installments} onChange={(e) => setPay({ ...pay, installments: e.target.value })}>{Array.from({ length: 12 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}x</option>)}</select></div>
            <div><label htmlFor="c-d">Vencimento da 1ª parcela *</label><input id="c-d" type="date" min={new Date().toISOString().slice(0, 10)} value={pay.firstDueDate} onChange={(e) => setPay({ ...pay, firstDueDate: e.target.value })} /></div>
          </>}
        </div>
        <div style={{ marginTop: 10 }}><label htmlFor="c-o">Observações</label><input id="c-o" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
        <div className="totals-bar" style={{ marginTop: 12 }}><span className="grand">Total {brl(total(lines))}</span></div>
        <div className="row" style={{ marginTop: 12 }}><button className="btn primary" onClick={save}>Salvar pedido</button></div>
        <p className="muted" style={{ fontSize: '0.8rem', marginBottom: 0 }}>O desconto, o limite de crédito e o estoque são conferidos quando o pedido chega ao escritório: se algo não passar, o pedido fica aguardando aprovação ou como rascunho, com o motivo.</p>
      </section>
    </div>
  );
}

function Queue({ queue, online, syncing, onSync, onRemove, onRetry }: { queue: QItem[]; online: boolean; syncing: boolean; onSync: () => void; onRemove: (ref: string) => void; onRetry: (ref: string) => void }) {
  const pending = queue.filter((i) => i.status !== 'SENT').length;
  if (!queue.length) return <EmptyState title="Nenhum pedido neste aparelho">Os pedidos que você lançar aparecem aqui até serem enviados.</EmptyState>;
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <div className="row"><button className={`btn primary ${syncing ? 'loading' : ''}`} onClick={onSync} disabled={syncing || !online || !pending}><RefreshCw aria-hidden />Enviar agora{pending ? ` (${pending})` : ''}</button>{!online && <span className="muted">Sem internet: o envio é automático quando voltar.</span>}</div>
      {queue.map((i) => (
        <section className="card" key={i.ref}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <strong>{i.customerName}</strong>
            <span className={`badge ${i.status === 'SENT' ? (i.orderStatus === 'CONFIRMED' ? 'ok' : 'warn') : i.status === 'ERROR' ? 'danger' : 'info'}`}>{i.status === 'SENT' ? `Enviado · pedido #${i.orderNumber}` : i.status === 'ERROR' ? 'Erro' : 'A enviar'}</span>
          </div>
          <div className="muted" style={{ fontSize: '0.82rem' }}>{new Date(i.createdAt).toLocaleString('pt-BR')} · {i.lines.length} item(ns) · {brl(total(i.lines))} · {PAYMENT_LABEL[i.paymentMethod]}</div>
          {i.message && <p style={{ margin: '8px 0 0', fontSize: '0.88rem' }}>{i.message}</p>}
          <div className="row" style={{ marginTop: 8 }}>
            {i.status === 'ERROR' && <button className="btn sm" onClick={() => onRetry(i.ref)}>Tentar de novo</button>}
            {i.status !== 'PENDING' && <button className="btn sm" onClick={() => onRemove(i.ref)}>{i.status === 'SENT' ? 'Limpar' : 'Descartar'}</button>}
          </div>
        </section>
      ))}
    </div>
  );
}
