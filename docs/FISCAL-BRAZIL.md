# Fiscal — Brasil (Fase 6)

> **Aviso:** o sistema auxilia a configuração e a validação, **não substitui o contador**. Nenhuma alíquota, CST/CSOSN, CFOP, NCM ou regra de ST/DIFAL vem pré-cadastrada. O que não puder ser determinado com segurança vira **pendência**, nunca um palpite.

## Estado por funcionalidade
| Funcionalidade | Estado |
|---|---|
| Assistente de configuração fiscal por estabelecimento (pendências, aptidão para homologação/produção, perguntas ao contador) | **Concluída** |
| Validação da configuração pelo contador (quem/quando; qualquer mudança reabre a validação) | **Concluída** |
| Certificado digital A1 (.pfx): validação de senha/validade/chave privada, armazenamento cifrado, substituição, alerta de vencimento | **Concluída** (a cadeia ICP-Brasil **não** é verificada — ver abaixo) |
| Importação de NF-e recebida (XML 4.00): estrutura, chave (DV mód. 11 e consistência com os campos), destinatário, protocolo, totais, duplicidade, XXE | **Concluída** |
| Vínculo de itens (código do fornecedor memorizado, GTIN, manual), conversão de unidade de compra | **Concluída** |
| Conciliação nota × ordem de compra (quantidade, custo, itens fora da OC) e recebimento físico idempotente | **Concluída** |
| Motor fiscal versionado (regras do tenant, vigência, aprovação, snapshot reprodutível) | **Concluída** para tributos percentuais; **ST/DIFAL/FCP: não calculados** (pendência explícita) |
| Preparação de NF-e de saída (dados, impostos pelo motor, validações) e numeração atômica | **Concluída** |
| Máquina de estados de transmissão (autorizada/rejeitada/timeout/consulta, sem duplicidade) | **Concluída**, com testes unitários e de integração do provedor |
| Geração do XML, assinatura, transmissão e DANFE/XML autorizado | **Concluída** via Focus NFe; emissão direta disponível somente nas UFs declaradas pelo registro interno |
| Cancelamento | **Implementado via provedor** (prazos do estado/provedor) |
| Carta de Correção e inutilização | **Implementadas** via Focus NFe e emissão direta |
| MDF-e (emissão, consulta, encerramento e cancelamento) | **Implementado** diretamente na SVRS com A1 local |
| Verificação de assinatura/autenticidade do XML recebido; consulta de situação na SEFAZ; manifestação do destinatário; download automático (NSU) | **Não implementados** (requerem certificado e acesso ao serviço oficial) |
| NFC-e | **Implementada via provedor** (exige CSC no provedor e forma de pagamento) |
| NFS-e, CT-e | **Não implementados** (arquitetura aceita novos tipos) |
| Reforma Tributária (IBS/CBS e Imposto Seletivo) | Cálculo percentual parametrizado e envio dos campos da NT 2025.002; CST/classificação/alíquotas são definidos pelo contador |

## Princípios e como foram aplicados
- **Separação**: legislação/parametrização (`tax_rules`, `tax_rule_versions`) ≠ cálculo (`engine.ts`, puro) ≠ documento (`fiscal_documents`) ≠ leiaute/transmissão (provedor).
- **Versionamento**: toda regra tem versões com vigência (`valid_from/valid_to`), **fonte obrigatória** (base legal/parecer, ≥ 10 caracteres), criador e aprovador diferentes (segregação de funções, exceto o proprietário). Versão aprovada é **imutável** (aplicação + gatilho no banco); substituir cria nova versão e encerra a anterior na véspera da nova. Cálculos em data antiga continuam usando a versão antiga.
- **Reprodutibilidade**: cada cálculo persistido (`tax_calculations`, imutável) guarda entradas, saídas, versões de regra e versão do motor (`1.0.0`).
- **Seleção de regra**: operação, UF origem/destino, regime, origem da mercadoria, tipo de destinatário e prefixo de NCM; vence a maior prioridade e, depois, a mais específica. Empate exato ⇒ **pendência de ambiguidade** (não escolhe).
- **Sem regra aprovada** ⇒ pendência `NO_RULE`; **sem NCM/UF** ⇒ `MISSING_DATA`; **tributo ST/DIFAL/FCP** ⇒ `UNSUPPORTED_TAX`.
- **Documentos recebidos e XML são imutáveis** (sem DELETE; itens protegidos por gatilho) e guardados com SHA-256 para retenção.
- **Autenticidade**: todo XML importado carrega o aviso permanente "assinatura e situação na SEFAZ não verificadas". Nota de **homologação** pode ser importada, mas nunca gera recebimento.
- **Emissão segura** (`FiscalOutgoingService`): número e chave só são reservados quando há provedor configurado; transação curta antes e depois, **sem transação aberta durante a chamada externa**; `TIMEOUT`/exceção ⇒ `PENDING_CONSULT` (proibido retransmitir, só consultar pela chave); `NOT_FOUND` na consulta libera reenvio com a **mesma numeração**; rejeição exige correção + revalidação e mantém a numeração; chamadas simultâneas não duplicam (bloqueio de linha). Produção exige configuração validada pelo contador, certificado vigente e dados completos — checados de novo imediatamente antes de consumir numeração.

## O que depende do CONTADOR
1. Confirmar o **regime tributário** da empresa e de cada estabelecimento.
2. Validar a **configuração fiscal** (ambiente, série, tipos de documento) — botão "Enviar ao contador" gera as perguntas.
3. Definir e aprovar as **regras tributárias** (CFOP, CST/CSOSN, alíquotas, redução de base, frete na base) por operação, UF, NCM e regime, registrando a **fonte**.
4. Validar o **NCM e a origem** de cada produto (o sistema só checa o formato de 8 dígitos; **não consulta a tabela oficial TIPI/NCM**).
5. Informar se há **ST, DIFAL/FCP, benefício fiscal, monofásico** etc. — ST/DIFAL/FCP ainda geram pendência explícita.
6. Definir CST, classificação tributária e alíquotas de **IBS/CBS e Imposto Seletivo** aplicáveis ao negócio.
7. Definir a classificação do destinatário (contribuinte/não contribuinte). O cadastro de clientes ainda não tem esse indicador, então regras que dependem dele não casam.
8. Validar o **tratamento de entradas** (crédito, escrituração) — o sistema registra os valores **como declarados** no XML e não calcula nem escritura.

## O que depende do CERTIFICADO DIGITAL e de acesso externo
1. Certificado **A1 ICP-Brasil** do estabelecimento (arquivo .pfx + senha). O sistema abre o PKCS#12, confere senha, validade e a correspondência da chave privada e guarda tudo cifrado; **não valida a cadeia de certificação ICP-Brasil nem revogação (CRL/OCSP)**.
2. **Provedor de emissão:** cadastrar a empresa, A1 e CSC no Focus NFe e salvar o token do ambiente no sistema. Para MDF-e, manter também o A1 local ativo.
3. **Homologação**: credenciamento de contribuinte e acesso ao ambiente de homologação da UF; testes de rejeição, timeout e contingência com o provedor real.
4. **Produção**: somente depois do item 3, da validação do contador e da revisão jurídica/contábil. Armazenamento do XML autorizado conforme o prazo legal de guarda.

## Fontes normativas e técnicas
As implementações foram revistas em 02/11/2026 contra o Portal Nacional da NF-e, os XSDs oficiais incluídos no repositório, a NT 2025.002 vigente e a referência oficial do Focus NFe. A homologação com a empresa real continua obrigatória porque credenciamento, regras estaduais e cadastro fiscal não podem ser reproduzidos apenas por testes locais.

## Limitações conhecidas
- Valores de impostos do XML recebido são guardados como declarados (sem recálculo nem conferência).
- A conciliação usa o custo unitário do XML (valor do item ÷ quantidade em estoque); frete, seguro e outras despesas não são rateados no custo.
- As duplicatas do XML são guardadas (`installments`) para o Contas a pagar (Fase 7), que ainda não existe.
- Unidades: conversão só entre unidade de venda e de compra do produto; outras unidades pedem revisão manual.
- Um produto tem um único código de fornecedor por fornecedor.

## Documento fiscal escolhido na venda (NF-e ou NFC-e) e espelho
**Na venda** (Vendas → Pedido) o usuário escolhe o documento: **Nota fiscal (NF-e)**, **Cupom fiscal (NFC-e)** ou **Decidir depois** (padrão). A escolha fica no pedido (`fiscalDocType`) e pode ser trocada enquanto for rascunho. A tela sugere NF-e para cliente com CNPJ e NFC-e para CPF, mas a decisão é do usuário.

**Espelho** (`GET /api/sales/orders/:id/fiscal-preview`, botão "Ver documento" no pedido): mostra como ficará o **DANFE da NF-e (A4)** e o **cupom da NFC-e (80 mm)** com os dados do pedido, do estabelecimento emitente e do cliente, pode ser impresso e traz a lista do que **falta para emitir**:
- *Bloqueia:* emitente sem CNPJ, IE, endereço ou regime tributário; itens sem NCM de 8 dígitos; NF-e sem CPF/CNPJ ou sem endereço completo do destinatário.
- *Avisa:* item sem origem da mercadoria; configuração fiscal ainda não validada pelo contador ou tipo de documento não habilitado; sem certificado A1 ativo; NFC-e para cliente com CNPJ (normalmente pede NF-e).

**O que o espelho NÃO é:** não é documento fiscal. Não há número, chave de acesso, protocolo ou QR Code, e a marca "ESPELHO · SEM VALOR FISCAL" cobre o documento. A nota fiscal válida nasce apenas depois da preparação, validação e autorização pela SEFAZ no fluxo Fiscal → Notas de saída.
