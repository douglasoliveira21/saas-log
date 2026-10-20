'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { useUi, PageHeader, Alert, Skeleton } from '@/components/ui';
import { useSession } from '@/lib/session';

interface Count { id: string; name: string; status: string; createdAt: string; warehouse: { code: string; name: string }; _count: { items: number } }
interface Item { productId: string; systemQty: number; countedQty: number | null; divergence: number | null; product: { sku: string; name: string; barcode: string | null } }
interface Detail extends Omit<Count, '_count'> { items: Item[] }
interface Company { establishments: { warehouses: { id: string; code: string; name: string; active: boolean }[] }[] }

const STATUS: Record<string, string> = { OPEN: 'Em contagem', SUBMITTED: 'Aguardando aprovação', APPROVED: 'Aprovado', REJECTED: 'Rejeitado' };

export default function InventarioPage() {
  const { can } = useSession();
  const ui = useUi();
  const [counts, setCounts] = useState<Count[] | null>(null);
  const [whs, setWhs] = useState<{ id: string; code: string; name: string }[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [draft, setDraft] = useState<Record<string, string>>({});

  const load = useCallback(() => { api<Count[]>('/inventory/counts').then(setCounts).catch((e) => setError(e.message)); }, []);
  useEffect(load, [load]);
  useEffect(() => { api<Company[]>('/structure').then((t) => setWhs(t.flatMap((c) => c.establishments.flatMap((e) => e.warehouses)).filter((w) => w.active))).catch(() => undefined); }, []);

  const open = useCallback(async (id: string) => {
    setError(''); setDraft({});
    try { setDetail(await api<Detail>(`/inventory/counts/${id}`)); } catch (e) { setError((e as Error).message); }
  }, []);

  const act = async (fn: () => Promise<unknown>, message: string) => {
    setError(''); setOk('');
    try { await fn(); setOk(message); load(); if (detail) await open(detail.id); } catch (e) { setError((e as Error).message); }
  };

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(''); setOk('');
    try {
      const r = await api<{ id: string }>('/inventory/counts', 'POST', { warehouseId: f.get('warehouseId'), name: f.get('name') });
      e.currentTarget.reset(); load(); await open(r.id); setOk('Contagem aberta com o retrato dos saldos atuais.');
    } catch (err) { setError((err as Error).message); }
  }

  const saveDrafts = () => act(() => api(`/inventory/counts/${detail!.id}/items`, 'PUT', {
    entries: Object.entries(draft).filter(([, v]) => v !== '').map(([productId, v]) => ({ productId, countedQty: Number(v) })),
  }), 'Contagens lançadas.');

  async function scan(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const form = e.currentTarget;
    await act(() => api(`/inventory/counts/${detail!.id}/items`, 'PUT', { entries: [{ code: String(f.get('code')).trim(), countedQty: Number(f.get('qty')) }] }), 'Leitura registrada.');
    form.reset();
  }

  return (
    <>
      <PageHeader title="Inventário" description={<>Contagem → envio → aprovação. Só a aprovação gera ajustes no estoque, um movimento auditável por divergência.</>} />
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}

      {can('inventory.count') && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={create}>
          <h2>Abrir contagem</h2>
          <div className="form-grid">
            <div><label htmlFor="w">Depósito</label><select id="w" name="warehouseId" required>{whs.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select></div>
            <div><label htmlFor="n">Nome</label><input id="n" name="name" required placeholder="Contagem cíclica — corredor A" /></div>
          </div>
          <div style={{ marginTop: 12 }}><button className="btn primary">Abrir</button></div>
        </form>
      )}

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Contagem</th><th>Depósito</th><th>Itens</th><th>Situação</th><th>Aberta em</th><th /></tr></thead>
            <tbody>
              {!counts && !error && <tr><td colSpan={6}><Skeleton rows={3} /></td></tr>}
              {counts?.length === 0 && <tr><td colSpan={6} className="empty">Nenhuma contagem aberta ainda.</td></tr>}
              {counts?.map((c) => (
                <tr key={c.id}><td>{c.name}</td><td>{c.warehouse.code}</td><td>{c._count.items}</td><td><span className="badge">{STATUS[c.status]}</span></td>
                  <td>{new Date(c.createdAt).toLocaleDateString('pt-BR')}</td><td><button className="btn sm" onClick={() => open(c.id)}>Abrir</button></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {detail && (
        <section className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2>{detail.name} <span className="badge">{STATUS[detail.status]}</span></h2>
            <div className="row">
              {detail.status === 'OPEN' && can('inventory.count') && <button className="btn" onClick={() => act(() => api(`/inventory/counts/${detail.id}/submit`, 'POST'), 'Enviada para aprovação.')}>Enviar para aprovação</button>}
              {detail.status === 'SUBMITTED' && can('stock.approve') && <>
                <button className="btn primary" onClick={async () => { if (await ui.confirm({ title: 'Aprovar inventário?', message: 'Os ajustes de estoque serão aplicados e só podem ser desfeitos por estorno.', confirmLabel: 'Aprovar e ajustar' })) void act(() => api(`/inventory/counts/${detail.id}/approve`, 'POST'), 'Inventário aprovado e ajustes aplicados.'); }}>Aprovar e ajustar</button>
                <button className="btn" onClick={() => act(() => api(`/inventory/counts/${detail.id}/reject`, 'POST'), 'Inventário rejeitado.')}>Rejeitar</button>
              </>}
            </div>
          </div>
          {detail.status === 'OPEN' && can('inventory.count') && (
            <form className="row" onSubmit={scan} style={{ marginBottom: 12 }}>
              <input name="code" placeholder="Leia o código de barras ou digite o SKU" required style={{ maxWidth: 320 }} aria-label="Código lido" />
              <input name="qty" type="number" min={0} placeholder="Qtd." required style={{ maxWidth: 100 }} aria-label="Quantidade contada" />
              <button className="btn">Registrar leitura</button>
            </form>
          )}
          <div className="table-wrap">
            <table>
              <thead><tr><th>SKU</th><th>Produto</th><th>Sistema</th><th>Contado</th><th>Divergência</th></tr></thead>
              <tbody>
                {detail.items.length === 0 && <tr><td colSpan={5} className="empty">Sem itens. Registre leituras acima.</td></tr>}
                {detail.items.map((i) => (
                  <tr key={i.productId}>
                    <td>{i.product.sku}</td><td>{i.product.name}</td><td>{i.systemQty}</td>
                    <td>{detail.status === 'OPEN' && can('inventory.count')
                      ? <input type="number" min={0} aria-label={`Contagem de ${i.product.sku}`} style={{ width: 90 }} value={draft[i.productId] ?? (i.countedQty ?? '')} onChange={(e) => setDraft({ ...draft, [i.productId]: e.target.value })} />
                      : (i.countedQty ?? '—')}</td>
                    <td>{i.divergence == null ? '—' : <span className={`badge ${i.divergence === 0 ? 'ok' : 'warn'}`}>{i.divergence > 0 ? `+${i.divergence}` : i.divergence}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {detail.status === 'OPEN' && Object.keys(draft).length > 0 && <p><button className="btn primary" onClick={saveDrafts}>Salvar contagens digitadas</button></p>}
        </section>
      )}
    </>
  );
}
