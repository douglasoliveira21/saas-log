'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, useUi } from '@/components/ui';
import { api } from '@/lib/api';
import { dateBr } from '@/lib/format';

interface Ev { id: string; kind: string; tpEvento: string; seq: number; text: string | null; status: string; statusCode: string | null; protocol: string | null; message: string | null; createdAt: string }
const TITLE: Record<string, string> = { '110110': 'Carta de correção', '210200': 'Confirmação da operação', '210210': 'Ciência da operação', '210220': 'Desconhecimento da operação', '210240': 'Operação não realizada' };
const MANIFEST: [string, string][] = [['CIENCIA', 'Ciência da operação'], ['CONFIRMACAO', 'Confirmar operação'], ['DESCONHECIMENTO', 'Desconhecer operação'], ['NAO_REALIZADA', 'Operação não realizada']];

/** Eventos fiscais de uma nota: carta de correção (nota de saída autorizada) e manifestação do destinatário (nota recebida). */
export function EventsPanel({ kind, id, canAct, authorized55 }: { kind: 'outgoing' | 'inbound'; id: string; canAct: boolean; authorized55?: boolean }) {
  const ui = useUi();
  const [events, setEvents] = useState<Ev[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => { api<Ev[]>(`/fiscal/${kind}/${id}/events`).then(setEvents).catch(() => setEvents([])); }, [kind, id]);
  useEffect(() => { setError(''); load(); }, [load]);

  async function correct() {
    const text = await ui.prompt({
      title: 'Carta de correção (CC-e)', multiline: true, label: 'O que deve ser corrigido (15 a 1000 caracteres)', confirmLabel: 'Enviar à SEFAZ', cancelLabel: 'Voltar',
      message: 'A carta de correção NÃO pode alterar valores, quantidade, base de cálculo, alíquota, dados do remetente ou do destinatário, nem a data de emissão ou de saída. Serve para corrigir erros como endereço, transportador e informações complementares.',
    });
    if (!text) return;
    setError('');
    try { await api(`/fiscal/outgoing/${id}/correction`, 'POST', { text }); ui.toast.ok('Carta de correção registrada na SEFAZ.'); load(); } catch (e) { setError((e as Error).message); load(); }
  }
  async function manifest(action: string, label: string) {
    let justification: string | undefined;
    if (action === 'NAO_REALIZADA') {
      const j = await ui.prompt({ title: label, multiline: true, label: 'Justificativa (15 a 255 caracteres)', confirmLabel: 'Enviar', cancelLabel: 'Voltar' });
      if (!j) return;
      justification = j;
    } else if (!(await ui.confirm({ title: `${label}?`, message: 'A manifestação é enviada à SEFAZ (Ambiente Nacional) e não pode ser desfeita. Desconhecimento e operação não realizada travam o recebimento da mercadoria.', confirmLabel: 'Enviar', cancelLabel: 'Voltar', danger: action === 'DESCONHECIMENTO' }))) return;
    setError('');
    try { await api(`/fiscal/inbound/${id}/manifest`, 'POST', { action, justification }); ui.toast.ok('Manifestação registrada.'); load(); } catch (e) { setError((e as Error).message); load(); }
  }

  const showCorrect = kind === 'outgoing' && authorized55 && canAct;
  const showManifest = kind === 'inbound' && canAct;
  if (!showCorrect && !showManifest && !(events && events.length)) return null;
  return (
    <section aria-label="Eventos fiscais" style={{ marginTop: 12 }}>
      <h3 style={{ margin: '8px 0' }}>Eventos fiscais</h3>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="row" style={{ marginBottom: 8 }}>
        {showCorrect && <button className="btn" onClick={correct}>Carta de correção</button>}
        {showManifest && MANIFEST.map(([a, l]) => <button key={a} className="btn sm" onClick={() => manifest(a, l)}>{l}</button>)}
      </div>
      {events && events.length > 0 && (
        <div className="table-wrap"><table>
          <thead><tr><th>Evento</th><th>Data</th><th>Situação</th><th>Detalhe</th></tr></thead>
          <tbody>{events.map((e) => (
            <tr key={e.id}>
              <td>{TITLE[e.tpEvento] ?? e.tpEvento}{e.kind === 'CCE' ? ` nº ${e.seq}` : ''}</td><td>{dateBr(e.createdAt)}</td>
              <td><span className={`badge ${e.status === 'REGISTERED' ? 'ok' : 'danger'}`}>{e.status === 'REGISTERED' ? 'Registrado' : 'Recusado'}</span>{e.statusCode && <span className="muted" style={{ fontSize: '0.76rem' }}> cStat {e.statusCode}</span>}</td>
              <td className="muted" style={{ fontSize: '0.82rem' }}>{e.text ?? ''}{e.protocol ? ` · protocolo ${e.protocol}` : ''}{e.message ? ` · ${e.message}` : ''}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {showManifest && <p className="muted" style={{ fontSize: '0.8rem' }}>Exige a emissão direta na SEFAZ configurada (certificado A1) e o endereço do serviço do Ambiente Nacional informado pelo administrador do sistema.</p>}
    </section>
  );
}
