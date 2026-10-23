'use client';

import { useEffect, useState } from 'react';

/** Mesmo formato do `useTheme` do next-themes, lendo o tema do próprio sistema (`data-theme` no <html>; sem ele vale o do navegador). */
export function useTheme(): { theme: 'light' | 'dark' | 'system'; systemTheme: 'light' | 'dark' } {
  const read = () => {
    const t = typeof document === 'undefined' ? undefined : document.documentElement.dataset.theme;
    return t === 'dark' || t === 'light' ? t : 'system';
  };
  const sys = () => (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const [state, setState] = useState<{ theme: 'light' | 'dark' | 'system'; systemTheme: 'light' | 'dark' }>({ theme: 'system', systemTheme: 'light' });
  useEffect(() => {
    const update = () => setState({ theme: read(), systemTheme: sys() });
    update();
    const obs = new MutationObserver(update);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return state;
}
