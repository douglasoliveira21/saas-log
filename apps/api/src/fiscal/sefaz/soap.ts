import { readFileSync } from 'node:fs';
import https from 'node:https';
import tls from 'node:tls';
import { NS } from './messages';

/**
 * Cliente SOAP 1.2 dos serviços da SEFAZ com TLS mútuo (certificado A1 do emitente).
 * - A verificação do certificado do SERVIDOR nunca é desligada. Os servidores usam a cadeia ICP-Brasil, que não vem no pacote padrão do Node:
 *   informe o arquivo PEM da cadeia em FISCAL_SEFAZ_CA_FILE (obtido da fonte oficial do ITI). Sem ela a conexão falha com mensagem clara.
 * - FISCAL_SEFAZ_URL_OVERRIDE (JSON {"base":"https://host:porta"}) troca só o endereço-base e SÓ funciona fora de produção (testes).
 */
export interface Mtls { keyPem: string; certPem: string }

export class TlsSetupError extends Error {}

function target(url: string): string {
  const o = process.env.FISCAL_SEFAZ_URL_OVERRIDE;
  if (!o || process.env.NODE_ENV === 'production') return url;
  const base = new URL((JSON.parse(o) as { base: string }).base);
  const u = new URL(url);
  u.protocol = base.protocol; u.host = base.host;
  return u.toString();
}

let extraCa: string | null | undefined;
function caList(): string[] {
  if (extraCa === undefined) {
    const f = process.env.FISCAL_SEFAZ_CA_FILE;
    extraCa = f ? readFileSync(f, 'utf8') : null;
  }
  return [...tls.rootCertificates, ...(extraCa ? [extraCa] : [])];
}
export const resetCaCache = () => { extraCa = undefined; };

export interface SoapReply { status: number; text: string }

/** Envia `bodyXml` (sem o envelope) à operação e devolve o texto da resposta. Erros de TLS/rede viram exceção com `sent` indicando se a requisição pode ter chegado. */
export async function soapCall(url: string, op: { operation: string; method: string }, bodyXml: string, id: Mtls, timeoutMs = 30_000): Promise<SoapReply> {
  const ns = `${NS}/wsdl/${op.operation}`;
  const envelope = `<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><nfeDadosMsg xmlns="${ns}">${bodyXml}</nfeDadosMsg></soap12:Body></soap12:Envelope>`;
  const u = new URL(target(url));
  const agent = new https.Agent({ key: id.keyPem, cert: id.certPem, ca: caList(), minVersion: 'TLSv1.2', rejectUnauthorized: true, keepAlive: false });
  return new Promise<SoapReply>((resolve, reject) => {
    let connected = false;
    const req = https.request({
      method: 'POST', hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, agent, timeout: timeoutMs,
      headers: { 'content-type': `application/soap+xml; charset=utf-8; action="${ns}/${op.method}"`, 'content-length': Buffer.byteLength(envelope) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('socket', (s) => { s.once('secureConnect', () => { connected = true; }); });
    req.on('timeout', () => { req.destroy(Object.assign(new Error('Tempo esgotado'), { sent: connected, timeout: true })); });
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (/UNABLE_TO_VERIFY|SELF_SIGNED|CERT_|UNABLE_TO_GET_ISSUER/.test(e.code ?? '')) reject(new TlsSetupError('Não foi possível validar o certificado do servidor da SEFAZ: a cadeia ICP-Brasil não está configurada (FISCAL_SEFAZ_CA_FILE).'));
      else reject(Object.assign(e, { sent: connected }));
    });
    req.end(envelope);
  });
}
