export const brl = (v: string | number | null | undefined) =>
  v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const dateBr = (v: string | null | undefined) => (v ? new Date(v).toLocaleDateString('pt-BR') : '—');

export const ORDER_STATUS: Record<string, string> = {
  DRAFT: 'Rascunho', PENDING_APPROVAL: 'Aguardando aprovação', CONFIRMED: 'Confirmado', PICKING: 'Em separação', PACKED: 'Embalado',
  SHIPPED: 'Enviado', DELIVERED: 'Entregue', CLOSED: 'Encerrado', CANCELLED: 'Cancelado',
};
export const PURCHASE_STATUS: Record<string, string> = {
  DRAFT: 'Rascunho', PENDING_APPROVAL: 'Aguardando aprovação', APPROVED: 'Aprovada', PARTIALLY_RECEIVED: 'Recebida parcialmente', RECEIVED: 'Recebida', CANCELLED: 'Cancelada',
};
