# Testes

```bash
npm test             # unitários: senha, CNPJ, papéis, remoção de segredos (sem banco)
npm run test:e2e     # e2e: cria/migra distribuihub_test e roda contra PostgreSQL real
```
Pré-requisito do e2e: PostgreSQL acessível em `DIRECT_URL` (padrão: `npm run db:start`).

## Cobertura e2e da Fase 1 (`apps/api/test/foundation.e2e-spec.ts`, 21 testes)
- Autenticação: acesso sem sessão (401), registro + `/me`, CSRF, bloqueio por tentativas, rotação/reutilização de refresh, logout.
- Isolamento: dois tenants; leitura/escrita cruzada negada (404), listagem de usuários/auditoria, `select-tenant` forjado (403), JWT com `tid` alheio (403).
- Banco: RLS (leitura vazia, INSERT cruzado rejeitado, sem contexto = vazio), FK composta, auditoria append-only.
- RBAC: vendedor 403 em rotas administrativas; anti-escalação; último proprietário; papéis personalizados; CNPJ; whitelist; duplicidade; trilha de auditoria sem segredos; visão geral com dados reais.

## Cobertura e2e da Fase 2 (`apps/api/test/stock.e2e-spec.ts`, 19 testes)
- Concorrência: 15 reservas simultâneas com 10 em estoque (exatamente 10 passam), 15 saídas simultâneas (nunca negativa), transferências opostas simultâneas (sem deadlock/500).
- Idempotência: mesmo evento/reserva repetido em paralelo gera um único efeito; consumo/liberação ocorrem uma vez; estorno único.
- Banco: razão imutável, CHECK de disponível negativo.
- Inventário: contagem por código de barras → aprovação com ajuste auditável; conflito com reservas não aplica nada; aprovador precisa de permissão.
- Importação CSV: simulação, 422 com erros, saldo inicial auditável, reimportação, permissão de saldo inicial.
- Isolamento entre tenants (produtos, movimentos, reservas, estornos, fornecedores), permissões, validação de CNPJ/CPF e pendência fiscal.
- Unitários: parser de CSV, números BR, CPF.

## Cobertura e2e da Fase 3 (`apps/api/test/commercial.e2e-spec.ts`, 17 testes)
- Pedido: totais em centavos, reserva na confirmação, baixa na expedição, transições inválidas, falta de estoque sem reservas parciais, duas ordens pela última unidade, confirmação tripla em paralelo.
- Aprovação por desconto/preço mínimo, segregação de funções, rejeição; cancelamento com liberação de reserva e estorno de comissão; bloqueio de cancelar após expedição.
- Devoluções parcial/total (sem deriva de arredondamento), excesso recusado, avaria sem reposição.
- Comissões: regra única por prioridade/especificidade, evento configurável (confirmado/entregue), pagamento único, estorno após pagamento, escopo por vendedor.
- Compras: limite de aprovação, alçada, recebimento parcial/total, divergência, custo médio, estorno de recebimento, recebimento idempotente em paralelo, sugestão de reposição.
- Isolamento entre tenants para pedidos, compras, clientes, vendedores e regras; numeração; auditoria; livro de comissões sem DELETE.
- Unitários: seleção de regra, cálculo de comissão e totais de linha.

## Cobertura e2e da Fase 4 (`apps/api/test/integrations.e2e-spec.ts`, 26 testes + `crypto.spec.ts`)
- Honestidade: conectores reais respondem 501/NOT_IMPLEMENTED, matriz só `PLANNED`, ativação bloqueada com lista de pendências.
- Ciclo de vida: autorizar → callback (state de uso único/forjado) → testar → ativar; configuração incompleta; pausar (cancela tarefas), retomar; desconectar (revoga, apaga credenciais, mantém histórico).
- Credenciais cifradas no banco e ausentes das respostas; segredos redigidos em logs, auditoria e jobs.
- Webhooks: assinatura, deduplicação concorrente, hash do corpo, pausa/retomada, rotação do segredo, isolamento entre tenants.
- Fila: backoff, DEAD após 5 tentativas, reprocessamento manual, recuperação da conexão pela reconciliação, retry-after, erro de validação sem repetição, token expirado → TOKEN_EXPIRED, renovação de token, job travado recuperado, idempotência de enfileiramento, reprocessamento não idempotente exige confirmação.
- Monitoramento, permissões (view/manage), RLS e isolamento.
- Unitários: cifra (tenant/AAD/adulteração/rotação) e remoção de segredos.

## Cobertura e2e da Fase 5 (`apps/api/test/mercadolivre.e2e-spec.ts`, 20 testes)
**Servidor HTTP SIMULADO do Mercado Livre** (não é a API real): prova o comportamento do nosso código, não o do canal.
- OAuth: ausência de ML_CLIENT_ID (424), URL com redirect_uri exato, troca do code, credenciais cifradas, `expires_in` honrado, PKCE, code inválido, falta de refresh_token, conta duplicada, validação de conta, renovação com refresh de uso único e queda para TOKEN_EXPIRED.
- Pedidos: importação idempotente (reconciliação repetida e 5 importações concorrentes), SKU sem vínculo → pendência → vincular → reprocessar, estoque insuficiente sem perder a venda, aguardando pagamento → pago, cancelamento (automático, manual e após expedição), paginação (3 páginas) e janela incremental, 429/500/401.
- Notificações: token incorreto, conta desconhecida, corpo não confiável (relido na API), resposta < 500 ms, duplicatas, tópicos ignorados, recurso malformado, pedido de outro vendedor, mesma conta em duas empresas (isolamento).

## Cobertura da Fase 5b (`apps/api/test/channels.e2e-spec.ts`, 13 testes + `pricing.spec.ts`, 7 testes)
- Simulador: equilíbrio, preço recomendado, avaliação, meta impossível, sobrescrita pontual sem alterar o perfil salvo, produto sem custo (422), permissões.
- Anúncios: vínculo alimenta o mapeamento de importação, duplicidade (409), religação, isolamento entre tenants.
- Preço: piso do produto, margem mínima, confirmação > 20%, histórico imutável e auditoria, permissões; margem e custos ocultos sem `pricing.view`.
- Sincronização: fórmula do estoque publicável (exemplo 100/8/2/5 → 85), envio apenas do que mudou, teto e estoque nunca negativo, revalidação do preço no envio, envio desligado, falha temporária com progresso parcial, recusa do canal por anúncio, **Mercado Livre bloqueado com motivo**, agendamento idempotente por janela.
- Categorias: mapear, atualizar, remover, isolamento, permissões.
- Regressão da Fase 4: salvar parte da configuração da conexão não apaga o restante (bug corrigido: campos ausentes eram gravados como `undefined`).

## Cobertura da Fase 6 (`apps/api/test/fiscal.e2e-spec.ts`, 28 testes + `fiscal.spec.ts`, 13 testes)
**Provedor de transmissão SIMULADO (`ScriptedProvider`) e XMLs sintéticos**: provam o nosso código, não a SEFAZ nem a conformidade do leiaute.
- Assistente: pendências por item (homologação × produção), perguntas ao contador, padrão seguro (homologação), fluxo de validação do contador e reabertura a cada mudança.
- Certificado: senha errada/arquivo inválido/vencido (422), armazenamento cifrado (não decifra em outro tenant), resposta e auditoria sem segredos, substituição apagando o segredo antigo, alertas.
- XML: importação com hash e retenção imutável, duplicidade (inclusive paralela), rejeições bloqueantes sem gravar (e auditadas), XXE, vínculo por GTIN/código/manual, conversão de unidade, criação de fornecedor.
- Conciliação e recebimento: status por item, bloqueios, entrada de estoque com custo do XML, idempotência (3 chamadas simultâneas = 1 recebimento), divergência de custo com confirmação, estorno reabre a nota, homologação nunca recebe.
- Motor: formato da regra, rascunho não vale, aprovação por outra pessoa, imutabilidade (aplicação e banco), versões com vigência, ST/DIFAL como pendência, desativar regra, snapshot reprodutível, isolamento.
- Saída: pendências, idempotência por pedido, prontidão, sem provedor ⇒ 424 sem consumir numeração, autorização, numeração sequencial, 4 transmissões simultâneas ⇒ 1 envio, TIMEOUT/exceção ⇒ consulta (sem novo número), NOT_FOUND ⇒ reenvio com a mesma numeração, rejeição, indisponibilidade, produção exige validação, certificado vencido bloqueia antes de consumir número.
- Unitários: chave de acesso, GTIN, parser/validador de NF-e, motor.

## Cobertura da Fase 7 (`apps/api/test/finance.e2e-spec.ts`, 25 testes + `export.spec.ts`, 3 testes)
Os relatórios de marketplace são CSVs sintéticos e o OFX é gerado pelo teste: provam o nosso código, não o formato real de nenhum banco/canal.
- Títulos: parcelamento sem perda de centavos, recorrência, baixa parcial com juros/multa/desconto, excesso bloqueado, **3 baixas simultâneas ⇒ 1**, saldo esperado (tela desatualizada), estorno (único, não estorna estorno, histórico preservado), cancelamento, limite de aprovação com segregação, recebíveis de pedido (soma das parcelas, duplicidade, marketplace bloqueado).
- XML → contas a pagar: uma por duplicata, idempotência (sequencial e paralela), fornecedor obrigatório, sem duplicatas exige vencimento, homologação nunca gera.
- Comissões: repasse vira título, "pagar" direto não duplica, PAGO só com a quitação.
- Banco: OFX/CSV idempotentes, sugestão, conciliação, valores diferentes, estorno bloqueado enquanto conciliado, permissão.
- Marketplaces: importação idempotente, vínculo ao pedido, divergências, aceite explícito, 2 conciliações simultâneas ⇒ 1, saldo da conta.
- Fluxo de caixa (saldo inicial, realizado, previsto, atrasados) e DRE (receita, CMV, margem, despesas, avisos, base de cálculo, permissão).
- Relatórios: visibilidade por perfil, CSV com BOM e fórmula neutralizada, XLSX válido, auditoria, exportação grande em segundo plano (5.100 linhas) com download restrito a quem pediu.
- Expedição: Correios `NOT_CONFIGURED`, validação de rastreio, embalagem, um envio ativo por pedido, estados finais, unicidade do código.
- Isolamento entre tenants e permissões (vendedor/contador), trilha de auditoria.

## Cobertura da Fase 8 (`apps/api/test/platform.e2e-spec.ts`, 17 testes)
- Planos: visão de uso/limites, bloqueio 402 de produtos (inclusive importação em lote), conexões e pedidos, ilimitado quando não há limite, avaliação vencida ⇒ somente leitura.
- Plataforma: só administradores; apenas metadados e contagens; alteração de plano/situação com auditoria na plataforma **e** no tenant; suspensão bloqueia e reativação libera; catálogo de planos validado; administrador desativado perde o acesso.
- Observabilidade: correlation id (aceita válido, descarta suspeito), `/health/ready`, `/metrics` desligado sem token / protegido com token / sem ids de tenant.
- Backup: pg_dump + restauração em banco temporário com comparação de linhas, RLS e isolamento como `dh_app`; backup cifrado; adulteração e chave errada rejeitadas.
- Revisão estrutural: enumeração de todas as rotas (nenhuma sem proteção), RLS forçada em toda tabela com `tenant_id`, `dh_app` sem BYPASSRLS, imutabilidade, cookies/CSRF/cabeçalhos.

## Cobertura de produto no padrão marketplace (`product-media.e2e-spec.ts`, 8 testes; `channel-products.e2e-spec.ts`, 15 testes)
Servidores **simulados** (loja de fotos do canal e API do Mercado Livre) e conector Sandbox: provam o nosso código, não o comportamento real dos canais.
- Fotos: tipo/dimensões de PNG/JPEG/WebP pelos bytes, ordem e principal, limite de 12 também sob concorrência, recusa de SVG disfarçado/tipo divergente/tamanho/dimensões, permissões e isolamento, URL pública assinada (adulterada, de outra imagem, sem assinatura, expirada).
- Qualidade do cadastro e novos campos (título, condição, garantia, ficha técnica) com validação.
- Canal → base: varredura paginada e idempotente, correspondência por SKU/GTIN, importação com fotos e vínculo, conflito pede vínculo, fotos perigosas (domínio, redirecionamento, HTML disfarçado) viram aviso, importar em lote, ignorar/restaurar, falha do canal, permissões e isolamento.
- Base → canal: pré-visualização com bloqueios, publicação (fotos por URL assinada, categoria mapeada), recusa/incerteza do canal, 3 publicações simultâneas ⇒ 1, canal sem publicação.
- Defesas e conector ML: SSRF (domínio, HTTP, credenciais, redirecionamento, IPs privados), normalização do anúncio, corpo do `POST /items`, varredura por rolagem + multiget, publicação desligada por padrão (nenhuma chamada de criação).

## Visão geral de pedidos e edição de estoque (`orders-dashboard.e2e-spec.ts`, 9 testes)
- Dashboard de pedidos (`GET /api/dashboard/orders`): zerado no início, novos/a enviar/em trânsito/entregues, atraso de envio (aprovado há mais de N horas) e de entrega (enviado há mais de N dias) com datas retroativas gravadas direto no banco, prazos configuráveis (`orders.shippingSlaHours`, `orders.deliverySlaDays`) com validação, período 7/30/90 e recusa de valores inválidos.
- Escopo: vendedor sem `sales.view_all` vê só os próprios pedidos; outra empresa não vê nada (RLS).
- Editar estoque (`POST /api/stock/set-on-hand`): sobe/desce gerando ajuste com histórico, recusa igual ao atual/sem motivo/negativo/abaixo do reservado, exige `stock.adjust`, isolamento entre empresas, idempotência e 4 edições simultâneas para o mesmo valor ⇒ só 1 aplicada.
- "Excluir estoque" na tela é o mesmo endpoint levando o saldo a 0 (ajustes auditáveis; o histórico nunca é apagado).

## Magalu (`magalu.e2e-spec.ts`, 7 testes — servidor simulado)
Servidor **simulado** conforme as páginas oficiais lidas; prova o nosso código, não o comportamento real do Magalu.
- Disponível "sem validação real", pendência clara sem `MAGALU_CLIENT_ID`, URL de login (`choose_tenants=true`, escopos só de leitura, redirect exato), troca do code em JSON, credenciais cifradas, renovação em formulário e refresh antigo invalidado.
- Pedidos: paginação por `meta.links.next`, só o status configurado como pago importa, `paid` não listado não importa por engano, SKU sem produto pede atenção, cancelado registrado, repetir não duplica.
- Catálogo: varredura paginada de SKUs, GTIN inválido descartado, sem título descartado; escrita (preço, estoque, publicação) segue NOT_IMPLEMENTED e nada é enviado.

## Inadimplência (`delinquency.e2e-spec.ts`, 8 testes)
Desligado por padrão; validação (0–365) e permissões; só atenção abaixo do prazo e bloqueio no prazo (criar, editar e enviar pedido, inclusive rascunho antigo); pagamento parcial e total; título cancelado/a pagar ignorados; liberação manual com motivo/permissão/expiração/revogação e auditoria; desligar libera; isolamento entre empresas; resumo ordenado.

## Não coberto ainda
Throttling (desligado em `NODE_ENV=test`), UI (sem testes de componente/E2E de navegador), **qualquer chamada à API real do Mercado Livre ou da SEFAZ**, conformidade do leiaute da NF-e e a API real dos Correios, formatos reais de extrato/relatório de liquidação, UI gateway de pagamento, MFA, carga/desempenho e pentest.

Nota: em dev o API roda código compilado por `tsc` porque o Nest depende de `emitDecoratorMetadata`, que o `tsx`/esbuild não emite.
