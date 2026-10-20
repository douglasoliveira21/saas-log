'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { BRAND } from '@/lib/brand';
import { NAV } from '@/lib/nav';
import { SessionProvider, useSession } from '@/lib/session';

function Shell({ children }: { children: ReactNode }) {
  const { me, can, logout } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [pathname]);

  // Só mostra o que o usuário pode acessar (o servidor reforça a mesma regra).
  const visible = NAV.filter((n) => can(n.permission));
  const core = visible.filter((n) => n.implemented);
  const upcoming = visible.filter((n) => !n.implemented);

  const link = (n: (typeof NAV)[number]) => (
    <Link key={n.href} href={n.href} className={pathname === n.href ? 'active' : ''}>
      <span className="ico" aria-hidden>{n.icon}</span>
      <span>{n.label}</span>
      {!n.implemented && <span className="soon">Fase {n.phase}</span>}
    </Link>
  );

  const switchTenant = () => router.push('/select-tenant');

  return (
    <div className="shell">
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand">{BRAND.name}</div>
        <nav className="nav" aria-label="Navegação principal">
          {core.filter((n) => n.group !== 'admin').map(link)}
          <div className="nav-title">Em construção</div>
          {upcoming.map(link)}
          <div className="nav-title">Administração</div>
          {core.filter((n) => n.group === 'admin').map(link)}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="btn sm menu-btn" onClick={() => setOpen(!open)} aria-label="Abrir menu">☰</button>
          <strong>{me.tenant!.name}</strong>
          <span className="badge">{me.role?.name}</span>
          {me.tenant!.plan && <span className="badge warn">Plano: {me.tenant!.plan}</span>}
          <span className="spacer" />
          {me.tenants.length > 1 && <button className="btn sm" onClick={switchTenant}>Trocar empresa</button>}
          <span className="muted">{me.user.name}</span>
          <button className="btn sm" onClick={logout}>Sair</button>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <Shell>{children}</Shell>
    </SessionProvider>
  );
}
