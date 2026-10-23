import * as forge from 'node-forge';
import { buildChave } from '../chave';
import { signXml, verifySignature } from '../sefaz/signature';
import { buildMdfeXml, cancelDetail, closeDetail, consSitMDFe, consStatServMDFe, mdfeEvent, MdfeInput, parseMdfeAuthorization, parseMdfeEvent, parseMdfeSituation, syncBody } from './mdfe-xml';
import { validateMdfe, validateMdfeFull } from './xsd';
import { gunzipSync } from 'node:zlib';

function cert() {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const c = forge.pki.createCertificate();
  c.publicKey = keys.publicKey; c.serialNumber = '01';
  c.validity.notBefore = new Date(Date.now() - 86_400_000); c.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attrs = [{ name: 'commonName', value: 'EMPRESA TESTE:45723174000110' }];
  c.setSubject(attrs); c.setIssuer(attrs); c.sign(keys.privateKey, forge.md.sha256.create());
  return { keyPem: forge.pki.privateKeyToPem(keys.privateKey), certPem: forge.pki.certificateToPem(c) };
}

const CHAVE = buildChave({ uf: 'MG', issuedAt: new Date('2026-10-22T13:00:00Z'), cnpj: '45723174000110', model: '58', series: 1, number: 7, cNF: '12345678' });
const NFE = ['31261045723174000110550010000001231000001236', '31261045723174000110550010000001241000001241'];
const input = (over: Partial<MdfeInput> = {}): MdfeInput => ({
  environment: 'HOMOLOGACAO', chave: CHAVE, issuedAt: new Date('2026-10-22T13:00:00Z'),
  emitter: { cnpj: '45723174000110', ie: '0623079040081', name: 'Distribuidora Teste LTDA', tradeName: 'Distribuidora', street: 'Rua A', number: '10', district: 'Centro', cMun: '3106200', city: 'Belo Horizonte', uf: 'MG', zip: '30110000', phone: '3133334444' },
  load: { cMun: '3106200', city: 'Belo Horizonte' }, ufIni: 'MG', ufFim: 'RJ',
  vehicle: { plate: 'abc-1d23', tareKg: 1500, capKg: 3000, uf: 'MG', tpRod: '04', tpCar: '02' }, driver: { name: 'João da Silva', cpf: '52998224725' },
  unload: [{ cMun: '3304557', city: 'Rio de Janeiro', nfeKeys: NFE }], totals: { nfeCount: 2, value: 1999.9, weightKg: 350.5 }, additionalInfo: 'Viagem 12', procVersion: 'DistribuiHub 1.0', ...over,
});
const signed = (xml: string, c = cert()) => signXml(xml, { ...c, tagToSign: 'infMDFe', after: 'infMDFe' });

describe('MDF-e rodoviário (leiaute 3.00)', () => {
  const c = cert();
  it('a chave tem modelo 58 e o XML assinado respeita o XSD', async () => {
    expect(CHAVE.slice(20, 22)).toBe('58');
    const xml = signed(buildMdfeXml(input()), c);
    const r = await validateMdfeFull(xml);
    expect(r.errors).toEqual([]);
    expect(verifySignature(xml).valid).toBe(true);
    expect(xml).toContain('<tpEmit>2</tpEmit>');
    expect(xml).toContain('<placa>ABC1D23</placa>');
    expect(xml).toContain(`<chNFe>${NFE[0]}</chNFe>`);
  });

  it('o envio síncrono vai compactado (gzip) em base64 e volta ao XML original', () => {
    const xml = signed(buildMdfeXml(input()), c);
    expect(gunzipSync(Buffer.from(syncBody(xml), 'base64')).toString('utf8')).toBe(xml);
  });

  it('o XSD recusa placa inválida e conta de NF-e fora do padrão (o que o XSD não pega, o serviço bloqueia antes de enviar)', async () => {
    const bad = await validateMdfeFull(signed(buildMdfeXml(input({ vehicle: { plate: '12', tareKg: 1500, uf: 'MG', tpRod: '04', tpCar: '02' } })), c));
    expect(bad.valid).toBe(false);
    expect(bad.errors.map((e) => e.message).join(' ')).toMatch(/placa/i);
    const noKeys = await validateMdfeFull(signed(buildMdfeXml(input({ unload: [{ cMun: '3304557', city: 'Rio de Janeiro', nfeKeys: ['123'] }] })), c));
    expect(noKeys.valid).toBe(false); // chave com tamanho errado
  });

  it('eventos de cancelamento e encerramento e as consultas respeitam o XSD', async () => {
    const at = '2026-10-22T14:00:00-03:00';
    const sign = (x: string) => signXml(x, { ...c, tagToSign: 'infEvento', after: 'infEvento' });
    const cancel = sign(mdfeEvent({ tp: '110111', chave: CHAVE, env: 'HOMOLOGACAO', cnpj: '45723174000110', at, det: cancelDetail('131260000000123', 'Viagem cancelada por erro de lançamento') }));
    expect((await validateMdfe('eventoMDFe_v3.00.xsd', cancel)).errors).toEqual([]);
    const close = sign(mdfeEvent({ tp: '110112', chave: CHAVE, env: 'HOMOLOGACAO', cnpj: '45723174000110', at, det: closeDetail('131260000000123', '2026-10-23', '33', '3304557') }));
    expect((await validateMdfe('eventoMDFe_v3.00.xsd', close)).errors).toEqual([]);
    expect((await validateMdfe('consSitMDFe_v3.00.xsd', consSitMDFe(CHAVE, 'HOMOLOGACAO'))).errors).toEqual([]);
    expect((await validateMdfe('consStatServMDFe_v3.00.xsd', consStatServMDFe('HOMOLOGACAO'))).errors).toEqual([]);
  });

  it('lê as respostas de autorização, situação e evento', () => {
    const NS = 'http://www.portalfiscal.inf.br/mdfe';
    const prot = `<protMDFe xmlns="${NS}" versao="3.00"><infProt><tpAmb>2</tpAmb><verAplic>RS</verAplic><chMDFe>${CHAVE}</chMDFe><dhRecbto>2026-10-22T13:01:00-03:00</dhRecbto><nProt>931260000000123</nProt><digVal>abc</digVal><cStat>100</cStat><xMotivo>Autorizado o uso do MDF-e</xMotivo></infProt></protMDFe>`;
    const a = parseMdfeAuthorization(`<retMDFe xmlns="${NS}" versao="3.00"><tpAmb>2</tpAmb><cUF>31</cUF><verAplic>RS</verAplic><cStat>104</cStat><xMotivo>Lote processado</xMotivo>${prot}</retMDFe>`);
    expect(a.prot).toMatchObject({ cStat: '100', protocol: '931260000000123' });
    expect(a.prot!.raw).toContain('<protMDFe');
    const s = parseMdfeSituation(`<retConsSitMDFe xmlns="${NS}" versao="3.00"><tpAmb>2</tpAmb><verAplic>RS</verAplic><cStat>132</cStat><xMotivo>Encerrado</xMotivo></retConsSitMDFe>`);
    expect(s).toMatchObject({ cStat: '132', closed: true, cancelled: false });
    const e = parseMdfeEvent(`<retEventoMDFe xmlns="${NS}" versao="3.00"><infEvento><tpAmb>2</tpAmb><cStat>135</cStat><xMotivo>Evento registrado</xMotivo><nProt>931260000000999</nProt></infEvento></retEventoMDFe>`);
    expect(e.event).toMatchObject({ cStat: '135', protocol: '931260000000999' });
  });
});
