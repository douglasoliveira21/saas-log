'use client';

import { Camera, CheckCircle2, MapPin, Navigation, Phone, TriangleAlert, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Dialog, EmptyState, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { stopMapUrl } from '@/lib/maps';
import { dateBr } from '@/lib/format';

interface Stop {
  id: string; sequence: number; status: 'PENDING' | 'DELIVERED' | 'FAILED' | 'CANCELLED'; customerName: string; customerPhone: string | null; address: string;
  deliveredAt: string | null; receiverName: string | null; failureReason: string | null; hasProof: boolean;
}
interface MyRoute { id: string; number: number; routeDate: string; status: string; notes: string | null; totals: { stops: number; pending: number; delivered: number; failed: number; cancelled: number }; stops: Stop[] }

const FAIL_REASONS = ['Cliente ausente', 'Endereço não encontrado', 'Recusou o recebimento', 'Estabelecimento fechado', 'Outro motivo'];
const MAX_SIDE = 1600;
const MAX_BYTES = 3_600_000;

/** Reduz a foto no celular (lado maior 1600 px, JPEG) para o envio ser rápido em rede móvel. O servidor confere de novo pelos bytes. */
async function prepare(file: File): Promise<{ base64: string; preview: string; w: number; h: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Não foi possível ler a foto. Tente tirar novamente.')); i.src = url; });
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    if (Math.min(c.width, c.height) < 480) throw new Error('A foto ficou pequena demais. Aproxime-se e fotografe o canhoto inteiro, com boa luz.');
    let blob: Blob | null = null;
    for (const q of [0.85, 0.7, 0.55]) {
      blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', q));
      if (blob && blob.size <= MAX_BYTES) break;
    }
    if (!blob || blob.size > MAX_BYTES) throw new Error('A foto ficou muito grande. Tente novamente.');
    const preview = c.toDataURL('image/jpeg', 0.5);
    const base64 = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.onerror = () => rej(new Error('Falha ao preparar a foto.')); r.readAsDataURL(blob!); });
    return { base64, preview, w: c.width, h: c.height };
  } finally { URL.revokeObjectURL(url); }
}

/** Posição do aparelho (opcional: se negar ou demorar, a entrega segue sem ela). */
function position(): Promise<{ lat: number; lng: number; accuracyM: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((res) => navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy }), () => res(null), { enableHighAccuracy: true, timeout: 6000, maximumAge: 60_000 }));
}

function PhotoPicker({ label, required, value, onChange }: { label: string; required?: boolean; value: { base64: string; preview: string } | null; onChange: (v: { base64: string; preview: string } | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function pick(f: File | undefined) {
    if (!f) return;
    setErr(''); setBusy(true);
    try { onChange(await prepare(f)); } catch (e) { onChange(null); setErr((e as Error).message); }
    setBusy(false); if (input.current) input.current.value = '';
  }
  return (
    <div className="photo-pick">
      <label>{label}{required && ' *'}</label>
      {value ? (
        <div className="photo-pick-prev">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={value.preview} alt="Pré-visualização da foto" />
          <button type="button" className="btn sm" onClick={() => input.current?.click()}>Tirar outra</button>
        </div>
      ) : (
        <button type="button" className={`photo-pick-btn ${busy ? 'loading' : ''}`} onClick={() => input.current?.click()} disabled={busy}><Camera aria-hidden /><span>{busy ? 'Preparando…' : 'Tirar foto'}</span></button>
      )}
      <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void pick(e.target.files?.[0])} aria-label={label} />
      {err && <div className="alert error" role="alert" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  );
}

function DeliverDialog({ stop, onClose, onDone }: { stop: Stop; onClose: () => void; onDone: () => void }) {
  const [photo, setPhoto] = useState<{ base64: string; preview: string } | null>(null);
  const [name, setName] = useState('');
  const [doc, setDoc] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const can = !!photo && name.trim().length >= 2 && !busy;

  async function send() {
    setBusy(true); setError('');
    const geo = await position();
    try {
      await api(`/delivery/my/stops/${stop.id}/deliver`, 'POST', { receiverName: name.trim(), receiverDocument: doc.trim() || undefined, notes: notes.trim() || undefined, photo: { contentBase64: photo!.base64 }, ...(geo ?? {}) });
      onDone();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  return (
    <Dialog title="Confirmar entrega" description={<>{stop.customerName} · {stop.address}</>} onClose={onClose}>
      <div className="modal-body">
        {error && <div className="alert error" role="alert">{error}</div>}
        <PhotoPicker label="Foto do canhoto assinado" required value={photo} onChange={setPhoto} />
        <div style={{ marginTop: 12 }}><label htmlFor="rn">Nome de quem recebeu *</label><input id="rn" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" maxLength={120} /></div>
        <div style={{ marginTop: 12 }}><label htmlFor="rdoc">Documento (CPF/RG) — opcional</label><input id="rdoc" value={doc} onChange={(e) => setDoc(e.target.value)} maxLength={30} inputMode="numeric" /></div>
        <div style={{ marginTop: 12 }}><label htmlFor="rnotes">Observação — opcional</label><input id="rnotes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} placeholder="Ex.: deixado na portaria" /></div>
        {!photo && <p className="muted" style={{ fontSize: '0.84rem', marginBottom: 0 }}>Sem a foto do canhoto não é possível confirmar a entrega.</p>}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose} disabled={busy}>Voltar</button>
        <button className={`btn primary ${busy ? 'loading' : ''}`} disabled={!can} onClick={send}><CheckCircle2 aria-hidden />Confirmar entrega</button>
      </div>
    </Dialog>
  );
}

function FailDialog({ stop, onClose, onDone }: { stop: Stop; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState(FAIL_REASONS[0]);
  const [detail, setDetail] = useState('');
  const [photo, setPhoto] = useState<{ base64: string; preview: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const text = reason === 'Outro motivo' ? detail.trim() : [reason, detail.trim()].filter(Boolean).join(' — ');
  const can = text.length >= 3 && !busy;

  async function send() {
    setBusy(true); setError('');
    const geo = await position();
    try {
      await api(`/delivery/my/stops/${stop.id}/fail`, 'POST', { reason: text, ...(photo ? { photo: { contentBase64: photo.base64 } } : {}), ...(geo ?? {}) });
      onDone();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }

  return (
    <Dialog title="Não consegui entregar" description={<>{stop.customerName} · {stop.address}</>} onClose={onClose}>
      <div className="modal-body">
        {error && <div className="alert error" role="alert">{error}</div>}
        <label htmlFor="fr">Motivo *</label>
        <select id="fr" value={reason} onChange={(e) => setReason(e.target.value)}>{FAIL_REASONS.map((r) => <option key={r}>{r}</option>)}</select>
        <div style={{ marginTop: 12 }}><label htmlFor="fd">{reason === 'Outro motivo' ? 'Descreva o motivo *' : 'Detalhes — opcional'}</label><input id="fd" value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={200} /></div>
        <div style={{ marginTop: 12 }}><PhotoPicker label="Foto da ocorrência (opcional)" value={photo} onChange={setPhoto} /></div>
        <p className="muted" style={{ fontSize: '0.84rem', marginBottom: 0 }}>O pedido continua em trânsito e o despachante poderá colocá-lo em uma nova rota.</p>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose} disabled={busy}>Voltar</button>
        <button className={`btn danger ${busy ? 'loading' : ''}`} disabled={!can} onClick={send}><XCircle aria-hidden />Registrar</button>
      </div>
    </Dialog>
  );
}

export default function MotoristaPage() {
  const [routes, setRoutes] = useState<MyRoute[] | null>(null);
  const [sel, setSel] = useState<string>('');
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [dlg, setDlg] = useState<{ kind: 'deliver' | 'fail'; stop: Stop } | null>(null);

  const load = useCallback(() => api<MyRoute[]>('/delivery/my/routes').then((r) => { setRoutes(r); setSel((cur) => (cur && r.some((x) => x.id === cur) ? cur : (r.find((x) => x.status === 'IN_PROGRESS') ?? r[0])?.id ?? '')); }).catch((e) => setError(e.message)), []);
  useEffect(() => { void load(); }, [load]);

  const route = routes?.find((r) => r.id === sel);
  const total = route ? route.totals.stops - route.totals.cancelled : 0;
  const done = route ? route.totals.delivered + route.totals.failed : 0;
  const started = route?.status === 'IN_PROGRESS';

  return (
    <>
      <PageHeader title="Minhas entregas" description="Confirme cada entrega com a foto do canhoto assinado." />
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}
      {routes && routes.length === 0 && <EmptyState icon={<Navigation size={22} />} title="Nenhuma rota para você agora">Quando o despachante criar uma rota para você, ela aparece aqui.</EmptyState>}

      {routes && routes.length > 1 && (
        <div className="tabs" role="tablist" aria-label="Minhas rotas">
          {routes.map((r) => <button key={r.id} role="tab" aria-selected={sel === r.id} className={`tab ${sel === r.id ? 'active' : ''}`} onClick={() => setSel(r.id)}>Rota #{r.number} · {dateBr(r.routeDate)}</button>)}
        </div>
      )}

      {route && (
        <div className="stack">
          <section className="card">
            <div className="card-head"><h2>Rota #{route.number} · {dateBr(route.routeDate)}</h2><span className={`badge ${route.status === 'IN_PROGRESS' ? 'brand' : route.status === 'COMPLETED' ? 'ok' : ''}`}>{route.status === 'IN_PROGRESS' ? 'Em andamento' : route.status === 'COMPLETED' ? 'Concluída' : 'Aguardando saída'}</span></div>
            <div className="progress" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={total} aria-label="Progresso da rota" style={{ marginBottom: 6 }}><span style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>
            <div className="muted">{route.totals.delivered} entregue(s), {route.totals.failed} não entregue(s), {route.totals.pending} pendente(s).{route.notes ? ` ${route.notes}` : ''}</div>
            {route.status === 'PLANNED' && <div className="alert warn" role="status" style={{ marginTop: 10 }}><TriangleAlert aria-hidden /><div>O despachante ainda não iniciou esta rota. Você poderá confirmar as entregas assim que ela for iniciada.</div></div>}
          </section>

          {route.stops.filter((s) => s.status !== 'CANCELLED').map((s) => {
            const nav = stopMapUrl(s.address);
            return (
              <article key={s.id} className={`card stop-card ${s.status.toLowerCase()}`} aria-label={`Parada ${s.sequence}`}>
                <div className="stop-head">
                  <span className="stop-n" aria-hidden>{s.sequence}</span>
                  <div style={{ minWidth: 0 }}>
                    <strong>{s.customerName}</strong>
                    <div className="muted" style={{ fontSize: '0.9rem' }}><MapPin size={13} aria-hidden style={{ verticalAlign: '-2px' }} /> {s.address}</div>
                  </div>
                  {s.status === 'DELIVERED' && <span className="badge ok">Entregue</span>}
                  {s.status === 'FAILED' && <span className="badge danger">Não entregue</span>}
                </div>
                {s.status === 'DELIVERED' && <div className="muted" style={{ fontSize: '0.84rem' }}>Recebido por {s.receiverName} · {s.deliveredAt ? new Date(s.deliveredAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ''}</div>}
                {s.status === 'FAILED' && <div className="muted" style={{ fontSize: '0.84rem' }}>{s.failureReason}</div>}
                <div className="stop-actions">
                  {nav && s.status === 'PENDING' && <a className="btn" href={nav} target="_blank" rel="noreferrer"><Navigation aria-hidden />Navegar</a>}
                  {s.customerPhone && s.status === 'PENDING' && <a className="btn" href={`tel:${s.customerPhone}`}><Phone aria-hidden />Ligar</a>}
                  {s.status === 'PENDING' && <>
                    <button className="btn primary" disabled={!started} onClick={() => setDlg({ kind: 'deliver', stop: s })}><Camera aria-hidden />Entreguei</button>
                    <button className="btn" disabled={!started} onClick={() => setDlg({ kind: 'fail', stop: s })}>Não consegui</button>
                  </>}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {dlg?.kind === 'deliver' && <DeliverDialog stop={dlg.stop} onClose={() => setDlg(null)} onDone={() => { setDlg(null); setOk('Entrega confirmada com o canhoto.'); void load(); }} />}
      {dlg?.kind === 'fail' && <FailDialog stop={dlg.stop} onClose={() => setDlg(null)} onDone={() => { setDlg(null); setOk('Ocorrência registrada.'); void load(); }} />}
    </>
  );
}
