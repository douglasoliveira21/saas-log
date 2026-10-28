import { Injectable, Logger } from '@nestjs/common';

/** Ponto [latitude, longitude]. */
export type LatLng = [number, number];
const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Distância em metros entre dois pontos (fórmula de Haversine). */
export function haversine(a: LatLng, b: LatLng): number {
  const dLat = rad(b[0] - a[0]); const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distância (m) de um ponto ao segmento a–b, em projeção plana local (suficiente para distâncias de poucos km). */
export function distanceToSegment(p: LatLng, a: LatLng, b: LatLng): number {
  const k = Math.cos(rad(p[0]));
  const px = rad(p[1]) * k * R; const py = rad(p[0]) * R;
  const ax = rad(a[1]) * k * R; const ay = rad(a[0]) * R;
  const bx = rad(b[1]) * k * R; const by = rad(b[0]) * R;
  const dx = bx - ax; const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Menor distância (m) do ponto ao trajeto. Trajeto vazio → null. */
export function distanceToPolyline(p: LatLng, line: LatLng[]): number | null {
  if (!line.length) return null;
  if (line.length === 1) return haversine(p, line[0]);
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) best = Math.min(best, distanceToSegment(p, line[i], line[i + 1]));
  return best;
}

/** Reduz uma lista de pontos para no máximo `max` (mantém o primeiro e o último). */
export function downsample<T>(list: T[], max: number): T[] {
  if (list.length <= max) return list;
  const out: T[] = []; const step = (list.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(list[Math.round(i * step)]);
  return out;
}

export const validLat = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= -90 && n <= 90;
export const validLng = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= -180 && n <= 180;

export type GeoResult = { status: 'OK'; lat: number; lng: number } | { status: 'NOT_FOUND' } | { status: 'ERROR'; reason: string };

/**
 * Geocodificação com o Nominatim (dados do OpenStreetMap, gratuito e sem chave). A política de uso exige: no máximo 1 consulta por segundo,
 * identificar a aplicação (User-Agent com contato) e guardar o resultado — por isso cada parada/estabelecimento é geocodificado UMA vez e
 * salvo no banco. Para volume alto, aponte GEOCODER_URL para uma instância própria ou um serviço contratado.
 */
@Injectable()
export class Geocoder {
  private readonly log = new Logger(Geocoder.name);
  private chain: Promise<unknown> = Promise.resolve();
  private last = 0;

  private base() { return (process.env.GEOCODER_URL ?? 'https://nominatim.openstreetmap.org').replace(/\/$/, ''); }
  private gap() { return Number(process.env.GEOCODER_MIN_GAP_MS ?? 1100); }

  /** Tenta o endereço completo e, se não achar, o CEP + cidade. */
  async geocode(queries: string[]): Promise<GeoResult> {
    let notFound = false;
    for (const q of queries.filter((x) => x && x.trim().length > 3)) {
      const r = await this.enqueue(() => this.one(q));
      if (r.status === 'OK') return r;
      if (r.status === 'ERROR') return r;
      notFound = true;
    }
    return notFound ? { status: 'NOT_FOUND' } : { status: 'ERROR', reason: 'Endereço vazio.' };
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.last + this.gap() - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try { return await fn(); } finally { this.last = Date.now(); }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async one(q: string): Promise<GeoResult> {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 10_000);
    try {
      const url = `${this.base()}/search?${new URLSearchParams({ format: 'jsonv2', limit: '1', countrycodes: 'br', q })}`;
      const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': `DistribuiHub/1.0 (${process.env.GEOCODER_CONTACT ?? 'suporte@vgon.com.br'})`, 'Accept-Language': 'pt-BR' } });
      if (!res.ok) return { status: 'ERROR', reason: `Geocodificador respondeu ${res.status}` };
      const body = (await res.json()) as { lat?: string; lon?: string }[];
      const first = body?.[0];
      const lat = Number(first?.lat); const lng = Number(first?.lon);
      return validLat(lat) && validLng(lng) ? { status: 'OK', lat, lng } : { status: 'NOT_FOUND' };
    } catch (e) {
      this.log.warn(`geocodificação falhou: ${(e as Error).message}`);
      return { status: 'ERROR', reason: (e as Error).name === 'AbortError' ? 'demorou demais' : (e as Error).message };
    } finally { clearTimeout(timer); }
  }
}

export interface PlannedRoute { geometry: LatLng[]; distanceM: number; durationS: number; source: 'ORS' }

/**
 * Cálculo do trajeto pelas ruas com o OpenRouteService (OpenStreetMap; plano gratuito com chave: 2.000 rotas/dia, 40/min). Sem ORS_API_KEY
 * nada é calculado (o mapa mostra só as paradas e a posição do motorista) — nunca inventamos um trajeto.
 */
@Injectable()
export class RoutePlanner {
  private readonly log = new Logger(RoutePlanner.name);
  configured() { return !!process.env.ORS_API_KEY; }

  async plan(points: LatLng[]): Promise<PlannedRoute | null> {
    if (!this.configured() || points.length < 2) return null;
    const base = (process.env.ORS_URL ?? 'https://api.openrouteservice.org').replace(/\/$/, '');
    const geometry: LatLng[] = []; let distanceM = 0; let durationS = 0;
    // o serviço aceita até 50 pontos por consulta: divide em trechos que se encontram na última parada
    for (let i = 0; i < points.length - 1; i += 49) {
      const part = points.slice(i, i + 50);
      if (part.length < 2) break;
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 20_000);
      try {
        const res = await fetch(`${base}/v2/directions/driving-car/geojson`, {
          method: 'POST', signal: ctl.signal,
          headers: { 'Content-Type': 'application/json', Authorization: process.env.ORS_API_KEY!, Accept: 'application/geo+json' },
          body: JSON.stringify({ coordinates: part.map(([lat, lng]) => [lng, lat]) }),
        });
        if (!res.ok) { this.log.warn(`rota: serviço respondeu ${res.status}`); return null; }
        const j = (await res.json()) as { features?: { geometry?: { coordinates?: [number, number][] }; properties?: { summary?: { distance?: number; duration?: number } } }[] };
        const f = j.features?.[0];
        const coords = f?.geometry?.coordinates;
        if (!coords?.length) return null;
        geometry.push(...coords.map(([lng, lat]) => [lat, lng] as LatLng));
        distanceM += Math.round(f?.properties?.summary?.distance ?? 0); durationS += Math.round(f?.properties?.summary?.duration ?? 0);
      } catch (e) { this.log.warn(`rota falhou: ${(e as Error).message}`); return null; } finally { clearTimeout(timer); }
    }
    return { geometry: downsample(geometry, 4000), distanceM, durationS, source: 'ORS' };
  }
}
