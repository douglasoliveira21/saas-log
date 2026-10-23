'use client';

import { KeyRound, Lock, Mail } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { AuthShell } from '@/components/auth-shell';
import { PasswordInput } from '@/components/password-input';
import { Alert } from '@/components/ui';

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
        <div className="auth-head">
          <span className="auth-badge" aria-hidden>{mfaToken ? <KeyRound /> : <Lock />}</span>
          <h1>{mfaToken ? 'Verificação em duas etapas' : 'Acesse sua conta'}</h1>
          <p className="muted">{mfaToken ? 'Digite o código de 6 dígitos do aplicativo autenticador. Sem o celular, use um código de recuperação.' : 'Entre com o e-mail e a senha cadastrados.'}</p>
        </div>
        {error && <Alert kind="error">{error}</Alert>}
        {mfaToken ? (
          <div className="field">
            <label htmlFor="code">Código de verificação</label>
            <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" autoFocus required maxLength={16} placeholder="000000" className="otp" />
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor="email">E-mail</label>
              <span className="icon-field"><Mail aria-hidden /><input id="email" name="email" type="email" autoComplete="username" required placeholder="voce@empresa.com.br" autoFocus /></span>
            </div>
            <div className="field">
              <div className="field-row"><label htmlFor="password">Senha</label><Link href="/esqueci-senha" className="forgot">Esqueci a senha</Link></div>
              <PasswordInput id="password" name="password" autoComplete="current-password" required placeholder="Sua senha" />
            </div>
          </>
        )}
        <button className={`btn primary lg ${busy ? 'loading' : ''}`} disabled={busy} style={{ width: '100%' }}>{busy ? 'Entrando…' : mfaToken ? 'Confirmar' : 'Entrar'}</button>
        {mfaToken && <p className="muted" style={{ marginBottom: 0, textAlign: 'center' }}><a href="/login">Voltar</a></p>}
        {!mfaToken && <p className="auth-terms">Ao entrar, você concorda com os <Link href="/termos">Termos de uso</Link> e a <Link href="/privacidade">Política de privacidade</Link>.</p>}
      </form>
    </AuthShell>
  );
}
