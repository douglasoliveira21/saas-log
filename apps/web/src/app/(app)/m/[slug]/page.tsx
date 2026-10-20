'use client';

import Link from 'next/link';
import { use } from 'react';
import { findModule } from '@/lib/nav';

export default function ModulePlaceholder({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const mod = findModule(slug);
  if (!mod) return <div className="empty">Módulo não encontrado.</div>;
  return (
    <>
      <h1>{mod.label}</h1>
      <div className="card" style={{ marginTop: 16 }}>
        <span className="badge warn">Não implementado — planejado para a Fase {mod.phase}</span>
        <p>{mod.description ?? 'Este módulo ainda não foi construído.'}</p>
        <p className="muted">Nenhuma ação está disponível aqui por enquanto. Consulte o roadmap em <code>docs/ROADMAP.md</code>.</p>
        <Link href="/dashboard">← Voltar à visão geral</Link>
      </div>
    </>
  );
}
