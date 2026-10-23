import {
  BarChart3, Bell, Boxes, Briefcase, ShoppingBag, Building2, ClipboardList, Container, FileText, Gauge, CreditCard, Landmark, Handshake, LayoutDashboard, type LucideIcon, Package, PackageSearch,
  Navigation, Percent, Plug, ReceiptText, Route, ScrollText, Settings2, ShieldCheck, ShoppingCart, Store, Truck, Users, Wallet, Warehouse,
} from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  group: string;
  permission?: string;
  /** false = módulo ainda não construído; abre uma página que informa a fase planejada. */
  implemented: boolean;
  phase?: number;
  description?: string;
}

/** Ordem dos menus. Cada grupo é um menu que abre e fecha, com os módulos dele como submenus. */
export const NAV_GROUPS = ['Geral', 'Comercial', 'Suprimentos', 'Canais e logística', 'Financeiro e fiscal', 'Administração'] as const;

/** Ícone de cada menu (o de "Geral" não aparece: ele tem um só item e vira link direto). */
export const NAV_GROUP_ICONS: Record<(typeof NAV_GROUPS)[number], LucideIcon> = {
  Geral: LayoutDashboard, Comercial: ShoppingBag, Suprimentos: Boxes, 'Canais e logística': Truck, 'Financeiro e fiscal': Wallet, Administração: Settings2,
};

export const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Visão geral', icon: LayoutDashboard, group: 'Geral', implemented: true },

  { href: '/vendas', label: 'Vendas e pedidos', icon: ShoppingCart, group: 'Comercial', permission: 'sales.view', implemented: true },
  { href: '/orcamentos', label: 'Orçamentos', icon: FileText, group: 'Comercial', permission: 'sales.view', implemented: true },
  { href: '/clientes', label: 'Clientes', icon: Users, group: 'Comercial', permission: 'customers.view', implemented: true },
  { href: '/carteira', label: 'Carteira de clientes', icon: Briefcase, group: 'Comercial', permission: 'customers.view', implemented: true },
  { href: '/comissoes', label: 'Vendedores e comissões', icon: Percent, group: 'Comercial', permission: 'commissions.view', implemented: true },

  { href: '/produtos', label: 'Produtos e catálogo', icon: Package, group: 'Suprimentos', permission: 'products.view', implemented: true },
  { href: '/estoque', label: 'Estoque', icon: Warehouse, group: 'Suprimentos', permission: 'stock.view', implemented: true },
  { href: '/armazem', label: 'Armazém', icon: ClipboardList, group: 'Suprimentos', permission: 'sales.fulfill', implemented: true },
  { href: '/compras', label: 'Compras', icon: PackageSearch, group: 'Suprimentos', permission: 'purchases.view', implemented: true },
  { href: '/fornecedores', label: 'Fornecedores', icon: Handshake, group: 'Suprimentos', permission: 'suppliers.view', implemented: true },

  { href: '/integracoes', label: 'Marketplaces', icon: Plug, group: 'Canais e logística', permission: 'integrations.view', implemented: true },
  { href: '/expedicao', label: 'Expedição', icon: Truck, group: 'Canais e logística', permission: 'logistics.view', implemented: true },
  { href: '/frota', label: 'Frota e carga', icon: Container, group: 'Canais e logística', permission: 'routes.view', implemented: true },
  { href: '/rotas', label: 'Rotas e entregas', icon: Route, group: 'Canais e logística', permission: 'routes.view', implemented: true },
  { href: '/motorista', label: 'Minhas entregas', icon: Navigation, group: 'Canais e logística', permission: 'delivery.perform', implemented: true },

  { href: '/financeiro', label: 'Financeiro', icon: Wallet, group: 'Financeiro e fiscal', permission: 'finance.view', implemented: true },
  { href: '/fiscal', label: 'Fiscal e notas', icon: ReceiptText, group: 'Financeiro e fiscal', permission: 'fiscal.view', implemented: true },
  { href: '/impostos', label: 'Impostos', icon: Landmark, group: 'Financeiro e fiscal', permission: 'fiscal.view', implemented: true },
  { href: '/gestao', label: 'Metas e indicadores', icon: Gauge, group: 'Financeiro e fiscal', permission: 'management.view', implemented: true },
  { href: '/relatorios', label: 'Relatórios', icon: BarChart3, group: 'Financeiro e fiscal', permission: 'reports.view', implemented: true },

  { href: '/empresa', label: 'Empresa e estrutura', icon: Building2, group: 'Administração', permission: 'company.view', implemented: true },
  { href: '/usuarios', label: 'Usuários e papéis', icon: ShieldCheck, group: 'Administração', permission: 'users.view', implemented: true },
  { href: '/avisos', label: 'Avisos ao cliente', icon: Bell, group: 'Administração', permission: 'notifications.manage', implemented: true },
  { href: '/configuracoes', label: 'Políticas comerciais', icon: Settings2, group: 'Administração', permission: 'tenant.manage', implemented: true },
  { href: '/plano', label: 'Plano e uso', icon: CreditCard, group: 'Administração', permission: 'tenant.manage', implemented: true },
  { href: '/auditoria', label: 'Auditoria', icon: ScrollText, group: 'Administração', permission: 'audit.view', implemented: true },
  { href: '/plataforma', label: 'Plataforma (admin global)', icon: Store, group: 'Administração', permission: 'platform.admin', implemented: true },
];

export const findModule = (slug: string) => NAV.find((n) => n.href === `/m/${slug}`);
