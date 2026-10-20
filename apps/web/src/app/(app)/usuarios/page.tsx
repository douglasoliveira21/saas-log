'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

interface Member { id: string; status: string; role: { id: string; key: string; name: string }; user: { name: string; email: string; lastLoginAt: string | null } }
interface Role { id: string; key: string; name: string; isSystem: boolean; permissions: string[] }

export default function UsuariosPage() {
  const { can } = useSession();
  const manage = can('users.manage');
  const [members, setMembers] = useState<Member[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    Promise.all([api<Member[]>('/users'), api<Role[]>('/roles')])
      .then(([m, r]) => { setMembers(m); setRoles(r); })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(''); setOk('');
    const f = new FormData(e.currentTarget);
    try {
      await api('/users', 'POST', { name: f.get('name'), email: f.get('email'), password: f.get('password'), roleId: f.get('roleId') });
      setOk('Usuário adicionado. Informe a senha provisória a ele por um canal seguro.');
      setAdding(false);
      load();
    } catch (err) { setError((err as Error).message); }
  }

  async function patch(id: string, body: object) {
    setError(''); setOk('');
    try { await api(`/users/${id}`, 'PATCH', body); load(); } catch (err) { setError((err as Error).message); }
  }

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div><h1>Usuários e papéis</h1><p className="muted">Permissões são verificadas no servidor a cada requisição.</p></div>
        {manage && <button className="btn primary" onClick={() => setAdding(true)}>+ Adicionar usuário</button>}
      </div>
      {error && <div className="alert error" role="alert">{error}</div>}
      {ok && <div className="alert ok" role="status">{ok}</div>}

      {adding && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={add}>
          <h2>Novo usuário</h2>
          <div className="form-grid">
            <div><label htmlFor="n">Nome *</label><input id="n" name="name" required /></div>
            <div><label htmlFor="e">E-mail *</label><input id="e" name="email" type="email" required /></div>
            <div><label htmlFor="p">Senha provisória *</label><input id="p" name="password" type="password" minLength={10} required autoComplete="new-password" /></div>
            <div><label htmlFor="r">Papel *</label><select id="r" name="roleId" required>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div>
          </div>
          <p className="muted">Se o e-mail já tiver conta, ela apenas será vinculada a esta empresa (a senha existente é mantida). Convite por e-mail: Fase 8.</p>
          <div className="row"><button className="btn primary">Adicionar</button><button type="button" className="btn" onClick={() => setAdding(false)}>Cancelar</button></div>
        </form>
      )}

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Situação</th><th /></tr></thead>
            <tbody>
              {!members && <tr><td colSpan={5} className="muted">Carregando…</td></tr>}
              {members?.map((m) => (
                <tr key={m.id}>
                  <td>{m.user.name}</td><td>{m.user.email}</td>
                  <td>
                    {manage ? (
                      <select aria-label={`Papel de ${m.user.name}`} value={m.role.id} onChange={(e) => patch(m.id, { roleId: e.target.value })}>
                        {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    ) : m.role.name}
                  </td>
                  <td><span className={`badge ${m.status === 'ACTIVE' ? 'ok' : 'warn'}`}>{m.status === 'ACTIVE' ? 'Ativo' : 'Suspenso'}</span></td>
                  <td>{manage && <button className="btn sm" onClick={() => patch(m.id, { status: m.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE' })}>{m.status === 'ACTIVE' ? 'Suspender' : 'Reativar'}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Papéis</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Papel</th><th>Tipo</th><th>Permissões</th></tr></thead>
            <tbody>
              {roles.map((r) => (
                <tr key={r.id}><td>{r.name}</td><td>{r.isSystem ? 'Sistema' : 'Personalizado'}</td><td className="muted">{r.permissions.join(', ') || '—'}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>Criação de papéis personalizados já disponível na API (<code>POST /api/roles</code>); a tela de edição chega nas próximas fases.</p>
      </section>
    </>
  );
}
