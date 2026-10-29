'use client';

import { ArrowLeft, Bell, Home, MapPinned, Navigation, ShoppingCart, Truck, User, Users, Wallet, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { GpsGate } from '@/components/gps-gate';
import { NAV } from '@/lib/nav';
import { useSession } from '@/lib/session';

interface Tab { href: string; label: string; icon: LucideIcon; permission?: string; driverOnly?: boolean; hideForManagers?: boolean }

/** Abas candidatas, em ordem de prioridade: cada perfil vê as 3 primeiras que pode usar (Início e Perfil são fixas). */
const CANDIDATES: Tab[] = [
  { href: '/motorista', label: 'Entregas', icon: Navigation, permission: 'delivery.perform', hideForManagers: true },
  { href: '/vendas', label: 'Pedidos', icon: ShoppingCart, permission: 'sales.view' },
  { href: '/expedicao', label: 'Expedição', icon: Truck, permission: 'sales.fulfill' },
  { href: '/clientes', label: 'Clientes', icon: Users, permission: 'customers.view' },
  { href: '/financeiro', label: 'Financeiro', icon: Wallet, permission: 'finance.view' },
  { href: '/rotas/mapa', label: 'Mapa', icon: MapPinned, permission: 'routes.view' },
];

/**
 * Casca do aplicativo (APK): cabeçalho enxuto e abas embaixo, no lugar do menu lateral. Mesmas páginas e permissões do sistema;
 * a conta de motorista continua exigindo o GPS (GpsGate).
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { me, can } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const driverOnly = can('delivery.perform') && !can('routes.view');
  const manager = can('routes.view');
  const middle = CANDIDATES.filter((t) => can(t.permission) && !(t.hideForManagers && manager)).slice(0, 3);
  const tabs: Tab[] = [{ href: '/inicio', label: 'Início', icon: Home }, ...middle, { href: '/perfil', label: 'Perfil', icon: User }];
  const home = pathname === '/inicio';
  const current = [...NAV].sort((a, b) => b.href.length - a.href.length).find((n) => pathname === n.href || pathname.startsWith(n.href + '/'));
  const title = pathname === '/perfil' ? 'Perfil' : pathname === '/seguranca' ? 'Segurança da conta' : current?.label ?? 'DistribuiHub';
  const activeHref = [...tabs].sort((a, b) => b.href.length - a.href.length).find((t) => pathname === t.href || pathname.startsWith(t.href + '/'))?.href;

  return (
    <div className="appshell">
      <header className="app-top">
        {home
          ? <span className="app-brand" role="img" aria-label="DistribuiHub" />
          : <button className="app-back" onClick={() => router.back()} aria-label="Voltar"><ArrowLeft /></button>}
        <h1 className="app-title">{home ? '' : title}</h1>
        <span className="spacer" />
        <span className="app-who" aria-hidden>{me.user.name.split(' ')[0]}</span>
        <button className="app-bell" aria-label="Notificações"><Bell /></button>
      </header>
      <main className="app-content" id="conteudo">{driverOnly ? <GpsGate>{children}</GpsGate> : children}</main>
      <nav className="app-tabs" aria-label="Navegação principal">
        {tabs.map((t) => {
          const Icon = t.icon;
          const on = activeHref === t.href;
          return <Link key={t.href} href={t.href} className={`app-tab ${on ? 'on' : ''}`} aria-current={on ? 'page' : undefined}><Icon aria-hidden /><span>{t.label}</span></Link>;
        })}
      </nav>
    </div>
  );
}
