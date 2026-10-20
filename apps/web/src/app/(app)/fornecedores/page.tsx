'use client';

import { Plus } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { PageHeader, Alert, Skeleton } from '@/components/ui';
import { useSession } from '@/lib/session';

interface Supplier { id: string; legalName: string; tradeName: string | null; document: string | null; email: string | null; phone: string | null; paymentTerms: string | null; leadTimeDays: number | null; active: boolean }

export default function FornecedoresPage() {
  const { can } = useSession();
  const manage = can('suppliers.manage');
  const [items, setItems] = useState<Supplier[] | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => { api<Supplier[]>('/suppliers').then(setItems).catch((e) => setError(e.message)); }, []);
  useEffect(load, [load]);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(''); setOk('');
    const f = Object.fromEntries([...new FormData(e.currentTarget).entries()].filter(([, v]) => String(v).trim() !== ''));
    if (f.leadTimeDays) f.leadTimeDays = Number(f.leadTimeDays) as never;
    try { await api('/suppliers', 'POST', f); setOk('Fornecedor cadastrado.'); setAdding(false); load(); } catch (err) { setError((err as Error).message); }
  }

  async function toggle(s: Supplier) {
    try { await api(`/suppliers/${s.id}`, 'PATCH', { active: !s.active }); load(); } catch (err) { setError((err as Error).message); }
  }

  return (
    <>
      <PageHeader title="Fornecedores" description={<>Cadastro de fornecedores usados em compras, notas fiscais e contas a pagar.</>} actions={<>
          {manage && <button className="btn primary" onClick={() => setAdding(true)}><Plus aria-hidden />Fornecedor</button>}
        </>} />
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}
      {adding && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={create}>
          <h2>Novo fornecedor</h2>
          <div className="form-grid">
            <div><label htmlFor="legalName">Razão social *</label><input id="legalName" name="legalName" required /></div>
            <div><label htmlFor="tradeName">Nome fantasia</label><input id="tradeName" name="tradeName" /></div>
            <div><label htmlFor="document">CNPJ/CPF</label><input id="document" name="document" /></div>
            <div><label htmlFor="stateRegistration">Inscrição estadual</label><input id="stateRegistration" name="stateRegistration" /></div>
            <div><label htmlFor="email">E-mail</label><input id="email" name="email" type="email" /></div>
            <div><label htmlFor="phone">Telefone</label><input id="phone" name="phone" /></div>
            <div><label htmlFor="paymentTerms">Condições de pagamento</label><input id="paymentTerms" name="paymentTerms" placeholder="30/60/90 dias" /></div>
            <div><label htmlFor="leadTimeDays">Prazo de entrega (dias)</label><input id="leadTimeDays" name="leadTimeDays" inputMode="numeric" /></div>
          </div>
          <div className="row" style={{ marginTop: 12 }}><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={() => setAdding(false)}>Cancelar</button></div>
        </form>
      )}
      <section className="card">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Fornecedor</th><th>Documento</th><th>Contato</th><th>Pagamento</th><th>Prazo</th><th /></tr></thead>
            <tbody>
              {!items && !error && <tr><td colSpan={6}><Skeleton rows={3} /></td></tr>}
              {items?.length === 0 && <tr><td colSpan={6} className="empty">Nenhum fornecedor cadastrado.</td></tr>}
              {items?.map((s) => (
                <tr key={s.id} style={s.active ? undefined : { opacity: 0.55 }}>
                  <td>{s.legalName}{s.tradeName && <span className="muted"> · {s.tradeName}</span>}</td><td>{s.document ?? '—'}</td>
                  <td>{[s.email, s.phone].filter(Boolean).join(' · ') || '—'}</td><td>{s.paymentTerms ?? '—'}</td><td>{s.leadTimeDays != null ? `${s.leadTimeDays} d` : '—'}</td>
                  <td>{manage && <button className="btn sm" onClick={() => toggle(s)}>{s.active ? 'Inativar' : 'Reativar'}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
