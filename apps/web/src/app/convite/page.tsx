'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { AuthShell } from '@/components/auth-shell';
import { Alert } from '@/components/ui';
import { PasswordInput } from '@/components/password-input';

interface Info { email: string; name: string; company: string; existingUser: boolean }

export default function InvitePage() {
  const [token, setToken] = useState('');
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('token') ?? '';
    setToken(t);
    if (!t) { setError('Link de convite incompleto.'); return; }
    api<Info>('/auth/invite/preview', 'POST', { token: t }).then(setInfo).catch((e) => setError((e as Error).message));
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (!info?.existingUser && f.get('password') !== f.get('confirm')) return setError('As senhas não conferem.');
    setBusy(true); setError('');
    try { await api('/auth/invite/accept', 'POST', { token, password: f.get('password'), name: f.get('name') || undefined }); setDone(true); } catch (err) { setError((err as Error).message); }
    setBusy(false);
  }

  return (
    <AuthShell>
      <form method="post" className="card auth-card" onSubmit={submit}>
        <h1>Convite</h1>
        {error && <Alert kind="error">{error}</Alert>}
        {done ? (
          <><Alert kind="ok">Convite aceito. Agora você já pode entrar.</Alert><Link className="btn primary" href="/login" style={{ width: '100%' }}>Entrar</Link></>
        ) : info ? (
          <>
            <p className="muted" style={{ marginBottom: 20 }}>Você foi convidado(a) para a empresa <strong>{info.company}</strong> com o e-mail <strong>{info.email}</strong>.</p>
            {info.existingUser ? (
              <>
                <p className="muted">Este e-mail já tem conta. Digite a sua senha atual para aceitar.</p>
                <div className="field"><label htmlFor="password">Senha atual</label><PasswordInput id="password" name="password"  autoComplete="current-password" required /></div>
              </>
            ) : (
              <>
                <div className="field"><label htmlFor="name">Seu nome</label><input id="name" name="name" defaultValue={info.name} required minLength={2} /></div>
                <div className="field"><label htmlFor="password">Crie uma senha</label><PasswordInput id="password" name="password"  autoComplete="new-password" required minLength={8} /></div>
                <div className="field"><label htmlFor="confirm">Repita a senha</label><PasswordInput id="confirm" name="confirm"  autoComplete="new-password" required minLength={8} /></div>
              </>
            )}
            <button className={`btn primary ${busy ? 'loading' : ''}`} disabled={busy} style={{ width: '100%' }}>{busy ? 'Aceitando…' : 'Aceitar convite'}</button>
          </>
        ) : !error ? <p className="muted">Verificando o convite…</p> : null}
      </form>
    </AuthShell>
  );
}
