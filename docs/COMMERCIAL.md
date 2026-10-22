# Compras, vendas e comissões (Fase 3)

## Pedido de venda
`DRAFT → (PENDING_APPROVAL) → CONFIRMED → PICKING → PACKED → SHIPPED → DELIVERED → CLOSED`, com `CANCELLED` a partir de qualquer estado anterior à expedição.
- **Confirmar** reserva o estoque do depósito do pedido, tudo em uma transação (se faltar qualquer item, nada é reservado). **Expedir** consome as reservas (baixa o físico e grava `SALE_EXIT` no razão). Pedido expedido não se cancela: usa-se **devolução**.
- **Aprovação**: desconto de item acima de `sales.maxDiscountPct` (padrão 10%) ou preço líquido abaixo do `minPrice` do produto leva o pedido a `PENDING_APPROVAL`. Aprova quem tem `sales.approve` e **não** criou o pedido (exceto o proprietário).
- **Valores em centavos inteiros** (arredondamento comercial); desconto em pontos-base; numeração sequencial por empresa.
- **Escopo de dados**: sem `sales.view_all`, o usuário vê/edita apenas pedidos que criou ou do vendedor vinculado ao seu usuário; vendedor só vende em seu próprio nome.
- **Devolução** parcial/total (`sales.return`): valida quantidade contra o vendido e já devolvido; `restock=true` gera `RETURN_ENTRY`; `restock=false` (avaria) não mexe no estoque.
- Concorrência: o pedido é travado (`FOR UPDATE`) em cada transição; confirmações simultâneas viram uma só; duas ordens pela última unidade → uma confirma e a outra recebe 409.

## Comissões
- Regras (`commission_rules`): percentual sobre a venda líquida do item ou valor fixo por unidade; critérios opcionais: vendedor, categoria, produto, cliente, canal e vigência. **Apenas uma regra por item**: maior prioridade → mais específica → mais antiga (sem aplicação duplicada).
- **Livro de lançamentos** (`sales_commissions`, sem UPDATE de valores nem DELETE): `ACCRUAL` na confirmação; cancelamento e devolução geram `REVERSAL` negativo (devolução proporcional ao acumulado, sem deriva de arredondamento). Situação: `FORECAST → EARNED → PAID`.
- **Reconhecimento** configurável em Políticas comerciais: pedido confirmado (padrão), enviado ou entregue. "Venda faturada" e "recebimento confirmado" dependem de Fiscal/Financeiro (não disponíveis).
- Pagamento marca como pagas as comissões aprovadas do vendedor; estorno após pagamento vira saldo negativo aprovado, descontado em pagamento futuro (saldo negativo não é pago). O pagamento ainda **não gera conta a pagar** (Fase 7).
- Pendências: faixas progressivas por meta, comissão por margem, metas e equipe/supervisor operacional, demonstrativo exportável.

## Compras
`DRAFT → (PENDING_APPROVAL) → APPROVED → PARTIALLY_RECEIVED → RECEIVED` (ou `CANCELLED`).
- Até `purchases.approvalLimit` (padrão R$ 5.000) a ordem é aprovada ao enviar; acima, exige `purchases.approve` de outro usuário.
- **Recebimento** (`purchases.receive`): parcial, nunca acima do pendente (409 informa a divergência), com chave de idempotência; gera `PURCHASE_ENTRY` por item, atualiza `qty_received`, `last_price` do fornecedor e o **custo médio ponderado** do produto (considera o saldo físico total antes da entrada). **Estorno** do recebimento gera movimentos inversos e reverte as quantidades (o custo médio **não** é recalculado para trás). "Encerrar com pendência" aceita a falta e registra a divergência na auditoria.
- **Sugestão de reposição** com justificativa (posição = disponível + em compra, ponto de reposição, consumo dos últimos 30 dias, prazo): nada é comprado automaticamente.
- Pendências: cotações e comparação de fornecedores, solicitação de compra, conferência com NF-e/XML (Fase 6), contas a pagar (Fase 7), lotes/validade, substituição de produto, sazonalidade nas sugestões.

## Configurações (`tenant_settings`)
`commission.event`, `sales.maxDiscountPct`, `purchases.approvalLimit` — apenas `tenant.manage`; mudanças gravam antes/depois na auditoria.

## Horário de corte das vendas (fora de marketplace)
**Onde configurar:** Configurações → *Horário de corte das vendas* (`sales.cutoffTime`, formato HH:MM; vazio = sem corte, que é o padrão) e *Considerar só dias úteis* (`sales.cutoffBusinessDaysOnly`, ligado por padrão).

**Regra:** ao **confirmar** o pedido, se ele vier antes do horário (estritamente antes; no horário exato já conta como depois) a **saída prevista** é o mesmo dia; a partir do horário, é o dia seguinte. Com "só dias úteis", sábado e domingo saem na segunda. O pedido guarda a data (`dispatchDate`) e se ficou adiado (`dispatchDeferred`: passou do corte ou caiu em fim de semana). Fuso fixo de Brasília (UTC-3). **Feriados não são considerados** (não há calendário de feriados).

**Marketplace:** pedidos importados de canais **não** seguem o corte (continuam pelo prazo em horas de envio, `orders.shippingSlaHours`).

**Onde aparece:** aviso na tela de novo pedido ("confirmado agora, sai hoje / fica para dd/mm"), selo "Saída prevista" no pedido e, na Visão geral, "N com saída prevista para hoje"; com corte configurado, pedido cuja data de saída já passou e ainda não saiu entra em **atrasados para enviar** (pedidos sem data seguem o prazo em horas). Endpoint: `GET /api/sales/cutoff`.

## Perfil do cliente na compra (novo, ativo, voltou a comprar)
**Regra:** conta como compra o pedido **confirmado ou adiante** (rascunho, aguardando aprovação e cancelado não contam). No momento da compra o pedido recebe o selo (`customerType`):
- **Cliente novo · 1ª compra** — nunca comprou antes;
- **Cliente ativo** — a última compra foi há no máximo N dias;
- **Voltou a comprar** — a última compra foi há **mais** de N dias.
N é *Cliente inativo após quantos dias sem comprar?* (`customers.inactiveAfterDays`, padrão **60**, de 1 a 730, em Configurações). O selo fica gravado no pedido: mudar o prazo depois não reescreve o histórico.

**Onde aparece:** ao escolher o cliente no novo pedido (frase com última compra e histórico), no pedido (lista e detalhe) e na lista de Clientes (Novo / Ativo / Inativo há N dias, com nº de pedidos e última compra). Endpoint: `GET /api/customers/:id/purchase-profile`.
