'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { dateBr } from '@/lib/format';

interface Row { returnId: string; orderNumber: number; customer: string; createdAt: string; reason: string; items: { sku: string; quantity: number }[]; original: { id: string; number: number | null; series: number | null; model: string } | null; blocked: string | null }

/** Devoluções registradas em Vendas que podem virar NF-e de devolução (entrada própria referenciando a nota da venda). */
export function ReturnsCard({ act, open, reloadList }: { act: (fn: () => Promise<unknown>, message: string, reload: () => void) => Promise<void>; open: (id: string) => Promise<void>; reloadList: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const load = useCallback(() => { api<Row[]>('/fiscal/outgoing/returnable').then(setRows).catch(() => setRows([])); }, []);
  useEffect(load, [load]);
  if (!rows || rows.length === 0) return null;
  return (
    <section className="card" style={{ marginBottom: 16 }} aria-label="Devoluções sem nota">
      <div className="card-head"><h2>Devoluções de venda sem NF-e</h2><span className="badge warn">{rows.length}</span></div>
      <p className="muted" style={{ marginTop: 0 }}>Quando o cliente devolve mercadoria, a nota de devolução é uma NF-e de <strong>entrada própria</strong> que referencia a nota da venda. A tributação replica a da venda original: <strong>confira com o contador</strong>. Só na emissão direta e só para nota original autorizada.</p>
      <div className="table-wrap"><table>
        <thead><tr><th>Pedido</th><th>Cliente</th><th>Itens devolvidos</th><th>Nota original</th><th /></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.returnId}>
            <td><strong>#{r.orderNumber}</strong><div className="muted" style={{ fontSize: '0.78rem' }}>{dateBr(r.createdAt)}</div></td><td>{r.customer}</td>
            <td>{r.items.map((i) => `${i.quantity}× ${i.sku}`).join(', ')}<div className="muted" style={{ fontSize: '0.78rem' }}>{r.reason}</div></td>
            <td>{r.original ? `${r.original.model === '65' ? 'NFC-e' : 'NF-e'} ${r.original.number}/${r.original.series}` : <span className="badge warn">{r.blocked}</span>}</td>
            <td>{r.original && <button className="btn sm" onClick={() => act(async () => { const d = await api<{ id: string }>('/fiscal/outgoing/prepare-return', 'POST', { returnId: r.returnId }); await open(d.id); }, 'NF-e de devolução preparada. Confira e transmita.', () => { load(); reloadList(); })}>Preparar NF-e de devolução</button>}</td>
          </tr>
        ))}</tbody>
      </table></div>
    </section>
  );
}
