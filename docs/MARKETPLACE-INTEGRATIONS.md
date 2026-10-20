# Central de integrações (Fases 4 e 5)

**Estado:** infraestrutura concluída e testada (Fase 4). **Mercado Livre (Fase 5):** autorização OAuth, validação, renovação de token, importação de pedidos (reconciliação + notificações) e vínculo com produtos estão **implementados e testados contra um servidor SIMULADO — nunca contra a API real**. Por isso a matriz marca esses itens como `IMPLEMENTED_UNVERIFIED`, não `SUPPORTED`. Publicação, preço, estoque, catálogo e envios do Mercado Livre continuam `PLANNED`/`NOT_IMPLEMENTED`. Amazon e Shopee seguem como esqueleto (501).

## O que existe
| Peça | Onde | Observações |
|---|---|---|
| Conexões por tenant | `marketplace_connections` | estados: não conectada → aguardando autorização → teste pendente → configuração incompleta → conectada → ativa ⇄ pausada; token expirado; erro de sincronização; desconectada |
| Credenciais | `credentials_enc` | AES-256-GCM, chave derivada por tenant (HKDF), AAD por registro, `kid` para rotação (`CREDENTIALS_KEY` + `CREDENTIALS_KEY_PREVIOUS`); nunca retornam pela API |
| Interface de conectores | `integrations/connector.ts` | `authorizeConnection`, `completeAuthorization`, `validateConnection`, `refreshAuthorization`, `revokeAuthorization`, `fetchOrders`, `fetchProducts`, `publishProduct`, `updateProduct`, `updatePrice`, `updateInventory`, `cancelListing`, `getShipment`, `processNotification`, `verifyWebhook`, `webhookEventId`. Retorno tipado `OpResult` (`UNSUPPORTED`, `NOT_IMPLEMENTED`, `NOT_CONFIGURED`, `AUTH`, `RATE_LIMIT`, `UNAVAILABLE`, `VALIDATION`, `ERROR`) — nunca um falso sucesso |
| OAuth | `/api/integrations/connections/:id/authorize` e `/api/integrations/callback` | `state` JWT assinado, expira em 10 min e é de uso único (nonce) |
| Fila | `background_jobs` + `JobWorker` | ver ADR-0006: retentativas com backoff exponencial + jitter, respeito ao `retry-after`, DLQ (`DEAD`), reprocessamento manual, recuperação de worker morto (lock > 5 min), idempotência por chave |
| Webhooks | `POST /api/webhooks/:tenantId/:connectionId` | assinatura HMAC-SHA256 (`x-dh-signature`) com segredo por conexão (mostrado uma vez, rotacionável); deduplicação por id do evento (ou hash do corpo); responde 200 rápido e processa em job; conexão pausada guarda e reprocessa ao retomar |
| Reconciliação | job `connection.reconcile` | agendado por conexão ativa (padrão 15 min, idempotente por janela); não depende de webhooks |
| Renovação de token | job `token.refresh` | enfileirado quando faltam < 10 min |
| Logs | `integration_logs` | append-only, segredos removidos (`redactSecrets`), duração, nível |
| Monitoramento | `GET /api/integrations/connections/:id` e tela **Marketplaces e integrações** | contagens de jobs/webhooks/logs, tempo de resposta, próxima execução, alertas de atenção |
| Mapeamento externo | `external_entity_mappings` | tabela pronta; usada na Fase 5 |

Regras de segurança: operações automáticas não rodam com transação aberta durante chamadas externas; erro de autorização do canal responde **424** (nunca 401, que o navegador leria como sessão do ERP expirada); criar/ativar/pausar/desconectar/reprocessar exigem `integrations.manage`.

## Mercado Livre — verificação da documentação (consulta feita em 20/10/2026)

**Limitação da consulta:** a leitura direta das páginas oficiais (developers.mercadolivre.com.br) foi bloqueada (HTTP 403 para o fetch automático; o navegador embutido falhou na checagem de política). O que está abaixo veio de **trechos das páginas oficiais retornados por busca** — fonte oficial, porém indireta. Itens marcados **[A VALIDAR]** são o contrato que implementei por conhecimento prévio e que **não foi confirmado nesta sessão**; ficam isolados em `mercado-livre.connector.ts` (comentários `[CONFIRMADO]`/`[A VALIDAR]`).

| Tema | Situação | O que o código faz |
|---|---|---|
| Domínio de autorização do Brasil | confirmado (trecho oficial) | `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=…&redirect_uri=…&state=…` |
| `redirect_uri` | confirmado: deve coincidir exatamente com o cadastrado e não pode ter parte variável | usamos `<WEB_ORIGIN>/api/integrations/callback` fixo; dados variáveis vão no `state` (JWT assinado, 10 min, uso único) |
| `state` | confirmado: recomendado e conferido na volta | idem |
| PKCE | confirmado: só se habilitado no aplicativo | `ML_USE_PKCE=true` envia `code_challenge` (S256); o verificador é derivado do `state` por HMAC (sem armazenar) |
| Troca do code / renovação | confirmado: `POST https://api.mercadolibre.com/oauth/token` com `grant_type=authorization_code` ou `refresh_token` | corpo `application/x-www-form-urlencoded` com `client_id`, `client_secret`, `code`/`refresh_token`, `redirect_uri` |
| Validade do token | confirmado que a documentação é inconsistente (exemplos de 10800 s e 21600 s) | **lemos `expires_in` da resposta**, nunca presumimos |
| Refresh token | confirmado: **uso único**, cada renovação devolve um novo e só o último vale; necessário escopo `offline_access` | gravamos o novo par a cada renovação; sem `refresh_token` na resposta a autorização é recusada com orientação |
| Pedidos | confirmado: `/orders/search?seller=<id>` com Bearer; status `payment_required`, `payment_in_process`, `partially_paid`, `paid`, `cancelled`, `invalid`; limite citado de ~100 req/min | importamos `paid`; `cancelled`/`invalid` cancelam; os demais ficam "aguardando pagamento" |
| Filtro de data, `sort`, `limit`, `offset`, `paging.total`, campos do pedido | **[A VALIDAR]** | `order.date_created.from`, `sort=date_asc`, `limit=50`, `paging.total`, `order_items[].item.seller_sku` |
| `/users/me` para validar a conta | **[A VALIDAR]** | compara o `id` com a conta autorizada |
| Notificações | confirmado: corpo com `topic`, `resource`, `user_id`, `application_id`; **responder HTTP 200 em até 500 ms** (senão o tópico pode ser desativado); buscar o recurso na API depois; existe `missed_feeds` | endpoint responde rápido e processa em job; só o `resource` é usado |
| Reentregas | **conflito entre páginas** (8 tentativas/1 h vs. 12 h) | a reconciliação periódica cobre notificações perdidas; não dependemos de webhooks |
| Assinatura das notificações (`x-signature`) | **não encontrada nos trechos consultados** | **não confiamos no corpo**: token na URL (`ML_WEBHOOK_TOKEN`) filtra chamadas e o pedido é sempre relido na API com o token do vendedor; pedido de outro vendedor é recusado |
| Revogação da autorização | **não verificada** | `revokeAuthorization` não implementado; a UI orienta revogar em "Aplicativos conectados" da conta ML |
| Aplicativo/permissões/escopos exatos para pedidos | **não verificado** | depende da configuração do seu aplicativo |

Fontes consultadas (por busca): páginas "Gestão de aplicações / autenticação e autorização", "Obtenção do access token", "Orders / Gerenciamento de vendas" e "Notificações" em developers.mercadolivre.com.br e no devsite global-selling.mercadolibre.com.

### Importação de pedidos (como funciona)
1. Notificação (`POST /api/webhooks/providers/mercado_livre/<token>`) ou reconciliação periódica (padrão 15 min; 1ª execução: últimos 7 dias, configurável) obtém pedidos.
2. Cada pedido passa pelo **livro `external_orders`** (único por conexão + id externo) → importar N vezes é seguro; o pedido de venda tem chave única (origem + referência).
3. `paid` → cria cliente do comprador (vinculado por id do comprador), resolve produtos por **vínculo do anúncio** ou **SKU idêntico** (`seller_sku`), cria o pedido (origem Marketplace) e **reserva estoque**.
4. Pendências, nunca descarte: SKU sem produto → "precisa de atenção" (vincule o anúncio e reprocesse); estoque insuficiente → pedido fica "aguardando aprovação" com o motivo; depósito não definido; comprador ausente.
5. `cancelled`/`invalid`: cancela o pedido do ERP (libera reserva) conforme a política da conexão; se já expedido, exige tratamento manual (devolução).

Não faz ainda: tarifas/comissões do canal, frete, nota fiscal, atualização de status/rastreio no canal (Fases 6-7).

### O que depende do SEU acesso (nada disto foi possível aqui)
1. Criar o aplicativo em Mercado Livre Developers (conta de desenvolvedor) → `ML_CLIENT_ID`, `ML_CLIENT_SECRET`.
2. Cadastrar no aplicativo: **URL de redirecionamento** = `<WEB_ORIGIN>/api/integrations/callback` (HTTPS público em produção; localhost não é alcançável pelo ML para notificações) e **URL de notificações** = `<WEB_ORIGIN>/api/webhooks/providers/mercado_livre/<ML_WEBHOOK_TOKEN>` com os tópicos de pedidos.
3. Habilitar o escopo `offline_access` (e leitura/escrita) e, se for o caso, PKCE (`ML_USE_PKCE=true`).
4. Uma conta de vendedor para autorizar e ao menos alguns pedidos reais/de teste.
5. Rodar o roteiro de validação abaixo e devolver o resultado para trocar os itens **[A VALIDAR]** por `[CONFIRMADO]` e promover a matriz a `SUPPORTED`.
6. Ler a documentação oficial diretamente (o acesso automatizado foi bloqueado) para fechar os itens marcados como não verificados — principalmente assinatura de notificações, revogação e limites de paginação.

### Roteiro de validação com conta real
Conectar → Testar conexão → conferir `externalAccountId`; aguardar a primeira reconciliação e comparar pedidos/valores com o painel do ML; criar um pedido de teste e conferir a notificação (tempo de resposta < 500 ms nos logs); vincular um anúncio sem SKU; cancelar um pedido no ML; forçar renovação de token (alterar `token_expires_at` no banco de homologação) e verificar o novo `refresh_token`.

## Anúncios, preços, estoque publicável e categorias por canal (Fase 5b — não depende de credenciais)

| Peça | Como funciona |
|---|---|
| Anúncio (`channel_listings`) | produto do ERP × conexão; rascunho ou vinculado a um ID de anúncio do canal (o vínculo alimenta a importação de pedidos); um anúncio do canal não pode apontar para dois produtos |
| Perfil de tarifas do canal | comissão %, pagamento %, tributos % **estimados e informados por você**, tarifa fixa, frete subsidiado, embalagem e **margem mínima** — nada é presumido; salvo com antes/depois na auditoria |
| Simulador (`POST /api/integrations/pricing/simulate`, tela **Preços e margens**) | resultado por unidade, **margem sobre a venda** e **markup sobre o custo** (distintos), preço de equilíbrio e preço recomendado para uma margem-alvo: `preço = custos fixos / (1 − %variáveis − margem)` (impossível quando %+margem ≥ 100%) |
| Preço aprovado | `PUT …/listings/:produto/price` exige `pricing.manage`, motivo, respeita o **preço mínimo do produto** e a **margem mínima do canal**, pede confirmação explícita para variação > 20% e grava histórico imutável (`price_history`) + auditoria |
| Estoque publicável | `max(0, disponível − estoque de segurança)`, limitado pelo teto de publicação; disponível = físico − reservado − bloqueado do depósito da conexão. Exemplo: 100 físico, 8 reservado, 2 bloqueado, 5 segurança → **85** |
| Sincronização (`channel.sync`) | manual ou agendada por conexão (se envio de estoque/preço estiver ligado); envia **só o que mudou** desde o último envio (idempotente); **revalida o preço no envio** (custo/tarifa podem ter mudado); falha temporária reagenda mantendo o progresso; recusa do canal marca só aquele anúncio |
| Honestidade do envio | se o conector não implementa a operação (hoje: **Mercado Livre, Amazon e Shopee**), o anúncio fica **BLOQUEADO** com o motivo — nunca "sincronizado"; o job termina sem repetição infinita |
| Categorias (`channel_category_mappings`) | categoria do ERP → ID da categoria no canal, informado pelo usuário (a consulta automática de categorias e atributos obrigatórios depende dos conectores reais) |

Limitações: o envio de preço/estoque só foi exercitado com o conector **Sandbox**; atualização imediata a cada movimento de estoque (hoje é periódica/manual), estoque dedicado/prioridade entre canais, reserva exclusiva por canal, arredondamento de preço, agendamento de alterações e reversão automática de preço ainda não existem.

## Matriz de funcionalidades (resumo)
Amazon e Shopee: todas as linhas **PLANNED**. Mercado Livre: autorização, pedidos e notificações **IMPLEMENTED_UNVERIFIED**; catálogo, publicação, preço, estoque e envios **PLANNED**. Antes de marcar qualquer item como `SUPPORTED` é obrigatório: ler a documentação oficial vigente, registrar data/versão, permissões, limites e operações implementadas, e testar em sandbox/credenciais reais.

| Canal | Documentação oficial de partida | Dependências externas |
|---|---|---|
| Mercado Livre | https://developers.mercadolivre.com.br/pt_br/api-docs-pt-br | aplicativo registrado (client id/secret), autorização OAuth do vendedor |
| Amazon (SP-API) | https://developer-docs.amazon.com/sp-api/lang-pt_BR/docs/sp-api-endpoints | registro de desenvolvedor, aplicativo aprovado, autorização no Seller Central |
| Shopee | https://open.shopee.com/ (confirmar a documentação vigente) | conta Open Platform, aplicativo aprovado |

Datas de verificação: Mercado Livre — 20/10/2026, **parcial** (busca em páginas oficiais; leitura direta bloqueada). Amazon e Shopee — nenhuma.

## Conector Sandbox
`SANDBOX` só existe com `ENABLE_SANDBOX_CONNECTOR=true` fora de produção (testes automatizados). Simula erros (indisponibilidade, limite de requisições, token inválido, validação) para exercitar fila, retentativas e estados. Não representa nenhum marketplace.

## Pendências da central
Notificações ao usuário (e-mail/in-app) para token expirado e falhas; mapeamento de categorias/atributos; preço por canal e margem mínima; estoque por canal (segurança, teto, reserva exclusiva); regras fiscais por canal; Redis/BullMQ (se o volume exigir); coleta de métricas externas (Prometheus).


## Galeria de canais (catálogo ampliado)
- A tela **Marketplaces** mostra 20 canais em abas (marketplaces, lojas virtuais, ERPs/integradores) com busca. **Só o Mercado Livre conecta hoje** (e ainda sem validação com conta real); os outros 19 estão **planejados**: aparecem com "Em breve", requisitos, autenticação prevista e link da documentação oficial, mas **não executam nenhuma chamada** (matriz de capacidades "planejado", e o backend responde 501 se alguém forçar a autorização).
- **Conectar em um passo** (canais disponíveis): o usuário informa o nome e o depósito de origem, é levado ao canal para autorizar e, ao voltar, o teste de conexão roda sozinho; falta apenas clicar em "Ativar".
- **Catálogo:** `apps/api/src/integrations/catalog.ts` (canal, categoria, região, autenticação prevista, documentação). Endereços de documentação conferidos como acessíveis em 20/10/2026; Americanas e Casas Bahia ficaram sem link público localizado. As formas de autenticação dos canais planejados vêm da documentação pública e **precisam ser confirmadas** antes de implementar.
- **Logotipos:** ícones genéricos do pacote simple-icons (CC0) para os canais que têm (Shopee, AliExpress, TikTok, eBay, Etsy, Shopify, WooCommerce, VTEX); os demais mostram a sigla na cor da marca. Para usar o logotipo **oficial**, coloque o arquivo em `apps/web/public/marketplaces/<chave>.svg|png` (ex.: `mercado_livre.svg`, `magalu.png`) — ele passa a ter prioridade, sem mudar código. Os logotipos pertencem aos titulares e só identificam o canal; use arquivos que você tem direito de usar.
- **O que depende de você para cada canal virar real:** conta de desenvolvedor/aplicativo aprovado no canal, credenciais, e leitura da documentação vigente; hoje só o Mercado Livre tem conector (e exige ML_CLIENT_ID/ML_CLIENT_SECRET no servidor).
