'use client';

import { ArrowLeft, ArrowRight, ImagePlus, Star, Trash2, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { EmptyState, useUi } from '@/components/ui';
import { api } from '@/lib/api';

interface Img { id: string; position: number; width: number; height: number; bytes: number; alt: string | null; main: boolean; sourceUrl: string | null }
const MAX = 12;
const MIN_PX = 500;
const kb = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

/** Prepara a foto no navegador: lado máximo 2000 px e até ~2,9 MB (PNG grande vira JPEG com fundo branco). Pequenas seguem como estão. */
async function prepare(file: File): Promise<{ contentType: string; base64: string }> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error(`${file.name}: use PNG, JPG ou WebP (SVG não é aceito).`);
  const toB64 = (b: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.onerror = () => rej(new Error('Não foi possível ler o arquivo.')); r.readAsDataURL(b); });
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error(`${file.name}: imagem inválida ou corrompida.`)); i.src = url; });
    const max = Math.max(img.naturalWidth, img.naturalHeight);
    if (max <= 2000 && file.size <= 2_900_000) return { contentType: file.type, base64: await toB64(file) };
    const scale = Math.min(1, 2000 / max);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * scale)); c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const g = c.getContext('2d')!;
    const blobOf = (type: string) => new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Falha ao reduzir a imagem.'))), type, 0.9));
    g.drawImage(img, 0, 0, c.width, c.height);
    let blob = file.type === 'image/jpeg' ? await blobOf('image/jpeg') : await blobOf('image/png');
    if (blob.size > 2_900_000) { g.globalCompositeOperation = 'destination-over'; g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); blob = await blobOf('image/jpeg'); }
    if (blob.size > 2_900_000) throw new Error(`${file.name}: mesmo reduzida, a imagem passa de 3 MB.`);
    return { contentType: blob.type, base64: await toB64(blob) };
  } finally { URL.revokeObjectURL(url); }
}

export function Photos({ productId, manage, onChange }: { productId: string; manage: boolean; onChange: () => void }) {
  const ui = useUi();
  const [imgs, setImgs] = useState<Img[] | null>(null);
  const [busy, setBusy] = useState('');
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(() => api<Img[]>(`/products/${productId}/images`).then(setImgs).catch((e) => ui.toast.error(e.message)), [productId, ui]);
  useEffect(() => { void load(); }, [load]);

  async function upload(files: FileList | File[]) {
    const list = [...files];
    if (!list.length) return;
    const room = MAX - (imgs?.length ?? 0);
    if (list.length > room) ui.toast.info(`Cabem mais ${room} foto(s) (limite de ${MAX}); as demais foram ignoradas.`);
    let sent = 0;
    for (const [i, f] of list.slice(0, Math.max(room, 0)).entries()) {
      setBusy(`Enviando ${i + 1} de ${Math.min(list.length, room)}…`);
      try {
        const { contentType, base64 } = await prepare(f);
        await api(`/products/${productId}/images`, 'POST', { contentType, contentBase64: base64 });
        sent++;
      } catch (e) { ui.toast.error((e as Error).message); }
    }
    setBusy(''); if (input.current) input.current.value = '';
    if (sent) { ui.toast.ok(`${sent} foto(s) adicionada(s).`); await load(); onChange(); }
  }

  async function move(i: number, to: number) {
    if (!imgs || to < 0 || to >= imgs.length) return;
    const ids = imgs.map((x) => x.id);
    [ids[i], ids[to]] = [ids[to], ids[i]];
    try { await api(`/products/${productId}/images/order`, 'PUT', { ids }); await load(); onChange(); } catch (e) { ui.toast.error((e as Error).message); }
  }
  async function makeMain(i: number) {
    if (!imgs || i === 0) return;
    const ids = [imgs[i].id, ...imgs.filter((_, k) => k !== i).map((x) => x.id)];
    try { await api(`/products/${productId}/images/order`, 'PUT', { ids }); await load(); onChange(); } catch (e) { ui.toast.error((e as Error).message); }
  }
  async function remove(im: Img) {
    if (!(await ui.confirm({ title: 'Remover esta foto?', message: im.main ? 'É a foto principal: a próxima da fila passa a ser a principal.' : undefined, danger: true, confirmLabel: 'Remover', cancelLabel: 'Voltar' }))) return;
    try { await api(`/products/${productId}/images/${im.id}`, 'DELETE'); await load(); onChange(); } catch (e) { ui.toast.error((e as Error).message); }
  }
  async function alt(im: Img) {
    const v = await ui.prompt({ title: 'Texto alternativo da foto', label: 'Descreva a imagem (acessibilidade e busca)', defaultValue: im.alt ?? '', required: false, confirmLabel: 'Salvar' });
    if (v === null) return;
    try { await api(`/products/${productId}/images/${im.id}`, 'PATCH', { alt: v || null }); await load(); } catch (e) { ui.toast.error((e as Error).message); }
  }

  return (
    <div>
      <p className="muted" style={{ marginTop: 0 }}>Estas são as fotos que vão para o anúncio. A <strong>primeira é a principal</strong> (fundo branco, produto centralizado e com 1000 px ou mais é o ideal). Mínimo de {MIN_PX} × {MIN_PX} px; PNG, JPG ou WebP.</p>
      {manage && (
        <div
          className={`dropzone ${drag ? 'over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); void upload(e.dataTransfer.files); }}
        >
          <ImagePlus aria-hidden />
          <div>
            <strong>{busy || 'Arraste as fotos aqui'}</strong>
            <div className="muted" style={{ fontSize: '0.82rem' }}>ou <button type="button" className="linklike" onClick={() => input.current?.click()} disabled={!!busy || (imgs?.length ?? 0) >= MAX}>escolha os arquivos</button> · {imgs?.length ?? 0}/{MAX} fotos · reduzimos automaticamente as muito grandes</div>
          </div>
          <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => { e.stopPropagation(); if (e.target.files) void upload(e.target.files); }} aria-label="Selecionar fotos" />
        </div>
      )}
      {imgs && imgs.length === 0 && <EmptyState title="Nenhuma foto ainda">{manage ? 'Sem foto o anúncio não é aceito pelos marketplaces.' : 'Este produto ainda não tem fotos.'}</EmptyState>}
      <div className="photo-grid">
        {imgs?.map((im, i) => (
          <figure key={im.id} className={`photo ${im.main ? 'main' : ''}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/api/products/${productId}/images/${im.id}/file`} alt={im.alt ?? `Foto ${i + 1}`} loading="lazy" />
            <figcaption>
              <span>{im.main ? <span className="badge brand"><Star size={11} aria-hidden />Principal</span> : `Foto ${i + 1}`}</span>
              <span className="muted">{im.width}×{im.height} · {kb(im.bytes)}</span>
              {Math.min(im.width, im.height) < MIN_PX && <span className="badge warn"><TriangleAlert size={11} aria-hidden />abaixo de {MIN_PX}px</span>}
            </figcaption>
            {manage && (
              <div className="photo-actions">
                <button type="button" className="btn sm icon ghost" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label="Mover para trás" title="Mover para trás"><ArrowLeft /></button>
                <button type="button" className="btn sm icon ghost" onClick={() => move(i, i + 1)} disabled={i === imgs.length - 1} aria-label="Mover para frente" title="Mover para frente"><ArrowRight /></button>
                {!im.main && <button type="button" className="btn sm ghost" onClick={() => makeMain(i)}><Star aria-hidden />Principal</button>}
                <button type="button" className="btn sm ghost" onClick={() => alt(im)}>Texto alt.</button>
                <button type="button" className="btn sm icon ghost" onClick={() => remove(im)} aria-label="Remover foto" title="Remover"><Trash2 /></button>
              </div>
            )}
          </figure>
        ))}
      </div>
    </div>
  );
}
