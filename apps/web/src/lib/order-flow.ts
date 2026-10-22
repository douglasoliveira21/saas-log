/** Jornada do pedido: o que cada situação significa e qual é o próximo passo (texto didático da tela de Vendas). */
export type Tone = '' | 'ok' | 'warn' | 'danger' | 'info' | 'brand';

export const FLOW: string[] = ['DRAFT', 'CONFIRMED', 'PICKING', 'PACKED', 'SHIPPED', 'DELIVERED'];

export const STATUS_INFO: Record<string, { tone: Tone; short: string; meaning: string; next: string }> = {
  DRAFT: { tone: '', short: 'Ainda em edição', meaning: 'O pedido está sendo montado. Nada foi reservado no estoque e nada foi cobrado.', next: 'Confira os itens e clique em “Confirmar pedido” para reservar o estoque.' },
  PENDING_APPROVAL: { tone: 'warn', short: 'Espera um aprovador', meaning: 'O pedido passou de uma regra (por exemplo, desconto acima do limite) e precisa da liberação de um gestor.', next: 'Quem tem permissão de aprovar deve “Aprovar” ou “Rejeitar” (volta a rascunho).' },
  CONFIRMED: { tone: 'info', short: 'Estoque reservado', meaning: 'O estoque está reservado para este pedido. Ainda não saiu do depósito.', next: 'O depósito deve clicar em “Iniciar separação”.' },
  PICKING: { tone: 'info', short: 'Sendo separado', meaning: 'O depósito está separando os produtos nas prateleiras.', next: 'Quando terminar de separar, clique em “Marcar embalado”.' },
  PACKED: { tone: 'info', short: 'Pronto para sair', meaning: 'Os produtos estão embalados e esperando a saída.', next: 'Clique em “Expedir”: isso dá baixa no estoque físico. Emita a nota em Fiscal → Notas de saída.' },
  SHIPPED: { tone: 'brand', short: 'A caminho do cliente', meaning: 'O pedido saiu do depósito e o estoque físico já foi baixado.', next: 'Quando o cliente receber, clique em “Confirmar entrega” (ou o motorista confirma pela rota, com a foto do canhoto).' },
  DELIVERED: { tone: 'ok', short: 'Cliente recebeu', meaning: 'A entrega foi confirmada.', next: 'Encerre o pedido quando não houver mais nada pendente. Se algo voltou, registre a devolução.' },
  CLOSED: { tone: 'ok', short: 'Finalizado', meaning: 'Pedido encerrado. Só é possível registrar devolução.', next: 'Nada a fazer.' },
  CANCELLED: { tone: 'danger', short: 'Cancelado', meaning: 'O pedido foi cancelado: reservas liberadas e comissões estornadas.', next: 'Nada a fazer. O motivo aparece no detalhe.' },
};

/** Agrupa as situações para o resumo do topo da tela. */
export const SUMMARY_GROUPS: { key: string; label: string; hint: string; statuses: string[]; tone: Tone }[] = [
  { key: 'draft', label: 'Rascunhos', hint: 'Ainda em edição', statuses: ['DRAFT'], tone: '' },
  { key: 'approval', label: 'Aguardando aprovação', hint: 'Dependem de um gestor', statuses: ['PENDING_APPROVAL'], tone: 'warn' },
  { key: 'warehouse', label: 'No depósito', hint: 'Confirmados, em separação ou embalados', statuses: ['CONFIRMED', 'PICKING', 'PACKED'], tone: 'info' },
  { key: 'transit', label: 'A caminho', hint: 'Já saíram do depósito', statuses: ['SHIPPED'], tone: 'brand' },
  { key: 'done', label: 'Entregues', hint: 'Entregues ou encerrados', statuses: ['DELIVERED', 'CLOSED'], tone: 'ok' },
];
