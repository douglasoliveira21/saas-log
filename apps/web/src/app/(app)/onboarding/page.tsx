'use client';

import { CheckCircle2, Circle, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';

interface Step { key: string; title: string; description: string; href: string; complete: boolean }
interface Status { steps: Step[]; completed: number; total: number; dismissedAt: string | null }

export default function OnboardingPage() {
  const [data, setData] = useState<Status>(); const [error, setError] = useState(''); const [ok, setOk] = useState('');
  const load = () => api<Status>('/onboarding').then(setData).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);
  async function complete() { setError(''); try { await api('/onboarding/complete', 'POST'); setOk('Configuração inicial marcada como concluída. Você pode continuar ajustando qualquer etapa.'); load(); } catch (e) { setError((e as Error).message); } }
  return <>
    <PageHeader title="Configuração inicial" description="Um roteiro seguro para deixar a empresa pronta: estrutura, equipe, fiscal e dados do sistema anterior." />
    {error && <Alert kind="error">{error}</Alert>}{ok && <Alert kind="ok">{ok}</Alert>}
    {data && <>
      <div className="card" style={{ marginBottom: 16 }}><div className="row"><strong>{data.completed} de {data.total} etapas concluídas</strong><span className="spacer" /><span className="badge brand">{Math.round(data.completed / data.total * 100)}%</span></div><div className="app-progress" style={{ marginTop: 10 }}><span style={{ width: `${data.completed / data.total * 100}%` }} /></div></div>
      <div className="grid cols-2">{data.steps.map((s, i) => <div className="card" key={s.key}>
        <div className="row" style={{ alignItems: 'flex-start' }}>{s.complete ? <CheckCircle2 color="var(--success)" /> : <Circle color="var(--muted)" />}<div><span className="muted">Etapa {i + 1}</span><h2 style={{ margin: '2px 0 6px' }}>{s.title}</h2><p className="muted">{s.description}</p></div></div>
        <Link className="btn primary" href={s.href}>{s.complete ? 'Revisar' : 'Configurar'} <ExternalLink size={15} /></Link>
      </div>)}</div>
      <div className="card" style={{ marginTop: 16 }}><h2>Encerrar o assistente</h2><p className="muted">É possível encerrar mesmo com itens pendentes. O status continua disponível nesta página e não altera dados operacionais.</p><button className="btn primary" onClick={complete}>Marcar onboarding como concluído</button></div>
    </>}
  </>;
}
