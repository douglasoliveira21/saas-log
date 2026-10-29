// Gera o ícone e a tela de abertura do aplicativo (preto e dourado) a partir da marca do DistribuiHub (hexágonos em rede).
// Uso (na raiz do repositório): node mobile/scripts/make-icons.mjs
// Saída: mobile/assets/{icon-only,icon-foreground,icon-background,splash,splash-dark}.png — o GitHub Actions os converte para o Android
// com `@capacitor/assets`. Os PNGs ficam versionados; só rode este script para mudar o desenho.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const out = fileURLToPath(new URL('../assets/', import.meta.url));
mkdirSync(out, { recursive: true });

const GOLD = ['#f6df9c', '#d8b25a', '#a97b25'];
const defs = `<defs>
  <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="60" y1="40" x2="460" y2="480"><stop offset="0" stop-color="${GOLD[0]}"/><stop offset=".5" stop-color="${GOLD[1]}"/><stop offset="1" stop-color="${GOLD[2]}"/></linearGradient>
  <linearGradient id="gt" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${GOLD[0]}"/><stop offset=".5" stop-color="${GOLD[1]}"/><stop offset="1" stop-color="${GOLD[2]}"/></linearGradient>
  <radialGradient id="bg" cx=".5" cy=".38" r=".85"><stop offset="0" stop-color="#1d1a12"/><stop offset=".55" stop-color="#0d0d0e"/><stop offset="1" stop-color="#050505"/></radialGradient>
</defs>`;

/** Hexágono de ponta para cima (como na marca). */
const hex = (cx, cy, r) => {
  const p = Array.from({ length: 6 }, (_, i) => { const a = (Math.PI / 180) * (60 * i - 90); return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`; });
  return `<polygon points="${p.join(' ')}" fill="url(#g)" stroke-linejoin="round"/>`;
};

/** A marca: hexágono central, seis hexágonos ao redor, hastes e arcos de ligação. Desenhada em 512x512. */
function mark() {
  const c = 256; const R = 168; const rc = 66; const ro = 42;
  const ang = [-90, -30, 30, 90, 150, 210].map((d) => (d * Math.PI) / 180);
  const pts = ang.map((a) => [c + R * Math.cos(a), c + R * Math.sin(a)]);
  let s = '';
  // hastes do centro para os hexágonos de fora
  ang.forEach((a) => { const x1 = c + (rc + 14) * Math.cos(a); const y1 = c + (rc + 14) * Math.sin(a); const x2 = c + (R - ro - 14) * Math.cos(a); const y2 = c + (R - ro - 14) * Math.sin(a); s += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="url(#g)" stroke-width="15" stroke-linecap="butt"/>`; });
  // arcos entre os hexágonos vizinhos (pedaços do anel)
  for (let i = 0; i < 6; i++) {
    const a1 = ang[i] + 0.34; const a2 = ang[(i + 1) % 6] - 0.34 + (i === 5 ? Math.PI * 2 : 0);
    const r = R; const x1 = c + r * Math.cos(a1); const y1 = c + r * Math.sin(a1); const x2 = c + r * Math.cos(a2); const y2 = c + r * Math.sin(a2);
    s += `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="url(#g)" stroke-width="13" stroke-linecap="round" opacity=".9"/>`;
  }
  s += hex(c, c, rc);
  pts.forEach(([x, y]) => { s += hex(x, y, ro); });
  return s;
}

const svg = (w, h, inner) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${defs}${inner}</svg>`);
/** Coloca a marca (512x512) no centro de um quadro, com o tamanho dado (px) e deslocamento vertical opcional. */
const placed = (frame, size, dy = 0) => `<g transform="translate(${(frame - size) / 2} ${(frame - size) / 2 + dy}) scale(${size / 512})">${mark()}</g>`;

// ícone completo (usado pelo Android antigo e como base)
await sharp(svg(1024, 1024, `<rect width="1024" height="1024" fill="url(#bg)"/>${placed(1024, 640)}`)).png().toFile(`${out}icon-only.png`);
// ícone adaptativo: a marca precisa caber nos 66% centrais (o Android recorta círculo/quadrado/gota)
await sharp(svg(1024, 1024, placed(1024, 560))).png().toFile(`${out}icon-foreground.png`);
await sharp(svg(1024, 1024, `<rect width="1024" height="1024" fill="url(#bg)"/>`)).png().toFile(`${out}icon-background.png`);
// tela de abertura: marca e nome
const wordmark = `<text x="1366" y="1830" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="170" letter-spacing="6" fill="url(#gt)">DistribuiHub</text>`;
const splash = `<rect width="2732" height="2732" fill="url(#bg)"/><g transform="translate(${(2732 - 720) / 2} 640) scale(${720 / 512})">${mark()}</g>${wordmark}`;
await sharp(svg(2732, 2732, splash)).png().toFile(`${out}splash.png`);
await sharp(svg(2732, 2732, splash)).png().toFile(`${out}splash-dark.png`);
console.log('Ícones gerados em', out);
