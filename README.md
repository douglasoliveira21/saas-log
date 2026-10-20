# DistribuiHub ERP

ERP SaaS multi-tenant para distribuidoras brasileiras (nome provisório, centralizado em `APP_NAME` / `apps/web/src/lib/brand.ts`).

**Estado atual: Fases 1 a 4 concluídas (fundação, catálogo/estoque, compras/vendas/comissões e central de integrações); Fase 5 parcial (Mercado Livre sem validação real) e Fase 6 (fiscal) concluída no que não depende de contador/certificado; Fase 7 (financeiro, conciliações, fluxo de caixa, DRE, relatórios e expedição) concluída no que não depende de credenciais — ver `docs/FINANCE.md`; Fase 8 (planos, administrador global, backup/restore testado, observabilidade, revisão de segurança, implantação) concluída no que não depende de terceiros — ver `docs/PLATFORM.md`, `docs/DEPLOYMENT.md` e `docs/SECURITY-REVIEW.md`. Faltam, entre outros, gateway de pagamento, MFA, LGPD e CI.** Login real, tenants isolados (aplicação + RLS no PostgreSQL), RBAC, auditoria, estrutura empresa/estabelecimento/depósito layout principal, produtos, fornecedores, estoque multidepósito (movimentos, reservas, inventário) importação CSV, clientes, pedidos de venda com devoluções, compras com recebimento, comissões e a infraestrutura de integrações (fila, webhooks, credenciais cifradas, monitoramento — **Mercado Livre: OAuth e importação de pedidos implementados, ainda sem validação com conta real**). Os demais módulos aparecem no menu como "Fase N" e **não estão implementados** (ver `docs/ROADMAP.md`).

## Requisitos
- Node.js ≥ 20 (testado com 24) e npm ≥ 10
- PostgreSQL ≥ 15 (testado com 18). Docker **não** é necessário: `npm run db:start` sobe um cluster isolado em `.data/pg` (porta 5439) usando os binários locais do PostgreSQL (defina `PG_BIN` se `pg_ctl` não estiver no PATH).

## Como executar
```bash
npm install
cp apps/api/.env.example apps/api/.env      # ajuste JWT_SECRET e CREDENTIALS_KEY (veja o arquivo)
npm run db:start                            # PostgreSQL de desenvolvimento (opcional se já tiver um)
npm run db:setup                            # migrações + habilita o papel de runtime dh_app
npm run db:seed -w apps/api                 # dados de demonstração (dois tenants)
npm run dev:api                             # http://localhost:3001/api  (compila com tsc e inicia)
npm run dev:web                             # http://localhost:3000
```
Usuários de demonstração (senha em `SEED_PASSWORD`, somente desenvolvimento): `dono@demo.local`, `vendedor@demo.local`, `auditor@demo.local`, `dono@exemplo.local`.

Ao alterar o código do API durante o desenvolvimento, reinicie `dev:api` (ou rode `npm run start:watch -w apps/api` em outro terminal e reinicie o processo node).

## Testes
```bash
npm test            # unitários (sem banco)
npm run test:e2e    # e2e contra o banco distribuihub_test (criado/migrado automaticamente)
```
Detalhes em `docs/TESTING.md`.

## Documentação
`docs/ARCHITECTURE.md`, `docs/COMMERCIAL.md`, `docs/MARKETPLACE-INTEGRATIONS.md`, `docs/FISCAL-BRAZIL.md`, `docs/MULTITENANCY.md`, `docs/DATABASE.md`, `docs/SECURITY.md`, `docs/TESTING.md`, `docs/ROADMAP.md`, `docs/decisions/`. Documentos de módulos futuros (`INVENTORY`, `FISCAL-BRAZIL`, `FINANCE`, `MARKETPLACE-INTEGRATIONS`, `DEPLOYMENT`) existem como marcadores com premissas e pendências.
