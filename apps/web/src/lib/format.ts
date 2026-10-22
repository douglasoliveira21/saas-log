export const brl = (v: string | number | null | undefined) =>
  v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Datas só com dia (vencimento, saída prevista) chegam como AAAA-MM-DD ou meia-noite UTC: formatadas direto, sem recuar um dia no fuso do Brasil. */
export const dateBr = (v: string | null | undefined) => {
  if (!v) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.0+)?Z)?$/.exec(v);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : new Date(v).toLocaleDateString('pt-BR');
};

export const ORDER_STATUS: Record<string, string> = {
  DRAFT: 'Rascunho', PENDING_APPROVAL: 'Aguardando aprovação', CONFIRMED: 'Confirmado', PICKING: 'Em separação', PACKED: 'Embalado',
  SHIPPED: 'Enviado', DELIVERED: 'Entregue', CLOSED: 'Encerrado', CANCELLED: 'Cancelado',
};
export const PURCHASE_STATUS: Record<string, string> = {
  DRAFT: 'Rascunho', PENDING_APPROVAL: 'Aguardando aprovação', APPROVED: 'Aprovada', PARTIALLY_RECEIVED: 'Recebida parcialmente', RECEIVED: 'Recebida', CANCELLED: 'Cancelada',
};

// ───────────── documentos e contatos (exibição e máscaras) ─────────────
export const digits = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '');

export function formatCnpj(v: string | null | undefined): string {
  const d = digits(v).slice(0, 14);
  return d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2');
}
export function formatCpf(v: string | null | undefined): string {
  const d = digits(v).slice(0, 11);
  return d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2');
}
/** CPF (até 11 dígitos) ou CNPJ (acima disso), formatando conforme se digita. Valor vazio ⇒ "—" em exibição via `docOrDash`. */
export const formatCpfCnpj = (v: string | null | undefined) => (digits(v).length > 11 ? formatCnpj(v) : formatCpf(v));
export const docOrDash = (v: string | null | undefined) => (v ? formatCpfCnpj(v) : '—');

/** (11) 99999-9999 · (11) 3333-4444 · 0800 777 1234. Valores fora do padrão são mostrados como estão. */
export function formatPhone(v: string | null | undefined): string {
  let d = digits(v);
  if (!d) return '';
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if (d.length > 11) return v ?? '';
  if (d.startsWith('0800') && d.length <= 11) return d.replace(/^(\d{4})(\d{0,3})(\d{0,4}).*/, (_m, a, b, c) => [a, b, c].filter(Boolean).join(' '));
  if (d.length <= 2) return d.length ? `(${d}` : '';
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}${d.length > 6 ? '-' + d.slice(6) : ''}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7, 11)}`;
}
export const phoneOrDash = (v: string | null | undefined) => (v ? formatPhone(v) : '—');

export const formatCep = (v: string | null | undefined) => digits(v).slice(0, 8).replace(/^(\d{5})(\d)/, '$1-$2');
export const formatCnae = (v: string | null | undefined) => digits(v).slice(0, 7).replace(/^(\d{4})(\d)/, '$1-$2').replace(/^(\d{4}-\d)(\d)/, '$1/$2');
/** Chave de acesso da NF-e em blocos de 4 dígitos. */
export const formatAccessKey = (v: string | null | undefined) => digits(v).replace(/(\d{4})(?=\d)/g, '$1 ');
export const formatNcm = (v: string | null | undefined) => digits(v).slice(0, 8).replace(/^(\d{4})(\d)/, '$1.$2').replace(/^(\d{4}\.\d{2})(\d)/, '$1.$2');
