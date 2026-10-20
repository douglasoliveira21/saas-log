import { mapImportRows, parseCsv, parseDecimal } from './csv';
import { isValidCpf } from '../common/cnpj';

describe('CSV', () => {
  it('detecta ; e vírgula e respeita aspas', () => {
    expect(parseCsv('a;b\n1;"x;y"')).toEqual([['a', 'b'], ['1', 'x;y']]);
    expect(parseCsv('a,b\r\n1,"he said ""hi"""\r\n')).toEqual([['a', 'b'], ['1', 'he said "hi"']]);
  });
  it('lê números no padrão brasileiro', () => {
    expect(parseDecimal('1.234,56')).toBe(1234.56);
    expect(parseDecimal('R$ 3,90')).toBe(3.9);
    expect(parseDecimal('12.5')).toBe(12.5);
    expect(parseDecimal('abc')).toBeNaN();
  });
  it('valida cabeçalho, duplicidades e campos', () => {
    expect(mapImportRows('foo;bar\n1;2').errors[0].message).toMatch(/sku/);
    const { rows, errors } = mapImportRows('SKU;Nome;NCM;Custo\nA1;Item;12345678;1,5\nA1;Dup;;\nA2;X;123;\nA3;Ok;;-1');
    expect(rows).toHaveLength(1);
    expect(errors.map((e) => e.line)).toEqual([3, 4, 5]);
  });
  it('limita linhas', () => {
    const big = 'sku;nome\n' + Array.from({ length: 5001 }, (_, i) => `S${i};N${i}`).join('\n');
    expect(mapImportRows(big).errors[0].message).toMatch(/Limite/);
  });
});

describe('CPF', () => {
  it('valida dígitos', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true);
    expect(isValidCpf('529.982.247-24')).toBe(false);
  });
});
