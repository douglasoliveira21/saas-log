'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { AuthShell } from '@/components/auth-shell';
import { Alert } from '@/components/ui';

export default function ResetPage() {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setToken(new URLSearchParams(window.location.search).get('token') ?? ''); }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get('password') !== f.get('confirm')) return setError('As senhas não conferem.');
    setBusy(true); setError('');
    try { await api('/auth/reset-password', 'POST', { token, password: f.get('password') }); setDone(true); } catch (err) { setError((err as Error).message); }
    setBusy(false);
  }

  return (
    <AuthShell>
      <form className="card auth-card" onSubmit={submit}>
        <h1>Nova senha</h1>
        {error && <Alert kind="error">{error}</Alert>}
        {done ? (
          <><Alert kind="ok">Senha alterada. Todas as sessões abertas foram encerradas.</Alert><Link className="btn primary" href="/login" style={{ width: '100%' }}>Entrar</Link></>
        ) : !token ? (
          <><Alert kind="error">Link incompleto. Peça um novo em “Esqueci a senha”.</Alert><Link href="/esqueci-senha">Pedir novo link</Link></>
        ) : (
          <>
            <p className="muted" style={{ marginBottom: 20 }}>Escolha uma senha forte, com letras e números.</p>
            <div className="field"><label htmlFor="password">Nova senha</label><input id="password" name="password" type="password" autoComplete="new-password" required minLength={8} /></div>
            <div className="field"><label htmlFor="confirm">Repita a senha</label><input id="confirm" name="confirm" type="password" autoComplete="new-password" required minLength={8} /></div>
            <button className={`btn primary ${busy ? 'loading' : ''}`} disabled={busy} style={{ width: '100%' }}>{busy ? 'Salvando…' : 'Salvar nova senha'}</button>
          </>
        )}
      </form>
    </AuthShell>
  );
}
