import * as forge from 'node-forge';
import { createServer as createHttp, Server as HttpServer } from 'node:http';
import { createServer, Server } from 'node:https';
import { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifySignature } from '../../src/fiscal/sefaz/signature';
import { gunzipSync } from 'node:zlib';
import { validateAgainst } from '../../src/fiscal/sefaz/xsd';
import { validateMdfe, validateMdfeFull } from '../../src/fiscal/mdfe/xsd';

/**
 * SERVIDOR DE TESTE que imita a forma dos serviços da SEFAZ (SOAP 1.2 sobre TLS com certificado de cliente).
 * NÃO é a SEFAZ: valida o XML recebido contra o XSD e confere a assinatura, mas as respostas são as que o teste manda.
 * Serve para provar o NOSSO código; não prova que a SEFAZ real autoriza a nota.
 */
export type SefazMode = 'authorize' | 'reject' | 'denied' | 'receipt' | 'stuck' | 'down' | 'unknown';

const NS = 'http://www.portalfiscal.inf.br/nfe';
const soap = (op: string, inner: string) => `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeResultMsg xmlns="${NS}/wsdl/${op}">${inner}</nfeResultMsg></soap:Body></soap:Envelope>`;

const MNS = 'http://www.portalfiscal.inf.br/mdfe';
const msoap = (op: string, inner: string) => `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><mdfeResultMsg xmlns="${MNS}/wsdl/${op}">${inner}</mdfeResultMsg></soap:Body></soap:Envelope>`;

export function makeServerCert(): { key: string; cert: string } {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey; cert.serialNumber = '0a';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000); cert.validity.notAfter = new Date(Date.now() + 30 * 86_400_000);
  const attrs = [{ name: 'commonName', value: 'sefaz-teste.local' }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }, { type: 2, value: 'localhost' }] }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) };
}

export class MockSefaz {
  server!: Server;
  base = '';
  caFile = '';
  mode: SefazMode = 'authorize';
  /** Respostas da consulta por chave: chave → 'authorized' | 'cancelled'. */
  known = new Map<string, { protocol: string; prot: string; cancelled?: boolean }>();
  calls: { path: string; action: string; clientCn: string | null; xmlValid: boolean | null; sigValid: boolean | null; xsdErrors: string[]; body: string }[] = [];
  private n = 0;
  /** MDF-e conhecidos: chave → situação. */
  mdfe = new Map<string, { protocol: string; prot: string; closed?: boolean; cancelled?: boolean }>();
  private receipts = new Map<string, string>();

  async start() {
    const sc = makeServerCert();
    this.caFile = join(mkdtempSync(join(tmpdir(), 'sefaz-ca-')), 'ca.pem');
    writeFileSync(this.caFile, sc.cert);
    this.server = createServer({ key: sc.key, cert: sc.cert, requestCert: true, rejectUnauthorized: false }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => { this.handle(req, res, Buffer.concat(chunks).toString('utf8')).catch((e: Error) => { console.error('MOCK-SEFAZ erro:', e.message); res.writeHead(500); res.end(e.message); }); });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `https://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop() { return new Promise<void>((r) => this.server.close(() => r())); }

  private prot(chave: string, cStat: string, motivo: string, tpAmb = '2') {
    const nProt = cStat === '100' ? `13126${String(++this.n).padStart(10, '0')}` : '';
    const dh = '2026-10-22T10:00:00-03:00';
    return { nProt, xml: `<protNFe xmlns="${NS}" versao="4.00"><infProt><tpAmb>${tpAmb}</tpAmb><verAplic>MG-1.0</verAplic><chNFe>${chave}</chNFe><dhRecbto>${dh}</dhRecbto>${nProt ? `<nProt>${nProt}</nProt>` : ''}<digVal>AAAAAAAAAAAAAAAAAAAAAAAAAAA=</digVal><cStat>${cStat}</cStat><xMotivo>${motivo}</xMotivo></infProt></protNFe>` };
  }

  private async handleMdfe(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: string, path: string, op: string) {
    const peer = (req.socket as unknown as { getPeerCertificate?: () => { subject?: { CN?: string } } }).getPeerCertificate?.();
    const inner = /<mdfeDadosMsg[^>]*>([\s\S]*)<\/mdfeDadosMsg>/.exec(body)?.[1] ?? '';
    const call = { path, action: String(req.headers['content-type'] ?? ''), clientCn: peer?.subject?.CN ?? null, xmlValid: null as boolean | null, sigValid: null as boolean | null, xsdErrors: [] as string[], body: inner };
    this.calls.push(call);
    const send = (xml: string) => { res.writeHead(200, { 'content-type': 'application/soap+xml; charset=utf-8' }); res.end(msoap(op, xml)); };
    if (this.mode === 'down') { req.socket.destroy(); return; }
    const dh = '2026-10-23T10:00:00-03:00';

    if (op === 'MDFeRecepcaoSinc') {
      const xml = gunzipSync(Buffer.from(inner.trim(), 'base64')).toString('utf8');
      call.body = xml;
      const v = await validateMdfeFull(xml);
      call.xmlValid = v.valid; call.xsdErrors = v.errors.map((e) => e.message);
      call.sigValid = verifySignature(xml).valid;
      const chave = /Id="MDFe(\d{44})"/.exec(xml)?.[1] ?? '';
      if (this.mode === 'stuck') { req.socket.destroy(); return; }
      const [cStat, motivo] = !v.valid ? ['215', 'Rejeicao: Falha no schema XML'] : this.mode === 'reject' ? ['539', 'Rejeicao: Duplicidade de MDF-e'] : ['100', 'Autorizado o uso do MDF-e'];
      const nProt = cStat === '100' ? `13126${String(++this.n).padStart(10, '0')}` : '';
      const prot = `<protMDFe xmlns="${MNS}" versao="3.00"><infProt><tpAmb>2</tpAmb><verAplic>SVRS</verAplic><chMDFe>${chave}</chMDFe><dhRecbto>${dh}</dhRecbto>${nProt ? `<nProt>${nProt}</nProt>` : ''}<digVal>AAAAAAAAAAAAAAAAAAAAAAAAAAA=</digVal><cStat>${cStat}</cStat><xMotivo>${motivo}</xMotivo></infProt></protMDFe>`;
      if (cStat === '100') this.mdfe.set(chave, { protocol: nProt, prot });
      return send(`<retMDFe xmlns="${MNS}" versao="3.00"><tpAmb>2</tpAmb><verAplic>SVRS</verAplic><cStat>${cStat === '100' ? '104' : cStat}</cStat><xMotivo>${cStat === '100' ? 'Lote processado' : motivo}</xMotivo><cUF>31</cUF><dhRecbto>${dh}</dhRecbto>${prot}</retMDFe>`);
    }

    if (op === 'MDFeConsulta') {
      const chave = /<chMDFe>(\d{44})<\/chMDFe>/.exec(inner)?.[1] ?? '';
      const k = this.mdfe.get(chave);
      if (!k) return send(`<retConsSitMDFe xmlns="${MNS}" versao="3.00"><tpAmb>2</tpAmb><verAplic>SVRS</verAplic><cStat>217</cStat><xMotivo>Rejeicao: MDF-e nao consta na base de dados da SEFAZ</xMotivo><cUF>31</cUF></retConsSitMDFe>`);
      const [cStat, motivo] = k.cancelled ? ['101', 'Cancelamento de MDF-e homologado'] : k.closed ? ['132', 'Encerramento de MDF-e homologado'] : ['100', 'Autorizado o uso do MDF-e'];
      return send(`<retConsSitMDFe xmlns="${MNS}" versao="3.00"><tpAmb>2</tpAmb><verAplic>SVRS</verAplic><cStat>${cStat}</cStat><xMotivo>${motivo}</xMotivo><cUF>31</cUF><chMDFe>${chave}</chMDFe>${k.prot}</retConsSitMDFe>`);
    }

    if (op === 'MDFeRecepcaoEvento') {
      const v = await validateMdfe('eventoMDFe_v3.00.xsd', inner);
      call.xmlValid = v.valid; call.xsdErrors = v.errors.map((e) => e.message);
      call.sigValid = verifySignature(inner).valid;
      const tp = /<tpEvento>(\d+)<\/tpEvento>/.exec(inner)?.[1] ?? '';
      (call as { tpEvento?: string }).tpEvento = tp;
      const chave = /<chMDFe>(\d{44})<\/chMDFe>/.exec(inner)?.[1] ?? '';
      const k = this.mdfe.get(chave);
      const ok = v.valid && !!call.sigValid && !!k && !k.closed && !k.cancelled;
      if (ok && tp === '110111') k!.cancelled = true;
      if (ok && tp === '110112') k!.closed = true;
      return send(`<retEventoMDFe xmlns="${MNS}" versao="3.00"><infEvento><tpAmb>2</tpAmb><verAplic>SVRS</verAplic><cOrgao>91</cOrgao><cStat>${ok ? '135' : '573'}</cStat><xMotivo>${ok ? 'Evento registrado e vinculado a MDF-e' : 'Rejeicao: Evento nao aceito'}</xMotivo><chMDFe>${chave}</chMDFe><tpEvento>${tp}</tpEvento>${ok ? '<nProt>131260000000555</nProt>' : ''}</infEvento></retEventoMDFe>`);
    }
    res.writeHead(404); res.end('serviço MDF-e desconhecido no simulador');
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: string) {
    const path = req.url ?? '';
    const op = path.split('/').pop()!.replace(/\.asmx$/i, '');
    if (/^MDFe/.test(op)) return this.handleMdfe(req, res, body, path, op);
    const peer = (req.socket as unknown as { getPeerCertificate?: () => { subject?: { CN?: string } } }).getPeerCertificate?.();
    const inner = /<nfeDadosMsg[^>]*>([\s\S]*)<\/nfeDadosMsg>/.exec(body)?.[1] ?? '';
    const call = { path, action: String(req.headers['content-type'] ?? ''), clientCn: peer?.subject?.CN ?? null, xmlValid: null as boolean | null, sigValid: null as boolean | null, xsdErrors: [] as string[], body: inner };
    this.calls.push(call);
    const send = (xml: string) => { res.writeHead(200, { 'content-type': 'application/soap+xml; charset=utf-8' }); res.end(soap(op, xml)); };
    if (this.mode === 'down') { req.socket.destroy(); return; }

    if (op === 'NFeStatusServico4') return send(`<retConsStatServ xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>MG</verAplic><cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo><cUF>31</cUF><dhRecbto>2026-10-22T10:00:00-03:00</dhRecbto><tMed>1</tMed></retConsStatServ>`);

    if (op === 'NFeAutorizacao4') {
      const v = await validateAgainst('enviNFe_v4.00.xsd', inner);
      call.xmlValid = v.valid; call.xsdErrors = v.errors.map((e) => e.message);
      const nfe = /<NFe[\s\S]*<\/NFe>/.exec(inner)?.[0] ?? '';
      call.sigValid = verifySignature(nfe).valid;
      const chave = /Id="NFe(\d{44})"/.exec(inner)?.[1] ?? '';
      if (!v.valid) return send(`<retEnviNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>MG</verAplic><cStat>225</cStat><xMotivo>Rejeicao: Falha no Schema XML do lote de NFe</xMotivo><cUF>31</cUF><dhRecbto>2026-10-22T10:00:00-03:00</dhRecbto></retEnviNFe>`);
      if (this.mode === 'stuck') return send(`<retEnviNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>MG</verAplic><cStat>105</cStat><xMotivo>Lote em processamento</xMotivo><cUF>31</cUF><dhRecbto>2026-10-22T10:00:00-03:00</dhRecbto></retEnviNFe>`);
      if (this.mode === 'receipt') { const nRec = `31000${++this.n}`; this.receipts.set(nRec, chave); return send(`<retEnviNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>MG</verAplic><cStat>103</cStat><xMotivo>Lote recebido com sucesso</xMotivo><cUF>31</cUF><dhRecbto>2026-10-22T10:00:00-03:00</dhRecbto><infRec><nRec>${nRec}</nRec><tMed>1</tMed></infRec></retEnviNFe>`); }
      const [cStat, motivo] = this.mode === 'reject' ? ['539', 'Rejeicao: Duplicidade de NF-e, com diferenca na Chave de Acesso'] : this.mode === 'denied' ? ['301', 'Uso Denegado: Irregularidade fiscal do emitente'] : ['100', 'Autorizado o uso da NF-e'];
      const p = this.prot(chave, cStat, motivo);
      if (cStat === '100') this.known.set(chave, { protocol: p.nProt, prot: p.xml });
      return send(`<retEnviNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>MG</verAplic><cStat>104</cStat><xMotivo>Lote processado</xMotivo><cUF>31</cUF><dhRecbto>2026-10-22T10:00:00-03:00</dhRecbto>${p.xml}</retEnviNFe>`);
    }

    if (op === 'NFeRetAutorizacao4') {
      const nRec = /<nRec>(\d+)<\/nRec>/.exec(inner)?.[1] ?? '';
      const chave = this.receipts.get(nRec) ?? '';
      const p = this.prot(chave, '100', 'Autorizado o uso da NF-e');
      this.known.set(chave, { protocol: p.nProt, prot: p.xml });
      return send(`<retConsReciNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>MG</verAplic><nRec>${nRec}</nRec><cStat>104</cStat><xMotivo>Lote processado</xMotivo><cUF>31</cUF><dhRecbto>2026-10-22T10:00:00-03:00</dhRecbto>${p.xml}</retConsReciNFe>`);
    }

    if (op === 'NFeConsultaProtocolo4') {
      const chave = /<chNFe>(\d{44})<\/chNFe>/.exec(inner)?.[1] ?? '';
      const k = this.known.get(chave);
      if (!k) return send(`<retConsSitNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>MG</verAplic><cStat>217</cStat><xMotivo>Rejeicao: NF-e nao consta na base de dados da SEFAZ</xMotivo><cUF>31</cUF><dhRecbto>2026-10-22T10:00:00-03:00</dhRecbto><chNFe>${chave}</chNFe></retConsSitNFe>`);
      if (k.cancelled) return send(`<retConsSitNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>MG</verAplic><cStat>101</cStat><xMotivo>Cancelamento de NF-e homologado</xMotivo><cUF>31</cUF><dhRecbto>2026-10-22T10:00:00-03:00</dhRecbto><chNFe>${chave}</chNFe>${k.prot}<procEventoNFe versao="1.00"><evento versao="1.00"/><retEvento versao="1.00"><infEvento><tpAmb>2</tpAmb><cStat>135</cStat><xMotivo>Evento registrado e vinculado a NF-e</xMotivo><chNFe>${chave}</chNFe><tpEvento>110111</tpEvento><nProt>9999</nProt></infEvento></retEvento></procEventoNFe></retConsSitNFe>`);
      return send(`<retConsSitNFe xmlns="${NS}" versao="4.00"><tpAmb>2</tpAmb><verAplic>MG</verAplic><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo><cUF>31</cUF><dhRecbto>2026-10-22T10:00:00-03:00</dhRecbto><chNFe>${chave}</chNFe>${k.prot}</retConsSitNFe>`);
    }

    if (op === 'NFeRecepcaoEvento4') {
      const v = await validateAgainst('envEvento_v1.00.xsd', inner);
      const tp = /<tpEvento>(\d+)<\/tpEvento>/.exec(inner)?.[1] ?? '';
      // eventos com XSD próprio do detalhe (CC-e e manifestação): valida também o <detEvento>
      const detOk = tp === '110111' ? true : (await validateAgainst(`e${tp}_v1.00.xsd`, (/<detEvento[\s\S]*?<\/detEvento>/.exec(inner)?.[0] ?? '').replace('<detEvento ', `<detEvento xmlns="${NS}" `))).valid;
      call.xmlValid = v.valid && detOk; call.xsdErrors = v.errors.map((e) => e.message);
      call.sigValid = verifySignature(inner).valid;
      (call as { tpEvento?: string; cOrgao?: string; seq?: string }).tpEvento = tp;
      (call as { cOrgao?: string }).cOrgao = /<cOrgao>(\d+)<\/cOrgao>/.exec(inner)?.[1];
      (call as { seq?: string }).seq = /<nSeqEvento>(\d+)<\/nSeqEvento>/.exec(inner)?.[1];
      const chave = /<chNFe>(\d{44})<\/chNFe>/.exec(inner)?.[1] ?? '';
      const valid = v.valid && detOk && call.sigValid;
      const ok = tp === '110111' ? valid && this.known.has(chave) : tp === '110110' ? valid && this.known.has(chave) && !this.known.get(chave)!.cancelled : valid;
      if (ok && tp === '110111') this.known.get(chave)!.cancelled = true;
      return send(`<retEnvEvento xmlns="${NS}" versao="1.00"><idLote>1</idLote><tpAmb>2</tpAmb><verAplic>MG</verAplic><cOrgao>${/<cOrgao>(\d+)<\/cOrgao>/.exec(inner)?.[1] ?? '31'}</cOrgao><cStat>128</cStat><xMotivo>Lote de Evento Processado</xMotivo><retEvento versao="1.00"><infEvento><tpAmb>2</tpAmb><cStat>${ok ? '135' : '573'}</cStat><xMotivo>${ok ? 'Evento registrado e vinculado a NF-e' : 'Rejeicao: Duplicidade de evento'}</xMotivo><chNFe>${chave}</chNFe><tpEvento>${tp}</tpEvento>${ok ? '<nProt>131260000000999</nProt>' : ''}</infEvento></retEvento></retEnvEvento>`);
    }

    if (op === 'NFeInutilizacao4') {
      const v = await validateAgainst('inutNFe_v4.00.xsd', inner);
      call.xmlValid = v.valid; call.xsdErrors = v.errors.map((e) => e.message);
      call.sigValid = verifySignature(inner).valid;
      return send(`<retInutNFe xmlns="${NS}" versao="4.00"><infInut><tpAmb>2</tpAmb><verAplic>MG</verAplic><cStat>${v.valid ? '102' : '215'}</cStat><xMotivo>${v.valid ? 'Inutilizacao de numero homologado' : 'Rejeicao: Falha no schema XML'}</xMotivo><cUF>31</cUF>${v.valid ? '<nProt>131260000000777</nProt>' : ''}</infInut></retInutNFe>`);
    }
    res.writeHead(404); res.end('serviço desconhecido no simulador');
  }
}

/** Servidor HTTP simples que imita a API de municípios do IBGE (só MG e RJ, o que os testes usam). */
export function startMockIbge(): Promise<{ base: string; server: HttpServer }> {
  const data: Record<string, { id: number; nome: string }[]> = {
    MG: [{ id: 3106200, nome: 'Belo Horizonte' }, { id: 3170206, nome: 'Uberlândia' }],
    RJ: [{ id: 3304557, nome: 'Rio de Janeiro' }],
    SP: [{ id: 3509502, nome: 'Campinas' }],
  };
  const server = createHttp((req, res) => {
    const uf = /estados\/([A-Z]{2})\/municipios/.exec(req.url ?? '')?.[1] ?? '';
    res.writeHead(data[uf] ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data[uf] ?? []));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server })));
}
