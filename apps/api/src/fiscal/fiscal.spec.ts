import { buildNfeXml } from '../../test/fixtures/nfe';
import { buildChave, chaveDv, isValidChave, isValidGtin, parseChave } from './chave';
import { calculate, RuleCandidate } from './engine';
import { NfeParseError, parseNfe, validateNfe } from './nfe-xml';

const EMIT = '11222333000181';
const DEST = '45723174000110';
const base = { emitterCnpj: EMIT, recipientCnpj: DEST, number: 1234, items: [{ code: 'P1', name: 'Parafuso', qty: 10, price: 2.5, gtin: '7891234567895' }] };
const codes = (xml: string, docs = [DEST]) => validateNfe(parseNfe(xml), { establishmentDocs: docs }).map((i) => `${i.severity}:${i.code}`);

describe('chave de acesso e GTIN', () => {
  it('gera e valida a chave (módulo 11) e decompõe seus campos', () => {
    const k = buildChave({ uf: 'SP', issuedAt: new Date('2026-03-10T12:00:00Z'), cnpj: EMIT, series: 1, number: 99, cNF: '00000001' });
    expect(k).toHaveLength(44);
    expect(isValidChave(k)).toBe(true);
    expect(isValidChave(k.slice(0, 43) + ((Number(k[43]) + 1) % 10))).toBe(false);
    expect(parseChave(k)).toMatchObject({ uf: 'SP', ufCode: '35', yearMonth: '2603', cnpj: EMIT, model: '55', series: 1, number: 99 });
    expect(chaveDv('3526031122233300018155001000000099100000001')).toBe(Number(k[43]));
  });
  it('valida dígito verificador de GTIN', () => {
    expect(isValidGtin('7891234567895')).toBe(true);
    expect(isValidGtin('7891234567896')).toBe(false);
    expect(isValidGtin('12345')).toBe(false);
    expect(isValidGtin('4006381333931')).toBe(true);
  });
});

describe('leitura e validação de NF-e', () => {
  it('lê chave, emitente, itens, totais, duplicatas e protocolo', () => {
    const { xml, key } = buildNfeXml({ ...base, installments: [12.5, 12.5], freight: 0 });
    const n = parseNfe(xml);
    expect(n).toMatchObject({ accessKey: key, model: '55', series: 1, number: 1234, version: '4.00', environment: 'PRODUCAO', hasSignature: true });
    expect(n.emitter).toMatchObject({ doc: EMIT, uf: 'SP' });
    expect(n.items[0]).toMatchObject({ supplierCode: 'P1', ncm: '73181500', cfop: '5102', quantity: 10, unitValue: 2.5, totalValue: 25, gtin: '7891234567895' });
    expect(n.totals.vNF).toBe(25);
    expect(n.installments).toHaveLength(2);
    expect(n.protocol).toMatchObject({ statusCode: '100' });
  });

  it('nota íntegra só gera o aviso permanente de autenticidade não verificada', () => {
    expect(codes(buildNfeXml({ ...base, installments: [25] }).xml)).toEqual(['INFO:AUTHENTICITY_UNVERIFIED']);
  });

  it('bloqueia: chave com DV inválido, chave inconsistente, destinatário estranho, protocolo não autorizado, total quebrado', () => {
    expect(codes(buildNfeXml({ ...base, badKeyDv: true }).xml)).toContain('BLOCKING:KEY_INVALID');
    expect(codes(buildNfeXml({ ...base, wrongKeyCnpj: true }).xml)).toContain('BLOCKING:KEY_MISMATCH');
    expect(codes(buildNfeXml(base).xml, ['99999999000199'])).toContain('BLOCKING:RECIPIENT_NOT_ESTABLISHMENT');
    expect(codes(buildNfeXml({ ...base, protocol: { cStat: '110' } }).xml)).toContain('BLOCKING:NOT_AUTHORIZED');
    expect(codes(buildNfeXml({ ...base, breakTotal: true }).xml)).toContain('BLOCKING:TOTAL_PRODUCTS_MISMATCH');
  });

  it('avisa: homologação, sem protocolo, sem assinatura, NCM/GTIN/CFOP suspeitos, duplicatas divergentes', () => {
    const c = codes(buildNfeXml({ ...base, env: 2, protocol: null, signature: false, installments: [10], items: [{ code: 'P1', name: 'X', qty: 1, price: 25, ncm: '1234', gtin: '7891234567896', cfop: '1102' }] }).xml);
    expect(c).toEqual(expect.arrayContaining(['WARNING:HOMOLOGATION_DOCUMENT', 'WARNING:NO_PROTOCOL', 'WARNING:NO_SIGNATURE', 'WARNING:NCM_FORMAT', 'WARNING:GTIN_INVALID', 'WARNING:CFOP_UNEXPECTED', 'WARNING:INSTALLMENTS_MISMATCH']));
  });

  it('rejeita lixo, não-NF-e, DOCTYPE/ENTITY (XXE) e arquivos grandes', () => {
    expect(() => parseNfe('isto não é xml <')).toThrow(NfeParseError);
    expect(() => parseNfe('<outra><coisa/></outra>')).toThrow(/não é uma NF-e/);
    expect(() => parseNfe('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a SYSTEM "file:///etc/passwd">]><NFe/>')).toThrow(/DOCTYPE/);
    expect(() => parseNfe('<a>' + 'x'.repeat(2.1 * 1024 * 1024) + '</a>')).toThrow(/2 MB/);
  });
});

const rule = (o: Partial<RuleCandidate> & { rate?: number; cfop?: string; extra?: object }): RuleCandidate => ({
  ruleId: o.ruleId ?? 'r1', name: o.name ?? 'Regra', operation: 'SALE', originUf: null, destUf: null, ncmPrefix: null, regime: null, productOrigin: null, recipientKind: null, priority: 0,
  ...o,
  version: o.version ?? { id: `${o.ruleId ?? 'r1'}-v1`, version: 1, validFrom: new Date('2026-01-01'), validTo: null, sourceReference: 'Parecer do contador 12/2026', config: { cfop: o.cfop ?? '5102', taxes: { ICMS: { csosn: '102', ratePct: o.rate ?? 10 }, ...(o.extra ?? {}) } } },
});

const input = { operation: 'SALE' as const, date: new Date('2026-06-01'), originUf: 'SP', destUf: 'RJ', regime: 'SIMPLES_NACIONAL', items: [{ key: 'a', ncm: '73181500', value: 200 }] };

describe('motor fiscal', () => {
  it('sem regra aprovada devolve PENDÊNCIA, nunca alíquota presumida', () => {
    const r = calculate(input, []);
    expect(r.ready).toBe(false);
    expect(r.pendencies[0]).toMatchObject({ code: 'NO_RULE', itemKey: 'a' });
    expect(r.totals).toEqual({});
  });

  it('aplica os parâmetros da regra, com base reduzida e frete na base quando a regra manda', () => {
    const r = calculate({ ...input, items: [{ key: 'a', ncm: '73181500', value: 200, freight: 20 }] }, [rule({ rate: 12, cfop: '6102', extra: { PIS: { cst: '01', ratePct: 1.65, baseReductionPct: 50 } } })]);
    expect(r.ready).toBe(true);
    expect(r.items[0]).toMatchObject({ cfop: '6102', taxes: { ICMS: { base: 200, ratePct: 12, amount: 24, csosn: '102' }, PIS: { base: 100, amount: 1.65 } } });
    const withFreight = rule({ rate: 10 });
    withFreight.version.config.includeFreightInBase = true;
    expect(calculate({ ...input, items: [{ key: 'a', ncm: '73181500', value: 200, freight: 20 }] }, [withFreight]).items[0].taxes.ICMS.amount).toBe(22);
  });

  it('escolhe por prioridade e especificidade (NCM mais longo vence); empate exato é ambíguo', () => {
    const general = rule({ ruleId: 'g', name: 'Geral', rate: 5 });
    const ncm = rule({ ruleId: 'n', name: 'NCM 7318', ncmPrefix: '7318', rate: 7 });
    const ncm2 = rule({ ruleId: 'n2', name: 'NCM 731815', ncmPrefix: '731815', rate: 9 });
    expect(calculate(input, [general, ncm]).items[0].taxes.ICMS.ratePct).toBe(7);
    expect(calculate(input, [general, ncm, ncm2]).items[0].taxes.ICMS.ratePct).toBe(9);
    expect(calculate(input, [general, ncm, { ...ncm2, priority: 0 }, rule({ ruleId: 'p', priority: 5, rate: 1 })]).items[0].taxes.ICMS.ratePct).toBe(1);
    const a = rule({ ruleId: 'a', name: 'A', destUf: 'RJ', rate: 1 });
    const b = rule({ ruleId: 'b', name: 'B', originUf: 'SP', rate: 2 });
    const amb = calculate(input, [a, b]);
    expect(amb.pendencies[0].code).toBe('AMBIGUOUS_RULE');
    expect(amb.ready).toBe(false);
  });

  it('respeita UF, regime, operação e vigência da versão', () => {
    expect(calculate(input, [rule({ destUf: 'MG' })]).pendencies[0].code).toBe('NO_RULE');
    expect(calculate(input, [rule({ regime: 'LUCRO_REAL' })]).pendencies[0].code).toBe('NO_RULE');
    expect(calculate(input, [rule({ operation: 'PURCHASE' })]).pendencies[0].code).toBe('NO_RULE');
    const old = rule({});
    old.version.validTo = new Date('2026-03-31');
    expect(calculate(input, [old]).pendencies[0].code).toBe('NO_RULE');
    expect(calculate({ ...input, date: new Date('2026-03-01') }, [old]).ready).toBe(true);
  });

  it('ST/DIFAL/FCP e dados faltantes viram pendência explícita', () => {
    const st = calculate(input, [rule({ extra: { ICMS_ST: { kind: 'ST', ratePct: 18 } } })]);
    expect(st.pendencies.find((p) => p.code === 'UNSUPPORTED_TAX')?.message).toMatch(/ainda não é calculado/);
    expect(st.ready).toBe(false);
    expect(calculate({ ...input, items: [{ key: 'a', ncm: null, value: 10 }] }, [rule({})]).pendencies[0].code).toBe('MISSING_DATA');
    expect(calculate({ ...input, destUf: null }, [rule({})]).pendencies.some((p) => p.code === 'MISSING_DATA')).toBe(true);
  });

  it('é reprodutível e registra a regra/versão/fonte usadas', () => {
    const rules = [rule({ rate: 12 })];
    const a = calculate(input, rules);
    expect(calculate(input, rules)).toEqual(a);
    expect(a.rulesUsed[0]).toMatchObject({ versionId: 'r1-v1', version: 1, sourceReference: 'Parecer do contador 12/2026' });
    expect(a.engineVersion).toBe('1.0.0');
  });
});
