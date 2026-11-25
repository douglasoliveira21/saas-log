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
  /** Só no aplicativo: o Android está (restricted) ou não (ok) limitando a bateria do app, o que pode parar o GPS com a tela bloqueada. */
  battery: 'unknown' | 'ok' | 'restricted';
  /** Quantas vezes o motorista já foi levado aos ajustes de bateria nesta sessão. */
  batteryAsks: number;
  /** Opção do usuário: manter o GPS e a localização funcionando em segundo plano (serviço contínuo, com notificação fixa). */
  background: boolean;
  /** 'service' = serviço nativo do app (envia sozinho, com a tela bloqueada); 'bgplugin' = plugin de localização + envio pela página (APK antigo); 'web' = navegador. */
  engine: 'web' | 'bgplugin' | 'service';
  /** Serviço nativo: a permissão "Permitir o tempo todo" está concedida (null = ainda não sabe). */
  allTheTime: boolean | null;
  /** Quantas vezes o motorista foi levado a liberar "o tempo todo" nesta sessão. */
  bgAsks: number;
}

interface Pt { lat: number; lng: number; accuracyM?: number; speedMps?: number; heading?: number; recordedAt: string }
interface NativeLocation { latitude: number; longitude: number; accuracy: number; speed: number | null; bearing: number | null; time: number | null }
interface PowerSettingsPlugin { status(): Promise<{ ignoring: boolean }>; request(): Promise<void>; openBatterySettings(): Promise<void>; openAppSettings(): Promise<void> }
interface NativePerms { location: boolean; background: boolean; notifications: boolean; gpsOn: boolean }
interface NativeServiceState extends NativePerms {
  running: boolean; hasToken: boolean; authFailed: boolean; routeActive: number; pending: number; fixAgeSec: number; sentAgeSec: number;
  lat?: number; lng?: number; accuracyM?: number; lastError: string;
}
interface NativeTrackerPlugin {
  permissions(): Promise<NativePerms>; requestLocation(): Promise<NativePerms>; requestBackground(): Promise<NativePerms>; requestNotifications(): Promise<NativePerms>;
  start(o: { baseUrl?: string; token?: string }): Promise<NativeServiceState>; stop(): Promise<{ running: boolean }>; state(): Promise<NativeServiceState>;
}
interface BackgroundGeolocationPlugin {
  addWatcher(options: { backgroundMessage?: string; backgroundTitle?: string; requestPermissions?: boolean; stale?: boolean; distanceFilter?: number }, callback: (position?: NativeLocation, error?: { code?: string; message?: string }) => void): Promise<string>;
  removeWatcher(options: { id: string }): Promise<void>;
  openSettings(): Promise<void>;
}

const BUF_KEY = 'dh-track-buf';
const BG_KEY = 'dh-track-bg';
/** Padrão: ligado (um motorista que não escolheu nada fica acompanhado em segundo plano). */
const readBackground = () => { try { return localStorage.getItem(BG_KEY) !== '0'; } catch { return true; } };
const MAX_BUFFER = 500;
const KEEP_EVERY_MS = 5_000; // um ponto a cada 5 s no máximo
const HEARTBEAT_MS = 30_000;
const FLUSH_SIZE = 10;
const FLUSH_MS = 15_000;

const isNative = () => { try { return Capacitor.isNativePlatform(); } catch { return false; } };
const native = () => registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');
const power = () => registerPlugin<PowerSettingsPlugin>('PowerSettings');
const service = () => registerPlugin<NativeTrackerPlugin>('NativeTracker');

function store(op: 'get' | 'set' | 'del', value?: string): string | null {
  try { if (op === 'set') { localStorage.setItem(BUF_KEY, value!); return value!; } if (op === 'del') { localStorage.removeItem(BUF_KEY); return null; } return localStorage.getItem(BUF_KEY); } catch { return null; }
}

class Tracker {
  state: TrackerState = { status: 'idle', native: false, last: null, routeActive: null, routeNumber: null, pending: 0, lastSentAt: null, sendError: false, battery: 'unknown', batteryAsks: 0, background: true, engine: 'web', allTheTime: null, bgAsks: 0 };
  private listeners = new Set<() => void>();
  private started = false;
  private watchId: number | null = null;
  private nativeId: string | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private buffer: Pt[] = [];
  private lastKept = 0;
  private lastFlush = 0;
  private sending = false;
  private poll: ReturnType<typeof setInterval> | null = null;
  private lastHeal = 0;
  private onVisible = () => { if (document.visibilityState === 'visible') { void this.flush(); void this.checkBattery(); void this.pollService(); } };

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.state;
  private set(patch: Partial<TrackerState>) { this.state = { ...this.state, ...patch, pending: patch.pending ?? (this.state.engine === 'service' ? this.state.pending : this.buffer.length) }; this.listeners.forEach((l) => l()); }

  start() {
    if (this.started || typeof window === 'undefined') return;
    this.started = true;
    try { this.buffer = (JSON.parse(store('get') ?? '[]') as Pt[]).slice(-MAX_BUFFER); } catch { this.buffer = []; }
    this.set({ native: isNative(), background: readBackground() });
    if (isNative() && this.state.background) void this.startNative();
    else this.startWeb();
  }

  /** Navegador (ou o aplicativo com o GPS contínuo desligado): localização pela página, só com a página aberta. */
  private startWeb() {
    this.set({ engine: isNative() ? 'bgplugin' : 'web' });
    this.watch();
    void this.checkBattery();
    this.timers.push(setInterval(() => void this.flush(true), HEARTBEAT_MS));
    window.addEventListener('online', this.onVisible);
    document.addEventListener('visibilitychange', this.onVisible);
    void this.flush(true);
  }

  private stopWeb() {
    this.unwatch();
    this.timers.forEach(clearInterval); this.timers = [];
    window.removeEventListener('online', this.onVisible);
    document.removeEventListener('visibilitychange', this.onVisible);
  }

  /**
   * Aplicativo: o SERVIÇO NATIVO lê o GPS e envia as posições sozinho (fila em arquivo, credencial própria), mesmo com a tela bloqueada e a página
   * parada. Aqui só pedimos as permissões, entregamos a credencial e acompanhamos o estado para mostrar na tela.
   */
  private async startNative() {
    try { await service().permissions(); } catch { this.startWeb(); return; } // APK antigo, sem o serviço nativo
    this.set({ engine: 'service', status: 'asking' });
    void this.checkBattery();
    document.addEventListener('visibilitychange', this.onVisible);
    await this.ensureService(true);
    if (this.poll) clearInterval(this.poll);
    this.poll = setInterval(() => void this.pollService(), 3_000);
    void this.pollService();
  }

  /** Permissões, credencial do aparelho e início do serviço. `ask` = pode mostrar as janelas de permissão. */
  private async ensureService(ask: boolean) {
    try {
      let perms = await service().permissions();
      if (!perms.location && ask) perms = await service().requestLocation();
      if (!perms.location) { this.set({ status: 'denied', allTheTime: perms.background }); return; }
      if (!perms.notifications && ask) await service().requestNotifications().catch(() => undefined);
      if (!perms.background && ask) perms = await service().requestBackground().catch(() => perms);
      let token: string | undefined;
      try { token = (await api<{ token: string }>('/delivery/my/tracking-token', 'POST')).token; } catch { token = undefined; } // sem internet: usa a já guardada
      await service().start({ baseUrl: window.location.origin, token });
      this.set({ allTheTime: perms.background });
    } catch { /* o próximo ciclo tenta de novo */ }
  }

  /** Lê o estado do serviço nativo e traduz para a tela. Também religa o serviço se o Android o tiver encerrado. */
  private async pollService() {
    if (this.state.engine !== 'service') return;
    try {
      const s = await service().state();
      const now = Date.now();
      let status: GpsStatus;
      if (!s.location) status = 'denied';
      else if (!s.running) status = 'asking';
      else if (!s.gpsOn) status = 'weak';
      else status = s.fixAgeSec >= 0 && s.fixAgeSec < 90 ? 'ok' : 'weak';
      this.set({
        status, allTheTime: s.background, pending: s.pending,
        routeActive: s.routeActive === 1 ? true : s.routeActive === 0 ? false : null,
        lastSentAt: s.sentAgeSec >= 0 ? now - s.sentAgeSec * 1000 : this.state.lastSentAt,
        sendError: !!s.lastError && s.lastError !== '',
        last: s.lat !== undefined && s.lng !== undefined && s.fixAgeSec >= 0 ? { lat: s.lat, lng: s.lng, accuracyM: s.accuracyM ?? null, at: now - s.fixAgeSec * 1000 } : this.state.last,
      });
      // cura sozinha: serviço parado ou credencial recusada → renova e religa (no máximo a cada minuto)
      if (s.location && (!s.running || s.authFailed) && now - this.lastHeal > 60_000) { this.lastHeal = now; void this.ensureService(false); }
    } catch { /* tenta no próximo ciclo */ }
  }

  /** "Permitir o tempo todo" (Android 11 ou mais novo abre os ajustes do app). */
  async requestAllTheTime() {
    this.set({ bgAsks: this.state.bgAsks + 1 });
    try { const p = await service().requestBackground(); this.set({ allTheTime: p.background }); } catch { /* o aviso na tela orienta */ }
    void this.pollService();
  }

  /** Para só o acompanhamento NA PÁGINA. O serviço nativo do aplicativo continua rodando (só para ao sair da conta ou encerrar o app). */
  stop() {
    if (!this.started) return;
    this.started = false;
    this.stopWeb();
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
    document.removeEventListener('visibilitychange', this.onVisible);
    this.set({ status: 'idle', last: null, routeActive: null, sendError: false });
  }

  /** Encerra de verdade: desliga o serviço nativo, apaga a fila do aparelho e revoga a credencial (ao sair da conta ou fechar o app de propósito). */
  async endService() {
    if (!isNative()) return;
    try { await service().stop(); } catch { /* APK antigo */ }
    try { await api('/delivery/my/tracking-token', 'DELETE'); } catch { /* sem sessão ou sem internet: ela vence sozinha */ }
  }

  /** Pede (de novo) o acesso à localização. No navegador precisa de um toque do usuário em alguns aparelhos. */
  retry() { this.unwatch(); this.watch(); }

  /** Pergunta ao Android se o app está livre das restrições de bateria (só no aplicativo). */
  async checkBattery() {
    if (!isNative()) return;
    try { const r = await power().status(); this.set({ battery: r.ignoring ? 'ok' : 'restricted' }); } catch { this.set({ battery: 'unknown' }); }
  }

  /** Abre a tela do Android que libera o app das restrições de bateria. */
  async requestBattery() { if (isNative()) { this.set({ batteryAsks: this.state.batteryAsks + 1 }); try { await power().request(); } catch { /* o aviso na tela continua orientando */ } } }

  /** Lista de apps do Android, para escolher "Sem restrições" manualmente. */
  async openBatterySettings() { if (isNative()) { this.set({ batteryAsks: this.state.batteryAsks + 1 }); try { await power().openBatterySettings(); } catch { /* idem */ } } }

  /**
   * Liga/desliga o funcionamento em segundo plano (app). Ligado: serviço contínuo do Android com notificação fixa (o GPS segue com a tela
   * bloqueada ou com outro app aberto). Desligado: o GPS só funciona com o app na tela. A escolha fica neste aparelho.
   */
  setBackground(on: boolean) {
    try { localStorage.setItem(BG_KEY, on ? '1' : '0'); } catch { /* sem armazenamento: vale até fechar */ }
    this.set({ background: on });
    if (!this.started) return;
    if (this.state.engine === 'service' && !on) { // volta para a localização pela página (só com o app na tela)
      if (this.poll) { clearInterval(this.poll); this.poll = null; }
      document.removeEventListener('visibilitychange', this.onVisible);
      void service().stop().catch(() => undefined).then(() => this.startWeb());
    } else if (this.state.engine !== 'service' && isNative() && on) {
      this.stopWeb();
      void this.startNative();
    } else if (this.state.engine === 'bgplugin') this.retry(); // APK antigo: recria o observador com/sem o serviço do plugin
  }

  /** Encerra o rastreio (usado ao fechar o aplicativo de propósito). */
  shutdown() { this.stop(); void this.endService(); }

  async openSettings() { if (isNative()) { try { await power().openAppSettings(); } catch { try { await native().openSettings(); } catch { /* sem tela de ajustes: o aviso já orienta */ } } } }

  private unwatch() {
    if (this.watchId !== null) { navigator.geolocation.clearWatch(this.watchId); this.watchId = null; }
    if (this.nativeId) { const id = this.nativeId; this.nativeId = null; void native().removeWatcher({ id }).catch(() => undefined); }
  }

  private watch() {
    this.set({ status: 'asking' });
    if (isNative()) {
      native().addWatcher(
        { ...(this.state.background ? { backgroundTitle: 'DistribuiHub em funcionamento', backgroundMessage: 'GPS ativo. Mantenha o aplicativo aberto em segundo plano; a localização só é registrada com rota em andamento.' } : {}), requestPermissions: true, stale: false, distanceFilter: 15 },
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
if (typeof window !== 'undefined') tracker.state = { ...tracker.state, background: readBackground() };
export const useTracker = () => useSyncExternalStore(tracker.subscribe, tracker.getSnapshot, tracker.getSnapshot);

/** Apaga o que ficou guardado no aparelho (ao sair da conta). */
export function clearTrackerBuffer() { store('del'); }
/** Ao sair da conta: desliga o serviço nativo e revoga a credencial do aparelho. */
export const endTracking = () => tracker.endService();
