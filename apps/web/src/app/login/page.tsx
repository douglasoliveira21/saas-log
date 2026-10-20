'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { AuthShell } from '@/components/auth-shell';
import { Alert } from '@/components/ui';
import { BRAND } from '@/lib/brand';

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const f = new FormData(e.currentTarget);
    try {
      const res = await api<{ selectedTenantId: string | null }>('/auth/login', 'POST', {
        email: f.get('email'),
        password: f.get('password'),
      });
      router.replace(res.selectedTenantId ? '/dashboard' : '/select-tenant');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <form className="card auth-card" onSubmit={submit}>
        <h1>Entrar</h1>
        <p className="muted" style={{ marginBottom: 20 }}>Acesse sua conta no {BRAND.name}.</p>
        {error && <Alert kind="error">{error}</Alert>}
        <div className="field">
          <label htmlFor="email">E-mail</label>
          <input id="email" name="email" type="email" autoComplete="username" required />
        </div>
        <div className="field">
          <label htmlFor="password">Senha</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        <button className={`btn primary ${busy ? 'loading' : ''}`} disabled={busy} style={{ width: '100%' }}>{busy ? 'Entrando…' : 'Entrar'}</button>
        <p className="muted" style={{ marginBottom: 0 }}>Ainda não tem conta? <Link href="/register">Criar empresa</Link></p>
      </form>
    </AuthShell>
  );
}
