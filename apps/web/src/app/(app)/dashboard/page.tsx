'use client';

import { AlertTriangle, ArrowRight, Boxes, Building2, Check, PackageX, Users, Wallet, Warehouse } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BlurFade } from '@/components/magicui/blur-fade';
import { AnimatedCircularProgressBar } from '@/components/magicui/animated-circular-progress-bar';
import { Alert, Skeleton, StatCard } from '@/components/ui';
import { DashboardHero } from './hero';
import { api } from '@/lib/api';
import { brl } from '@/lib/format';
import { useSession } from '@/lib/session';
import { OrdersPanel } from './orders-panel';
import { SalesCharts } from './sales-charts';

interface Metrics { products: number; belowMin: number; outOfStock: number; stockValue: string; fiscalPending: number }
interface Overview {
  counts: { companies: number; establishments: number; warehouses: number; users: number };
  checklist: { key: string; label: string; done: boolean }[];
  pendingModules: string[];
}
interface FinanceSummary { PAYABLE: Record<string, string>; RECEIVABLE: Record<string, string> }

export default function DashboardPage() {
  const { me, can } = useSession();
  const router = useRouter();
  const driverOnly = can('delivery.perform') && !can('routes.view') && !can('sales.view') && !can('company.view');
  const [m, setM] = useState<Metrics | null>(null);
  const [fin, setFin] = useState<FinanceSummary | null>(null);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (driverOnly) { router.replace('/motorista'); return; }
    api<Overview>('/dashboard/overview').then(setData).catch((e) => setError(e.message));
    if (can('stock.view')) api<Metrics>('/stock/metrics').then(setM).catch(() => undefined);
    if (can('finance.view')) api<FinanceSummary>('/finance/summary').then(setFin).catch(() => undefined);
  }, [can, driverOnly, router]);

  const done = data?.checklist.filter((c) => c.done).length ?? 0;
  const total = data?.checklist.length ?? 0;
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <>
      <DashboardHero />
      {error && <Alert kind="error">{error}</Alert>}
      {!data && !error && (
        <div className="grid cols-4">{[0, 1, 2, 3].map((i) => <div className="card" key={i}><span className="skeleton" style={{ height: 14, width: '55%', marginBottom: 12 }} /><span className="skeleton" style={{ height: 30, width: '40%' }} /></div>)}</div>
      )}
      {data && (
        <div className="stack">
          <BlurFade delay={0.05}><section aria-label="Estrutura da empresa" className="grid cols-4">
            <StatCard label="Empresas" value={data.counts.companies} icon={<Building2 />} />
            <StatCard label="Estabelecimentos" value={data.counts.establishments} icon={<Warehouse />} />
            <StatCard label="Depósitos" value={data.counts.warehouses} icon={<Boxes />} />
            <StatCard label="Usuários ativos" value={data.counts.users} icon={<Users />} />
          </section></BlurFade>

          {can('sales.view') && <BlurFade delay={0.1} inView><OrdersPanel /></BlurFade>}
          {can('sales.view') && <BlurFade delay={0.1} inView><SalesCharts /></BlurFade>}

          {m && (
            <BlurFade inView><section aria-label="Estoque">
              <div className="card-head"><h2>Estoque</h2><Link href="/estoque" className="btn sm ghost">Ver estoque <ArrowRight /></Link></div>
              <div className="grid cols-4">
                <StatCard label="Produtos ativos" value={m.products} icon={<Boxes />} />
                <StatCard label="Abaixo do mínimo" value={m.belowMin} icon={<AlertTriangle />} tone={m.belowMin ? 'warn' : undefined} />
                <StatCard label="Sem estoque" value={m.outOfStock} icon={<PackageX />} tone={m.outOfStock ? 'danger' : undefined} />
                <StatCard label="Valor em estoque (custo)" value={brl(m.stockValue)} icon={<Wallet />} />
                {m.fiscalPending > 0 && <StatCard label="Sem NCM (pendência fiscal)" value={m.fiscalPending} tone="warn" icon={<AlertTriangle />} hint="Cadastre o NCM para emitir notas." />}
              </div>
            </section></BlurFade>
          )}

          {fin && (
            <BlurFade inView><section aria-label="Financeiro">
              <div className="card-head"><h2>Contas a pagar e a receber</h2><Link href="/financeiro" className="btn sm ghost">Abrir financeiro <ArrowRight /></Link></div>
              <div className="grid cols-4">
                <StatCard label="A pagar vencido" value={brl(fin.PAYABLE.overdue)} tone={Number(fin.PAYABLE.overdue) > 0 ? 'danger' : undefined} icon={<Wallet />} />
                <StatCard label="A pagar em 7 dias" value={brl(fin.PAYABLE.next7)} icon={<Wallet />} />
                <StatCard label="A receber vencido" value={brl(fin.RECEIVABLE.overdue)} tone={Number(fin.RECEIVABLE.overdue) > 0 ? 'warn' : undefined} icon={<Wallet />} />
                <StatCard label="A receber em 7 dias" value={brl(fin.RECEIVABLE.next7)} tone="ok" icon={<Wallet />} />
              </div>
            </section></BlurFade>
          )}

          {done < total && (
            <section className="card" aria-label="Checklist de implantação">
              <div className="card-head">
                <h2>Checklist de implantação</h2>
                <span className="badge brand">{done} de {total}</span>
              </div>
              <div className="check-ring"><AnimatedCircularProgressBar value={pct} gaugePrimaryColor="var(--brand)" gaugeSecondaryColor="var(--surface-3)" className="size-28 text-xl" /><span className="muted">Falta pouco para a empresa estar pronta para vender.</span></div>
              <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Progresso da implantação" style={{ marginBottom: 8 }}><span style={{ width: `${pct}%` }} /></div>
              <ul className="checklist">
                {data.checklist.map((c) => (
                  <li key={c.key}>
                    <span className={`tick ${c.done ? 'done' : ''}`}>{c.done && <Check />}</span>
                    <span className={c.done ? 'muted' : ''}>{c.label}</span>
                  </li>
                ))}
              </ul>
              <p style={{ margin: '12px 0 0' }}><Link href="/empresa" className="btn sm">Configurar empresa e depósitos <ArrowRight /></Link></p>
            </section>
          )}
          {!m && !fin && done === total && <Alert kind="info">Sua estrutura está configurada. Use o menu à esquerda para acessar os módulos permitidos ao seu perfil.</Alert>}
        </div>
      )}
      {!data && !error && <div style={{ marginTop: 16 }}><Skeleton rows={3} /></div>}
    </>
  );
}
