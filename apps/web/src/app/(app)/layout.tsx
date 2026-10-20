'use client';

import { ChevronDown, ChevronsLeft, ChevronsRight, LogOut, Menu, Moon, Repeat, Sun } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BRAND } from '@/lib/brand';
import { NAV, NAV_GROUPS } from '@/lib/nav';
import { SessionProvider, useSession } from '@/lib/session';

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('');

function safeStorage(op: 'get' | 'set', key: string, value?: string): string | null {
  try { if (op === 'set') { localStorage.setItem(key, value!); return value!; } return localStorage.getItem(key); } catch { return null; }
}

function Shell({ children }: { children: ReactNode }) {
  const { me, can, logout } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [menu, setMenu] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setCollapsed(safeStorage('get', 'dh-collapsed') === '1'); setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'); }, []);
  useEffect(() => { setOpen(false); setMenu(false); }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menu]);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next; safeStorage('set', 'dh-theme', next); setTheme(next);
  }
  function toggleCollapsed() { const next = !collapsed; setCollapsed(next); safeStorage('set', 'dh-collapsed', next ? '1' : '0'); }

  // Só mostra o que o usuário pode acessar (o servidor reforça a mesma regra).
  const visible = NAV.filter((n) => can(n.permission));
  const current = [...visible].sort((a, b) => b.href.length - a.href.length).find((n) => pathname === n.href || pathname.startsWith(n.href + '/'));
  const trialLeft = me.tenant?.status === 'TRIAL' && me.tenant.trialEndsAt ? Math.ceil((new Date(me.tenant.trialEndsAt).getTime() - Date.now()) / 86_400_000) : null;

  return (
    <div className={`shell ${collapsed ? 'collapsed' : ''}`}>
      {open && <div className="scrim" onClick={() => setOpen(false)} aria-hidden />}
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="sidebar-head">
          <div className="logo" aria-hidden>{BRAND.name.slice(0, 1)}</div>
          <span className="brand">{BRAND.name}</span>
        </div>
        <div className="sidebar-scroll">
          <nav className="nav" aria-label="Navegação principal">
            {NAV_GROUPS.map((g) => {
              const items = visible.filter((n) => n.group === g);
              if (!items.length) return null;
              return (
                <div className="nav-group" key={g}>
                  <div className="nav-title">{g}</div>
                  {items.map((n) => {
                    const Icon = n.icon;
                    const active = current?.href === n.href;
                    return (
                      <Link key={n.href} href={n.href} className={active ? 'active' : ''} aria-current={active ? 'page' : undefined} title={collapsed ? n.label : undefined}>
                        <Icon className="ico" aria-hidden />
                        <span className="lbl">{n.label}</span>
                        {!n.implemented && <span className="soon">Fase {n.phase}</span>}
                      </Link>
                    );
                  })}
                </div>
              );
            })}
          </nav>
        </div>
        <div className="sidebar-foot">
          <button className="btn ghost sm icon collapse-btn" onClick={toggleCollapsed} aria-label={collapsed ? 'Expandir menu' : 'Recolher menu'} title={collapsed ? 'Expandir menu' : 'Recolher menu'}>
            {collapsed ? <ChevronsRight /> : <ChevronsLeft />}
          </button>
          <span className="who muted" style={{ fontSize: '0.78rem' }}>{me.tenant!.name}</span>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button className="btn ghost icon menu-btn" onClick={() => setOpen(!open)} aria-label="Abrir menu" aria-expanded={open}><Menu /></button>
          <nav className="crumbs" aria-label="Você está em">
            <span className="hide-sm">{me.tenant!.name}</span>
            {current && <><span className="hide-sm" aria-hidden>/</span><span className="hide-sm">{current.group}</span><span className="hide-sm" aria-hidden>/</span><strong>{current.label}</strong></>}
          </nav>
          <span className="spacer" />
          {trialLeft !== null && (
            <Link href="/plano" className={`badge ${trialLeft <= 3 ? 'warn' : 'brand'} hide-sm`} style={{ textDecoration: 'none' }}>
              {trialLeft > 0 ? `Avaliação: ${trialLeft} dia(s)` : 'Avaliação encerrada'}
            </Link>
          )}
          <button className="btn ghost icon" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'} title="Alternar tema">{theme === 'dark' ? <Sun /> : <Moon />}</button>
          <div className="menu-wrap" ref={menuRef}>
            <button className="btn ghost user-chip" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu}>
              <span className="avatar" aria-hidden>{initials(me.user.name)}</span>
              <span className="who hide-sm">{me.user.name.split(' ')[0]}</span>
              <ChevronDown size={14} aria-hidden />
            </button>
            {menu && (
              <div className="menu" role="menu">
                <div className="menu-head">
                  <strong>{me.user.name}</strong>
                  <div className="muted" style={{ fontSize: '0.8rem', overflowWrap: 'anywhere' }}>{me.user.email}</div>
                  <div style={{ marginTop: 6 }}><span className="badge">{me.role?.name}</span> {me.tenant!.plan && <span className="badge brand">{me.tenant!.plan}</span>}</div>
                </div>
                {me.tenants.length > 1 && <button role="menuitem" onClick={() => router.push('/select-tenant')}><Repeat />Trocar empresa</button>}
                <button role="menuitem" onClick={logout}><LogOut />Sair</button>
              </div>
            )}
          </div>
        </header>
        <main className="content" id="conteudo">{children}</main>
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
