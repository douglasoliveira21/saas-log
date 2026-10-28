# Roteirização e confirmação de entrega pelo motorista

## Fluxo
1. **Cadastro do motorista** (Rotas e entregas → Motoristas): cria o acesso (papel de sistema **Motorista**) com nome, e-mail, senha provisória, telefone, veículo e placa. O motorista só vê as **próprias** rotas.
2. **Montar a rota** (Nova rota): data, motorista e os pedidos **embalados** (ou já expedidos) que ainda não estão em nenhuma rota. As paradas saem **ordenadas por região** (UF → cidade → CEP → rua → número) e o despachante ajusta com ↑ ↓, remove ou adiciona pedidos. "Abrir no mapa" gera um link do Google Maps com as paradas pendentes (até 10).
3. **Iniciar a rota**: os pedidos embalados passam a **expedidos** (baixa o estoque, como em Vendas) e o motorista passa a poder confirmar. Antes disso, o app do motorista mostra "aguardando saída" e bloqueia os botões.
4. **Entrega** (Minhas entregas, no celular): botão **Entreguei** → tira a **foto do canhoto assinado (obrigatória)**, informa quem recebeu (obrigatório), documento e observação (opcionais). A posição do aparelho é gravada se ele permitir. O pedido vira **Entregue** (dispara a comissão se configurada para "entregue"). Quando a última parada é resolvida, a rota fica **Concluída**.
5. **Não consegui entregar**: motivo obrigatório (foto opcional). O pedido **continua em trânsito** e pode ir para uma nova rota.
6. **Conferência**: o despachante abre a rota e vê o canhoto de cada entrega ("Ver canhoto"), quem recebeu, quando e o local.

## Regras do canhoto (o que o servidor garante)
- Sem foto, **não confirma** (HTTP 400). A foto é validada pelos **bytes** (PNG/JPEG/WebP reais; HTML ou arquivo renomeado é recusado), entre 2 KB e 4 MB, com **pelo menos 480 px no menor lado** (legibilidade). O celular reduz a foto para 1600 px antes de enviar.
- **A mesma foto não vale para duas entregas** (hash SHA-256 único por empresa).
- Reenvio da mesma confirmação (rede instável) é **idempotente**; confirmar de novo com outra foto é recusado. Envios simultâneos gravam um único comprovante.
- O comprovante é **imutável**: o papel de aplicação não tem UPDATE/DELETE nele. Auditoria registra início, entrega (com o hash da foto) e conclusão.
- Só o **motorista da rota** confirma (nem o despachante nem outro motorista). Entrega confirmada **não** permite cancelar a rota.
- Um pedido só pode estar **pendente em uma rota** por vez (garantido no banco, mesmo com cliques simultâneos). Isolamento por empresa com RLS.

## Permissões
`routes.view` (ver rotas, motoristas e canhotos), `routes.manage` (cadastrar motoristas, montar/iniciar/cancelar rotas) — Expedidor e Gerente operacional; `delivery.perform` — só o papel Motorista. Proprietário e administrador têm todas. Papéis de sistema novos são criados também nas empresas já existentes (`npm run db:setup` / `sync-roles`).

## Limites conhecidos (honestos)
- **Não calcula o menor caminho.** A ordem por região agrupa por CEP, mas otimizar distância real exige coordenadas e um serviço de rotas (ex.: Google Routes, OSRM), **não implementado**. O link do mapa apenas abre as paradas na ordem definida.
- Geocodificação, mapa ao vivo, trilha percorrida, alertas e previsão aproximada de chegada existem — veja [`DRIVER-TRACKING.md`](DRIVER-TRACKING.md). Não há janela de entrega por cliente nem capacidade/peso do veículo.
- O app do motorista é a página web do sistema (navegador ou APK, veja `mobile/`); **não há modo offline completo** — só as posições do GPS ficam em fila quando falta internet.
- O sistema **não** verifica a assinatura no canhoto (é uma foto); a conferência é visual pelo despachante.
- Fotos ficam no banco (limite por foto); armazenamento de objetos e retenção por prazo legal são um próximo passo.
