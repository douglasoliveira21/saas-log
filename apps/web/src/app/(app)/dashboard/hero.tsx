'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { BorderBeam } from '@/components/magicui/border-beam';
import { DotPattern } from '@/components/magicui/dot-pattern';
import { NumberTicker } from '@/components/magicui/number-ticker';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

interface OrdersDash { period: { created: number; revenue: string; shipped: number; delivered: number; cancelled: number }; cards: { late: number; toShip: number; inTransit: number } }
interface FinanceSummary { RECEIVABLE: Record<string, string> }

const hour = () => Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'America/Sao_Paulo' }).format(new Date()));
const greeting = () => (hour() < 12 ? 'Bom dia' : hour() < 18 ? 'Boa tarde' : 'Boa noite');

/** Faixa de abertura do dashboard: saudação e os números que mais importam, com contagem animada. */
export function DashboardHero() {
  const { me, can } = useSession();
  const [o, setO] = useState<OrdersDash | null>(null);
  const [f, setF] = useState<FinanceSummary | null>(null);
  useEffect(() => {
    if (can('sales.view')) api<OrdersDash>('/dashboard/orders?days=30').then(setO).catch(() => undefined);
    if (can('finance.view')) api<FinanceSummary>('/finance/summary').then(setF).catch(() => undefined);
  }, [can]);

  const revenue = o ? Number(o.period.revenue) : null;
  const overdue = f ? Number(f.RECEIVABLE.overdue) : null;
  return (
    <section className="hero" aria-label="Resumo">
      <DotPattern className="hero-dots" width={22} height={22} cr={1.1} />
      <div className="hero-body">
        <div>
          <p className="hero-kicker">{me.tenant!.name}</p>
          <h1>{greeting()}, {me.user.name.split(' ')[0]}!</h1>
          <p className="hero-sub">Resumo dos últimos 30 dias. Os números vêm do banco de dados em tempo real.</p>
        </div>
        {can('sales.view') && <Link href="/vendas" className="hero-cta">Ver pedidos <ArrowRight aria-hidden /></Link>}
      </div>
      {(o || f) && (
        <div className="hero-kpis">
          {revenue !== null && <div className="hero-kpi big"><span>Faturamento</span><strong>R$ <NumberTicker value={revenue} decimalPlaces={2} className="hero-ticker" /></strong></div>}
          {o && <div className="hero-kpi"><span>Pedidos</span><strong><NumberTicker value={o.period.created} className="hero-ticker" /></strong></div>}
          {o && <div className="hero-kpi"><span>Entregues</span><strong><NumberTicker value={o.period.delivered} className="hero-ticker" /></strong></div>}
          {o && <div className={`hero-kpi ${o.cards.late > 0 ? 'alert' : ''}`}><span>Em atraso</span><strong><NumberTicker value={o.cards.late} className="hero-ticker" /></strong></div>}
          {overdue !== null && <div className={`hero-kpi ${overdue > 0 ? 'alert' : ''}`}><span>A receber vencido</span><strong>R$ <NumberTicker value={overdue} decimalPlaces={2} className="hero-ticker" /></strong></div>}
        </div>
      )}
      <BorderBeam size={220} duration={9} colorFrom="#ffffff" colorTo="#7ab8ff" />
    </section>
  );
}
