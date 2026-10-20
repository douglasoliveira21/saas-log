'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { PageHeader, Alert } from '@/components/ui';
import { brl, dateBr } from '@/lib/format';

interface Resource { key: string; label: string; used: number; limit: number | null; exceeded: boolean }
interface Billing {
  status: string; plan: { code: string; name: string; priceCents: number | null } | null; trialEndsAt: string | null; trialDaysLeft: number | null; readOnly: boolean;
  resources: Resource[]; history: { at: string; status: string; plan: string; note: string | null }[];
  plans: { code: string; name: string; limits: Record<string, number>; priceCents: number | null; description: string | null }[];
  paymentGateway: { integrated: boolean; note: string };
}
const STATUS: Record<string, string> = { TRIAL: 'Avaliação', ACTIVE: 'Ativo', SUSPENDED: 'Suspenso', TRIALING: 'Avaliação', PAST_DUE: 'Em atraso', CANCELLED: 'Cancelado' };

export default function PlanoPage() {
  const [b, setB] = useState<Billing | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api<Billing>('/billing').then(setB).catch((e) => setError(e.message)); }, []);

  return (
    <>
      <PageHeader title="Plano e uso" />
      {error && <Alert kind="error">{error}</Alert>}
      {b && (
        <>
          {b.readOnly && <div className="alert error" role="alert">A avaliação terminou: o sistema está em modo somente leitura. Contrate um plano para voltar a lançar dados.</div>}
          <div className="card" style={{ marginBottom: 16 }}>
            <p><strong>{b.plan?.name ?? 'Sem plano'}</strong> <span className="badge">{STATUS[b.status] ?? b.status}</span>
              {b.trialDaysLeft !== null && !b.readOnly && <> · avaliação termina em {dateBr(b.trialEndsAt)} ({b.trialDaysLeft} dia(s))</>}
              {b.plan?.priceCents != null && <> · {brl(b.plan.priceCents / 100)}/mês</>}</p>
            <p className="muted">{b.paymentGateway.note}</p>
          </div>
          <div className="card" style={{ marginBottom: 16 }}>
            <h2>Uso</h2>
            <div className="table-wrap"><table>
              <thead><tr><th>Recurso</th><th>Em uso</th><th>Limite</th></tr></thead>
              <tbody>{b.resources.map((r) => <tr key={r.key}><td>{r.label}</td><td>{r.used}{r.exceeded && <span className="badge warn" style={{ marginLeft: 8 }}>acima do plano</span>}</td><td>{r.limit ?? 'Ilimitado'}</td></tr>)}</tbody>
            </table></div>
            <p className="muted">Pedidos importados de marketplaces nunca são bloqueados, mesmo acima do limite.</p>
          </div>
          <div className="card" style={{ marginBottom: 16 }}>
            <h2>Planos disponíveis</h2>
            <div className="table-wrap"><table>
              <thead><tr><th>Plano</th><th>Limites</th><th>Preço</th></tr></thead>
              <tbody>{b.plans.map((p) => <tr key={p.code}><td>{p.name}{p.description ? <><br /><span className="muted">{p.description}</span></> : null}</td><td>{Object.keys(p.limits).length ? Object.entries(p.limits).map(([k, v]) => `${k}: ${v}`).join(' · ') : 'Sem limites'}</td><td>{p.priceCents == null ? 'A combinar' : brl(p.priceCents / 100)}</td></tr>)}</tbody>
            </table></div>
          </div>
          <div className="card">
            <h2>Histórico</h2>
            <ul>{b.history.length === 0 && <li className="muted">Sem alterações.</li>}{b.history.map((h, i) => <li key={i}>{new Date(h.at).toLocaleString('pt-BR')} · {h.plan} · {STATUS[h.status] ?? h.status}{h.note ? ` — ${h.note}` : ''}</li>)}</ul>
          </div>
        </>
      )}
    </>
  );
}
