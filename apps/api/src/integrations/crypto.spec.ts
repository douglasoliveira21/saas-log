import { randomBytes } from 'node:crypto';
import { CryptoService, redactSecrets } from './crypto.service';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';

describe('CryptoService', () => {
  const original = { k: process.env.CREDENTIALS_KEY, p: process.env.CREDENTIALS_KEY_PREVIOUS };
  afterEach(() => {
    process.env.CREDENTIALS_KEY = original.k;
    if (original.p === undefined) delete process.env.CREDENTIALS_KEY_PREVIOUS; else process.env.CREDENTIALS_KEY_PREVIOUS = original.p;
  });

  it('cifra e decifra, sem texto puro no blob, com IV aleatório', () => {
    const c = new CryptoService();
    const a = c.encrypt(T1, 'cred:1', { accessToken: 'segredo-123' });
    const b = c.encrypt(T1, 'cred:1', { accessToken: 'segredo-123' });
    expect(a).not.toContain('segredo');
    expect(a).not.toBe(b);
    expect(c.decrypt(T1, 'cred:1', a)).toEqual({ accessToken: 'segredo-123' });
  });

  it('o blob de um tenant ou de outro registro não decifra (chave por tenant + AAD)', () => {
    const c = new CryptoService();
    const blob = c.encrypt(T1, 'cred:1', { a: 1 });
    expect(() => c.decrypt(T2, 'cred:1', blob)).toThrow();
    expect(() => c.decrypt(T1, 'cred:2', blob)).toThrow();
  });

  it('detecta adulteração', () => {
    const c = new CryptoService();
    const parts = c.encrypt(T1, 'x', { a: 1 }).split('.');
    parts[4] = Buffer.from('adulterado').toString('base64url');
    expect(() => c.decrypt(T1, 'x', parts.join('.'))).toThrow();
  });

  it('rotação: blob antigo continua legível com CREDENTIALS_KEY_PREVIOUS e é reconhecido como desatualizado', () => {
    const oldKey = process.env.CREDENTIALS_KEY!;
    const blob = new CryptoService().encrypt(T1, 'x', { v: 1 });
    process.env.CREDENTIALS_KEY = randomBytes(32).toString('base64');
    process.env.CREDENTIALS_KEY_PREVIOUS = oldKey;
    const rotated = new CryptoService();
    expect(rotated.decrypt(T1, 'x', blob)).toEqual({ v: 1 });
    expect(rotated.isCurrent(blob)).toBe(false);
    expect(rotated.isCurrent(rotated.encrypt(T1, 'x', {}))).toBe(true);
    delete process.env.CREDENTIALS_KEY_PREVIOUS;
    expect(() => new CryptoService().decrypt(T1, 'x', blob)).toThrow(/chave desconhecida/);
  });
});

describe('redactSecrets', () => {
  it('remove tokens, segredos e códigos de mensagens livres', () => {
    expect(redactSecrets('Authorization: Bearer abcdefghij123456')).toBe('Authorization: Bearer [REDACTED]');
    expect(redactSecrets('falhou com access_token=abc123def456 ok')).toContain('[REDACTED]');
    expect(redactSecrets('url ?code=XYZ123&state=1')).toBe('url ?code=[REDACTED]&state=1');
    expect(redactSecrets('client_secret: s3cr3tvalue')).toContain('[REDACTED]');
    expect(redactSecrets('Timeout ao consultar pedidos.')).toBe('Timeout ao consultar pedidos.');
    // texto comum que menciona a palavra não deve ser mutilado
    expect(redactSecrets('defina ML_CLIENT_ID e ML_CLIENT_SECRET (criados em Developers)')).toBe('defina ML_CLIENT_ID e ML_CLIENT_SECRET (criados em Developers)');
  });
});
