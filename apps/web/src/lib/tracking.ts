'use client';

import { Capacitor, registerPlugin } from '@capacitor/core';
import { useSyncExternalStore } from 'react';
import { api } from './api';

/**
 * Rastreio do motorista. No aplicativo (APK) usa o serviço de localização em segundo plano do Android; no navegador usa a localização do
 * próprio navegador (só enquanto a página está aberta). Os pontos são enviados em lotes; sem internet ficam guardados no aparelho e seguem
 * quando a conexão volta. O servidor só GUARDA a trilha enquanto há rota em andamento, e o aparelho só envia pontos nesse caso.
 */
export type GpsStatus =
  | 'idle' // ainda não pediu
  | 'asking' // aguardando a resposta do aparelho
  | 'ok' // recebendo posições
  | 'weak' // permissão concedida, mas sem posição agora (túnel, GPS desligado no aparelho…)
  | 'denied' // permissão negada
  | 'unsupported'; // aparelho/navegador sem localização

export interface TrackerState {
  status: GpsStatus;
  native: boolean;
  last: { lat: number; lng: number; accuracyM: number | null; at: number } | null;
  routeActive: boolean | null;
  routeNumber: number | null;
  pending: number;
  lastSentAt: number | null;
  sendError: boolean;
}

interface Pt { lat: number; lng: number; accuracyM?: number; speedMps?: number; heading?: number; recordedAt: string }
interface NativeLocation { latitude: number; longitude: number; accuracy: number; speed: number | null; bearing: number | null; time: number | null }
interface BackgroundGeolocationPlugin {
  addWatcher(options: { backgroundMessage?: string; backgroundTitle?: string; requestPermissions?: boolean; stale?: boolean; distanceFilter?: number }, callback: (position?: NativeLocation, error?: { code?: string; message?: string }) => void): Promise<string>;
  removeWatcher(options: { id: string }): Promise<void>;
  openSettings(): Promise<void>;
}

const BUF_KEY = 'dh-track-buf';
const MAX_BUFFER = 500;
const KEEP_EVERY_MS = 5_000; // um ponto a cada 5 s no máximo
const HEARTBEAT_MS = 30_000;
const FLUSH_SIZE = 10;
const FLUSH_MS = 15_000;

const isNative = () => { try { return Capacitor.isNativePlatform(); } catch { return false; } };
const native = () => registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

function store(op: 'get' | 'set' | 'del', value?: string): string | null {
  try { if (op === 'set') { localStorage.setItem(BUF_KEY, value!); return value!; } if (op === 'del') { localStorage.removeItem(BUF_KEY); return null; } return localStorage.getItem(BUF_KEY); } catch { return null; }
}

class Tracker {
  state: TrackerState = { status: 'idle', native: false, last: null, routeActive: null, routeNumber: null, pending: 0, lastSentAt: null, sendError: false };
  private listeners = new Set<() => void>();
  private started = false;
  private watchId: number | null = null;
  private nativeId: string | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private buffer: Pt[] = [];
  private lastKept = 0;
  private lastFlush = 0;
  private sending = false;
  private onVisible = () => { if (document.visibilityState === 'visible') void this.flush(); };

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.state;
  private set(patch: Partial<TrackerState>) { this.state = { ...this.state, ...patch, pending: this.buffer.length }; this.listeners.forEach((l) => l()); }

  start() {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    try { this.buffer = (JSON.parse(store('get') ?? '[]') as Pt[]).slice(-MAX_BUFFER); } catch { this.buffer = []; }
    this.set({ native: isNative() });
    this.watch();
    this.timers.push(setInterval(() => void this.flush(true), HEARTBEAT_MS));
    window.addEventListener('online', this.onVisible);
    document.addEventListener('visibilitychange', this.onVisible);
    void this.flush(true);
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.unwatch();
    this.timers.forEach(clearInterval); this.timers = [];
    window.removeEventListener('online', this.onVisible);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.set({ status: 'idle', last: null, routeActive: null, sendError: false });
  }

  /** Pede (de novo) o acesso à localização. No navegador precisa de um toque do usuário em alguns aparelhos. */
  retry() { this.unwatch(); this.watch(); }

  async openSettings() { if (isNative()) { try { await native().openSettings(); } catch { /* sem tela de ajustes: o aviso já orienta */ } } }

  private unwatch() {
    if (this.watchId !== null) { navigator.geolocation.clearWatch(this.watchId); this.watchId = null; }
    if (this.nativeId) { const id = this.nativeId; this.nativeId = null; void native().removeWatcher({ id }).catch(() => undefined); }
  }

  private watch() {
    this.set({ status: 'asking' });
    if (isNative()) {
      native().addWatcher(
        { backgroundTitle: 'DistribuiHub — rota em andamento', backgroundMessage: 'Sua localização é compartilhada com a empresa enquanto a rota estiver em andamento.', requestPermissions: true, stale: false, distanceFilter: 15 },
        (p, err) => {
          if (err) { this.set({ status: err.code === 'NOT_AUTHORIZED' ? 'denied' : 'weak' }); return; }
          if (p) this.onPoint({ lat: p.latitude, lng: p.longitude, accuracyM: p.accuracy, speedMps: p.speed ?? undefined, heading: p.bearing ?? undefined, t: p.time ?? Date.now() });
        },
      ).then((id) => { if (this.started) this.nativeId = id; else void native().removeWatcher({ id }).catch(() => undefined); }).catch(() => this.set({ status: 'unsupported' }));
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) { this.set({ status: 'unsupported' }); return; }
    this.watchId = navigator.geolocation.watchPosition(
      (p) => this.onPoint({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy, speedMps: p.coords.speed ?? undefined, heading: p.coords.heading ?? undefined, t: p.timestamp }),
      (e) => { if (e.code === e.PERMISSION_DENIED) this.set({ status: 'denied' }); else if (this.state.status !== 'ok') this.set({ status: 'weak' }); },
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    );
  }

  private onPoint(p: { lat: number; lng: number; accuracyM?: number; speedMps?: number; heading?: number; t: number }) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return;
    const now = Date.now();
    this.set({ status: 'ok', last: { lat: p.lat, lng: p.lng, accuracyM: p.accuracyM ?? null, at: now } });
    if (this.state.routeActive !== true || now - this.lastKept < KEEP_EVERY_MS) return; // fora de rota nada é guardado nem enviado
    this.lastKept = now;
    this.buffer.push({ lat: p.lat, lng: p.lng, accuracyM: p.accuracyM, speedMps: p.speedMps && p.speedMps >= 0 ? p.speedMps : undefined, heading: p.heading && p.heading >= 0 ? p.heading : undefined, recordedAt: new Date(p.t > 0 ? p.t : now).toISOString() });
    if (this.buffer.length > MAX_BUFFER) this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
    store('set', JSON.stringify(this.buffer));
    this.set({});
    if (this.buffer.length >= FLUSH_SIZE || now - this.lastFlush >= FLUSH_MS) void this.flush();
  }

  /** Envia o lote pendente (e o estado do GPS). `beat` envia mesmo sem pontos, para a gestão saber que o GPS está ligado. */
  async flush(beat = false) {
    if (this.sending || (!this.buffer.length && !beat) || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
    this.sending = true; this.lastFlush = Date.now();
    const s = this.state.status;
    const batch = this.state.routeActive === false ? [] : this.buffer.slice(0, 60);
    try {
      const r = await api<{ accepted: number; routeActive: boolean; routeNumber: number | null }>('/delivery/my/position', 'POST', {
        points: batch, gps: { enabled: s === 'ok', permission: s === 'denied' ? 'denied' : s === 'ok' || s === 'weak' ? 'granted' : 'prompt', source: isNative() ? 'APP' : 'WEB' },
      });
      this.buffer.splice(0, batch.length);
      if (!r.routeActive) this.buffer = [];
      store('set', JSON.stringify(this.buffer));
      this.set({ routeActive: r.routeActive, routeNumber: r.routeNumber, lastSentAt: Date.now(), sendError: false });
    } catch {
      this.set({ sendError: true });
    } finally { this.sending = false; }
  }
}

export const tracker = new Tracker();
export const useTracker = () => useSyncExternalStore(tracker.subscribe, tracker.getSnapshot, tracker.getSnapshot);

/** Apaga o que ficou guardado no aparelho (ao sair da conta). */
export function clearTrackerBuffer() { store('del'); }
