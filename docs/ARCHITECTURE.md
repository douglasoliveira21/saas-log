# Arquitetura

Monólito modular (ADR-0001). Processamento assíncrono: fila durável em PostgreSQL com worker no mesmo processo do API (ADR-0006; `WORKER_ENABLED=false` roda só o API).

```
saas-log/
├─ apps/
│  ├─ api/                 NestJS 11 + Prisma 6 + PostgreSQL
│  │  ├─ prisma/           schema.prisma, migrations/ (0000 init, 0100 RLS+papéis), seed.ts
│  │  ├─ scripts/db-setup.ts
│  │  ├─ src/
│  │  │  ├─ access/        catálogo de permissões e papéis de sistema
│  │  │  ├─ audit/         AuditService (grava na mesma transação) + GET /audit
│  │  │  ├─ auth/          registro, login, refresh rotativo, guard global
│  │  │  ├─ common/        contexto de auth, decorators, senha (scrypt), CNPJ
│  │  │  ├─ config/        APP_NAME, JWT, cookies
│  │  │  ├─ prisma/        PrismaService.withContext (contexto RLS)
│  │  │  ├─ structure/     empresas, estabelecimentos, depósitos, visão geral
│  │  │  └─ users/         membros, papéis, anti-escalação
│  │  └─ test/             e2e (supertest + banco real)
│  └─ web/                 Next.js 16 (App Router) + React 19, proxy /api → API
├─ scripts/dev-db.mjs      PostgreSQL local isolado (sem Docker)
└─ docs/
```

## Fluxo de uma requisição
1. O navegador chama `/api/*` na origem do web; o Next encaminha ao API (cookies same-origin, httpOnly).
2. `AuthGuard` (global) valida o JWT de acesso, **relê a membership ativa e as permissões no banco** e aplica `@RequirePermissions`.
3. O serviço abre `prisma.withContext({tenantId,userId}, tx => …)`; o PostgreSQL aplica RLS com esse contexto.
4. A ação e o registro de auditoria confirmam (ou falham) na mesma transação.

Módulos previstos (Identity, Tenant, Company, UserAccess já existem em forma inicial; Catalog, Inventory, Marketplace, Sales, Purchasing, Commission, Fiscal, Logistics, Finance, Reporting, Notification, Billing) seguem em `docs/ROADMAP.md`.

## Limitações conhecidas desta fase
- Sem MFA, recuperação de senha por e-mail nem convite por e-mail (exigem provedor de e-mail — Fase 8).
- Sem biblioteca de componentes de UI: CSS próprio com tokens, tema claro/escuro automático.
- Sem Docker/pipeline de CI no repositório ainda.
