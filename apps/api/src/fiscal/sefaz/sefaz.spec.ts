import { buildChave } from '../chave';
import { buildNfeXml, NfeInput } from './nfe-builder';
import { validateAgainst } from './xsd';

const chave = (model = '55') => buildChave({ uf: 'MG', issuedAt: new Date('2026-10-22T15:00:00Z'), cnpj: '45723174000110', model, series: 1, number: 1234, cNF: '12345678' });

export const base = (over: Partial<NfeInput> = {}): NfeInput => ({
  model: '55', environment: 'HOMOLOGACAO', chave: chave(), natOp: 'VENDA DE MERCADORIA', issuedAt: new Date('2026-10-22T15:00:00Z'), idDest: 2, indFinal: 0, indPres: 9, cMunFG: '3106200',
  emitter: { cnpj: '45723174000110', name: 'EMPRESA TESTE LTDA', tradeName: 'Teste', ie: '1112223340000', crt: 1, street: 'Rua A', number: '1', district: 'Centro', cMun: '3106200', city: 'Belo Horizonte', uf: 'MG', zip: '30110-000', phone: '3133334444' },
  recipient: { cnpj: '04252011000110', name: 'Cliente Teste', indIEDest: 9, street: 'Rua B', number: '2', district: 'Centro', cMun: '3304557', city: 'Rio de Janeiro', uf: 'RJ', zip: '20000-000', email: 'c@teste.com' },
  items: [{ line: 1, code: 'P-001', gtin: null, description: 'Parafuso sextavado M8', ncm: '73181500', cfop: '6102', unit: 'UN', quantity: 2, total: 100, icms: { origin: 0, regime: 'SN', code: '102' }, pis: { cst: '49', base: 0, rate: 0, amount: 0 }, cofins: { cst: '49', base: 0, rate: 0, amount: 0 } }],
  freight: 0, payments: [{ tPag: '17', vPag: 100 }], additionalInfo: 'Pedido 1', procVersion: 'DistribuiHub 1.0', ...over,
});

describe('XML da NF-e contra o XSD do pacote (validação estrutural real)', () => {
  it('Simples Nacional (CSOSN 102, PIS/COFINS 49) é válido', async () => {
    const xml = buildNfeXml(base());
    const r = await validateAgainst('nfe_v4.00.xsd', xml.replace('</infNFe></NFe>', '</infNFe></NFe>'));
    // sem a assinatura o XSD acusa só a falta de <Signature>; qualquer outro erro é problema do leiaute
    const other = r.errors.filter((e) => !/Signature/.test(e.message));
    expect(other).toEqual([]);
  });
});

// ───────────── assinatura digital ─────────────
import * as forge from 'node-forge';
import { pfxToPem } from './pfx';
import { signXml, verifySignature } from './signature';

function makePfx(cn: string, password = 'senha-teste'): Buffer {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey; cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000); cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
  const attrs = [{ name: 'commonName', value: cn }, { name: 'countryName', value: 'BR' }];
  cert.setSubject(attrs); cert.setIssuer(attrs); cert.sign(keys.privateKey, forge.md.sha256.create());
  return Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' })).getBytes(), 'binary');
}

describe('assinatura digital da NF-e (certificado de TESTE, não ICP-Brasil)', () => {
  const pem = pfxToPem(makePfx('EMPRESA TESTE:45723174000110'), 'senha-teste');
  const signed = () => signXml(buildNfeXml(base()), { keyPem: pem.keyPem, certPem: pem.certPem, tagToSign: 'infNFe', after: 'infNFe' });

  it('extrai chave e certificado do .pfx e identifica o CNPJ do titular', () => {
    expect(pem.cnpj).toBe('45723174000110');
    expect(pem.keyPem).toContain('BEGIN RSA PRIVATE KEY');
    expect(() => pfxToPem(makePfx('X'), 'outra-senha')).toThrow();
  });

  it('o XML assinado é VÁLIDO no XSD oficial completo (inclusive <Signature>) e a assinatura confere', async () => {
    const xml = signed();
    expect(xml).toContain('<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">');
    expect(xml).toContain('rsa-sha1');
    expect(xml).toMatch(/<Reference URI="#NFe\d{44}">/);
    expect(xml.indexOf('</infNFe><Signature')).toBeGreaterThan(0); // Signature logo depois de infNFe, dentro de NFe
    const r = await validateAgainst('nfe_v4.00.xsd', xml);
    expect(r.errors).toEqual([]);
    expect(verifySignature(xml, pem.certPem)).toEqual({ valid: true, errors: [] });
  });

  it('qualquer alteração depois de assinar invalida a assinatura', () => {
    const tampered = signed().replace('<vNF>100.00</vNF>', '<vNF>1.00</vNF>');
    expect(verifySignature(tampered, pem.certPem).valid).toBe(false);
  });
});

// ───────────── regras do builder, registro e QR Code ─────────────
import { createHash } from 'node:crypto';
import { allocateFreight, qrCodeV2 } from './nfe-builder';
import { coverage, service, ufEntry, UfNotAnalyzedError } from './registry';

describe('XML da NF-e/NFC-e: casos além do Simples', () => {
  const sign = (xml: string, after = 'infNFe') => signXml(xml, { keyPem: pem.keyPem, certPem: pem.certPem, tagToSign: 'infNFe', after });
  const pem = pfxToPem(makePfx('EMPRESA TESTE:45723174000110'), 'senha-teste');

  it('Regime Normal com ICMS 00 e PIS/COFINS tributados (base, alíquota e valor) é válido no XSD, com frete rateado', async () => {
    const input = base({
      emitter: { ...base().emitter, crt: 3 }, freight: 10,
      items: [
        { line: 1, code: 'A', gtin: '7891000100103', description: 'Item A', ncm: '73181500', cfop: '6102', unit: 'UN', quantity: 3, total: 99.99, icms: { origin: 0, regime: 'NORMAL', code: '00', base: 99.99, rate: 12, amount: 12 }, pis: { cst: '01', base: 99.99, rate: 1.65, amount: 1.65 }, cofins: { cst: '01', base: 99.99, rate: 7.6, amount: 7.6 } },
        { line: 2, code: 'B', gtin: null, description: 'Item B & "aspas"', ncm: '73181500', cfop: '6102', unit: 'UN', quantity: 1, total: 0.01, icms: { origin: 1, regime: 'NORMAL', code: '40' }, pis: { cst: '07' }, cofins: { cst: '07' } },
      ],
      payments: [{ tPag: '03', vPag: 110 }],
    });
    const xml = sign(buildNfeXml(input));
    expect((await validateAgainst('nfe_v4.00.xsd', xml)).errors).toEqual([]);
    expect(xml).toContain('<vNF>110.00</vNF>');
    expect(xml).toContain('<vICMS>12.00</vICMS>');
    expect(xml).toContain('Item B &amp;'); // & escapado como entidade (o XSD e a assinatura continuam válidos)
    expect(xml).toContain('<card><tpIntegra>2</tpIntegra></card>'); // cartão
  });

  it('o frete é rateado em centavos e a soma bate exatamente com o total', () => {
    const parts = allocateFreight([33.33, 33.33, 33.34], 10);
    expect(parts.reduce((s, p) => Math.round((s + p) * 100) / 100, 0)).toBe(10);
    expect(allocateFreight([50], 0)).toEqual([0]);
  });

  it('CSOSN/CST não suportados são recusados com mensagem clara (nunca viram XML errado)', () => {
    const bad = base({ items: [{ ...base().items[0], icms: { origin: 0, regime: 'SN', code: '500' } }] });
    expect(() => buildNfeXml(bad)).toThrow(/CSOSN 500 ainda não suportado/);
    const bad2 = base({ emitter: { ...base().emitter, crt: 3 }, items: [{ ...base().items[0], icms: { origin: 0, regime: 'NORMAL', code: '10' } }] });
    expect(() => buildNfeXml(bad2)).toThrow(/CST 10 de ICMS ainda não suportado/);
  });

  it('pagamento menor que o total é recusado antes de montar o XML', () => {
    expect(() => buildNfeXml(base({ payments: [{ tPag: '17', vPag: 50 }] }))).toThrow(/menor que o valor da nota/);
  });

  it('o XSD recusa o que o leiaute não aceita (NCM curto) e aponta o campo', async () => {
    const xml = buildNfeXml(base({ items: [{ ...base().items[0], ncm: '123' }] }));
    const r = await validateAgainst('nfe_v4.00.xsd', xml);
    expect(r.errors.some((e) => /NCM/.test(e.message))).toBe(true);
  });

  it('NFC-e: consumidor sem identificação, QR Code 2.00 e assinatura depois do infNFeSupl; válida no XSD', async () => {
    const key = chave('65');
    const input = base({ model: '65', chave: key, idDest: 1, indFinal: 1, indPres: 1, recipient: null, qr: { url: 'https://portalsped.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml', cscId: '1', csc: 'CSC-DE-TESTE-123456', consultaChaveUrl: 'https://hportalsped.fazenda.mg.gov.br/portalnfce' } });
    const xml = sign(buildNfeXml(input), 'infNFeSupl');
    expect((await validateAgainst('nfe_v4.00.xsd', xml)).errors).toEqual([]);
    expect(xml).toContain('<mod>65</mod>');
    expect(xml).not.toContain('<dest>');
    expect(xml.indexOf('</infNFeSupl><Signature')).toBeGreaterThan(0);
    expect(verifySignature(xml, pem.certPem).valid).toBe(true);
  });

  it('QR Code 2.00: SHA-1 maiúsculo de "chave|2|tpAmb|cscId" + CSC (conferido com o cálculo independente)', () => {
    const key = chave('65');
    const url = 'https://exemplo.gov.br/qr';
    const seq = `${key}|2|2|1`;
    const hash = createHash('sha1').update(seq + 'MEU-CSC-123456').digest('hex').toUpperCase();
    expect(qrCodeV2(url, key, 'HOMOLOGACAO', '000001', 'MEU-CSC-123456')).toBe(`${url}?p=${seq}|${hash}`);
    expect(qrCodeV2(url, key, 'PRODUCAO', '1', 'MEU-CSC-123456')).toContain('|2|1|1|');
  });
});

describe('registro de serviços e matriz de cobertura', () => {
  it('os endereços de MG são exatamente os da página oficial do SPED MG (NF-e e NFC-e, homologação e produção)', () => {
    expect(service('MG', '55', 'HOMOLOGACAO', 'autorizacao').url).toBe('https://hnfe.fazenda.mg.gov.br/nfe2/services/NFeAutorizacao4');
    expect(service('MG', '55', 'PRODUCAO', 'consulta').url).toBe('https://nfe.fazenda.mg.gov.br/nfe2/services/NFeConsultaProtocolo4');
    expect(service('MG', '65', 'HOMOLOGACAO', 'evento').url).toBe('https://hnfce.fazenda.mg.gov.br/nfce/services/NFeRecepcaoEvento4');
    expect(service('MG', '65', 'PRODUCAO', 'status').url).toBe('https://nfce.fazenda.mg.gov.br/nfce/services/NFeStatusServico4');
    expect(ufEntry('MG', '55', 'PRODUCAO').services.autorizacao.source).toMatch(/portalsped\.fazenda\.mg\.gov\.br/);
    expect(ufEntry('mg', '55', 'HOMOLOGACAO').services.status.consultedAt).toBe('2026-10-22');
  });

  it('UF sem endereços verificados é recusada com explicação (nada de URL inventada)', () => {
    expect(() => service('SP', '55', 'HOMOLOGACAO', 'autorizacao')).toThrow(UfNotAnalyzedError);
    expect(() => service('SP', '55', 'HOMOLOGACAO', 'autorizacao')).toThrow(/ainda não foi implementada para SP/);
  });

  it('a matriz cobre as 27 UFs nos 2 modelos e nenhum estado passa de "em desenvolvimento"', () => {
    const rows = coverage();
    expect(rows).toHaveLength(54);
    expect(rows.filter((r) => r.state !== 'NAO_ANALISADO').map((r) => `${r.uf}:${r.model}`).sort()).toEqual(['MG:55', 'MG:65']);
    expect(rows.every((r) => ['NAO_ANALISADO', 'EM_DESENVOLVIMENTO'].includes(r.state))).toBe(true);
  });
});
