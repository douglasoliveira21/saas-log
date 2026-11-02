# Emissão fiscal por provedor (NF-e e NFC-e) — Focus NFe

## Como funciona
O sistema **prepara e valida** a nota (destinatário, regras tributárias ativas, impostos do motor). A **geração do XML, a assinatura digital e a transmissão à SEFAZ** são feitas pelo provedor **Focus NFe**, na **conta de cada cliente do SaaS**:
1. O cliente cria a conta no Focus NFe, cadastra a empresa, o **certificado A1** e (NFC-e) o **CSC** no painel dele.
2. Em Fiscal → Configuração → *Provedor de emissão*, cola o **token** de homologação e/ou produção (cifrado no servidor; só os 4 últimos caracteres voltam à tela). O botão **Testar** confere o token sem emitir nada.
3. Em Fiscal → Notas de saída: **Preparar** (a partir do pedido; NF-e ou NFC-e conforme escolhido na venda, mais a forma de pagamento) → **Transmitir** → acompanhar → **Ver DANFE / Baixar XML** → **Cancelar** (se necessário).

Cada estabelecimento usa o seu token; o ambiente (homologação/produção) é o definido na configuração fiscal. **Comece sempre pela homologação** (sem valor fiscal).

## Segurança da emissão (o que o sistema garante)
- A **referência** enviada ao provedor é o id do documento: reenviar nunca cria uma segunda nota. O provedor numera (não enviamos número/série) e devolve a chave ao autorizar.
- Timeout/queda de rede/resposta desconhecida ⇒ **Aguardando consulta**: **proibido reenviar**; só "Consultar situação" (pela referência). Se o provedor não conhece a referência, libera o reenvio seguro.
- Rejeição volta com o **motivo** (SEFAZ/provedor) e permite corrigir e reenviar. Autorização é confirmada pelo status do provedor (uma NFC-e rejeitada também responde 201: o sistema lê o `status`, não só o código HTTP).
- O **XML autorizado** é copiado para o nosso arquivo (guarda legal, imutável); o DANFE vem do provedor. Os caminhos de arquivo devolvidos pelo provedor são **validados** (só caminho relativo, sempre no host do provedor: sem SSRF).
- O token nunca é registrado em log nem na auditoria; a tabela guarda só o valor cifrado (AES-256-GCM, chave por empresa) com RLS.
- Sem token, **Transmitir** responde 424 e **não consome nada**.

## Conferência contra a documentação oficial
Revisado em 02/11/2026 contra a referência oficial do Focus NFe: autenticação, ambientes, emissão/consulta/cancelamento, pagamentos, ICMS, PIS, COFINS, IPI, IBS/CBS, Imposto Seletivo, devolução referenciada, CC-e, inutilização e caminhos do XML/DANFE. Os payloads têm testes automatizados. A autorização real continua dependendo da conta, credenciamento, certificado e parametrização do cliente e deve ser comprovada no ambiente de homologação antes da produção.

## Limites conhecidos
- O motor calcula tributos percentuais configurados pelo responsável fiscal, inclusive IBS/CBS e Imposto Seletivo. **ST, DIFAL e FCP** continuam como pendência explícita por exigirem bases específicas.
- O conector envia ICMS, PIS, COFINS, IPI, IBS/CBS e Imposto Seletivo. Tributo desconhecido com valor diferente de zero bloqueia a transmissão para impedir XML incompleto.
- Cancelamento, CC-e e inutilização estão implementados. Contingência offline da NFC-e e eventos de entrega não estão.
- Devolução de venda gera NF-e de entrada, finalidade 4, chave original referenciada e exige regra aprovada para `RETURN_SALE`.
- Cancelamento: prazo e regras são do estado/provedor (a doc cita 24 h para NF-e e 30 min para NFC-e); o sistema repassa a recusa.
- Webhook do provedor não é usado: o acompanhamento é por consulta (a emissão tenta algumas vezes antes de ficar "aguardando consulta").
- O DANFE vem do provedor (PDF/HTML conforme ele devolver); o espelho de Vendas continua sendo só conferência.
- A emissão direta na SEFAZ existe para a cobertura declarada no registro de UFs; o Focus NFe é o caminho nacional recomendado.
- MDF-e é assinado com o A1 local e transmitido diretamente à SVRS, mesmo quando NF-e/NFC-e usam Focus NFe.
- **Custos:** o provedor cobra pela emissão em produção (o ambiente de homologação costuma ser gratuito; confirme no site dele). O certificado A1 é custo do cliente.

## NFC-e acima do limite do cupom (divisão automática)
Configurável em Configurações → *Cupom fiscal (NFC-e)* (`fiscal.nfceMaxValue`, padrão R$ 9.999,00; `0` desliga). Ao preparar uma NFC-e cujo pedido passa do limite, o sistema cria **vários documentos** ("cupom N/M") do mesmo pedido: cálculo em centavos, soma exata, unidade nunca partida, frete no primeiro cupom. Cada cupom tem numeração, chave e transmissão próprias (uma falha não derruba os outros). Uma unidade acima do limite recusa a preparação. Não vale para NF-e. Ex.: R$ 400.000,00 → 41 cupons. **Pendente:** transmitir todos de uma vez (hoje um a um) e confirmar com a SEFAZ da UF se o fracionamento é aceito para o caso de uso.
