'use client';

import { CheckCircle2, CircleAlert, Eye, Send } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { MarketplaceLogo } from '@/components/marketplace-logo';
import { Dialog, EmptyState, useUi } from '@/components/ui';
import { api } from '@/lib/api';
import { brl } from '@/lib/format';

interface Channel {
  connectionId: string; label: string; provider: string; displayName: string; status: string; canPublish: boolean; publishingSupport: string;
  listing: { externalItemId: string | null; status: string; price: string | null; syncStatus: string | null; syncError: string | null } | null;
}
interface Preview {
  draft: { title: string; description: string; price: number; quantity: number; brand?: string; model?: string; gtin?: string; categoryId?: string; condition: string; warrantyMonths?: number; attributes: { name: string; value: string }[]; pictures: { url: string; width: number; height: number }[] };
  problems: string[]; warnings: string[]; canPublish: boolean;
}
const COND: Record<string, string> = { NEW: 'Novo', USED: 'Usado', REFURBISHED: 'Recondicionado' };
/** As URLs da pré-visualização são as públicas do canal; no navegador usamos só o caminho (mesma origem). */
const rel = (u: string) => { try { const x = new URL(u); return `${x.pathname}${x.search}`; } catch { return u; } };

export function Channels({ productId, manage, onChange }: { productId: string; manage: boolean; onChange: () => void }) {
  const ui = useUi();
  const [list, setList] = useState<Channel[] | null>(null);
  const [prev, setPrev] = useState<{ ch: Channel; data: Preview } | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(() => api<Channel[]>(`/products/${productId}/channels`).then(setList).catch((e) => ui.toast.error(e.message)), [productId, ui]);
  useEffect(() => { void load(); }, [load]);

  async function open(ch: Channel) {
    setBusy(ch.connectionId);
    try { setPrev({ ch, data: await api<Preview>(`/products/${productId}/channels/${ch.connectionId}/preview`, 'POST') }); } catch (e) { ui.toast.error((e as Error).message); } finally { setBusy(''); }
  }
  async function publish() {
    if (!prev) return;
    setBusy('publish');
    try {
      const r = await api<{ externalItemId: string }>(`/products/${productId}/channels/${prev.ch.connectionId}/publish`, 'POST');
      ui.toast.ok(`Publicado em ${prev.ch.displayName} (anúncio ${r.externalItemId}).`);
      setPrev(null); await load(); onChange();
    } catch (e) {
      ui.toast.error((e as Error).message);
      await load();
    } finally { setBusy(''); }
  }

  if (!list) return <div className="skeleton" style={{ height: 80 }} />;
  if (!list.length) return <EmptyState title="Nenhum canal conectado">Conecte um marketplace para publicar este produto. <Link href="/integracoes">Ir para Marketplaces</Link></EmptyState>;

  return (
    <>
      <div className="stack" style={{ gap: 10 }}>
        {list.map((c) => {
          const l = c.listing;
          return (
            <div key={c.connectionId} className="channel-row">
              <MarketplaceLogo provider={c.provider} name={c.displayName} size={40} />
              <div style={{ flex: 1, minWidth: 180 }}>
                <strong>{c.label}</strong> <span className="muted">· {c.displayName}</span>
                <div style={{ marginTop: 2 }}>
                  {l?.externalItemId ? <span className="badge ok dot">Publicado · {l.externalItemId}</span>
                    : l?.syncStatus === 'ERROR' ? <span className="badge danger">Erro ao publicar</span>
                    : l?.syncStatus === 'PUBLISHING' ? <span className="badge warn">Publicando…</span>
                    : <span className="badge">Não publicado</span>}
                  {l?.price && <span className="muted" style={{ marginLeft: 8, fontSize: '0.82rem' }}>preço {brl(l.price)}</span>}
                  {c.status !== 'ACTIVE' && <span className="badge warn" style={{ marginLeft: 6 }}>conexão {c.status === 'PAUSED' ? 'pausada' : 'não ativa'}</span>}
                </div>
                {l?.syncError && <div className="hint" style={{ color: 'var(--danger)', fontSize: '0.8rem', marginTop: 4 }}>{l.syncError}</div>}
                {!c.canPublish && <div className="muted" style={{ fontSize: '0.8rem', marginTop: 4 }}>Publicação por aqui ainda não está disponível neste canal ({c.publishingSupport === 'UNSUPPORTED' ? 'não suportada' : 'planejada'}).</div>}
              </div>
              <div className="row">
                <button className="btn sm" onClick={() => open(c)} disabled={busy === c.connectionId}><Eye aria-hidden />Pré-visualizar anúncio</button>
              </div>
            </div>
          );
        })}
      </div>

      {prev && (
        <Dialog wide onClose={() => setPrev(null)} title={`Anúncio em ${prev.ch.displayName}`} description="Veja exatamente o que será enviado. Nada é publicado até você confirmar.">
          <div className="modal-body">
            {prev.data.problems.length > 0 && (
              <div className="alert error"><CircleAlert aria-hidden /><div><strong>Falta resolver antes de publicar:</strong><ul style={{ margin: '6px 0 0' }}>{prev.data.problems.map((p) => <li key={p}>{p}</li>)}</ul></div></div>
            )}
            {prev.data.warnings.length > 0 && (
              <div className="alert warn"><CircleAlert aria-hidden /><div><strong>Atenção:</strong><ul style={{ margin: '6px 0 0' }}>{prev.data.warnings.map((p) => <li key={p}>{p}</li>)}</ul></div></div>
            )}
            <div className="preview-grid">
              <div className="preview-pics">
                {prev.data.draft.pictures.length === 0 && <div className="muted">Sem fotos.</div>}
                {prev.data.draft.pictures.map((p, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={p.url} src={rel(p.url)} alt={`Foto ${i + 1}`} className={i === 0 ? 'main' : ''} />
                ))}
              </div>
              <div>
                <h3 style={{ margin: '0 0 4px' }}>{prev.data.draft.title}</h3>
                <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>{brl(prev.data.draft.price)}</div>
                <div className="meta" style={{ margin: '6px 0 10px' }}>
                  <span><b>Estoque publicável:</b> {prev.data.draft.quantity}</span>
                  <span><b>Condição:</b> {COND[prev.data.draft.condition] ?? prev.data.draft.condition}</span>
                  {prev.data.draft.brand && <span><b>Marca:</b> {prev.data.draft.brand}</span>}
                  {prev.data.draft.model && <span><b>Modelo:</b> {prev.data.draft.model}</span>}
                  {prev.data.draft.gtin && <span><b>GTIN:</b> {prev.data.draft.gtin}</span>}
                  {prev.data.draft.warrantyMonths ? <span><b>Garantia:</b> {prev.data.draft.warrantyMonths} meses</span> : null}
                  <span><b>Categoria do canal:</b> {prev.data.draft.categoryId ?? <em>não mapeada</em>}</span>
                </div>
                {prev.data.draft.attributes.length > 0 && (
                  <div style={{ marginBottom: 10 }}><strong style={{ fontSize: '0.85rem' }}>Ficha técnica</strong><ul style={{ margin: '4px 0 0', paddingLeft: '1.1rem', fontSize: '0.88rem' }}>{prev.data.draft.attributes.map((a) => <li key={a.name}>{a.name}: {a.value}</li>)}</ul></div>
                )}
                <div><strong style={{ fontSize: '0.85rem' }}>Descrição</strong><p className="muted" style={{ whiteSpace: 'pre-wrap', marginTop: 4, maxHeight: 160, overflow: 'auto' }}>{prev.data.draft.description || '—'}</p></div>
              </div>
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn" onClick={() => setPrev(null)}>Fechar</button>
            {manage && (
              <button className={`btn primary ${busy === 'publish' ? 'loading' : ''}`} disabled={!prev.data.canPublish || busy === 'publish'} onClick={publish}><Send aria-hidden />Publicar em {prev.ch.displayName}</button>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}

export function QualityPanel({ productId, refreshKey }: { productId: string; refreshKey: number }) {
  const [q, setQ] = useState<{ score: number; ready: boolean; items: { key: string; label: string; ok: boolean; level: 'required' | 'recommended'; hint: string }[] } | null>(null);
  useEffect(() => { api<NonNullable<typeof q>>(`/products/${productId}/quality`).then(setQ).catch(() => setQ(null)); }, [productId, refreshKey]);
  if (!q) return <div className="card"><div className="skeleton" style={{ height: 140 }} /></div>;
  const tone = q.score >= 80 ? 'var(--ok)' : q.score >= 50 ? 'var(--warn)' : 'var(--danger)';
  const group = (level: 'required' | 'recommended', title: string) => (
    <div style={{ marginTop: 12 }}>
      <div className="level-title" style={{ marginBottom: 6 }}>{title}</div>
      <ul className="quality-list">
        {q.items.filter((i) => i.level === level).map((i) => (
          <li key={i.key} className={i.ok ? 'ok' : 'bad'}>
            {i.ok ? <CheckCircle2 size={16} aria-label="ok" /> : <CircleAlert size={16} aria-label="pendente" />}
            <div><span>{i.label}</span>{!i.ok && <div className="muted" style={{ fontSize: '0.78rem' }}>{i.hint}</div>}</div>
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <div className="card quality">
      <div className="row" style={{ gap: 14, flexWrap: 'nowrap' }}>
        <div className="ring" style={{ background: `conic-gradient(${tone} ${q.score * 3.6}deg, var(--surface-3) 0)` }} role="img" aria-label={`Qualidade do cadastro: ${q.score}%`}><span>{q.score}%</span></div>
        <div>
          <strong>Qualidade do cadastro</strong>
          <div className="muted" style={{ fontSize: '0.82rem' }}>{q.ready ? 'Pronto para anunciar' : 'Faltam itens obrigatórios para anunciar'}</div>
        </div>
      </div>
      {group('required', 'Obrigatórios para anunciar')}
      {group('recommended', 'Recomendados')}
      <p className="muted" style={{ fontSize: '0.74rem', margin: '12px 0 0' }}>Exigências comuns aos grandes marketplaces. Cada canal pode pedir mais: veja a pré-visualização do anúncio.</p>
    </div>
  );
}
