import { cceDetail, detEventoOf, eventEnvelope, MANIFEST, manifestDetail } from './messages';
import { validateAgainst } from './xsd';

const KEY = '31261045723174000110550010000001231000001236';
const wrap = (tp: string, det: string, orgao = '31') => eventEnvelope({ tpEvento: tp, chave: KEY, env: 'HOMOLOGACAO', cnpj: '45723174000110', at: '2026-10-22T10:00:00-03:00', seq: 1, orgao, det });

describe('eventos fiscais: CC-e e manifestação do destinatário (leiaute oficial)', () => {
  it('a carta de correção respeita o XSD do evento (texto fixo de condições de uso incluído)', async () => {
    const env = wrap('110110', cceDetail('Corrigir o complemento do endereço de entrega'));
    expect((await validateAgainst('e110110_v1.00.xsd', detEventoOf(env))).valid).toBe(true);
  });

  it('o XSD recusa correção curta, e o envelope não aceita Id de evento fora do padrão', async () => {
    const short = wrap('110110', cceDetail('curta'));
    expect((await validateAgainst('e110110_v1.00.xsd', detEventoOf(short))).valid).toBe(false);
    const badKey = eventEnvelope({ tpEvento: '210210', chave: KEY.slice(0, 43), env: 'HOMOLOGACAO', cnpj: '45723174000110', at: '2026-10-22T10:00:00-03:00', seq: 1, orgao: '91', det: manifestDetail('CIENCIA') });
    expect((await validateAgainst('envEvento_v1.00.xsd', badKey)).valid).toBe(false);
  });

  it.each(Object.keys(MANIFEST))('manifestação %s: detalhe válido no XSD do tipo de evento e órgão 91 aceito no envelope', async (action) => {
    const cfg = MANIFEST[action];
    const det = manifestDetail(action as keyof typeof MANIFEST, cfg.needsReason ? 'Mercadoria não foi entregue no endereço' : undefined);
    const env = wrap(cfg.tp, det, '91');
    expect((await validateAgainst(`e${cfg.tp}_v1.00.xsd`, detEventoOf(env))).errors).toEqual([]);
    expect(env).toContain('<cOrgao>91</cOrgao>');
    expect(env).toContain(`ID${cfg.tp}${KEY}01`);
  });

  it('"operação não realizada" sem justificativa válida é recusada pelo XSD', async () => {
    const env = wrap('210240', manifestDetail('NAO_REALIZADA', 'curta'), '91');
    expect((await validateAgainst('e210240_v1.00.xsd', detEventoOf(env))).valid).toBe(false);
  });
});
