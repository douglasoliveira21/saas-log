'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Dialog, EmptyState, Skeleton, useUi } from '@/components/ui';
import { api } from '@/lib/api';
import { brl, dateBr } from '@/lib/format';
import { boletoPreview } from '@/lib/order-flow';
import { useSession } from '@/lib/session';

interface OpenTitle { id: string; description: string; installmentNo: number; installmentTotal: number; dueDate: string; outstanding: string; daysLate: number; eligible: boolean; reason: string | null }
interface NegRow { id: string; number: number; status: 'ACTIVE' | 'CANCELLED'; totalAmount: string; installments: number; firstDueDate: string; createdAt: string; customer: { name: string } }
interface NegDetail extends NegRow {
  originalAmount: string; interest: string; fine: string; discount: string; intervalDays: number; notes: string | null; cancelReason: string | null; customer: { id: string; name: string; document: string | null };
  titles: { id: string; title: { description: string; dueDate: string; amount: string; status: string } }[];
  installmentsList: { id: string; installmentNo: number; installmentTotal: number; dueDate: string; amount: string; status: string }[];
  orders: { id: string; number: number; fiscalDocType: string; fiscalDocuments: { id: string; model: string; status: string; number: number | null; series: number | null; splitIndex: number | null; splitTotal: number | null }[] }[];
}

const num = (v: string) => { const n = Number(v.replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const STATUS_TITLE: Record<string, [string, string]> = { OPEN: ['Em aberto', ''], PARTIAL: ['Paga em parte', 'warn'], PAID: ['Paga', 'ok'], CANCELLED: ['Cancelada', 'danger'] };
const DOC_STATUS: Record<string, string> = { DRAFT: 'Rascunho', PENDING_VALIDATION: 'Com pendências', READY_TO_TRANSMIT: 'Pronta para transmitir', TRANSMITTING: 'Transmitindo', AUTHORIZED: 'Autorizada', REJECTED: 'Rejeitada', COMMUNICATION_FAILURE: 'Falha de comunicação', PENDING_CONSULT: 'Aguardando consulta', DENIED: 'Denegada', CANCELLED: 'Cancelada' };

/** Janela para montar a negociação: escolhe os títulos vencidos, ajusta juros/multa/desconto e define as novas parcelas. */
export function NegotiationDialog({ customerId, customerName, onClose, onDone }: { customerId: string; customerName: string; onClose: () => void; onDone: (id: string) => void }) {
  const [titles, setTitles] = useState<OpenTitle[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [f, setF] = useState({ interest: '', fine: '', discount: '', installments: '1', firstDueDate: '', intervalDays: '30', notes: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<OpenTitle[]>(`/finance/negotiations/open-titles/${customerId}`).then((t) => { setTitles(t); setPicked(new Set(t.filter((x) => x.eligible && x.daysLate > 0).map((x) => x.id))); }).catch((e) => setError(e.message));
  }, [customerId]);

  const original = useMemo(() => Math.round((titles ?? []).filter((t) => picked.has(t.id)).reduce((s, t) => s + Number(t.outstanding), 0) * 100), [titles, picked]);
  const total = original + Math.round(num(f.interest) * 100) + Math.round(num(f.fine) * 100) - Math.round(num(f.discount) * 100);
  const count = Math.max(1, Math.min(36, Math.floor(Number(f.installments)) || 1));
  const plan = total > 0 ? boletoPreview(total, count, f.firstDueDate, Math.max(1, Math.floor(Number(f.intervalDays)) || 30)) : [];

  async function submit() {
    setError('');
    if (!picked.size) { setError('Escolha ao menos um título para negociar.'); return; }
    if (total <= 0) { setError('O valor negociado deve ser maior que zero.'); return; }
    if (!f.firstDueDate) { setError('Informe o vencimento da primeira parcela.'); return; }
    setBusy(true);
    try {
      const r = await api<{ id: string }>('/finance/negotiations', 'POST', {
        customerId, titleIds: [...picked], interest: num(f.interest), fine: num(f.fine), discount: num(f.discount), installments: count, firstDueDate: f.firstDueDate, intervalDays: Number(f.intervalDays) || 30, notes: f.notes || undefined,
      });
      onDone(r.id);
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  return (
    <Dialog title={`Negociar dívida — ${customerName}`} description="Os títulos escolhidos são substituídos por novas parcelas (boleto). Os originais ficam como renegociados, sem baixa de dinheiro." onClose={onClose} xl>
      <div className="modal-body">
        {error && <Alert kind="error">{error}</Alert>}
        <h3 style={{ margin: '4px 0 8px' }}>1. Títulos que entram na negociação</h3>
        {!titles && !error && <Skeleton rows={3} />}
        {titles?.length === 0 && <EmptyState title="Este cliente não tem títulos em aberto" />}
        {titles && titles.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th /><th>Título</th><th>Vencimento</th><th className="num">Dias</th><th className="num">Em aberto</th></tr></thead>
            <tbody>{titles.map((t) => (
              <tr key={t.id} style={!t.eligible ? { opacity: 0.6 } : undefined}>
                <td><input type="checkbox" aria-label={`Negociar ${t.description}`} disabled={!t.eligible} checked={picked.has(t.id)} onChange={(e) => { const s = new Set(picked); if (e.target.checked) s.add(t.id); else s.delete(t.id); setPicked(s); }} style={{ width: 'auto' }} /></td>
                <td>{t.description}{t.installmentTotal > 1 ? ` (${t.installmentNo}/${t.installmentTotal})` : ''}{t.reason && <div className="muted" style={{ fontSize: '0.78rem' }}>{t.reason}</div>}</td>
                <td>{dateBr(t.dueDate)}</td>
                <td className="num">{t.daysLate > 0 ? <span className="badge danger">{t.daysLate}d</span> : <span className="badge">a vencer</span>}</td>
                <td className="num">{brl(t.outstanding)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}

        <h3 style={{ margin: '16px 0 8px' }}>2. Valores</h3>
        <div className="form-grid">
          <div><label>Dívida original</label><input value={brl(original / 100)} readOnly /></div>
          <div><label htmlFor="ng-fine">Multa (R$)</label><input id="ng-fine" inputMode="decimal" placeholder="0,00" value={f.fine} onChange={set('fine')} /></div>
          <div><label htmlFor="ng-int">Juros (R$)</label><input id="ng-int" inputMode="decimal" placeholder="0,00" value={f.interest} onChange={set('interest')} /></div>
          <div><label htmlFor="ng-dis">Desconto (R$)</label><input id="ng-dis" inputMode="decimal" placeholder="0,00" value={f.discount} onChange={set('discount')} /></div>
        </div>

        <h3 style={{ margin: '16px 0 8px' }}>3. Novas parcelas (boleto)</h3>
        <div className="form-grid">
          <div><label htmlFor="ng-n">Parcelas</label><select id="ng-n" value={f.installments} onChange={set('installments')}>{Array.from({ length: 36 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}x</option>)}</select></div>
          <div><label htmlFor="ng-d">Vencimento da 1ª parcela</label><input id="ng-d" type="date" min={new Date().toISOString().slice(0, 10)} value={f.firstDueDate} onChange={set('firstDueDate')} /></div>
          {count > 1 && <div><label htmlFor="ng-i">Dias entre as parcelas</label><input id="ng-i" inputMode="numeric" value={f.intervalDays} onChange={set('intervalDays')} /></div>}
          <div style={{ gridColumn: '1 / -1' }}><label htmlFor="ng-o">Observações</label><input id="ng-o" maxLength={500} value={f.notes} onChange={set('notes')} placeholder="Ex.: acordo por telefone com o responsável financeiro" /></div>
        </div>
        {plan.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 12 }}><table>
            <thead><tr><th>Parcela</th><th>Vencimento</th><th className="num">Valor</th></tr></thead>
            <tbody>{plan.map((p, i) => <tr key={i}><td>{i + 1}/{plan.length}</td><td>{dateBr(p.due)}</td><td className="num">{brl(p.cents / 100)}</td></tr>)}</tbody>
          </table></div>
        )}
        <div className="totals-bar" style={{ marginTop: 12 }}>
          <span>Original {brl(original / 100)}</span><span>+ Multa e juros {brl((num(f.fine) + num(f.interest)))}</span><span>− Desconto {brl(num(f.discount))}</span><span className="grand">Total negociado {brl(Math.max(total, 0) / 100)}</span>
        </div>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>Cancelar</button>
        <button className={`btn primary ${busy ? 'loading' : ''}`} disabled={busy} onClick={submit}>Gerar negociação e boletos</button>
      </div>
    </Dialog>
  );
}

/** Detalhe da negociação: novas parcelas, títulos substituídos e as notas das vendas de origem. */
export function NegotiationDetailDialog({ id, canManage, onClose, onChanged }: { id: string; canManage: boolean; onClose: () => void; onChanged: () => void }) {
  const ui = useUi();
  const { can } = useSession();
  const [d, setD] = useState<NegDetail | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api<NegDetail>(`/finance/negotiations/${id}`).then(setD).catch((e) => setError(e.message)), [id]);
  useEffect(() => { void load(); }, [load]);

  async function undo() {
    const reason = await ui.prompt({ title: 'Desfazer negociação', message: 'As parcelas novas são canceladas e os títulos originais voltam a ficar em aberto (e em atraso).', label: 'Motivo', danger: true, confirmLabel: 'Desfazer negociação', cancelLabel: 'Voltar' });
    if (!reason) return;
    try { await api(`/finance/negotiations/${id}/cancel`, 'POST', { reason }); ui.toast.ok('Negociação desfeita.'); await load(); onChanged(); } catch (e) { setError((e as Error).message); }
  }
  async function prepare(orderId: string) {
    try { await api('/fiscal/outgoing/prepare', 'POST', { salesOrderId: orderId }); ui.toast.ok('Nota preparada. Valide e transmita em Fiscal → Notas de saída.'); await load(); } catch (e) { setError((e as Error).message); }
  }

  return (
    <Dialog title={d ? `Negociação #${d.number}` : 'Negociação'} description={d && <span className={`badge ${d.status === 'ACTIVE' ? 'ok' : 'danger'}`}>{d.status === 'ACTIVE' ? 'Ativa' : 'Desfeita'}</span>} onClose={onClose} xl>
      <div className="modal-body">
        {error && <Alert kind="error">{error}</Alert>}
        {!d && !error && <Skeleton rows={4} />}
        {d && <>
          <div className="meta" style={{ marginBottom: 12 }}><span><b>Cliente:</b> {d.customer.name}</span><span><b>Original:</b> {brl(d.originalAmount)}</span><span><b>Multa:</b> {brl(d.fine)}</span><span><b>Juros:</b> {brl(d.interest)}</span><span><b>Desconto:</b> {brl(d.discount)}</span><span><b>Total negociado:</b> {brl(d.totalAmount)}</span></div>
          {d.notes && <p className="muted" style={{ marginTop: 0 }}>{d.notes}</p>}
          {d.cancelReason && <Alert kind="error">Desfeita: {d.cancelReason}</Alert>}

          <h3 style={{ margin: '8px 0' }}>Novas parcelas (boleto)</h3>
          <div className="table-wrap"><table>
            <thead><tr><th>Parcela</th><th>Vencimento</th><th className="num">Valor</th><th>Situação</th></tr></thead>
            <tbody>{d.installmentsList.map((p) => { const [l, tone] = STATUS_TITLE[p.status] ?? [p.status, '']; return <tr key={p.id}><td>{p.installmentNo}/{p.installmentTotal}</td><td>{dateBr(p.dueDate)}</td><td className="num">{brl(p.amount)}</td><td><span className={`badge ${tone}`}>{l}</span></td></tr>; })}</tbody>
          </table></div>
          <p className="muted" style={{ fontSize: '0.82rem' }}>As parcelas são lançadas em Financeiro → A receber. O sistema <strong>não emite o boleto bancário</strong>: gere o boleto no seu banco ou meio de cobrança com estes vencimentos e valores, e dê a baixa aqui quando for pago.</p>

          <h3 style={{ margin: '16px 0 8px' }}>Títulos substituídos</h3>
          <div className="table-wrap"><table>
            <thead><tr><th>Título</th><th>Vencimento</th><th className="num">Valor</th><th>Situação</th></tr></thead>
            <tbody>{d.titles.map((x) => { const [l, tone] = STATUS_TITLE[x.title.status] ?? [x.title.status, '']; return <tr key={x.id}><td>{x.title.description}</td><td>{dateBr(x.title.dueDate)}</td><td className="num">{brl(x.title.amount)}</td><td><span className={`badge ${tone}`}>{x.title.status === 'CANCELLED' ? 'Renegociado' : l}</span></td></tr>; })}</tbody>
          </table></div>

          {d.orders.length > 0 && <>
            <h3 style={{ margin: '16px 0 8px' }}>Notas das vendas de origem</h3>
            <div className="table-wrap"><table>
              <thead><tr><th>Venda</th><th>Nota</th><th /></tr></thead>
              <tbody>{d.orders.map((o) => (
                <tr key={o.id}>
                  <td>Pedido #{o.number}</td>
                  <td>{o.fiscalDocuments.length ? o.fiscalDocuments.map((n) => <div key={n.id}><span className="badge">{n.model === '65' ? 'NFC-e' : 'NF-e'}{n.splitTotal ? ` cupom ${n.splitIndex}/${n.splitTotal}` : ''}{n.number ? ` nº ${n.number}` : ''}</span> {DOC_STATUS[n.status] ?? n.status}</div>) : <span className="muted">Ainda sem nota emitida</span>}</td>
                  <td>{!o.fiscalDocuments.length && can('fiscal.emit') && <button className="btn sm" onClick={() => prepare(o.id)}>Preparar nota</button>}</td>
                </tr>
              ))}</tbody>
            </table></div>
            <p className="muted" style={{ fontSize: '0.82rem' }}>A nota fiscal é da <strong>venda de mercadoria</strong> e continua valendo: a negociação não gera nota nova sobre o valor renegociado (juros e multa não entram em nota de produto). Para transmitir ou consultar, vá em <Link href="/fiscal">Fiscal → Notas de saída</Link>.</p>
          </>}
        </>}
      </div>
      {d?.status === 'ACTIVE' && canManage && <div className="modal-foot"><button className="btn" onClick={undo}>Desfazer negociação</button></div>}
    </Dialog>
  );
}

/** Lista das negociações feitas. */
export function NegotiationsList({ canManage, refreshKey, onChanged }: { canManage: boolean; refreshKey: number; onChanged: () => void }) {
  const [rows, setRows] = useState<NegRow[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => api<NegRow[]>('/finance/negotiations').then(setRows).catch(() => setRows([])), []);
  useEffect(() => { void load(); }, [load, refreshKey]);
  return (
    <section className="card" aria-label="Negociações">
      <div className="card-head"><h2>Negociações</h2><span className="badge">{rows?.length ?? 0}</span></div>
      {rows && rows.length === 0 && <EmptyState title="Nenhuma negociação ainda">Clique em “Negociar” ao lado de um cliente em atraso para parcelar a dívida em novos boletos.</EmptyState>}
      {rows && rows.length > 0 && (
        <div className="table-wrap"><table>
          <thead><tr><th>Nº</th><th>Cliente</th><th className="num">Total</th><th>Parcelas</th><th>1º vencimento</th><th>Situação</th><th /></tr></thead>
          <tbody>{rows.map((n) => <tr key={n.id}><td>#{n.number}</td><td>{n.customer.name}</td><td className="num">{brl(n.totalAmount)}</td><td>{n.installments}x</td><td>{dateBr(n.firstDueDate)}</td><td><span className={`badge ${n.status === 'ACTIVE' ? 'ok' : 'danger'}`}>{n.status === 'ACTIVE' ? 'Ativa' : 'Desfeita'}</span></td><td><button className="btn sm" onClick={() => setOpen(n.id)}>Abrir</button></td></tr>)}</tbody>
        </table></div>
      )}
      {open && <NegotiationDetailDialog id={open} canManage={canManage} onClose={() => setOpen(null)} onChanged={() => { void load(); onChanged(); }} />}
    </section>
  );
}
