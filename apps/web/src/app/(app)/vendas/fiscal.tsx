'use client';

import { FileText, Printer, Receipt, TriangleAlert } from 'lucide-react';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Dialog } from '@/components/ui';
import { api } from '@/lib/api';
import { brl, dateBr, formatCep, formatCpfCnpj, formatNcm } from '@/lib/format';

export type FiscalChoice = 'NONE' | 'NFE' | 'NFCE';
export const FISCAL_LABEL: Record<FiscalChoice, string> = { NONE: 'Sem documento agora', NFE: 'Nota fiscal (NF-e)', NFCE: 'Cupom fiscal (NFC-e)' };

interface Issue { level: 'BLOCKER' | 'WARNING' | 'INFO'; code: string; message: string }
interface Addr { street: string | null; number: string | null; district: string | null; city: string | null; state: string | null; zipCode: string | null }
export interface Preview {
  mode: 'ESPELHO'; docType: FiscalChoice; ready: boolean; issues: Issue[];
  order: { id: string; number: number; status: string; createdAt: string };
  emitter: Addr & { legalName: string; tradeName: string | null; cnpj: string | null; stateRegistration: string | null; taxRegime: string | null; complement: string | null; environment: string | null; series: number | null };
  recipient: Addr & { name: string; document: string | null; kind: string; stateRegistration: string | null; email: string | null; phone: string | null };
  items: { line: number; sku: string; name: string; ncm: string | null; cest: string | null; gtin: string | null; unit: string; quantity: number; unitPrice: string; discountPct: string; total: string }[];
  totals: { subtotal: string; discount: string; shipping: string; total: string };
}

const OPTIONS: { value: FiscalChoice; title: string; text: string; icon: ReactNode }[] = [
  { value: 'NFE', title: 'Nota fiscal (NF-e)', text: 'Modelo 55, em formato A4 (DANFE). Para vendas a empresas e quando o cliente precisa da nota com todos os dados.', icon: <FileText aria-hidden /> },
  { value: 'NFCE', title: 'Cupom fiscal (NFC-e)', text: 'Modelo 65, cupom de 80 mm. Para venda a consumidor final, no balcão, com CPF opcional.', icon: <Receipt aria-hidden /> },
  { value: 'NONE', title: 'Decidir depois', text: 'Salva o pedido sem escolher o documento. Dá para definir antes de faturar.', icon: <FileText aria-hidden style={{ opacity: 0.45 }} /> },
];

/** Escolha do documento fiscal da venda (NF-e ou NFC-e). */
export function FiscalChoicePicker({ value, onChange, suggestion }: { value: FiscalChoice; onChange: (v: FiscalChoice) => void; suggestion?: FiscalChoice }) {
  return (
    <fieldset className="fiscal-choice" aria-label="Documento fiscal da venda">
      <legend>Documento fiscal desta venda</legend>
      <div className="fiscal-choice-grid">
        {OPTIONS.map((o) => (
          <label key={o.value} className={`fiscal-opt ${value === o.value ? 'on' : ''}`}>
            <input type="radio" name="fiscalDocType" value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
            <span className="fiscal-ico">{o.icon}</span>
            <span><strong>{o.title}</strong>{suggestion === o.value && value !== o.value && <span className="badge brand" style={{ marginLeft: 6 }}>sugerido</span>}<span className="muted fiscal-opt-text">{o.text}</span></span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const addr = (a: Addr) => [[a.street, a.number].filter(Boolean).join(', '), a.district, [a.city, a.state].filter(Boolean).join(' / '), a.zipCode ? `CEP ${formatCep(a.zipCode)}` : ''].filter(Boolean).join(' · ');
const qty = (n: number) => n.toLocaleString('pt-BR');
const REGIME: Record<string, string> = { SIMPLES_NACIONAL: 'Simples Nacional', LUCRO_PRESUMIDO: 'Lucro Presumido', LUCRO_REAL: 'Lucro Real', MEI: 'MEI' };

/** DANFE (NF-e, A4). Espelho para conferência: sem chave, protocolo nem tributos calculados. */
export function Danfe({ p }: { p: Preview }) {
  const e = p.emitter; const r = p.recipient;
  return (
    <div className="doc danfe" aria-label="Espelho do DANFE">
      <div className="doc-watermark" aria-hidden>ESPELHO · SEM VALOR FISCAL</div>
      <div className="danfe-top">
        <div className="danfe-emit">
          <div className="cap">Emitente</div>
          <strong className="danfe-name">{e.legalName}</strong>
          {e.tradeName && <div>{e.tradeName}</div>}
          <div>{addr(e) || 'Endereço não informado'}</div>
          <div>CNPJ {e.cnpj ? formatCpfCnpj(e.cnpj) : '—'} · IE {e.stateRegistration ?? '—'}</div>
          {e.taxRegime && <div>{REGIME[e.taxRegime] ?? e.taxRegime}</div>}
        </div>
        <div className="danfe-title">
          <strong>DANFE</strong>
          <span>Documento Auxiliar da Nota Fiscal Eletrônica</span>
          <div className="danfe-io"><span>0 - Entrada<br />1 - Saída</span><b>1</b></div>
          <div>Nº <b>pendente</b> · Série <b>{e.series ?? '—'}</b></div>
        </div>
        <div className="danfe-key">
          <div className="cap">Chave de acesso</div>
          <div className="danfe-bars" aria-hidden>código de barras disponível após a autorização na SEFAZ</div>
          <div className="mono">— — — — — — — — — — — —</div>
          <div className="muted">Consulta de autenticidade no portal nacional da NF-e</div>
        </div>
      </div>
      <div className="danfe-row">
        <div><div className="cap">Natureza da operação</div>Venda de mercadoria</div>
        <div><div className="cap">Protocolo de autorização de uso</div>— (não autorizada)</div>
      </div>
      <div className="cap danfe-sec">Destinatário / remetente</div>
      <div className="danfe-grid g3">
        <div className="span2"><div className="cap">Nome / razão social</div>{r.name}</div>
        <div><div className="cap">CNPJ / CPF</div>{r.document ? formatCpfCnpj(r.document) : '—'}</div>
        <div className="span2"><div className="cap">Endereço</div>{addr(r) || '—'}</div>
        <div><div className="cap">Inscrição estadual</div>{r.stateRegistration ?? '—'}</div>
        <div><div className="cap">Data de emissão</div>{dateBr(p.order.createdAt)}</div>
        <div><div className="cap">Telefone</div>{r.phone ?? '—'}</div>
        <div><div className="cap">E-mail</div>{r.email ?? '—'}</div>
      </div>
      <div className="cap danfe-sec">Cálculo do imposto</div>
      <div className="danfe-grid g6">
        <div><div className="cap">Base de cálculo ICMS</div>não calculado</div>
        <div><div className="cap">Valor do ICMS</div>não calculado</div>
        <div><div className="cap">Valor do frete</div>{brl(p.totals.shipping)}</div>
        <div><div className="cap">Desconto</div>{brl(p.totals.discount)}</div>
        <div><div className="cap">Valor total dos produtos</div>{brl(p.totals.subtotal)}</div>
        <div className="strong"><div className="cap">Valor total da nota</div><b>{brl(p.totals.total)}</b></div>
      </div>
      <div className="cap danfe-sec">Dados dos produtos / serviços</div>
      <table className="danfe-items">
        <thead><tr><th>Cód.</th><th>Descrição</th><th>NCM</th><th>Un.</th><th className="num">Qtd.</th><th className="num">V. unit.</th><th className="num">Desc.</th><th className="num">V. total</th></tr></thead>
        <tbody>
          {p.items.map((i) => (
            <tr key={i.line}>
              <td>{i.sku}</td><td>{i.name}</td><td>{i.ncm ? formatNcm(i.ncm) : <b className="bad">falta</b>}</td><td>{i.unit}</td>
              <td className="num">{qty(i.quantity)}</td><td className="num">{brl(i.unitPrice)}</td><td className="num">{Number(i.discountPct) ? `${Number(i.discountPct)}%` : '—'}</td><td className="num">{brl(i.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="danfe-row">
        <div><div className="cap">Dados adicionais</div>Pedido de venda nº {p.order.number}. Tributos, CFOP e CST/CSOSN serão preenchidos na emissão, conforme as regras aprovadas pelo contador.</div>
      </div>
    </div>
  );
}

/** Cupom da NFC-e (80 mm). Espelho para conferência. */
export function Cupom({ p }: { p: Preview }) {
  const e = p.emitter; const r = p.recipient;
  const cpf = r.document && r.document.replace(/\D/g, '').length === 11 ? r.document : null;
  return (
    <div className="doc cupom" aria-label="Espelho do cupom NFC-e">
      <div className="doc-watermark small" aria-hidden>ESPELHO · SEM VALOR FISCAL</div>
      <div className="cupom-c"><strong>{e.legalName}</strong></div>
      <div className="cupom-c">CNPJ {e.cnpj ? formatCpfCnpj(e.cnpj) : '—'} · IE {e.stateRegistration ?? '—'}</div>
      <div className="cupom-c">{addr(e) || 'Endereço não informado'}</div>
      <hr />
      <div className="cupom-c"><strong>DANFE NFC-e</strong><br />Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica</div>
      <div className="cupom-c small">Não permite aproveitamento de crédito de ICMS</div>
      <hr />
      <table className="cupom-items">
        <tbody>
          {p.items.map((i) => (
            <Fragment key={i.line}>
              <tr className="l1"><td colSpan={2}>{String(i.line).padStart(2, '0')} {i.sku} {i.name}</td></tr>
              <tr><td>{qty(i.quantity)} {i.unit} x {brl(i.unitPrice)}</td><td className="num">{brl(i.total)}</td></tr>
            </Fragment>
          ))}
        </tbody>
      </table>
      <hr />
      <div className="cupom-line"><span>Qtd. total de itens</span><span>{p.items.length}</span></div>
      <div className="cupom-line"><span>Subtotal</span><span>{brl(p.totals.subtotal)}</span></div>
      {Number(p.totals.discount) > 0 && <div className="cupom-line"><span>Descontos</span><span>-{brl(p.totals.discount)}</span></div>}
      {Number(p.totals.shipping) > 0 && <div className="cupom-line"><span>Frete</span><span>{brl(p.totals.shipping)}</span></div>}
      <div className="cupom-line big"><span>VALOR TOTAL</span><span>{brl(p.totals.total)}</span></div>
      <div className="cupom-line"><span>Forma de pagamento</span><span>a definir</span></div>
      <hr />
      <div className="cupom-c small">Tributos totais incidentes (Lei 12.741/2012): não calculado</div>
      <hr />
      <div className="cupom-c"><strong>{cpf ? `CONSUMIDOR CPF ${formatCpfCnpj(cpf)}` : 'CONSUMIDOR NÃO IDENTIFICADO'}</strong></div>
      <div className="cupom-c small">NFC-e nº pendente · Série {e.series ?? '—'} · {dateBr(p.order.createdAt)}</div>
      <div className="cupom-qr" aria-hidden>QR Code<br />disponível após a autorização</div>
      <div className="cupom-c small">Chave de acesso: —<br />Consulte pela chave de acesso no portal da SEFAZ da sua UF.</div>
      <div className="cupom-c small">Pedido {p.order.number}</div>
    </div>
  );
}

function PrintRoot({ children }: { children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const d = document.createElement('div');
    d.className = 'fiscal-print-root';
    document.body.appendChild(d);
    setEl(d);
    return () => { d.remove(); };
  }, []);
  return el ? createPortal(children, el) : null;
}

/** Janela de pré-visualização do documento escolhido, com as pendências para emitir e impressão do espelho. */
export function FiscalPreviewDialog({ orderId, docType, onClose }: { orderId: string; docType: FiscalChoice; onClose: () => void }) {
  const [p, setP] = useState<Preview | null>(null);
  const [view, setView] = useState<'NFE' | 'NFCE'>(docType === 'NFCE' ? 'NFCE' : 'NFE');
  const [error, setError] = useState('');
  useEffect(() => { api<Preview>(`/sales/orders/${orderId}/fiscal-preview`).then(setP).catch((e) => setError(e.message)); }, [orderId]);

  const blockers = p?.issues.filter((i) => i.level === 'BLOCKER') ?? [];
  const others = p?.issues.filter((i) => i.level !== 'BLOCKER') ?? [];
  const doc = p ? (view === 'NFE' ? <Danfe p={p} /> : <Cupom p={p} />) : null;

  return (
    <Dialog wide title={`Documento fiscal do pedido ${p?.order.number ?? ''}`} description="Espelho para conferência. A nota só vale depois de transmitida em Fiscal → Notas de saída." onClose={onClose}>
      <div className="modal-body fiscal-dlg">
        {error && <div className="alert error" role="alert">{error}</div>}
        {!p && !error && <p className="muted">Montando o documento…</p>}
        {p && (
          <>
            <div className="tabs fiscal-noprint" role="tablist" aria-label="Modelo do documento" style={{ marginBottom: 12 }}>
              <button role="tab" aria-selected={view === 'NFE'} className={`tab ${view === 'NFE' ? 'active' : ''}`} onClick={() => setView('NFE')}>NF-e (DANFE A4){p.docType === 'NFE' && ' · escolhida'}</button>
              <button role="tab" aria-selected={view === 'NFCE'} className={`tab ${view === 'NFCE' ? 'active' : ''}`} onClick={() => setView('NFCE')}>NFC-e (cupom 80 mm){p.docType === 'NFCE' && ' · escolhida'}</button>
            </div>
            {(blockers.length > 0 || others.length > 0) && (
              <div className="fiscal-issues fiscal-noprint">
                {blockers.length > 0 && <div className="alert error" role="alert"><TriangleAlert aria-hidden /><div><strong>Falta para emitir:</strong><ul>{blockers.map((i) => <li key={i.code}>{i.message}</li>)}</ul></div></div>}
                {others.length > 0 && <div className="alert warn" role="status"><TriangleAlert aria-hidden /><div><ul>{others.map((i) => <li key={i.code}>{i.message}</li>)}</ul></div></div>}
              </div>
            )}
            <div className="doc-stage fiscal-noprint">{doc}</div>
            <PrintRoot>{doc}</PrintRoot>
          </>
        )}
      </div>
      <div className="modal-foot fiscal-noprint">
        <button className="btn" onClick={onClose}>Fechar</button>
        <a className="btn" href="/fiscal">Ir para Notas de saída</a>
        <button className="btn primary" disabled={!p} onClick={() => window.print()}><Printer aria-hidden />Imprimir espelho</button>
      </div>
    </Dialog>
  );
}
