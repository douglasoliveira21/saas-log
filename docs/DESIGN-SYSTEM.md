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
