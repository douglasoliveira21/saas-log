# Emissão fiscal por provedor (NF-e e NFC-e) — Focus NFe

## Como funciona
O sistema **prepara e valida** a nota (destinatário, regras tributárias aprovadas pelo contador, impostos do motor). A **geração do XML, a assinatura digital e a transmissão à SEFAZ** são feitas pelo provedor **Focus NFe**, na **conta de cada cliente do SaaS**:
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

## O que foi conferido contra a documentação oficial e o que NÃO foi
**Confirmado** (páginas de doc.focusnfe.com.br lidas em 22/10/2026): autenticação HTTP Basic (token como usuário, senha vazia); URLs `https://homologacao.focusnfe.com.br` e `https://api.focusnfe.com.br` (`/v2`); `POST /v2/nfe?ref=` (assíncrono, 202) e `POST /v2/nfce?ref=` (síncrono); `GET`/`DELETE /v2/{nfe|nfce}/{ref}` (cancelamento com `justificativa` de 15 a 255 caracteres); status `autorizado`/`processando_autorizacao`/`erro_autorizacao`/`cancelado`; códigos de erro; nomes dos campos de cabeçalho, emitente, destinatário e itens usados. **Verificado de verdade:** uma chamada real à homologação com token falso devolve 401, que o sistema mostra como "Token recusado".

**NÃO confirmado — exige conta de homologação real:**
- O bloco de **pagamentos da NF-e** (usamos `formas_pagamento`, como na NFC-e; o nome não está nas páginas lidas).
- Campos de **base e valor de ICMS/PIS/COFINS**: por isso **nota com tributo destacado (valor > 0) é BLOQUEADA** na validação em vez de enviada incompleta. Hoje funciona para operações **sem tributo destacado** (ex.: Simples Nacional, CSOSN 102 e PIS/COFINS CST 49 sem valor).
- O formato do link de XML/DANFE e o comportamento exato de reenvio com a mesma referência (a doc não descreve; confirme com o suporte do provedor).
- Se a SEFAZ autoriza de fato: só a homologação real mostra.

## Limites conhecidos
- **ST, DIFAL, FCP, benefício fiscal, monofásico, IBS/CBS**: o motor não calcula (pendência explícita) e o conector não envia.
- Carta de correção, inutilização, contingência offline da NFC-e e eventos além do cancelamento **não** estão implementados.
- Cancelamento: prazo e regras são do estado/provedor (a doc cita 24 h para NF-e e 30 min para NFC-e); o sistema repassa a recusa.
- Webhook do provedor não é usado: o acompanhamento é por consulta (a emissão tenta algumas vezes antes de ficar "aguardando consulta").
- O DANFE vem do provedor (PDF/HTML conforme ele devolver); o espelho de Vendas continua sendo só conferência.
- Outros provedores: o ponto de encaixe é `FiscalProvider` (`fiscal-provider.ts`); só o Focus NFe está implementado.
- **Custos:** o provedor cobra pela emissão em produção (o ambiente de homologação costuma ser gratuito; confirme no site dele). O certificado A1 é custo do cliente.
