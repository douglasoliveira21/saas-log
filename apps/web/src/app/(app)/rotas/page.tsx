'use client';

import { ArrowDown, ArrowUp, Map as MapIcon, Play, Plus, Route as RouteIcon, Trash2, Wand2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Dialog, EmptyState, PageHeader, StatCard, useUi } from '@/components/ui';
import { api } from '@/lib/api';
import { brl, dateBr, formatPhone } from '@/lib/format';
import { routeMapUrl } from '@/lib/maps';
import { useSession } from '@/lib/session';
import { RouteFleetCard } from './fleet-card';

interface Driver { id: string; name: string; phone: string | null; vehicle: string | null; plate: string | null; cpf: string | null; active: boolean; openRoutes: number }
interface Eligible { id: string; number: number; status: string; total: string; customerName: string; customerPhone: string | null; address: string; zipCode: string | null; city: string | null; state: string | null; addressComplete: boolean; dispatchDate: string | null }
interface Stop {
  id: string; sequence: number; status: 'PENDING' | 'DELIVERED' | 'FAILED' | 'CANCELLED'; salesOrderId: string; customerName: string; customerPhone: string | null; address: string;
  deliveredAt: string | null; receiverName: string | null; receiverDocument: string | null; notes: string | null; failureReason: string | null; lat: number | null; lng: number | null; hasProof: boolean; hasFailurePhoto: boolean;
}
interface RouteRow { id: string; number: number; routeDate: string; status: string; notes: string | null; cancelReason: string | null; driver: { id: string; name: string; plate: string | null; vehicle: string | null }; totals: { stops: number; pending: number; delivered: number; failed: number; cancelled: number } }
interface RouteDetail extends RouteRow { stops: Stop[]; startedAt: string | null; finishedAt: string | null }

const ROUTE_STATUS: Record<string, [string, string]> = { PLANNED: ['Planejada', ''], IN_PROGRESS: ['Em andamento', 'brand'], COMPLETED: ['Concluída', 'ok'], CANCELLED: ['Cancelada', 'danger'] };
const STOP_STATUS: Record<string, [string, string]> = { PENDING: ['Pendente', 'warn'], DELIVERED: ['Entregue', 'ok'], FAILED: ['Não entregue', 'danger'], CANCELLED: ['Removida', ''] };
const today = () => new Date().toISOString().slice(0, 10);

export default function RotasPage() {
  const { can } = useSession();
  const ui = useUi();
  const manage = can('routes.manage');
  const [tab, setTab] = useState<'rotas' | 'motoristas'>('rotas');
  const [routes, setRoutes] = useState<RouteRow[] | null>(null);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [eligible, setEligible] = useState<Eligible[]>([]);
  const [detail, setDetail] = useState<RouteDetail | null>(null);
  const [filter, setFilter] = useState({ status: '', date: '' });
  const [panel, setPanel] = useState<'nova' | 'motorista' | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);
  const [proof, setProof] = useState<Stop | null>(null);
  const [newRoute, setNewRoute] = useState({ date: today(), driverId: '', notes: '', autoSort: true });
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const loadRoutes = useCallback(() => {
    const q = new URLSearchParams();
    if (filter.status) q.set('status', filter.status);
    if (filter.date) q.set('date', filter.date);
    api<RouteRow[]>(`/delivery/routes?${q}`).then(setRoutes).catch((e) => setError(e.message));
  }, [filter]);
  const loadDrivers = useCallback(() => api<Driver[]>('/delivery/drivers').then(setDrivers).catch((e) => setError(e.message)), []);
  const loadEligible = useCallback(() => api<Eligible[]>('/delivery/eligible-orders').then(setEligible).catch(() => undefined), []);
  useEffect(() => { loadRoutes(); }, [loadRoutes]);
  useEffect(() => { void loadDrivers(); void loadEligible(); }, [loadDrivers, loadEligible]);

  const open = useCallback(async (id: string) => { setError(''); try { setDetail(await api<RouteDetail>(`/delivery/routes/${id}`)); } catch (e) { setError((e as Error).message); } }, []);
  const act = async (fn: () => Promise<unknown>, message?: string) => {
    setError(''); setOk(''); setBusy(true);
    try { await fn(); if (message) setOk(message); loadRoutes(); void loadEligible(); void loadDrivers(); if (detail) await open(detail.id); } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  async function createRoute() {
    if (!newRoute.driverId) { setError('Escolha o motorista.'); return; }
    if (!picked.size) { setError('Marque ao menos um pedido.'); return; }
    setError(''); setOk(''); setBusy(true);
    try {
      const r = await api<RouteDetail>('/delivery/routes', 'POST', { routeDate: newRoute.date, driverId: newRoute.driverId, orderIds: [...picked], notes: newRoute.notes || undefined, autoSort: newRoute.autoSort });
      setPanel(null); setPicked(new Set()); setDetail(r); setOk(`Rota ${r.number} criada com ${r.totals.stops} parada(s). Confira a ordem e inicie quando o veículo sair.`); loadRoutes(); void loadEligible(); void loadDrivers();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }

  async function createDriver(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries([...new FormData(e.currentTarget).entries()].filter(([, v]) => String(v).trim() !== ''));
    await act(async () => { await api('/delivery/drivers', 'POST', f); setPanel(null); }, 'Motorista cadastrado. Ele já pode entrar com o e-mail e a senha informados.');
  }

  const move = (i: number, to: number) => {
    if (!detail) return;
    const pending = detail.stops.filter((s) => s.status === 'PENDING').map((s) => s.id);
    if (to < 0 || to >= pending.length) return;
    [pending[i], pending[to]] = [pending[to], pending[i]];
    void act(() => api(`/delivery/routes/${detail.id}/order`, 'PUT', { stopIds: pending }));
  };

  async function cancelRoute() {
    if (!detail) return;
    const reason = await ui.prompt({ title: `Cancelar a rota ${detail.number}?`, message: 'Os pedidos voltam para a fila de entrega. Não é possível cancelar depois de uma entrega confirmada.', label: 'Motivo', danger: true, confirmLabel: 'Cancelar rota', cancelLabel: 'Voltar' });
    if (reason) await act(() => api(`/delivery/routes/${detail.id}/cancel`, 'POST', { reason }), 'Rota cancelada.');
  }

  async function start() {
    if (!detail) return;
    if (!(await ui.confirm({ title: `Iniciar a rota ${detail.number}?`, message: 'Os pedidos embalados passam a expedidos (o estoque é baixado) e o motorista já pode confirmar as entregas pelo celular.', confirmLabel: 'Iniciar rota' }))) return;
    await act(() => api(`/delivery/routes/${detail.id}/start`, 'POST'), 'Rota iniciada.');
  }

  const editable = !!detail && ['PLANNED', 'IN_PROGRESS'].includes(detail.status) && manage;
  const pendingStops = detail?.stops.filter((s) => s.status === 'PENDING') ?? [];
  const link = detail ? routeMapUrl(pendingStops.map((s) => s.address)) : null;
  const activeDrivers = drivers.filter((d) => d.active);

  return (
    <>
      <PageHeader title="Rotas e entregas" description={<>Monte a rota do dia, ordene as paradas e acompanhe as entregas. O motorista confirma cada entrega pelo celular e <strong>precisa enviar a foto do canhoto assinado</strong>.</>} actions={
        manage && tab === 'rotas' ? <button className="btn primary" onClick={() => { setPanel('nova'); setPicked(new Set()); void loadEligible(); }}><Plus aria-hidden />Nova rota</button>
          : manage && tab === 'motoristas' ? <button className="btn primary" onClick={() => setPanel('motorista')}><Plus aria-hidden />Motorista</button> : undefined
      } />
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}

      <div className="tabs" role="tablist" aria-label="Seções">
        {([['rotas', 'Rotas'], ['motoristas', 'Motoristas']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => { setTab(k); setPanel(null); }}>{l}</button>)}
      </div>

      {tab === 'motoristas' && (
        <div className="stack">
          {panel === 'motorista' && (
            <form className="card" onSubmit={createDriver}>
              <h2>Novo motorista</h2>
              <p className="muted" style={{ marginTop: 0 }}>Cria o acesso do motorista ao sistema. Ele entra com este e-mail e senha (ela pode ser trocada depois) e vê somente as próprias entregas.</p>
              <div className="form-grid">
                <div><label htmlFor="dn">Nome *</label><input id="dn" name="name" required minLength={2} /></div>
                <div><label htmlFor="de">E-mail (login) *</label><input id="de" name="email" type="email" required /></div>
                <div><label htmlFor="dp">Senha provisória * (mín. 8)</label><input id="dp" name="password" type="password" required minLength={8} autoComplete="new-password" /></div>
                <div><label htmlFor="dt">Telefone</label><input id="dt" name="phone" inputMode="tel" /></div>
                <div><label htmlFor="dv">Veículo</label><input id="dv" name="vehicle" placeholder="Ex.: Fiorino" /></div>
                <div><label htmlFor="dl">Placa</label><input id="dl" name="plate" maxLength={10} /></div>
                <div><label htmlFor="dc">CPF (exigido no MDF-e)</label><input id="dc" name="cpf" inputMode="numeric" maxLength={14} placeholder="000.000.000-00" /></div>
              </div>
              <div className="row" style={{ marginTop: 12 }}><button className="btn primary" disabled={busy}>Cadastrar</button><button type="button" className="btn" onClick={() => setPanel(null)}>Cancelar</button></div>
            </form>
          )}
          <section className="card">
            {drivers.length === 0 ? <EmptyState title="Nenhum motorista cadastrado">Cadastre os motoristas para montar rotas.</EmptyState> : (
              <div className="table-wrap"><table>
                <thead><tr><th>Motorista</th><th>Telefone</th><th>Veículo</th><th>CPF</th><th>Rotas em aberto</th><th>Situação</th><th /></tr></thead>
                <tbody>{drivers.map((d) => (
                  <tr key={d.id} style={d.active ? undefined : { opacity: 0.55 }}>
                    <td>{d.name}</td><td>{d.phone ? formatPhone(d.phone) : '—'}</td><td>{[d.vehicle, d.plate].filter(Boolean).join(' · ') || '—'}</td><td>{d.cpf ? `***.${d.cpf.slice(3, 6)}.${d.cpf.slice(6, 9)}-**` : <span className="badge warn">falta</span>}</td><td className="num">{d.openRoutes}</td>
                    <td><span className={`badge ${d.active ? 'ok' : ''}`}>{d.active ? 'Ativo' : 'Inativo'}</span></td>
                    <td className="actions">{manage && <button className="btn sm" disabled={busy} onClick={async () => { const c = await ui.prompt({ title: `CPF de ${d.name}`, label: 'CPF (11 dígitos)', defaultValue: d.cpf ?? '', confirmLabel: 'Salvar' }); if (c !== null) void act(() => api(`/delivery/drivers/${d.id}`, 'PUT', { cpf: c }), 'CPF salvo.'); }}>CPF</button>}{manage && <button className="btn sm" disabled={busy} onClick={() => act(() => api(`/delivery/drivers/${d.id}`, 'PUT', { active: !d.active }), d.active ? 'Motorista inativado.' : 'Motorista reativado.')}>{d.active ? 'Inativar' : 'Reativar'}</button>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </section>
        </div>
      )}

      {tab === 'rotas' && (
        <div className="stack">
          {panel === 'nova' && (
            <section className="card" aria-label="Nova rota">
              <h2>Nova rota</h2>
              <div className="form-grid">
                <div><label htmlFor="rd">Data da rota</label><input id="rd" type="date" value={newRoute.date} onChange={(e) => setNewRoute({ ...newRoute, date: e.target.value })} /></div>
                <div><label htmlFor="rm">Motorista *</label>
                  <select id="rm" value={newRoute.driverId} onChange={(e) => setNewRoute({ ...newRoute, driverId: e.target.value })}><option value="">Selecione…</option>{activeDrivers.map((d) => <option key={d.id} value={d.id}>{d.name}{d.plate ? ` — ${d.plate}` : ''}</option>)}</select>
                  {activeDrivers.length === 0 && <div className="muted" style={{ fontSize: '0.8rem' }}>Cadastre um motorista na aba “Motoristas”.</div>}
                </div>
                <div style={{ gridColumn: '1 / -1' }}><label htmlFor="rn">Observação</label><input id="rn" value={newRoute.notes} onChange={(e) => setNewRoute({ ...newRoute, notes: e.target.value })} maxLength={500} /></div>
              </div>
              <h3 style={{ marginBottom: 6 }}>Pedidos prontos para entrega ({eligible.length})</h3>
              <p className="muted" style={{ marginTop: 0 }}>Aparecem os pedidos <strong>embalados</strong> (ou já expedidos) que ainda não estão em nenhuma rota.</p>
              {eligible.length === 0 ? <EmptyState title="Nenhum pedido pronto">Embale os pedidos em Vendas para eles aparecerem aqui.</EmptyState> : (
                <div className="table-wrap"><table>
                  <thead><tr><th style={{ width: 36 }}><input type="checkbox" aria-label="Marcar todos" checked={picked.size === eligible.length} onChange={(e) => setPicked(e.target.checked ? new Set(eligible.map((o) => o.id)) : new Set())} /></th><th>Pedido</th><th>Cliente</th><th>Endereço</th><th className="num">Valor</th></tr></thead>
                  <tbody>{eligible.map((o) => (
                    <tr key={o.id}>
                      <td><input type="checkbox" aria-label={`Pedido ${o.number}`} checked={picked.has(o.id)} onChange={(e) => { const s = new Set(picked); if (e.target.checked) s.add(o.id); else s.delete(o.id); setPicked(s); }} /></td>
                      <td>#{o.number}<div className="muted" style={{ fontSize: '0.76rem' }}>{o.status === 'PACKED' ? 'Embalado' : 'Expedido'}{o.dispatchDate ? ` · saída ${dateBr(o.dispatchDate)}` : ''}</div></td>
                      <td>{o.customerName}{o.customerPhone && <div className="muted" style={{ fontSize: '0.76rem' }}>{formatPhone(o.customerPhone)}</div>}</td>
                      <td>{o.address}{!o.addressComplete && <div><span className="badge warn">endereço incompleto</span></div>}</td>
                      <td className="num">{brl(o.total)}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              )}
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}><input type="checkbox" style={{ width: 'auto' }} checked={newRoute.autoSort} onChange={(e) => setNewRoute({ ...newRoute, autoSort: e.target.checked })} />Ordenar as paradas por região (UF, cidade e CEP). Você pode ajustar a ordem depois.</label>
              <div className="row" style={{ marginTop: 12 }}><button className={`btn primary ${busy ? 'loading' : ''}`} disabled={busy || !picked.size} onClick={createRoute}><RouteIcon aria-hidden />Criar rota{picked.size ? ` com ${picked.size} pedido(s)` : ''}</button><button className="btn" onClick={() => setPanel(null)}>Cancelar</button></div>
            </section>
          )}

          <section className="card">
            <div className="toolbar">
              <input type="date" aria-label="Filtrar por data" value={filter.date} onChange={(e) => setFilter({ ...filter, date: e.target.value })} style={{ maxWidth: 170 }} />
              <select aria-label="Filtrar por situação" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })} style={{ maxWidth: 200 }}>
                <option value="">Todas as situações</option>{Object.entries(ROUTE_STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            {routes?.length === 0 && <EmptyState title="Nenhuma rota">{manage ? 'Clique em “Nova rota” para montar a primeira.' : 'Ainda não há rotas.'}</EmptyState>}
            {routes && routes.length > 0 && (
              <div className="table-wrap"><table>
                <thead><tr><th>Rota</th><th>Data</th><th>Motorista</th><th>Entregas</th><th>Situação</th><th /></tr></thead>
                <tbody>{routes.map((r) => {
                  const [l, tone] = ROUTE_STATUS[r.status] ?? [r.status, ''];
                  return (
                    <tr key={r.id}>
                      <td>#{r.number}</td><td>{dateBr(r.routeDate)}</td><td>{r.driver.name}{r.driver.plate && <div className="muted" style={{ fontSize: '0.76rem' }}>{r.driver.plate}</div>}</td>
                      <td>{r.totals.delivered} de {r.totals.stops - r.totals.cancelled}{r.totals.failed > 0 && <span className="muted"> · {r.totals.failed} não entregue(s)</span>}</td>
                      <td><span className={`badge ${tone}`}>{l}</span></td><td className="actions"><button className="btn sm" onClick={() => open(r.id)}>Abrir</button></td>
                    </tr>
                  );
                })}</tbody>
              </table></div>
            )}
          </section>

          {detail && (
            <section className="card" aria-label={`Rota ${detail.number}`}>
              <div className="card-head" style={{ flexWrap: 'wrap', gap: 8 }}>
                <h2>Rota #{detail.number} · {dateBr(detail.routeDate)} <span className={`badge ${ROUTE_STATUS[detail.status]?.[1] ?? ''}`}>{ROUTE_STATUS[detail.status]?.[0] ?? detail.status}</span></h2>
                <div className="row">
                  {manage && detail.status === 'PLANNED' && <button className="btn primary" disabled={busy} onClick={start}><Play aria-hidden />Iniciar rota</button>}
                  {editable && pendingStops.length > 1 && <button className="btn" disabled={busy} onClick={() => act(() => api(`/delivery/routes/${detail.id}/auto-sort`, 'POST'), 'Paradas reordenadas por região.')}><Wand2 aria-hidden />Ordenar por região</button>}
                  {link && <a className="btn" href={link} target="_blank" rel="noreferrer"><MapIcon aria-hidden />Abrir no mapa</a>}
                  {editable && !detail.stops.some((s) => s.status === 'DELIVERED') && <button className="btn" disabled={busy} onClick={cancelRoute}>Cancelar rota</button>}
                  <button className="btn ghost" onClick={() => setDetail(null)}>Fechar</button>
                </div>
              </div>
              <RouteFleetCard routeId={detail.id} manage={manage} editable={editable} />
              <p className="muted" style={{ marginTop: 0 }}>Motorista: <strong>{detail.driver.name}</strong>{detail.driver.vehicle || detail.driver.plate ? ` · ${[detail.driver.vehicle, detail.driver.plate].filter(Boolean).join(' ')}` : ''}{detail.notes ? ` · ${detail.notes}` : ''}{detail.cancelReason ? ` · Cancelada: ${detail.cancelReason}` : ''}</p>
              <div className="grid cols-4" style={{ marginBottom: 12 }}>
                <StatCard label="Paradas" value={detail.totals.stops - detail.totals.cancelled} />
                <StatCard label="Pendentes" value={detail.totals.pending} tone={detail.totals.pending ? 'warn' : undefined} />
                <StatCard label="Entregues" value={detail.totals.delivered} tone="ok" />
                <StatCard label="Não entregues" value={detail.totals.failed} tone={detail.totals.failed ? 'danger' : undefined} />
              </div>
              <div className="table-wrap"><table>
                <thead><tr><th>#</th><th>Cliente</th><th>Endereço</th><th>Situação</th><th /></tr></thead>
                <tbody>{detail.stops.filter((s) => s.status !== 'CANCELLED' || detail.status === 'CANCELLED').map((s) => {
                  const [l, tone] = STOP_STATUS[s.status];
                  const pi = pendingStops.findIndex((p) => p.id === s.id);
                  return (
                    <tr key={s.id}>
                      <td><strong>{s.sequence}</strong></td>
                      <td>{s.customerName}{s.customerPhone && <div className="muted" style={{ fontSize: '0.76rem' }}>{formatPhone(s.customerPhone)}</div>}</td>
                      <td>{s.address}</td>
                      <td>
                        <span className={`badge ${tone}`}>{l}</span>
                        {s.status === 'DELIVERED' && <div className="muted" style={{ fontSize: '0.76rem' }}>{s.receiverName} · {s.deliveredAt ? new Date(s.deliveredAt).toLocaleString('pt-BR') : ''}</div>}
                        {s.status === 'FAILED' && <div className="muted" style={{ fontSize: '0.76rem' }}>{s.failureReason}</div>}
                      </td>
                      <td className="actions"><span className="row" style={{ gap: 4, flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
                        {s.status === 'PENDING' && editable && <>
                          <button className="btn sm icon ghost" aria-label="Subir" title="Subir" disabled={busy || pi === 0} onClick={() => move(pi, pi - 1)}><ArrowUp /></button>
                          <button className="btn sm icon ghost" aria-label="Descer" title="Descer" disabled={busy || pi === pendingStops.length - 1} onClick={() => move(pi, pi + 1)}><ArrowDown /></button>
                          <button className="btn sm icon ghost" aria-label="Remover da rota" title="Remover da rota" disabled={busy} onClick={() => act(() => api(`/delivery/routes/${detail.id}/stops/${s.id}`, 'DELETE'), 'Parada removida; o pedido voltou para a fila.')}><Trash2 /></button>
                        </>}
                        {(s.hasProof || s.hasFailurePhoto) && <button className="btn sm" onClick={() => setProof(s)}>{s.hasProof ? 'Ver canhoto' : 'Ver foto'}</button>}
                      </span></td>
                    </tr>
                  );
                })}</tbody>
              </table></div>
              {editable && eligible.length > 0 && (
                <div className="row" style={{ marginTop: 12 }}>
                  <select aria-label="Adicionar pedido à rota" defaultValue="" onChange={(e) => { const v = e.target.value; e.target.value = ''; if (v) void act(() => api(`/delivery/routes/${detail.id}/stops`, 'POST', { orderId: v }), 'Pedido adicionado à rota.'); }} style={{ maxWidth: 360 }}>
                    <option value="">Adicionar pedido à rota…</option>{eligible.map((o) => <option key={o.id} value={o.id}>#{o.number} — {o.customerName}</option>)}
                  </select>
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {proof && (
        <Dialog wide title={proof.hasProof ? `Canhoto — ${proof.customerName}` : `Foto da ocorrência — ${proof.customerName}`} description={proof.address} onClose={() => setProof(null)}>
          <div className="modal-body">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/delivery/stops/${proof.id}/proof?kind=${proof.hasProof ? 'DELIVERY' : 'FAILURE'}`} alt="Foto do canhoto" style={{ width: '100%', maxHeight: '60vh', objectFit: 'contain', background: 'var(--surface-2)', borderRadius: 8 }} />
            <p className="muted" style={{ marginBottom: 0 }}>
              {proof.hasProof ? <>Recebido por <strong>{proof.receiverName}</strong>{proof.receiverDocument ? ` (${proof.receiverDocument})` : ''} em {proof.deliveredAt ? new Date(proof.deliveredAt).toLocaleString('pt-BR') : '—'}.{proof.notes ? ` Obs.: ${proof.notes}` : ''}</> : <>Motivo: {proof.failureReason}</>}
              {proof.lat !== null && proof.lng !== null && <> · <a href={`https://www.google.com/maps?q=${proof.lat},${proof.lng}`} target="_blank" rel="noreferrer">Local da confirmação</a></>}
            </p>
          </div>
          <div className="modal-foot"><button className="btn" onClick={() => setProof(null)}>Fechar</button></div>
        </Dialog>
      )}
    </>
  );
}
