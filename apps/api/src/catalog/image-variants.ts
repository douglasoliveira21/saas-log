import sharp from 'sharp';

/**
 * Versões leves das fotos para as telas do sistema: WebP (ou AVIF) redimensionado.
 * O original continua intacto no banco (e é o que vai para os marketplaces).
 * Cache em memória (LRU simples) para não reprocessar a mesma foto a cada abertura de tela.
 */
const MAX_ENTRIES = 300;
const MAX_BYTES = 64 * 1024 * 1024;
const cache = new Map<string, { content: Buffer; contentType: string }>();
let bytes = 0;

export type VariantFormat = 'webp' | 'avif';

/** Escolhe o melhor formato aceito pelo navegador (cabeçalho Accept). */
export function pickFormat(accept: string | undefined): VariantFormat | null {
  if (!accept) return null;
  if (/image\/webp/.test(accept)) return 'webp';
  return null;
}

export function clampWidth(w: unknown): number | null {
  const n = Number(w);
  if (!Number.isFinite(n) || n < 16) return null;
  return Math.min(Math.round(n), 1600);
}

export async function imageVariant(id: string, source: Buffer, width: number, format: VariantFormat): Promise<{ content: Buffer; contentType: string } | null> {
  const key = `${id}:${width}:${format}`;
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit; }
  try {
    const pipeline = sharp(source, { failOn: 'none' }).rotate().resize({ width, withoutEnlargement: true });
    const content = await (format === 'avif' ? pipeline.avif({ quality: 55 }) : pipeline.webp({ quality: 78 })).toBuffer();
    // se ficou maior que o original, não vale a pena
    if (content.length >= source.length) return null;
    const v = { content, contentType: `image/${format}` };
    cache.set(key, v); bytes += content.length;
    while (cache.size > MAX_ENTRIES || bytes > MAX_BYTES) {
      const first = cache.keys().next().value as string | undefined;
      if (!first) break;
      bytes -= cache.get(first)!.content.length; cache.delete(first);
    }
    return v;
  } catch {
    return null; // formato que o sharp não lê: serve o original
  }
}
