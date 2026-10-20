'use client';

import { ArrowLeft, Construction } from 'lucide-react';
import Link from 'next/link';
import { use } from 'react';
import { EmptyState, PageHeader } from '@/components/ui';
import { findModule } from '@/lib/nav';

export default function ModulePlaceholder({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const mod = findModule(slug);
  if (!mod) return <EmptyState title="Módulo não encontrado" action={<Link className="btn" href="/dashboard"><ArrowLeft />Voltar à visão geral</Link>} />;
  return (
    <>
      <PageHeader title={mod.label} />
      <div className="card">
        <EmptyState icon={<Construction size={22} />} title={`Planejado para a Fase ${mod.phase}`} action={<Link className="btn" href="/dashboard"><ArrowLeft />Voltar à visão geral</Link>}>
          {mod.description ?? 'Este módulo ainda não foi construído e nenhuma ação está disponível por enquanto.'}
        </EmptyState>
      </div>
    </>
  );
}
