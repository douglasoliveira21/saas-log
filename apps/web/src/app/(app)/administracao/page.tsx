'use client';

import { Building2, ShieldCheck, Store } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { ADMIN_NAV } from '@/lib/nav';
import { useSession } from '@/lib/session';

export default function AdministrationPage() {
  const { me, can } = useSession();
  const items = ADMIN_NAV.filter((item) => can(item.permission));
  return <>
    <PageHeader title="Administração do tenant" description="Configurações da empresa exibidas conforme as permissões do administrador responsável." />
    <div className="admin-hero card">
      <div className="admin-hero-icon"><ShieldCheck aria-hidden /></div>
      <div><strong>Administrador do tenant</strong><p className="muted">Cada função exige sua própria permissão e as alterações são registradas na auditoria.</p></div>
    </div>
    <div className="admin-grid">
      {items.map((item) => { const Icon=item.icon; return <Link href={item.href} className="admin-card card" key={item.href}>
        <span className="admin-card-icon"><Icon aria-hidden /></span><span><strong>{item.label}</strong><small>{adminDescription(item.href)}</small></span>
      </Link>; })}
    </div>
    {me.platformAdmin && <section className="card" style={{marginTop:18}}><div className="row"><span className="admin-card-icon"><Store aria-hidden /></span><div><h2 style={{margin:0}}>Administração global da plataforma</h2><p className="muted" style={{margin:'4px 0 10px'}}>Área independente dos dados e configurações deste tenant.</p><Link className="btn" href="/plataforma"><Building2 size={16}/>Abrir plataforma</Link></div></div></section>}
  </>;
}

function adminDescription(href: string) {
  return ({
    '/empresa':'Empresas, estabelecimentos e depósitos.', '/onboarding':'Roteiro de configuração inicial.', '/migracao':'Importação segura do ERP anterior.',
    '/usuarios':'Usuários, convites, papéis e permissões.', '/suporte':'Autorizações temporárias de suporte.', '/avisos':'Regras e canais de notificação.',
    '/configuracoes':'Políticas comerciais do tenant.', '/plano':'Assinatura, limites e consumo.', '/auditoria':'Histórico das ações administrativas.',
  } as Record<string,string>)[href] ?? '';
}
