import * as forge from 'node-forge';

export interface CertPem { keyPem: string; certPem: string; chainPem: string[]; certBase64: string; cnpj: string | null; notAfter: Date }

/** Extrai chave privada e certificados do .pfx (A1) em memória. Nunca registra a senha nem o conteúdo. */
export function pfxToPem(pfx: Buffer, password: string): CertPem {
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary'))), password);
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []).map((b) => b.cert).filter((c): c is forge.pki.Certificate => !!c);
  const keyBags = [...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []), ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? [])];
  const key = keyBags[0]?.key as forge.pki.rsa.PrivateKey | undefined;
  if (!key || !certs.length) throw new Error('O arquivo não contém chave privada e certificado.');
  const own = certs.find((c) => (c.publicKey as forge.pki.rsa.PublicKey).n.toString(16) === key.n.toString(16));
  if (!own) throw new Error('A chave privada não corresponde a nenhum certificado do arquivo.');
  const cn = (own.subject.getField('CN')?.value as string | undefined) ?? '';
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(own)).getBytes();
  return {
    keyPem: forge.pki.privateKeyToPem(key), certPem: forge.pki.certificateToPem(own),
    chainPem: certs.filter((c) => c !== own).map((c) => forge.pki.certificateToPem(c)), certBase64: Buffer.from(der, 'binary').toString('base64'),
    cnpj: cn.match(/(\d{14})/)?.[1] ?? null, notAfter: own.validity.notAfter,
  };
}
