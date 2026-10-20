'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

interface Row { productId: string; sku: string; name: string; minStock: number; onHand: number; reserved: number; blocked: number; available: number }
interface Warehouse { id: string; code: string; name: string; active: boolean }
interface Company { establishments: { warehouses: Warehouse[] }[] }
interface Movement { id: string; type: string; quantity: number; balanceBefore: number; balanceAfter: number; reason: string | null; createdAt: string; product: { sku: string; name: string }; warehouse: { code: string } }

const TYPES: [string, string, boolean][] = [
  ['PURCHASE_ENTRY', 'Entrada por compra', false], ['RETURN_ENTRY', 'Devolução (entrada)', false], ['SALE_EXIT', 'Saída por venda', false],
  ['INTERNAL_USE', 'Uso interno', false], ['LOSS', 'Perda', true], ['DAMAGE', 'Avaria', true], ['ADJUSTMENT', 'Ajuste (+/−)', true],
];
const LABEL = Object.fromEntries([...TYPES.map(([v, l]) => [v, l]), ['TRANSFER_IN', 'Transferência (entrada)'], ['TRANSFER_OUT', 'Transferência (saída)'], ['REVERSAL', 'Estorno']]);

export default function EstoquePage() {
  const { can } = useSession();
  const canMove = can('stock.move');
  const canAdjust = can('stock.adjust');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [movs, setMovs] = useState<Movement[]>([]);
  const [whs, setWhs] = useState<Warehouse[]>([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [panel, setPanel] = useState<'move' | 'transfer' | null>(null);

  const load = useCallback(() => {
    const qs = new URLSearchParams({ limit: '100' });
    if (search) qs.set('search', search);
    if (status) qs.set('status', status);
    api<Row[]>(`/stock/overview?${qs}`).then(setRows).catch((e) => setError(e.message));
    api<{ items: Movement[] }>('/stock/movements?limit=20').then((r) => setMovs(r.items)).catch(() => undefined);
  }, [search, status]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);
  useEffect(() => {
    api<Company[]>('/structure').then((t) => setWhs(t.flatMap((c) => c.establishments.flatMap((e) => e.warehouses)).filter((w) => w.active))).catch(() => undefined);
  }, []);

  const num = (f: FormData, k: string) => Number(String(f.get(k)).replace(',', '.'));

  async function submit(e: FormEvent<HTMLFormElement>, kind: 'move' | 'transfer') {
    e.preventDefault();
    setError(''); setOk('');
    const f = new FormData(e.currentTarget);
    const key = crypto.randomUUID(); // evita lançamento duplicado em duplo clique/reenvio
    try {
      if (kind === 'move') {
        await api('/stock/movements', 'POST', { productId: f.get('productId'), warehouseId: f.get('warehouseId'), type: f.get('type'), quantity: num(f, 'quantity'), reason: f.get('reason') || undefined, idempotencyKey: key });
      } else {
        await api('/stock/transfers', 'POST', { productId: f.get('productId'), fromWarehouseId: f.get('from'), toWarehouseId: f.get('to'), quantity: num(f, 'quantity'), reason: f.get('reason') || undefined, idempotencyKey: key });
      }
      setOk('Movimento registrado.'); setPanel(null); load();
    } catch (err) { setError((err as Error).message); }
  }

  async function reverse(m: Movement) {
    const reason = window.prompt(`Motivo do estorno de "${LABEL[m.type]}" (${m.quantity > 0 ? '+' : ''}${m.quantity}) de ${m.product.sku}:`);
    if (!reason) return;
    setError(''); setOk('');
    try { await api(`/stock/movements/${m.id}/reverse`, 'POST', { reason }); setOk('Movimento estornado.'); load(); } catch (err) { setError((err as Error).message); }
  }

  const productSelect = <select name="productId" required aria-label="Produto">{rows?.map((r) => <option key={r.productId} value={r.productId}>{r.sku} — {r.name}</option>)}</select>;
  const whSelect = (name: string, label: string) => <div><label>{label}</label><select name={name} required>{whs.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select></div>;

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div><h1>Estoque</h1><p className="muted">Disponível = físico − reservado − bloqueado. Movimentos confirmados não são editados: erros são corrigidos com estorno.</p></div>
        {canMove && <div className="row"><button className="btn" onClick={() => setPanel('transfer')}>Transferir</button><button className="btn primary" onClick={() => setPanel('move')}>Movimentar</button></div>}
      </div>
      {error && <div className="alert error" role="alert">{error}</div>}
      {ok && <div className="alert ok" role="status">{ok}</div>}

      {panel === 'move' && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={(e) => submit(e, 'move')}>
          <h2>Novo movimento</h2>
          <div className="form-grid">
            <div><label>Produto</label>{productSelect}</div>
            {whSelect('warehouseId', 'Depósito')}
            <div><label htmlFor="type">Tipo</label><select id="type" name="type" required>{TYPES.filter(([, , crit]) => !crit || canAdjust).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            <div><label htmlFor="quantity">Quantidade (ajuste aceita negativo)</label><input id="quantity" name="quantity" inputMode="numeric" required /></div>
            <div><label htmlFor="reason">Motivo (obrigatório em perdas, avarias e ajustes)</label><input id="reason" name="reason" /></div>
          </div>
          <div className="row" style={{ marginTop: 12 }}><button className="btn primary">Registrar</button><button type="button" className="btn" onClick={() => setPanel(null)}>Cancelar</button></div>
        </form>
      )}
      {panel === 'transfer' && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={(e) => submit(e, 'transfer')}>
          <h2>Transferência entre depósitos</h2>
          <div className="form-grid">
            <div><label>Produto</label>{productSelect}</div>
            {whSelect('from', 'Origem')}{whSelect('to', 'Destino')}
            <div><label htmlFor="tq">Quantidade</label><input id="tq" name="quantity" inputMode="numeric" required /></div>
            <div><label htmlFor="tr">Motivo</label><input id="tr" name="reason" /></div>
          </div>
          <div className="row" style={{ marginTop: 12 }}><button className="btn primary">Transferir</button><button type="button" className="btn" onClick={() => setPanel(null)}>Cancelar</button></div>
        </form>
      )}

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ marginBottom: 12 }}>
          <input aria-label="Buscar" placeholder="Buscar por SKU, nome ou código de barras" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 340 }} />
          <select aria-label="Filtro" value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 220 }}>
            <option value="">Todos</option><option value="below_min">Abaixo do mínimo</option><option value="out">Sem estoque</option>
          </select>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>SKU</th><th>Produto</th><th>Físico</th><th>Reservado</th><th>Bloqueado</th><th>Disponível</th><th>Mínimo</th></tr></thead>
            <tbody>
              {!rows && !error && <tr><td colSpan={7} className="muted">Carregando…</td></tr>}
              {rows?.length === 0 && <tr><td colSpan={7} className="empty">Nenhum produto para exibir. Cadastre produtos em “Produtos e catálogo”.</td></tr>}
              {rows?.map((r) => (
                <tr key={r.productId}>
                  <td>{r.sku}</td><td>{r.name}</td><td>{r.onHand}</td><td>{r.reserved}</td><td>{r.blocked}</td>
                  <td><strong>{r.available}</strong> {r.available <= 0 ? <span className="badge warn">sem estoque</span> : r.available < r.minStock ? <span className="badge warn">abaixo do mínimo</span> : null}</td>
                  <td>{r.minStock}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Últimos movimentos</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Quando</th><th>Produto</th><th>Depósito</th><th>Tipo</th><th>Qtd.</th><th>Saldo</th><th>Motivo</th><th /></tr></thead>
            <tbody>
              {movs.length === 0 && <tr><td colSpan={8} className="empty">Nenhum movimento registrado.</td></tr>}
              {movs.map((m) => (
                <tr key={m.id}>
                  <td>{new Date(m.createdAt).toLocaleString('pt-BR')}</td><td>{m.product.sku}</td><td>{m.warehouse.code}</td><td>{LABEL[m.type] ?? m.type}</td>
                  <td>{m.quantity > 0 ? `+${m.quantity}` : m.quantity}</td><td>{m.balanceBefore} → {m.balanceAfter}</td><td className="muted">{m.reason ?? ''}</td>
                  <td>{canAdjust && !['REVERSAL', 'TRANSFER_IN', 'TRANSFER_OUT'].includes(m.type) && <button className="btn sm" onClick={() => reverse(m)}>Estornar</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
