'use client';

import { useEffect } from 'react';

/**
 * Mede a velocidade real de quem usa (LCP, INP, CLS, FCP, TTFB) e envia de forma anônima
 * para /api/vitals: só nome, valor e tipo de aparelho — sem usuário, IP ou endereço da página.
 */
export function WebVitals() {
  useEffect(() => {
    if (typeof PerformanceObserver === 'undefined') return;
    const device = window.matchMedia('(max-width: 768px)').matches ? 'mobile' : 'desktop';
    const send = (name: string, value: number) => {
      try { navigator.sendBeacon?.('/api/vitals', new Blob([JSON.stringify({ name, value: Math.round(value * 1000) / 1000, device })], { type: 'application/json' })); } catch { /* medir nunca atrapalha o uso */ }
    };
    let lcp = 0, cls = 0, inp = 0, sent = false;
    const observe = (type: string, cb: (e: PerformanceEntry) => void, extra: object = {}) => {
      try { const po = new PerformanceObserver((l) => l.getEntries().forEach(cb)); po.observe({ type, buffered: true, ...extra } as PerformanceObserverInit); return po; } catch { return null; }
    };
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav) send('TTFB', nav.responseStart);
    observe('paint', (e) => { if (e.name === 'first-contentful-paint') send('FCP', e.startTime); });
    observe('largest-contentful-paint', (e) => { lcp = e.startTime; });
    observe('layout-shift', (e) => { const ls = e as PerformanceEntry & { value: number; hadRecentInput: boolean }; if (!ls.hadRecentInput) cls += ls.value; });
    observe('event', (e) => { const ev = e as PerformanceEntry & { interactionId?: number }; if (ev.interactionId && e.duration > inp) inp = e.duration; }, { durationThreshold: 40 });
    const flush = () => {
      if (sent || document.visibilityState !== 'hidden') return;
      sent = true;
      if (lcp) send('LCP', lcp);
      send('CLS', cls);
      if (inp) send('INP', inp);
    };
    document.addEventListener('visibilitychange', flush);
    return () => document.removeEventListener('visibilitychange', flush);
  }, []);
  return null;
}
