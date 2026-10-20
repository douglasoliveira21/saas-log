'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { PageHeader, Alert, Skeleton } from '@/components/ui';

interface Item { id: string; action: string; entity: string | null; entityId: string | null; metadata: Record<string, unknown>; createdAt: string; user: { name: string; email: string } | null }
interface Page { items: Item[]; nextCursor: string | null }

export default function AuditoriaPage() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback((after?: string | null) => {
    api<Page>(`/audit?limit=50${after ? `&cursor=${after}` : ''}`)
      .then((p) => { setItems((prev) => (after ? [...(prev ?? []), ...p.items] : p.items)); setCursor(p.nextCursor); })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => load(), [load]);

  return (
    <>
      <PageHeader title="Auditoria" description={<>Trilha append-only das ações críticas. Segredos nunca são gravados.</>} />
      {error && <Alert kind="error">{error}</Alert>}
      <section className="card">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Detalhes</th></tr></thead>
            <tbody>
              {!items && !error && <tr><td colSpan={4}><Skeleton rows={3} /></td></tr>}
              {items?.length === 0 && <tr><td colSpan={4} className="empty">Nenhum evento registrado.</td></tr>}
              {items?.map((i) => (
                <tr key={i.id}>
                  <td>{new Date(i.createdAt).toLocaleString('pt-BR')}</td>
                  <td>{i.user?.name ?? '—'}</td>
                  <td><span className="badge">{i.action}</span></td>
                  <td className="muted">{Object.keys(i.metadata).length ? JSON.stringify(i.metadata) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {cursor && <p><button className="btn" onClick={() => load(cursor)}>Carregar mais</button></p>}
      </section>
    </>
  );
}
