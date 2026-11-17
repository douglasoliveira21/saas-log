# Shopee Open Platform v2

O canal aparece em **Integrações → Shopee → Conectar**. Autorize uma loja brasileira por conexão. Os testes usam respostas simuladas e um banco local isolado. A validação com loja real está pendente, por isso as capacidades são `IMPLEMENTED_UNVERIFIED`.

## Configuração

1. Cadastre e obtenha aprovação do aplicativo no Shopee Open Platform, com acesso às APIs de loja, pedidos e produtos usadas abaixo.
2. Configure o domínio de retorno da produção como `log.vgon.com.br` para esta instalação. O retorno completo enviado à Shopee é `https://log.vgon.com.br/api/integrations/callback`. Em outras instalações, o endereço vem de `WEB_ORIGIN`.
3. No ambiente do serviço **API**, configure `SHOPEE_PARTNER_ID` e `SHOPEE_PARTNER_KEY`. As credenciais devem pertencer ao mesmo ambiente. Defina `SHOPEE_SANDBOX=true` apenas para o sandbox Shopee. O padrão é produção.
4. Aplique a migração Prisma incluída e gere o Prisma Client no deploy.
5. Em Integrações, conecte a Shopee, selecione o depósito do ERP e autorize com a conta da loja. Autorizações de conta principal com múltiplas lojas exigem um fluxo adicional e são recusadas com orientação na tela.
6. Ao retornar, o sistema testa a loja. Ative a conexão para iniciar a importação periódica. O worker da API deve estar habilitado.
7. Importe o catálogo ou vincule anúncios aos produtos do ERP. Variações usam `item_id:model_id`. Cada variação tem seu próprio SKU e estoque. Habilite preço e estoque conforme a configuração da conexão.

Partner Key e tokens ficam no servidor. Tokens de cada loja são cifrados com as mesmas proteções por tenant das demais integrações. A renovação tem uma reserva de execução no banco para impedir dois workers de rotacionarem o mesmo token ao mesmo tempo.

## Operações

| Capacidade | Operações v2 |
|---|---|
| Autorização | Link BR `/auth`, troca `/api/v2/auth/token/get`, renovação `/api/v2/auth/access_token/get` |
| Teste da conexão | `/api/v2/shop/get_shop_info`, valida região BR e loja NORMAL |
| Pedidos | `/api/v2/order/get_order_list` por update_time e `/api/v2/order/get_order_detail` |
| Catálogo e imagens | `/api/v2/product/get_item_list`, `get_item_base_info` e `get_model_list` |
| Preço de anúncio vinculado | `/api/v2/product/update_price`, por item/modelo, confirma success_list |
| Estoque de anúncio vinculado | `/api/v2/product/update_stock`, usa seller_stock e confirma success_list |

Pedidos com estado de venda liberada são normalizados para o importador existente. Pedidos UNPAID, PENDING e IN_CANCEL aguardam confirmação. CANCELLED segue a política de cancelamento já configurada. Produtos e pedidos com moeda diferente de BRL são recusados. Variações sem SKU próprio precisam de vínculo explícito.

A leitura de pedidos percorre janelas de 14 dias. O cursor preserva a janela e a página. Após dez páginas, a fila cria uma continuação e só marca a sincronização quando todas as páginas terminarem.

O envio de estoque cobre seller_stock sem location_id, para o depósito padrão da loja. Contas com múltiplos depósitos Shopee podem exigir location_id e configuração adicional. Publicação de novos anúncios, gestão de envios e push/webhooks ainda constam como PLANNED. A importação usa reconciliação periódica.

## Documentação oficial consultada em 16/11/2026

O portal respondeu à leitura HTTP direta pelo serviço público `/opservice/api/v1/doc/api/?version=2&api_name=...`. Os campos de requisição, resposta e erros foram consultados para cada operação implementada. O guia de autorização foi lido em `/opservice/api/v1/developer_guide/detail?document_id=20&language_code=en`.

- [Authorization and Authentication](https://open.shopee.com/developer-guide/20)
- [Pedidos](https://open.shopee.com/documents/v2/v2.order.get_order_list?module=94&type=1)
- [Catálogo](https://open.shopee.com/documents/v2/v2.product.get_item_base_info?module=89&type=1)
- [Preço](https://open.shopee.com/documents/v2/v2.product.update_price?module=89&type=1)
- [Estoque](https://open.shopee.com/documents/v2/v2.product.update_stock?module=89&type=1)
