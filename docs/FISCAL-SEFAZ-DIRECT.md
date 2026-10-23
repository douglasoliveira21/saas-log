# Emissão direta na SEFAZ (NF-e e NFC-e) — estado real

> **Resumo honesto:** o código monta o XML no leiaute 4.00, confere no XSD, assina (XMLDSig), fala SOAP 1.2 com TLS mútuo e trata autorização, rejeição, denegação, recibo, consulta, cancelamento e inutilização. Isso está **testado com um servidor de teste que imita a forma da SEFAZ** (que também valida o XML e a assinatura recebidos). **Nada disso foi executado contra a SEFAZ real** (exige certificado A1 ICP-Brasil e credenciamento da empresa). **Nenhuma UF está "homologação aprovada" nem "produção habilitada".**

## Como ativar (por estabelecimento)
Fiscal → Configuração → *Como emitir as notas* → **Direto na SEFAZ**. Antes: enviar o **certificado A1** (card acima), ter o **credenciamento** na SEFAZ da UF e, para NFC-e, o **CSC** (portal da SEFAZ). O botão **Testar comunicação** consulta o *status do serviço* da UF com o certificado (TLS mútuo) sem emitir nada.

## O que existe (arquivos em `apps/api/src/fiscal/sefaz/`)
| Peça | Arquivo | Evidência |
|---|---|---|
| Registro versionado de serviços por UF/modelo/ambiente, com fonte e data | `registry.ts` | MG copiada do SPED MG (22/10/2026); teste compara com as URLs oficiais |
| Matriz de cobertura 27 UFs × 2 modelos (`GET /api/fiscal/sefaz/coverage`) | `registry.ts` | teste: 54 linhas, só MG ≠ "não analisado", nenhuma passa de "em desenvolvimento" |
| XML NF-e/NFC-e 4.00 (Simples: CSOSN 102/103/300/400; Normal: CST 00/40/41/50; PIS/COFINS) | `nfe-builder.ts` | **validado no XSD** do pacote (inclui Signature) |
| Validação por XSD (xmllint em WASM) | `xsd.ts` | o XSD já recusou erro real (CNAE sem IM) durante o desenvolvimento |
| Assinatura RSA-SHA1/C14N/enveloped com certificado A1 | `signature.ts`, `pfx.ts` | XSD aceita + `verifySignature` confere + alteração invalida |
| SOAP 1.2 + TLS mútuo, sem desligar a verificação do servidor | `soap.ts` | handshake mTLS real contra servidor de teste |
| Mensagens e leitura de respostas (status, lote, recibo, consulta, evento 110111, inutilização) | `messages.ts` | testes de ponta a ponta |
| Provedor direto (autorizar, consultar, cancelar, inutilizar, ping) | `sefaz-direct.provider.ts` | 15 testes e2e |
| Código IBGE do município pela API oficial do IBGE (cache 24 h, fora da transação) | `ibge.ts` | usado no XML |
| QR Code 2.00 da NFC-e (SHA-1 de chave\|2\|tpAmb\|cscId + CSC) | `nfe-builder.ts` | cálculo conferido de forma independente |

## Regras de segurança fiscal mantidas
- Número e chave reservados antes do envio (atômico); **nunca** reenviar após timeout sem consultar a chave; consulta "não consta" (217) libera reenvio com a **mesma** numeração; duas transmissões simultâneas enviam uma vez.
- **Nenhum XML que o XSD recusa é enviado.** Autorização só com `protNFe` de cStat 100/150; 301/302/110… viram "denegada"; o `nfeProc` (NFe + protocolo) é o XML guardado.
- Certificado decifrado só em memória, por chamada; nunca em log, resposta ou auditoria. CSC cifrado e nunca devolvido.
- A cadeia ICP-Brasil **não vem** no Node: informe `FISCAL_SEFAZ_CA_FILE` (PEM da cadeia, da fonte oficial do ITI). Sem ela a conexão falha com mensagem clara; a verificação **não** é desligada.

## O que NÃO foi feito / bloqueios
| Item | Situação | Bloqueio |
|---|---|---|
| Comunicação real com a SEFAZ (MG homologação) | **Não executada** | certificado A1 ICP-Brasil + credenciamento da empresa em MG |
| Schemas **oficiais** | Usa **espelho de terceiros** (`sped-nfe`, PL_010 v1.30) | o download oficial do Portal da NF-e não é acessível por automação; substituir `schemas/` pelo pacote vigente e rodar `npm run fiscal:schemas`. O pacote em produção pode ser **mais novo** (IBS/CBS, NT 2025.002 v1.50+): a SEFAZ prevalece |
| 26 UFs além de MG | **Não analisadas** (endereços não verificados ⇒ emissão recusada com explicação) | consultar a página oficial de cada UF/autorizador virtual (ex.: SVRS) e testar em homologação |
| NFC-e de MG | XML/QR Code/assinatura testados; **versão do QR Code vigente em MG não confirmada** (existe a 2.00 com CSC e a 3.00 assinada, sem CSC); regras de impressão e contingência da UF não verificadas | confirmar na documentação da SEFAZ-MG |
| Regras de homologação não documentadas nas páginas lidas | `dest/xNome` fixo e `xProd` do 1º item da NFC-e em homologação estão como **[A VALIDAR]** | só a homologação real confirma |
| Contingência (SVC, EPEC, NFC-e offline) | **Não implementada** (a página do SPED MG não cita SVC; EPEC é da RFB) | decisão de produto + verificação por UF |
| DANFE a partir do XML autorizado (NF-e A4 e DANFE NFC-e 80 mm com QR Code) | **Implementado (aproximação do leiaute)**: gerado do XML guardado, com código de barras Code 128 da chave e QR Code; **não conferido pixel a pixel com o Manual de Orientação do Contribuinte** nem validado por contador/SEFAZ da UF. O documento com validade é o XML | validar o leiaute com o contador e a UF antes de usar como documento oficial impresso |
| ST, DIFAL, FCP, IPI, benefícios, importação, CSOSN 101/500/900, CST 10/20/60/70/90 | Não suportados (recusados com mensagem) | regras do contador e do motor tributário |
| Carta de correção (CC-e) | **Implementada** (evento 110110, serviço de eventos da UF — mesmo endereço verificado do cancelamento; XSD do evento e assinatura conferidos por teste; só com servidor de teste) | homologação real |
| Manifestação do destinatário (ciência, confirmação, desconhecimento, não realizada) | **Implementada, mas desligada por padrão**: vai ao Ambiente Nacional (cOrgao 91) e o **endereço do serviço NÃO foi verificado em fonte oficial** por este projeto: o administrador informa `FISCAL_SEFAZ_AN_EVENT_URL_HOMOLOGACAO` / `_PRODUCAO` depois de conferir no Portal Nacional da NF-e. Sem isso é recusada com explicação | conferir o endereço oficial + homologação real |
| Distribuição DF-e (baixar as notas emitidas contra o CNPJ) | Não implementada | — |
| Fila assíncrona com retentativa/dead-letter própria para emissão | Não feita (a transmissão é síncrona; consulta manual) | trabalho de infraestrutura |
| CNPJ alfanumérico (leiaute 2026) | O XSD aceita; cadastro e validações de CNPJ do sistema ainda são numéricos | adequar cadastros |

## Cobertura nacional (resumo)
27 UFs × (NF-e, NFC-e) = 54 combinações. **Em desenvolvimento:** MG/55 e MG/65 (endereços oficiais verificados). **Não analisadas:** as outras 52. **Homologação aprovada / produção habilitada:** 0.
Fontes oficiais consultadas em 22/10/2026: SPED MG — `portalsped.fazenda.mg.gov.br/spedmg/nfe/webservices/` e `/nfce/web-services/` (SEFAZ-MG); SEFAZ-ES (lista do SVRS, apenas referência — SVRS ainda não implementado). Conferência cruzada de operações/métodos do WSDL e do QR Code com o projeto de código aberto `sped-nfe` (apenas como verificação, não como fonte oficial).

## Variáveis
`FISCAL_SEFAZ_CA_FILE` (cadeia ICP-Brasil, PEM), `FISCAL_SCHEMAS_DIR` (pacote de schemas alternativo), `FISCAL_SEFAZ_POLL_ATTEMPTS`/`FISCAL_SEFAZ_POLL_DELAY_MS` (acompanhamento do recibo), `IBGE_API_BASE`. `FISCAL_SEFAZ_URL_OVERRIDE` existe **só para testes** e é ignorada em produção.

## NF-e de devolução e MDF-e

**NF-e de devolução de venda** (aba Notas de saída → “Devoluções de venda sem NF-e”): a partir da devolução registrada em Vendas, gera NF-e de entrada própria (finNFe 4, tpNF 0, `NFref/refNFe`, CFOP de devolução 1201/1202/1411/2201/…, `tPag 90`). Só na emissão direta e só com a nota original autorizada. A tributação replica a da venda: o contador deve conferir. Validada no XSD e na assinatura contra o servidor de teste; nunca contra a SEFAZ real.

**MDF-e rodoviário (carga própria)** (aba Fiscal → MDF-e; código em `apps/api/src/fiscal/mdfe/`): prepara a partir da viagem (veículo, motorista, NF-e autorizadas dos pedidos), transmite pelo serviço síncrono da SVRS com o certificado A1, consulta, encerra (110112) e cancela (110111). Exige no cadastro: tara e UF da placa do veículo, CPF do motorista, peso dos produtos.
- Só `tpEmit 2` (prestador de serviço de transporte e CT-e **não** estão cobertos); só NF-e (modelo 55), não NFC-e; sem seguro/CIOT/vale-pedágio.
- **Nunca foi testado contra a SVRS real.** Os XSD vêm do projeto de código aberto `sped-mdfe` (não do pacote oficial: troque o conteúdo de `mdfe/schemas/` pelo oficial). URLs conferidas na página de serviços do portal; nomes de operação/método e o cabeçalho SOAP `mdfeCabecMsg` foram cruzados apenas com o `sped-mdfe` e podem exigir ajuste na homologação.
- Se a resposta se perder depois do envio, o MDF-e fica em “Consultar”: nunca reenvia sem consultar (mesma regra da NF-e).
- Se a sua operação exige MDF-e (e quando encerrar/cancelar) é decisão do contador.
