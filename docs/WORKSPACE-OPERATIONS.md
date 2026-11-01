# Onboarding, migração e operação interna

## Onboarding

A página `/onboarding` calcula o progresso com dados reais do tenant e conduz o administrador por empresa, certificado fiscal, depósitos, usuários, regras fiscais e importação inicial. O administrador pode encerrar o assistente a qualquer momento; as pendências continuam visíveis e auditadas.

API: `GET /api/onboarding` e `POST /api/onboarding/complete`.

## Migração de ERP

A página `/migracao` aceita CSV com `;` ou `,`, oferece validação (`dryRun`) e aplicação idempotente. Cada execução e cada chave legada ficam auditadas, o que evita duplicação ao reenviar o mesmo arquivo.

Entidades e colunas principais:

- `PRODUCTS`: `sku`, `nome`, `codigo_de_barras`, `custo`, `preco_venda`, `estoque_minimo`, `ncm`.
- `CUSTOMERS`: `id`, `nome`, `cpf_cnpj`, `email`, `telefone`, `cidade`, `uf`.
- `SUPPLIERS`: `razao_social`, `cnpj`, `nome_fantasia`, `email`, `telefone`.
- `STOCK`: `sku`, `deposito`, `quantidade`.
- `OPEN_TITLES`: `codigo`, `tipo` (`RECEIVABLE` ou `PAYABLE`), `descricao`, `valor`, `vencimento`, `documento_pessoa`.
- `HISTORY`: `codigo`, `tipo`, `data`, `descricao`, `valor`, `dados`.

API: `GET /api/migration/runs` e `POST /api/migration/import`. O limite por envio é 5.000 linhas.

## Busca global

`Ctrl+K` abre a busca em produtos, clientes, fornecedores, pedidos e títulos financeiros. Os resultados respeitam tenant e permissões do usuário.

API: `GET /api/search?q=texto&limit=8`.

## Suporte temporário

O administrador da plataforma solicita acesso informando motivo e duração. Um proprietário do tenant aprova ou recusa e decide se haverá escrita. A sessão usa token próprio, expira automaticamente, pode ser revogada e registra solicitação, aprovação, entrada e saída nas auditorias global e do tenant. Por padrão, o acesso é somente leitura.

- Tenant: `/suporte`.
- Plataforma: `/plataforma`.
- A saída imediata fica disponível no aviso superior durante a sessão.

## Operação interna

`/plataforma` exibe tenants por estado, filas, jobs mortos ou atrasados, integrações quebradas, falhas recentes de integração/notificação e saúde por tenant. A consulta é restrita a administradores globais.

## Teste de carga

Rode somente contra ambiente isolado:

```powershell
$env:LOAD_BASE_URL='http://localhost:3000'
$env:LOAD_EMAIL='admin@teste.local'
$env:LOAD_PASSWORD='senha-de-teste'
$env:LOAD_CONCURRENCY='10'
$env:LOAD_DURATION_SECONDS='30'
# Opcional: documento fiscal de rascunho no ambiente isolado, para exercitar a revalidação completa.
$env:LOAD_FISCAL_DOC_ID='uuid-do-documento'
npm run test:load
```

O script mede p50, p95 e p99 em fechamento financeiro, estoque, cálculo fiscal da emissão, busca global e importação em modo de validação. Com `LOAD_FISCAL_DOC_ID`, também testa a revalidação completa de um rascunho sem transmiti-lo à SEFAZ. Qualquer resposta com erro encerra com código não zero.
