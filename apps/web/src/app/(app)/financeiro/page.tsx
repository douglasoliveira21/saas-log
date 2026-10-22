'use client';

import { Plus } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { brl, dateBr } from '@/lib/format';
import { useUi, PageHeader, Alert } from '@/components/ui';
import { useSession } from '@/lib/session';
import { Delinquency } from './delinquency';

type Tab = 'pagar' | 'receber' | 'inadimplencia' | 'caixa' | 'dre' | 'contas' | 'banco' | 'marketplaces';

interface Title { id: string; description: string; counterpartyName: string | null; dueDate: string; amount: string; outstanding: string; status: string; overdue: boolean; daysOverdue: number; installmentNo: number; installmentTotal: number; origin: string; approvedAt: string | null; category?: { name: string } | null }
interface Account { id: string; name: string; kind: string; active: boolean; balance: string; bankName?: string | null }
interface Category { id: string; name: string; kind: string }
interface Summary { PAYABLE: Record<string, string>; RECEIVABLE: Record<string, string> }
interface FlowRow { start: string; end: string; realizedIn: string; realizedOut: string; pendingIn: string; pendingOut: string; marketplaceExpectedIn: string; closingBalance: string; projected: boolean }
interface DreLine { key: string; label: string; amount: string; pctOfNetRevenue: number | null; detail?: Record<string, string> }
interface StmtLine { id: string; fitid: string; postedAt: string; amount: string; description: string; settlementId: string | null; suggestions: { settlementId: string; description: string }[] }
interface Conn { id: string; label: string; provider: string }
interface MktLine { id: string; externalOrderId: string; status: string; gross: string; netReported: string; receivedDate: string | null; divergence: { code: string; message: string }[] }

const STATUS: Record<string, string> = { OPEN: 'Em aberto', PARTIAL: 'Parcial', PAID: 'Quitado', CANCELLED: 'Cancelado' };
const MKT: Record<string, string> = { IMPORTED: 'Importada', UNLINKED: 'Sem pedido no ERP', DIVERGENT: 'Divergente', RECONCILED: 'Conciliada' };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const shift = (n: number) => iso(new Date(Date.now() + n * 86_400_000));
const num = (v: FormDataEntryValue | number | null) => Number(String(v ?? '').replace(',', '.'));

export default function FinanceiroPage() {
  const { can } = useSession();
  const ui = useUi();
  const manage = can('finance.manage');
  const reconcile = can('finance.reconcile');
  const [tab, setTab] = useState<Tab>('pagar');
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [titles, setTitles] = useState<Title[]>([]);
  const [onlyOverdue, setOnlyOverdue] = useState(false);
  const [panel, setPanel] = useState<'novo' | 'conta' | null>(null);
  const [settling, setSettling] = useState<Title | null>(null);
  const [flow, setFlow] = useState<{ openingBalance: string; overdue: { receivable: string; payable: string }; rows: FlowRow[]; notes: string[] } | null>(null);
  const [range, setRange] = useState({ from: shift(-7), to: shift(30), granularity: 'week' });
  const [dre, setDre] = useState<{ lines: DreLine[]; warnings: string[]; basis: string } | null>(null);
  const [acct, setAcct] = useState('');
  const [lines, setLines] = useState<StmtLine[]>([]);
  const [conns, setConns] = useState<Conn[]>([]);
  const [conn, setConn] = useState('');
  const [mkt, setMkt] = useState<{ items: MktLine[]; summary: { status: string; lines: number; net: string }[] } | null>(null);

  const fail = (e: unknown) => { setError((e as Error).message); setOk(''); };
  const direction = tab === 'receber' ? 'RECEIVABLE' : 'PAYABLE';

  const loadBase = useCallback(() => {
    api<Account[]>('/finance/accounts').then((a) => { setAccounts(a); setAcct((cur) => cur || a[0]?.id || ''); }).catch(fail);
    api<Category[]>('/finance/categories').then(setCategories).catch(() => undefined);
    api<Summary>('/finance/summary').then(setSummary).catch(() => undefined);
  }, []);
  useEffect(loadBase, [loadBase]);

  const loadTitles = useCallback(() => {
    if (tab !== 'pagar' && tab !== 'receber') return;
    api<{ items: Title[] }>(`/finance/titles?direction=${direction}${onlyOverdue ? '&overdue=true' : ''}&limit=200`).then((r) => setTitles(r.items)).catch(fail);
  }, [tab, direction, onlyOverdue]);
  useEffect(loadTitles, [loadTitles]);

  useEffect(() => {
    if (tab === 'caixa') api<NonNullable<typeof flow>>(`/finance/cashflow?from=${range.from}&to=${range.to}&granularity=${range.granularity}`).then(setFlow).catch(fail);
    if (tab === 'dre') api<NonNullable<typeof dre>>(`/finance/dre?from=${range.from}&to=${range.to}`).then(setDre).catch(fail);
  }, [tab, range]);
  useEffect(() => { if (tab === 'banco' && acct && reconcile) api<StmtLine[]>(`/finance/accounts/${acct}/statement`).then(setLines).catch(fail); }, [tab, acct, reconcile]);
  useEffect(() => {
    if (tab !== 'marketplaces' || !reconcile) return;
    api<Conn[]>('/integrations/connections').then((c) => { setConns(c); setConn((cur) => cur || c[0]?.id || ''); }).catch(fail);
  }, [tab, reconcile]);
  const loadMkt = useCallback(() => { if (conn) api<NonNullable<typeof mkt>>(`/finance/marketplace/${conn}/settlements`).then(setMkt).catch(fail); }, [conn]);
  useEffect(() => { if (tab === 'marketplaces') loadMkt(); }, [tab, loadMkt]);

  async function run(fn: () => Promise<unknown>, done: string, after?: () => void) {
    setError(''); setOk('');
    try { await fn(); setOk(done); after?.(); loadBase(); loadTitles(); } catch (e) { fail(e); }
  }

  const createTitle = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> = { direction: f.get('direction'), description: f.get('description'), amount: num(f.get('amount')), dueDate: f.get('dueDate'), mode: f.get('mode') };
    if (f.get('mode') !== 'SINGLE') body.count = Number(f.get('count') || 2);
    for (const k of ['counterpartyName', 'categoryId', 'documentRef']) if (String(f.get(k) ?? '').trim()) body[k] = f.get(k);
    void run(() => api('/finance/titles', 'POST', body), 'Título lançado.', () => setPanel(null));
  };
  const createAccount = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> = { name: f.get('name'), kind: f.get('kind'), openingBalance: num(f.get('openingBalance') || 0) };
    if (String(f.get('bankName') ?? '').trim()) body.bankName = f.get('bankName');
    void run(() => api('/finance/accounts', 'POST', body), 'Conta criada.', () => setPanel(null));
  };
  const settle = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!settling) return;
    const f = new FormData(e.currentTarget);
    const body = { accountId: f.get('accountId'), amount: num(f.get('amount')), interest: num(f.get('interest') || 0), fine: num(f.get('fine') || 0), discount: num(f.get('discount') || 0), paidAt: f.get('paidAt') || undefined, expectedOutstanding: Number(settling.outstanding) };
    void run(() => api(`/finance/titles/${settling.id}/settle`, 'POST', body), direction === 'PAYABLE' ? 'Pagamento registrado.' : 'Recebimento registrado.', () => setSettling(null));
  };
  const upload = (kind: 'statement' | 'report') => (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const file = (form.elements.namedItem('file') as HTMLInputElement).files?.[0];
    if (!file) return;
    void file.text().then((content) =>
      run(async () => {
        const r = kind === 'statement'
          ? await api<{ imported: number; duplicates: number; errors: unknown[] }>(`/finance/accounts/${acct}/statement`, 'POST', { format: file.name.toLowerCase().endsWith('.ofx') ? 'OFX' : 'CSV', content })
          : await api<{ imported: number; duplicates: number; errors: unknown[] }>(`/finance/marketplace/${conn}/reports`, 'POST', { reportRef: String(new FormData(form).get('reportRef')), csv: content });
        setOk(`${r.imported} linha(s) importada(s), ${r.duplicates} já existente(s), ${r.errors.length} com erro.`);
        if (kind === 'statement') api<StmtLine[]>(`/finance/accounts/${acct}/statement`).then(setLines).catch(fail); else loadMkt();
      }, ''));
  };

  const tabs: [Tab, string, boolean][] = [['pagar', 'A pagar', true], ['receber', 'A receber', true], ['inadimplencia', 'Inadimplência', true], ['caixa', 'Fluxo de caixa', true], ['dre', 'DRE gerencial', true], ['contas', 'Contas', true], ['banco', 'Conciliação bancária', reconcile], ['marketplaces', 'Marketplaces', reconcile]];

  return (
    <>
      <PageHeader title="Financeiro" description={<>Baixas e estornos são lançamentos auditáveis: nada é apagado. O DRE é gerencial e não substitui a contabilidade.</>} actions={<>
          {manage && (tab === 'pagar' || tab === 'receber') && <button className="btn primary" onClick={() => setPanel('novo')}><Plus aria-hidden />Lançar título</button>}
        {manage && tab === 'contas' && <button className="btn primary" onClick={() => setPanel('conta')}><Plus aria-hidden />Conta</button>}
        </>} />
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}

      {summary && (
        <div className="grid cols-4" style={{ marginBottom: 16 }}>
          <div className="card stat"><div className="muted">A pagar vencido</div><div className="n">{brl(summary.PAYABLE.overdue)}</div></div>
          <div className="card stat"><div className="muted">A pagar em 7 dias</div><div className="n">{brl(summary.PAYABLE.next7)}</div></div>
          <div className="card stat"><div className="muted">A receber vencido</div><div className="n">{brl(summary.RECEIVABLE.overdue)}</div></div>
          <div className="card stat"><div className="muted">A receber em 7 dias</div><div className="n">{brl(summary.RECEIVABLE.next7)}</div></div>
        </div>
      )}

      <div className="tabs" role="tablist" aria-label="Seções do financeiro">
        {tabs.filter((t) => t[2]).map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => { setTab(k); setPanel(null); setSettling(null); }}>{label}</button>)}
      </div>

      {panel === 'novo' && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={createTitle}>
          <h2>Novo título</h2>
          <div className="form-grid">
            <div><label htmlFor="d">Tipo</label><select id="d" name="direction" defaultValue={direction}><option value="PAYABLE">A pagar</option><option value="RECEIVABLE">A receber</option></select></div>
            <div><label htmlFor="ds">Descrição *</label><input id="ds" name="description" required minLength={2} /></div>
            <div><label htmlFor="cp">Fornecedor / cliente</label><input id="cp" name="counterpartyName" /></div>
            <div><label htmlFor="am">Valor *</label><input id="am" name="amount" inputMode="decimal" required /></div>
            <div><label htmlFor="dd">Vencimento *</label><input id="dd" name="dueDate" type="date" required defaultValue={shift(7)} /></div>
            <div><label htmlFor="md">Lançamento</label><select id="md" name="mode" defaultValue="SINGLE"><option value="SINGLE">Único</option><option value="SPLIT">Parcelado (divide o total)</option><option value="RECURRING">Recorrente mensal</option></select></div>
            <div><label htmlFor="ct">Parcelas / meses</label><input id="ct" name="count" type="number" min={2} max={60} placeholder="2" /></div>
            <div><label htmlFor="cat">Categoria</label><select id="cat" name="categoryId" defaultValue=""><option value="">Sem categoria</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
          </div>
          <div className="row" style={{ marginTop: 12 }}><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={() => setPanel(null)}>Cancelar</button></div>
        </form>
      )}
      {panel === 'conta' && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={createAccount}>
          <h2>Nova conta financeira</h2>
          <div className="form-grid">
            <div><label htmlFor="cn">Nome *</label><input id="cn" name="name" required /></div>
            <div><label htmlFor="ck">Tipo</label><select id="ck" name="kind" defaultValue="BANK"><option value="BANK">Banco</option><option value="CASH">Caixa</option><option value="MARKETPLACE">Saldo em marketplace</option><option value="OTHER">Outra</option></select></div>
            <div><label htmlFor="cb">Banco</label><input id="cb" name="bankName" /></div>
            <div><label htmlFor="co">Saldo inicial</label><input id="co" name="openingBalance" inputMode="decimal" defaultValue="0" /></div>
          </div>
          <div className="row" style={{ marginTop: 12 }}><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={() => setPanel(null)}>Cancelar</button></div>
        </form>
      )}

      {(tab === 'pagar' || tab === 'receber') && (
        <div className="card">
          <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={onlyOverdue} onChange={(e) => setOnlyOverdue(e.target.checked)} style={{ width: 'auto' }} /> Somente vencidos</label>
          {settling && (
            <form className="card" style={{ margin: '12px 0' }} onSubmit={settle}>
              <h2>{direction === 'PAYABLE' ? 'Pagar' : 'Receber'}: {settling.description}</h2>
              <p className="muted">Em aberto: {brl(settling.outstanding)}. Valor = principal + juros + multa − desconto.</p>
              <div className="form-grid">
                <div><label htmlFor="sa">Conta *</label><select id="sa" name="accountId" required defaultValue={accounts[0]?.id}>{accounts.filter((a) => a.active).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
                <div><label htmlFor="sv">Valor *</label><input id="sv" name="amount" inputMode="decimal" required defaultValue={settling.outstanding} /></div>
                <div><label htmlFor="si">Juros</label><input id="si" name="interest" inputMode="decimal" /></div>
                <div><label htmlFor="sf">Multa</label><input id="sf" name="fine" inputMode="decimal" /></div>
                <div><label htmlFor="sd">Desconto</label><input id="sd" name="discount" inputMode="decimal" /></div>
                <div><label htmlFor="sp">Data</label><input id="sp" name="paidAt" type="date" defaultValue={iso(new Date())} /></div>
              </div>
              <div className="row" style={{ marginTop: 12 }}><button className="btn primary">Confirmar</button><button type="button" className="btn" onClick={() => setSettling(null)}>Cancelar</button></div>
            </form>
          )}
          <div className="table-wrap"><table>
            <thead><tr><th>Vencimento</th><th>Descrição</th><th>Parcela</th><th>Valor</th><th>Em aberto</th><th>Status</th><th /></tr></thead>
            <tbody>
              {titles.length === 0 && <tr><td colSpan={7} className="muted">Nenhum título.</td></tr>}
              {titles.map((t) => (
                <tr key={t.id}>
                  <td>{dateBr(t.dueDate)} {t.overdue && <span className="badge warn">{t.daysOverdue}d atraso</span>}</td>
                  <td>{t.description}{t.counterpartyName ? <><br /><span className="muted">{t.counterpartyName}</span></> : null} {t.origin !== 'MANUAL' && <span className="badge">{t.origin}</span>}</td>
                  <td>{t.installmentNo}/{t.installmentTotal}</td><td className="num">{brl(t.amount)}</td><td className="num">{brl(t.outstanding)}</td>
                  <td><span className={`badge ${t.status === 'PAID' ? 'ok' : t.overdue ? 'warn' : ''}`}>{STATUS[t.status]}</span></td>
                  <td className="row">
                    {manage && (t.status === 'OPEN' || t.status === 'PARTIAL') && <button className="btn sm" onClick={() => setSettling(t)}>{direction === 'PAYABLE' ? 'Pagar' : 'Receber'}</button>}
                    {can('finance.approve') && direction === 'PAYABLE' && !t.approvedAt && t.status === 'OPEN' && <button className="btn sm" onClick={() => run(() => api(`/finance/titles/${t.id}/approve`, 'POST'), 'Título aprovado.')}>Aprovar</button>}
                    {manage && t.status === 'OPEN' && <button className="btn sm" onClick={async () => { const reason = await ui.prompt({ title: 'Cancelar título', message: 'Somente títulos sem baixa podem ser cancelados.', label: 'Motivo do cancelamento', danger: true, confirmLabel: 'Cancelar título', cancelLabel: 'Voltar' }); if (reason) void run(() => api(`/finance/titles/${t.id}/cancel`, 'POST', { reason }), 'Título cancelado.'); }}>Cancelar</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      )}

      {(tab === 'caixa' || tab === 'dre') && (
        <div className="card">
          <div className="row" style={{ flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
            <div><label htmlFor="rf">De</label><input id="rf" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></div>
            <div><label htmlFor="rt">Até</label><input id="rt" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></div>
            {tab === 'caixa' && <div><label htmlFor="rg">Agrupar por</label><select id="rg" value={range.granularity} onChange={(e) => setRange({ ...range, granularity: e.target.value })}><option value="day">Dia</option><option value="week">Semana</option><option value="month">Mês</option></select></div>}
          </div>
          {tab === 'caixa' && flow && (
            <>
              <p>Saldo inicial: <strong>{brl(flow.openingBalance)}</strong> · Vencido a receber: {brl(flow.overdue.receivable)} · Vencido a pagar: {brl(flow.overdue.payable)}</p>
              <div className="table-wrap"><table>
                <thead><tr><th>Período</th><th>Entradas realizadas</th><th>Saídas realizadas</th><th>A receber</th><th>A pagar</th><th>Marketplaces previstos</th><th>Saldo final</th></tr></thead>
                <tbody>{flow.rows.map((r) => <tr key={r.start}><td>{dateBr(r.start)} – {dateBr(r.end)} {r.projected && <span className="badge">projetado</span>}</td><td className="num">{brl(r.realizedIn)}</td><td className="num">{brl(r.realizedOut)}</td><td className="num">{brl(r.pendingIn)}</td><td className="num">{brl(r.pendingOut)}</td><td className="num">{brl(r.marketplaceExpectedIn)}</td><td><strong>{brl(r.closingBalance)}</strong></td></tr>)}</tbody>
              </table></div>
              <ul className="muted">{flow.notes.map((n) => <li key={n}>{n}</li>)}</ul>
            </>
          )}
          {tab === 'dre' && dre && (
            <>
              {dre.warnings.map((w) => <div key={w} className="alert error">{w}</div>)}
              <div className="table-wrap"><table>
                <thead><tr><th>Linha</th><th>Valor</th><th>% da receita líquida</th></tr></thead>
                <tbody>{dre.lines.map((l) => <tr key={l.key}><td>{l.label}{l.detail && <><br /><span className="muted">{Object.entries(l.detail).map(([k, v]) => `${k}: ${brl(v)}`).join(' · ')}</span></>}</td><td><strong>{brl(l.amount)}</strong></td><td>{l.pctOfNetRevenue === null ? '—' : `${l.pctOfNetRevenue.toLocaleString('pt-BR')}%`}</td></tr>)}</tbody>
              </table></div>
              <p className="muted">{dre.basis}</p>
            </>
          )}
        </div>
      )}

      {tab === 'inadimplencia' && <Delinquency canConfigure={manage} canRelease={can('finance.approve')} />}

      {tab === 'contas' && (
        <div className="card"><div className="table-wrap"><table>
          <thead><tr><th>Conta</th><th>Tipo</th><th>Saldo</th><th>Situação</th><th /></tr></thead>
          <tbody>{accounts.map((a) => <tr key={a.id}><td>{a.name}{a.bankName ? <span className="muted"> · {a.bankName}</span> : null}</td><td>{a.kind}</td><td className="num">{brl(a.balance)}</td><td>{a.active ? 'Ativa' : 'Inativa'}</td><td>{manage && <button className="btn sm" onClick={() => run(() => api(`/finance/accounts/${a.id}/active`, 'PUT', { active: !a.active }), 'Conta atualizada.')}>{a.active ? 'Desativar' : 'Ativar'}</button>}</td></tr>)}</tbody>
        </table></div></div>
      )}

      {tab === 'banco' && reconcile && (
        <div className="card">
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <div><label htmlFor="ba">Conta</label><select id="ba" value={acct} onChange={(e) => setAcct(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
            <form onSubmit={upload('statement')} className="row" style={{ alignItems: 'end', gap: 8 }}><div><label htmlFor="bf">Extrato (OFX ou CSV: data;descricao;valor)</label><input id="bf" name="file" type="file" accept=".ofx,.csv,.txt" required /></div><button className="btn primary">Importar</button></form>
          </div>
          <div className="table-wrap" style={{ marginTop: 12 }}><table>
            <thead><tr><th>Data</th><th>Descrição</th><th>Valor</th><th>Situação</th></tr></thead>
            <tbody>
              {lines.length === 0 && <tr><td colSpan={4} className="muted">Nenhum lançamento importado.</td></tr>}
              {lines.map((l) => (
                <tr key={l.id}>
                  <td>{dateBr(l.postedAt)}</td><td>{l.description}</td><td className="num">{brl(l.amount)}</td>
                  <td>{l.settlementId ? <><span className="badge ok">conciliado</span> <button className="btn sm" onClick={() => run(() => api(`/finance/statement-lines/${l.id}/unmatch`, 'POST'), 'Conciliação desfeita.', () => setTab('banco'))}>Desfazer</button></>
                    : l.suggestions.length ? l.suggestions.map((s) => <button key={s.settlementId} className="btn sm" title={s.description} onClick={() => run(() => api(`/finance/statement-lines/${l.id}/match`, 'POST', { settlementId: s.settlementId }), 'Conciliado.', () => api<StmtLine[]>(`/finance/accounts/${acct}/statement`).then(setLines))}>Conciliar com “{s.description.slice(0, 24)}”</button>)
                      : <span className="muted">sem sugestão</span>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      )}

      {tab === 'marketplaces' && reconcile && (
        <div className="card">
          <p className="muted">Importe o relatório de liquidação exportado pelo canal (CSV com pedido, bruto, comissão, tarifa_fixa, frete, liquido, data_recebimento). A leitura direta pela API do canal ainda não está disponível.</p>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <div><label htmlFor="mc">Conexão</label><select id="mc" value={conn} onChange={(e) => setConn(e.target.value)}>{conns.map((c) => <option key={c.id} value={c.id}>{c.label} ({c.provider})</option>)}</select></div>
            <form onSubmit={upload('report')} className="row" style={{ alignItems: 'end', gap: 8, flexWrap: 'wrap' }}>
              <div><label htmlFor="mr">Identificador do relatório *</label><input id="mr" name="reportRef" required placeholder="ex.: ML-2026-10-A" /></div>
              <div><label htmlFor="mf">Arquivo CSV</label><input id="mf" name="file" type="file" accept=".csv,.txt" required /></div>
              <button className="btn primary">Importar</button>
            </form>
          </div>
          {mkt && <p>{mkt.summary.map((s) => `${MKT[s.status] ?? s.status}: ${s.lines} (líquido ${brl(s.net)})`).join(' · ')}</p>}
          <div className="table-wrap"><table>
            <thead><tr><th>Pedido no canal</th><th>Bruto</th><th>Líquido</th><th>Recebimento</th><th>Situação</th><th /></tr></thead>
            <tbody>
              {mkt?.items.length === 0 && <tr><td colSpan={6} className="muted">Nada importado.</td></tr>}
              {mkt?.items.map((m) => (
                <tr key={m.id}>
                  <td>{m.externalOrderId}</td><td className="num">{brl(m.gross)}</td><td className="num">{brl(m.netReported)}</td><td>{dateBr(m.receivedDate)}</td>
                  <td><span className={`badge ${m.status === 'RECONCILED' ? 'ok' : m.status === 'IMPORTED' ? '' : 'warn'}`}>{MKT[m.status]}</span>{m.divergence.map((d) => <div key={d.code} className="muted">{d.message}</div>)}</td>
                  <td>{manage && (m.status === 'IMPORTED' || m.status === 'DIVERGENT') && (
                    <button className="btn sm" onClick={async () => {
                      if (m.divergence.length && !(await ui.confirm({ title: 'Conciliar com divergências?', message: 'O aceite fica registrado na auditoria.', confirmLabel: 'Aceitar e conciliar' }))) return;
                      void run(() => api(`/finance/marketplace/settlements/${m.id}/reconcile`, 'POST', { accountId: acct || accounts[0]?.id, acceptDivergence: m.divergence.length > 0 }), 'Linha conciliada.', loadMkt);
                    }}>Conciliar</button>)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      )}
    </>
  );
}
