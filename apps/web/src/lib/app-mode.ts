'use client';

import { Capacitor } from '@capacitor/core';
import { useSyncExternalStore } from 'react';

/**
 * "Modo aplicativo": a aparência de aplicativo de celular (tema preto e dourado, navegação por abas embaixo). Liga sozinho dentro do APK;
 * no navegador dá para ver abrindo qualquer página com ?app=1 (e desligar com ?app=0). A escolha fica guardada neste navegador.
 */
export function detectAppMode(): boolean {
  try {
    if (Capacitor.isNativePlatform()) return true;
    const p = new URLSearchParams(window.location.search).get('app');
    if (p === '1') { localStorage.setItem('dh-app', '1'); return true; }
    if (p === '0') { localStorage.removeItem('dh-app'); return false; }
    return localStorage.getItem('dh-app') === '1';
  } catch { return false; }
}

const noop = () => () => undefined;
export function useAppMode(): boolean {
  const on = useSyncExternalStore(noop, detectAppMode, () => false);
  return on;
}
