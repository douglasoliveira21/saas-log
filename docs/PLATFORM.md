# Planos, assinaturas e administração da plataforma (Fase 8)

## Planos e limites
- Catálogo em `plans` (código, nome, `limits` JSON, `price_cents`, ativo). Seed: `trial`, `starter`, `pro`, `enterprise`. **Os limites de starter/pro e todos os preços são marcadores iniciais** (preço nulo = "a combinar"): definição comercial é sua, editável em **Plataforma → planos** (`PUT /api/platform/plans/:code`).
- Chaves de limite: `users`, `establishments`, `warehouses`, `products`, `connections`, `ordersPerMonth`. Chave ausente = ilimitado.
- Aplicação (HTTP 402 com mensagem clara): criar usuário/estabelecimento/depósito, produto (inclusive **importação em lote**: nada é gravado se estourar), conexão de marketplace e pedido de venda (mês corrente, exceto cancelados).
- **Pedidos importados de marketplaces nunca são bloqueados**: perder uma venda já paga seria pior que exceder o plano. O excedente aparece em *Plano e uso* ("acima do plano").
- Reduzir limites não apaga nem bloqueia o que já existe; só impede novas criações.

## Ciclo de vida do tenant
| Situação | Efeito |
|---|---|
| `TRIAL` (14 dias) | Uso normal com limites do plano `trial`. |
| `TRIAL` vencido | **Somente leitura**: escritas retornam 402; leitura, login e relatórios seguem funcionando (dados acessíveis para exportar). |
| `ACTIVE` | Plano contratado. |
| `SUSPENDED` | Acesso bloqueado (403) até reativação; dados preservados. |
Nada é excluído automaticamente; exclusão/anonimização de tenant sob LGPD **não está implementada** (ver SECURITY-REVIEW.md).

## Assinaturas
`subscriptions` guarda o histórico (plano, situação, período, nota). **Não há gateway de pagamento integrado** (nem cobrança recorrente, nota de serviço ou régua de inadimplência): a contratação é registrada manualmente por um administrador da plataforma, e a tela *Plano e uso* diz isso. Integrar um gateway depende de escolha do provedor e de credenciais.

## Administrador global
- **Quem:** usuários listados em `platform_admins`. A concessão só ocorre por script com acesso direto ao banco (`npm run platform-admin -- grant|revoke|list`) — **não existe rota de API** para virar administrador, então um tenant não consegue se promover.
- **Como o banco protege:** o papel de runtime não tem privilégio algum sobre `platform_admins` e `platform_audit_log`. As operações passam por funções `SECURITY DEFINER` estreitas (`platform_list_tenants`, `platform_update_tenant`, `platform_upsert_plan`, `platform_audit`) que começam com `platform_require()` (falha com `42501` se `app.user_id` não é admin ativo). Usuário desativado perde o acesso na hora.
- **O que vê:** metadados e contagens (situação, plano, usuários, produtos, pedidos em 30 dias, conexões, última atividade). **Não** lê clientes, pedidos, notas, financeiro nem credenciais; o próprio papel de tenant do admin continua restrito ao tenant dele.
- **O que faz:** alterar situação/plano/fim da avaliação (motivo obrigatório), editar planos, ver fila de trabalhos e a auditoria da plataforma. Cada alteração grava em `platform_audit_log` **e** na auditoria do tenant afetado (`platform.subscription_changed`), para transparência.
- **Não implementado:** suporte "entrar como" o tenant (impersonação), exclusão/exportação de tenant, múltiplos níveis de administrador da plataforma, MFA obrigatório para administradores (**recomendado antes de usar em produção**).
