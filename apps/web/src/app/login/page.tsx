'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { AuthShell } from '@/components/auth-shell';
import { Alert } from '@/components/ui';
import { BRAND } from '@/lib/brand';

type LoginResult = { selectedTenantId: string | null; mfaRequired?: undefined } | { mfaRequired: true; mfaToken: string };

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mfaToken, setMfaToken] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const f = new FormData(e.currentTarget);
    try {
      if (mfaToken) {
        const res = await api<{ selectedTenantId: string | null }>('/auth/mfa/verify', 'POST', { mfaToken, code: f.get('code') });
        router.replace(res.selectedTenantId ? '/inicio' : '/select-tenant');
        return;
      }
      const res = await api<LoginResult>('/auth/login', 'POST', { email: f.get('email'), password: f.get('password') });
      if (res.mfaRequired) { setMfaToken(res.mfaToken); setBusy(false); return; }
      router.replace(res.selectedTenantId ? '/inicio' : '/select-tenant');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <form method="post" className="card auth-card" onSubmit={submit}>
        <h1>{mfaToken ? 'Verificação em duas etapas' : 'Entrar'}</h1>
        <p className="muted" style={{ marginBottom: 20 }}>
          {mfaToken ? 'Digite o código de 6 dígitos do aplicativo autenticador. Sem o celular, use um código de recuperação.' : `Acesse sua conta no ${BRAND.name}.`}
        </p>
        {error && <Alert kind="error">{error}</Alert>}
        {mfaToken ? (
          <div className="field">
            <label htmlFor="code">Código</label>
            <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" autoFocus required maxLength={16} placeholder="000000" />
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor="email">E-mail</label>
              <input id="email" name="email" type="email" autoComplete="username" required />
            </div>
            <div className="field">
              <label htmlFor="password">Senha</label>
              <input id="password" name="password" type="password" autoComplete="current-password" required />
            </div>
          </>
        )}
        <button className={`btn primary ${busy ? 'loading' : ''}`} disabled={busy} style={{ width: '100%' }}>{busy ? 'Entrando…' : mfaToken ? 'Confirmar' : 'Entrar'}</button>
        {mfaToken ? (
          <p className="muted" style={{ marginBottom: 0 }}><a href="/login">Voltar</a></p>
        ) : (
          <p className="muted" style={{ marginBottom: 0 }}><Link href="/esqueci-senha">Esqueci a senha</Link> · Ainda não tem conta? <Link href="/register">Criar empresa</Link></p>
        )}
      </form>
    </AuthShell>
  );
}
