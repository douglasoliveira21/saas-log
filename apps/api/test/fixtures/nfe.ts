import { buildChave } from '../../src/fiscal/chave';

export interface FixtureItem { code: string; gtin?: string; name: string; ncm?: string; cfop?: string; unit?: string; qty: number; price: number; csosn?: string; cst?: string }

export interface FixtureOpts {
  emitterCnpj: string; recipientCnpj: string; uf?: string; series?: number; number: number; issuedAt?: Date; items: FixtureItem[];
  env?: 1 | 2; protocol?: { cStat: string; nProt?: string } | null; signature?: boolean; freight?: number; installments?: number[]; breakTotal?: boolean; badKeyDv?: boolean;
  wrongKeyCnpj?: boolean;
}

/** Gera uma NF-e 4.00 sintética (apenas para testes), com chave de acesso consistente. */
export function buildNfeXml(o: FixtureOpts): { xml: string; key: string; total: number } {
  const issuedAt = o.issuedAt ?? new Date();
  const uf = o.uf ?? 'SP';
  const series = o.series ?? 1;
  let key = buildChave({ uf, issuedAt, cnpj: o.wrongKeyCnpj ? '00000000000191' : o.emitterCnpj, series, number: o.number, cNF: '12345678' });
  if (o.badKeyDv) key = key.slice(0, 43) + ((Number(key[43]) + 1) % 10);
  const f = (n: number) => n.toFixed(2);
  const prods = o.items.reduce((s, i) => s + Math.round(i.qty * i.price * 100) / 100, 0);
  const freight = o.freight ?? 0;
  const total = Math.round((prods + freight) * 100) / 100;
  const det = o.items.map((i, idx) => `
    <det nItem="${idx + 1}"><prod><cProd>${i.code}</cProd><cEAN>${i.gtin ?? 'SEM GTIN'}</cEAN><xProd>${i.name}</xProd><NCM>${i.ncm ?? '73181500'}</NCM><CFOP>${i.cfop ?? '5102'}</CFOP><uCom>${i.unit ?? 'UN'}</uCom><qCom>${i.qty.toFixed(4)}</qCom><vUnCom>${i.price.toFixed(6)}</vUnCom><vProd>${f(i.qty * i.price)}</vProd><cEANTrib>${i.gtin ?? 'SEM GTIN'}</cEANTrib><uTrib>${i.unit ?? 'UN'}</uTrib><qTrib>${i.qty.toFixed(4)}</qTrib><vUnTrib>${i.price.toFixed(6)}</vUnTrib></prod>
    <imposto><ICMS><${i.csosn ? 'ICMSSN102' : 'ICMS00'}><orig>0</orig>${i.csosn ? `<CSOSN>${i.csosn}</CSOSN>` : `<CST>${i.cst ?? '00'}</CST><vBC>${f(i.qty * i.price)}</vBC><pICMS>18.00</pICMS><vICMS>${f(i.qty * i.price * 0.18)}</vICMS>`}</${i.csosn ? 'ICMSSN102' : 'ICMS00'}></ICMS><PIS><PISAliq><CST>01</CST><vPIS>0.00</vPIS></PISAliq></PIS><COFINS><COFINSAliq><CST>01</CST><vCOFINS>0.00</vCOFINS></COFINSAliq></COFINS></imposto></det>`).join('');
  const dups = (o.installments ?? []).map((v, i) => `<dup><nDup>00${i + 1}</nDup><dVenc>2026-12-${String(10 + i).padStart(2, '0')}</dVenc><vDup>${f(v)}</vDup></dup>`).join('');
  const nfe = `<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe versao="4.00" Id="NFe${key}">
    <ide><cUF>35</cUF><natOp>Venda de mercadoria</natOp><mod>55</mod><serie>${series}</serie><nNF>${o.number}</nNF><dhEmi>${issuedAt.toISOString()}</dhEmi><tpAmb>${o.env ?? 1}</tpAmb></ide>
    <emit><CNPJ>${o.emitterCnpj}</CNPJ><xNome>Fornecedor Teste Ltda</xNome><enderEmit><UF>${uf}</UF></enderEmit><IE>123456789</IE></emit>
    <dest><CNPJ>${o.recipientCnpj}</CNPJ><xNome>Destinatário</xNome></dest>${det}
    <total><ICMSTot><vBC>0.00</vBC><vICMS>0.00</vICMS><vICMSDeson>0.00</vICMSDeson><vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vProd>${f(o.breakTotal ? prods + 5 : prods)}</vProd><vFrete>${f(freight)}</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vOutro>0.00</vOutro><vNF>${f(total)}</vNF></ICMSTot></total>
    <transp><modFrete>0</modFrete></transp>${dups ? `<cobr>${dups}</cobr>` : ''}</infNFe>${o.signature === false ? '' : '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo/></Signature>'}</NFe>`;
  const prot = o.protocol === null ? '' : `<protNFe versao="4.00"><infProt><tpAmb>${o.env ?? 1}</tpAmb><chNFe>${key}</chNFe><nProt>${o.protocol?.nProt ?? '135260000000001'}</nProt><cStat>${o.protocol?.cStat ?? '100'}</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe>`;
  return { xml: `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">${nfe}${prot}</nfeProc>`, key, total };
}
