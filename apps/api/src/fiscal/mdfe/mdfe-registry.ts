/**
 * Endereços dos serviços do MDF-e 3.00. O MDF-e é atendido nacionalmente pela SEFAZ Virtual do Rio Grande do Sul (SVRS), para todas as UFs.
 * FONTE (oficial): página "Serviços" do Portal do MDF-e da SVRS (dfe-portal.svrs.rs.gov.br/Mdfe/Servicos), lida em 23/10/2026.
 * Nomes de operação/método conferidos com o projeto de código aberto sped-mdfe (cruzamento, não fonte oficial): o WSDL não pôde ser lido
 * automaticamente (cadeia ICP-Brasil). NUNCA foi executado contra o serviço real.
 */
export type MdfeServiceKey = 'recepcao' | 'evento' | 'consulta' | 'status';
export type MdfeEnvName = 'HOMOLOGACAO' | 'PRODUCAO';
const BASE: Record<MdfeEnvName, string> = { PRODUCAO: 'https://mdfe.svrs.rs.gov.br/ws', HOMOLOGACAO: 'https://mdfe-homologacao.svrs.rs.gov.br/ws' };
const PATH: Record<MdfeServiceKey, string> = {
  recepcao: 'MDFeRecepcaoSinc/MDFeRecepcaoSinc.asmx', evento: 'MDFeRecepcaoEvento/MDFeRecepcaoEvento.asmx', consulta: 'MDFeConsulta/MDFeConsulta.asmx', status: 'MDFeStatusServico/MDFeStatusServico.asmx',
};
export const MDFE_SOURCE = 'Portal do MDF-e (SVRS), página Serviços, consultada em 23/10/2026';

export function mdfeService(_uf: string, env: MdfeEnvName, key: MdfeServiceKey): { url: string; version: '3.00'; source: string } {
  return { url: `${BASE[env]}/${PATH[key]}`, version: '3.00', source: MDFE_SOURCE };
}
