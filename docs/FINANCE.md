# Financeiro, relatórios e expedição (Fase 7)

**Estado:** implementado e testado com banco real (`apps/api/test/finance.e2e-spec.ts`, 25 testes). Itens que dependem de credenciais, contratos ou fontes oficiais não consultadas estão em [Pendências](#pendências-e-dependências-externas).

## Princípios
- Valores em **centavos inteiros** nos cálculos (`Decimal(14,2)` no banco); parcelamento distribui a diferença de centavos na última parcela, nunca perde nem cria dinheiro.
- **Sem exclusão física.** Baixa é um lançamento imutável (`financial_settlements` só aceita INSERT/SELECT — sem UPDATE/DELETE para o papel de runtime). Estorno cria um lançamento inverso (`kind = REVERSAL`, único por baixa) e o histórico permanece.
- Toda mutação roda em transação com `SELECT … FOR UPDATE` no título: duas baixas simultâneas do mesmo título resultam em **uma** (testado com 3 requisições paralelas).
- Isolamento por tenant: RLS FORCE nas 11 tabelas novas + chaves compostas `(tenant_id, id)`; usar conta/categoria de outro tenant dá 400/404.

## Contas a pagar e a receber
| Operação | Regra |
|---|---|
| Lançamento | Único, **parcelado** (divide o total) ou **recorrente mensal**; fornecedor/cliente, categoria e centro de custo validados no tenant. |
| Baixa (total/parcial) | `principal = valor − juros − multa + desconto`; principal não pode exceder o saldo; `expectedOutstanding` opcional impede baixa em tela desatualizada (409). Atualiza o saldo da conta financeira. |
| Estorno | Lançamento inverso com motivo; bloqueado se a baixa estiver conciliada com o extrato (desfazer a conciliação primeiro). Não se estorna um estorno. |
| Cancelamento | Só sem baixas; libera comissões vinculadas se for repasse. |
| Aprovação | Pagamento acima de `finance.paymentApprovalLimit` (padrão R$ 10.000, configurável em Políticas) exige `finance.approve`, e quem lançou não aprova (exceto proprietário). |
| Atraso | Calculado na consulta (dias em atraso); **sem juros/multa automáticos** — a política de encargos é do usuário e é informada na baixa. |

### Origens automáticas
- **Duplicatas do XML recebido** (`POST /finance/from-xml/:docId`): uma conta a pagar por duplicata, chave de idempotência `chaveDeAcesso:nDup` (reprocessar não duplica, inclusive em paralelo). Exige fornecedor vinculado; a soma das duplicatas deve igualar o valor da nota; sem `<cobr>` usa o total com vencimento informado; **nota de homologação nunca gera contas**.
- **Pedido de venda** (`POST /finance/from-order/:orderId`): parcelas devem somar o total do pedido; bloqueia segunda geração. Pedidos de **marketplace** não geram recebível por aqui (o dinheiro vem pela conciliação do canal).
- **Comissões** (`POST /finance/commission-payout`): agrupa as comissões aprovadas (`EARNED`, sem repasse) de um vendedor em **uma conta a pagar**. As comissões só viram `PAID` quando o título é quitado; estornar a baixa as devolve a `EARNED`; cancelar o título as libera. O antigo "pagar comissões" direto ignora comissões já comprometidas em repasse (sem pagamento duplo).

## Conciliação bancária
Importa extrato **OFX** (1.x/2.x) ou **CSV** (`data;descricao;valor[;id]`, datas dd/mm/aaaa e valores no padrão BR). Idempotente por `(conta, FITID)`; no CSV sem id deriva um hash estável e lançamentos idênticos no mesmo arquivo são distintos (`#2`, `#3`). O sistema **sugere** baixas da mesma conta, mesmo valor com sinal e data até 3 dias; o usuário confirma. Valores diferentes não conciliam (ajustar via estorno/novo lançamento). Cada conciliação/desfazer é auditado.

## Conciliação de marketplaces
O dinheiro recebido **não** é o total dos pedidos. A partir do **relatório de liquidação** exportado pelo canal (CSV: `pedido; bruto; comissao; tarifa_fixa; tarifa_pagamento; frete; ajustes; reembolsos; liquido; data_prevista; data_recebimento`):
1. Importação idempotente por `(conexão, relatório, pedido)`; até 5.000 linhas; linhas inválidas são reportadas com número da linha.
2. Cada linha é ligada ao pedido pelo livro `external_orders`. Estados: `IMPORTED`, `UNLINKED` (sem pedido no ERP), `DIVERGENT`, `RECONCILED`.
3. Divergências detectadas: líquido que não fecha com os componentes (`NET_INCONSISTENT`), bruto diferente do total do pedido (`GROSS_DIFFERS_FROM_ORDER`), reembolso presente (`HAS_REFUND`).
4. **Conciliar** cria um recebível do **líquido** (origem `MARKETPLACE`, ref `mkt:<id>`) e já o baixa na conta, na data de recebimento. Divergência exige `acceptDivergence` explícito (fica auditado). Duas conciliações simultâneas → uma só.
5. Previsões (`data_prevista` sem recebimento) entram no fluxo de caixa como "marketplaces previstos".

> **Não implementado:** leitura direta da API financeira dos canais (liquidações/pagamentos). Depende de credenciais do Mercado Livre/Amazon/Shopee e da documentação vigente de cada API; por isso o insumo é o relatório exportado.

## Fluxo de caixa (`GET /finance/cashflow`)
- Saldo inicial = saldos de abertura das contas + baixas anteriores ao período (filtros por conta e centro de custo).
- Por dia/semana/mês: **realizado** (baixas), **previsto** (vencimentos), **pendente** (em aberto) e **marketplaces previstos**; saldo final acumulado. Vencidos em aberto entram como pendência no período que contém hoje e aparecem separados em `overdue`.
- Limite de 400 dias por consulta. O pendente não é filtrado por conta (título aberto ainda não tem conta de baixa).

## DRE gerencial (`GET /finance/dre`)
Receita bruta (pedidos **expedidos** no período + categorias de receita lançadas) → deduções (descontos, devoluções, categorias de dedução) → receita líquida → CMV (custo gravado no pedido, `costSnapshot`; devolução reposta abate) → margem bruta → despesas variáveis (comissões de vendedores, tarifas de marketplace importadas, categorias variáveis) → margem de contribuição → despesas operacionais/financeiras/outras (inclui títulos sem categoria, com aviso) → **resultado gerencial**.
- **Regime:** receita por data de expedição; despesas por vencimento do título; comissões por data de aprovação. Não é regime de caixa nem competência contábil formal.
- **Não substitui a escrituração contábil.** Tributos sobre vendas só aparecem se lançados em categorias de Dedução; apuração de impostos depende do contador/motor fiscal.
- Avisos explícitos: itens vendidos sem custo cadastrado (CMV subestimado) e despesas sem categoria.

## Relatórios e exportação
Relatórios: vendas, estoque, contas a receber, contas a pagar, comissões, liquidação de marketplaces, fluxo de caixa e DRE. Cada um exige `reports.view` **e** a permissão do módulo de origem (ex.: o perfil Financeiro não vê estoque).
- Exportação CSV (BOM UTF-8, `;`, vírgula decimal) e XLSX (gerado com `fflate`). **Proteção contra injeção de fórmula**: textos iniciados por `= + - @` TAB CR recebem apóstrofo.
- Até 5.000 linhas: arquivo imediato. Acima: `202` + job `report.export` (fila PostgreSQL); download restrito a **quem pediu** (outro usuário do mesmo tenant e outro tenant recebem 404), expira em 3 dias, limite de 100 mil linhas.
- Toda exportação é auditada (`report.exported`: relatório, formato, filtros, linhas).

## Expedição e Correios
- Embalagens (dimensões/peso máximo), fila de pedidos prontos, **envio por pedido** (um ativo por vez), código de rastreio com formato validado (`AA123456789BR`) e único por transportadora, eventos de rastreio **manuais** com máquina de estados (estado final não retrocede; evento não pode estar no futuro; `DELIVERED`/`POSTED` preenchem as datas).
- **Correios sem credenciais:** cotação, pré-postagem/etiqueta e rastreamento automático respondem `NOT_CONFIGURED` em `GET /logistics/capabilities`. **Nada é simulado.** Quando houver contrato e credenciais, o conector entrará pela mesma interface de conectores da Fase 4.

## Permissões
`finance.view`, `finance.manage`, `finance.approve`, `finance.reconcile`, `reports.view`, `reports.export`, `logistics.view`, `logistics.manage`. Dados bancários das contas só aparecem para `finance.manage`.

## Pendências e dependências externas
| Item | Depende de |
|---|---|
| Cotação/etiqueta/rastreamento automático Correios | Contrato e credenciais dos Correios; documentação oficial vigente da API (**não consultada** nesta fase) |
| Liquidações direto da API de Mercado Livre/Amazon/Shopee | Contas de desenvolvedor/vendedor do usuário e docs vigentes |
| Regras de encargos (juros/multa) por cliente/fornecedor | Política do negócio |
| Boletos/PIX/CNAB (remessa/retorno), pagamento via banco | Convênio e layout do banco |
| Conciliação de cartão/adquirente | Arquivos/API da adquirente |
| DRE contábil, tributos e fechamento | Contador; motor fiscal validado |
| Rateio entre centros de custo, orçamento × realizado, transferência entre contas | Não implementados |
| Notificações de vencimento | Módulo de notificações (pendente) |
