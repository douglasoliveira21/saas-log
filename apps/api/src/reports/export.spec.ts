import { unzipSync, strFromU8 } from 'fflate';
import { safeText, toCsv, toXlsx } from './export';

describe('export', () => {
  it('neutraliza fórmulas', () => {
    expect(safeText('=SOMA(A1)')).toBe("'=SOMA(A1)");
    expect(safeText('+55')).toBe("'+55");
    expect(safeText('Normal')).toBe('Normal');
  });

  it('gera CSV com BOM, ponto e vírgula e vírgula decimal', () => {
    const buf = toCsv([{ key: 'a', label: 'Nome' }, { key: 'b', label: 'Valor' }], [{ a: 'Ana; "Silva"', b: 10.5 }, { a: '=cmd', b: 2 }]);
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = buf.toString('utf8').slice(1);
    expect(text).toBe('Nome;Valor\r\n"Ana; ""Silva""";10,5\r\n\'=cmd;2\r\n');
  });

  it('gera XLSX válido (zip com planilha) e escapa XML', () => {
    const buf = toXlsx('Vendas', [{ key: 'a', label: 'Nome' }, { key: 'b', label: 'Valor' }], [{ a: 'A & B <x>', b: 3.5 }]);
    const files = unzipSync(new Uint8Array(buf));
    expect(Object.keys(files)).toContain('xl/worksheets/sheet1.xml');
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']);
    expect(sheet).toContain('A &amp; B &lt;x&gt;');
    expect(sheet).toContain('<v>3.5</v>');
  });
});
