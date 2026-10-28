'use client';

import { FileText, Fuel, Printer, Truck, User } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Dialog, useUi } from '@/components/ui';
import { api } from '@/lib/api';
import { brl, dateBr } from '@/lib/format';
import { docLabel, kg, manifestHtml, romaneioHtml, ROUTE_STATUS, usedPct, type Manifest } from './manifest-print';

interface Load { vehicle: { id: string; plate: string; description: string } | null; orders: number; weightKg: number; itemsWithoutWeight: number; value: string; capacityKg: number | null; usedPct: number | null; overCapacity: boolean; cost: string }
interface Vehicle { id: string; plate: string; description: string; capacityKg: number | null; active: boolean }
const KINDS: [string, string][] = [['FUEL', 'Combustível'], ['TOLL', 'Pedágio'], ['MAINTENANCE', 'Manutenção'], ['DRIVER', 'Motorista'], ['INSURANCE', 'Seguro'], ['OTHER', 'Outros']];

/** Veículo, carga (peso x capacidade), custos e manifesto de uma viagem. */
export function RouteFleetCard({ routeId, manage, editable }: { routeId: string; manage: boolean; editable: boolean }) {
  const ui = useUi();
  const [load, setLoad] = useState<Load | null>(null); const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [manifest, setManifest] = useState<Manifest | null>(null); const [error, setError] = useState('');
  const refresh = useCallback(() => { api<Load>(`/fleet/routes/${routeId}/load`).then(setLoad).catch((e) => setError(e.message)); }, [routeId]);
  useEffect(refresh, [refresh]);
  useEffect(() => { api<Vehicle[]>('/fleet/vehicles').then((v) => setVehicles(v.filter((x) => x.active))).catch(() => undefined); }, []);

  async function assign(vehicleId: string) {
    setError('');
    try { await api(`/fleet/routes/${routeId}/vehicle`, 'PUT', { vehicleId: vehicleId || null }); refresh(); } catch (e) { setError((e as Error).message); }
  }
  async function addCost() {
    if (!load?.vehicle) return;
    const v = await ui.form({ title: 'Lançar custo da viagem', message: `Veículo ${load.vehicle.plate}.`, confirmLabel: 'Lançar', fields: [
      { name: 'kind', label: 'Tipo', type: 'select', defaultValue: 'FUEL', options: KINDS.map(([value, label]) => ({ value, label })) },
      { name: 'amount', label: 'Valor (R$)', required: true }, { name: 'note', label: 'Observação' },
    ] });
    if (!v) return;
    try { await api('/fleet/costs', 'POST', { vehicleId: load.vehicle.id, routeId, kind: v.kind, amount: Number(String(v.amount).replace(',', '.')), date: new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10), note: v.note || undefined }); ui.toast.ok('Custo lançado.'); refresh(); } catch (e) { ui.toast.error((e as Error).message); }
  }
  async function openManifest() { try { setManifest(await api<Manifest>(`/fleet/routes/${routeId}/manifest`)); } catch (e) { setError((e as Error).message); } }
  function print(m: Manifest, kind: 'manifesto' | 'romaneio' = 'manifesto') {
    const w = window.open('', '_blank', 'width=900,height=1100');
    if (!w) { ui.toast.error('Libere pop-ups para imprimir.'); return; }
    w.document.write((kind === 'romaneio' ? romaneioHtml(m) : manifestHtml(m)).replace('</body>', '<script>window.onload=function(){setTimeout(function(){window.print()},350)}</script></body>'));
    w.document.close();
  }

  return (
    <div className="card" style={{ marginBottom: 12, background: 'var(--surface-2)' }} aria-label="Veículo e carga">
      {error && <Alert kind="error">{error}</Alert>}
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row">
          <label htmlFor="rf-v" className="muted" style={{ fontSize: '0.82rem' }}>Veículo</label>
          <select id="rf-v" value={load?.vehicle?.id ?? ''} disabled={!manage || !editable} onChange={(e) => assign(e.target.value)} style={{ maxWidth: 260 }}>
            <option value="">Sem veículo definido</option>{vehicles.map((v) => <option key={v.id} value={v.id}>{v.plate} — {v.description}{v.capacityKg ? ` (${v.capacityKg} kg)` : ''}</option>)}
          </select>
        </div>
        <div className="row">
          {manage && load?.vehicle && <button className="btn sm" onClick={addCost}><Fuel aria-hidden />Lançar custo</button>}
          <button className="btn sm" onClick={openManifest}><FileText aria-hidden />Manifesto de carga</button>
          {manage && load?.vehicle && <a className="btn sm" href="/fiscal#mdfe">MDF-e</a>}
        </div>
      </div>
      {load && (
        <div style={{ marginTop: 10 }}>
          <div className="meta"><span><b>Carga:</b> {load.weightKg} kg{load.capacityKg ? ` de ${load.capacityKg} kg` : ''}</span><span><b>Pedidos:</b> {load.orders}</span><span><b>Valor:</b> {brl(load.value)}</span><span><b>Custo da viagem:</b> {brl(load.cost)}</span></div>
          {load.usedPct !== null && <div className="progress" aria-hidden style={{ marginTop: 6 }}><span style={{ width: `${Math.min(100, load.usedPct)}%`, background: load.overCapacity ? 'var(--danger)' : load.usedPct >= 85 ? 'var(--warn)' : undefined }} /></div>}
          {load.overCapacity && <Alert kind="warn">A carga passa da capacidade do veículo. Troque o veículo ou divida a viagem.</Alert>}
          {load.itemsWithoutWeight > 0 && <p className="muted" style={{ fontSize: '0.8rem', marginBottom: 0 }}>{load.itemsWithoutWeight} item(ns) sem peso cadastrado: o peso total está subestimado.</p>}
        </div>
      )}
      {manifest && (() => {
        const pct = usedPct(manifest);
        const cls = manifest.overCapacity ? 'bad' : pct !== null && pct >= 85 ? 'warn' : '';
        const withNf = manifest.stops.filter((x) => x.documents.length).length;
        return (
          <Dialog title={`Manifesto de carga — viagem #${manifest.route.number}`} description={`${dateBr(manifest.route.date)} · ${ROUTE_STATUS[manifest.route.status] ?? manifest.route.status}. Documento de conferência, não é o MDF-e.`} onClose={() => setManifest(null)} xl>
            <div className="modal-body mf">
              {manifest.warnings.map((w) => <Alert key={w} kind="warn">{w}</Alert>)}
              <div className="mf-cards">
                <div className="mf-card"><span className="mf-ico"><Truck aria-hidden /></span><div><small>Veículo</small>{manifest.vehicle ? <><span className="mf-plate">{manifest.vehicle.plate}</span><div className="muted">{manifest.vehicle.description}</div></> : <b>Não definido</b>}</div></div>
                <div className="mf-card"><span className="mf-ico"><User aria-hidden /></span><div><small>Motorista</small><b>{manifest.driver.name}</b>{manifest.driver.phone && <div className="muted">{manifest.driver.phone}</div>}</div></div>
                <div className="mf-card wide"><div style={{ width: '100%' }}><small>Carga x capacidade</small><b>{kg(manifest.weightKg)}{manifest.vehicle?.capacityKg ? ` de ${kg(manifest.vehicle.capacityKg)}` : ''}</b>
                  {pct !== null ? <><div className={`mf-cap ${cls}`} role="progressbar" aria-valuenow={Math.min(100, pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Uso da capacidade do veículo"><i style={{ width: `${Math.min(100, pct)}%` }} /></div><div className="muted" style={{ fontSize: '0.8rem' }}>{pct}% da capacidade{manifest.overCapacity ? ' — excede' : ''}</div></> : <div className="muted" style={{ fontSize: '0.8rem' }}>Capacidade do veículo não informada</div>}
                </div></div>
              </div>
              <div className="mf-kpis">
                <div><b>{manifest.stops.length}</b><small>Paradas</small></div>
                <div><b>{brl(manifest.value)}</b><small>Valor da carga</small></div>
                <div><b>{manifest.states.join(', ') || '—'}</b><small>UF de destino</small></div>
                <div className={withNf < manifest.stops.length ? 'bad' : ''}><b>{withNf}/{manifest.stops.length}</b><small>Com NF-e</small></div>
              </div>
              <div className="table-wrap"><table>
                <thead><tr><th>Ordem</th><th>Pedido</th><th>Cliente / endereço</th><th>Cidade</th><th>Documento fiscal</th><th className="num">Valor</th></tr></thead>
                <tbody>{manifest.stops.map((s) => (
                  <tr key={s.sequence}>
                    <td><span className="mf-seq">{s.sequence}</span></td><td>{s.orderNumber ?? '—'}</td>
                    <td><strong>{s.customer}</strong><div className="muted" style={{ fontSize: '0.78rem' }}>{s.address}</div>{s.phone && <div className="muted" style={{ fontSize: '0.76rem' }}>{s.phone}</div>}</td>
                    <td>{[s.city, s.state].filter(Boolean).join('/')}</td>
                    <td>{s.documents.length ? s.documents.map((d, i) => <div key={i}><span className="badge ok">{docLabel(d)} {d.number}{d.series != null ? `/${d.series}` : ''}</span></div>) : <span className="badge danger">sem NF-e autorizada</span>}</td>
                    <td className="num">{brl(s.value)}</td>
                  </tr>
                ))}</tbody>
              </table></div>
              {manifest.route.notes && <p className="muted" style={{ fontSize: '0.84rem' }}>Observações da viagem: {manifest.route.notes}</p>}
              <p className="muted" style={{ fontSize: '0.8rem' }}>{manifest.notice}</p>
            </div>
            <div className="modal-foot"><button className="btn" onClick={() => setManifest(null)}>Fechar</button><button className="btn" onClick={() => print(manifest, 'romaneio')}><Printer aria-hidden />Imprimir romaneio</button><button className="btn primary" onClick={() => print(manifest)}><Printer aria-hidden />Imprimir manifesto</button></div>
          </Dialog>
        );
      })()}
    </div>
  );
}
