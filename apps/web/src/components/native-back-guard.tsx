'use client';

import { Capacitor, registerPlugin } from '@capacitor/core';
import { useEffect } from 'react';
import { useUi } from '@/components/ui';
import { tracker } from '@/lib/tracking';

interface AppPlugin {
  addListener(event: 'backButton', cb: (e: { canGoBack: boolean }) => void): Promise<{ remove: () => Promise<void> }>;
  exitApp(): Promise<void>;
}

/**
 * Só no aplicativo (APK): o botão "voltar" do Android nunca fecha o app por engano. Volta de tela normalmente; na tela inicial, o primeiro
 * toque avisa e o segundo (em até 3 s) pergunta se deseja mesmo encerrar. Só confirmando é que o app fecha e o GPS para; do contrário
 * ele continua em segundo plano (o botão "início" também só manda o app para segundo plano).
 */
export function NativeBackGuard() {
  const ui = useUi();
  useEffect(() => {
    let native = false;
    try { native = Capacitor.isNativePlatform(); } catch { /* navegador */ }
    if (!native) return;
    const app = registerPlugin<AppPlugin>('App');
    let last = 0; let asking = false; let remove: (() => Promise<void>) | null = null; let dead = false;
    void app.addListener('backButton', async ({ canGoBack }) => {
      if (asking) return;
      if (canGoBack) { window.history.back(); return; }
      const now = Date.now();
      if (now - last > 3000) { last = now; ui.toast.info('Toque em voltar de novo para encerrar o aplicativo.'); return; }
      last = 0; asking = true;
      const yes = await ui.confirm({ title: 'Encerrar o aplicativo?', message: 'Ao encerrar, o GPS para e sua rota deixa de ser acompanhada. Para continuar trabalhando, escolha “Continuar”.', confirmLabel: 'Encerrar', cancelLabel: 'Continuar', danger: true });
      asking = false;
      if (yes) { tracker.shutdown(); await app.exitApp(); }
    }).then((h) => { if (dead) void h.remove(); else remove = h.remove; }).catch(() => undefined);
    return () => { dead = true; if (remove) void remove(); };
  }, [ui]);
  return null;
}
