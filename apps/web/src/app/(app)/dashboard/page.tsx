'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

interface Metrics { products: number; belowMin: number; outOfStock: number; stockValue: string; fiscalPending: number }
interface Overview {
  counts: { companies: number; establishments: number; warehouses: number; users: number };
  checklist: { key: string; label: string; done: boolean }[];
  pendingModules: string[];
}

export default function DashboardPage() {
  const { me, can } = useSession();
  const [m, setM] = useState<Metrics | null>(null);
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Overview>('/dashboard/overview').then(setData).catch((e) => setError(e.message));
    if (can('stock.view')) api<Metrics>('/stock/metrics').then(setM).catch(() => undefined);
  }, [can]);

  const stats = data && [
    ['Empresas', data.counts.companies],
    ['Estabelecimentos', data.counts.establishments],
    ['Depósitos', data.counts.warehouses],
    ['Usuários ativos', data.counts.users],
  ] as const;
  const done = data?.checklist.filter((c) => c.done).length ?? 0;

  return (
    <>
      <h1>Olá, {me.user.name.split(' ')[0]}</h1>
      <p className="muted">Visão geral de {me.tenant!.name}. Os números vêm do banco de dados em tempo real.</p>
      {error && <div className="alert error" role="alert">{error}</div>}
      {!data && !error && <p className="muted">Carregando…</p>}
      {data && (
        <>
          <div className="grid cols-4" style={{ marginBottom: 16 }}>
            {stats!.map(([label, n]) => (
              <div className="card stat" key={label}>
                <div className="muted">{label}</div>
                <div className="n">{n}</div>
              </div>
            ))}
          </div>
          {m && (
            <div className="grid cols-4" style={{ marginBottom: 16 }}>
              {([
                ['Produtos ativos', m.products],
                ['Abaixo do mínimo', m.belowMin],
                ['Sem estoque', m.outOfStock],
                ['Valor em estoque (custo)', Number(m.stockValue).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })],
                ['Sem NCM (pendência fiscal)', m.fiscalPending],
              ] as const).map(([label, n]) => (
                <div className="card stat" key={label}><div className="muted">{label}</div><div className="n">{n}</div></div>
              ))}
            </div>
          )}
          <div className="grid cols-2">
            <section className="card">
              <h2>Checklist de implantação ({done}/{data.checklist.length})</h2>
              <ul className="checklist">
                {data.checklist.map((c) => (
                  <li key={c.key}>
                    <span className={`tick ${c.done ? 'done' : ''}`}>{c.done ? '✓' : ''}</span>
                    <span>{c.label}</span>
                  </li>
                ))}
              </ul>
              <p style={{ marginBottom: 0 }}><Link href="/empresa">Configurar empresa e depósitos →</Link></p>
            </section>
            <section className="card">
              <h2>Ainda não disponível</h2>
              <p className="muted">Indicadores de vendas, estoque e financeiro aparecerão aqui quando os módulos correspondentes forem entregues — sem números fictícios.</p>
              <ul>{data.pendingModules.map((m) => <li key={m}>{m}</li>)}</ul>
            </section>
          </div>
        </>
      )}
    </>
  );
}
