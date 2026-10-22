# Modelo de dados (Fases 1-6)

Fonte da verdade: `apps/api/prisma/schema.prisma` + migrations em `apps/api/prisma/migrations`.

| Tabela | Escopo | Observações |
|---|---|---|
| `plans` | global | limites em JSON (`users`, `establishments`, `warehouses`); plano `trial` semeado pela migration |
| `users` | global | e-mail minúsculo único; hash scrypt; bloqueio após 5 falhas (15 min) |
| `refresh_sessions` | global | hash SHA-256 do token opaco; `family_id` para detectar reutilização |
| `tenants` | RLS | `status` TRIAL/ACTIVE/SUSPENDED; suspensão bloqueia acesso sem apagar dados |
| `roles`, `role_permissions` | RLS | permissões como códigos de `src/access/permissions.ts` |
| `memberships` | RLS | usuário × tenant × papel |
| `companies` | RLS | pessoa jurídica; CNPJ único por tenant |
| `establishments` | RLS | CNPJ/IE/CNAE/endereço; matriz, filial, CD |
| `warehouses` | RLS | código único por tenant; próprio/terceiros/consignado |
| `audit_logs` | RLS, append-only | metadados com segredos removidos |
| `product_categories`, `products` | RLS | SKU/código de barras únicos por tenant; campos fiscais opcionais |
| `suppliers`, `product_suppliers` | RLS | CNPJ/CPF único por tenant; vínculo produto×fornecedor |
| `stock_balances` | RLS + CHECKs | físico/reservado/bloqueado por produto×depósito; disponível nunca negativo |
| `stock_movements` | RLS, append-only | razão com saldo antes/depois, chave idempotente, estorno único |
| `stock_reservations` | RLS | ACTIVE/RELEASED/CONSUMED, chave idempotente |
| `inventory_counts`, `inventory_count_items` | RLS | contagem com retrato do sistema e divergência |
| `customers`, `salespeople` | RLS | CPF/CNPJ único por tenant; vendedor pode ser vinculado a um usuário |
| `sales_orders`, `sales_order_items` | RLS + CHECKs | numeração por tenant; preços/descontos em decimais de 2 casas; reserva por item |
| `return_requests`, `return_items` | RLS, append-only | devoluções parciais/totais |
| `commission_rules`, `sales_commissions` | RLS | livro de comissões sem DELETE |
| `purchase_orders`, `purchase_order_items` | RLS + CHECKs | `qty_received` entre 0 e o pedido |
| `goods_receipts`, `goods_receipt_items` | RLS | recebimentos com chave idempotente e estorno |
| `tenant_settings`, `document_counters` | RLS | políticas por tenant e numeração sequencial |
| `marketplace_connections` | RLS | estado da conexão, credenciais e segredo de webhook cifrados |
| `background_jobs` | RLS (+ funções definer para o worker) | fila durável, tentativas, DEAD, chave idempotente |
| `webhook_events` | RLS | evento recebido, único por (conexão, dedupe_key) |
| `integration_logs` | RLS, append-only | segredos removidos |
| `external_entity_mappings` | RLS | vínculo interno × externo (uso na Fase 5) |
| `external_orders` | RLS | livro de pedidos importados de canais (idempotência e pendências); `sales_orders` ganha `external_source`/`external_ref` únicos |
| `channel_listings` | RLS | produto × conexão: ID do anúncio, preço aprovado, último estoque/preço enviados, situação do envio |
| `price_history` | RLS, append-only | alterações de preço de canal com margem e motivo |
| `channel_category_mappings` | RLS | categoria do ERP → categoria do canal |
| `fiscal_configurations` | RLS | parâmetros fiscais por estabelecimento e validação do contador |
| `fiscal_certificates` | RLS | metadados do A1; PFX e senha cifrados (apagados ao substituir); um ativo por estabelecimento |
| `fiscal_documents`, `fiscal_document_items` | RLS | entrada (XML) e saída (NF-e); itens de entrada imutáveis por gatilho |
| `fiscal_xml_files` | RLS, append-only | XML original com SHA-256 |
| `fiscal_series` | RLS | numeração atômica por estabelecimento/série/ambiente |
| `tax_rules`, `tax_rule_versions` | RLS | regras do tenant; versão aprovada imutável (gatilho) |
| `tax_calculations` | RLS, append-only | retrato reprodutível do cálculo |
| `financial_accounts`, `financial_categories`, `cost_centers` | RLS | cadastros financeiros (categoria tem `kind` para o DRE) |
| `financial_titles` | RLS, CHECKs de valor | contas a pagar/receber; único `(tenant, origem, ref)` garante idempotência de XML/pedido/marketplace |
| `financial_settlements` | RLS, **append-only** | baixas e estornos (`REVERSAL` único por baixa) |
| `bank_statement_lines` | RLS | extrato importado, único `(conta, fitid)`; uma baixa por linha |
| `marketplace_settlements` | RLS | linhas do relatório de liquidação, únicas `(conexão, relatório, pedido)` |
| `packagings`, `shipments`, `shipment_events` | RLS (eventos append-only) | expedição e rastreio manual |
| `drivers`, `delivery_routes`, `delivery_stops`, `delivery_proofs` | RLS (comprovante só INSERT; 1 parada pendente por pedido) | rotas, motoristas e canhotos (docs/DELIVERY-ROUTES.md) |
| `report_exports` | RLS | exportações grandes (conteúdo em `bytea`, expiram em 3 dias) |
| `subscriptions` | RLS (somente SELECT ao runtime) | histórico de assinatura; escrita só por `platform_update_tenant` |
| `platform_admins`, `platform_audit_log` | RLS, **sem privilégios ao runtime** | administradores da plataforma e sua auditoria; acesso só por funções `SECURITY DEFINER` |
| `plans` | sem RLS (catálogo global, SELECT) | + preço, descrição e ordem; edição só por `platform_upsert_plan` |

Funções `SECURITY DEFINER` (todas com `search_path` fixo e EXECUTE só para `dh_app`): worker/fila (`claim_background_jobs`, `list_active_connections`, …), `find_connections_by_account`, `queue_stats` e `platform_*`.

Decisões: sem exclusão física (usa `active`/`status`); endereço embutido por ora (ADR-0003); `Subscription`, `Permission` (catálogo em código) e demais entidades da especificação entram com seus módulos.
