'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, type Me } from './api';

interface SessionValue {
  me: Me;
  can: (permission?: string) => boolean;
  reload: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession fora do SessionProvider');
  return v;
}

/** Carrega /auth/me; sem sessão → /login; sem tenant escolhido → /select-tenant. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<Me>('/auth/me');
      if (!data.tenant) {
        router.replace('/select-tenant');
        return;
      }
      setMe(data);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.replace('/login');
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  const logout = useCallback(async () => {
    await api('/auth/logout', 'POST').catch(() => undefined);
    router.replace('/login');
  }, [router]);

  if (!me) return <div className="center-screen muted">Carregando…</div>;
  const perms = new Set(me.permissions);
  return <Ctx.Provider value={{ me, can: (p) => !p || (p === 'platform.admin' ? me.platformAdmin : perms.has(p)), reload: load, logout }}>{children}</Ctx.Provider>;
}
