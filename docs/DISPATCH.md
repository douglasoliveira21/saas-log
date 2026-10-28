# Expedição

O pedido confirmado em **Vendas** chega à **Expedição** (Canais e logística → Expedição, permissão `sales.fulfill`). Vendas só acompanha a situação; as etapas são executadas na Expedição.

## Telas
- **Painel e alertas:** pedidos por etapa, expedidos hoje, atrasados, saem hoje, tempo médio até expedir (7 dias), peso em aberto, horário de corte (se configurado) e os **alertas** com os pedidos envolvidos. Atualiza sozinho a cada minuto. Um resumo aparece também na Visão geral.
- **Fila de trabalho:** quadro com cinco etapas (Aguardando separação, Em separação, Prontos para expedir, Expedidos, Entregues). Cada cartão mostra cliente, cidade, itens/peso, saída prevista, tempo na etapa, quem separou/embalou, observação e a ação da vez: *Iniciar separação*, *Marcar embalado*, *Expedir*, *Confirmar entrega*, *Encerrar*. Atalhos para a lista de separação e a conferência (Armazém), urgência e observação.
- **Envios e rastreio:** registro de envio, rastreio manual e embalagens (como antes; precisa de `logistics.view`).

## Alertas (regras)
- **Atrasado:** saída prevista vencida, ou mais de N horas desde a confirmação (config. `orders.shippingSlaHours`, padrão 24 h) sem expedir.
- **Saem hoje:** saída prevista para hoje ainda não embalada. Mostra o horário de corte se houver.
- **Parado:** em separação há 4 h ou mais, ou embalado há 6 h ou mais sem sair (valores fixos no código).
- **Divergência:** a última conferência do pedido acusou diferença.
- **Urgente:** pedido marcado como urgente pela expedição (vai para o topo da fila).

## Regras que continuam valendo
Mudar de etapa usa `POST /sales/orders/:id/advance`: reserva e baixa de estoque, conferência obrigatória (`warehouse.requireCheck`), comissão e avisos ao cliente. Cada etapa grava quem fez e quando (separação e embalagem aparecem no detalhe da venda).
