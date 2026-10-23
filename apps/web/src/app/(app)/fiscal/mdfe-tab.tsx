'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { dateBr, formatAccessKey } from '@/lib/format';
import { useUi } from '@/components/ui';

interface Issue { severity: string; code: string; message: string }
interface Mdfe { id: string; routeId: string; routeNumber: number | null; status: string; environment: string; number: number | null; series: number | null; accessKey: string | null; protocol: string | null; statusCode: string | null; statusMessage: string | null; issues: Issue[]; weightKg: number | null; createdAt: string; vehicle: { plate: string } | null }
interface RouteOpt { id: string; number: number; routeDate: string; status: string; vehicle: string | null; driver: string; stops: number }
type Props = { act: (fn: () => Promise<unknown>, m: string, r: () => void) => Promise<void>; can: (p?: string) => boolean };

const LABEL: Record<string, string> = { DRAFT: 'Rascunho', TRANSMITTING: 'Transmitindo', PENDING_CONSULT: 'Consultar', AUTHORIZED: 'Em viagem (autorizado)', CLOSED: 'Encerrado', CANCELLED: 'Cancelado', REJECTED: 'Rejeitado' };
const tone = (s: string) => (['AUTHORIZED', 'CLOSED'].includes(s) ? 'ok' : ['REJECTED', 'PENDING_CONSULT', 'TRANSMITTING'].includes(s) ? 'warn' : '');

/** MDF-e rodoviário de carga própria: prepara a partir da viagem, transmite (SVRS), consulta, encerra e cancela. */
export function MdfeTab({ act, can }: Props) {
  const ui = useUi();
  const [rows, setRows] = useState<Mdfe[] | null>(null);
  const [routes, setRoutes] = useState<RouteOpt[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => {
    api<Mdfe[]>('/fiscal/mdfe').then(setRows).catch(() => setRows([]));
    api<RouteOpt[]>('/fiscal/mdfe/routes').then(setRoutes).catch(() => setRoutes([]));
  }, []);
  useEffect(load, [load]);
  const emit = can('fiscal.emit');

  async function downloadXml(m: Mdfe) {
    const r = await api<{ name: string; xml: string }>(`/fiscal/mdfe/${m.id}/xml`);
    const url = URL.createObjectURL(new Blob([r.xml], { type: 'application/xml' }));
    const a = document.createElement('a'); a.href = url; a.download = r.name; a.click(); URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="alert info">O MDF-e (manifesto de documentos fiscais) acompanha a carga que sai com <strong>NF-e</strong> e é obrigatório em muitos casos de transporte próprio entre estados: <strong>confirme com o seu contador se a sua operação exige</strong>. Aqui só o <strong>modal rodoviário, carga própria</strong> (o seu veículo e o seu motorista), com certificado A1 e emissão direta. <strong>Ainda não foi testado contra a SEFAZ real</strong>: comece pela homologação e encerre cada viagem depois da entrega.</div>
      {emit && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void act(async () => { const r = await api<{ id: string; ready: boolean }>('/fiscal/mdfe/prepare', 'POST', { routeId: f.get('route') }); setOpen(r.id); }, 'MDF-e preparado. Confira as pendências e transmita.', load); }}>
          <h2>Preparar MDF-e de uma viagem</h2>
          <div className="row">
            <select name="route" required aria-label="Viagem" style={{ maxWidth: 460 }}><option value="">Viagem…</option>{routes.map((r) => <option key={r.id} value={r.id}>#{r.number} — {dateBr(r.routeDate)} — {r.vehicle ?? 'sem veículo'} — {r.driver} ({r.stops} parada{r.stops === 1 ? '' : 's'})</option>)}</select>
            <button className="btn primary">Preparar</button>
          </div>
          <p className="muted" style={{ marginBottom: 0, fontSize: '0.82rem' }}>Usa o veículo e o motorista da viagem e as NF-e <strong>autorizadas</strong> dos pedidos. Falta tara/UF do veículo ou CPF do motorista? Complete em Frota e carga / Rotas e entregas.</p>
        </form>
      )}
      <section className="card">
        {!rows ? <p className="muted">Carregando…</p> : rows.length === 0 ? <p className="muted">Nenhum MDF-e ainda.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Viagem</th><th>Veículo</th><th>Número</th><th>Situação</th><th className="num">Peso</th><th /></tr></thead>
            <tbody>{rows.map((m) => (
              <>
                <tr key={m.id}>
                  <td>#{m.routeNumber ?? '—'}<div className="muted" style={{ fontSize: '0.78rem' }}>{dateBr(m.createdAt)}</div></td>
                  <td className="mono">{m.vehicle?.plate ?? '—'}</td>
                  <td>{m.number ? `${m.number}/${m.series}` : '—'}{m.accessKey && <div className="muted mono" style={{ fontSize: '0.72rem', wordBreak: 'break-all' }}>{formatAccessKey(m.accessKey)}</div>}</td>
                  <td><span className={`badge ${tone(m.status)}`}>{LABEL[m.status] ?? m.status}</span>{m.environment === 'HOMOLOGACAO' && <span className="badge" style={{ marginLeft: 4 }}>homologação</span>}{m.statusMessage && m.status !== 'AUTHORIZED' && <div className="muted" style={{ fontSize: '0.78rem' }}>{m.statusCode ? `${m.statusCode} — ` : ''}{m.statusMessage}</div>}</td>
                  <td className="num">{m.weightKg !== null ? `${m.weightKg} kg` : '—'}</td>
                  <td className="actions">
                    {m.status === 'DRAFT' && <button className="btn sm" onClick={() => setOpen(open === m.id ? null : m.id)}>Pendências</button>}
                    {emit && m.status === 'DRAFT' && <button className="btn sm primary" onClick={() => act(() => api(`/fiscal/mdfe/${m.id}/transmit`, 'POST'), 'MDF-e autorizado.', load)}>Transmitir</button>}
                    {emit && ['PENDING_CONSULT', 'TRANSMITTING', 'AUTHORIZED'].includes(m.status) && <button className="btn sm" onClick={() => act(() => api(`/fiscal/mdfe/${m.id}/consult`, 'POST'), 'Situação atualizada.', load)}>Consultar</button>}
                    {emit && m.status === 'AUTHORIZED' && <button className="btn sm" onClick={async () => { if (await ui.confirm({ title: 'Encerrar MDF-e', message: 'Confirma que a viagem terminou e a carga foi entregue? O encerramento não pode ser desfeito.', confirmLabel: 'Encerrar' })) void act(() => api(`/fiscal/mdfe/${m.id}/close`, 'POST'), 'MDF-e encerrado.', load); }}>Encerrar</button>}
                    {emit && m.status === 'AUTHORIZED' && <button className="btn sm" onClick={async () => { const r = await ui.prompt({ title: 'Cancelar MDF-e', label: 'Justificativa (15 a 255 caracteres)', multiline: true, confirmLabel: 'Cancelar MDF-e' }); if (r) void act(() => api(`/fiscal/mdfe/${m.id}/cancel`, 'POST', { reason: r }), 'MDF-e cancelado.', load); }}>Cancelar</button>}
                    {['AUTHORIZED', 'CLOSED', 'CANCELLED'].includes(m.status) && m.protocol && <button className="btn sm" onClick={() => void downloadXml(m)}>XML</button>}
                  </td>
                </tr>
                {open === m.id && (
                  <tr key={`${m.id}-i`}><td colSpan={6}>
                    {m.issues.length === 0 ? <span className="badge ok">Sem pendências</span> : <ul style={{ margin: '8px 0' }}>{m.issues.map((i, k) => <li key={k}><span className={`badge ${i.severity === 'BLOCKING' ? 'warn' : ''}`}>{i.severity === 'BLOCKING' ? 'impede' : 'info'}</span> {i.message}</li>)}</ul>}
                  </td></tr>
                )}
              </>
            ))}</tbody>
          </table></div>
        )}
      </section>
      <p className="muted" style={{ fontSize: '0.8rem' }}>Peso e valor vêm dos pedidos e das NF-e da viagem. Cancelamento: a SEFAZ define o prazo. Encerrar é obrigatório depois da entrega.</p>
    </>
  );
}
