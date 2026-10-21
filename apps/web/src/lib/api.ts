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

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let res = await raw(path, method, body);
  // Access token expirado: tenta renovar uma vez com o refresh token (cookie httpOnly).
  if (res.status === 401 && !path.startsWith('/auth/')) {
    const refreshed = await raw('/auth/refresh', 'POST');
    if (refreshed.ok) res = await raw(path, method, body);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = Array.isArray(data?.message) ? data.message.join(' ') : (data?.message ?? 'Não foi possível concluir a operação.');
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export interface Me {
  user: { id: string; name: string; email: string };
  tenant: { id: string; name: string; slug: string; status: string; plan: string | null; trialEndsAt?: string | null; logoVersion?: number | null } | null;
  role: { key: string; name: string } | null;
  permissions: string[];
  platformAdmin: boolean;
  tenants: { id: string; name: string; slug: string; role: { key: string; name: string } }[];
  appName: string;
}
