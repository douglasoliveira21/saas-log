'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Alert, PageHeader, useUi } from '@/components/ui';

interface Rule { type: string; emailEnabled: boolean; whatsappEnabled: boolean; daysBefore: number; minOverdueDays: number; repeatEveryDays: number; orderStatuses: string[]; subject: string | null; body: string | null; defaultSubject: string; defaultBody: string; variables: string[] }
interface RulesRes { emailAvailable: boolean; whatsappAvailable: boolean; rules: Rule[] }
interface Wa { configured: boolean; status: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED'; phone: string | null; lastError: string | null; wantConnected?: boolean; reconnectAttempts?: number; lastCheckedAt?: string | null }
interface QrRes { qr: string; expiresInSeconds: number }
const MAX_QR_CYCLES = 8; // ~6 minutos tentando; depois espera o clique (evita gerar QR sem ninguém olhando)
interface LogRow { id: string; type: string; channel: string; recipient: string; subject: string | null; status: string; error: string | null; attempts: number; createdAt: string; sentAt: string | null }
interface Logs { counts: Record<string, number>; items: LogRow[] }

const TITLE: Record<string, string> = { INVOICE_DUE: 'Lembrete de vencimento', ORDER_STATUS: 'Status do pedido', COLLECTION: 'Cobrança de títulos vencidos' };
const HELP: Record<string, string> = {
  INVOICE_DUE: 'Avisa o cliente alguns dias antes do vencimento dos títulos a receber em aberto (um aviso por cliente e dia).',
  ORDER_STATUS: 'Avisa o cliente quando o pedido muda para os status escolhidos. Pedidos de marketplace não entram (quem avisa é o marketplace).',
  COLLECTION: 'Avisa o cliente sobre títulos vencidos, em tom neutro, repetindo no intervalo escolhido até o pagamento. Revise o texto com o seu financeiro.',
};
const STATUSES: [string, string][] = [['CONFIRMED', 'Confirmado'], ['PICKING', 'Em separação'], ['PACKED', 'Embalado'], ['SHIPPED', 'Enviado'], ['DELIVERED', 'Entregue'], ['CANCELLED', 'Cancelado']];
const LOGSTATUS: Record<string, string> = { QUEUED: 'Na fila', SENT: 'Enviado', FAILED: 'Falhou', SKIPPED: 'Não enviado' };

export default function AvisosPage() {
  const ui = useUi();
  const [res, setRes] = useState<RulesRes | null>(null);
  const [wa, setWa] = useState<Wa | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [qrEnds, setQrEnds] = useState(0); // instante (ms) em que este QR deixa de valer
  const [qrTotal, setQrTotal] = useState(45);
  const [cycle, setCycle] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [expired, setExpired] = useState(false);
  const renewing = useRef(false);
  const [logs, setLogs] = useState<Logs | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(() => {
    api<RulesRes>('/notifications/rules').then(setRes).catch((e) => setError(e.message));
    api<Logs>('/notifications/logs').then(setLogs).catch(() => undefined);
  }, []);
  const loadWa = useCallback(() => api<Wa>('/notifications/whatsapp').then((w) => { setWa(w); if (w.status === 'CONNECTED') setQr(null); return w; }).catch((e) => { setError(e.message); return null; }), []);
  useEffect(() => { load(); void loadWa(); }, [load, loadWa]);
  // enquanto o QR code está na tela, confere a cada 3 s se o celular já leu
  useEffect(() => {
    if (!qr) return;
    poll.current = setInterval(() => { void loadWa(); }, 3000);
    return () => { if (poll.current) clearInterval(poll.current); };
  }, [qr, loadWa]);

  async function save(type: string, body: object, msg = 'Salvo.') {
    setError(''); setOk('');
    try { await api(`/notifications/rules/${type}`, 'PUT', body); setOk(msg); load(); } catch (e) { setError((e as Error).message); }
  }
  const connect = useCallback(async (auto = false, nextCycle = 1) => {
    if (renewing.current) return;
    renewing.current = true;
    if (!auto) { setError(''); setOk(''); }
    try {
      const r = await api<QrRes>('/notifications/whatsapp/connect', 'POST');
      setQr(r.qr); setQrTotal(r.expiresInSeconds); setQrEnds(Date.now() + r.expiresInSeconds * 1000); setCycle(nextCycle); setExpired(false);
      void loadWa();
    } catch (e) { setError((e as Error).message); setQr(null); } finally { renewing.current = false; }
  }, [loadWa]);
  // relógio do QR: 1 tique por segundo; ao zerar, gera outro sozinho (até MAX_QR_CYCLES) e depois pede o clique
  useEffect(() => {
    if (!qr) return;
    const t = setInterval(() => setNowMs(Date.now()), 500);
    return () => clearInterval(t);
  }, [qr]);
  useEffect(() => {
    if (!qr || nowMs < qrEnds || renewing.current) return;
    if (cycle >= MAX_QR_CYCLES) { setExpired(true); return; }
    void connect(true, cycle + 1);
  }, [nowMs, qr, qrEnds, cycle, connect]);
  async function disconnect() {
    if (!(await ui.confirm({ title: 'Desconectar o WhatsApp?', message: 'Os avisos por WhatsApp param até você ler um novo QR code.', confirmLabel: 'Desconectar' }))) return;
    try { await api('/notifications/whatsapp/disconnect', 'POST'); setQr(null); void loadWa(); } catch (e) { setError((e as Error).message); }
  }
  async function test(channel: 'EMAIL' | 'WHATSAPP') {
    const to = await ui.prompt({ title: channel === 'EMAIL' ? 'Teste por e-mail' : 'Teste por WhatsApp', label: channel === 'EMAIL' ? 'Enviar para (e-mail)' : 'Enviar para (telefone com DDD)', confirmLabel: 'Enviar teste' });
    if (!to) return;
    setError(''); setOk('');
    try { await api('/notifications/test', 'POST', { channel, to }); setOk('Teste enviado.'); } catch (e) { setError((e as Error).message); }
  }
  async function runNow() {
    setError(''); setOk('');
    try { const r = await api<{ generated: number; sent: number; failed: number }>('/notifications/run', 'POST'); setOk(`Varredura feita: ${r.generated} aviso(s) novo(s), ${r.sent} enviado(s), ${r.failed} com falha.`); load(); } catch (e) { setError((e as Error).message); }
  }

  return (
    <>
      <PageHeader title="Avisos ao cliente" description={<>Vencimento, status do pedido e cobrança por e-mail e WhatsApp. Tudo começa desligado. Só recebe quem tem contato cadastrado e não pediu para sair; cada aviso vai uma única vez.</>}
        actions={<button className="btn" onClick={runNow}>Enviar agora</button>} />
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}
      {res && !res.emailAvailable && <Alert kind="warn">O servidor ainda não tem e-mail configurado (SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM). Avisos por e-mail ficam como “falhou” até lá.</Alert>}

      <section className="card" style={{ marginBottom: 16 }} aria-label="WhatsApp">
        <h2>WhatsApp {wa && <span className={`badge ${wa.status === 'CONNECTED' ? 'ok' : 'warn'}`}>{wa.status === 'CONNECTED' ? 'Conectado' : wa.status === 'CONNECTING' ? 'Aguardando leitura do QR code' : 'Desconectado'}</span>}</h2>
        {wa && !wa.configured && <Alert kind="warn">O servidor ainda não está ligado à Evolution API (EVOLUTION_API_URL e EVOLUTION_API_KEY). Peça ao responsável pela instalação.</Alert>}
        {wa?.lastError && <p className="muted">{wa.status === 'CONNECTED' ? 'Aviso' : 'Situação'}: {wa.lastError}</p>}
        {wa?.status === 'CONNECTING' && wa.wantConnected && !qr && <Alert kind="warn">A sessão caiu e o sistema está tentando reconectar sozinho (tentativa {wa.reconnectAttempts} de 5). Não precisa ler QR code agora; se não voltar, você será avisado por e-mail.</Alert>}
        {wa?.status === 'DISCONNECTED' && wa.lastError?.includes('QR code') && !qr && <Alert kind="error">A sessão foi encerrada e não voltou sozinha. Leia um novo QR code abaixo.</Alert>}
        {wa?.status === 'CONNECTED' ? (
          <>
            <div className="row"><span>Número conectado: <strong>{wa.phone ?? '—'}</strong></span><button className="btn" onClick={() => test('WHATSAPP')}>Enviar teste</button><button className="btn" onClick={disconnect}>Desconectar</button></div>
            <p className="muted" style={{ fontSize: '0.82rem', marginBottom: 0 }}>Sessão vigiada: se cair, o sistema tenta reconectar sozinho a cada 2 minutos{wa.lastCheckedAt ? ` (última verificação às ${new Date(wa.lastCheckedAt).toLocaleTimeString('pt-BR')})` : ''}. Só pede novo QR code se o aparelho for desconectado no celular.</p>
          </>
        ) : (
          <>
            <p className="muted">Use um número da empresa. No celular: WhatsApp → Aparelhos conectados → Conectar um aparelho → ler o QR code abaixo. Mensagens automáticas em volume podem levar à restrição do número pelo WhatsApp: comece devagar.</p>
            <button className="btn primary" onClick={() => void connect(false, 1)} disabled={!wa?.configured}>{qr || expired ? 'Gerar novo QR code agora' : 'Conectar WhatsApp'}</button>
            {qr && (() => {
              const left = Math.max(0, Math.ceil((qrEnds - nowMs) / 1000));
              const pct = Math.max(0, Math.min(100, ((qrEnds - nowMs) / (qrTotal * 1000)) * 100));
              return (
                <div style={{ marginTop: 12, maxWidth: 260 }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qr} alt="QR code para conectar o WhatsApp" width={240} height={240} style={{ background: '#fff', padding: 8, borderRadius: 8, opacity: expired ? 0.25 : 1 }} />
                  {!expired ? (
                    <>
                      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={qrTotal} aria-valuenow={left} aria-label="Tempo restante do QR code" style={{ marginTop: 8 }}><span style={{ width: `${pct}%`, transition: 'width .5s linear', background: left <= 10 ? 'var(--danger, #c0392b)' : undefined }} /></div>
                      <p style={{ margin: '6px 0 0', fontWeight: 600 }}>{left <= 0 ? 'Gerando novo QR code…' : `Expira em ${left}s`}</p>
                      <p className="muted" style={{ fontSize: '0.82rem', margin: '2px 0 0' }}>Um novo QR code é gerado sozinho ao zerar (tentativa {cycle} de {MAX_QR_CYCLES}). Esta tela confere sozinha quando o celular conectar.</p>
                    </>
                  ) : (
                    <p className="muted">O tempo para ler acabou. Clique em “Gerar novo QR code agora” quando estiver com o celular em mãos.</p>
                  )}
                </div>
              );
            })()}
          </>
        )}
      </section>

      {res?.rules.map((r) => (
        <section key={r.type} className="card" style={{ marginBottom: 16 }} aria-label={TITLE[r.type]}>
          <h2>{TITLE[r.type]}</h2>
          <p className="muted" style={{ marginTop: 0 }}>{HELP[r.type]}</p>
          <div className="row" style={{ gap: 18 }}>
            <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={r.emailEnabled} onChange={(e) => save(r.type, { emailEnabled: e.target.checked }, e.target.checked ? 'Aviso por e-mail ligado.' : 'Aviso por e-mail desligado.')} />E-mail</label>
            <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={r.whatsappEnabled} onChange={(e) => save(r.type, { whatsappEnabled: e.target.checked }, e.target.checked ? 'Aviso por WhatsApp ligado.' : 'Aviso por WhatsApp desligado.')} />WhatsApp</label>
            {r.type === 'INVOICE_DUE' && <label className="row" style={{ gap: 6 }}>Avisar <input type="number" min={0} max={30} defaultValue={r.daysBefore} style={{ width: 70 }} onBlur={(e) => Number(e.target.value) !== r.daysBefore && save(r.type, { daysBefore: Number(e.target.value) })} /> dia(s) antes</label>}
            {r.type === 'COLLECTION' && <>
              <label className="row" style={{ gap: 6 }}>Cobrar após <input type="number" min={1} max={90} defaultValue={r.minOverdueDays} style={{ width: 70 }} onBlur={(e) => Number(e.target.value) !== r.minOverdueDays && save(r.type, { minOverdueDays: Number(e.target.value) })} /> dia(s) de atraso</label>
              <label className="row" style={{ gap: 6 }}>Repetir a cada <input type="number" min={1} max={90} defaultValue={r.repeatEveryDays} style={{ width: 70 }} onBlur={(e) => Number(e.target.value) !== r.repeatEveryDays && save(r.type, { repeatEveryDays: Number(e.target.value) })} /> dia(s)</label>
            </>}
          </div>
          {r.type === 'ORDER_STATUS' && (
            <div className="row" style={{ gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
              <span className="muted">Avisar quando o pedido ficar:</span>
              {STATUSES.map(([k, l]) => (
                <label key={k} className="row" style={{ gap: 4 }}><input type="checkbox" checked={r.orderStatuses.includes(k)} onChange={(e) => save(r.type, { orderStatuses: e.target.checked ? [...r.orderStatuses, k] : r.orderStatuses.filter((x) => x !== k) })} />{l}</label>
              ))}
            </div>
          )}
          <details style={{ marginTop: 10 }}>
            <summary>Texto da mensagem</summary>
            <form onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void save(r.type, { subject: String(f.get('subject') ?? ''), body: String(f.get('body') ?? '') }, 'Texto salvo.'); }}>
              <p className="muted" style={{ fontSize: '0.82rem' }}>Variáveis: {r.variables.map((v) => `{${v}}`).join(' ')}. Deixe em branco para usar o texto padrão.</p>
              <div className="field"><label htmlFor={`s-${r.type}`}>Assunto (e-mail)</label><input id={`s-${r.type}`} name="subject" defaultValue={r.subject ?? ''} placeholder={r.defaultSubject} maxLength={150} /></div>
              <div className="field"><label htmlFor={`b-${r.type}`}>Mensagem</label><textarea id={`b-${r.type}`} name="body" rows={4} defaultValue={r.body ?? ''} placeholder={r.defaultBody} maxLength={1000} /></div>
              <button className="btn">Salvar texto</button>
            </form>
          </details>
        </section>
      ))}

      <section className="card" aria-label="Histórico">
        <div className="card-head"><h2>Histórico de envios</h2><div className="row"><button className="btn sm" onClick={() => test('EMAIL')}>Teste por e-mail</button></div></div>
        {logs && <p className="muted">{Object.entries(logs.counts).map(([k, v]) => `${LOGSTATUS[k] ?? k}: ${v}`).join(' · ') || 'Nenhum aviso ainda.'}</p>}
        {logs && logs.items.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th>Quando</th><th>Aviso</th><th>Canal</th><th>Destino</th><th>Situação</th></tr></thead>
            <tbody>{logs.items.map((l) => (
              <tr key={l.id}><td>{new Date(l.createdAt).toLocaleString('pt-BR')}</td><td>{TITLE[l.type] ?? l.type}</td><td>{l.channel === 'EMAIL' ? 'E-mail' : 'WhatsApp'}</td><td>{l.recipient}</td>
                <td><span className={`badge ${l.status === 'SENT' ? 'ok' : l.status === 'FAILED' ? 'warn' : ''}`}>{LOGSTATUS[l.status] ?? l.status}</span>{l.error && <div className="muted" style={{ fontSize: '0.78rem' }}>{l.error}</div>}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </>
  );
}
