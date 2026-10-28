import { api } from '@/lib/api';
import { brl, dateBr } from '@/lib/format';
import { cnpjFmt, esc, PRINT_CSS } from '../vendas/print';

export interface ManifestStop {
  sequence: number; orderNumber: number | null; customer: string; phone: string | null; city: string | null; state: string | null; address: string; value: number; status: string;
  documents: { model: string; number: number | null; series: number | null; accessKey: string | null }[];
  items: { sku: string; name: string; unit: string; quantity: number }[];
}
export interface Manifest {
  company: { name: string; legalName: string; cnpj: string | null; stateRegistration: string | null; address: string; phone: string | null; email: string | null } | null;
  logo: string | null; generatedAt: string;
  route: { number: number; date: string; status: string; notes: string | null; startedAt: string | null };
  vehicle: { plate: string; description: string; kind?: string | null; capacityKg: number | null } | null;
  driver: { name: string; phone: string | null };
  stops: ManifestStop[]; states: string[]; weightKg: number; value: string; itemsWithoutWeight: number; overCapacity: boolean; warnings: string[]; notice: string;
}

export const ROUTE_STATUS: Record<string, string> = { PLANNED: 'Planejada', IN_PROGRESS: 'Em andamento', COMPLETED: 'Concluída', CANCELLED: 'Cancelada' };
export const kg = (n: number) => `${n.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} kg`;
const phoneFmt = (v: string | null) => { const d = (v ?? '').replace(/\D/g, ''); return d.length === 11 ? d.replace(/^(\d{2})(\d{5})(\d{4})$/, '($1) $2-$3') : d.length === 10 ? d.replace(/^(\d{2})(\d{4})(\d{4})$/, '($1) $2-$3') : v ?? ''; };
const keyFmt = (k: string | null) => (k ?? '').replace(/\D/g, '').replace(/(\d{4})(?=\d)/g, '$1 ').trim();
export const docLabel = (d: { model: string }) => (d.model === '65' ? 'NFC-e' : 'NF-e');

/** Percentual da capacidade usada (null sem veículo/capacidade). */
export const usedPct = (m: Pick<Manifest, 'vehicle' | 'weightKg'>) => (m.vehicle?.capacityKg ? Math.round((m.weightKg / m.vehicle.capacityKg) * 100) : null);

const EXTRA_CSS = `
.cards4{display:grid;grid-template-columns:1.1fr 1fr 1.3fr;gap:10px;margin:14px 0}
.plate{display:inline-block;margin-top:2px;padding:2px 10px;border:2px solid #1b2430;border-radius:6px;font:700 15px Consolas,monospace;letter-spacing:2px;background:#fff}
.cap{margin-top:6px;height:7px;border-radius:99px;background:#dfe6f2;overflow:hidden}.cap i{display:block;height:100%;background:#1d4ed8}
.cap.warn i{background:#d97706}.cap.bad i{background:#b3261e}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:0 0 14px}
.kpi{border:1px solid #dfe6f2;border-radius:8px;padding:8px 11px;text-align:center}.kpi b{display:block;font-size:17px;letter-spacing:-.3px}.kpi small{color:#6a7686;font-size:9.5px;text-transform:uppercase;letter-spacing:.7px}
.alertbox{margin:0 0 8px;padding:8px 12px;border-radius:8px;background:#fff4e5;border:1px solid #f0c98a;color:#7a4a00;font-size:11px}
.alertbox.bad{background:#fdecec;border-color:#f3c3c3;color:#8a1f18}
.seq{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;background:#1d4ed8;color:#fff;font-weight:700;font-size:11px}
.cust{font-weight:600}.addr{color:#5b6675;font-size:10.5px}.ph{color:#6a7686;font-size:10px}
.nf{white-space:nowrap}.nf b{font-size:11px}.nf .key{display:block;color:#6a7686}
.nonf{display:inline-block;padding:1px 8px;border-radius:99px;background:#fdecec;color:#b3261e;font-weight:700;font-size:10px}
.chk{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:6px}.chk div{display:flex;gap:7px;align-items:center;font-size:11px;color:#445063}
.chk i{display:inline-block;width:12px;height:12px;border:1.5px solid #6a7686;border-radius:3px;flex:none}
.sign3{display:grid;grid-template-columns:repeat(3,1fr);gap:28px;margin-top:38px}.sign3 div{border-top:1px solid #8591a1;padding-top:4px;text-align:center;color:#6a7686;font-size:10px}
.legal{margin-top:12px;padding:8px 12px;border:1px dashed #b8c4d8;border-radius:8px;color:#5b6675;font-size:10px;line-height:1.5}
tr{break-inside:avoid}
`;

export function manifestHtml(m: Manifest): string {
  const c = m.company;
  const pct = usedPct(m);
  const capClass = m.overCapacity ? 'bad' : pct !== null && pct >= 85 ? 'warn' : '';
  const delivered = m.stops.filter((s) => s.status === 'DELIVERED').length;
  const rows = m.stops.map((s) => `<tr><td class="c"><span class="seq">${s.sequence}</span></td><td class="c">${s.orderNumber ?? '—'}</td><td><div class="cust">${esc(s.customer)}</div><div class="addr">${esc(s.address)}</div>${s.phone ? `<div class="ph">${esc(phoneFmt(s.phone))}</div>` : ''}</td><td>${esc([s.city, s.state].filter(Boolean).join('/'))}</td><td class="nf">${s.documents.length ? s.documents.map((d) => `<div><b>${docLabel(d)} ${d.number ?? ''}${d.series != null ? `/${d.series}` : ''}</b>${d.accessKey ? `<span class="key">${esc(keyFmt(d.accessKey))}</span>` : ''}</div>`).join('') : '<span class="nonf">sem NF-e</span>'}</td><td class="r"><b>${esc(brl(s.value))}</b></td></tr>`).join('');
  const alerts = m.warnings.map((w) => `<div class="alertbox ${/passa da capacidade|sem NF-e/.test(w) ? 'bad' : ''}">${esc(w)}</div>`).join('');
  const veh = m.vehicle;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Manifesto de carga ${m.route.number}${c ? ` — ${esc(c.name)}` : ''}</title><style>${PRINT_CSS}${EXTRA_CSS}</style></head><body>
<div class="top"><div class="brand">${m.logo ? `<img class="logo" src="${esc(m.logo)}" alt="">` : ''}<div>${c ? `<h1>${esc(c.name)}</h1><p>${esc(c.legalName !== c.name ? c.legalName : '')}${c.cnpj ? ` · CNPJ ${esc(cnpjFmt(c.cnpj))}` : ''}${c.stateRegistration ? ` · IE ${esc(c.stateRegistration)}` : ''}</p><p>${esc(c.address)}</p><p>${esc([phoneFmt(c.phone), c.email].filter(Boolean).join(' · '))}</p>` : '<h1>Manifesto de carga</h1>'}</div></div>
<div class="num"><span class="tag">Manifesto de carga</span><div class="n">Viagem #${m.route.number}</div><div class="d">${esc(dateBr(m.route.date))} · ${esc(ROUTE_STATUS[m.route.status] ?? m.route.status)}</div></div></div>
<div class="cards4">
<div class="card"><small>Veículo</small>${veh ? `<span class="plate">${esc(veh.plate)}</span><div>${esc(veh.description)}</div>` : '<b>Não definido</b>'}</div>
<div class="card"><small>Motorista</small><b>${esc(m.driver.name)}</b>${m.driver.phone ? `<div class="ph">${esc(phoneFmt(m.driver.phone))}</div>` : ''}</div>
<div class="card"><small>Carga x capacidade</small><b>${esc(kg(m.weightKg))}${veh?.capacityKg ? ` de ${esc(kg(veh.capacityKg))}` : ''}</b>${pct !== null ? `<div class="cap ${capClass}"><i style="width:${Math.min(100, pct)}%"></i></div><div class="ph">${pct}% da capacidade${m.overCapacity ? ' — EXCEDE' : ''}</div>` : '<div class="ph">Capacidade não informada</div>'}</div></div>
<div class="kpis"><div class="kpi"><b>${m.stops.length}</b><small>Paradas</small></div><div class="kpi"><b>${esc(brl(m.value))}</b><small>Valor da carga</small></div><div class="kpi"><b>${esc(m.states.join(', ') || '—')}</b><small>UF de destino</small></div><div class="kpi"><b>${m.stops.filter((s) => s.documents.length).length}/${m.stops.length}</b><small>Com NF-e</small></div></div>
${alerts}
<section><h3>Paradas e documentos fiscais</h3><table><thead><tr><th class="c" style="width:34px">Ordem</th><th class="c" style="width:48px">Pedido</th><th>Cliente / endereço de entrega</th><th style="width:78px">Cidade</th><th style="width:150px">Documento fiscal</th><th class="r" style="width:80px">Valor</th></tr></thead><tbody>${rows}</tbody></table></section>
<div class="totals"><div><span>Pedidos na carga</span><span>${m.stops.length}</span></div><div><span>Peso total</span><span>${esc(kg(m.weightKg))}</span></div><div class="g"><span>Valor total</span><span>${esc(brl(m.value))}</span></div></div>
${m.route.notes ? `<div class="note"><b>Observações da viagem:</b> ${esc(m.route.notes)}</div>` : ''}
<section><h3>Conferência antes da saída</h3><div class="chk"><div><i></i>Volumes conferidos com os pedidos</div><div><i></i>NF-e acompanhando a carga</div><div><i></i>Carga amarrada e protegida</div><div><i></i>Documentos do veículo e do motorista</div><div><i></i>Canhotos entregues ao motorista</div><div><i></i>Veículo e combustível verificados</div></div></section>
<div class="sign3"><div>Expedição / conferente</div><div>Motorista — ${esc(m.driver.name)}</div><div>Data e hora da saída</div></div>
<div class="legal">${esc(m.notice)}${delivered ? ` Entregas já confirmadas até a emissão: ${delivered}.` : ''}</div>
<div class="foot"><span>${esc(c?.name ?? '')} · Manifesto gerado pelo sistema</span><span>Impresso em ${esc(new Date(m.generatedAt).toLocaleString('pt-BR'))}</span></div>
</body></html>`;
}

const ROMANEIO_CSS = `
.stop{margin-top:12px;border:1px solid #dfe6f2;border-radius:10px;overflow:hidden;break-inside:avoid}
.stop-h{display:flex;align-items:center;gap:10px;padding:8px 12px;background:#f4f7fc;border-bottom:1px solid #dfe6f2}
.stop-h .t{flex:1;min-width:0}.stop-h .nfs{text-align:right;font-size:10px;color:#445063}
.stop table{margin:0}.stop th{border-radius:0!important;background:#eef2fa;color:#445063}
.stop td{padding:5px 10px}.box{display:inline-block;width:13px;height:13px;border:1.5px solid #6a7686;border-radius:3px;vertical-align:middle}
.rec{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:14px;padding:12px 12px 8px}.rec div{border-top:1px solid #8591a1;padding-top:3px;color:#6a7686;font-size:9.5px}
`;

/** Romaneio: a lista de entrega do motorista, com os itens de cada parada e o recebimento do cliente. Mesmo desenho do manifesto. */
export function romaneioHtml(m: Manifest): string {
  const c = m.company;
  const veh = m.vehicle;
  const totalItems = m.stops.reduce((a, s) => a + s.items.reduce((b, i) => b + i.quantity, 0), 0);
  const blocks = m.stops.map((s) => `<div class="stop"><div class="stop-h"><span class="seq">${s.sequence}</span><div class="t"><div class="cust">${esc(s.customer)}</div><div class="addr">${esc(s.address)}${s.city ? ` · ${esc([s.city, s.state].filter(Boolean).join('/'))}` : ''}${s.phone ? ` · ${esc(phoneFmt(s.phone))}` : ''}</div></div><div class="nfs">Pedido ${s.orderNumber ?? '—'}<br>${s.documents.length ? s.documents.map((d) => `${docLabel(d)} ${d.number ?? ''}`).join(' · ') : '<span class="nonf">sem NF-e</span>'}<br><b>${esc(brl(s.value))}</b></div></div>
<table><thead><tr><th style="width:22px" class="c">OK</th><th style="width:90px">Código</th><th>Produto</th><th class="r" style="width:70px">Qtd.</th></tr></thead><tbody>${s.items.map((i) => `<tr><td class="c"><span class="box"></span></td><td class="sku">${esc(i.sku)}</td><td>${esc(i.name)}</td><td class="r"><b>${i.quantity}</b> ${esc(i.unit)}</td></tr>`).join('')}</tbody></table>
<div class="rec"><div>Recebido por (nome legível e documento)</div><div>Assinatura</div><div>Data e hora</div></div></div>`).join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Romaneio de carga ${m.route.number}${c ? ` — ${esc(c.name)}` : ''}</title><style>${PRINT_CSS}${EXTRA_CSS}${ROMANEIO_CSS}</style></head><body>
<div class="top"><div class="brand">${m.logo ? `<img class="logo" src="${esc(m.logo)}" alt="">` : ''}<div>${c ? `<h1>${esc(c.name)}</h1><p>${esc(c.legalName !== c.name ? c.legalName : '')}${c.cnpj ? ` · CNPJ ${esc(cnpjFmt(c.cnpj))}` : ''}</p><p>${esc(c.address)}</p><p>${esc([phoneFmt(c.phone), c.email].filter(Boolean).join(' · '))}</p>` : '<h1>Romaneio de carga</h1>'}</div></div>
<div class="num"><span class="tag">Romaneio de carga</span><div class="n">Viagem #${m.route.number}</div><div class="d">${esc(dateBr(m.route.date))} · ${esc(ROUTE_STATUS[m.route.status] ?? m.route.status)}</div></div></div>
<div class="cards4"><div class="card"><small>Veículo</small>${veh ? `<span class="plate">${esc(veh.plate)}</span><div>${esc(veh.description)}</div>` : '<b>Não definido</b>'}</div><div class="card"><small>Motorista</small><b>${esc(m.driver.name)}</b>${m.driver.phone ? `<div class="ph">${esc(phoneFmt(m.driver.phone))}</div>` : ''}</div><div class="card"><small>Resumo da carga</small><b>${m.stops.length} entrega(s) · ${totalItems} item(ns)</b><div class="ph">${esc(kg(m.weightKg))} · ${esc(brl(m.value))}</div></div></div>
${m.warnings.map((w) => `<div class="alertbox ${/passa da capacidade|sem NF-e/.test(w) ? 'bad' : ''}">${esc(w)}</div>`).join('')}
${m.route.notes ? `<div class="note"><b>Observações:</b> ${esc(m.route.notes)}</div>` : ''}
${blocks}
<div class="sign3"><div>Expedição — carga conferida</div><div>Motorista — ${esc(m.driver.name)}</div><div>Data e hora da saída</div></div>
<div class="legal">Cada parada deve ser entregue com a nota fiscal e o canhoto assinado. Em caso de recusa ou ausência, registre o motivo no aplicativo do motorista. ${esc(m.notice)}</div>
<div class="foot"><span>${esc(c?.name ?? '')} · Romaneio gerado pelo sistema</span><span>Impresso em ${esc(new Date(m.generatedAt).toLocaleString('pt-BR'))}</span></div>
</body></html>`;
}

/** Abre o manifesto em uma janela pronta para imprimir ou "Salvar como PDF". Devolve false se o pop-up for bloqueado. */
export async function printManifest(routeId: string): Promise<boolean> {
  const w = window.open('', '_blank', 'width=900,height=1100');
  if (!w) return false;
  w.document.write('<!doctype html><title>Preparando impressão…</title><body style="font:14px system-ui;padding:24px;color:#445063">Preparando o manifesto…</body>');
  try {
    const data = await api<Manifest>(`/fleet/routes/${routeId}/manifest`);
    w.document.open();
    w.document.write(manifestHtml(data).replace('</body>', '<script>window.onload=function(){setTimeout(function(){window.print()},350)}</script></body>'));
    w.document.close();
    return true;
  } catch (e) { w.close(); throw e; }
}
