'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { dateBr } from '@/lib/format';
import { PageHeader, Alert } from '@/components/ui';
import { MaskedInput } from '@/components/fields';
import { useSession } from '@/lib/session';

interface QueueItem { id: string; number: number; status: string; channel: string; customer: string; city: string | null; state: string | null }
interface Shipment { id: string; carrier: string; service: string | null; trackingCode: string | null; status: string; postedAt: string | null; deliveredAt: string | null; order: { number: number } }
interface Packaging { id: string; name: string; lengthMm: number; widthMm: number; heightMm: number; maxWeightG: number }
interface Capabilities { correios: Record<string, { status: string; note: string }> }
interface Detail extends Shipment { events: { id: string; occurredAt: string; status: string; description: string; location: string | null }[] }

const STATUS: Record<string, string> = { PENDING: 'Aguardando postagem', POSTED: 'Postado', IN_TRANSIT: 'Em trânsito', DELIVERED: 'Entregue', PROBLEM: 'Problema', CANCELLED: 'Cancelado' };

export default function ExpedicaoPage() {
  const { can } = useSession();
  const manage = can('logistics.manage');
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [packs, setPacks] = useState<Packaging[]>([]);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [create, setCreate] = useState<QueueItem | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  const load = useCallback(() => {
    api<QueueItem[]>('/logistics/queue').then(setQueue).catch((e) => setError(e.message));
    api<Shipment[]>('/logistics/shipments').then(setShipments).catch(() => undefined);
    api<Packaging[]>('/logistics/packagings').then(setPacks).catch(() => undefined);
    api<Capabilities>('/logistics/capabilities').then(setCaps).catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  async function run(fn: () => Promise<unknown>, done: string, after?: () => void) {
    setError(''); setOk('');
    try { await fn(); setOk(done); after?.(); load(); } catch (e) { setError((e as Error).message); }
  }
  const open = (id: string) => api<Detail>(`/logistics/shipments/${id}`).then(setDetail).catch((e) => setError(e.message));

  const createShipment = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!create) return;
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> = { salesOrderId: create.id, carrier: f.get('carrier') };
    for (const k of ['service', 'trackingCode', 'packagingId']) if (String(f.get(k) ?? '').trim()) body[k] = String(f.get(k)).trim();
    if (f.get('weightG')) body.weightG = Number(f.get('weightG'));
    if (f.get('cost')) body.cost = Number(String(f.get('cost')).replace(',', '.'));
    void run(() => api('/logistics/shipments', 'POST', body), 'Envio registrado.', () => setCreate(null));
  };
  const addEvent = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!detail) return;
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> = { status: f.get('status'), description: f.get('description') };
    if (String(f.get('trackingCode') ?? '').trim()) body.trackingCode = f.get('trackingCode');
    if (String(f.get('location') ?? '').trim()) body.location = f.get('location');
    void run(() => api(`/logistics/shipments/${detail.id}/events`, 'POST', body), 'Evento registrado.', () => void open(detail.id));
  };
  const addPackaging = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void run(() => api('/logistics/packagings', 'POST', { name: f.get('name'), lengthMm: Number(f.get('l')), widthMm: Number(f.get('w')), heightMm: Number(f.get('h')), maxWeightG: Number(f.get('max')) }), 'Embalagem cadastrada.');
  };

  return (
    <>
      <PageHeader title="Logística e expedição" description={<>Registro de envios e rastreio manual. Cotação, etiqueta e rastreio automático dos Correios dependem de contrato e credenciais — nada é simulado.</>} />
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}

      {caps && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>Correios</h2>
          <ul>{Object.entries(caps.correios).map(([k, v]) => <li key={k}><span className={`badge ${v.status === 'SUPPORTED' ? 'ok' : 'warn'}`}>{v.status === 'SUPPORTED' ? 'disponível' : 'aguardando credenciais'}</span> {v.note}</li>)}</ul>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Fila de expedição</h2>
        {create && manage && (
          <form className="card" style={{ margin: '12px 0' }} onSubmit={createShipment}>
            <h2>Envio do pedido {create.number}</h2>
            <div className="form-grid">
              <div><label htmlFor="c">Transportadora</label><select id="c" name="carrier" defaultValue="CORREIOS"><option value="CORREIOS">Correios</option><option value="OUTRA">Outra</option></select></div>
              <div><label htmlFor="s">Serviço</label><input id="s" name="service" placeholder="SEDEX, PAC…" /></div>
              <div><label htmlFor="t">Código de rastreio (ex.: AA123456789BR)</label><MaskedInput id="t" name="trackingCode" kind="tracking" /></div>
              <div><label htmlFor="p">Embalagem</label><select id="p" name="packagingId" defaultValue=""><option value="">—</option>{packs.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.lengthMm}×{p.widthMm}×{p.heightMm} mm)</option>)}</select></div>
              <div><label htmlFor="w">Peso (g)</label><input id="w" name="weightG" type="number" min={1} /></div>
              <div><label htmlFor="co">Custo do frete</label><input id="co" name="cost" inputMode="decimal" /></div>
            </div>
            <div className="row" style={{ marginTop: 12 }}><button className="btn primary">Registrar envio</button><button type="button" className="btn" onClick={() => setCreate(null)}>Cancelar</button></div>
          </form>
        )}
        <div className="table-wrap"><table>
          <thead><tr><th>Pedido</th><th>Cliente</th><th>Destino</th><th>Canal</th><th /></tr></thead>
          <tbody>
            {queue.length === 0 && <tr><td colSpan={5} className="muted">Nenhum pedido aguardando envio.</td></tr>}
            {queue.map((q) => <tr key={q.id}><td>{q.number}</td><td>{q.customer}</td><td>{[q.city, q.state].filter(Boolean).join('/') || '—'}</td><td>{q.channel}</td><td>{manage && <button className="btn sm" onClick={() => setCreate(q)}>Registrar envio</button>}</td></tr>)}
          </tbody>
        </table></div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Envios</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Pedido</th><th>Transportadora</th><th>Rastreio</th><th>Situação</th><th>Postado</th><th /></tr></thead>
          <tbody>{shipments.map((s) => <tr key={s.id}><td>{s.order.number}</td><td>{s.carrier}{s.service ? ` · ${s.service}` : ''}</td><td>{s.trackingCode ?? '—'}</td><td><span className={`badge ${s.status === 'DELIVERED' ? 'ok' : s.status === 'PROBLEM' ? 'warn' : ''}`}>{STATUS[s.status]}</span></td><td>{dateBr(s.postedAt)}</td><td><button className="btn sm" onClick={() => open(s.id)}>Abrir</button></td></tr>)}</tbody>
        </table></div>
        {detail && (
          <div style={{ marginTop: 16 }}>
            <h2>Pedido {detail.order.number} — {STATUS[detail.status]}</h2>
            <ul>{detail.events.map((ev) => <li key={ev.id}>{new Date(ev.occurredAt).toLocaleString('pt-BR')} · <strong>{STATUS[ev.status]}</strong> — {ev.description}{ev.location ? ` (${ev.location})` : ''}</li>)}</ul>
            {manage && detail.status !== 'DELIVERED' && detail.status !== 'CANCELLED' && (
              <form className="form-grid" onSubmit={addEvent}>
                <div><label htmlFor="es">Novo status</label><select id="es" name="status" defaultValue="POSTED">{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
                <div><label htmlFor="ed">Descrição *</label><input id="ed" name="description" required minLength={2} /></div>
                <div><label htmlFor="el">Local</label><input id="el" name="location" /></div>
                <div><label htmlFor="et">Código de rastreio</label><MaskedInput id="et" name="trackingCode" kind="tracking" defaultValue={detail.trackingCode ?? ''} /></div>
                <div style={{ alignSelf: 'end' }}><button className="btn primary">Registrar evento</button></div>
              </form>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Embalagens</h2>
        <ul>{packs.map((p) => <li key={p.id}>{p.name} — {p.lengthMm}×{p.widthMm}×{p.heightMm} mm, até {p.maxWeightG} g</li>)}</ul>
        {manage && (
          <form className="form-grid" onSubmit={addPackaging}>
            <div><label htmlFor="pn">Nome *</label><input id="pn" name="name" required /></div>
            <div><label htmlFor="pl">Comprimento (mm)</label><input id="pl" name="l" type="number" min={1} required /></div>
            <div><label htmlFor="pw">Largura (mm)</label><input id="pw" name="w" type="number" min={1} required /></div>
            <div><label htmlFor="ph">Altura (mm)</label><input id="ph" name="h" type="number" min={1} required /></div>
            <div><label htmlFor="pm">Peso máx. (g)</label><input id="pm" name="max" type="number" min={1} required /></div>
            <div style={{ alignSelf: 'end' }}><button className="btn primary">Adicionar</button></div>
          </form>
        )}
      </div>
    </>
  );
}
