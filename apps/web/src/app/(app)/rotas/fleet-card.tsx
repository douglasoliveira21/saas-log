'use client';

import { FileText, Fuel, Printer } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Dialog, useUi } from '@/components/ui';
import { api } from '@/lib/api';
import { brl } from '@/lib/format';

interface Load { vehicle: { id: string; plate: string; description: string } | null; orders: number; weightKg: number; itemsWithoutWeight: number; value: string; capacityKg: number | null; usedPct: number | null; overCapacity: boolean; cost: string }
interface Vehicle { id: string; plate: string; description: string; capacityKg: number | null; active: boolean }
interface Manifest {
  route: { number: number; date: string; status: string }; vehicle: { plate: string; description: string; capacityKg: number | null } | null; driver: { name: string; phone: string | null };
  stops: { sequence: number; orderNumber: number | null; customer: string; city: string | null; state: string | null; address: string; value: number; documents: { model: string; number: number | null; series: number | null; accessKey: string | null }[] }[];
  states: string[]; weightKg: number; value: string; warnings: string[]; notice: string;
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
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
  function print(m: Manifest) {
    const w = window.open('', '_blank', 'width=900,height=1000');
    if (!w) { ui.toast.error('Libere pop-ups para imprimir.'); return; }
    const rows = m.stops.map((s) => `<tr><td>${s.sequence}</td><td>${s.orderNumber ?? ''}</td><td>${esc(s.customer)}<br><small>${esc(s.address)}</small></td><td>${esc([s.city, s.state].filter(Boolean).join('/'))}</td><td>${s.documents.length ? s.documents.map((d) => `${d.model === '65' ? 'NFC-e' : 'NF-e'} ${d.number ?? ''}<br><small>${esc(d.accessKey ?? '')}</small>`).join('<br>') : '<b style="color:#b00">sem NF-e</b>'}</td><td class="n">${brl(s.value)}</td></tr>`).join('');
    w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Manifesto da viagem ${m.route.number}</title><style>body{font:12px system-ui,sans-serif;margin:24px}table{width:100%;border-collapse:collapse;margin:12px 0}th,td{border-bottom:1px solid #ccc;padding:5px;text-align:left;vertical-align:top}.n{text-align:right}small{color:#555;word-break:break-all}.warn{border:1px solid #b00;padding:8px;margin:8px 0}</style></head><body><h2>Manifesto de carga — viagem #${m.route.number} (${m.route.date})</h2><p>Veículo: <b>${esc(m.vehicle ? `${m.vehicle.plate} — ${m.vehicle.description}` : 'não definido')}</b> · Motorista: <b>${esc(m.driver.name)}</b> · UF(s): ${esc(m.states.join(', ') || '—')} · Peso: <b>${m.weightKg} kg</b>${m.vehicle?.capacityKg ? ` de ${m.vehicle.capacityKg} kg` : ''} · Valor: <b>${brl(m.value)}</b></p>${m.warnings.map((x) => `<div class="warn">${esc(x)}</div>`).join('')}<table><thead><tr><th>#</th><th>Pedido</th><th>Cliente / endereço</th><th>Cidade</th><th>Documento fiscal</th><th class="n">Valor</th></tr></thead><tbody>${rows}</tbody></table><p><small>${esc(m.notice)}</small></p><script>window.onload=()=>window.print()</script></body></html>`);
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
      {manifest && (
        <Dialog title={`Manifesto de carga — viagem #${manifest.route.number}`} description="Documento de conferência. Não é o MDF-e." onClose={() => setManifest(null)} xl>
          <div className="modal-body">
            {manifest.warnings.map((w) => <Alert key={w} kind="warn">{w}</Alert>)}
            <div className="meta" style={{ marginBottom: 12 }}><span><b>Veículo:</b> {manifest.vehicle ? `${manifest.vehicle.plate} — ${manifest.vehicle.description}` : '—'}</span><span><b>Motorista:</b> {manifest.driver.name}</span><span><b>UF:</b> {manifest.states.join(', ') || '—'}</span><span><b>Peso:</b> {manifest.weightKg} kg</span><span><b>Valor:</b> {brl(manifest.value)}</span></div>
            <div className="table-wrap"><table>
              <thead><tr><th>#</th><th>Pedido</th><th>Cliente</th><th>Cidade</th><th>Documento fiscal</th><th className="num">Valor</th></tr></thead>
              <tbody>{manifest.stops.map((s) => (
                <tr key={s.sequence}><td>{s.sequence}</td><td>{s.orderNumber ?? '—'}</td><td>{s.customer}<div className="muted" style={{ fontSize: '0.78rem' }}>{s.address}</div></td><td>{[s.city, s.state].filter(Boolean).join('/')}</td>
                  <td>{s.documents.length ? s.documents.map((d, i) => <div key={i}><span className="badge">{d.model === '65' ? 'NFC-e' : 'NF-e'} {d.number}</span></div>) : <span className="badge danger">sem NF-e autorizada</span>}</td><td className="num">{brl(s.value)}</td></tr>
              ))}</tbody>
            </table></div>
            <p className="muted" style={{ fontSize: '0.8rem' }}>{manifest.notice}</p>
          </div>
          <div className="modal-foot"><button className="btn" onClick={() => print(manifest)}><Printer aria-hidden />Imprimir</button></div>
        </Dialog>
      )}
    </div>
  );
}
