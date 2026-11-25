# Aplicativo do motorista, GPS obrigatório e mapa ao vivo

O motorista usa o **mesmo sistema e o mesmo banco**. A diferença: ao entrar com uma conta de motorista, a **localização do celular é obrigatória** e a gestão acompanha a rota em tempo real.

## O que existe

| Parte | O que faz |
|---|---|
| **Portão de GPS** (`apps/web/src/components/gps-gate.tsx`) | Conta só com `delivery.perform` (sem `routes.view`): nada do sistema abre enquanto a localização não for liberada. Se for negada, mostra o passo a passo e o botão “Abrir ajustes” (no app). Se o sinal cair no meio do trabalho, aparece um aviso (sem travar a tela de entrega). |
| **Rastreador** (`apps/web/src/lib/tracking.ts`) | No **APK**: serviço em primeiro plano do Android (plugin `@capacitor-community/background-geolocation`), continua com a tela apagada. No **navegador**: só enquanto a página está aberta. Envia em lotes a cada ~15 s; sem internet guarda até 500 pontos no aparelho e envia depois. |
| **API** (`apps/api/src/delivery/tracking.ts`) | `POST /delivery/my/position`, `GET /delivery/tracking` (mapa ao vivo), `GET /delivery/routes/:id/track`, `POST /delivery/routes/:id/plan`, `GET /delivery/my/routes/:id/map`. |
| **Mapa ao vivo** (`/rotas/mapa`) | Motoristas com rota em andamento, trajeto planejado, trilha percorrida, próxima parada com distância e previsão, e **alertas**: GPS desligado/bloqueado, sem sinal (> 3 min), fora da rota (> 300 m do trajeto nos 3 últimos pontos), parado (> 15 min longe de qualquer parada). |
| **Mapa do motorista** (`/motorista`) | Paradas numeradas, trajeto e a posição dele. |
| **APK** (`mobile/` + `.github/workflows/android-apk.yml`) | Casca Capacitor que abre o sistema em produção. |

## Privacidade (já refletida em `/privacidade` e `/termos`)

- A posição só é **guardada** com rota **em andamento**. Sem rota, o aparelho só informa se o GPS está ligado; nada de latitude/longitude é enviado nem gravado.
- Trilha apagada após `TRACK_RETENTION_DAYS` (padrão **30**; limpeza automática, no máximo 1×/h por processo).
- Isolamento por empresa com RLS (`driver_positions`, `driver_track_points`), como o resto do sistema.
- Para o mapa, só o **endereço** da parada vai ao geocodificador e só **coordenadas** ao serviço de rotas — sem nome de cliente ou motorista.

## Mapas gratuitos escolhidos e seus limites

| Função | Serviço | Limite / observação |
|---|---|---|
| Mapa | **Leaflet + OpenStreetMap** | A política dos tiles públicos do OSM é de uso **leve**. Para muitos motoristas/telas, aponte `NEXT_PUBLIC_MAP_TILE_URL` (e `NEXT_PUBLIC_MAP_ATTRIBUTION`) para um provedor próprio ou contratado. É variável de **build** do web. |
| Endereço → coordenada | **Nominatim** (OSM) | 1 consulta/s, com identificação (`GEOCODER_CONTACT`). Cada endereço é consultado **uma vez** e guardado no banco. Para volume alto use instância própria (`GEOCODER_URL`). |
| Trajeto pelas ruas | **OpenRouteService** | Gratuito com chave (≈2.000 rotas/dia). **Sem `ORS_API_KEY` nenhum trajeto é calculado** (o mapa mostra só paradas e posição; o alerta “fora da rota” fica desligado). Nunca inventamos um trajeto. `ORS_URL` permite instância própria. |

## Variáveis de ambiente

API: `ORS_API_KEY`, `ORS_URL`, `GEOCODER_URL`, `GEOCODER_CONTACT`, `GEOCODER_MIN_GAP_MS`, `TRACK_RETENTION_DAYS`.
Web (build): `NEXT_PUBLIC_MAP_TILE_URL`, `NEXT_PUBLIC_MAP_ATTRIBUTION`.

Ao **iniciar uma rota**, o sistema geocodifica o depósito e as paradas e calcula o trajeto em segundo plano (iniciar nunca falha por causa do mapa). Também dá para recalcular em **Mapa ao vivo → Calcular trajeto**.

## Gerar o APK

Veja [`mobile/README.md`](../mobile/README.md).

## Limites conhecidos (honestos)

- **O APK não foi compilado nem testado em aparelho real nesta máquina** (não há Android SDK/JDK 21 aqui). O projeto Android é gerado e compilado pelo GitHub Actions; o primeiro APK precisa ser instalado e testado em um celular antes do uso real (permissão “o tempo todo”, notificação fixa, economia de bateria do fabricante).
- Alguns fabricantes (Xiaomi, Huawei, Samsung em modo econômico) encerram serviços em segundo plano: o motorista deve tirar o app da “otimização de bateria”.
- **Segundo plano (tela bloqueada / outro app aberto):** o APK usa um serviço em primeiro plano do Android (notificação fixa) e pede ao motorista para liberar o app das restrições de bateria (plugin nativo `PowerSettings`, instalado por `mobile/scripts/patch-android.mjs`). As posições são enviadas quando o Android entrega a localização ao app; se o envio falhar, ficam em fila e seguem ao voltar a rede ou ao reabrir o app. **Isso não foi testado em aparelho real**; teste bloqueando a tela por 10+ minutos com uma rota em andamento e conferindo a trilha no mapa ao vivo.
- No **navegador** o rastreio para quando a tela apaga ou a aba fica em segundo plano — por isso o APK.
- A precisão do GPS e a previsão de chegada são **estimativas** (a previsão usa distância em linha reta × 1,3 e 30 km/h).
- A conta de motorista é reconhecida por ter `delivery.perform` e **não** ter `routes.view`; um usuário com os dois não é bloqueado.
- iOS não está incluído.
- Não há otimização do menor caminho entre as paradas (continua a ordenação por região).


## Envio nativo (serviço do aplicativo) — a parte que não depende da página

**Por quê:** o envio feito pela página do sistema pode parar quando o Android pausa a página (tela bloqueada há alguns minutos, celulares muito restritivos). No APK novo, quem lê o GPS **e envia** as posições é um **serviço nativo** do Android (`mobile/native/TrackerService.java`), que não depende da página, da tela ou do app estar na frente.

**Como funciona**
- **Serviço em primeiro plano** (notificação fixa), com *wake lock* parcial, `START_STICKY` (o Android o religa se o encerrar) e `BootReceiver` (religa ao reiniciar o celular ou atualizar o app). Lê o GPS a cada 5 s (e a rede como reserva se o GPS ficar 30 s sem posição); se o sistema parar de entregar posições por 2 min, registra o GPS de novo.
- **Fila em arquivo** (`PointQueue`): cada posição só sai da fila quando o servidor confirma. Sem internet, ela espera (até ~20.000 pontos) e vai em lotes de 60 quando a conexão volta. Sobrevive a app fechado e celular reiniciado.
- **Credencial do aparelho:** a página pede `POST /delivery/my/tracking-token` (motorista logado) e entrega ao serviço. O valor aparece uma vez; no banco fica só o hash (SHA-256). Vale **90 dias**, só serve para `POST /delivery/beacon` (nenhuma outra rota) e é conferida a cada chamada (motorista, usuário e participação ativos). Uma nova credencial revoga a anterior. Sair da conta ou encerrar o app revoga e apaga a fila.
- **Rota `POST /delivery/beacon`** (pública, `Authorization: Bearer dht_…`, limitada a 240 req/min): grava a trilha só com rota em andamento, como a rota normal.
- **Tela:** acompanha o serviço a cada 3 s (permissões, GPS ligado, última posição, fila, último envio) e exige **“Permitir o tempo todo”** (e a liberação de bateria) antes de liberar o sistema, com saída “continuar mesmo assim” depois de 2 tentativas. Se o serviço parar ou a credencial for recusada, a página renova e religa sozinha (no máximo a cada minuto).
- **Alertas da gestão** (Mapa ao vivo): GPS desligado, sem sinal (> 3 min), fora da rota, parado.
- APK antigo (sem o serviço nativo): a página cai no caminho anterior (plugin + envio pela página).

**O que continua impossível de garantir (e por quê)**
- Motorista que desliga o GPS, tira a permissão ou ativa o modo avião: o sistema avisa, mas não impede.
- Fabricantes que matam apps em segundo plano mesmo assim (Xiaomi, Huawei, Samsung/Motorola em modo econômico): reduz-se com os ajustes de bateria e “início automático”, não se elimina.
- Túnel, garagem, área sem sinal de GPS: não há posição; ao voltar, a fila é enviada.
- Android recente restringe religar serviço de localização ao reiniciar o celular; se o `BootReceiver` não conseguir, o motorista abre o app e ele volta.
- **O serviço nativo nunca foi executado em um celular real por mim.** A API (credencial, rota, isolamento) tem testes automáticos; o código Android só foi compilado/validado pelo GitHub Actions. Faça o roteiro de teste abaixo antes de confiar.

**Roteiro de teste em celular real**
1. Instale o APK, entre com um motorista, libere localização “o tempo todo”, notificações e bateria.
2. Inicie uma rota de teste e bloqueie a tela por 15 min andando (ou em uma janela). Confira a trilha no Mapa ao vivo.
3. Repita com outro app aberto por 15 min, e com o modo avião por 5 min (a trilha deve “completar” ao voltar a internet).
4. Reinicie o celular com a rota em andamento e abra o app: o GPS deve voltar.
5. Observe se aparecem buracos na trilha e anote o modelo do aparelho.
