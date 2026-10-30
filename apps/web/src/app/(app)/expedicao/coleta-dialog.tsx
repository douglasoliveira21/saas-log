'use client';

import { CheckCircle2, Minus, Plus, ScanBarcode, XCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Dialog, Skeleton, useUi } from '@/components/ui';
import { api } from '@/lib/api';

interface CheckInfo { orderId: string; number: number; status: string; customer: string; items: { productId: string; sku: string; name: string; barcode: string | null; expected: number }[] }

const norm = (s: string) => s.trim().toLowerCase();

/** Janela flutuante da coleta: checklist dos produtos do pedido, marcados pelo leitor de código de barras (ou digitando o código/SKU) ou manualmente com +/−. */
export function ColetaDialog({ orderId, onClose, onDone }: { orderId: string; onClose: () => void; onDone: () => void }) {
  const ui = useUi();
  const [info, setInfo] = useState<CheckInfo | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [unknown, setUnknown] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<CheckInfo>(`/warehouse/check/${orderId}`).then((i) => { setInfo(i); setTimeout(() => input.current?.focus(), 50); }).catch((e) => setError(e.message));
  }, [orderId]);

  function scan(raw: string) {
    const c = norm(raw);
    if (!c || !info) return;
    const item = info.items.find((i) => (i.barcode && norm(i.barcode) === c) || norm(i.sku) === c);
    if (!item) { setUnknown((u) => [...u, raw.trim()]); setFlash({ ok: false, text: `Código ${raw.trim()} não pertence a este pedido.` }); return; }
    const next = (counts[item.productId] ?? 0) + 1;
    setCounts({ ...counts, [item.productId]: next });
    setFlash(next > item.expected ? { ok: false, text: `${item.name}: passou da quantidade (${next} de ${item.expected}).` } : { ok: true, text: `${item.name}: ${next} de ${item.expected}` });
  }
  function adjust(productId: string, delta: number) {
    setCounts((c) => ({ ...c, [productId]: Math.max(0, (c[productId] ?? 0) + delta) }));
  }

  const done = useMemo(() => !!info && info.items.every((i) => (counts[i.productId] ?? 0) === i.expected) && unknown.length === 0, [info, counts, unknown]);
  const collected = info ? info.items.filter((i) => (counts[i.productId] ?? 0) >= i.expected).length : 0;

  async function finish() {
    if (!info) return;
    setError(''); setSaving(true);
    try {
      const r = await api<{ status: string }>(`/warehouse/check/${info.orderId}`, 'POST', { items: info.items.map((i) => ({ productId: i.productId, counted: counts[i.productId] ?? 0 })), unknown });
      if (r.status === 'OK') ui.toast.ok('Coleta conferida sem divergência.'); else ui.toast.error('Coleta registrada com divergência.');
      onDone(); onClose();
    } catch (e) { setError((e as Error).message); }
    setSaving(false);
  }

  return (
    <Dialog wide title={info ? `Coleta — pedido #${info.number}` : 'Coleta'} description={info ? `${info.customer} · ${collected} de ${info.items.length} produtos coletados` : undefined} onClose={onClose}>
      <div className="modal-body">
        {error && <Alert kind="error">{error}</Alert>}
        {!info && !error && <Skeleton rows={3} />}
        {info && <>
          <label htmlFor="col-c"><ScanBarcode size={16} aria-hidden style={{ verticalAlign: '-3px' }} /> Leia o código de barras (ou digite o código/SKU e tecle Enter)</label>
          <input id="col-c" ref={input} value={code} autoComplete="off" inputMode="text" placeholder="Aponte o leitor aqui" onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); scan(code); setCode(''); } }} />
          {flash && <div className={`alert ${flash.ok ? 'ok' : 'error'}`} role="status" style={{ marginTop: 10 }}>{flash.ok ? <CheckCircle2 aria-hidden /> : <XCircle aria-hidden />}<div>{flash.text}</div></div>}
          <div className="table-wrap" style={{ marginTop: 12 }}><table>
            <thead><tr><th>Produto</th><th className="num">Coletado</th><th className="num">Pedido</th><th /></tr></thead>
            <tbody>{info.items.map((i) => {
              const n = counts[i.productId] ?? 0;
              return (
                <tr key={i.productId}>
                  <td><strong>{i.name}</strong><div className="muted mono" style={{ fontSize: '0.78rem' }}>{i.sku}{i.barcode ? ` · ${i.barcode}` : ' · sem código de barras (digite o SKU)'}</div></td>
                  <td className="num">
                    <div className="row" style={{ gap: 4, justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                      <button type="button" className="btn sm icon ghost" onClick={() => adjust(i.productId, -1)} disabled={n === 0} aria-label={`Tirar uma unidade de ${i.name}`}><Minus /></button>
                      <strong>{n}</strong>
                      <button type="button" className="btn sm icon ghost" onClick={() => adjust(i.productId, 1)} aria-label={`Marcar uma unidade de ${i.name}`}><Plus /></button>
                    </div>
                  </td>
                  <td className="num">{i.expected}</td>
                  <td><span className={`badge ${n === i.expected ? 'ok' : n > i.expected ? 'danger' : ''}`}>{n === i.expected ? 'Coletado' : n > i.expected ? `+${n - i.expected} a mais` : `faltam ${i.expected - n}`}</span></td>
                </tr>
              );
            })}</tbody>
          </table></div>
          {unknown.length > 0 && <Alert kind="error">Códigos lidos que não são deste pedido: {unknown.join(', ')}. Tire o item errado e recomece a coleta.</Alert>}
        </>}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn" onClick={() => { setCounts({}); setUnknown([]); setFlash(null); input.current?.focus(); }} disabled={!info}>Recomeçar</button>
        <button type="button" className="btn" onClick={onClose}>Fechar</button>
        <button type="button" className={`btn ${done ? 'primary' : ''}`} onClick={finish} disabled={!info || saving}>{done ? 'Concluir coleta' : 'Registrar com divergência'}</button>
      </div>
    </Dialog>
  );
}
