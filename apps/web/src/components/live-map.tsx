'use client';

import 'leaflet/dist/leaflet.css';
import { useEffect, useRef } from 'react';
import type { Map as LMap, LayerGroup } from 'leaflet';

export interface MapMarker {
  id: string; lat: number; lng: number; kind: 'driver' | 'stop' | 'me';
  /** Texto curto dentro do marcador (número da parada, inicial do motorista). */
  tag: string; tone?: 'ok' | 'warn' | 'bad' | 'muted' | 'brand'; title: string; detail?: string; onClick?: () => void;
}
export interface MapLine { id: string; kind: 'plan' | 'trail'; points: [number, number][] }

/** Tiles do OpenStreetMap por padrão (uso leve). Para volume alto, aponte NEXT_PUBLIC_MAP_TILE_URL para um provedor próprio/contratado. */
const TILES = process.env.NEXT_PUBLIC_MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = process.env.NEXT_PUBLIC_MAP_ATTRIBUTION || '&copy; colaboradores do <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>';

/** Mapa (Leaflet + OpenStreetMap). `fitKey` muda ⇒ reenquadra o mapa nos itens; senão mantém o zoom do usuário. */
export function LiveMap({ markers, lines, fitKey, height = 480, label = 'Mapa' }: { markers: MapMarker[]; lines: MapLine[]; fitKey: string; height?: number; label?: string }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<LMap | null>(null);
  const layer = useRef<LayerGroup | null>(null);
  const lib = useRef<typeof import('leaflet') | null>(null);
  const fitted = useRef('');
  const data = useRef({ markers, lines, fitKey });
  data.current = { markers, lines, fitKey };

  function draw() {
    const L = lib.current; const m = map.current; const g = layer.current;
    if (!L || !m || !g) return;
    const { markers, lines, fitKey } = data.current;
    g.clearLayers();
    const bounds: [number, number][] = [];
    for (const l of lines) {
      if (l.points.length < 2) continue;
      L.polyline(l.points, l.kind === 'plan' ? { color: '#2563eb', weight: 5, opacity: 0.75 } : { color: '#111827', weight: 3, opacity: 0.8, dashArray: '2 7' }).addTo(g);
      if (l.kind === 'plan') bounds.push(...l.points);
    }
    for (const mk of markers) {
      const icon = L.divIcon({ className: 'map-pin-wrap', html: `<span class="map-pin ${mk.kind} ${mk.tone ?? 'brand'}">${mk.kind === 'me' ? '' : escapeHtml(mk.tag)}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] });
      const marker = L.marker([mk.lat, mk.lng], { icon, title: mk.title, zIndexOffset: mk.kind === 'driver' ? 1000 : 0 }).addTo(g);
      const box = document.createElement('div');
      const b = document.createElement('strong'); b.textContent = mk.title; box.append(b);
      if (mk.detail) { const d = document.createElement('div'); d.textContent = mk.detail; d.style.fontSize = '0.85em'; box.append(d); }
      marker.bindPopup(box);
      if (mk.onClick) marker.on('click', mk.onClick);
      bounds.push([mk.lat, mk.lng]);
    }
    if (fitted.current !== fitKey && bounds.length) {
      fitted.current = fitKey;
      if (bounds.length === 1) m.setView(bounds[0], 15); else m.fitBounds(bounds, { padding: [36, 36], maxZoom: 16 });
    }
  }

  useEffect(() => {
    let dead = false;
    void import('leaflet').then((mod) => {
      if (dead || !el.current) return;
      const L = (mod as unknown as { default?: typeof import('leaflet') }).default ?? mod;
      lib.current = L;
      const m = L.map(el.current, { zoomControl: true, attributionControl: true }).setView([-15.78, -47.93], 4); // Brasil, até haver itens
      L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(m);
      map.current = m; layer.current = L.layerGroup().addTo(m);
      draw();
    });
    return () => { dead = true; map.current?.remove(); map.current = null; layer.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { draw(); }, [markers, lines, fitKey]);

  return <div ref={el} className="live-map" style={{ height }} role="region" aria-label={label} />;
}

function escapeHtml(s: string) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!); }
