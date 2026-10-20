# Multi-tenancy e autorização

## Modelo
- **Tenant** = empresa contratante. **User** é uma identidade global (e-mail único) que pode ter **Membership** em vários tenants, cada uma com um **Role**.
- Papéis (`roles`) e permissões (`role_permissions`) são **por tenant**; os 12 papéis de sistema são criados no registro e não são editáveis. Papéis personalizados: `POST /api/roles`, `PUT /api/roles/:id/permissions`.

## Defesa em profundidade
1. **Servidor, não o navegador**: o tenant vem do JWT, mas o `AuthGuard` revalida a membership ativa no banco a cada requisição (um `tid` forjado resulta em 403). Nenhum `tenantId` do corpo da requisição é aceito (DTOs com `forbidNonWhitelisted`).
2. **Consultas escopadas**: todo acesso a tabelas de negócio passa por `PrismaService.withContext`, filtrando por `tenantId` explicitamente.
3. **Row-Level Security** (migration `…0100_rls_and_roles`): o papel de runtime `dh_app` (sem `BYPASSRLS`, não é dono das tabelas) só enxerga/grava linhas com `tenant_id = app_tenant_id()`. `FORCE ROW LEVEL SECURITY` também vale para o dono. Sem contexto = nenhuma linha (falha segura).
4. **FKs compostas** `(tenant_id, id)`: impedem vincular, por exemplo, um depósito do tenant B a um estabelecimento do tenant A, mesmo para quem ignora RLS.
5. **Auditoria append-only**: `dh_app` só tem `INSERT`/`SELECT` em `audit_logs`.

## Exceções deliberadas (tabelas globais, sem RLS)
- `users`: identidade global (nome, e-mail, hash). Listagens por tenant sempre partem de `memberships` (com RLS).
- `refresh_sessions`: infraestrutura de sessão; guarda só o hash do token.
- `plans`: catálogo comercial (somente leitura para o runtime).
- Políticas especiais: `memberships`/`roles`/`tenants` também são legíveis pelo próprio usuário (contexto `app.user_id`) para listar "minhas empresas" no login; escrita sempre restrita ao tenant corrente.

## Anti-escalação
Só é possível atribuir/conceder o que o próprio ator já possui; não é possível rebaixar/suspender o último proprietário; só proprietário altera outro proprietário.

## Pendências
- Administrador global da plataforma (acesso excepcional com justificativa e auditoria): Fase 8.
- Limites de aprovação e dupla autorização para ações críticas: junto aos módulos que as possuem.
