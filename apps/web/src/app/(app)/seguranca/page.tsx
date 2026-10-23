'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { Alert, PageHeader } from '@/components/ui';

interface Status { enabled: boolean; enabledAt: string | null; recoveryCodesLeft: number }
interface Setup { secret: string; otpauthUrl: string; qrDataUrl: string }

/** Segurança da conta: segundo fator (aplicativo autenticador) com códigos de recuperação. */
export default function SegurancaPage() {
  const [st, setSt] = useState<Status | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const load = useCallback(() => { api<Status>('/auth/mfa').then(setSt).catch((e) => setError(e.message)); }, []);
  useEffect(load, [load]);

  async function start() {
    setError(''); setOk('');
    try { setSetup(await api<Setup>('/auth/mfa/setup', 'POST')); } catch (e) { setError((e as Error).message); }
  }
  async function enable(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError('');
    try {
      const r = await api<{ recoveryCodes: string[] }>('/auth/mfa/enable', 'POST', { code: new FormData(e.currentTarget).get('code') });
      setCodes(r.recoveryCodes); setSetup(null); setOk('Segundo fator ativado.'); load();
    } catch (err) { setError((err as Error).message); }
  }
  async function disable(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(''); setOk('');
    const f = new FormData(e.currentTarget);
    try { await api('/auth/mfa/disable', 'POST', { password: f.get('password'), code: f.get('code') }); setOk('Segundo fator desativado.'); setCodes(null); load(); } catch (err) { setError((err as Error).message); }
  }

  return (
    <>
      <PageHeader title="Segurança da conta" description={<>Com o segundo fator, a senha sozinha não entra: é preciso também o código do aplicativo autenticador (Google Authenticator, Microsoft Authenticator, Authy…).</>} />
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}

      {codes && (
        <section className="card" style={{ marginBottom: 16 }} aria-label="Códigos de recuperação">
          <h2>Guarde os códigos de recuperação</h2>
          <p className="muted">Cada código vale uma vez e substitui o aplicativo se você perder o celular. <strong>Eles não serão mostrados de novo.</strong></p>
          <pre className="mono" style={{ columns: 2, margin: 0 }}>{codes.join('\n')}</pre>
          <div className="row" style={{ marginTop: 12 }}><button className="btn" onClick={() => void navigator.clipboard?.writeText(codes.join('\n'))}>Copiar</button><button className="btn primary" onClick={() => setCodes(null)}>Já guardei</button></div>
        </section>
      )}

      <section className="card">
        <h2>Verificação em duas etapas {st && <span className={`badge ${st.enabled ? 'ok' : 'warn'}`}>{st.enabled ? 'Ativa' : 'Desligada'}</span>}</h2>
        {!st ? <p className="muted">Carregando…</p> : st.enabled ? (
          <form onSubmit={disable}>
            <p className="muted">Ativa desde {st.enabledAt ? new Date(st.enabledAt).toLocaleDateString('pt-BR') : '—'} · {st.recoveryCodesLeft} código(s) de recuperação restante(s).</p>
            <p className="muted">Para desligar, confirme a senha e um código atual (ou de recuperação).</p>
            <div className="form-grid">
              <div><label htmlFor="pw">Senha</label><input id="pw" name="password" type="password" autoComplete="current-password" required /></div>
              <div><label htmlFor="cd">Código</label><input id="cd" name="code" inputMode="numeric" autoComplete="one-time-code" required maxLength={16} /></div>
            </div>
            <div className="row" style={{ marginTop: 12 }}><button className="btn danger">Desativar</button></div>
          </form>
        ) : setup ? (
          <form onSubmit={enable}>
            <p>1. No aplicativo autenticador, leia o QR code (ou digite a chave).</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={setup.qrDataUrl} alt="QR code do autenticador" width={220} height={220} />
            <p className="muted mono" style={{ overflowWrap: 'anywhere' }}>Chave: {setup.secret}</p>
            <p>2. Digite o código de 6 dígitos que o aplicativo mostrar.</p>
            <div className="row"><input name="code" inputMode="numeric" autoComplete="one-time-code" required maxLength={6} placeholder="000000" style={{ maxWidth: 160 }} aria-label="Código de 6 dígitos" /><button className="btn primary">Ativar</button><button type="button" className="btn" onClick={() => setSetup(null)}>Cancelar</button></div>
          </form>
        ) : (
          <>
            <p className="muted">Recomendado para quem acessa financeiro, fiscal e usuários.</p>
            <button className="btn primary" onClick={start}>Configurar</button>
          </>
        )}
      </section>
    </>
  );
}
