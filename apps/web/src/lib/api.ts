export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function raw(path: string, method: string, body?: unknown): Promise<Response> {
  return fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-dh-csrf': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Uma única renovação por vez evita que chamadas paralelas (por exemplo, vários
// componentes montando junto com /auth/me) rotacionem o mesmo refresh token.
let refreshInFlight: Promise<boolean> | null = null;
function refreshOnce(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = raw('/auth/refresh', 'POST')
      .then((res) => res.ok)
      .catch(() => false)
      .finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

const noRefreshPaths = new Set([
  '/auth/login', '/auth/register', '/auth/refresh', '/auth/logout',
  '/auth/forgot-password', '/auth/reset-password', '/auth/mfa/verify',
]);

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let res = await raw(path, method, body);
  // Access token expirado: tenta renovar uma vez com o refresh token (cookie httpOnly).
  if (res.status === 401 && !noRefreshPaths.has(path)) {
    if (await refreshOnce()) res = await raw(path, method, body);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = Array.isArray(data?.message) ? data.message.join(' ') : (data?.message ?? 'Não foi possível concluir a operação.');
    if (typeof window !== 'undefined' && !path.startsWith('/auth/')) window.dispatchEvent(new CustomEvent('dh:action-feedback', { detail: { kind: 'error', message: msg } }));
    throw new ApiError(res.status, msg);
  }
  if (typeof window !== 'undefined' && method !== 'GET' && !path.startsWith('/auth/')) {
    window.dispatchEvent(new CustomEvent('dh:action-feedback', { detail: { kind: 'ok', message: 'Ação concluída com sucesso.' } }));
  }
  return data as T;
}

export interface Me {
  user: { id: string; name: string; email: string; phone?: string | null; navStyle?: 'CLASSIC' | 'LAUNCHER'; mfaEnabled?: boolean; avatarVersion?: number | null };
  tenant: { id: string; name: string; slug: string; status: string; plan: string | null; trialEndsAt?: string | null; logoVersion?: number | null } | null;
  role: { key: string; name: string } | null;
  permissions: string[];
  platformAdmin: boolean;
  support?: { sessionId: string; allowWrite: boolean } | null;
  tenants: { id: string; name: string; slug: string; role: { key: string; name: string } }[];
  appName: string;
}
