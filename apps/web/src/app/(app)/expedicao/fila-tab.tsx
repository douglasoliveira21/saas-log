'use client';

import { ClipboardList, Flame, MapPin, Package, RefreshCw, ScanBarcode, StickyNote, Truck, User } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, useUi } from '@/components/ui';
import { api } from '@/lib/api';
import { dateBr } from '@/lib/format';
import { ColetaDialog } from './coleta-dialog';

type Stage = 'WAITING' | 'PICKING' | 'PACKED' | 'SHIPPED' | 'DELIVERED';
type Flag = 'LATE' | 'DUE_TODAY' | 'STUCK' | 'DIVERGENT' | 'RUSH';
interface Item {
  id: string; number: number; status: string; stage: Stage; channel: string; customer: string; city: string | null; state: string | null; warehouse: string;
  items: number; units: number; weightKg: number; dispatchDate: string | null; dispatchDeferred: boolean; stageSince: string | null; ageHours: number; stageHours: number;
  rush: boolean; rushReason: string | null; note: string | null; pickingBy: string | null; packedBy: string | null; lastCheck: string | null;
  shipment: { carrier: string; trackingCode: string | null; status: string } | null; flags: Flag[];
}

const COLUMNS: { stage: Stage; title: string; hint: string; color: string }[] = [
  { stage: 'WAITING', title: 'Aguardando separação', hint: 'Confirmados em Vendas', color: 'var(--dv-2)' },
  { stage: 'PICKING', title: 'Em separação', hint: 'No depósito agora', color: 'var(--dv-1)' },
  { stage: 'PACKED', title: 'Prontos para expedir', hint: 'Embalados', color: 'var(--dv-3)' },
  { stage: 'SHIPPED', title: 'Expedidos', hint: 'A caminho (7 dias)', color: 'var(--dv-7)' },
  { stage: 'DELIVERED', title: 'Entregues', hint: 'Encerrar o pedido (3 dias)', color: 'var(--ok)' },
];
const FILTERS: [string, string][] = [['', 'Todos'], ['LATE', 'Atrasados'], ['DUE_TODAY', 'Saem hoje'], ['RUSH', 'Urgentes'], ['STUCK', 'Parados'], ['DIVERGENT', 'Divergência'], ['READY', 'Prontos']];
const FLAG_LABEL: Record<Flag, [string, string]> = { LATE: ['Atrasado', 'danger'], DUE_TODAY: ['Sai hoje', 'warn'], STUCK: ['Parado', 'warn'], DIVERGENT: ['Divergência', 'danger'], RUSH: ['Urgente', 'danger'] };
const since = (h: number) => (h < 1 ? 'menos de 1 h' : h < 48 ? `${h} h` : `${Math.floor(h / 24)} dias`);

/** Quadro da expedição: cada pedido na sua etapa, com tempo, responsável, alertas e a ação do momento. */
export function FilaTab({ initialFilter, initialSearch, onRegisterShipment }: { initialFilter: string; initialSearch: string; onRegisterShipment: () => void }) {
  const ui = useUi();
  const [items, setItems] = useState<Item[] | null>(null);
  const [filter, setFilter] = useState(initialFilter);
  const [q, setQ] = useState(initialSearch);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [coletaId, setColetaId] = useState<string | null>(null);
  useEffect(() => { setFilter(initialFilter); setQ(initialSearch); }, [initialFilter, initialSearch]);

  const load = useCallback(() => { api<Item[]>('/dispatch/queue').then((r) => { setItems(r); setError(''); }).catch((e) => setError(e.message)); }, []);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (items ?? []).filter((i) => {
      if (filter === 'READY' ? i.stage !== 'PACKED' : filter && !i.flags.includes(filter as Flag)) return false;
      if (!term) return true;
      return String(i.number) === term.replace('#', '') || i.customer.toLowerCase().includes(term) || (i.city ?? '').toLowerCase().includes(term);
    });
  }, [items, filter, q]);

  async function advance(i: Item, to: string, done: string, confirm?: { title: string; message: string; label: string }): Promise<boolean> {
    if (confirm && !(await ui.confirm({ title: confirm.title, message: confirm.message, confirmLabel: confirm.label }))) return false;
    let success = false;
    setBusy(i.id); setError(''); setOk('');
    try { await api(`/sales/orders/${i.id}/advance`, 'POST', { to }); setOk(`Pedido #${i.number}: ${done}`); load(); success = true; } catch (e) { setError(`Pedido #${i.number}: ${(e as Error).message}`); }
    setBusy(null);
    return success;
  }
  async function startPicking(i: Item) {
    if (await advance(i, 'PICKING', 'separação iniciada.')) setColetaId(i.id);
  }
  async function toggleRush(i: Item) {
    let reason: string | null = '';
    if (!i.rush) { reason = await ui.prompt({ title: `Urgente — pedido #${i.number}`, label: 'Motivo (opcional)', confirmLabel: 'Marcar urgente' }); if (reason === null) return; }
    setError(''); setOk('');
    try { await api(`/dispatch/orders/${i.id}/rush`, 'PUT', { rush: !i.rush, reason: reason || undefined }); load(); } catch (e) { setError((e as Error).message); }
  }
  async function editNote(i: Item) {
    const note = await ui.prompt({ title: `Observação — pedido #${i.number}`, label: 'Instruções para a equipe (ex.: frágil, retirada no balcão)', defaultValue: i.note ?? '', multiline: true, confirmLabel: 'Salvar' });
    if (note === null) return;
    try { await api(`/dispatch/orders/${i.id}/note`, 'PUT', { note }); load(); } catch (e) { setError((e as Error).message); }
  }

  function actions(i: Item) {
    const disabled = busy === i.id;
    switch (i.stage) {
      case 'WAITING': return <>
        <button className="btn sm primary" disabled={disabled} onClick={() => startPicking(i)}><Package aria-hidden />Iniciar separação</button>
        <Link className="btn sm" href="/armazem"><ClipboardList aria-hidden />Lista</Link>
      </>;
      case 'PICKING': return <>
        <button className="btn sm primary" disabled={disabled} onClick={() => advance(i, 'PACKED', 'embalado e pronto para expedir.')}><Package aria-hidden />Marcar embalado</button>
        <button className="btn sm" onClick={() => setColetaId(i.id)}><ScanBarcode aria-hidden />Coletar</button>
      </>;
      case 'PACKED': return <>
        <button className="btn sm primary" disabled={disabled} onClick={() => advance(i, 'SHIPPED', 'expedido (estoque baixado).', { title: `Expedir o pedido #${i.number}?`, message: 'O pedido sai do depósito e o estoque físico é baixado. Isso não pode ser desfeito (só por devolução).', label: 'Expedir' })}><Truck aria-hidden />Expedir</button>
        <button className="btn sm" onClick={onRegisterShipment}>Registrar envio</button>
      </>;
      case 'SHIPPED': return <button className="btn sm" disabled={disabled} onClick={() => advance(i, 'DELIVERED', 'entrega confirmada.', { title: `Confirmar a entrega do pedido #${i.number}?`, message: 'Use quando o cliente já recebeu (o motorista também confirma pela rota, com a foto do canhoto).', label: 'Confirmar entrega' })}>Confirmar entrega</button>;
      case 'DELIVERED': return <button className="btn sm" disabled={disabled} onClick={() => advance(i, 'CLOSED', 'pedido encerrado.', { title: `Encerrar o pedido #${i.number}?`, message: 'Depois de encerrado só é possível registrar devolução.', label: 'Encerrar' })}>Encerrar</button>;
    }
  }

  return (
    <div className="stack">
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}
      <div className="row" style={{ justifyContent: 'space-between', gap: 10 }}>
        <div className="row" role="group" aria-label="Filtro" style={{ gap: 6 }}>
          {FILTERS.map(([k, l]) => <button key={k || 'all'} className={`btn sm ${filter === k ? 'primary' : ''}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}
        </div>
        <div className="row">
          <input aria-label="Buscar pedido" placeholder="Pedido, cliente ou cidade" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 240 }} />
          <button className="btn icon ghost" onClick={load} aria-label="Atualizar" title="Atualiza sozinho a cada 30 s"><RefreshCw /></button>
        </div>
      </div>

      {coletaId && <ColetaDialog orderId={coletaId} onClose={() => setColetaId(null)} onDone={load} />}

      {!items && !error && <div className="card"><span className="skeleton" style={{ height: 160, width: '100%' }} /></div>}
      {items && (
        <div className="kanban" role="list">
          {COLUMNS.map((c) => {
            const list = visible.filter((i) => i.stage === c.stage);
            const total = items.filter((i) => i.stage === c.stage).length;
            return (
              <section key={c.stage} className="kb-col" aria-label={c.title}>
                <header style={{ borderTopColor: c.color }}><strong>{c.title}</strong><span className="badge">{list.length}{list.length !== total ? `/${total}` : ''}</span><small className="muted">{c.hint}</small></header>
                <div className="kb-list">
                  {list.length === 0 && <p className="muted kb-empty">Nenhum pedido.</p>}
                  {list.map((i) => (
                    <article key={i.id} className={`kb-card ${i.flags.includes('LATE') || i.flags.includes('DIVERGENT') ? 'bad' : i.flags.length ? 'warn' : ''}`} role="listitem">
                      <div className="row" style={{ justifyContent: 'space-between', gap: 6 }}>
                        <strong>#{i.number}</strong>
                        <div className="row" style={{ gap: 4 }}>
                          {i.channel === 'MARKETPLACE' && <span className="badge">Marketplace</span>}
                          {i.flags.map((f) => <span key={f} className={`badge ${FLAG_LABEL[f][1]}`}>{FLAG_LABEL[f][0]}</span>)}
                        </div>
                      </div>
                      <div className="kb-cust">{i.customer}</div>
                      <div className="muted kb-meta"><MapPin aria-hidden size={12} /> {[i.city, i.state].filter(Boolean).join('/') || '—'} · {i.items} item(ns), {i.units} un.{i.weightKg > 0 ? ` · ${String(i.weightKg).replace('.', ',')} kg` : ''}</div>
                      <div className="muted kb-meta">
                        {i.dispatchDate ? <>Saída {dateBr(i.dispatchDate)}{i.dispatchDeferred ? ' (adiada)' : ''} · </> : null}na etapa há {since(i.stageHours)}
                      </div>
                      {(i.pickingBy || i.packedBy) && <div className="muted kb-meta"><User aria-hidden size={12} /> {i.stage === 'PICKING' ? `Separando: ${i.pickingBy}` : [i.pickingBy && `Separou: ${i.pickingBy}`, i.packedBy && `Embalou: ${i.packedBy}`].filter(Boolean).join(' · ')}</div>}
                      {i.rush && i.rushReason && <div className="kb-note"><Flame aria-hidden size={12} /> {i.rushReason}</div>}
                      {i.note && <div className="kb-note"><StickyNote aria-hidden size={12} /> {i.note}</div>}
                      {i.shipment && <div className="muted kb-meta"><Truck aria-hidden size={12} /> {i.shipment.carrier}{i.shipment.trackingCode ? ` · ${i.shipment.trackingCode}` : ''}</div>}
                      <div className="row kb-actions">
                        {actions(i)}
                        {['WAITING', 'PICKING', 'PACKED'].includes(i.stage) && <>
                          <button className={`btn sm icon ghost ${i.rush ? 'on' : ''}`} onClick={() => toggleRush(i)} aria-pressed={i.rush} aria-label={i.rush ? 'Tirar urgência' : 'Marcar urgente'} title={i.rush ? 'Tirar urgência' : 'Marcar urgente'}><Flame /></button>
                          <button className="btn sm icon ghost" onClick={() => editNote(i)} aria-label="Observação" title="Observação da expedição"><StickyNote /></button>
                        </>}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
