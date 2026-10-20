import { Boxes, LineChart, ShieldCheck, Store } from 'lucide-react';
import type { ReactNode } from 'react';
import { BRAND } from '@/lib/brand';

const POINTS = [
  { icon: Boxes, text: 'Catálogo, estoque multidepósito e compras em um só lugar.' },
  { icon: Store, text: 'Pedidos de marketplaces importados e conciliados.' },
  { icon: LineChart, text: 'Financeiro, fluxo de caixa e DRE gerencial.' },
  { icon: ShieldCheck, text: 'Dados de cada empresa isolados no banco de dados.' },
];

/** Moldura das telas públicas (entrar, criar conta, escolher empresa): painel de marca + formulário. */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="auth-wrap">
      <aside className="auth-side" aria-hidden="true">
        <div className="sidebar-head" style={{ padding: 0 }}><div className="logo">{BRAND.name.slice(0, 1)}</div><span className="brand">{BRAND.name}</span></div>
        <div>
          <h2>Gestão completa para a sua distribuidora.</h2>
          <ul>{POINTS.map(({ icon: I, text }) => <li key={text}><I />{text}</li>)}</ul>
        </div>
        <small style={{ opacity: 0.7 }}>© {new Date().getFullYear()} {BRAND.name}</small>
      </aside>
      <main className="auth-main">{children}</main>
    </div>
  );
}
