'use client';

import { useEffect, useState } from 'react';
import { Dialog, useUi } from '@/components/ui';
import { api } from '@/lib/api';

interface Bal { warehouseId: string; warehouse: { code: string; name: string }; onHand: number; reserved: number; blocked: number; available: number }
interface Wh { id: string; code: string; name: string }
export interface StockProduct { productId: string; sku: string; name: string }

/**
 * Editar: define a quantidade física de um depósito (gera um ajuste com a diferença e o motivo).
 * Excluir: zera o estoque do produto em todos os depósitos (também por ajustes). Nada é apagado do histórico — fica rastreável e pode ser estornado.
 */
export function StockDialog({ mode, product, warehouses, onClose, onDone }: { mode: 'edit' | 'delete'; product: StockProduct; warehouses: Wh[]; onClose: () => void; onDone: (msg: string) => void }) {
  const ui = useUi();
  const [bals, setBals] = useState<Bal[] | null>(null);
  const [wh, setWh] = useState('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState(mode === 'delete' ? 'Exclusão de estoque' : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Bal[]>(`/stock/balances/${product.productId}`).then((b) => {
      const all = warehouses.map((w) => b.find((x) => x.warehouseId === w.id) ?? { warehouseId: w.id, warehouse: { code: w.code, name: w.name }, onHand: 0, reserved: 0, blocked: 0, available: 0 });
      setBals(all);
      const first = all.find((x) => x.onHand > 0) ?? all[0];
      if (first) { setWh(first.warehouseId); setQty(String(first.onHand)); }
    }).catch((e) => setError(e.message));
  }, [product.productId, warehouses]);

  const cur = bals?.find((b) => b.warehouseId === wh);
  const n = Number(qty);
  const floor = cur ? cur.reserved + cur.blocked : 0;
  const valid = qty.trim() !== '' && Number.isInteger(n) && n >= 0;
  const delta = cur && valid ? n - cur.onHand : 0;

  async function save() {
    if (!cur || !valid) return;
    setBusy(true); setError('');
    try {
      await api('/stock/set-on-hand', 'POST', { productId: product.productId, warehouseId: wh, newOnHand: n, reason: reason.trim(), idempotencyKey: crypto.randomUUID() });
      onDone(`Estoque de ${product.sku} em ${cur.warehouse.code}: ${cur.onHand} → ${n}.`);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  async function wipe() {
    const targets = (bals ?? []).filter((b) => b.onHand > 0);
    if (!(await ui.confirm({ title: `Excluir o estoque de ${product.sku}?`, message: `Zera o saldo físico em ${targets.length} depósito(s) (${targets.reduce((s, b) => s + b.onHand, 0)} un.). Cada baixa fica registrada no histórico e pode ser estornada.`, danger: true, confirmLabel: 'Excluir estoque', cancelLabel: 'Voltar' }))) return;
    setBusy(true); setError('');
    let done = 0;
    try {
      for (const b of targets) {
        await api('/stock/set-on-hand', 'POST', { productId: product.productId, warehouseId: b.warehouseId, newOnHand: 0, reason: reason.trim(), idempotencyKey: crypto.randomUUID() });
        done++;
      }
      onDone(`Estoque de ${product.sku} excluído (${done} depósito(s) zerado(s)).`);
    } catch (e) {
      setError(`${(e as Error).message}${done ? ` (${done} depósito(s) já foram zerados.)` : ''}`); setBusy(false);
      if (done) onDone(`Estoque de ${product.sku} parcialmente excluído (${done} depósito(s)).`);
    }
  }

  if (mode === 'delete') {
    const blocked = (bals ?? []).filter((b) => b.reserved + b.blocked > 0);
    const has = (bals ?? []).some((b) => b.onHand > 0);
    return (
      <Dialog title="Excluir estoque" description={<><strong>{product.sku}</strong> — {product.name}. O saldo físico vai a zero; o histórico de movimentos é mantido.</>} onClose={onClose}>
        <div className="modal-body">
          {error && <div className="alert error" role="alert">{error}</div>}
          {bals && !has && <p className="muted">Este produto já está sem estoque físico.</p>}
          {bals && has && (
            <div className="table-wrap"><table>
              <thead><tr><th>Depósito</th><th className="num">Físico</th><th className="num">Reservado</th><th className="num">Bloqueado</th></tr></thead>
              <tbody>{bals.filter((b) => b.onHand > 0).map((b) => <tr key={b.warehouseId}><td>{b.warehouse.code} — {b.warehouse.name}</td><td className="num">{b.onHand}</td><td className="num">{b.reserved}</td><td className="num">{b.blocked}</td></tr>)}</tbody>
            </table></div>
          )}
          {blocked.length > 0 && <p className="alert warn" role="status">Há reservas/bloqueios em {blocked.map((b) => b.warehouse.code).join(', ')}. Libere-os (cancele ou envie os pedidos) antes de excluir.</p>}
          <label htmlFor="sd-reason">Motivo</label>
          <input id="sd-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className={`btn danger ${busy ? 'loading' : ''}`} disabled={busy || !has || blocked.length > 0 || !reason.trim()} onClick={wipe}>Excluir estoque</button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="Editar estoque" description={<><strong>{product.sku}</strong> — {product.name}. Informe a quantidade física que existe de verdade no depósito; o sistema registra a diferença como ajuste.</>} onClose={onClose}>
      <div className="modal-body">
        {error && <div className="alert error" role="alert">{error}</div>}
        {!bals && !error && <p className="muted">Carregando saldos…</p>}
        {bals && bals.length === 0 && <p className="muted">Cadastre um depósito antes de ajustar o estoque.</p>}
        {bals && bals.length > 0 && (
          <div className="form-grid">
            <div>
              <label htmlFor="se-wh">Depósito</label>
              <select id="se-wh" value={wh} onChange={(e) => { setWh(e.target.value); setQty(String(bals.find((b) => b.warehouseId === e.target.value)?.onHand ?? 0)); }}>
                {bals.map((b) => <option key={b.warehouseId} value={b.warehouseId}>{b.warehouse.code} — {b.warehouse.name} (físico {b.onHand})</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="se-qty">Nova quantidade física</label>
              <input id="se-qty" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} autoFocus />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="se-reason">Motivo (obrigatório)</label>
              <input id="se-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: contagem física, correção de lançamento" maxLength={300} />
            </div>
          </div>
        )}
        {cur && (
          <p className="muted" style={{ marginBottom: 0 }}>
            Hoje: <strong>{cur.onHand}</strong> físico · {cur.reserved} reservado · {cur.blocked} bloqueado.{' '}
            {valid && delta !== 0 && n >= floor && <>Vai registrar um ajuste de <strong>{delta > 0 ? `+${delta}` : delta}</strong>.</>}
            {valid && delta === 0 && 'A quantidade é a mesma de hoje.'}
            {valid && n < floor && <span style={{ color: 'var(--danger)' }}> Mínimo possível: {floor} (reservado + bloqueado).</span>}
          </p>
        )}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>Cancelar</button>
        <button className={`btn primary ${busy ? 'loading' : ''}`} disabled={busy || !cur || !valid || delta === 0 || n < floor || !reason.trim()} onClick={save}>Salvar</button>
      </div>
    </Dialog>
  );
}
