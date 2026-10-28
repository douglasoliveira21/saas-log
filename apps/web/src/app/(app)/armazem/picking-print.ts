import { dateBr } from '@/lib/format';
import { cnpjFmt, esc, PRINT_CSS } from '../vendas/print';

export interface PickList {
  warehouse: string; generatedAt: string; logo?: string | null;
  company?: { name: string; legalName: string; cnpj: string | null; address: string; phone: string | null; email: string | null } | null;
  orders: { id: string; number: number; customer: string; dispatchDate?: string | null; channel?: string }[];
  lines: { productId: string; sku: string; name: string; barcode: string | null; unit: string; quantity: number; shortage: number; picks: { lotCode: string | null; expiresAt: string | null; location: string | null; qty: number }[]; orders: { number: number; qty: number }[] }[];
}

/** Resumo para os indicadores (tela e impressão). */
export function pickSummary(l: PickList) {
  const units = l.lines.reduce((a, x) => a + x.quantity, 0);
  const places = new Set(l.lines.flatMap((x) => x.picks.map((p) => p.location).filter(Boolean))).size;
  const noAddress = l.lines.filter((x) => x.picks.some((p) => !p.location)).length;
  const short = l.lines.filter((x) => x.shortage > 0).length;
  return { products: l.lines.length, units, places, noAddress, short, orders: l.orders.length };
}

/** Dias até vencer (negativo = vencido) para destacar lotes de validade curta. */
const daysTo = (iso: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) / 86_400_000);

const EXTRA_CSS = `
.cards4{display:grid;grid-template-columns:1fr 1.6fr 1fr;gap:10px;margin:14px 0}
.chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:3px}.chip{padding:1px 8px;border-radius:99px;background:#fff;border:1px solid #cfdcf7;font-size:10px;color:#1d4ed8;font-weight:600}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:0 0 14px}
.kpi{border:1px solid #dfe6f2;border-radius:8px;padding:8px 11px;text-align:center}.kpi b{display:block;font-size:17px;letter-spacing:-.3px}.kpi small{color:#6a7686;font-size:9.5px;text-transform:uppercase;letter-spacing:.7px}
.alertbox{margin:0 0 8px;padding:8px 12px;border-radius:8px;background:#fff4e5;border:1px solid #f0c98a;color:#7a4a00;font-size:11px}.alertbox.bad{background:#fdecec;border-color:#f3c3c3;color:#8a1f18}
.loc{display:inline-block;white-space:nowrap;min-width:64px;text-align:center;padding:3px 8px;border-radius:6px;background:#1b2430;color:#fff;font:700 13px Consolas,monospace;letter-spacing:.5px}
.loc.none{background:#fff;color:#b3261e;border:1px dashed #b3261e;font:600 10px 'Segoe UI',sans-serif}
.pn{font-weight:600}.bar{color:#6a7686;font:10px Consolas,monospace}
.qty{font-size:17px;font-weight:700;letter-spacing:-.3px}.qty small{font-size:10px;color:#6a7686;font-weight:600}
.lot{font:600 11px Consolas,monospace}.exp{font-size:10px;color:#6a7686}.exp.soon{color:#b45309;font-weight:700}.exp.over{color:#b3261e;font-weight:700}
.ords{font-size:10px;color:#445063}
.box{display:inline-block;width:16px;height:16px;border:1.8px solid #6a7686;border-radius:4px}
tr.cont td{border-top:0;padding-top:0}tr{break-inside:avoid}
tr.short td{background:#fdecec!important;color:#8a1f18;font-weight:600}
.sign3{display:grid;grid-template-columns:repeat(3,1fr);gap:28px;margin-top:34px}.sign3 div{border-top:1px solid #8591a1;padding-top:4px;text-align:center;color:#6a7686;font-size:10px}
.legal{margin-top:12px;padding:8px 12px;border:1px dashed #b8c4d8;border-radius:8px;color:#5b6675;font-size:10px;line-height:1.5}
.ol{margin:0;padding:0;list-style:none;columns:2;column-gap:20px;font-size:10.5px}.ol li{padding:2px 0;break-inside:avoid}.ol b{color:#1d4ed8}
`;

export function pickingHtml(l: PickList): string {
  const c = l.company ?? null;
  const s = pickSummary(l);
  const rows = l.lines.map((ln) => {
    const body = ln.picks.map((p, i) => {
      const d = p.expiresAt ? daysTo(p.expiresAt) : null;
      const first = i === 0;
      return `<tr class="${first ? '' : 'cont'}"><td class="c">${p.location ? `<span class="loc">${esc(p.location)}</span>` : '<span class="loc none">sem endereço</span>'}</td><td>${first ? `<div class="pn">${esc(ln.name)}</div><div class="bar">${esc(ln.sku)}${ln.barcode ? ` · ${esc(ln.barcode)}` : ''}</div>` : ''}</td><td>${p.lotCode ? `<div class="lot">${esc(p.lotCode)}</div>` : '<span class="exp">—</span>'}${p.expiresAt ? `<div class="exp ${d !== null && d < 0 ? 'over' : d !== null && d <= 30 ? 'soon' : ''}">vence ${esc(dateBr(p.expiresAt))}${d !== null && d >= 0 && d <= 30 ? ` (${d} d)` : ''}</div>` : ''}</td><td class="r"><span class="qty">${p.qty}</span> <small>${esc(ln.unit)}</small></td><td class="ords">${first ? ln.orders.map((o) => `#${o.number}: <b>${o.qty}</b>`).join(' · ') : ''}</td><td class="c"><span class="box"></span></td></tr>`;
    }).join('');
    return body + (ln.shortage ? `<tr class="short"><td colspan="6">Faltam ${ln.shortage} ${esc(ln.unit)} de ${esc(ln.sku)} — ${esc(ln.name)} (sem saldo válido disponível)</td></tr>` : '');
  }).join('');
  const alerts = [
    s.short ? `<div class="alertbox bad">${s.short} produto(s) sem saldo válido suficiente. Confira estoque e lotes vencidos antes de separar.</div>` : '',
    s.noAddress ? `<div class="alertbox">${s.noAddress} produto(s) com parte sem endereço cadastrado: procure na área geral do depósito.</div>` : '',
  ].join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Lista de separação — ${esc(l.warehouse)}${c ? ` — ${esc(c.name)}` : ''}</title><style>${PRINT_CSS}${EXTRA_CSS}</style></head><body>
<div class="top"><div class="brand">${l.logo ? `<img class="logo" src="${esc(l.logo)}" alt="">` : ''}<div>${c ? `<h1>${esc(c.name)}</h1><p>${esc(c.legalName !== c.name ? c.legalName : '')}${c.cnpj ? ` · CNPJ ${esc(cnpjFmt(c.cnpj))}` : ''}</p><p>${esc(c.address)}</p>` : '<h1>Lista de separação</h1>'}</div></div>
<div class="num"><span class="tag">Lista de separação</span><div class="n">Depósito ${esc(l.warehouse)}</div><div class="d">${esc(new Date(l.generatedAt).toLocaleString('pt-BR'))}</div></div></div>
<div class="cards4"><div class="card"><small>Pedidos</small><b>${s.orders} pedido(s)</b></div><div class="card"><small>Para separar</small><div class="chips">${l.orders.map((o) => `<span class="chip">#${o.number}</span>`).join('')}</div></div><div class="card"><small>Itens da lista</small><b>${s.products} produto(s)</b></div></div>
<div class="kpis"><div class="kpi"><b>${s.products}</b><small>Produtos</small></div><div class="kpi"><b>${s.units}</b><small>Unidades</small></div><div class="kpi"><b>${s.places}</b><small>Endereços a visitar</small></div><div class="kpi"><b>${s.short ? s.short : '0'}</b><small>Com falta</small></div></div>
${alerts}
<section><h3>Caminho de separação</h3><table><thead><tr><th class="c" style="width:100px">Endereço</th><th>Produto</th><th style="width:118px">Lote / validade</th><th class="r" style="width:68px">Qtd.</th><th style="width:96px">Pedidos</th><th class="c" style="width:30px">OK</th></tr></thead><tbody>${rows}</tbody></table></section>
<section><h3>Pedidos desta lista</h3><ul class="ol">${l.orders.map((o) => `<li><b>#${o.number}</b> ${esc(o.customer)}${o.dispatchDate ? ` · saída ${esc(dateBr(o.dispatchDate))}` : ''}</li>`).join('')}</ul></section>
<div class="sign3"><div>Separador</div><div>Conferente</div><div>Data e hora</div></div>
<div class="legal">Os lotes seguem a ordem de validade (o que vence primeiro sai primeiro) e os endereços estão na ordem de caminho. Depois de separar, confira cada pedido com o leitor de código de barras antes de embalar.</div>
<div class="foot"><span>${esc(c?.name ?? '')} · Lista gerada pelo sistema</span><span>Impressa em ${esc(new Date().toLocaleString('pt-BR'))}</span></div>
</body></html>`;
}
