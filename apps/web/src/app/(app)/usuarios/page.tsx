'use client';

import { Plus } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { PageHeader, Alert, Skeleton } from '@/components/ui';
import { Avatar } from '@/components/avatar';
import { useSession } from '@/lib/session';

interface Member { id: string; status: string; role: { id: string; key: string; name: string }; user: { id: string; name: string; email: string; lastLoginAt: string | null } }
interface Invite { id: string; name: string; email: string; role: string; expiresAt: string; expired: boolean }
interface Role { id: string; key: string; name: string; isSystem: boolean; permissions: string[] }

export default function UsuariosPage() {
  const { can } = useSession();
  const manage = can('users.manage');
  const [members, setMembers] = useState<Member[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [adding, setAdding] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [invites, setInvites] = useState<Invite[]>([]);

  const load = useCallback(() => {
    Promise.all([api<Member[]>('/users'), api<Role[]>('/roles')])
      .then(([m, r]) => { setMembers(m); setRoles(r); })
      .catch((e) => setError(e.message));
    api<Invite[]>('/users/invites').then(setInvites).catch(() => setInvites([]));
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

  async function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(''); setOk('');
    const f = new FormData(e.currentTarget);
    try {
      const r = await api<{ emailSent: boolean; reason?: string; link?: string }>('/users/invites', 'POST', { name: f.get('name'), email: f.get('email'), roleId: f.get('roleId') });
      setOk(r.emailSent ? 'Convite enviado por e-mail. O link vale por 7 dias.' : `O e-mail não pôde ser enviado (${r.reason}). Repasse este link por outro meio: ${r.link}`);
      setInviting(false);
      load();
    } catch (err) { setError((err as Error).message); }
  }

  async function patch(id: string, body: object) {
    setError(''); setOk('');
    try { await api(`/users/${id}`, 'PATCH', body); load(); } catch (err) { setError((err as Error).message); }
  }

  return (
    <>
      <PageHeader title="Usuários e papéis" description={<>Permissões são verificadas no servidor a cada requisição.</>} actions={<>
          {manage && <button className="btn primary" onClick={() => { setInviting(true); setAdding(false); }}><Plus aria-hidden />Convidar por e-mail</button>}
          {manage && <button className="btn" onClick={() => { setAdding(true); setInviting(false); }}>Adicionar com senha provisória</button>}
        </>} />
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}

      {inviting && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={invite}>
          <h2>Convidar por e-mail</h2>
          <div className="form-grid">
            <div><label htmlFor="in">Nome *</label><input id="in" name="name" required minLength={2} /></div>
            <div><label htmlFor="ie">E-mail *</label><input id="ie" name="email" type="email" required /></div>
            <div><label htmlFor="ir">Papel *</label><select id="ir" name="roleId" required>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div>
          </div>
          <p className="muted">A pessoa recebe um link (vale 7 dias, uso único) e escolhe a própria senha. Se o e-mail já tiver conta, ela só confirma a senha atual.</p>
          <div className="row"><button className="btn primary">Enviar convite</button><button type="button" className="btn" onClick={() => setInviting(false)}>Cancelar</button></div>
        </form>
      )}

      {adding && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={add}>
          <h2>Novo usuário</h2>
          <div className="form-grid">
            <div><label htmlFor="n">Nome *</label><input id="n" name="name" required /></div>
            <div><label htmlFor="e">E-mail *</label><input id="e" name="email" type="email" required /></div>
            <div><label htmlFor="p">Senha provisória *</label><input id="p" name="password" type="password" minLength={10} required autoComplete="new-password" /></div>
            <div><label htmlFor="r">Papel *</label><select id="r" name="roleId" required>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div>
          </div>
          <p className="muted">Se o e-mail já tiver conta, ela apenas será vinculada a esta empresa (a senha existente é mantida).</p>
          <div className="row"><button className="btn primary">Adicionar</button><button type="button" className="btn" onClick={() => setAdding(false)}>Cancelar</button></div>
        </form>
      )}

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Situação</th><th /></tr></thead>
            <tbody>
              {!members && <tr><td colSpan={5}><Skeleton rows={3} /></td></tr>}
              {members?.map((m) => (
                <tr key={m.id}>
                  <td><span className="row" style={{ gap: 8 }}><Avatar name={m.user.name} userId={m.user.id} size={26} />{m.user.name}</span></td><td>{m.user.email}</td>
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

      {manage && invites.length > 0 && (
        <section className="card" style={{ marginBottom: 16 }}>
          <h2>Convites pendentes</h2>
          <div className="table-wrap"><table>
            <thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Validade</th><th /></tr></thead>
            <tbody>{invites.map((i) => (
              <tr key={i.id}><td>{i.name}</td><td>{i.email}</td><td>{i.role}</td>
                <td><span className={`badge ${i.expired ? 'warn' : ''}`}>{i.expired ? 'Expirado' : `até ${new Date(i.expiresAt).toLocaleDateString('pt-BR')}`}</span></td>
                <td><button className="btn sm" onClick={async () => { try { await api(`/users/invites/${i.id}`, 'DELETE'); load(); } catch (err) { setError((err as Error).message); } }}>Cancelar convite</button></td></tr>
            ))}</tbody>
          </table></div>
        </section>
      )}

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
