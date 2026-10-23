import { api } from '@/lib/api';
import { brl, dateBr } from '@/lib/format';
import { FISCAL_LABEL } from './fiscal';
import { PAYMENT_LABEL } from '@/lib/order-flow';

interface PrintData {
  order: {
    number: number; status: string; createdAt: string; priceTable?: string; paymentMethod: string | null; installmentCount: number; notes?: string | null; fiscalDocType?: string;
    subtotal: string; discountTotal: string; shipping: string; total: string;
    customer: { name: string; document: string | null }; salesperson: { name: string } | null; warehouse: { code: string; name: string };
    items: { quantity: number; unitPrice: string; discountPct: string; total: string; product: { sku: string; name: string } }[];
    installments: { installmentNo: number; installmentTotal: number; dueDate: string; amount: string; status: string }[];
    fiscalDocuments?: { model: string; number: number | null; series: number | null; status: string; accessKey: string | null }[];
  };
  company: { name: string; legalName: string; cnpj: string | null; stateRegistration: string | null; address: string; phone: string | null; email: string | null };
  logo: string | null;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const STATUS: Record<string, string> = { DRAFT: 'Rascunho', PENDING_APPROVAL: 'Aguardando aprovação', CONFIRMED: 'Confirmado', PICKING: 'Em separação', PACKED: 'Embalado', SHIPPED: 'Enviado', DELIVERED: 'Entregue', CLOSED: 'Concluído', CANCELLED: 'Cancelado' };
const INSTALLMENT: Record<string, string> = { OPEN: 'Em aberto', PARTIAL: 'Parcial', PAID: 'Paga', CANCELLED: 'Cancelada' };
const cnpjFmt = (v: string | null) => { const d = (v ?? '').replace(/\D/g, ''); return d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : v ?? ''; };
const docFmt = (v: string | null) => { const d = (v ?? '').replace(/\D/g, ''); return d.length === 11 ? d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : cnpjFmt(v); };

export function printHtml(d: PrintData): string {
  const o = d.order;
  const disc = Number(o.discountTotal) > 0;
  const rows = o.items.map((i, k) => `<tr><td class="c">${k + 1}</td><td><b>${esc(i.product.name)}</b><div class="sku">${esc(i.product.sku)}</div></td><td class="r">${i.quantity}</td><td class="r">${esc(brl(i.unitPrice))}</td><td class="r">${Number(i.discountPct) ? `${Number(i.discountPct)}%` : '—'}</td><td class="r"><b>${esc(brl(i.total))}</b></td></tr>`).join('');
  const inst = o.installments.length ? `<section><h3>Parcelas a receber</h3><table><thead><tr><th>Parcela</th><th>Vencimento</th><th class="r">Valor</th><th>Situação</th></tr></thead><tbody>${o.installments.map((t) => `<tr><td>${t.installmentNo}/${t.installmentTotal}</td><td>${esc(dateBr(t.dueDate))}</td><td class="r">${esc(brl(t.amount))}</td><td>${esc(INSTALLMENT[t.status] ?? t.status)}</td></tr>`).join('')}</tbody></table></section>` : '';
  const notes = o.fiscalDocuments?.length ? `<section><h3>Documentos fiscais</h3><table><thead><tr><th>Documento</th><th>Número/série</th><th>Situação</th><th>Chave de acesso</th></tr></thead><tbody>${o.fiscalDocuments.map((n) => `<tr><td>${n.model === '65' ? 'NFC-e' : 'NF-e'}</td><td>${n.number ?? '—'}/${n.series ?? '—'}</td><td>${n.status === 'AUTHORIZED' ? 'Autorizada' : esc(n.status)}</td><td class="key">${esc(n.accessKey ?? '—')}</td></tr>`).join('')}</tbody></table></section>` : '';
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Venda ${o.number} — ${esc(d.company.name)}</title><style>
@page{size:A4;margin:14mm}
*{box-sizing:border-box}
body{margin:0;font:12px/1.45 'Segoe UI',system-ui,-apple-system,Arial,sans-serif;color:#1b2430;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;padding-bottom:14px;border-bottom:3px solid #1d4ed8}
.brand{display:flex;gap:14px;align-items:center}
.logo{max-height:64px;max-width:150px;object-fit:contain}
.brand h1{margin:0;font-size:19px;letter-spacing:-.2px}
.brand p{margin:2px 0 0;color:#5b6675;font-size:11px}
.num{text-align:right}
.num .tag{display:inline-block;background:#1d4ed8;color:#fff;border-radius:999px;padding:3px 12px;font-size:10px;letter-spacing:.8px;text-transform:uppercase}
.num .n{font-size:26px;font-weight:700;margin-top:4px;letter-spacing:-.5px}
.num .d{color:#5b6675;font-size:11px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:14px 0}
.card{background:#f4f7fc;border:1px solid #dfe6f2;border-radius:8px;padding:9px 11px}
.card small{display:block;color:#6a7686;font-size:9.5px;text-transform:uppercase;letter-spacing:.7px;margin-bottom:2px}
.card b{font-size:12.5px}
section{margin-top:14px;break-inside:avoid}
h3{margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:.9px;color:#1d4ed8}
table{width:100%;border-collapse:collapse}
th{background:#1d4ed8;color:#fff;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.5px;padding:7px 8px}
th:first-child{border-radius:6px 0 0 6px}th:last-child{border-radius:0 6px 6px 0}
td{padding:7px 8px;border-bottom:1px solid #e6ebf3;vertical-align:top}
tbody tr:nth-child(even) td{background:#f8fafd}
.r{text-align:right}.c{text-align:center;color:#6a7686}th.c{color:#fff}
.sku{color:#6a7686;font-size:10px}.key{font-family:Consolas,monospace;font-size:10px;word-break:break-all}
.totals{margin-left:auto;margin-top:10px;width:290px}
.totals div{display:flex;justify-content:space-between;padding:4px 0;color:#445063}
.totals .g{margin-top:6px;padding:9px 12px;background:#1d4ed8;color:#fff;border-radius:8px;font-size:15px;font-weight:700}
.note{margin-top:12px;padding:9px 12px;border-left:3px solid #1d4ed8;background:#f4f7fc;color:#445063}
.foot{margin-top:22px;padding-top:8px;border-top:1px solid #dfe6f2;color:#8591a1;font-size:10px;display:flex;justify-content:space-between}
.sign{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:34px}.sign div{border-top:1px solid #8591a1;padding-top:4px;text-align:center;color:#6a7686;font-size:10px}
</style></head><body>
<div class="top"><div class="brand">${d.logo ? `<img class="logo" src="${esc(d.logo)}" alt="">` : ''}<div><h1>${esc(d.company.name)}</h1><p>${esc(d.company.legalName !== d.company.name ? d.company.legalName : '')}${d.company.cnpj ? ` · CNPJ ${esc(cnpjFmt(d.company.cnpj))}` : ''}${d.company.stateRegistration ? ` · IE ${esc(d.company.stateRegistration)}` : ''}</p><p>${esc(d.company.address)}</p><p>${esc([d.company.phone, d.company.email].filter(Boolean).join(' · '))}</p></div></div>
<div class="num"><span class="tag">Pedido de venda</span><div class="n">#${o.number}</div><div class="d">${esc(dateBr(o.createdAt))} · ${esc(STATUS[o.status] ?? o.status)}</div></div></div>
<div class="cards">
<div class="card"><small>Cliente</small><b>${esc(o.customer.name)}</b>${o.customer.document ? `<div>${esc(docFmt(o.customer.document))}</div>` : ''}</div>
<div class="card"><small>Vendedor</small><b>${esc(o.salesperson?.name ?? '—')}</b><div>Depósito ${esc(o.warehouse.code)}</div></div>
<div class="card"><small>Condições</small><b>${esc(o.paymentMethod ? PAYMENT_LABEL[o.paymentMethod] ?? o.paymentMethod : 'Não informado')}${o.paymentMethod === 'BOLETO' ? ` em ${o.installmentCount}x` : ''}</b><div>Tabela de ${o.priceTable === 'WHOLESALE' ? 'atacado' : 'varejo'} · ${esc(FISCAL_LABEL[(o.fiscalDocType ?? 'NONE') as keyof typeof FISCAL_LABEL] ?? '')}</div></div></div>
<section><h3>Itens</h3><table><thead><tr><th style="width:28px" class="c">#</th><th>Produto</th><th class="r" style="width:50px">Qtd.</th><th class="r" style="width:80px">Preço</th><th class="r" style="width:54px">Desc.</th><th class="r" style="width:90px">Total</th></tr></thead><tbody>${rows}</tbody></table></section>
<div class="totals"><div><span>Produtos</span><span>${esc(brl(o.subtotal))}</span></div>${disc ? `<div><span>Descontos</span><span>− ${esc(brl(o.discountTotal))}</span></div>` : ''}${Number(o.shipping) > 0 ? `<div><span>Frete</span><span>${esc(brl(o.shipping))}</span></div>` : ''}<div class="g"><span>Total</span><span>${esc(brl(o.total))}</span></div></div>
${inst}${notes}
${o.notes ? `<div class="note"><b>Observações:</b> ${esc(o.notes)}</div>` : ''}
<div class="sign"><div>Responsável pela entrega</div><div>Recebido por (nome e data)</div></div>
<div class="foot"><span>Documento de acompanhamento da venda. Não substitui a nota fiscal.</span><span>Impresso em ${esc(new Date().toLocaleString('pt-BR'))}</span></div>
</body></html>`;
}

/** Abre a venda em uma janela pronta para imprimir ou "Salvar como PDF". Devolve false se o navegador bloqueou o pop-up. */
export async function printOrder(orderId: string): Promise<boolean> {
  // abre a janela já no clique (os navegadores bloqueiam pop-up aberto depois de esperar a rede)
  const w = window.open('', '_blank', 'width=900,height=1100');
  if (!w) return false;
  w.document.write('<!doctype html><title>Preparando impressão…</title><body style="font:14px system-ui;padding:24px;color:#445063">Preparando a impressão da venda…</body>');
  try {
    const data = await api<PrintData>(`/sales/orders/${orderId}/print`);
    w.document.open();
    w.document.write(printHtml(data).replace('</body>', '<script>window.onload=function(){setTimeout(function(){window.print()},350)}</script></body>'));
    w.document.close();
    return true;
  } catch (e) { w.close(); throw e; }
}
