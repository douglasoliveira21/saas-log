'use client';

import { CloudDownload, Link2, Search } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Dialog, EmptyState, useUi } from '@/components/ui';
import { api } from '@/lib/api';
import { brl } from '@/lib/format';

interface Item {
  id: string; externalId: string; title: string | null; sku: string | null; gtin: string | null; price: string | null; quantity: number | null; channelStatus: string | null; permalink: string | null;
  status: 'NEW' | 'LINKED' | 'IMPORTED' | 'IGNORED'; matchedBy: string | null; pictureCount: number; product: { id: string; sku: string; name: string } | null;
}
interface ProductLite { id: string; sku: string; name: string }

const LABEL: Record<string, string> = { NEW: 'Novos', LINKED: 'Vinculados', IMPORTED: 'Importados', IGNORED: 'Ignorados', ALL: 'Todos' };
const CH_STATUS: Record<string, string> = { active: 'Ativo', paused: 'Pausado', closed: 'Encerrado', under_review: 'Em revisão' };

/** Anúncios que já existem no canal: aparece o que ainda não está na base e você decide importar (com fotos), vincular a um produto ou ignorar. */
export function ChannelCatalog({ connectionId, supported, manage, canImport }: { connectionId: string; supported: boolean; manage: boolean; canImport: boolean }) {
  const ui = useUi();
  const [filter, setFilter] = useState('NEW');
  const [data, setData] = useState<{ counts: Record<string, number>; items: Item[] } | null>(null);
  const [busy, setBusy] = useState('');
  const [linking, setLinking] = useState<Item | null>(null);

  const load = useCallback(() => api<NonNullable<typeof data>>(`/integrations/connections/${connectionId}/catalog/items${filter === 'ALL' ? '' : `?status=${filter}`}`).then(setData).catch((e) => ui.toast.error(e.message)), [connectionId, filter, ui]);
  useEffect(() => { void load(); }, [load]);

  async function scan() {
    setBusy('scan');
    let cursor: string | null = null; let read = 0; let created = 0;
    try {
      for (let i = 0; i < 60; i++) {
        const r: { scanned: number; created: number; nextCursor: string | null } = await api(`/integrations/connections/${connectionId}/catalog/scan`, 'POST', cursor ? { cursor } : {});
        read += r.scanned; created += r.created; cursor = r.nextCursor;
        setBusy(`Lendo anúncios… ${read}`);
        if (!cursor) break;
      }
      ui.toast.ok(`${read} anúncio(s) lido(s); ${created} novo(s) no canal em relação à última leitura.`);
      if (cursor) ui.toast.info('A leitura foi parcial (muitos anúncios). Rode de novo para continuar.');
    } catch (e) { ui.toast.error((e as Error).message); }
    setBusy(''); await load();
  }

  async function importOne(it: Item) {
    setBusy(it.id);
    try {
      const r = await api<{ productId: string; warnings: string[] }>(`/integrations/connections/${connectionId}/catalog/items/${it.id}/import`, 'POST');
      ui.toast.ok(`Produto criado${r.warnings.length ? ` (com ${r.warnings.length} aviso(s) nas fotos)` : ' com as fotos do anúncio'}.`);
      if (r.warnings.length) ui.toast.info(r.warnings.slice(0, 2).join(' · '));
    } catch (e) { ui.toast.error((e as Error).message); }
    setBusy(''); await load();
  }
  async function importAll() {
    if (!(await ui.confirm({ title: 'Importar os novos?', message: 'Cria um produto (com fotos) para cada anúncio novo sem correspondência na base, até 25 por vez. Os que têm o mesmo SKU/GTIN de um produto existente ficam para você vincular.', confirmLabel: 'Importar' }))) return;
    setBusy('all');
    try {
      const r = await api<{ processed: number; imported: number; failed: number; results: { title: string | null; ok: boolean; error?: string }[] }>(`/integrations/connections/${connectionId}/catalog/import-new`, 'POST');
      ui.toast.ok(`${r.imported} importado(s)${r.failed ? `, ${r.failed} com problema` : ''}.`);
      const first = r.results.find((x) => !x.ok);
      if (first) ui.toast.error(`${first.title ?? 'Item'}: ${first.error}`);
    } catch (e) { ui.toast.error((e as Error).message); }
    setBusy(''); await load();
  }
  async function link(it: Item, productId: string) {
    try { await api(`/integrations/connections/${connectionId}/catalog/items/${it.id}/link`, 'POST', { productId }); ui.toast.ok('Anúncio vinculado ao produto.'); setLinking(null); await load(); } catch (e) { ui.toast.error((e as Error).message); }
  }
  async function ignore(it: Item, v: boolean) {
    try { await api(`/integrations/connections/${connectionId}/catalog/items/${it.id}/ignore`, 'POST', { ignore: v }); await load(); } catch (e) { ui.toast.error((e as Error).message); }
  }

  if (!supported) return <p className="muted">Este canal ainda não permite ler os anúncios (importar para a base).</p>;
  const counts = data?.counts ?? {};
  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>Traz para cá os anúncios que já existem no canal. Nada é criado sozinho: você escolhe importar (cria o produto com as fotos), vincular a um produto que já existe ou ignorar.</p>
      <div className="toolbar">
        <div className="tabs" role="tablist" style={{ margin: 0, border: 0, flex: 1 }}>
          {['NEW', 'LINKED', 'IMPORTED', 'IGNORED', 'ALL'].map((k) => (
            <button key={k} role="tab" aria-selected={filter === k} className={`tab ${filter === k ? 'active' : ''}`} onClick={() => setFilter(k)}>{LABEL[k]}{k !== 'ALL' && counts[k] ? ` (${counts[k]})` : ''}</button>
          ))}
        </div>
        {manage && <button className={`btn ${busy === 'scan' ? 'loading' : ''}`} disabled={!!busy} onClick={scan}><Search aria-hidden />{busy.startsWith('Lendo') ? busy : 'Buscar anúncios no canal'}</button>}
        {manage && canImport && (counts.NEW ?? 0) > 0 && <button className={`btn primary ${busy === 'all' ? 'loading' : ''}`} disabled={!!busy} onClick={importAll}><CloudDownload aria-hidden />Importar novos</button>}
      </div>
      {data && data.items.length === 0 && <EmptyState title={filter === 'NEW' ? 'Nenhum anúncio novo' : 'Nada por aqui'}>{Object.keys(counts).length ? 'Mude o filtro para ver os outros anúncios.' : 'Clique em “Buscar anúncios no canal” para ler o que já está publicado.'}</EmptyState>}
      {data && data.items.length > 0 && (
        <div className="table-wrap"><table>
          <thead><tr><th>Anúncio no canal</th><th>SKU</th><th className="num">Preço</th><th className="num">Qtd.</th><th>Correspondência na base</th><th /></tr></thead>
          <tbody>
            {data.items.map((it) => (
              <tr key={it.id}>
                <td>{it.permalink ? <a href={it.permalink} target="_blank" rel="noreferrer">{it.title}</a> : it.title}<div className="muted" style={{ fontSize: '0.78rem' }}>{it.externalId}{it.channelStatus && ` · ${CH_STATUS[it.channelStatus] ?? it.channelStatus}`}{` · ${it.pictureCount} foto(s)`}</div></td>
                <td className="mono">{it.sku ?? '—'}</td>
                <td className="num">{it.price ? brl(it.price) : '—'}</td>
                <td className="num">{it.quantity ?? '—'}</td>
                <td>
                  {it.status === 'IMPORTED' && <span className="badge ok">Importado</span>}
                  {it.status === 'LINKED' && <span className="badge ok">Vinculado</span>}
                  {it.status === 'IGNORED' && <span className="badge">Ignorado</span>}
                  {it.product && <div style={{ fontSize: '0.84rem', marginTop: 2 }}>{it.status === 'NEW' ? <span className="badge warn" title="Mesmo código encontrado na base">mesmo {it.matchedBy === 'GTIN' ? 'GTIN' : 'SKU'}</span> : null} <Link href={`/produtos/${it.product.id}`}>{it.product.sku} — {it.product.name}</Link></div>}
                  {it.status === 'NEW' && !it.product && <span className="muted">Não existe na base</span>}
                </td>
                <td className="actions">
                  {manage && it.status === 'NEW' && (
                    <span className="row" style={{ gap: 6, flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
                      {it.product ? <button className="btn sm primary" disabled={!!busy} onClick={() => link(it, it.product!.id)}><Link2 aria-hidden />Vincular a {it.product.sku}</button>
                        : canImport && <button className={`btn sm primary ${busy === it.id ? 'loading' : ''}`} disabled={!!busy} onClick={() => importOne(it)}><CloudDownload aria-hidden />Importar</button>}
                      <button className="btn sm" disabled={!!busy} onClick={() => setLinking(it)}>{it.product ? 'Outro produto…' : 'Vincular…'}</button>
                      <button className="btn sm ghost" disabled={!!busy} onClick={() => ignore(it, true)}>Ignorar</button>
                    </span>
                  )}
                  {manage && it.status === 'IGNORED' && <button className="btn sm" onClick={() => ignore(it, false)}>Restaurar</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {linking && <LinkDialog item={linking} onClose={() => setLinking(null)} onPick={(pid) => link(linking, pid)} />}
    </div>
  );
}

function LinkDialog({ item, onClose, onPick }: { item: Item; onClose: () => void; onPick: (productId: string) => void }) {
  const [q, setQ] = useState(item.sku ?? '');
  const [rows, setRows] = useState<ProductLite[] | null>(null);
  useEffect(() => {
    const t = setTimeout(() => { api<{ items: ProductLite[] }>(`/products?limit=10${q ? `&search=${encodeURIComponent(q)}` : ''}`).then((r) => setRows(r.items)).catch(() => setRows([])); }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <Dialog title="Vincular a um produto" description={<>Anúncio: <strong>{item.title}</strong>. Depois de vinculado, preço e estoque passam a seguir o produto escolhido.</>} onClose={onClose}>
      <div className="modal-body">
        <label htmlFor="lk">Buscar produto (SKU, nome ou código de barras)</label>
        <input id="lk" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <ul className="pick-list">
          {rows?.length === 0 && <li className="muted">Nenhum produto encontrado.</li>}
          {rows?.map((p) => <li key={p.id}><button type="button" className="btn sm" onClick={() => onPick(p.id)}>Vincular</button> <span className="mono">{p.sku}</span> — {p.name}</li>)}
        </ul>
      </div>
      <div className="modal-foot"><button className="btn" onClick={onClose}>Cancelar</button></div>
    </Dialog>
  );
}
