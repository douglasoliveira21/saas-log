# Segurança

## Implementado (Fase 1)
- Senhas com scrypt (N=16384) e política mínima (10 caracteres, letras e números); comparação em tempo constante; hash fictício para e-mail inexistente.
- Bloqueio temporário após 5 falhas; rate limiting (`@nestjs/throttler`) em registro, login e refresh.
- Access token JWT HS256 de 15 min em cookie httpOnly + refresh opaco rotativo de 14 dias (cookie restrito a `/api/auth`); reutilização de refresh revoga a família.
- CSRF: cookies `SameSite=Lax` + cabeçalho obrigatório `x-dh-csrf` em requisições mutáveis autenticadas por cookie; sem CORS aberto.
- `helmet`, validação de entrada com whitelist, Prisma parametrizado (sem SQL concatenado nas rotas).
- Autorização no servidor, RLS no banco, auditoria append-only com remoção de segredos.
- `JWT_SECRET` obrigatório (≥ 32 caracteres); sem segredos versionados (`.env` no `.gitignore`).

## Integrações (Fase 4)
- Credenciais de canais: AES-256-GCM, chave por tenant (HKDF), AAD por registro, rotação com `CREDENTIALS_KEY_PREVIOUS`; nunca expostas pela API nem gravadas em logs/auditoria (`redactSecrets` + `scrub`).
- Webhooks: HMAC-SHA256 com comparação em tempo constante, segredo por conexão, deduplicação, limite de taxa; o esquema oficial de cada provedor deve ser validado na Fase 5.
- OAuth: `state` assinado, expirável e de uso único.
- Worker sem BYPASSRLS (funções SECURITY DEFINER mínimas).
- **Gestão da `CREDENTIALS_KEY`:** em produção deve vir de cofre de segredos; perder a chave inutiliza as credenciais (reconectar os canais).

## Fiscal (Fase 6)
- Certificado A1: arquivo e senha cifrados (AES-256-GCM, chave por tenant, AAD por certificado); nunca expostos pela API nem registrados em logs/auditoria (a auditoria guarda só assunto, série, impressão digital e validade); o segredo do certificado substituído é apagado.
- XML recebido: tamanho máximo de 2 MB, DOCTYPE/ENTITY recusados (XXE), parser sem resolução de entidades externas.
- Regras tributárias e XML são imutáveis após aprovação/registro (aplicação + banco); cálculos e numeração são append-only/atômicos.
- Download do XML original é auditado.

## Financeiro e relatórios (Fase 7)
- Baixas/estornos append-only (sem UPDATE/DELETE para o papel de runtime); bloqueio pessimista por título; segregação de aprovação acima do limite.
- Dados bancários das contas só para `finance.manage`; relatórios exigem a permissão do módulo de origem; download de exportação só pelo solicitante, com expiração.
- Exportação CSV/XLSX neutraliza injeção de fórmula; toda exportação é auditada.
- Arquivos de extrato/relatório: texto, limite de 3 MB e 5.000 linhas, sem execução de conteúdo.

## Plataforma e operação (Fase 8)
- Administrador global só por script direto no banco; funções `platform_*` validam `platform_admins`; o admin enxerga metadados, não dados de negócio.
- Avaliação vencida ⇒ somente leitura; suspensão ⇒ bloqueio.
- Logs estruturados sem corpo/query; 500 com mensagem genérica e `requestId`; `/metrics` por token (comparação em tempo constante).
- Revisão completa, achados e checklist de produção: **SECURITY-REVIEW.md**.

## Pendências / não implementado
- MFA, recuperação de senha, convite por e-mail, verificação de e-mail.
- Rotação de chaves JWT, criptografia de campos sensíveis e cofre de certificados (Fase 6).
- Política de retenção de logs, backups com teste de restauração, plano de incidentes, LGPD (solicitações de titulares) — Fase 8.
- O hash de senha é comparado também contra usuário desativado sem distinguir a causa (intencional).
- Definir `COOKIE_SECURE=true` e HTTPS em qualquer ambiente fora do desenvolvimento.
