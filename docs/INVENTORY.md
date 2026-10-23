# Estoque e catálogo (Fase 2)

## Regras
- **Disponível = físico − reservado − bloqueado** (função única `available` em `stock.service.ts`). Quantidade de segurança, teto anunciado e reservas por canal são regras de canal e entram na Fase 4 — não há números fixos no código.
- Saldo por produto × depósito em `stock_balances`. Só produtos `PHYSICAL` têm estoque; kits/variações exigem a lógica de consumo de componentes (Fase 3).
- **Razão imutável** (`stock_movements`): o papel de runtime só tem `INSERT`/`SELECT`. Cada movimento guarda quantidade com sinal, saldo antes/depois, motivo, usuário e referência. Correção = movimento `REVERSAL` (um por original, garantido por índice único). Transferências são estornadas por transferência inversa.
- **Concorrência**: toda alteração de saldo é um `UPDATE … WHERE disponível_resultante >= 0 RETURNING` atômico (a linha fica travada até o fim da transação; a condição é reavaliada após o lock). Além disso, `CHECK` no banco impede `on_hand`, `reserved`, `blocked` ou o disponível negativos. Transferências travam as duas linhas em ordem determinística (sem deadlock).
- **Idempotência**: `idempotencyKey` (por tenant) em movimentos e reservas. Repetição devolve o resultado original com `replayed: true`, inclusive sob concorrência (a corrida vira replay).
- **Reservas**: `ACTIVE → RELEASED | CONSUMED`. Consumir baixa o físico e gera `SALE_EXIT`; cada transição ocorre uma única vez.
- **Bloqueio**: `POST /stock/blocks` (permissão `stock.adjust`), reduz o disponível sem alterar o físico.
- Estoque negativo não é permitido (ainda não existe fluxo de autorização para isso).

## Inventário (removido)
> **Removido do produto:** a tela, as rotas (`/api/inventory/counts`), o serviço e a permissão `inventory.count` foram retirados porque não serão usados. As tabelas `inventory_counts` e `inventory_count_items` permanecem no banco (vazias de uso) para não perder histórico; o texto abaixo descreve o que existia.

`OPEN → SUBMITTED → APPROVED | REJECTED`. Abertura grava o retrato do sistema; contagem por produto ou leitura de código de barras/SKU; relatório de divergência. Aprovação (`stock.approve`) gera um `ADJUSTMENT` por divergência *contra o saldo atual*, tudo numa transação: se conflitar com reservas/bloqueios, nada é aplicado. Hoje não há exigência de que o aprovador seja outra pessoa (configuração prevista).

## Importação por planilha
CSV (`;` `,` ou tab; UTF-8; números BR). Simulação (`dryRun`) com erros por linha; sem `skipInvalid`, qualquer erro bloqueia tudo (422). SKU existente é atualizado. `deposito` + `saldo_inicial` cria ajuste auditável (exige `stock.adjust`; só para produto sem saldo no depósito). Limite de 5.000 linhas. **XLSX não é suportado ainda** (exportar como CSV).

## Dados fiscais do produto
NCM/CEST/origem/GTIN tributário são opcionais e nunca inferidos; produto sem NCM é sinalizado como pendência fiscal (lista e indicador do dashboard). Alterações de custo, preço e dados fiscais gravam antes/depois na auditoria.

## Pendências
Lotes, séries e validade; kits e variações; endereçamento físico; produtos substitutos; preço por canal; edição completa de produto na interface (a API já aceita `PATCH`); upload de imagens; fornecedores alternativos além do vínculo simples; histórico de preços de compra.

## Estoque publicado por canal (Fase 5b)
publicável = max(0, disponível − segurança do canal), limitado por `maxPublished` da conexão. O disponível já desconta reservas de pedidos de qualquer canal; a segurança e o teto são configurados por conexão (não há número fixo no código). Prioridade entre canais, estoque dedicado e reserva exclusiva por canal ainda não existem.

## Lote e validade (PEPS/FEFO) e armazém
- **Controle de lote por produto** (`products.track_lots`; Estoque → Lotes e validade). Ao ligar, o saldo atual vira o lote **LEGADO** (sem validade) em cada depósito. Depois disso: **entrada** exige lote (e, se houver, validade; lote já vencido não entra); **saída** (venda, uso interno, transferência) sai do lote que **vence primeiro**, depois do mais antigo; **lote vencido não é vendido** (só sai como perda/avaria/ajuste, escolhendo o lote); **devolução** volta aos lotes de origem; **transferência** leva lote e validade; estorno desfaz nos mesmos lotes. Cada movimento guarda de quais lotes saiu (`stock_lot_movements`) para rastreabilidade. O gancho fica em `applyMovement` e no consumo de reserva (`lots-core.ts`), dentro da mesma transação do saldo. Desligar só com o saldo em lotes zerado.
- **Endereços** (`warehouse_locations`, `stock_location_items`): código tipo `A-01-02`. A soma dos endereços nunca passa do saldo físico; o que não tem endereço aparece em "Para guardar". Saídas baixam dos endereços (lote a lote, em ordem de código). Entradas podem informar o endereço.
- **Lista de separação** (Armazém): por produto, lote que vence primeiro e endereços em ordem de caminho; vários pedidos do mesmo depósito somados; impressão.
- **Conferência** por leitor de código de barras (ou SKU): resultado OK/DIVERGENTE gravado; com `warehouse.requireCheck` ligado, o pedido só vai a "embalado" com a última conferência OK.
- **Limites:** sem inventário/contagem cíclica (removido); lote sem controle de quantidade mínima de validade por cliente; marketplace não deixa escolher lote (sai FEFO), mas respeita a validade mínima configurada; transferências entre depósitos exigem que a saída tenha lotes registrados.

## Validade mínima por cliente e por canal
- **Cliente** (Clientes → Crédito → "Validade mínima na entrega"): dias de validade que o lote precisa ter. Na **confirmação** do pedido o sistema confere se há lote que atenda (senão recusa, com o motivo); na **expedição** e na **lista de separação** pula os lotes mais curtos. Lote sem validade informada é aceito.
- **Marketplace** (Configurações → "Validade mínima dos lotes em pedidos de marketplace"): o marketplace não escolhe o lote, então o sistema aplica essa regra única a todos os pedidos de canal.
- Não considera prazos de trânsito (a validade é contada da data da expedição).
