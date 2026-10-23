import { barcodeSvg, formatKey, parseNfe, renderDanfce, renderDanfe } from './danfe';

const KEY = '31261045723174000110550010000001231000001236';
const nfe = (over: { mod?: string; tpAmb?: string; prot?: boolean; xProd?: string; supl?: boolean } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe${KEY}" versao="4.00">
<ide><cUF>31</cUF><natOp>Venda de mercadoria</natOp><mod>${over.mod ?? '55'}</mod><serie>1</serie><nNF>123</nNF><dhEmi>2026-10-22T10:30:00-03:00</dhEmi><tpNF>1</tpNF><tpAmb>${over.tpAmb ?? '1'}</tpAmb></ide>
<emit><CNPJ>45723174000110</CNPJ><xNome>Distribuidora &amp; Cia</xNome><enderEmit><xLgr>Rua A</xLgr><nro>10</nro><xBairro>Centro</xBairro><xMun>Belo Horizonte</xMun><UF>MG</UF><CEP>30000000</CEP></enderEmit><IE>1234567890123</IE></emit>
<dest><CNPJ>11222333000181</CNPJ><xNome>Cliente Teste</xNome><enderDest><xLgr>Rua B</xLgr><nro>5</nro><xBairro>Bairro</xBairro><xMun>Contagem</xMun><UF>MG</UF><CEP>32000000</CEP></enderDest><IE>ISENTO</IE></dest>
<det nItem="1"><prod><cProd>P1</cProd><xProd>${over.xProd ?? 'Parafuso'}</xProd><NCM>73181500</NCM><CFOP>5102</CFOP><uCom>UN</uCom><qCom>10.0000</qCom><vUnCom>2.5000</vUnCom><vProd>25.00</vProd></prod><imposto><ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS></imposto></det>
<det nItem="2"><prod><cProd>P2</cProd><xProd>Porca</xProd><NCM>73181600</NCM><CFOP>5102</CFOP><uCom>UN</uCom><qCom>4.0000</qCom><vUnCom>1.0000</vUnCom><vProd>4.00</vProd></prod><imposto><ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS></imposto></det>
<total><ICMSTot><vBC>0.00</vBC><vICMS>0.00</vICMS><vBCST>0.00</vBCST><vST>0.00</vST><vProd>29.00</vProd><vFrete>1.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vOutro>0.00</vOutro><vIPI>0.00</vIPI><vNF>30.00</vNF></ICMSTot></total>
<transp><modFrete>9</modFrete></transp><cobr><dup><nDup>001</nDup><dVenc>2026-11-22</dVenc><vDup>30.00</vDup></dup></cobr>
<pag><detPag><tPag>15</tPag><vPag>30.00</vPag></detPag></pag><infAdic><infCpl>Pedido 77 - obrigado</infCpl></infAdic></infNFe>
${over.supl === false ? '' : `<infNFeSupl><qrCode>https://exemplo.fazenda.gov.br/nfce?p=${KEY}|2|1|1|ABCDEF</qrCode><urlChave>https://exemplo.fazenda.gov.br/consulta</urlChave></infNFeSupl>`}</NFe>
${over.prot === false ? '' : `<protNFe versao="4.00"><infProt><tpAmb>1</tpAmb><chNFe>${KEY}</chNFe><dhRecbto>2026-10-22T10:31:00-03:00</dhRecbto><nProt>131260000012345</nProt><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe>`}</nfeProc>`;

describe('DANFE e DANFE NFC-e gerados do XML autorizado', () => {
  it('lê o XML: chave, protocolo e modelo', () => {
    const p = parseNfe(nfe());
    expect(p).toMatchObject({ model: '55', key: KEY, protocol: '131260000012345', cStat: '100', env: '1' });
    expect(() => parseNfe('<outro/>')).toThrow(/infNFe/);
  });

  it('o DANFE traz emitente, destinatário, itens, totais, duplicata, pagamento, chave e código de barras', () => {
    const html = renderDanfe(nfe());
    expect(html).toContain('Distribuidora &amp; Cia');
    expect(html).toContain('45.723.174/0001-10');
    expect(html).toContain('Cliente Teste');
    expect(html).toContain('11.222.333/0001-81');
    expect(html).toContain('Parafuso');
    expect(html).toContain('73181500');
    expect(html).toContain('102'); // CSOSN
    expect(html).toContain('30,00'); // total da nota
    expect(html).toContain('001 · 22/11/2026 · R$ 30,00');
    expect(html).toContain('Boleto bancário');
    expect(html).toContain(formatKey(KEY));
    expect(html).toContain('131260000012345 - 22/10/2026 10:31:00');
    expect(html).toMatch(/<svg[\s\S]*<\/svg>/); // código de barras
    expect(html).not.toContain('SEM VALOR FISCAL');
    expect(html).toContain('Pedido 77 - obrigado');
  });

  it('marca homologação e documento sem protocolo; escapa HTML do XML (nada de script)', () => {
    expect(renderDanfe(nfe({ tpAmb: '2' }))).toContain('AMBIENTE DE HOMOLOGAÇÃO');
    expect(renderDanfe(nfe({ prot: false }))).toContain('NÃO É UM DANFE VÁLIDO');
    const evil = renderDanfe(nfe({ xProd: '&lt;script&gt;alert(1)&lt;/script&gt;' }));
    expect(evil).not.toMatch(/<script>alert/);
    expect(evil).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('o DANFE NFC-e em bobina traz itens, pagamento, chave e QR Code', async () => {
    const html = await renderDanfce(nfe({ mod: '65' }));
    expect(html).toContain('DANFE NFC-e');
    expect(html).toContain('Parafuso');
    expect(html).toContain('Valor a pagar R$');
    expect(html).toContain('CONSUMIDOR');
    expect(html).toContain(formatKey(KEY));
    expect(html).toContain('https://exemplo.fazenda.gov.br/consulta');
    expect(html).toMatch(/<svg[\s\S]*<\/svg>/); // QR
    expect(html).toContain('80mm');
  });

  it('código de barras da chave: Code 128 com a largura esperada para 44 dígitos', () => {
    const svg = barcodeSvg(KEY);
    expect(svg).toMatch(/^<svg/);
    // Code C: início (11) + 22 pares de dígitos (22×11) + dígito verificador (11) + parada (13) = 277 módulos
    expect(svg).toMatch(/viewBox="0 0 277 /);
  });
});
