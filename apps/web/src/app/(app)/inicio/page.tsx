'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { NAV, NAV_GROUPS } from '@/lib/nav';
import { AppHome } from './app-home';
import { useAppMode } from '@/lib/app-mode';
import { useSession } from '@/lib/session';

/** Cor do bloco por menu (texto branco em todas, contraste ≥ 4,5:1). */
const TONE: Record<(typeof NAV_GROUPS)[number], string> = { Geral: 't-slate', Comercial: 't-blue', Suprimentos: 't-orange', 'Canais e logística': 't-teal', 'Financeiro e fiscal': 't-green', Administração: 't-violet' };

/**
 * Início em blocos (estilo "launcher"): um bloco por módulo, agrupados pelos menus. Quem usa o menu lateral clássico não vê esta tela:
 * é levado ao painel de sempre.
 */
function LauncherHome() {
  const { me, can } = useSession();
  const router = useRouter();
  const launcher = me.user.navStyle === 'LAUNCHER';
  const [q, setQ] = useState('');
  useEffect(() => { if (!launcher) router.replace(can('delivery.perform') && !can('sales.view') && !can('company.view') ? '/motorista' : '/dashboard'); }, [launcher, router, can]);

  const sections = useMemo(() => {
    const term = q.trim().toLowerCase();
    return NAV_GROUPS.map((g) => ({ group: g, items: NAV.filter((n) => n.group === g && can(n.permission) && (!term || n.label.toLowerCase().includes(term) || g.toLowerCase().includes(term))) })).filter((s) => s.items.length);
  }, [q, can]);

  if (!launcher) return <p className="muted">Abrindo o painel…</p>;
  return (
    <>
      <div className="home-hello">
        <h1>Olá, {me.user.name.split(' ')[0]}!</h1>
        <p>Em que vamos trabalhar hoje?</p>
        <input className="home-search" type="search" placeholder="Buscar módulo…" aria-label="Buscar módulo" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {sections.length === 0 && <p className="muted">Nenhum módulo encontrado{q ? ` para “${q}”` : ''}.</p>}
      {sections.map((s) => (
        <section className="home-sec" key={s.group} aria-label={s.group}>
          <h2>{s.group === 'Geral' ? 'Painel' : s.group}</h2>
          <div className="tiles">
            {s.items.map((n) => {
              const Icon = n.icon;
              return (
                <Link key={n.href} href={n.href} className={`tile ${TONE[s.group]}`}>
                  <Icon className="ico" aria-hidden />
                  <span className="lbl">{n.label}</span>
                  {!n.implemented && <span className="soon">Fase {n.phase}</span>}
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </>
  );
}

export default function InicioPage() {
  const app = useAppMode();
  return app ? <AppHome /> : <LauncherHome />;
}
