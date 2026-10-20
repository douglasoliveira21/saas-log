import { existsSync } from 'node:fs';

export function loadEnv(): void {
  if (existsSync('.env')) {
    try {
      process.loadEnvFile('.env');
    } catch {
      /* variáveis já definidas no ambiente têm prioridade */
    }
  }
}

export interface AppConfig {
  appName: string; // marca centralizada: troque via APP_NAME sem tocar no código
  nodeEnv: string;
  port: number;
  webOrigin: string;
  jwtSecret: string;
  cookieSecure: boolean;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  credentialsKey: Buffer;
  credentialsKeyPrevious: Buffer | null;
  workerEnabled: boolean;
  sandboxConnector: boolean;
}

function key(name: string, required: boolean): Buffer | null {
  const raw = process.env[name];
  if (!raw) {
    if (required) throw new Error(`${name} ausente (32 bytes em base64).`);
    return null;
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error(`${name} deve ter exatamente 32 bytes (base64).`);
  return buf;
}

export function getConfig(): AppConfig {
  const jwtSecret = process.env.JWT_SECRET ?? '';
  if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET ausente ou com menos de 32 caracteres.');
  }
  return {
    appName: process.env.APP_NAME ?? 'DistribuiHub ERP',
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: Number(process.env.API_PORT ?? 3001),
    webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    jwtSecret,
    cookieSecure: process.env.COOKIE_SECURE === 'true',
    accessTtlSeconds: 15 * 60,
    refreshTtlSeconds: 14 * 24 * 60 * 60,
    credentialsKey: key('CREDENTIALS_KEY', true)!,
    credentialsKeyPrevious: key('CREDENTIALS_KEY_PREVIOUS', false),
    workerEnabled: process.env.WORKER_ENABLED !== 'false',
    sandboxConnector: process.env.ENABLE_SANDBOX_CONNECTOR === 'true' && process.env.NODE_ENV !== 'production',
  };
}
