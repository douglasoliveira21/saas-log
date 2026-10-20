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

## Inventário
`OPEN → SUBMITTED → APPROVED | REJECTED`. Abertura grava o retrato do sistema; contagem por produto ou leitura de código de barras/SKU; relatório de divergência. Aprovação (`stock.approve`) gera um `ADJUSTMENT` por divergência *contra o saldo atual*, tudo numa transação: se conflitar com reservas/bloqueios, nada é aplicado. Hoje não há exigência de que o aprovador seja outra pessoa (configuração prevista).

## Importação por planilha
CSV (`;` `,` ou tab; UTF-8; números BR). Simulação (`dryRun`) com erros por linha; sem `skipInvalid`, qualquer erro bloqueia tudo (422). SKU existente é atualizado. `deposito` + `saldo_inicial` cria ajuste auditável (exige `stock.adjust`; só para produto sem saldo no depósito). Limite de 5.000 linhas. **XLSX não é suportado ainda** (exportar como CSV).

## Dados fiscais do produto
NCM/CEST/origem/GTIN tributário são opcionais e nunca inferidos; produto sem NCM é sinalizado como pendência fiscal (lista e indicador do dashboard). Alterações de custo, preço e dados fiscais gravam antes/depois na auditoria.

## Pendências
Lotes, séries e validade; kits e variações; endereçamento físico; produtos substitutos; preço por canal; edição completa de produto na interface (a API já aceita `PATCH`); upload de imagens; fornecedores alternativos além do vínculo simples; histórico de preços de compra.

## Estoque publicado por canal (Fase 5b)
publicável = max(0, disponível − segurança do canal), limitado por `maxPublished` da conexão. O disponível já desconta reservas de pedidos de qualquer canal; a segurança e o teto são configurados por conexão (não há número fixo no código). Prioridade entre canais, estoque dedicado e reserva exclusiva por canal ainda não existem.
