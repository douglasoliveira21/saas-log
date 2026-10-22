'use client';

import { MapPin, PackageOpen, Plus } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Dialog, EmptyState, Skeleton, useUi } from '@/components/ui';
import { api } from '@/lib/api';
import { dateBr } from '@/lib/format';

interface Wh { id: string; code: string; name: string }
interface Loc { id: string; code: string; description: string | null; active: boolean; units: number; products: number; warehouse: string }
interface Pending { productId: string; sku: string; name: string; lotId: string | null; lotCode: string | null; expiresAt: string | null; pending: number }
interface LocItems { code: string; items: { id: string; sku: string; name: string; lotCode: string | null; expiresAt: string | null; quantity: number }[] }

/** Endereços do depósito (rua-prédio-nível): criar, guardar a mercadoria e ver o que há em cada um. */
export function LocationsTab({ warehouses, canManage, canMove }: { warehouses: Wh[]; canManage: boolean; canMove: boolean }) {
  const ui = useUi();
  const [wh, setWh] = useState(warehouses[0]?.id ?? '');
  const [locs, setLocs] = useState<Loc[] | null>(null);
  const [pending, setPending] = useState<Pending[] | null>(null);
  const [view, setView] = useState<LocItems | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { if (!wh && warehouses[0]) setWh(warehouses[0].id); }, [warehouses, wh]);
  const load = useCallback(() => {
    if (!wh) return;
    setError('');
    api<Loc[]>(`/warehouse/locations?warehouseId=${wh}`).then(setLocs).catch((e) => setError(e.message));
    api<Pending[]>(`/warehouse/unaddressed?warehouseId=${wh}`).then(setPending).catch(() => setPending([]));
  }, [wh]);
  useEffect(load, [load]);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget; const f = new FormData(form);
    try {
      await api('/warehouse/locations', 'POST', { warehouseId: wh, code: String(f.get('code')), description: String(f.get('description') || '') || undefined });
      form.reset(); ui.toast.ok('Endereço criado.'); load();
    } catch (err) { setError((err as Error).message); }
  }
  async function store(p: Pending) {
    const v = await ui.form({ title: `Guardar ${p.sku}${p.lotCode ? ` · lote ${p.lotCode}` : ''}`, message: `${p.pending} unidade(s) ainda sem endereço.`, confirmLabel: 'Guardar', fields: [{ name: 'loc', label: 'Endereço (ex.: A-01-02)', required: true }, { name: 'qty', label: 'Quantidade', type: 'number', defaultValue: p.pending, min: 1, max: p.pending, required: true }] });
    if (!v) return;
    try {
      await api('/warehouse/putaway', 'POST', { warehouseId: wh, productId: p.productId, lotId: p.lotId ?? undefined, locationCode: v.loc, quantity: Number(v.qty) });
      ui.toast.ok('Mercadoria guardada.'); load();
    } catch (err) { ui.toast.error((err as Error).message); }
  }
  async function open(l: Loc) { try { setView(await api<LocItems>(`/warehouse/locations/${l.id}/items`)); } catch (e) { setError((e as Error).message); } }

  return (
    <div className="stack">
      {error && <Alert kind="error">{error}</Alert>}
      <div className="toolbar">
        <div><label htmlFor="lc-w" className="muted" style={{ fontSize: '0.8rem' }}>Depósito</label><select id="lc-w" value={wh} onChange={(e) => setWh(e.target.value)}>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select></div>
      </div>
      {canManage && (
        <form className="card" onSubmit={create}>
          <h2>Novo endereço</h2>
          <div className="form-grid">
            <div><label htmlFor="lc-c">Código *</label><input id="lc-c" name="code" required maxLength={40} placeholder="A-01-02 (rua, prédio, nível)" /></div>
            <div><label htmlFor="lc-d">Descrição</label><input id="lc-d" name="description" maxLength={200} /></div>
          </div>
          <div className="row" style={{ marginTop: 12 }}><button className="btn primary"><Plus aria-hidden />Criar endereço</button></div>
        </form>
      )}
      <section className="card">
        <h2>Para guardar (sem endereço)</h2>
        {!pending && <Skeleton rows={2} />}
        {pending && pending.length === 0 && <p className="muted" style={{ marginBottom: 0 }}>Tudo o que está no estoque deste depósito já tem endereço.</p>}
        {pending && pending.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th>Produto</th><th>Lote</th><th className="num">Sem endereço</th><th /></tr></thead>
            <tbody>{pending.map((p) => (
              <tr key={`${p.productId}-${p.lotId}`}>
                <td><strong>{p.name}</strong><div className="muted mono" style={{ fontSize: '0.78rem' }}>{p.sku}</div></td>
                <td>{p.lotCode ? <span className="mono">{p.lotCode}</span> : '—'}{p.expiresAt && <div className="muted" style={{ fontSize: '0.76rem' }}>vence {dateBr(p.expiresAt)}</div>}</td>
                <td className="num">{p.pending}</td>
                <td>{canMove && <button className="btn sm" onClick={() => store(p)}>Guardar</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      <section className="card">
        <h2>Endereços</h2>
        {!locs && <Skeleton rows={3} />}
        {locs && locs.length === 0 && <EmptyState icon={<MapPin size={22} />} title="Nenhum endereço neste depósito">Crie endereços (ex.: A-01-01) para saber onde cada produto está e para a lista de separação indicar o caminho.</EmptyState>}
        {locs && locs.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th>Endereço</th><th>Descrição</th><th className="num">Produtos</th><th className="num">Unidades</th><th>Situação</th><th /></tr></thead>
            <tbody>{locs.map((l) => (
              <tr key={l.id} style={l.active ? undefined : { opacity: 0.55 }}>
                <td className="mono"><strong>{l.code}</strong></td><td>{l.description ?? '—'}</td><td className="num">{l.products}</td><td className="num">{l.units}</td>
                <td><span className={`badge ${l.active ? 'ok' : ''}`}>{l.active ? 'Ativo' : 'Inativo'}</span></td>
                <td className="actions">
                  <button className="btn sm" onClick={() => open(l)}><PackageOpen aria-hidden />Ver</button>
                  {canManage && <button className="btn sm" onClick={async () => { try { await api(`/warehouse/locations/${l.id}`, 'PUT', { active: !l.active }); load(); } catch (e) { ui.toast.error((e as Error).message); } }}>{l.active ? 'Desativar' : 'Ativar'}</button>}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {view && (
        <Dialog title={`Endereço ${view.code}`} onClose={() => setView(null)}>
          <div className="modal-body">
            {view.items.length === 0 ? <p className="muted">Vazio.</p> : (
              <div className="table-wrap"><table>
                <thead><tr><th>Produto</th><th>Lote</th><th className="num">Qtd.</th></tr></thead>
                <tbody>{view.items.map((i) => <tr key={i.id}><td>{i.sku} — {i.name}</td><td>{i.lotCode ?? '—'}{i.expiresAt ? ` · vence ${dateBr(i.expiresAt)}` : ''}</td><td className="num">{i.quantity}</td></tr>)}</tbody>
              </table></div>
            )}
          </div>
        </Dialog>
      )}
    </div>
  );
}
