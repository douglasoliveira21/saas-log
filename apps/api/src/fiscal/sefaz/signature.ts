import { SignedXml } from 'xml-crypto';

// Algoritmos exigidos pelo leiaute da NF-e/NFC-e (assinatura RSA-SHA1, resumo SHA-1, canonicalização C14N 1.0 e transformação enveloped).
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
const SHA1 = 'http://www.w3.org/2000/09/xmldsig#sha1';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

const bare = (pem: string) => pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');

/**
 * Assina o elemento `tagToSign` (que tem o atributo Id) e insere <Signature> como irmã logo depois de `after` (infNFe; ou infNFeSupl na NFC-e;
 * nos eventos e inutilização, dentro do próprio elemento raiz).
 */
export function signXml(xml: string, o: { keyPem: string; certPem: string; tagToSign: string; after: string }): string {
  const sig = new SignedXml({ privateKey: o.keyPem, publicCert: o.certPem, signatureAlgorithm: RSA_SHA1, canonicalizationAlgorithm: C14N, getKeyInfoContent: () => `<X509Data><X509Certificate>${bare(o.certPem)}</X509Certificate></X509Data>` });
  sig.addReference({ xpath: `//*[local-name(.)='${o.tagToSign}']`, transforms: [ENVELOPED, C14N], digestAlgorithm: SHA1 });
  sig.computeSignature(xml, { location: { reference: `//*[local-name(.)='${o.after}']`, action: 'after' } });
  return sig.getSignedXml();
}

/** Confere a assinatura de um XML assinado (usa a chave pública do certificado embutido). Serve aos testes e à conferência do retorno. */
export function verifySignature(xml: string, certPem?: string): { valid: boolean; errors: string[] } {
  const sigs = [...xml.matchAll(/<Signature[\s\S]*?<\/Signature>/g)];
  if (!sigs.length) return { valid: false, errors: ['Sem <Signature>.'] };
  const sigText = sigs[sigs.length - 1][0];
  // Sem certificado informado usa o que vem dentro da própria assinatura (confere INTEGRIDADE e autoria da chave embutida, não a cadeia de confiança).
  const embedded = /<X509Certificate>([\s\S]*?)<\/X509Certificate>/.exec(sigText)?.[1]?.replace(/\s+/g, '');
  const pem = certPem ?? (embedded ? ['-----BEGIN CERTIFICATE-----', ...(embedded.match(/.{1,64}/g) ?? []), '-----END CERTIFICATE-----'].join('\n') : undefined);
  if (!pem) return { valid: false, errors: ['Assinatura sem certificado.'] };
  const v = new SignedXml({ publicCert: pem });
  v.loadSignature(sigText);
  const valid = v.checkSignature(xml);
  return { valid, errors: valid ? [] : ['assinatura inválida ou documento alterado depois de assinado'] };
}
