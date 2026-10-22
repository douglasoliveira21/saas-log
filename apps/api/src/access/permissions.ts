// Catálogo de permissões e papéis de sistema. Cada fase acrescenta as suas permissões.
// Só entram aqui permissões efetivamente aplicadas no servidor.

export const PERMISSIONS = {
  'tenant.manage': 'Administrar dados e plano da empresa contratante',
  'company.view': 'Consultar empresas e estabelecimentos',
  'company.manage': 'Criar e editar empresas e estabelecimentos',
  'warehouse.view': 'Consultar depósitos',
  'warehouse.manage': 'Criar e editar depósitos',
  'users.view': 'Consultar usuários e papéis',
  'users.manage': 'Convidar, alterar e suspender usuários',
  'roles.manage': 'Criar e editar papéis personalizados',
  'audit.view': 'Consultar a trilha de auditoria',
  'products.view': 'Consultar produtos e categorias',
  'products.manage': 'Criar, editar e importar produtos e categorias',
  'suppliers.view': 'Consultar fornecedores',
  'suppliers.manage': 'Criar e editar fornecedores',
  'stock.view': 'Consultar saldos e movimentações de estoque',
  'stock.move': 'Registrar entradas, saídas, transferências e reservas',
  'stock.adjust': 'Ajustar e estornar movimentos de estoque',
  'stock.approve': 'Aprovar inventários e ajustes',
  'customers.view': 'Consultar clientes',
  'customers.manage': 'Criar e editar clientes',
  'sales.view': 'Consultar os próprios pedidos de venda',
  'sales.view_all': 'Consultar pedidos de todos os vendedores',
  'sales.create': 'Criar, editar e enviar pedidos de venda; cancelar',
  'sales.approve': 'Aprovar pedidos com desconto acima do limite ou preço abaixo do mínimo',
  'sales.fulfill': 'Separar, embalar, expedir e entregar pedidos',
  'sales.return': 'Registrar devoluções de venda',
  'commissions.view': 'Consultar comissões (próprias, ou todas com sales.view_all)',
  'commissions.manage': 'Gerir vendedores, regras de comissão e pagamentos',
  'purchases.view': 'Consultar ordens de compra',
  'purchases.create': 'Criar, editar e enviar ordens de compra',
  'purchases.approve': 'Aprovar ordens de compra acima do limite',
  'purchases.receive': 'Registrar e estornar recebimentos de mercadoria',
  'integrations.view': 'Consultar conexões, jobs, webhooks e logs de integrações',
  'pricing.view': 'Consultar custos, margens e simulador de preços',
  'pricing.manage': 'Definir preços e margens mínimas por canal',
  'fiscal.view': 'Consultar configuração fiscal, documentos e regras',
  'fiscal.manage': 'Configurar parâmetros fiscais e gerenciar certificado digital',
  'fiscal.import': 'Importar XML de documentos recebidos e conciliar com compras',
  'fiscal.rules': 'Criar e editar regras tributárias (rascunho)',
  'fiscal.approve': 'Aprovar regras tributárias e a configuração fiscal (validação do contador)',
  'fiscal.emit': 'Preparar e transmitir documentos fiscais de saída',
  'finance.view': 'Consultar contas a pagar/receber, caixa e DRE',
  'finance.manage': 'Lançar títulos e registrar baixas/estornos; cadastros financeiros',
  'finance.approve': 'Aprovar pagamentos acima do limite configurado e liberar clientes bloqueados por inadimplência',
  'finance.reconcile': 'Importar extratos e conciliar bancos e marketplaces',
  'reports.view': 'Consultar a central de relatórios',
  'reports.export': 'Exportar relatórios (CSV/XLSX)',
  'logistics.view': 'Consultar expedição e rastreamento',
  'logistics.manage': 'Registrar envios, embalagens e eventos de rastreamento',
  'routes.view': 'Consultar rotas de entrega, motoristas e comprovantes (canhotos)',
  'routes.manage': 'Cadastrar motoristas, montar, iniciar e cancelar rotas de entrega',
  'delivery.perform': 'Motorista: ver as próprias rotas e confirmar entregas com a foto do canhoto',
  'integrations.manage': 'Conectar, configurar, ativar, pausar e desconectar canais; reprocessar jobs',
} as const;

export type PermissionCode = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PermissionCode[];

export interface SystemRoleDef {
  key: string;
  name: string;
  permissions: PermissionCode[];
}

const operational: PermissionCode[] = ['company.view', 'warehouse.view', 'products.view', 'stock.view'];

const salesRead: PermissionCode[] = ['customers.view', 'sales.view', 'sales.view_all'];

export const SYSTEM_ROLES: SystemRoleDef[] = [
  { key: 'owner', name: 'Proprietário da empresa', permissions: ALL_PERMISSIONS },
  { key: 'admin', name: 'Administrador do tenant', permissions: ALL_PERMISSIONS.filter((p) => p !== 'tenant.manage') },
  {
    key: 'ops_manager',
    name: 'Gerente operacional',
    permissions: [
      ...operational, 'warehouse.manage', 'products.manage', 'suppliers.view', 'suppliers.manage', 'stock.move', 'stock.adjust', 'stock.approve',
      ...salesRead, 'sales.fulfill', 'sales.return', 'purchases.view', 'purchases.create', 'purchases.approve', 'purchases.receive', 'integrations.view', 'pricing.view', 'fiscal.view', 'fiscal.import', 'logistics.view', 'logistics.manage', 'routes.view', 'routes.manage', 'reports.view',
    ],
  },
  {
    key: 'commercial_manager',
    name: 'Gerente comercial',
    permissions: [
      ...operational, 'products.manage', ...salesRead, 'customers.manage', 'sales.create', 'sales.approve', 'sales.return', 'commissions.view', 'commissions.manage', 'integrations.view', 'pricing.view', 'pricing.manage', 'reports.view',
    ],
  },
  { key: 'buyer', name: 'Comprador', permissions: [...operational, 'suppliers.view', 'suppliers.manage', 'purchases.view', 'purchases.create', 'fiscal.view', 'fiscal.import'] },
  { key: 'salesperson', name: 'Vendedor', permissions: [...operational, 'customers.view', 'customers.manage', 'sales.view', 'sales.create', 'commissions.view'] },
  { key: 'stock_operator', name: 'Operador de estoque', permissions: [...operational, 'stock.move', 'sales.view', 'sales.view_all', 'sales.fulfill', 'purchases.view', 'purchases.receive', 'logistics.view'] },
  { key: 'shipper', name: 'Expedidor', permissions: [...operational, 'stock.move', 'sales.view', 'sales.view_all', 'sales.fulfill', 'logistics.view', 'logistics.manage', 'routes.view', 'routes.manage'] },
  { key: 'driver', name: 'Motorista', permissions: ['delivery.perform'] },
  { key: 'finance', name: 'Financeiro', permissions: ['company.view', 'products.view', 'suppliers.view', ...salesRead, 'purchases.view', 'commissions.view', 'pricing.view', 'finance.view', 'finance.manage', 'finance.reconcile', 'reports.view', 'reports.export'] },
  { key: 'fiscal', name: 'Fiscal', permissions: ['company.view', 'products.view', 'products.manage', ...salesRead, 'purchases.view', 'fiscal.view', 'fiscal.manage', 'fiscal.import', 'fiscal.rules', 'fiscal.emit'] },
  { key: 'accountant', name: 'Contador (acesso limitado)', permissions: ['company.view', 'products.view', 'fiscal.view', 'fiscal.rules', 'fiscal.approve', 'finance.view', 'reports.view'] },
  {
    key: 'auditor',
    name: 'Auditor (somente leitura)',
    permissions: [...operational, 'suppliers.view', 'users.view', 'audit.view', ...salesRead, 'commissions.view', 'purchases.view', 'integrations.view', 'pricing.view', 'fiscal.view', 'finance.view', 'reports.view', 'logistics.view'],
  },
];

export function isPermissionCode(v: string): v is PermissionCode {
  return v in PERMISSIONS;
}
