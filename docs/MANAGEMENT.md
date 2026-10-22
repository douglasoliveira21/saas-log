# Gestão: metas, margem, giro, orçamento e pacote do contador

Menu **Metas e indicadores** (`/gestao`, permissão `management.view`; definir metas/orçamento exige `management.manage`). Tudo é calculado em centavos a partir dos dados do sistema e **não altera** estoque, pedidos nem títulos.

| Aba | O que mostra | Regra |
|---|---|---|
| Metas e ranking | meta × vendido por vendedor, % atingido, projeção do mês, quanto falta, ranking | venda **confirmada** no mês (data da confirmação), líquida de devoluções; cancelados fora; projeção = ritmo por dia × dias do mês; meses em Brasília (UTC−3) |
| Margem | por produto, cliente ou pedido: venda, custo, margem e % | venda **expedida** no período, líquida de devoluções, custo = custo cadastrado quando o pedido foi criado (`cost_snapshot`); item sem custo entra com custo 0 e é avisado; **não** desconta frete, comissão, tarifa de marketplace nem impostos (veja a DRE) |
| Giro e ruptura | situação de cada produto: ruptura, crítico, atenção, sem giro; cobertura em dias, giro, previsão de 30 dias, compra sugerida, curva ABC | ritmo diário = 60% dos últimos 28 dias + 40% da média do período; crítico = cobertura < prazo de reposição (do produto, ou o padrão informado); compra sugerida = ritmo × (30 dias + prazo) + estoque mínimo − disponível. **Estimativa simples**: sem sazonalidade nem promoções |
| Orçamento | orçado × realizado por categoria e mês (e linha de vendas), com variação e total do ano | realizado: vendas pela data de expedição (produtos − descontos); demais linhas pelo **vencimento** dos títulos da categoria, sem os de pedido, marketplace, comissão e negociação |

Pedido (pop-up em Vendas): quem tem `management.view` vê a **margem bruta da mercadoria** do pedido.

## Pacote do contador (Financeiro → Pacote do contador)
ZIP com `notas_saida.csv`, `notas_entrada.csv`, `lancamentos_financeiros.csv`, `baixas.csv`, `plano_de_contas.csv`, `dre_gerencial.csv`, `LEIA-ME.txt` e a pasta `xml/` (autorizadas de saída e recebidas de entrada, até 5.000). Exige `finance.view` + `reports.export` (o papel Contador passou a ter `reports.export`).

**Não é SPED.** EFD ICMS/IPI, EFD Contribuições e ECD **não foram implementados**: exigem apuração de ICMS/ST/IPI/PIS/COFINS, blocos e validação no PVA da Receita, que dependem das regras do contador e de ICMS-ST (ainda não suportado). O pacote entrega os dados para o escritório gerar o SPED.
