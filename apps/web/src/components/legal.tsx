import { ArrowLeft, Printer } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { BRAND } from '@/lib/brand';
import { LEGAL_UPDATED, VGON } from '@/lib/company';

export interface LegalSection { id: string; title: string; body: ReactNode }

/** Estrutura das páginas públicas de texto legal: barra com a marca, índice lateral e o documento. */
export function LegalPage({ title, intro, sections, other }: { title: string; intro: ReactNode; sections: LegalSection[]; other: { href: string; label: string } }) {
  return (
    <div className="legal-page">
      <header className="legal-bar">
        <Link href="/login" className="row" style={{ gap: 10, textDecoration: 'none' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="sys-logo full" src="/brand/logo.png" alt={BRAND.name} />
        </Link>
        <nav className="row" aria-label="Textos legais" style={{ gap: 14 }}>
          <Link href={other.href}>{other.label}</Link>
          <Link href="/login" className="btn sm"><ArrowLeft aria-hidden />Voltar ao acesso</Link>
        </nav>
      </header>
      <div className="legal-wrap">
        <nav className="legal-toc" aria-label="Índice">
          <strong>Neste documento</strong>
          <ol>{sections.map((s, i) => <li key={s.id}><a href={`#${s.id}`}>{i + 1}. {s.title}</a></li>)}</ol>
        </nav>
        <article className="legal-doc">
          <h1>{title}</h1>
          <p className="legal-meta">Última atualização: {LEGAL_UPDATED}.</p>
          <div className="legal-id">
            <strong>{VGON.name}</strong> · CNPJ {VGON.cnpj}<br />
            Contato e suporte: <a href={`mailto:${VGON.email}`}>{VGON.email}</a>
          </div>
          {intro}
          {sections.map((s, i) => (
            <section key={s.id} id={s.id}>
              <h2>{i + 1}. {s.title}</h2>
              {s.body}
            </section>
          ))}
          <p className="legal-meta" style={{ marginTop: 32 }}><Printer size={14} aria-hidden style={{ verticalAlign: '-2px' }} /> Dica: use “Imprimir” do navegador para salvar este documento em PDF.</p>
        </article>
      </div>
      <p className="legal-foot">© {new Date().getFullYear()} {VGON.name} · CNPJ {VGON.cnpj} · {BRAND.name}</p>
    </div>
  );
}
