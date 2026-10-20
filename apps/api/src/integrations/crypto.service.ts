import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { getConfig } from '../config/app.config';

const kidOf = (master: Buffer) => createHash('sha256').update(master).digest('hex').slice(0, 8);

/**
 * Criptografia de credenciais de integrações: AES-256-GCM.
 * - A chave de cada tenant é derivada da chave mestra por HKDF (sal = tenantId): um blob de um tenant não decifra em outro.
 * - O AAD amarra o blob ao tenant e ao propósito (ex.: id da conexão), impedindo troca de blobs entre registros.
 * - Formato: v1.<kid>.<iv>.<tag>.<ciphertext> (base64url). O kid identifica a chave mestra usada (rotação).
 */
@Injectable()
export class CryptoService {
  private readonly keys = new Map<string, Buffer>();
  private readonly currentKid: string;

  constructor() {
    const cfg = getConfig();
    this.currentKid = kidOf(cfg.credentialsKey);
    this.keys.set(this.currentKid, cfg.credentialsKey);
    if (cfg.credentialsKeyPrevious) this.keys.set(kidOf(cfg.credentialsKeyPrevious), cfg.credentialsKeyPrevious);
  }

  private derive(master: Buffer, tenantId: string): Buffer {
    return Buffer.from(hkdfSync('sha256', master, Buffer.from(tenantId), Buffer.from('dh-credentials-v1'), 32));
  }

  encrypt(tenantId: string, aad: string, value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.derive(this.keys.get(this.currentKid)!, tenantId), iv);
    cipher.setAAD(Buffer.from(`${tenantId}|${aad}`));
    const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return ['v1', this.currentKid, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  decrypt<T = Record<string, unknown>>(tenantId: string, aad: string, blob: string): T {
    const [v, kid, iv, tag, ct] = blob.split('.');
    const master = this.keys.get(kid);
    if (v !== 'v1' || !master) throw new Error('Credencial ilegível: chave desconhecida (verifique CREDENTIALS_KEY/CREDENTIALS_KEY_PREVIOUS).');
    const decipher = createDecipheriv('aes-256-gcm', this.derive(master, tenantId), Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(`${tenantId}|${aad}`));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const out = Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]);
    return JSON.parse(out.toString('utf8')) as T;
  }

  /** O blob usa a chave mestra atual? (false → precisa ser regravado após rotação) */
  isCurrent(blob: string): boolean {
    return blob.split('.')[1] === this.currentKid;
  }
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]'],
  [/((?:access|refresh)_?token["']?\s*[=:]\s*["']?)[A-Za-z0-9._~+/=-]{6,}/gi, '$1[REDACTED]'],
  [/((?:client_?secret|secret|password|senha|api_?key|signature|sign)["']?\s*[=:]\s*["']?)[^\s&"',]{4,}/gi, '$1[REDACTED]'],
  [/(code=)[^&\s]+/gi, '$1[REDACTED]'],
];

/** Remove tokens/segredos de textos livres (mensagens de erro, URLs) antes de logar ou devolver ao navegador. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((t, [re, rep]) => t.replace(re, rep), text);
}
