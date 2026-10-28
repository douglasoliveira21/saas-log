'use client';

import { ArrowRight, Truck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface Ov { stages: { waiting: number; picking: number; packed: number }; late: number; dueToday: number; stuck: number; divergent: number; rush: number; shippedToday: number; alerts: { key: string; severity: string; title: string; count: number }[] }

/** Resumo da expedição no painel principal: onde estão os pedidos e o que precisa de atenção, com atalho para a fila. */
export function DispatchAlerts() {
  const [ov, setOv] = useState<Ov | null>(null);
  useEffect(() => { api<Ov>('/dispatch/overview').then(setOv).catch(() => undefined); }, []);
  if (!ov) return null;
  const attention = ov.alerts.filter((a) => a.severity !== 'info');
  return (
    <section aria-label="Expedição">
      <div className="card-head"><h2>Expedição</h2><Link href="/expedicao" className="btn sm ghost">Abrir expedição <ArrowRight /></Link></div>
      <div className="card">
        <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
          <span><Truck size={16} aria-hidden style={{ verticalAlign: '-3px' }} /> <strong>{ov.stages.waiting}</strong> aguardando · <strong>{ov.stages.picking}</strong> em separação · <strong>{ov.stages.packed}</strong> prontos · <strong>{ov.shippedToday}</strong> expedidos hoje</span>
        </div>
        <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          {attention.length === 0 ? <span className="badge ok">Sem alertas na expedição</span> : attention.map((a) => (
            <Link key={a.key} href="/expedicao#fila" className={`badge ${a.severity === 'danger' ? 'danger' : 'warn'}`} style={{ textDecoration: 'none', padding: '4px 10px' }}>{a.title}: {a.count}</Link>
          ))}
        </div>
      </div>
    </section>
  );
}
