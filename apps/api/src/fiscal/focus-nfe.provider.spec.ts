import { OutgoingDocument } from './fiscal-provider';
import { buildFocusPayload, FocusNfeProvider } from './focus-nfe.provider';

const document = (over: Partial<OutgoingDocument> = {}): OutgoingDocument => ({
  ref: 'nota-1', model: '55', environment: 'HOMOLOGACAO', issuedAt: new Date('2026-11-02T12:00:00-03:00'),
  presence: 'INTERNET', destination: 2, finalConsumer: false,
  emitter: { cnpj: '45723174000110', name: 'EMPRESA TESTE LTDA', tradeName: 'Teste', street: 'Rua A', number: '1', district: 'Centro', city: 'Belo Horizonte', cMun: '3106200', uf: 'MG', zip: '30110000', ie: '1112223340000', regime: 3, cnae: null },
  recipient: { document: '04252011000110', name: 'CLIENTE TESTE LTDA', ie: null, ieIndicator: 9, street: 'Rua B', number: '2', district: 'Centro', city: 'Rio de Janeiro', cMun: '3304557', uf: 'RJ', zip: '20000000', phone: null, email: null },
  items: [{
    line: 1, sku: 'P-1', description: 'Produto', ncm: '73181500', cfop: '6102', unit: 'UN', quantity: 2, unitValue: 50, total: 100,
    origin: 0, icmsCode: '00', pisCst: '01', cofinsCst: '01', taxAmounts: { icms: 12, pis: 1.65, cofins: 7.6 },
    tax: { icms: { base: 100, rate: 12, amount: 12 }, pis: { base: 100, rate: 1.65, amount: 1.65 }, cofins: { base: 100, rate: 7.6, amount: 7.6 } },
    taxes: {
      ICMS: { cst: '00', base: 100, ratePct: 12, amount: 12 }, PIS: { cst: '01', base: 100, ratePct: 1.65, amount: 1.65 }, COFINS: { cst: '01', base: 100, ratePct: 7.6, amount: 7.6 },
      IPI: { cst: '50', base: 100, ratePct: 5, amount: 5 }, IBS_UF: { cst: '000', classCode: '000001', base: 100, ratePct: 0.1, amount: 0.1 },
      IBS_MUN: { cst: '000', classCode: '000001', base: 100, ratePct: 0, amount: 0 }, CBS: { cst: '000', classCode: '000001', base: 100, ratePct: 0.9, amount: 0.9 },
      IS: { cst: '000', classCode: '000001', base: 100, ratePct: 0.2, amount: 0.2 },
    },
  }],
  totals: { products: 100, freight: 0, total: 100 }, payments: [{ method: 'PIX', amount: 100 }], additionalInfo: 'Pedido 1', ...over,
});

describe('Focus NFe: payload fiscal', () => {
  it('envia impostos legados e da reforma tributária sem omitir valores', () => {
    const payload = buildFocusPayload(document()) as Record<string, unknown>;
    const item = (payload.items as Record<string, unknown>[])[0];
    expect(item).toMatchObject({
      icms_base_calculo: 100, icms_aliquota: 12, icms_valor: 12,
      pis_base_calculo: 100, pis_aliquota_porcentual: 1.65, pis_valor: 1.65,
      cofins_base_calculo: 100, cofins_aliquota_porcentual: 7.6, cofins_valor: 7.6,
      ipi_situacao_tributaria: '50', ipi_codigo_enquadramento_legal: 999, ipi_valor: 5,
      ibs_cbs_situacao_tributaria: '000', ibs_cbs_classificacao_tributaria: '000001', ibs_uf_valor: 0.1, cbs_valor: 0.9,
      is_situacao_tributaria: '000', is_classificacao_tributaria: '000001', is_valor: 0.2,
    });
  });

  it('monta devolução com finalidade e chave referenciada oficiais', () => {
    const key = '31261145723174000110550010000000011000000010';
    expect(buildFocusPayload(document({ returnOf: [key], payments: [] }))).toMatchObject({
      natureza_operacao: 'DEVOLUCAO DE VENDA', tipo_documento: 0, finalidade_emissao: 4, notas_referenciadas: [key],
    });
  });

  it('bloqueia tributo desconhecido para nunca transmitir nota incompleta', () => {
    const doc = document();
    doc.items[0].taxes!.OUTRO = { base: 100, ratePct: 1, amount: 1 };
    expect(new FocusNfeProvider().validate(doc)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'FOCUS_TAX_UNMAPPED' }),
    ]));
  });
});
