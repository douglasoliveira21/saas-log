# Produto no padrão de marketplace (cadastro, fotos e ida e volta com o canal)

## O que mudou no cadastro
O produto agora é cadastrado **como um anúncio** (tela `Produtos → Produto`, página própria com seções): título comercial (contador até 60), marca, modelo, código do fabricante (MPN), GTIN/EAN com checagem do dígito verificador, condição (novo/usado/recondicionado), garantia, categoria, descrição (resumo + completa), **ficha técnica** (pares nome/valor), preço e custo, **peso e medidas da embalagem** (frete), estoque, dados fiscais e **fotos**. O que está preenchido aqui é o que alimenta o anúncio.

- **Qualidade do cadastro** (`GET /products/:id/quality`): checklist ao lado do formulário (obrigatórios × recomendados) com nota de 0 a 100. Regras **comuns aos grandes marketplaces** (título 10–60, foto principal ≥ 500×500, marca, GTIN válido, categoria, preço, peso/medidas, ≥ 3 fotos, descrição ≥ 100, ≥ 3 atributos). Cada canal pode exigir mais; o que for específico aparece na pré-visualização do anúncio daquele canal.
- **Fotos** (`product_images`): até 12 por produto, PNG/JPG/WebP, até 3 MB cada (o navegador reduz para no máximo 2000 px). A primeira é a principal; reordenar, trocar a principal, texto alternativo e remover. O servidor confere os **bytes reais** (SVG/HTML renomeado é recusado), lê as dimensões e aplica o limite de 12 mesmo com envios simultâneos. Guardadas no banco com limites (suficiente para este porte; armazenamento de objetos é um próximo passo).
- **URL pública temporária** (`GET /api/media/:id?e=…&s=…`): é como o marketplace baixa a foto ao publicar. Assinada por HMAC, expira (24 h por padrão, no máximo 7 dias), serve **uma** imagem, sem login; assinatura inválida ou expirada responde 404. Cabeçalhos `nosniff` e CSP restritiva.

## Canal → base (importar o que já existe no canal)
Em **Marketplaces → Gerenciar → Produtos do canal**:
1. **Buscar anúncios no canal** lê o catálogo (leitura apenas) e lista os itens: *Novos*, *Vinculados*, *Importados*, *Ignorados*. Repetir é seguro.
2. O sistema sugere correspondência por **SKU** (sem diferenciar maiúsculas) ou **GTIN**.
3. Para cada novo: **Importar** (cria o produto com título, descrição, marca, modelo, GTIN, condição, ficha técnica, preço e **fotos**, e já deixa o anúncio vinculado), **Vincular** a um produto existente, ou **Ignorar**. **Importar novos** faz isso em lote (25 por vez), pulando os que têm correspondência.
4. Nada é criado sozinho. Se já existe produto com o mesmo SKU/GTIN, a importação **recusa** e pede o vínculo (não duplica).
- **Fotos do canal**: baixadas só de domínios que o conector declara (Mercado Livre: `mlstatic.com`), **somente HTTPS**, sem seguir redirecionamentos, com DNS resolvido para endereço público, 10 s e 3 MB — defesa contra SSRF. Foto que falha não impede a importação (vira aviso).
- **Custo**: o canal não informa; o produto importado nasce **sem custo** e o preço do anúncio vira o preço sugerido. Complete o custo para a margem funcionar.

## Base → canal (publicar)
No produto, **Canais de venda**: para cada conexão, **Pré-visualizar anúncio** mostra exatamente o que será enviado (título, preço, estoque publicável, categoria do canal, fotos, ficha técnica, descrição) e a lista do que **bloqueia** (sem foto, sem preço, categoria do canal não mapeada, regras do canal) e do que é só **atenção**. **Publicar** só habilita sem bloqueios.
- A publicação é **ação do usuário** (não automática), uma por vez por produto/canal (reserva atômica). Se o canal recusar, o erro volta claro e o anúncio fica marcado com erro; se o resultado for **incerto** (tempo esgotado), o sistema orienta a usar *Importar do canal* para localizar o anúncio antes de repetir (a varredura vincula por SKU), evitando duplicar.
- Depois de publicado, preço e estoque seguem a sincronização existente (Preços e margens / regras da conexão).

## Estado por canal — honesto
| Canal | Ler anúncios (importar) | Publicar |
|---|---|---|
| Mercado Livre | **Implementado, sem validação com conta real** (testado com servidor simulado) | Implementado, **desligado por padrão** (`ML_PUBLISH_ENABLED=true` para ligar): cria anúncios **reais** e o contrato do `POST /items` (categoria, tipo de anúncio, atributos obrigatórios) **não foi validado**. Ligue só para testar com sua conta. |
| Demais canais da galeria | Planejado | Planejado |
| Sandbox (testes) | Simulado | Simulado |

## O que ainda NÃO existe
- Sincronização **automática e periódica** do catálogo do canal (hoje a leitura é por botão).
- **Variações** (cor/tamanho como SKUs filhos) e kits.
- **Árvore de categorias do canal** e atributos obrigatórios por categoria: o mapeamento de categoria é manual (código do canal informado por você); atributos próprios entram na descrição ("Ficha técnica") no Mercado Livre, pois o canal só aceita IDs do seu catálogo. O modelo "User Products" do Mercado Livre (título definido pelo canal) **não** foi tratado.
- **Atualizar** título/descrição/fotos de um anúncio **já publicado** (hoje só preço e estoque são atualizados).
- Importação de estoque/pedidos históricos por esta tela (pedidos já têm fluxo próprio).
- Qualquer coisa nos canais "Em breve".

## Como testar com segurança
Use a conexão **Sandbox** (testes) ou, no Mercado Livre, uma conta de teste/vendedor com baixo risco, com `ML_PUBLISH_ENABLED=true` apenas durante o teste. Comece pela **leitura** (Buscar anúncios no canal), que não altera nada no canal.
