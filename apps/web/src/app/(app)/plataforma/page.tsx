'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { PageHeader, Alert } from '@/components/ui';
import { dateBr } from '@/lib/format';

interface Tenant { id: string; name: string; slug: string; status: string; plan: string | null; trialEndsAt: string | null; createdAt: string; users: number; products: number; orders30d: number; connections: number; lastActivity: string | null }
interface Plan { code: string; name: string; active: boolean; priceCents: number | null; limits: Record<string, number> }
interface Audit { id: string; action: string; tenantId: string | null; metadata: Record<string, unknown>; at: string }
interface QueueRow { status: string; jobs: number }

export default function PlataformaPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [edit, setEdit] = useState<Tenant | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  const load = useCallback(() => {
    api<Tenant[]>('/platform/tenants').then(setTenants).catch((e) => setError(e.message));
    api<Plan[]>('/platform/plans').then(setPlans).catch(() => undefined);
    api<Audit[]>('/platform/audit?limit=30').then(setAudit).catch(() => undefined);
    api<QueueRow[]>('/platform/queue').then(setQueue).catch(() => undefined);
  }, []);
  useEffect(load, [load]);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!edit) return;
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> = { note: f.get('note') };
    for (const k of ['status', 'planCode', 'trialEndsAt']) if (String(f.get(k) ?? '')) body[k] = f.get(k);
    setError(''); setOk('');
    try { await api(`/platform/tenants/${edit.id}`, 'PUT', body); setOk('Empresa atualizada.'); setEdit(null); load(); } catch (err) { setError((err as Error).message); }
  }

  return (
    <>
      <PageHeader title="Plataforma" description={<>Visão de administrador global: somente metadados e contagens. Nenhum dado comercial, fiscal ou financeiro das empresas é exibido. Toda alteração fica registrada aqui e na auditoria da empresa.</>} />
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}

      {edit && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={save}>
          <h2>{edit.name}</h2>
          <div className="form-grid">
            <div><label htmlFor="s">Situação</label><select id="s" name="status" defaultValue=""><option value="">Manter ({edit.status})</option><option value="TRIAL">Avaliação</option><option value="ACTIVE">Ativo</option><option value="SUSPENDED">Suspenso</option></select></div>
            <div><label htmlFor="p">Plano</label><select id="p" name="planCode" defaultValue=""><option value="">Manter ({edit.plan ?? '—'})</option>{plans.filter((p) => p.active).map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></div>
            <div><label htmlFor="t">Fim da avaliação</label><input id="t" name="trialEndsAt" type="date" /></div>
            <div><label htmlFor="n">Motivo (obrigatório, fica registrado) *</label><input id="n" name="note" required minLength={3} /></div>
          </div>
          <div className="row" style={{ marginTop: 12 }}><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={() => setEdit(null)}>Cancelar</button></div>
        </form>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Empresas ({tenants.length})</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Empresa</th><th>Situação</th><th>Plano</th><th>Usuários</th><th>Produtos</th><th>Pedidos 30d</th><th>Conexões</th><th>Última atividade</th><th /></tr></thead>
          <tbody>{tenants.map((t) => (
            <tr key={t.id}>
              <td>{t.name}<br /><span className="muted">{t.slug}</span></td>
              <td><span className={`badge ${t.status === 'ACTIVE' ? 'ok' : t.status === 'SUSPENDED' ? 'warn' : ''}`}>{t.status}</span>{t.status === 'TRIAL' && t.trialEndsAt && <div className="muted">até {dateBr(t.trialEndsAt)}</div>}</td>
              <td>{t.plan ?? '—'}</td><td>{t.users}</td><td>{t.products}</td><td>{t.orders30d}</td><td>{t.connections}</td><td>{dateBr(t.lastActivity)}</td>
              <td><button className="btn sm" onClick={() => setEdit(t)}>Alterar</button></td>
            </tr>
          ))}</tbody>
        </table></div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>Fila de trabalhos</h2>
          <ul>{queue.length === 0 && <li className="muted">Vazia.</li>}{queue.map((q) => <li key={q.status}>{q.status}: {q.jobs}</li>)}</ul>
          <h2>Planos</h2>
          <ul>{plans.map((p) => <li key={p.code}>{p.name} ({p.code}) {p.active ? '' : '— inativo'}: {Object.keys(p.limits).length ? Object.entries(p.limits).map(([k, v]) => `${k} ${v}`).join(', ') : 'sem limites'}</li>)}</ul>
        </div>
        <div className="card">
          <h2>Auditoria da plataforma</h2>
          <ul>{audit.map((a) => <li key={a.id}>{new Date(a.at).toLocaleString('pt-BR')} · {a.action}{a.metadata?.note ? ` — ${String(a.metadata.note)}` : ''}</li>)}</ul>
        </div>
      </div>
    </>
  );
}
