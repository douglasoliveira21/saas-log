'use client';

import { Plus } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { brl } from '@/lib/format';
import { useUi, PageHeader, Alert } from '@/components/ui';
import { useSession } from '@/lib/session';
import { GoalBonusCard } from './bonus-card';

interface Salesperson { id: string; name: string; email: string | null; active: boolean; userId: string | null }
interface Rule { id: string; name: string; kind: 'PERCENT' | 'FIXED_PER_UNIT'; percent: string | null; fixedAmount: string | null; priority: number; salespersonId: string | null; categoryId: string | null; productId: string | null; customerId: string | null; channel: string | null; active: boolean }
interface Entry { id: string; kind: string; status: string; amount: string; note: string | null; createdAt: string; order: { number: number }; salesperson: { name: string } }
interface Summary { name: string; FORECAST: string; EARNED: string; PAID: string }
interface Member { user: { id: string; name: string; email: string } }

const STATUS: Record<string, string> = { FORECAST: 'Prevista', EARNED: 'Aprovada', PAID: 'Paga' };

export default function ComissoesPage() {
  const { can } = useSession();
  const ui = useUi();
  const manage = can('commissions.manage');
  const [people, setPeople] = useState<Salesperson[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [summary, setSummary] = useState<Record<string, Summary>>({});
  const [entries, setEntries] = useState<Entry[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [panel, setPanel] = useState<'person' | 'rule' | null>(null);

  const load = useCallback(() => {
    api<Salesperson[]>('/salespeople').then(setPeople).catch((e) => setError(e.message));
    api<{ summary: Record<string, Summary>; entries: Entry[] }>('/commissions').then((r) => { setSummary(r.summary); setEntries(r.entries); }).catch(() => undefined);
    if (manage) api<Rule[]>('/commission-rules').then(setRules).catch(() => undefined);
  }, [manage]);
  useEffect(load, [load]);
  useEffect(() => { if (manage && can('users.view')) api<Member[]>('/users').then(setMembers).catch(() => undefined); }, [manage, can]);

  const clean = (f: FormData) => Object.fromEntries([...f.entries()].filter(([, v]) => String(v).trim() !== ''));

  async function createPerson(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(''); setOk('');
    try { await api('/salespeople', 'POST', clean(new FormData(e.currentTarget))); setOk('Vendedor cadastrado.'); setPanel(null); load(); } catch (err) { setError((err as Error).message); }
  }
  async function createRule(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(''); setOk('');
    const f = clean(new FormData(e.currentTarget)) as Record<string, unknown>;
    for (const k of ['percent', 'fixedAmount', 'priority']) if (f[k] !== undefined) f[k] = Number(String(f[k]).replace(',', '.'));
    try { await api('/commission-rules', 'POST', f); setOk('Regra criada.'); setPanel(null); load(); } catch (err) { setError((err as Error).message); }
  }
  async function toggleRule(r: Rule) {
    try { await api(`/commission-rules/${r.id}/active`, 'PUT', { active: !r.active }); load(); } catch (err) { setError((err as Error).message); }
  }
  async function pay(id: string, name: string) {
    if (!(await ui.confirm({ title: 'Marcar comissão como paga?', message: `Toda a comissão aprovada de ${name} será marcada como paga. Para gerar uma conta a pagar no Financeiro, use o repasse.`, confirmLabel: 'Marcar como paga' }))) return;
    setError(''); setOk('');
    try { const r = await api<{ paid: string }>('/commissions/pay', 'POST', { salespersonId: id }); setOk(`Pago: ${brl(r.paid)}.`); load(); } catch (err) { setError((err as Error).message); }
  }
  const scope = (r: Rule) => [r.salespersonId && 'vendedor', r.categoryId && 'categoria', r.productId && 'produto', r.customerId && 'cliente', r.channel && `canal ${r.channel}`].filter(Boolean).join(' + ') || 'geral';

  return (
    <>
      <PageHeader title="Vendedores e comissões" description={<>Uma única regra por item (maior prioridade; empate → mais específica). Cancelamentos e devoluções entram como estornos; nada é apagado.</>} actions={<>
          {manage && <div className="row"><button className="btn" onClick={() => setPanel('person')}><Plus aria-hidden />Vendedor</button><button className="btn primary" onClick={() => setPanel('rule')}><Plus aria-hidden />Regra</button></div>}
        </>} />
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}
      <GoalBonusCard manage={manage} onChange={load} fail={setError} done={setOk} />

      {panel === 'person' && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={createPerson}>
          <h2>Novo vendedor</h2>
          <div className="form-grid">
            <div><label htmlFor="n">Nome *</label><input id="n" name="name" required /></div>
            <div><label htmlFor="e">E-mail</label><input id="e" name="email" type="email" /></div>
            <div><label htmlFor="u">Usuário do sistema (para ver só os próprios pedidos)</label>
              <select id="u" name="userId" defaultValue=""><option value="">Sem vínculo</option>{members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.name} — {m.user.email}</option>)}</select></div>
            <div><label htmlFor="emp">Vínculo</label><select id="emp" name="employment" defaultValue="EMPLOYEE"><option value="EMPLOYEE">Funcionário</option><option value="REPRESENTATIVE">Representante</option></select></div>
          </div>
          <div className="row" style={{ marginTop: 12 }}><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={() => setPanel(null)}>Cancelar</button></div>
        </form>
      )}
      {panel === 'rule' && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={createRule}>
          <h2>Nova regra de comissão</h2>
          <div className="form-grid">
            <div><label htmlFor="rn">Nome *</label><input id="rn" name="name" required /></div>
            <div><label htmlFor="k">Tipo *</label><select id="k" name="kind" defaultValue="PERCENT"><option value="PERCENT">Percentual sobre a venda líquida</option><option value="FIXED_PER_UNIT">Valor fixo por unidade</option></select></div>
            <div><label htmlFor="p">Percentual (%)</label><input id="p" name="percent" inputMode="decimal" /></div>
            <div><label htmlFor="fx">Valor por unidade (R$)</label><input id="fx" name="fixedAmount" inputMode="decimal" /></div>
            <div><label htmlFor="pr">Prioridade (maior vence)</label><input id="pr" name="priority" inputMode="numeric" defaultValue="0" /></div>
            <div><label htmlFor="sp">Só para o vendedor</label><select id="sp" name="salespersonId" defaultValue=""><option value="">Todos</option>{people.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
            <div><label htmlFor="ch">Só para o canal</label><select id="ch" name="channel" defaultValue=""><option value="">Todos</option>{['DIRECT', 'PHONE', 'WHATSAPP', 'EMAIL', 'STORE', 'WEB', 'REPRESENTATIVE'].map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
            <div><label htmlFor="vf">Válida a partir de</label><input id="vf" name="validFrom" type="date" /></div>
            <div><label htmlFor="vt">Válida até</label><input id="vt" name="validTo" type="date" /></div>
          </div>
          <p className="muted">Critérios por categoria, produto e cliente já são aceitos pela API (IDs); o seletor visual chega com a edição completa do catálogo. Faixas progressivas por meta e comissão por margem ainda não existem.</p>
          <div className="row"><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={() => setPanel(null)}>Cancelar</button></div>
        </form>
      )}

      <section className="card" style={{ marginBottom: 16 }}>
        <h2>Resumo por vendedor</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Vendedor</th><th>Prevista</th><th>Aprovada</th><th>Paga</th><th /></tr></thead>
          <tbody>
            {Object.keys(summary).length === 0 && <tr><td colSpan={5} className="empty">Ainda não há comissões. Elas surgem quando pedidos de vendedores com regra aplicável são confirmados.</td></tr>}
            {Object.entries(summary).map(([id, s]) => <tr key={id}><td>{s.name}</td><td className="num">{brl(s.FORECAST)}</td><td className="num">{brl(s.EARNED)}</td><td className="num">{brl(s.PAID)}</td><td>{manage && <button className="btn sm" onClick={() => pay(id, s.name)}>Pagar aprovadas</button>}</td></tr>)}
          </tbody>
        </table></div>
      </section>

      {manage && (
        <section className="card" style={{ marginBottom: 16 }}>
          <h2>Regras</h2>
          <div className="table-wrap"><table>
            <thead><tr><th>Regra</th><th>Valor</th><th>Prioridade</th><th>Escopo</th><th /></tr></thead>
            <tbody>
              {rules.length === 0 && <tr><td colSpan={5} className="empty">Nenhuma regra. Sem regra aplicável, o pedido não gera comissão.</td></tr>}
              {rules.map((r) => <tr key={r.id} style={r.active ? undefined : { opacity: 0.55 }}><td>{r.name}</td><td>{r.kind === 'PERCENT' ? `${Number(r.percent)}%` : `${brl(r.fixedAmount)}/un`}</td><td>{r.priority}</td><td className="muted">{scope(r)}</td><td><button className="btn sm" onClick={() => toggleRule(r)}>{r.active ? 'Desativar' : 'Ativar'}</button></td></tr>)}
            </tbody>
          </table></div>
        </section>
      )}

      <section className="card" style={{ marginBottom: 16 }}>
        <h2>Vendedores</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Nome</th><th>E-mail</th><th>Usuário vinculado</th><th>Situação</th></tr></thead>
          <tbody>
            {people.length === 0 && <tr><td colSpan={4} className="empty">Nenhum vendedor cadastrado.</td></tr>}
            {people.map((s) => <tr key={s.id}><td>{s.name}</td><td>{s.email ?? '—'}</td><td>{s.userId ? 'sim' : 'não'}</td><td><span className={`badge ${s.active ? 'ok' : 'warn'}`}>{s.active ? 'Ativo' : 'Inativo'}</span></td></tr>)}
          </tbody>
        </table></div>
      </section>

      <section className="card">
        <h2>Lançamentos recentes</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Quando</th><th>Pedido</th><th>Vendedor</th><th>Tipo</th><th>Situação</th><th>Valor</th></tr></thead>
          <tbody>
            {entries.length === 0 && <tr><td colSpan={6} className="empty">Sem lançamentos.</td></tr>}
            {entries.map((e) => <tr key={e.id}><td>{new Date(e.createdAt).toLocaleString('pt-BR')}</td><td>{e.order.number}</td><td>{e.salesperson.name}</td><td>{e.kind === 'ACCRUAL' ? 'Comissão' : `Estorno${e.note ? ` (${e.note})` : ''}`}</td><td><span className="badge">{STATUS[e.status]}</span></td><td className="num">{brl(e.amount)}</td></tr>)}
          </tbody>
        </table></div>
      </section>
    </>
  );
}
