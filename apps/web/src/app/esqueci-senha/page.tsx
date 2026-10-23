'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { AuthShell } from '@/components/auth-shell';
import { Alert } from '@/components/ui';

export default function ForgotPage() {
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api<{ message: string }>('/auth/forgot-password', 'POST', { email: new FormData(e.currentTarget).get('email') });
      setDone(r.message);
    } catch (err) { setError((err as Error).message); }
    setBusy(false);
  }

  return (
    <AuthShell>
      <form className="card auth-card" onSubmit={submit}>
        <h1>Esqueci a senha</h1>
        <p className="muted" style={{ marginBottom: 20 }}>Informe o e-mail da sua conta. Enviaremos um link para criar uma nova senha (vale 1 hora).</p>
        {error && <Alert kind="error">{error}</Alert>}
        {done && <Alert kind="ok">{done}</Alert>}
        {!done && (
          <>
            <div className="field"><label htmlFor="email">E-mail</label><input id="email" name="email" type="email" autoComplete="username" required /></div>
            <button className={`btn primary ${busy ? 'loading' : ''}`} disabled={busy} style={{ width: '100%' }}>{busy ? 'Enviando…' : 'Enviar link'}</button>
          </>
        )}
        <p className="muted" style={{ marginBottom: 0 }}><Link href="/login">Voltar para entrar</Link></p>
      </form>
    </AuthShell>
  );
}
