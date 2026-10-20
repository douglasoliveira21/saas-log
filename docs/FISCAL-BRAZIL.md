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
| Máquina de estados de transmissão (autorizada/rejeitada/timeout/consulta, sem duplicidade) | **Concluída**, exercitada com um provedor **simulado** em testes |
| Geração do XML da NF-e, assinatura digital, transmissão à SEFAZ, DANFE | **Não implementada** — depende do provedor/biblioteca (ADR-0008) e do certificado |
| Cancelamento, Carta de Correção, inutilização, contingência, eventos | **Não implementados** |
| Verificação de assinatura/autenticidade do XML recebido; consulta de situação na SEFAZ; manifestação do destinatário; download automático (NSU) | **Não implementados** (requerem certificado e acesso ao serviço oficial) |
| NFC-e, NFS-e, CT-e | **Não implementados** (arquitetura aceita novos tipos) |
| Reforma Tributária (IBS/CBS) | O motor aceita qualquer código de tributo configurado pelo contador; **nenhum parâmetro oficial foi carregado** |

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
5. Informar se há **ST, DIFAL/FCP, benefício fiscal, monofásico** etc. — o motor ainda não calcula; será tratado fora do sistema ou numa próxima etapa.
6. Definir o tratamento de **IBS/CBS** na transição da Reforma Tributária, quando houver regulamentação aplicável ao negócio.
7. Definir a classificação do destinatário (contribuinte/não contribuinte). O cadastro de clientes ainda não tem esse indicador, então regras que dependem dele não casam.
8. Validar o **tratamento de entradas** (crédito, escrituração) — o sistema registra os valores **como declarados** no XML e não calcula nem escritura.

## O que depende do CERTIFICADO DIGITAL e de acesso externo
1. Certificado **A1 ICP-Brasil** do estabelecimento (arquivo .pfx + senha). O sistema abre o PKCS#12, confere senha, validade e a correspondência da chave privada e guarda tudo cifrado; **não valida a cadeia de certificação ICP-Brasil nem revogação (CRL/OCSP)**.
2. **Provedor/biblioteca de emissão** (ADR-0008): geração do XML no leiaute vigente, assinatura (XMLDSig), comunicação com os webservices da SEFAZ de cada UF e DANFE. Sem isso, "Transmitir" responde 424 e nada é emitido.
3. **Homologação**: credenciamento de contribuinte e acesso ao ambiente de homologação da UF; testes de rejeição, timeout e contingência com o provedor real.
4. **Produção**: somente depois do item 3, da validação do contador e da revisão jurídica/contábil. Armazenamento do XML autorizado conforme o prazo legal de guarda.

## Fontes oficiais a consultar antes de implementar a emissão (não consultadas nesta etapa)
Portal Nacional da NF-e (https://www.nfe.fazenda.gov.br/portal/): Manual de Orientação do Contribuinte, Notas Técnicas vigentes, esquemas XSD e tabelas de códigos; Receita Federal — Reforma Tributária do Consumo (https://www.gov.br/receitafederal/pt-br/acesso-a-informacao/acoes-e-programas/programas-e-atividades/reforma-tributaria-do-consumo/orientacoes-da-reforma-tributaria); Portal Nacional da NFS-e (https://www.gov.br/nfse/pt-br/nfs-e-via/documentacao-tecnica/documentacao-tecnica). **O leiaute 4.00 e a regra de dígito verificador da chave usados aqui seguem o conhecimento prévio e devem ser conferidos contra a documentação vigente.** Nenhuma verificação na documentação oficial foi feita nesta fase.

## Limitações conhecidas
- Valores de impostos do XML recebido são guardados como declarados (sem recálculo nem conferência).
- A conciliação usa o custo unitário do XML (valor do item ÷ quantidade em estoque); frete, seguro e outras despesas não são rateados no custo.
- As duplicatas do XML são guardadas (`installments`) para o Contas a pagar (Fase 7), que ainda não existe.
- Unidades: conversão só entre unidade de venda e de compra do produto; outras unidades pedem revisão manual.
- Um produto tem um único código de fornecedor por fornecedor.
