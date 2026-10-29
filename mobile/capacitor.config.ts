import type { CapacitorConfig } from '@capacitor/cli';

/**
 * O aplicativo é uma casca: abre o próprio sistema (mesmo servidor, mesmo banco, mesmas telas) e acrescenta o que o navegador não faz —
 * enviar o GPS do motorista com a tela apagada, por um serviço em primeiro plano do Android.
 * APP_URL = endereço do sistema em produção (https). Lido na hora do `cap sync` / build.
 */
const url = (process.env.APP_URL ?? '').replace(/\/$/, '');
if (!url.startsWith('https://') && process.env.APP_ALLOW_HTTP !== '1') {
  throw new Error('Defina APP_URL com o endereço https do sistema (ex.: https://erp.suaempresa.com.br).');
}
const host = url.replace(/^https?:\/\//, '').split('/')[0];

const config: CapacitorConfig = {
  appId: process.env.APP_ID ?? 'br.com.vgon.distribuihub',
  appName: process.env.APP_NAME ?? 'DistribuiHub',
  webDir: 'www',
  server: {
    url,
    cleartext: url.startsWith('http://'),
    allowNavigation: [host],
    errorPath: 'index.html',
  },
  android: { allowMixedContent: false, webContentsDebuggingEnabled: process.env.APP_DEBUG_WEBVIEW === '1' },
  plugins: {
    // o Android usa esta permissão para o serviço de localização; o texto da notificação é definido pela tela do motorista
    BackgroundGeolocation: {},
  },
};

export default config;
