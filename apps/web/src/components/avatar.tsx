'use client';

import { useState } from 'react';

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('');

/** Foto de perfil redonda; sem foto (ou se não carregar) mostra as iniciais. `version` força recarregar depois de trocar a foto. */
export function Avatar({ name, userId, self = false, version, size = 30 }: { name: string; userId?: string; self?: boolean; version?: number | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  const src = self ? `/api/auth/avatar?v=${version ?? 0}` : userId ? `/api/auth/avatar/${userId}` : null;
  const hasPhoto = !failed && !!src && (self ? !!version : true);
  const style = { width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.38)) } as const;
  return hasPhoto ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="avatar" src={src!} alt="" aria-hidden style={{ ...style, objectFit: 'cover' }} onError={() => setFailed(true)} />
  ) : (
    <span className="avatar" aria-hidden style={style}>{initials(name)}</span>
  );
}

/** Reduz e recorta a imagem escolhida para um quadrado (padrão 256 px) e devolve JPEG em base64, sem o prefixo data:. */
export async function squareJpegBase64(file: File, side = 256): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error('Não foi possível ler esta imagem.')); i.src = url; });
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas'); canvas.width = side; canvas.height = side;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, side, side);
    ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, side, side);
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
  } finally { URL.revokeObjectURL(url); }
}
