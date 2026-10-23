import { Boxes, LineChart, ShieldCheck, Store } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { DotPattern } from '@/components/magicui/dot-pattern';
import { BRAND } from '@/lib/brand';
import { VGON } from '@/lib/company';

const POINTS = [
  { icon: Boxes, text: 'Catálogo, estoque multidepósito e compras em um só lugar.' },
  { icon: Store, text: 'Pedidos de marketplaces importados e conciliados.' },
  { icon: LineChart, text: 'Financeiro, fluxo de caixa e DRE gerencial.' },
  { icon: ShieldCheck, text: 'Dados de cada empresa isolados no banco de dados.' },
];

/** Moldura das telas públicas (entrar, recuperar senha, convite, escolher empresa): painel de marca + formulário + rodapé legal. */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="auth-wrap">
      <aside className="auth-side">
        <DotPattern className="auth-dots" width={24} height={24} cr={1.1} aria-hidden />
        <div className="auth-side-in">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="sys-logo full on-dark" src="/brand/logo.png" alt={BRAND.name} />
          <div>
            <h2>Gestão completa para a sua distribuidora.</h2>
            <ul>{POINTS.map(({ icon: I, text }) => <li key={text}><I aria-hidden />{text}</li>)}</ul>
          </div>
          <small>© {new Date().getFullYear()} {BRAND.name} · {VGON.name} · CNPJ {VGON.cnpj}</small>
        </div>
      </aside>
      <main className="auth-main">
        <div className="auth-col">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="sys-logo full auth-top-logo" src="/brand/logo.png" alt={BRAND.name} />
          {children}
          <footer className="auth-foot">
            <nav aria-label="Informações legais"><Link href="/termos">Termos de uso</Link><span aria-hidden>·</span><Link href="/privacidade">Política de privacidade</Link></nav>
            <span>Suporte: <a href={`mailto:${VGON.email}`}>{VGON.email}</a></span>
          </footer>
        </div>
      </main>
    </div>
  );
}
