# Implantação e operação

> **Estado:** os procedimentos de banco, migrações, backup/restauração e métricas foram **executados e testados** em PostgreSQL 18 local. Os Dockerfiles em `deploy/` **não foram testados** (Docker indisponível no ambiente de desenvolvimento). Não há CI, HTTPS/proxy reverso nem monitoramento externo configurados: são pré-requisitos seus (ver [Pendências](#pendências)).

> Quer publicar no Easypanel? Siga o passo a passo para leigos em [EASYPANEL.md](EASYPANEL.md). `TRUST_PROXY_HOPS` (padrão 1) define quantos proxies ficam na frente da API.

## Topologia
```
navegador ──HTTPS──> proxy reverso (TLS, HSTS) ──> web (Next.js :3000) ──/api──> API (NestJS :3001) ──> PostgreSQL
                                                                            └── worker de filas (mesmo processo; WORKER_ENABLED)
```
O navegador só fala com a origem do web; `/api/*` é encaminhado ao backend (cookies *same-origin*; `API_URL` define o destino). A fila usa `FOR UPDATE SKIP LOCKED`: várias instâncias do API podem rodar workers com segurança; deixe `WORKER_ENABLED=true` em ao menos uma.

## Variáveis de ambiente (API)
| Variável | Obrigatória | Observação |
|---|---|---|
| `DATABASE_URL` | sim | **Papel de runtime `dh_app`** (sem BYPASSRLS). Nunca use superusuário aqui: desligaria o isolamento entre tenants. |
| `DIRECT_URL` | sim (migrações/scripts) | Dono do schema. Só para `prisma migrate`, `db:setup`, backup e `platform-admin`; não exponha ao processo web. |
| `DH_APP_PASSWORD` | em `db:setup` | Senha aplicada a `dh_app`. |
| `JWT_SECRET` | sim | ≥ 32 caracteres aleatórios. |
| `CREDENTIALS_KEY` | sim | 32 bytes base64. Cifra credenciais de integrações e certificados. **Perder a chave = perder as credenciais.** Rotação: `CREDENTIALS_KEY_PREVIOUS`. |
| `COOKIE_SECURE` | produção: `true` | Exige HTTPS. |
| `WEB_ORIGIN` | sim | Origem pública (callbacks OAuth). |
| `ALLOW_SELF_REGISTRATION` | produção: `false` | Fecha o cadastro público de empresas (`POST /api/auth/register` passa a responder 403). Crie a primeira empresa/conta de administrador antes de desligar; depois, contas nascem por convite. A tela de cadastro já foi removida do site. |
| `WORKER_ENABLED` | não (padrão `true`) | |
| `ENABLE_SANDBOX_CONNECTOR` | **nunca em produção** | Ignorado quando `NODE_ENV=production`. |
| `METRICS_TOKEN` | opcional | Liga `/api/metrics`. |
| `BACKUP_KEY` | recomendado | Cifra os backups; guarde separado do armazenamento deles. |
| `ML_*` | só com Mercado Livre | Ver MARKETPLACE-INTEGRATIONS.md. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | para e-mail | Recuperação de senha, convite de usuário e avisos ao cliente. Sem `SMTP_HOST` nada é enviado (a tela avisa). Porta 587 com `SMTP_SECURE=false` (STARTTLS) ou 465 com `true`. |
| `EVOLUTION_API_URL`, `EVOLUTION_API_KEY` | para WhatsApp | Servidor da Evolution API v2 e a chave global. Cada empresa conecta o próprio número por QR code em **Avisos ao cliente**. |

Web: `API_URL` (destino do proxy), `NEXT_PUBLIC_APP_NAME`.

## Primeira instalação
1. PostgreSQL 15+ (testado em 18). O papel `dh_app` é criado pela migração `rls_and_roles`.
2. Segredos em um cofre (não em arquivo versionado).
3. `npm ci && npm run build`
4. Migrações **com o dono**: `DIRECT_URL=… npm run db:setup` (aplica `prisma migrate deploy`, define a senha de `dh_app`, fixa o fuso UTC do banco e sincroniza as permissões dos papéis de sistema).
5. Subir o API (`node apps/api/dist/main.js`, com `DATABASE_URL` de `dh_app`) e o web (`next start`).
6. Registrar-se pela tela e conceder o primeiro administrador da plataforma: `npm run platform-admin -w apps/api -- grant voce@empresa.com`.
7. Conferir `GET /api/health` (vivo) e `GET /api/health/ready` (banco + atraso da fila).

## Atualizações
- Migrações são aditivas e versionadas. Rode `db:setup` antes de subir a nova versão. **Não edite migrações já aplicadas** (o checksum quebra): corrija com uma nova (ex.: `…_fix_platform_update`).
- Rollback de código é seguro enquanto o schema novo for compatível; rollback de schema = restaurar backup. Faça backup antes de cada migração em produção.

## Backup e restauração
```bash
npm run backup -w apps/api -- /caminho/dh-AAAA-MM-DD.dump
npm run restore:check -w apps/api -- /caminho/dh-AAAA-MM-DD.dump.enc
```
- `backup`: `pg_dump -Fc`; com `BACKUP_KEY` o arquivo é cifrado (AES-256-GCM, extensão `.enc`).
- `restore:check` restaura em um **banco temporário**, compara linhas de todas as tabelas, RLS forçada, políticas, funções `SECURITY DEFINER` e migrações com a origem e confirma, como `dh_app`, que sem tenant nada é visível e que um tenant só vê os próprios dados; depois remove o temporário. Código de saída ≠ 0 se algo divergir. **Agende-o** (ex.: semanal) sobre o backup mais recente: backup nunca restaurado não é backup.
- Testado (`test/platform.e2e-spec.ts`): backup simples e cifrado, restauração com verificação, rejeição de arquivo adulterado e de chave errada.
- O dump contém credenciais **já cifradas** pela `CREDENTIALS_KEY`; guarde a chave separadamente e com cópia própria.
- Servidor novo: crie o papel `dh_app` antes do `pg_restore` (papéis não fazem parte do dump), restaure e rode `db:setup` para definir a senha.
- **Não coberto:** retenção/rotação automática, envio a armazenamento externo, PITR/WAL (em produção, prefira backup físico contínuo do provedor de banco além deste dump lógico), RPO/RTO acordados.

## Observabilidade
- **Logs:** uma linha JSON por requisição em stdout (`ts, level, reqId, method, route, status, ms, tenantId, userId`). Sem corpo, query string, cookies ou cabeçalhos; IDs nas rotas são normalizados (`:id`). Erros inesperados (500) são logados com `reqId`; o cliente recebe mensagem genérica e `requestId`. Um `x-request-id` válido vindo do proxy é reaproveitado.
- **Saúde:** `/api/health` (vivo); `/api/health/ready` → 503 sem banco; `degraded` se há job pronto parado > 10 min; informa jobs `DEAD`.
- **Métricas** (`/api/metrics`, Prometheus; requer `METRICS_TOKEN`, 404 sem ele): `http_requests_total{method,status}`, histograma `http_request_duration_seconds`, `http_errors_total`, `unhandled_exceptions_total`, `process_uptime_seconds`, `background_jobs{status}`. Contadores **por processo** (some entre instâncias no Prometheus). Não carregam IDs de tenant/usuário.
- **Alertas sugeridos (não configurados):** `ready` ≠ ok por 2 min; 5xx > 2%; `background_jobs{status="DEAD"}` > 0; p95 > 2 s; backup/`restore:check` atrasado ou com falha.
- **Não implementado:** tracing distribuído, agregador de logs, painéis, retenção de logs, rastreamento de erros (Sentry etc.).

## Plataforma (administrador global)
Ver [PLATFORM.md](PLATFORM.md).

## Pendências
HTTPS/proxy e HSTS; CI (testes, build, `npm audit`); testar Dockerfiles e *compose*; cofre de segredos; política de retenção de logs/dados e atendimento a titulares (LGPD); monitoramento externo; RPO/RTO; limitação de taxa por tenant (hoje por IP).
