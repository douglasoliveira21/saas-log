'use client';

import { Lock, ShieldCheck, TriangleAlert, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Alert, EmptyState, StatCard, useUi } from '@/components/ui';
import { api } from '@/lib/api';
import { brl, dateBr } from '@/lib/format';
import { NegotiationDetailDialog, NegotiationDialog, NegotiationsList } from './negotiation';

interface Row {
  customerId: string; name: string; document: string | null; titles: number; overdueAmount: string; oldestDueDate: string; maxDaysOverdue: number;
  state: 'ATTENTION' | 'BLOCKED' | 'RELEASED'; releasedUntil: string | null; releaseReason: string | null;
}
interface Data { blockAfterDays: number; totals: { customers: number; overdueAmount: string; blocked: number; released: number }; items: Row[] }

const STATE = { ATTENTION: ['Atenção', 'warn'], BLOCKED: ['Bloqueado', 'danger'], RELEASED: ['Liberado', 'ok'] } as const;
const FILTERS = [['ALL', 'Todos'], ['BLOCKED', 'Bloqueados'], ['ATTENTION', 'Em atenção'], ['RELEASED', 'Liberados']] as const;

/** Inadimplência: clientes com títulos a receber vencidos, regra de bloqueio por dias de atraso e liberação manual. */
export function Delinquency({ canConfigure, canRelease }: { canConfigure: boolean; canRelease: boolean }) {
  const ui = useUi();
  const [data, setData] = useState<Data | null>(null);
  const [days, setDays] = useState('');
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('ALL');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [negotiating, setNegotiating] = useState<Row | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [listKey, setListKey] = useState(0);

  const load = useCallback(() => api<Data>('/finance/delinquency').then((d) => { setData(d); setDays(String(d.blockAfterDays)); }).catch((e) => setError(e.message)), []);
  useEffect(() => { void load(); }, [load]);

  async function saveConfig() {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 0 || n > 365) { ui.toast.error('Informe um número inteiro de 0 a 365.'); return; }
    setBusy(true);
    try {
      await api('/finance/delinquency/config', 'PUT', { blockAfterDays: n });
      ui.toast.ok(n === 0 ? 'Bloqueio automático desligado.' : `Clientes serão bloqueados com ${n} dia(s) de atraso.`);
      await load();
    } catch (e) { ui.toast.error((e as Error).message); }
    setBusy(false);
  }

  async function release(r: Row) {
    const v = await ui.form({
      title: `Liberar ${r.name}`, confirmLabel: 'Liberar',
      message: `O cliente poderá fazer pedidos mesmo com ${brl(r.overdueAmount)} em atraso. A liberação vale pelo prazo escolhido e fica registrada.`,
      fields: [
        { name: 'days', label: 'Liberar por quantos dias?', type: 'number', defaultValue: 7, min: 1, max: 90, required: true },
        { name: 'reason', label: 'Motivo (ex.: pagamento prometido para sexta)', required: true },
      ],
    });
    if (!v) return;
    try {
      await api(`/finance/delinquency/customers/${r.customerId}/release`, 'POST', { days: Number(v.days), reason: v.reason });
      ui.toast.ok('Cliente liberado.'); await load();
    } catch (e) { ui.toast.error((e as Error).message); }
  }

  async function revoke(r: Row) {
    if (!(await ui.confirm({ title: `Cancelar a liberação de ${r.name}?`, message: 'O cliente volta a ficar bloqueado.', danger: true, confirmLabel: 'Bloquear de novo', cancelLabel: 'Voltar' }))) return;
    try { await api(`/finance/delinquency/customers/${r.customerId}/revoke-release`, 'POST'); ui.toast.ok('Liberação cancelada.'); await load(); } catch (e) { ui.toast.error((e as Error).message); }
  }

  const rows = data?.items.filter((i) => filter === 'ALL' || i.state === filter) ?? [];
  const off = data?.blockAfterDays === 0;

  return (
    <div className="stack">
      {error && <Alert kind="error">{error}</Alert>}

      <section className="card" aria-label="Regra de bloqueio">
        <div className="card-head"><h2>Regra de bloqueio</h2>{data && <span className={`badge ${off ? '' : 'brand'}`}>{off ? 'Desligado' : `Bloqueia com ${data.blockAfterDays} dia(s) de atraso`}</span>}</div>
        <p className="muted" style={{ marginTop: 0 }}>
          O cliente com algum título <strong>a receber vencido</strong> há tantos dias ou mais fica <strong>bloqueado para novos pedidos</strong> até pagar (ou até você liberar). Use 0 para desligar. Pedidos que chegam dos marketplaces já vêm pagos e não são bloqueados.
        </p>
        <div className="row" style={{ alignItems: 'flex-end', gap: 12 }}>
          <div style={{ maxWidth: 240 }}>
            <label htmlFor="dl-days">Bloquear após quantos dias de atraso?</label>
            <input id="dl-days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} disabled={!canConfigure} aria-describedby="dl-hint" />
          </div>
          {canConfigure && <button className={`btn primary ${busy ? 'loading' : ''}`} disabled={busy || !data || days === String(data.blockAfterDays)} onClick={saveConfig}>Salvar regra</button>}
        </div>
        <div id="dl-hint" className="muted" style={{ fontSize: '0.82rem', marginTop: 6 }}>Exemplo: com 10, um cliente com boleto vencido há 10 dias não consegue criar nem enviar pedidos.</div>
      </section>

      {data && (
        <div className="grid cols-4">
          <StatCard label="Clientes com atraso" value={data.totals.customers} icon={<Users />} />
          <StatCard label="Valor em atraso" value={brl(data.totals.overdueAmount)} icon={<TriangleAlert />} tone={Number(data.totals.overdueAmount) > 0 ? 'warn' : undefined} />
          <StatCard label="Bloqueados" value={data.totals.blocked} icon={<Lock />} tone={data.totals.blocked ? 'danger' : undefined} />
          <StatCard label="Liberados manualmente" value={data.totals.released} icon={<ShieldCheck />} />
        </div>
      )}

      <section className="card" aria-label="Clientes em atraso">
        <div className="tabs" role="tablist" aria-label="Filtro" style={{ marginBottom: 12 }}>
          {FILTERS.map(([k, l]) => <button key={k} role="tab" aria-selected={filter === k} className={`tab ${filter === k ? 'active' : ''}`} onClick={() => setFilter(k)}>{l}</button>)}
        </div>
        {data && rows.length === 0 && (
          <EmptyState title={data.items.length ? 'Nenhum cliente neste filtro' : 'Nenhum cliente em atraso'}>{data.items.length ? 'Mude o filtro para ver os demais.' : 'Quando um título a receber vencer sem pagamento, o cliente aparece aqui.'}</EmptyState>
        )}
        {rows.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th>Cliente</th><th className="num">Títulos</th><th className="num">Em atraso</th><th>Mais antigo</th><th className="num">Dias</th><th>Situação</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => {
                const [label, tone] = STATE[r.state];
                return (
                  <tr key={r.customerId}>
                    <td>{r.name}{r.document && <div className="muted mono" style={{ fontSize: '0.78rem' }}>{r.document}</div>}</td>
                    <td className="num">{r.titles}</td>
                    <td className="num">{brl(r.overdueAmount)}</td>
                    <td>{dateBr(r.oldestDueDate)}</td>
                    <td className="num"><strong>{r.maxDaysOverdue}</strong></td>
                    <td>
                      <span className={`badge ${tone}`}>{label}</span>
                      {r.state === 'RELEASED' && r.releasedUntil && <div className="muted" style={{ fontSize: '0.78rem' }}>até {dateBr(r.releasedUntil)}{r.releaseReason ? ` · ${r.releaseReason}` : ''}</div>}
                    </td>
                    <td className="actions">
                      {canConfigure && <button className="btn sm primary" onClick={() => setNegotiating(r)}>Negociar</button>}
                      {canRelease && r.state === 'BLOCKED' && <button className="btn sm" onClick={() => release(r)}>Liberar</button>}
                      {canRelease && r.state === 'RELEASED' && <button className="btn sm ghost" onClick={() => revoke(r)}>Cancelar liberação</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </section>

      <NegotiationsList canManage={canConfigure} refreshKey={listKey} onChanged={() => { void load(); }} />
      {negotiating && <NegotiationDialog customerId={negotiating.customerId} customerName={negotiating.name} onClose={() => setNegotiating(null)} onDone={(id) => { setNegotiating(null); setCreated(id); setListKey((k) => k + 1); ui.toast.ok('Negociação criada: as novas parcelas já estão em A receber.'); void load(); }} />}
      {created && <NegotiationDetailDialog id={created} canManage={canConfigure} onClose={() => setCreated(null)} onChanged={() => { void load(); setListKey((k) => k + 1); }} />}
    </div>
  );
}
