'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { brl } from '@/lib/format';
import { useUi } from '@/components/ui';

interface Tier { id: string; name: string; minPct: string; kind: 'PERCENT' | 'FIXED'; percent: string | null; fixedAmount: string | null; active: boolean }
interface Row { salespersonId: string; name: string; goal: string; achieved: string; pct: number; tier: { name: string } | null; bonus: string; status: 'PROJECTED' | 'EARNED' | 'PAID' | 'NONE' }
interface Report { period: string; closed: boolean; rows: Row[]; basis: string }

const STATUS: Record<Row['status'], string> = { PROJECTED: 'Projeção', EARNED: 'Apurado (a pagar)', PAID: 'Pago', NONE: 'Sem bônus' };
const lastMonth = () => { const d = new Date(Date.now() - 3 * 3_600_000); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };

/** Comissão por meta: faixas de bônus sobre a meta mensal e apuração do mês encerrado (o valor apurado entra no repasse de comissões). */
export function GoalBonusCard({ manage, onChange, fail, done }: { manage: boolean; onChange: () => void; fail: (m: string) => void; done: (m: string) => void }) {
  const ui = useUi();
  const [period, setPeriod] = useState(lastMonth());
  const [rep, setRep] = useState<Report | null>(null);
  const [tiers, setTiers] = useState<Tier[]>([]);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => {
    api<Report>(`/goal-bonus?period=${period}`).then(setRep).catch((e) => fail(e.message));
    if (manage) api<Tier[]>('/goal-bonus-tiers').then(setTiers).catch(() => undefined);
  }, [period, manage, fail]);
  useEffect(load, [load]);

  async function addTier(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget); const kind = String(f.get('kind'));
    try {
      await api('/goal-bonus-tiers', 'POST', { name: f.get('name'), minPct: Number(String(f.get('minPct')).replace(',', '.')), kind, ...(kind === 'PERCENT' ? { percent: Number(String(f.get('value')).replace(',', '.')) } : { fixedAmount: Number(String(f.get('value')).replace(',', '.')) }) });
      setAdding(false); load();
    } catch (err) { fail((err as Error).message); }
  }
  async function close() {
    if (!(await ui.confirm({ title: `Apurar o bônus de ${period}?`, message: 'O valor apurado fica congelado (devoluções e mudança de faixas depois não o alteram) e passa a entrar no repasse de comissões.', confirmLabel: 'Apurar' }))) return;
    try { const r = await api<{ created: number; total: string }>('/goal-bonus/close', 'POST', { period }); done(`Bônus apurado: ${r.created} vendedor(es), total ${brl(r.total)}.`); load(); onChange(); } catch (err) { fail((err as Error).message); }
  }

  return (
    <section className="card" style={{ marginBottom: 16 }} aria-label="Comissão por meta">
      <div className="card-head">
        <h2>Comissão por meta</h2>
        <div className="row">
          <input type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} aria-label="Mês" style={{ maxWidth: 170 }} />
          {manage && <button className="btn" onClick={() => setAdding((v) => !v)}>Faixa de bônus</button>}
          {manage && rep?.closed && <button className="btn primary" onClick={close}>Apurar mês</button>}
        </div>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>{rep?.basis ?? 'Bônus por atingimento da meta mensal de cada vendedor (Gestão → Metas).'}</p>
      {adding && (
        <form onSubmit={addTier} style={{ marginBottom: 12 }}>
          <div className="form-grid">
            <div><label htmlFor="bt-n">Nome *</label><input id="bt-n" name="name" required placeholder="Ex.: Bateu a meta" /></div>
            <div><label htmlFor="bt-m">A partir de (% da meta) *</label><input id="bt-m" name="minPct" inputMode="decimal" required placeholder="100" /></div>
            <div><label htmlFor="bt-k">Tipo</label><select id="bt-k" name="kind" defaultValue="PERCENT"><option value="PERCENT">% sobre o vendido no mês</option><option value="FIXED">Valor fixo (R$)</option></select></div>
            <div><label htmlFor="bt-v">Valor *</label><input id="bt-v" name="value" inputMode="decimal" required placeholder="1" /></div>
          </div>
          <div className="row" style={{ marginTop: 8 }}><button className="btn primary">Salvar faixa</button><button type="button" className="btn" onClick={() => setAdding(false)}>Cancelar</button></div>
        </form>
      )}
      {manage && tiers.length > 0 && (
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          Faixas (vale a maior atingida): {tiers.map((t) => (
            <span key={t.id} className={`badge ${t.active ? '' : 'warn'}`} style={{ marginRight: 6, cursor: 'pointer' }} title="Clique para ligar/desligar" onClick={async () => { try { await api(`/goal-bonus-tiers/${t.id}/active`, 'PUT', { active: !t.active }); load(); } catch (err) { fail((err as Error).message); } }}>
              {t.name}: ≥{Number(t.minPct)}% → {t.kind === 'PERCENT' ? `${Number(t.percent)}%` : brl(t.fixedAmount ?? 0)}{t.active ? '' : ' (off)'}
            </span>
          ))}
        </p>
      )}
      {rep && rep.rows.length === 0 && <p className="muted">Nenhum vendedor com meta em {period}. Defina em Gestão → Metas e cadastre ao menos uma faixa.</p>}
      {rep && rep.rows.length > 0 && (
        <div className="table-wrap"><table>
          <thead><tr><th>Vendedor</th><th className="num">Meta</th><th className="num">Vendido</th><th className="num">Atingido</th><th>Faixa</th><th className="num">Bônus</th><th>Situação</th></tr></thead>
          <tbody>{rep.rows.map((r) => (
            <tr key={r.salespersonId}><td>{r.name}</td><td className="num">{brl(r.goal)}</td><td className="num">{brl(r.achieved)}</td><td className="num">{r.pct.toLocaleString('pt-BR')}%</td>
              <td>{r.tier?.name ?? '—'}</td><td className="num"><strong>{brl(r.bonus)}</strong></td><td><span className={`badge ${r.status === 'PAID' ? 'ok' : r.status === 'EARNED' ? 'brand' : ''}`}>{STATUS[r.status]}</span></td></tr>
          ))}</tbody>
        </table></div>
      )}
    </section>
  );
}
