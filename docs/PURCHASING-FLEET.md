# Compras inteligentes, cotação e frota

## Sugestão de compra (Compras → Sugestão de compra)
Por produto físico ativo: ritmo diário = 60% do ritmo dos últimos 28 dias + 40% da média do período (vendas expedidas líquidas de devolução). Entra na lista quando *(disponível + já em compra)* chega ao ponto de reposição (o maior entre o cadastrado e `ritmo × prazo + estoque mínimo`). Quantidade = `ritmo × (prazo + dias de cobertura) + mínimo − posição`, limitada ao estoque máximo. Prazo = `lead_time_days` do produto (padrão 7). Curva ABC pelo valor consumido (custo × quantidade vendida). Fornecedor/custo = fornecedor principal (último preço) ou custo do produto. **Gerar ordens** cria uma ordem por fornecedor, tudo ou nada, na alçada normal de aprovação. É estimativa estatística: sem sazonalidade, promoções ou múltiplos de embalagem.

## Cotação entre fornecedores (Compras → Cotações)
Cotação com itens e até 10 fornecedores; registra-se a proposta de cada um (preço por item, prazo, frete, condição). Quadro comparativo com o menor preço de cada item e o menor total entre quem cotou tudo. **Fechar** gera as ordens: *melhor total* de um fornecedor (que cotou todos os itens) ou *melhor preço por item* (uma ordem por fornecedor vencedor, com o frete dele). Cotação fechada/cancelada não aceita mais proposta. O sistema **não envia** a cotação aos fornecedores (sem e-mail/portal): as propostas são digitadas.

## Frota e carga (Frota e carga; viagem em Rotas e entregas)
- **Veículos** (placa única, tipo, capacidade em kg) e **custos** (combustível, pedágio, manutenção, motorista, seguro, outros; data não futura; custo de viagem só do veículo da viagem). Lançamentos são imutáveis.
- **Viagem**: escolher o veículo mostra o **peso da carga × capacidade** (peso bruto dos produtos × quantidade; produto sem peso é avisado) e recusa o mesmo veículo em duas viagens ativas no dia.
- **Custo por entrega**: custo do período ÷ paradas entregues, e custo sobre o valor dos pedidos entregues.
- **Manifesto de carga**: veículo, motorista, UFs, pedidos, peso, valor e as **NF-e autorizadas** de cada pedido (avisa pedido sem NF-e). **Não é o MDF-e**: o sistema não emite nem transmite MDF-e à SEFAZ (depende de certificado A1, credenciamento e do leiaute do MDF-e, que não foram implementados nem testados).
