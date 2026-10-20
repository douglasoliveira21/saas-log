# Tutorial: publicar o sistema no Easypanel (passo a passo)

> **Aviso honesto:** os Dockerfiles e este roteiro **não foram executados de ponta a ponta** (não há Docker nem Easypanel no ambiente de desenvolvimento). Os comandos do sistema (migrações, backup, administrador) foram testados em PostgreSQL local. Se algum passo falhar, copie a mensagem do "Log" do Easypanel e peça ajuda — é normal ajustar um detalhe no primeiro deploy.

## O que você vai criar (3 peças dentro de 1 projeto)
1. **postgres** — o banco de dados.
2. **api** — o "cérebro" do sistema (porta 3001, **sem** endereço público).
3. **web** — o site que você acessa (porta 3000, **com** seu domínio e HTTPS).

## Antes de começar (o que você precisa ter)
- Um servidor (VPS) com Easypanel instalado e acesso ao painel. Mínimo sugerido: 2 vCPU e 4 GB de RAM.
- Um domínio (ex.: `erp.suaempresa.com.br`) e acesso ao DNS dele.
- Uma conta no GitHub (gratuita).
- No seu computador: **Git** e **Node.js** instalados (o Node você já tem).

---

## PARTE A — Colocar o código no GitHub

O Easypanel baixa o código de um repositório. Hoje o projeto está só na sua máquina.

1. Entre em github.com → **New repository** → nome `distribuihub` → marque **Private** (privado!) → **Create**.
2. Abra o terminal na pasta do projeto (`saas-log`) e rode, um comando por vez:
   ```bash
   git init
   git add .
   git status
   ```
   **Confira a lista:** não pode aparecer `.env`, `.data`, `*.pfx` nem `node_modules` (o `.gitignore` já bloqueia). Se aparecer algum, **pare** e me avise.
   ```bash
   git commit -m "Primeira versão"
   git branch -M main
   git remote add origin https://github.com/SEU_USUARIO/distribuihub.git
   git push -u origin main
   ```
3. O GitHub pode pedir login. Se pedir senha, use um **Personal Access Token** (GitHub → Settings → Developer settings → Tokens) no lugar da senha.

> Nunca envie senhas ou chaves ao GitHub. Elas vão só no painel do Easypanel (Parte C).

---

## PARTE B — Gerar as senhas e chaves

Você precisa de 5 valores. No terminal do seu computador, rode **cada comando** e anote o resultado em um lugar seguro (gerenciador de senhas):

| Nome | Comando |
|---|---|
| `JWT_SECRET` | `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `CREDENTIALS_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `BACKUP_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `METRICS_TOKEN` | `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"` |
| `DH_APP_PASSWORD` | `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"` |

⚠️ **Guarde `CREDENTIALS_KEY` e `BACKUP_KEY` em dois lugares.** Se perder a `CREDENTIALS_KEY`, as credenciais de marketplaces e certificados salvos no sistema ficam irrecuperáveis. Se perder a `BACKUP_KEY`, os backups cifrados não abrem.

---

## PARTE C — Criar tudo no Easypanel

### 1. Projeto
Painel do Easypanel → **Create Project** → nome: `distribuihub`.

### 2. Banco de dados (postgres)
1. Dentro do projeto: **+ Service → Postgres**.
2. Nome do serviço: `postgres`. Defina uma **senha forte** (anote como `SENHA_PG`). Versão: **15** (importante: a ferramenta de backup dentro do container da API é a versão 15 e não consegue copiar bancos mais novos; o sistema foi testado em 18, mas nada nele exige mais que 15 — se algum erro de migração aparecer, me avise). **Create**.
3. Abra o serviço `postgres` e procure os dados de conexão internos (algo como *Internal Host* / *Connection string*). O endereço interno costuma ser **`distribuihub_postgres`** (formato `projeto_servico`), porta `5432`, usuário `postgres`. **Confirme na tela** e anote.
4. Crie o banco: no próprio serviço Postgres, o Easypanel já cria um banco (geralmente com o nome do serviço). Anote o nome (ex.: `distribuihub`). Se não houver, abra o **Console** do serviço e rode: `psql -U postgres -c "CREATE DATABASE distribuihub"`.

### 3. API (api)
1. **+ Service → App**. Nome: `api`.
2. **Source → GitHub**: conecte sua conta, escolha o repositório `distribuihub`, branch `main`.
3. **Build** → escolha **Dockerfile** e informe o caminho: `deploy/Dockerfile.api` (a raiz do repositório é o contexto — é o padrão).
4. **Environment** (variáveis) — cole, trocando os valores:
   ```
   NODE_ENV=production
   API_PORT=3001
   WEB_ORIGIN=https://erp.suaempresa.com.br
   COOKIE_SECURE=true
   TRUST_PROXY_HOPS=2
   DIRECT_URL=postgresql://postgres:SENHA_PG@distribuihub_postgres:5432/distribuihub
   DATABASE_URL=postgresql://dh_app:DH_APP_PASSWORD@distribuihub_postgres:5432/distribuihub
   DH_APP_PASSWORD=(o valor gerado)
   JWT_SECRET=(o valor gerado)
   CREDENTIALS_KEY=(o valor gerado)
   BACKUP_KEY=(o valor gerado)
   METRICS_TOKEN=(o valor gerado)
   WORKER_ENABLED=true
   ```
   - Se a senha tiver caracteres especiais (`@ : / # ?`), troque-a por uma só com letras e números ou codifique-a (ex.: `@` vira `%40`).
   - **Não** defina `ENABLE_SANDBOX_CONNECTOR`.
   - Mercado Livre: só adicione `ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `ML_WEBHOOK_TOKEN` depois de ter o aplicativo criado (ver `docs/MARKETPLACE-INTEGRATIONS.md`).
5. **Domains/Ports**: a porta do app é `3001`. **Não adicione domínio público** à API (o site acessa por dentro da rede).
6. **Deploy**. Abra os **Logs**: no início você verá as migrações do banco sendo aplicadas ("All migrations have been successfully applied", "Banco … pronto") e depois a API subindo. Se der erro de conexão, revise `DIRECT_URL` (host/senha/nome do banco).

### 4. Site (web)
1. **+ Service → App**. Nome: `web`. Mesmo repositório e branch.
2. **Build → Dockerfile**: `deploy/Dockerfile.web`.
3. **Build args** (argumentos de build): `API_URL=http://distribuihub_api:3001`
   (o endereço interno da API: `projeto_servico`; confirme o nome exato mostrado no serviço `api`).
4. **Environment**: `NEXT_PUBLIC_APP_NAME=DistribuiHub ERP` (ou o nome que preferir).
5. **Domains**: adicione `erp.suaempresa.com.br`, porta `3000`, **HTTPS ligado** (certificado automático).
6. **Deploy**.

### 5. DNS
No painel do seu domínio crie um registro **A**: nome `erp` → IP do seu servidor. Espere alguns minutos (até horas). O Easypanel emite o HTTPS sozinho quando o DNS apontar.

### 6. Primeiro acesso
1. Abra `https://erp.suaempresa.com.br` → **Criar conta** (cadastre você).
2. Para virar **administrador da plataforma** (menu "Plataforma"): no Easypanel, abra o serviço `api` → **Console** e rode:
   ```bash
   npx tsx scripts/platform-admin.ts grant seu@email.com
   ```
   Saia e entre de novo no sistema.
3. Em **Plataforma**, mude sua empresa para o plano e a situação desejados (a avaliação de 14 dias vira somente leitura ao vencer).

### 7. Conferir que está saudável
- `https://erp.suaempresa.com.br/api/health` → deve mostrar `"status":"ok"`.
- `https://erp.suaempresa.com.br/api/health/ready` → `"database":"ok"`.
- Faça login, cadastre um produto, saia e entre de novo.

---

## PARTE D — Backup (faça no primeiro dia)

1. No serviço `api` → **Console**:
   ```bash
   npm run backup -- /tmp/teste.dump
   npm run restore:check -- /tmp/teste.dump.enc
   ```
   O segundo comando restaura em um banco temporário e deve terminar com `"ok": true`. Isso prova que o backup funciona.
2. **Backups de verdade precisam sair do servidor.** Opções: (a) o recurso de backup do próprio Easypanel/Postgres (veja o serviço `postgres` → *Backups*, geralmente com envio para S3); (b) agendar o comando `npm run backup` e copiar o arquivo `.enc` para um armazenamento externo. Isto **não** está automatizado no sistema — configure e **teste a restauração** pelo menos uma vez por mês.
3. Ative também o snapshot/backup do servidor no seu provedor de VPS.

## PARTE E — Atualizar o sistema depois
1. Faça as alterações, `git add . && git commit -m "..." && git push`.
2. No Easypanel, abra `api` e `web` → **Deploy** (ou ative o deploy automático por GitHub). A API aplica as migrações novas sozinha ao iniciar.
3. **Antes de cada atualização que mude o banco**, rode um backup (Parte D).

---

## Problemas comuns
| Sintoma | O que fazer |
|---|---|
| Build da `api`/`web` falha | Veja o log; confirme que o caminho do Dockerfile é `deploy/Dockerfile.api` / `deploy/Dockerfile.web` e que o contexto é a raiz do repositório. |
| `api` reinicia sem parar | Log mostra o motivo: normalmente variável faltando (`JWT_SECRET` com menos de 32 caracteres, `CREDENTIALS_KEY` fora de 32 bytes) ou senha do banco errada. |
| Site abre, mas login dá erro | `API_URL` do `web` errado (refaça o **build** do `web` após corrigir) ou `COOKIE_SECURE=true` acessando por `http://` (use sempre `https://`). |
| "Muitas tentativas" para todo mundo | `TRUST_PROXY_HOPS` incorreto (a API vê o IP do proxy em vez do seu). Com Easypanel + site na frente, use `2`; se usar Cloudflare na frente, `3`. |
| Certificado HTTPS não sai | O DNS ainda não aponta para o servidor, ou as portas 80/443 estão bloqueadas no firewall do provedor. |
| `permission denied`/erro de papel `dh_app` | `DIRECT_URL` precisa usar o usuário `postgres` (dono); `DATABASE_URL` usa `dh_app` com a mesma senha de `DH_APP_PASSWORD`. |

## Segurança mínima (resumo)
Repositório **privado**; segredos só no painel; senha forte no Easypanel (e 2FA no GitHub); API sem domínio público; HTTPS ativo; backup fora do servidor e restauração testada; leia `docs/SECURITY-REVIEW.md` (itens pendentes: MFA, LGPD, e-mail transacional) antes de atender clientes reais.
