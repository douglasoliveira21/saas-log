import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Hash fictício: iguala o tempo de resposta quando o e-mail não existe. */
export const DUMMY_HASH = `scrypt$${N}$${R}$${P}$AAAAAAAAAAAAAAAAAAAAAA==$${Buffer.alloc(KEYLEN).toString('base64')}`;

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function newOpaqueToken(): string {
  return randomBytes(48).toString('base64url');
}

export function validatePasswordPolicy(password: string): string | null {
  if (password.length < 10) return 'A senha deve ter ao menos 10 caracteres.';
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) return 'A senha deve conter letras e números.';
  return null;
}
