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
