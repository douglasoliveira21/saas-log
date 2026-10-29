# DistribuiHub — aplicativo Android

Casca [Capacitor](https://capacitorjs.com) que abre o **mesmo sistema** (mesmo servidor e banco) e mantém o GPS enviando a posição do motorista com a tela apagada. Detalhes do recurso: [`docs/DRIVER-TRACKING.md`](../docs/DRIVER-TRACKING.md).

Esta pasta fica **fora** dos workspaces do monorepo de propósito: não interfere no build/deploy do sistema. O projeto Android (`android/`) não é versionado — é gerado a cada build.

## Gerar o APK (recomendado: GitHub Actions)

1. No GitHub: **Settings → Secrets and variables → Actions → Variables** → crie `APP_URL` com o endereço https do sistema (ex.: `https://erp.suaempresa.com.br`).
2. **Actions → Aplicativo Android (APK) → Run workflow**. (Ou informe o endereço no campo ao executar.)
3. Ao terminar (uns 6–10 min), baixe o artefato **distribuihub-apk**.
   - Sem chave cadastrada sai um APK **debug** (instala direto, serve para teste e uso interno).
   - Para APK **assinado**: cadastre os secrets `ANDROID_KEYSTORE_BASE64` (o `.jks` em base64), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` e `ANDROID_KEY_PASSWORD`. **Guarde essa chave**: sem ela não dá para publicar atualizações do mesmo app.
4. No celular: permita instalar de “fontes desconhecidas”, instale, abra e entre com a conta de motorista. Na pergunta de localização escolha **Permitir o tempo todo** e libere as notificações.

## Gerar localmente (opcional)

Precisa de Node 20+, **JDK 21** e Android SDK.

```bash
cd mobile
npm install
APP_URL=https://erp.suaempresa.com.br npx cap add android
node scripts/patch-android.mjs
APP_URL=https://erp.suaempresa.com.br npx cap sync android
cd android && ./gradlew assembleDebug
# APK em android/app/build/outputs/apk/debug/
```

## Como funciona

- `capacitor.config.ts` aponta `server.url` para o sistema: o app **não duplica telas** — qualquer melhoria no sistema vale para o app na hora, sem novo APK.
- A tela do motorista detecta que está no app (`Capacitor.isNativePlatform()`) e usa o plugin de localização em segundo plano; no navegador usa o GPS do navegador.
- Sem internet o app mostra a tela “Sem conexão” (`www/index.html`); as posições ficam guardadas e seguem quando a conexão volta.

## Segundo plano

Para o GPS continuar com a tela bloqueada ou com outro app aberto: permissão de localização **o tempo todo**, notificações liberadas e, quando o app pedir, **“Permitir sem restrição de bateria”**. Em Xiaomi, Huawei, Samsung e Motorola também pode ser preciso ativar “Início automático” / tirar o app da economia de bateria nos ajustes do fabricante.

**Opção no app:** em **Perfil → GPS e localização em segundo plano** há uma chave para ligar/desligar o serviço contínuo (padrão: ligado), com o estado da localização, da bateria e da notificação fixa. Desligada, o GPS só funciona com o app na tela.

## Fechar o aplicativo

O botão **voltar** do Android não fecha o app por engano: volta de tela normalmente; na tela inicial, o primeiro toque avisa e o segundo (em até 3 s) pergunta “Encerrar o aplicativo?”. Só confirmando o app fecha e o GPS para. O botão **início** apenas manda o app para segundo plano, onde o GPS continua (notificação fixa). No aplicativo, a conta de motorista só abre depois de liberar a localização e a bateria (há uma saída “continuar mesmo assim” após duas tentativas, para ninguém ficar travado).

## Pendências e avisos

- **Ainda não testado em celular real** (veja os limites em `docs/DRIVER-TRACKING.md`).
- Ícone e tela de abertura são os padrões do Capacitor; troque gerando os recursos com `@capacitor/assets` se quiser a marca.
- Publicar na Play Store exige conta de desenvolvedor, política de privacidade pública (`/privacidade`) e a declaração de uso de localização em segundo plano.
