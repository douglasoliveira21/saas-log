'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

interface Customer { id: string; kind: 'PF' | 'PJ'; name: string; document: string | null; email: string | null; phone: string | null; city: string | null; state: string | null; active: boolean }

export default function ClientesPage() {
  const { can } = useSession();
  const manage = can('customers.manage');
  const [items, setItems] = useState<Customer[] | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => { api<Customer[]>(`/customers${search ? `?search=${encodeURIComponent(search)}` : ''}`).then(setItems).catch((e) => setError(e.message)); }, [search]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(''); setOk('');
    const f = Object.fromEntries([...new FormData(e.currentTarget).entries()].filter(([, v]) => String(v).trim() !== ''));
    try { await api('/customers', 'POST', f); setOk('Cliente cadastrado.'); setAdding(false); load(); } catch (err) { setError((err as Error).message); }
  }
  async function toggle(c: Customer) {
    try { await api(`/customers/${c.id}`, 'PATCH', { active: !c.active }); load(); } catch (err) { setError((err as Error).message); }
  }

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div><h1>Clientes</h1><p className="muted">Pessoas físicas e jurídicas. Dados pessoais ficam restritos às permissões do módulo.</p></div>
        {manage && <button className="btn primary" onClick={() => setAdding(true)}>+ Cliente</button>}
      </div>
      {error && <div className="alert error" role="alert">{error}</div>}
      {ok && <div className="alert ok" role="status">{ok}</div>}
      {adding && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={create}>
          <h2>Novo cliente</h2>
          <div className="form-grid">
            <div><label htmlFor="kind">Tipo *</label><select id="kind" name="kind" defaultValue="PJ"><option value="PJ">Pessoa jurídica</option><option value="PF">Pessoa física</option></select></div>
            <div><label htmlFor="name">Nome / razão social *</label><input id="name" name="name" required /></div>
            <div><label htmlFor="document">CPF/CNPJ</label><input id="document" name="document" /></div>
            <div><label htmlFor="stateRegistration">Inscrição estadual</label><input id="stateRegistration" name="stateRegistration" /></div>
            <div><label htmlFor="email">E-mail</label><input id="email" name="email" type="email" /></div>
            <div><label htmlFor="phone">Telefone</label><input id="phone" name="phone" /></div>
            <div><label htmlFor="zipCode">CEP</label><input id="zipCode" name="zipCode" /></div>
            <div><label htmlFor="city">Município</label><input id="city" name="city" /></div>
            <div><label htmlFor="state">UF</label><input id="state" name="state" maxLength={2} /></div>
          </div>
          <div className="row" style={{ marginTop: 12 }}><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={() => setAdding(false)}>Cancelar</button></div>
        </form>
      )}
      <section className="card">
        <input aria-label="Buscar clientes" placeholder="Buscar por nome ou documento" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 340, marginBottom: 12 }} />
        <div className="table-wrap">
          <table>
            <thead><tr><th>Nome</th><th>Tipo</th><th>Documento</th><th>Contato</th><th>Local</th><th /></tr></thead>
            <tbody>
              {!items && !error && <tr><td colSpan={6} className="muted">Carregando…</td></tr>}
              {items?.length === 0 && <tr><td colSpan={6} className="empty">Nenhum cliente encontrado.</td></tr>}
              {items?.map((c) => (
                <tr key={c.id} style={c.active ? undefined : { opacity: 0.55 }}>
                  <td>{c.name}</td><td>{c.kind}</td><td>{c.document ?? '—'}</td><td>{[c.email, c.phone].filter(Boolean).join(' · ') || '—'}</td>
                  <td>{[c.city, c.state].filter(Boolean).join('/') || '—'}</td>
                  <td>{manage && <button className="btn sm" onClick={() => toggle(c)}>{c.active ? 'Inativar' : 'Reativar'}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
