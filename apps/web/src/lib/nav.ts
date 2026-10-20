export interface NavItem {
  href: string;
  label: string;
  icon: string;
  permission?: string;
  /** false = módulo ainda não construído; abre uma página que informa a fase planejada. */
  implemented: boolean;
  phase?: number;
  description?: string;
  group?: 'admin';
}

export const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Visão geral', icon: '▦', implemented: true },
    { href: '/produtos', label: 'Produtos e catálogo', icon: '▤', permission: 'products.view', implemented: true },
  { href: '/precos', label: 'Preços e margens', icon: '¢', permission: 'pricing.view', implemented: true },
  { href: '/vendas', label: 'Vendas e pedidos', icon: '⤒', permission: 'sales.view', implemented: true },
  { href: '/clientes', label: 'Clientes', icon: '☺', permission: 'customers.view', implemented: true },
  { href: '/compras', label: 'Compras', icon: '⤓', permission: 'purchases.view', implemented: true },
  { href: '/comissoes', label: 'Vendedores e comissões', icon: '%', permission: 'commissions.view', implemented: true },
  { href: '/integracoes', label: 'Marketplaces e integrações', icon: '⇄', permission: 'integrations.view', implemented: true },
    { href: '/estoque', label: 'Estoque', icon: '▥', permission: 'stock.view', implemented: true },
  { href: '/inventario', label: 'Inventário', icon: '☑', permission: 'stock.view', implemented: true },
    { href: '/fornecedores', label: 'Fornecedores', icon: '⚑', permission: 'suppliers.view', implemented: true },
  { href: '/fiscal', label: 'Fiscal e notas', icon: '✎', permission: 'fiscal.view', implemented: true },
  { href: '/expedicao', label: 'Logística e expedição', icon: '✈', permission: 'logistics.view', implemented: true },
  { href: '/financeiro', label: 'Financeiro', icon: '$', permission: 'finance.view', implemented: true },
  { href: '/relatorios', label: 'Relatórios', icon: '≣', permission: 'reports.view', implemented: true },
  { href: '/m/notificacoes', label: 'Notificações', icon: '🔔', implemented: false, phase: 4 },
  { href: '/plano', label: 'Plano e uso', icon: '◔', permission: 'tenant.manage', implemented: true, group: 'admin' },
  { href: '/plataforma', label: 'Plataforma (admin global)', icon: '⚑', permission: 'platform.admin', implemented: true, group: 'admin' },
  { href: '/empresa', label: 'Empresa e depósitos', icon: '⌂', permission: 'company.view', implemented: true, group: 'admin' },
  { href: '/usuarios', label: 'Usuários e papéis', icon: '☷', permission: 'users.view', implemented: true, group: 'admin' },
  { href: '/configuracoes', label: 'Políticas comerciais', icon: '⚙', permission: 'tenant.manage', implemented: true, group: 'admin' },
  { href: '/auditoria', label: 'Auditoria', icon: '⌕', permission: 'audit.view', implemented: true, group: 'admin' },
];

export const findModule = (slug: string) => NAV.find((n) => n.href === `/m/${slug}`);
