'use client';

import { Boxes, LineChart, ShieldCheck, Store } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
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
  const reducedMotion = useReducedMotion();
  const enter = reducedMotion ? undefined : { opacity: 1, y: 0 };
  return (
    <div className="auth-wrap">
      <aside className="auth-side">
        <DotPattern className="auth-dots" width={24} height={24} cr={1.1} aria-hidden />
        <motion.div className="auth-side-in" initial={reducedMotion ? undefined : { opacity: 0, x: -24 }} animate={reducedMotion ? undefined : { opacity: 1, x: 0 }} transition={{ duration: .55, ease: 'easeOut' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="sys-logo full on-dark" src="/brand/logo.png" alt={BRAND.name} />
          <div>
            <h2>Gestão completa para a sua distribuidora.</h2>
            <ul>{POINTS.map(({ icon: I, text }, i) => <motion.li key={text} initial={reducedMotion ? undefined : { opacity: 0, x: -10 }} animate={reducedMotion ? undefined : { opacity: 1, x: 0 }} transition={{ delay: reducedMotion ? 0 : .16 + i * .07, duration: .35 }}><I aria-hidden />{text}</motion.li>)}</ul>
          </div>
          <small>© {new Date().getFullYear()} {BRAND.name} · {VGON.name} · CNPJ {VGON.cnpj}</small>
        </motion.div>
      </aside>
      <main className="auth-main">
        <motion.div className="auth-col" initial={reducedMotion ? undefined : { opacity: 0, y: 18 }} animate={enter} transition={{ duration: .45, delay: .08, ease: 'easeOut' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="sys-logo full auth-top-logo" src="/brand/logo.png" alt={BRAND.name} />
          {children}
          <footer className="auth-foot">
            <nav aria-label="Informações legais"><Link href="/termos">Termos de uso</Link><span aria-hidden>·</span><Link href="/privacidade">Política de privacidade</Link></nav>
            <span>Suporte: <a href={`mailto:${VGON.email}`}>{VGON.email}</a></span>
          </footer>
        </motion.div>
      </main>
    </div>
  );
}
