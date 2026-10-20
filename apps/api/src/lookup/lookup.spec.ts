import { mapBrasilApiCep, mapBrasilApiCnpj, mapViaCep, normalizePhone, titleCase } from './lookup';

describe('lookup — normalização', () => {
  it('titleCase preserva preposições, siglas e algarismos romanos', () => {
    expect(titleCase('AVENIDA PAULISTA')).toBe('Avenida Paulista');
    expect(titleCase('RUA DOS TRES IRMAOS')).toBe('Rua dos Tres Irmaos');
    expect(titleCase('SAO JOSE DO RIO PRETO')).toBe('Sao Jose do Rio Preto');
    expect(titleCase('SAUN QUADRA 5 BLOCO B TORRE III')).toBe('Saun Quadra 5 Bloco B Torre III');
    expect(titleCase('  ')).toBeUndefined();
    expect(titleCase(null)).toBeUndefined();
  });

  it('normalizePhone aceita máscara e +55; rejeita tamanhos inválidos', () => {
    expect(normalizePhone('(11) 99999-9999')).toBe('11999999999');
    expect(normalizePhone('+55 11 3333-4444')).toBe('1133334444');
    expect(normalizePhone('11 3333 4444')).toBe('1133334444');
    expect(normalizePhone('99999-9999')).toBeNull(); // sem DDD
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('')).toBeNull();
  });

  it('mapeia a resposta da BrasilAPI (CNPJ) sem inventar campos fiscais', () => {
    const info = mapBrasilApiCnpj({
      cnpj: '00000000000191', razao_social: 'BANCO DO BRASIL SA', nome_fantasia: 'DIRECAO GERAL', cnae_fiscal: 6422100, cnae_fiscal_descricao: 'Bancos múltiplos',
      ddd_telefone_1: '6134939002', email: 'CONTATO@EXEMPLO.COM', descricao_situacao_cadastral: 'ATIVA', descricao_identificador_matriz_filial: 'MATRIZ',
      cep: '70040912', logradouro: 'SAUN QUADRA 5', numero: 'SN', complemento: 'ANDAR T I', bairro: 'ASA NORTE', municipio: 'BRASILIA', uf: 'df', opcao_pelo_simples: false,
    });
    expect(info).toMatchObject({ cnpj: '00000000000191', legalName: 'BANCO DO BRASIL SA', tradeName: 'DIRECAO GERAL', cnae: '6422100', phone: '6134939002', email: 'contato@exemplo.com', active: true, branch: 'MATRIZ' });
    expect(info.address).toMatchObject({ zipCode: '70040912', street: 'Saun Quadra 5', number: 'S/N', district: 'Asa Norte', city: 'Brasilia', state: 'DF' });
    expect(Object.keys(info)).not.toContain('stateRegistration');
    expect(Object.keys(info)).not.toContain('taxRegime');
  });

  it('situação diferente de ATIVA é sinalizada; nome fantasia vazio some', () => {
    const info = mapBrasilApiCnpj({ cnpj: '1', razao_social: 'X LTDA', nome_fantasia: '', descricao_situacao_cadastral: 'BAIXADA' });
    expect(info.active).toBe(false);
    expect(info.status).toBe('BAIXADA');
    expect(info.tradeName).toBeUndefined();
  });

  it('mapeia CEP (BrasilAPI e ViaCEP) e trata "erro" do ViaCEP', () => {
    expect(mapBrasilApiCep({ cep: '01001000', state: 'SP', city: 'São Paulo', neighborhood: 'Sé', street: 'Praça da Sé' })).toMatchObject({ zipCode: '01001000', street: 'Praça da Sé', district: 'Sé', city: 'São Paulo', state: 'SP' });
    expect(mapViaCep({ cep: '01001-000', logradouro: 'Praça da Sé', bairro: 'Sé', localidade: 'São Paulo', uf: 'SP' })).toMatchObject({ zipCode: '01001000', state: 'SP' });
    expect(mapViaCep({ erro: true })).toBeNull();
  });
});
