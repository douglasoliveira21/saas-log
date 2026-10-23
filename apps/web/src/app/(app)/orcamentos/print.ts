import { api } from '@/lib/api';
import { brl, dateBr } from '@/lib/format';
import { PAYMENT_LABEL } from '@/lib/order-flow';
import { cnpjFmt, docFmt, esc, PRINT_CSS } from '../vendas/print';

interface QuotePrint {
  quote: {
    number: number; createdAt: string; validUntil: string; displayStatus: string; paymentMethod: string | null; notes: string | null;
    subtotal: string; discountTotal: string; shipping: string; total: string;
    customer: { name: string; document: string | null; phone: string | null; email: string | null };
    items: { quantity: number; unitPrice: string; discountPct: string; total: string; product: { sku: string; name: string; saleUnit: string } }[];
  };
  company: { name: string; legalName: string; cnpj: string | null; stateRegistration: string | null; address: string; phone: string | null; email: string | null };
  salesperson: { name: string; phone: string | null; email: string | null } | null;
  logo: string | null;
}

const phoneFmt = (v: string | null) => { const d = (v ?? '').replace(/\D/g, ''); return d.length === 11 ? d.replace(/^(\d{2})(\d{5})(\d{4})$/, '($1) $2-$3') : d.length === 10 ? d.replace(/^(\d{2})(\d{4})(\d{4})$/, '($1) $2-$3') : v ?? ''; };
const STATUS: Record<string, string> = { OPEN: 'Em aberto', CONVERTED: 'Aprovado (virou pedido)', LOST: 'Não aprovado', EXPIRED: 'Vencido' };
const EXTRA_CSS = `
.valid{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:14px 0 0;padding:11px 16px;border-radius:10px;background:linear-gradient(90deg,#eaf1ff,#f4f7fc);border:1px solid #cfdcf7}
.valid b{font-size:15px;color:#1d4ed8}.valid span{color:#445063}
.valid.expired{background:#fdecec;border-color:#f3c3c3}.valid.expired b{color:#b3261e}
.terms{margin-top:14px;padding:10px 14px;border:1px dashed #b8c4d8;border-radius:8px;color:#5b6675;font-size:10.5px;line-height:1.55}
.terms ul{margin:4px 0 0;padding-left:16px}
.contact{margin-top:2px;color:#5b6675;font-size:10.5px}
`;

export function quoteHtml(d: QuotePrint): string {
  const q = d.quote;
  const expired = q.displayStatus === 'EXPIRED';
  const disc = Number(q.discountTotal) > 0;
  const rows = q.items.map((i, k) => `<tr><td class="c">${k + 1}</td><td><b>${esc(i.product.name)}</b><div class="sku">${esc(i.product.sku)}</div></td><td class="r">${i.quantity}${i.product.saleUnit ? ` ${esc(i.product.saleUnit)}` : ''}</td><td class="r">${esc(brl(i.unitPrice))}</td><td class="r">${Number(i.discountPct) ? `${Number(i.discountPct)}%` : '—'}</td><td class="r"><b>${esc(brl(i.total))}</b></td></tr>`).join('');
  const sellerLine = d.salesperson ? `<div class="contact">${esc([phoneFmt(d.salesperson.phone), d.salesperson.email].filter(Boolean).join(' · '))}</div>` : '';
  const clientLine = [phoneFmt(q.customer.phone), q.customer.email].filter(Boolean).join(' · ');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Orçamento ${q.number} — ${esc(d.company.name)}</title><style>${PRINT_CSS}${EXTRA_CSS}</style></head><body>
<div class="top"><div class="brand">${d.logo ? `<img class="logo" src="${esc(d.logo)}" alt="">` : ''}<div><h1>${esc(d.company.name)}</h1><p>${esc(d.company.legalName !== d.company.name ? d.company.legalName : '')}${d.company.cnpj ? ` · CNPJ ${esc(cnpjFmt(d.company.cnpj))}` : ''}${d.company.stateRegistration ? ` · IE ${esc(d.company.stateRegistration)}` : ''}</p><p>${esc(d.company.address)}</p><p>${esc([phoneFmt(d.company.phone), d.company.email].filter(Boolean).join(' · '))}</p></div></div>
<div class="num"><span class="tag">Proposta comercial</span><div class="n">Orçamento #${q.number}</div><div class="d">Emitido em ${esc(dateBr(q.createdAt))}</div></div></div>
<div class="valid ${expired ? 'expired' : ''}"><span>${expired ? 'Esta proposta venceu em' : 'Proposta válida até'}</span><b>${esc(dateBr(q.validUntil))}</b><span>${esc(STATUS[q.displayStatus] ?? '')}</span></div>
<div class="cards">
<div class="card"><small>Cliente</small><b>${esc(q.customer.name)}</b>${q.customer.document ? `<div>${esc(docFmt(q.customer.document))}</div>` : ''}${clientLine ? `<div class="contact">${esc(clientLine)}</div>` : ''}</div>
<div class="card"><small>Vendedor</small><b>${esc(d.salesperson?.name ?? '—')}</b>${sellerLine}</div>
<div class="card"><small>Pagamento previsto</small><b>${esc(q.paymentMethod ? PAYMENT_LABEL[q.paymentMethod] ?? q.paymentMethod : 'A combinar')}</b></div></div>
<section><h3>Itens da proposta</h3><table><thead><tr><th style="width:28px" class="c">#</th><th>Produto</th><th class="r" style="width:64px">Qtd.</th><th class="r" style="width:80px">Preço</th><th class="r" style="width:54px">Desc.</th><th class="r" style="width:90px">Total</th></tr></thead><tbody>${rows}</tbody></table></section>
<div class="totals"><div><span>Produtos</span><span>${esc(brl(q.subtotal))}</span></div>${disc ? `<div><span>Descontos</span><span>− ${esc(brl(q.discountTotal))}</span></div>` : ''}${Number(q.shipping) > 0 ? `<div><span>Frete</span><span>${esc(brl(q.shipping))}</span></div>` : ''}<div class="g"><span>Total</span><span>${esc(brl(q.total))}</span></div></div>
${q.notes ? `<div class="note"><b>Observações:</b> ${esc(q.notes)}</div>` : ''}
<div class="terms"><b>Condições</b><ul><li>Preços e condições válidos até ${esc(dateBr(q.validUntil))}.</li><li>Sujeito à disponibilidade de estoque no momento da confirmação do pedido.</li><li>Este documento é uma proposta comercial e não substitui a nota fiscal.</li></ul></div>
<div class="sign"><div>${esc(d.salesperson?.name ?? d.company.name)}</div><div>De acordo — ${esc(q.customer.name)} (nome, data e assinatura)</div></div>
<div class="foot"><span>Proposta gerada pelo sistema. Dúvidas? ${esc([phoneFmt(d.salesperson?.phone ?? d.company.phone), d.salesperson?.email ?? d.company.email].filter(Boolean).join(' · ') || d.company.name)}</span><span>Impresso em ${esc(new Date().toLocaleString('pt-BR'))}</span></div>
</body></html>`;
}

/** Abre a proposta em uma janela pronta para imprimir ou "Salvar como PDF". A janela abre já no clique (pop-up). Devolve false se bloqueada. */
export async function printQuote(quoteId: string): Promise<boolean> {
  const w = window.open('', '_blank', 'width=900,height=1100');
  if (!w) return false;
  w.document.write('<!doctype html><title>Preparando impressão…</title><body style="font:14px system-ui;padding:24px;color:#445063">Preparando a proposta…</body>');
  try {
    const data = await api<QuotePrint>(`/quotes/${quoteId}/print`);
    w.document.open();
    w.document.write(quoteHtml(data).replace('</body>', '<script>window.onload=function(){setTimeout(function(){window.print()},350)}</script></body>'));
    w.document.close();
    return true;
  } catch (e) { w.close(); throw e; }
}
