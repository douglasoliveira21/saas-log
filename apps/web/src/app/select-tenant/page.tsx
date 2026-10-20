'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, ApiError, type Me } from '@/lib/api';

export default function SelectTenantPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Me>('/auth/me')
      .then(setMe)
      .catch((e) => e instanceof ApiError && e.status === 401 && router.replace('/login'));
  }, [router]);

  async function choose(tenantId: string) {
    try {
      await api('/auth/select-tenant', 'POST', { tenantId });
      router.replace('/dashboard');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <main className="center-screen">
      <div className="card auth-card">
        <h1>Escolha a empresa</h1>
        <p className="muted">Sua conta tem acesso a mais de uma empresa.</p>
        {error && <div className="alert error" role="alert">{error}</div>}
        {!me && <p className="muted">Carregando…</p>}
        {me?.tenants.length === 0 && <div className="empty">Nenhuma empresa ativa para este usuário.</div>}
        {me?.tenants.map((t) => (
          <button key={t.id} className="btn tenant-pick" onClick={() => choose(t.id)}>
            <span>{t.name}</span>
            <span className="badge">{t.role.name}</span>
          </button>
        ))}
      </div>
    </main>
  );
}
