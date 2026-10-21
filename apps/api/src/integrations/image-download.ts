import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { MAX_IMAGE_BYTES } from '../catalog/product-images.service';

/** IPs que nunca devem ser alvo de uma busca feita pelo servidor (rede interna, loopback, link-local, metadados de nuvem). */
export function isPrivateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

/**
 * Baixa uma foto de um anúncio do canal com defesa contra SSRF: só HTTPS, só domínios que o conector declara (imageHosts),
 * sem seguir redirecionamentos, DNS resolvido para endereço público, tempo e tamanho limitados.
 * (Em desenvolvimento/teste, o conector sandbox pode declarar 127.0.0.1 em HTTP.)
 */
export async function downloadChannelImage(rawUrl: string, allowedHosts: string[]): Promise<Buffer> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw new Error('endereço da foto inválido'); }
  const host = u.hostname.toLowerCase();
  const dev = process.env.NODE_ENV !== 'production' && host === '127.0.0.1' && allowedHosts.includes('127.0.0.1');
  if (u.protocol !== 'https:' && !dev) throw new Error('a foto precisa estar em HTTPS');
  if (u.username || u.password) throw new Error('endereço com credenciais não é aceito');
  if (!allowedHosts.some((h) => host === h || host.endsWith(`.${h}`))) throw new Error(`domínio da foto não permitido (${host})`);
  if (!dev) {
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error('o endereço da foto não é público');
  }
  const res = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { accept: 'image/*' } });
  if (res.status !== 200) throw new Error(`o canal respondeu ${res.status} ao baixar a foto`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_IMAGE_BYTES) throw new Error('foto maior que 3 MB');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > MAX_IMAGE_BYTES) throw new Error('foto maior que 3 MB');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
