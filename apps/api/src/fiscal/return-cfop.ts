/**
 * CFOP da NF-e de devolução de venda (entrada própria) a partir do CFOP da venda original. Só os pares abaixo são suportados; qualquer outro CFOP
 * precisa ser tratado manualmente com o contador (o sistema recusa em vez de adivinhar).
 */
const MAP: Record<string, string> = {
  '5101': '1201', '6101': '2201', // venda de produção do estabelecimento
  '5102': '1202', '6102': '2202', // venda de mercadoria adquirida ou recebida de terceiros
  '5403': '1411', '6403': '2411', '5405': '1411', '6404': '2411', // com substituição tributária
  '5949': '1949', '6949': '2949', // outra saída
};
export const returnCfop = (cfop: string): string | null => MAP[cfop.trim()] ?? null;
