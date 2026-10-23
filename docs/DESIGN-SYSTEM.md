# Design system (front-end)

Stack preservado: Next.js 16 + React 19, CSS global com tokens (sem Tailwind/shadcn). **Única dependência nova: `lucide-react`** (ícones, licença ISC, compatível com React 19). Toasts, diálogos, tabelas ordenáveis e skeletons são componentes próprios (`apps/web/src/components/ui.tsx`) — não foi preciso instalar outra biblioteca.

## Onde fica
| Arquivo | Conteúdo |
|---|---|
| `src/app/globals.css` | Tokens (cores, raios, sombras, alturas, z-index), tema claro/escuro, layout, componentes. Os nomes antigos (`.card`, `.btn`, `.badge`, `.alert`, `.row`, `.table-wrap`, `.form-grid`) continuam válidos — todas as telas herdam o visual. |
| `src/components/ui.tsx` | `UiProvider` (toasts + diálogos), `useUi()` (`confirm`, `prompt`, `form`, `toast`), `PageHeader`, `StatCard`, `EmptyState`, `Skeleton`, `Alert`, `useSort` + `SortTh`. |
| `src/components/auth-shell.tsx` | Moldura das telas públicas (entrar, criar conta, escolher empresa). |
| `src/lib/nav.ts` | Menu por grupos, com ícones e permissões. |
| `src/app/(app)/layout.tsx` | Sidebar (grupos, recolher/expandir, gaveta no celular), cabeçalho (breadcrumb, aviso de avaliação, tema, menu do usuário). |

## Tokens
Cor de marca `--brand` (azul-índigo), neutros frios, semânticas `--ok/--warn/--danger/--info` com versões `-soft`. Raios 6/10/14 px, controles 38 px (30 px em `.sm`), sombras sutis. Tema escuro por `data-theme="dark"` (preferência salva em `localStorage`; sem salvar, segue o sistema; script inline evita o "flash").

## Padrões
- **Cabeçalho de página:** `PageHeader` (título, descrição, ações à direita).
- **Ações destrutivas ou que exigem motivo:** nunca `window.confirm/prompt`; use `ui.confirm / ui.prompt / ui.form` (foco preso no diálogo, `Esc` cancela, botão de envio trava para evitar duplo envio).
- **Estados:** `Skeleton` ao carregar, `EmptyState` sem dados (com texto diferente quando há filtro), `Alert` para erros/avisos, `ui.toast` para confirmações curtas.
- **Tabelas:** cabeçalho fixo, colunas numéricas com `.num` (alinhadas à direita, números tabulares), `SortTh` para ordenar (produtos), contêiner `.table-wrap` com rolagem horizontal só dentro da tabela.
- **Abas:** `.tabs` + `.tab` com `role="tablist"`.
- **Acessibilidade:** foco visível, `aria-current` no menu, `aria-sort`, `aria-live` nos toasts, `prefers-reduced-motion` respeitado.

## Verificado
Telas conferidas no navegador (claro, escuro e 375 px): login, painel, produtos (incluindo o diálogo de nova categoria criando dados reais), financeiro; rolagem horizontal da página medida em 17 telas no celular — nenhuma. Build e checagem de tipos passam.

## Pendências / próximas melhorias
- Ordenação, busca e paginação no servidor existem só em produtos; as demais listas mostram os registros que a API devolve (limite de 100–300).
- Gráficos: o painel não tem série histórica de dados (a API só expõe totais), então **não há gráficos** — não foram inventados. Quando houver endpoints de séries (vendas por dia, fluxo de caixa), usar Recharts.
- Formulários longos (fiscal, integrações) ainda são painéis em cartão, não páginas em seções; as validações de campo seguem as do navegador + mensagens da API.
- Nenhum teste automatizado de interface (E2E de navegador) foi criado.
- Busca global e central de notificações ainda não existem.

## Máscaras, formatação e consulta de CNPJ/CEP
- **Máscaras** (`components/fields.tsx`): `MaskedInput` (CPF, CNPJ, CPF/CNPJ, telefone, CEP, CNAE, código de rastreio), `UfSelect` (lista fixa de UFs). Funções de exibição em `lib/format.ts` (`formatCnpj/Cpf/Phone/Cep/Cnae/Ncm/AccessKey`, `docOrDash`).
- **Gravação:** o servidor guarda documentos, telefone e CEP **só com dígitos** (`normalizeContact`); a formatação é feita ao exibir. Telefone exige DDD (10 ou 11 dígitos; aceita +55). Dados antigos com máscara continuam exibindo corretamente.
- **Consulta de CNPJ** (`DocumentField`): ao completar 14 dígitos válidos, busca na BrasilAPI (base pública da Receita Federal) e preenche **apenas campos vazios**; o botão de lupa refaz a consulta e substitui. Mostra a situação cadastral (alerta se não for "ativa"). **Não traz** inscrição estadual nem regime tributário (não são dados públicos confiáveis; seguem manuais e validados pelo contador). CPF não tem consulta pública: só máscara e validação.
- **Consulta de CEP** (`CepField`): BrasilAPI (v2) com ViaCEP como segunda fonte; preenche logradouro, bairro, município e UF e leva o cursor ao campo "Número".
- **Onde:** empresa, estabelecimento, clientes e fornecedores (consulta de CNPJ); empresa/estabelecimento/clientes (CEP); código de rastreio na expedição.
- **Como funciona por trás:** o navegador chama `GET /api/lookup/cnpj/:cnpj` e `/lookup/cep/:cep` (exigem login e permissão `company.view`; limite de 20 e 40 consultas/min). O servidor valida os dígitos antes de qualquer chamada externa, consulta com tempo limite de 8 s e guarda o resultado em memória por 24 h. Só o número consultado sai do servidor. Se o serviço externo cair, responde 503 e o cadastro segue manual. Endereços das APIs configuráveis por `LOOKUP_BRASILAPI_BASE` / `LOOKUP_VIACEP_BASE`.
- **Atenção:** são serviços públicos de terceiros, sem garantia de disponibilidade nem de atualização; sempre confira os dados preenchidos. O servidor precisa de saída para a internet.

## Tela "Empresa e estrutura" e logotipo do tenant
- **Didática:** passo a passo em 3 etapas (empresa → estabelecimento → depósito) que mostra o que já foi feito e o que falta, com a explicação de para que serve cada nível; depois a hierarquia em cartões (empresa > estabelecimentos > depósitos), com os botões de adicionar no nível certo. Formulários abrem em janela (`Dialog`) com seções (Identificação, Dados fiscais, Endereço) e uma frase dizendo por que cada bloco existe.
- **Logotipo do tenant:** enviado em Empresa e estrutura (PNG/JPG/WebP, até 1 MB; o navegador reduz para no máximo 600 px). Fica em `tenant_branding` (1 por tenant, RLS), é servido por `GET /api/branding/logo` (qualquer membro; só quem gerencia a empresa envia/remove) e aparece no topo do menu lateral **no lugar do nome e do ícone do sistema**. Sem logotipo, o menu mostra a marca do sistema. **SVG é recusado** (pode carregar script); o servidor confere os bytes reais do arquivo, o limite de tamanho e as dimensões. Entrega com CSP restritiva e `nosniff`; envio e remoção são auditados. A versão do logotipo vai no perfil (`tenant.logoVersion`) para o cache atualizar após trocar. Outros usos (login, documentos, relatórios) serão definidos depois.

## Magic UI (animações e cartões de destaque)

Instalado como no guia oficial (shadcn): `apps/web/components.json` com o registro `@magicui`. Componentes em `apps/web/src/components/magicui/` (NumberTicker, MagicCard, BorderBeam, BlurFade, DotPattern, AnimatedCircularProgressBar, ShineBorder, AnimatedGridPattern). Para adicionar mais: `cd apps/web && npx shadcn@latest add @magicui/<nome>`.

- **Tailwind v4 só para eles**, em `src/app/tailwind.css`: sem "preflight" (não reseta o CSS do sistema) e em camadas CSS, então o `globals.css` do sistema sempre vence. As cores do shadcn apontam para as variáveis do sistema (claro/escuro).
- Ajustes feitos nos arquivos copiados: números em `pt-BR`, sem cor fixa preta/branca no `NumberTicker`, e `MagicCard` usa `@/lib/use-theme` (tema do próprio sistema) em vez do `next-themes`.
- Uso no sistema: `StatCard` (todas as telas) virou `KpiCard` (brilho que segue o mouse, número que conta, barra de cor por tom); o dashboard ganhou a faixa `DashboardHero` (`BorderBeam` + `DotPattern`), entrada suave (`BlurFade`), gráficos em cartões com brilho e o progresso circular do checklist.
- Animações respeitam "reduzir movimento" nos nossos estilos; os componentes do Magic UI usam a biblioteca `motion`.
