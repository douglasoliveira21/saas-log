'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { AuthShell } from '@/components/auth-shell';
import { Alert } from '@/components/ui';
import { BRAND } from '@/lib/brand';

export default function RegisterPage() {
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get('password') !== f.get('confirm')) return setError('As senhas não conferem.');
    setBusy(true);
    setError('');
    try {
      await api('/auth/register', 'POST', {
        companyName: f.get('companyName'),
        name: f.get('name'),
        email: f.get('email'),
        password: f.get('password'),
      });
      router.replace('/dashboard');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <form className="card auth-card" onSubmit={submit}>
        <h1>Criar conta no {BRAND.name}</h1>
        <p className="muted">14 dias de avaliação. Você será o proprietário da empresa.</p>
        {error && <Alert kind="error">{error}</Alert>}
        <div className="field"><label htmlFor="companyName">Nome da empresa</label><input id="companyName" name="companyName" required minLength={2} /></div>
        <div className="field"><label htmlFor="name">Seu nome</label><input id="name" name="name" required minLength={2} /></div>
        <div className="field"><label htmlFor="email">E-mail</label><input id="email" name="email" type="email" autoComplete="username" required /></div>
        <div className="field"><label htmlFor="password">Senha (mín. 10 caracteres, letras e números)</label><input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} /></div>
        <div className="field"><label htmlFor="confirm">Confirmar senha</label><input id="confirm" name="confirm" type="password" autoComplete="new-password" required /></div>
        <button className={`btn primary ${busy ? 'loading' : ''}`} disabled={busy} style={{ width: '100%' }}>{busy ? 'Criando…' : 'Criar conta'}</button>
        <p className="muted" style={{ marginBottom: 0 }}>Já tem conta? <Link href="/login">Entrar</Link></p>
      </form>
    </AuthShell>
  );
}
