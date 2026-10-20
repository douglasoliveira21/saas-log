# Revisão de segurança (Fase 8)

**Natureza:** revisão do código e do banco feita pelo próprio desenvolvimento desta base, apoiada por testes automatizados. **Não é** um pentest nem auditoria independente; recomenda-se uma revisão externa antes de operar com clientes reais.

## O que é verificado automaticamente (`test/platform.e2e-spec.ts`)
| Controle | Verificação |
|---|---|
| Nenhuma rota esquecida | Todos os handlers HTTP são enumerados: ou exigem permissão, ou estão na lista explícita de públicas (login/registro/refresh/logout, health, callback OAuth, webhooks, métricas por token) ou sem-tenant (`auth/*`, `platform/*`). Uma rota nova sem proteção **quebra o teste**. Única exceção autenticada sem permissão: `GET /dashboard/overview` (contagens do próprio tenant). |
| Isolamento | Toda tabela com `tenant_id` tem RLS habilitada **e forçada** (exceção documentada: `refresh_sessions`, ver abaixo). O papel `dh_app` não é superusuário nem tem BYPASSRLS. |
| Imutabilidade | `dh_app` sem UPDATE/DELETE em auditoria, baixas financeiras, eventos de envio, logs de integração, histórico de preço, cálculos fiscais, XML e assinaturas. |
| Plataforma | `dh_app` sem qualquer privilégio direto em `platform_admins`/`platform_audit_log`; funções administrativas negam não-administradores. |
| Sessão | Cookies `HttpOnly`; escrita por cookie sem `x-dh-csrf` → 403; `X-Content-Type-Options`, sem `X-Powered-By` (helmet). |
| Restauração | Backup restaurado mantém RLS, políticas e isolamento (ver DEPLOYMENT.md). |
Além disso, as fases anteriores cobrem isolamento entre tenants em cada módulo (testes de "tenant B não acessa tenant A").

## Achados e decisões
| # | Item | Gravidade | Situação |
|---|---|---|---|
| 1 | `npm audit` (produção): **node-forge** (várias avisos de ASN.1/assinatura, sem correção publicada), **fast-xml-parser <5.7** (injeção no *XMLBuilder*) e **deepmerge-ts <8** (dependência do Prisma). | alta/moderada | **Aceito com mitigação, a reavaliar.** Usamos o node-forge só para ler o PKCS#12 enviado por usuário com `fiscal.manage` (tamanho limitado a ~400 KB, senha obrigatória; risco = DoS por certificado malicioso, sem verificação de cadeia/assinatura de terceiros). Não usamos `XMLBuilder`. `deepmerge-ts` é do ferramental do Prisma. Correção do fast-xml-parser exige salto de versão maior (testar com os XMLs de NF-e antes). Acompanhar as correções upstream. |
| 2 | `refresh_sessions` não tem RLS (a sessão é achada pelo hash do token, antes de existir tenant). | baixa | Aceito: tabela só tocada pelo serviço de autenticação, token opaco com hash SHA-256, rotação com detecção de reuso que revoga a família. |
| 3 | Limitação de taxa por IP (login 5/min, registro 10/min, geral 300/min); bloqueio de conta por 5 falhas. Sem limite por tenant/usuário. | média | Pendente. Atrás de proxy, `trust proxy` está em 1 salto: confira o número de proxies. |
| 4 | Sem MFA, sem recuperação de senha, sem confirmação de e-mail, sem convite por e-mail. | alta p/ produção | **Pendente** (depende de provedor de e-mail). Recomendado MFA obrigatório para administradores da plataforma. |
| 5 | JWT HS256 com segredo único, sem rotação. Acesso de 15 min; refresh rotativo. | média | Pendente: rotação de chave (`kid`). |
| 6 | `CREDENTIALS_KEY` única em variável de ambiente (rotação suportada, sem KMS/HSM). | média | Pendente: cofre/KMS. |
| 7 | LGPD: não há fluxo de atendimento a titulares (acesso, correção, exclusão/anonimização), nem política de retenção implementada, nem registro de operações automatizado. Auditoria não é apagada. | alta p/ produção | **Pendente** — exige decisão jurídica (prazos de guarda fiscal × exclusão). |
| 8 | Logs de requisição sem corpo/query; erros 500 sem detalhe ao cliente. Auditoria de negócio guarda IP. | — | OK. Defina retenção. |
| 9 | Webhooks: assinatura HMAC por conexão, deduplicação por evento, corpo bruto verificado; webhook do Mercado Livre por token na URL (limitação do canal) — token deve ser longo e secreto. | — | OK/atenção. |
| 10 | Upload de planilhas/extratos/relatórios: texto com limites de tamanho e linhas; exportações neutralizam injeção de fórmula; XML com DOCTYPE/ENTITY recusado (XXE). | — | OK. |
| 11 | Backup lógico cifrado opcionalmente; chave de backup fora do alcance de quem acessa os arquivos é responsabilidade operacional. | média | Documentado. |
| 12 | Sem WAF, sem proteção contra DoS de camada 7 além do rate limit, sem varredura de dependências no CI, sem SAST. | média | Pendente (CI). |
| 13 | Administrador da plataforma pode suspender qualquer tenant; ações auditadas, mas sem aprovação em dupla. | média | Aceito para equipe pequena; revisar. |

## Modelo de ameaças resumido
- **Tenant malicioso → outro tenant:** bloqueado por RLS no banco (mesmo com bug na aplicação), FKs compostas `(tenant_id,id)` e testes de isolamento por módulo.
- **Usuário comum → plataforma:** sem rota de promoção; funções do banco recusam; tabelas sem privilégio.
- **Vazamento de backup:** credenciais já cifradas; backup opcionalmente cifrado; sem a chave nada é legível.
- **Replay/CSRF:** SameSite=Lax + cabeçalho customizado obrigatório em escritas por cookie.
- **Injeção:** consultas parametrizadas (Prisma/`$queryRaw` tagueado); validação de DTO com `whitelist` e `forbidNonWhitelisted`.

## Antes de ir a produção (checklist)
- [ ] HTTPS com HSTS e `COOKIE_SECURE=true`; `trust proxy` conferido
- [ ] Segredos em cofre; `ENABLE_SANDBOX_CONNECTOR` ausente
- [ ] `DATABASE_URL` com `dh_app` (confirmar com `SELECT rolbypassrls FROM pg_roles WHERE rolname='dh_app'` = false)
- [ ] Backup agendado **e** `restore:check` agendado; chaves guardadas separadamente
- [ ] MFA para administradores da plataforma; e-mail transacional
- [ ] Decisão jurídica LGPD e retenção
- [ ] CI com testes, `npm audit` e revisão das exceções acima
- [ ] Revisão/pentest independente
