'use client';

import { CheckCircle2, KeyRound, Trash2, XCircle } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useUi } from '@/components/ui';
import { api } from '@/lib/api';

interface Csc { configured: boolean; id: string | null; hint: string | null }
interface ProviderView {
  available: { key: string; name: string }[]; provider: string | null; providerName: string | null;
  homologacao: { configured: boolean; hint: string | null }; producao: { configured: boolean; hint: string | null };
  csc: { homologacao: Csc; producao: Csc };
}
type Env = 'HOMOLOGACAO' | 'PRODUCAO';
type Choice = 'FOCUS_NFE' | 'SEFAZ_DIRECT';

/** Como a nota é emitida neste estabelecimento: provedor (Focus NFe, token) ou direto na SEFAZ (certificado A1 + CSC). Segredos nunca voltam ao navegador. */
export function ProviderCard({ establishmentId, uf, manage, onChange }: { establishmentId: string; uf: string | null; manage: boolean; onChange: () => void }) {
  const ui = useUi();
  const [v, setV] = useState<ProviderView | null>(null);
  const [choice, setChoice] = useState<Choice>('FOCUS_NFE');
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState<{ env: Env; ok: boolean; message: string } | null>(null);
  const load = () => api<ProviderView>(`/fiscal/establishments/${establishmentId}/provider`).then((r) => { setV(r); if (r.provider === 'FOCUS_NFE' || r.provider === 'SEFAZ_DIRECT') setChoice(r.provider); }).catch(() => setV(null));
  useEffect(() => { setResult(null); void load(); }, [establishmentId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget; // o evento é reciclado depois do await
    const f = new FormData(form);
    const val = (k: string) => String(f.get(k) ?? '').trim();
    const csc = (id: string, tk: string) => (val(id) || val(tk) ? { id: val(id), token: val(tk) } : undefined);
    const body = choice === 'FOCUS_NFE'
      ? { provider: choice, tokenHomologacao: val('th') || undefined, tokenProducao: val('tp') || undefined }
      : { provider: choice, cscHomologacao: csc('cih', 'cth'), cscProducao: csc('cip', 'ctp') };
    if (choice === 'FOCUS_NFE' && !body.tokenHomologacao && !(body as { tokenProducao?: string }).tokenProducao) { ui.toast.error('Informe ao menos um token.'); return; }
    setBusy('save');
    try { await api(`/fiscal/establishments/${establishmentId}/provider`, 'PUT', body); form.reset(); ui.toast.ok(choice === 'FOCUS_NFE' ? 'Token salvo com criptografia.' : 'Emissão direta ativada para este estabelecimento.'); await load(); onChange(); } catch (err) { ui.toast.error((err as Error).message); }
    setBusy('');
  }

  async function test(env: Env) {
    setBusy(env); setResult(null);
    try { const r = await api<{ ok: boolean; message: string }>(`/fiscal/establishments/${establishmentId}/provider/test`, 'POST', { environment: env }); setResult({ env, ...r }); } catch (err) { setResult({ env, ok: false, message: (err as Error).message }); }
    setBusy('');
  }

  async function remove() {
    if (!(await ui.confirm({ title: 'Remover a configuração de emissão?', message: 'Os tokens e CSC salvos são apagados e este estabelecimento deixa de poder transmitir notas. Notas já autorizadas não são afetadas.', danger: true, confirmLabel: 'Remover', cancelLabel: 'Voltar' }))) return;
    try { await api(`/fiscal/establishments/${establishmentId}/provider`, 'DELETE'); ui.toast.ok('Configuração removida.'); await load(); onChange(); } catch (err) { ui.toast.error((err as Error).message); }
  }

  if (!v) return null;
  const direct = v.provider === 'SEFAZ_DIRECT';
  const Status = ({ env }: { env: Env }) => result?.env === env ? <span role="status" style={{ display: 'inline-flex', gap: 4, alignItems: 'center', color: result.ok ? 'var(--ok)' : 'var(--danger)' }}>{result.ok ? <CheckCircle2 size={14} aria-hidden /> : <XCircle size={14} aria-hidden />}{result.message}</span> : null;
  const envRow = (env: Env, label: string) => {
    const tok = env === 'HOMOLOGACAO' ? v.homologacao : v.producao;
    const csc = env === 'HOMOLOGACAO' ? v.csc.homologacao : v.csc.producao;
    return (
      <li key={env} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ minWidth: 120 }}>{label}</span>
        {direct ? (csc.configured ? <span className="badge ok">CSC {csc.id} · {csc.hint}</span> : <span className="badge">sem CSC (só NF-e)</span>) : (tok.configured ? <span className="badge ok">token {tok.hint}</span> : <span className="badge">sem token</span>)}
        {manage && (direct || tok.configured) && <button className={`btn sm ${busy === env ? 'loading' : ''}`} disabled={!!busy} onClick={() => test(env)}>Testar comunicação</button>}
        <Status env={env} />
      </li>
    );
  };

  return (
    <section className="card" aria-label="Provedor de emissão">
      <div className="card-head"><h2><KeyRound size={16} aria-hidden style={{ verticalAlign: '-2px' }} /> Como emitir as notas</h2>{v.provider ? <span className="badge ok">{v.providerName}</span> : <span className="badge warn">Não configurado</span>}</div>
      {manage && (
        <div style={{ marginBottom: 12, maxWidth: 420 }}>
          <label htmlFor="pchoice">Forma de emissão</label>
          <select id="pchoice" value={choice} onChange={(e) => setChoice(e.target.value as Choice)}>
            <option value="FOCUS_NFE">Provedor Focus NFe (token) — recomendado para começar</option>
            <option value="SEFAZ_DIRECT">Direto na SEFAZ (certificado A1)</option>
          </select>
        </div>
      )}
      {choice === 'FOCUS_NFE' ? (
        <p className="muted" style={{ marginTop: 0 }}>
          A nota é gerada, assinada e transmitida à SEFAZ pelo provedor, na <strong>sua conta</strong> dele. Crie a conta, cadastre a empresa, o <strong>certificado A1</strong> e (NFC-e) o <strong>CSC</strong> no painel do Focus NFe e cole aqui o token de cada ambiente. Comece pela <strong>homologação</strong> (sem valor fiscal).
        </p>
      ) : (
        <div className="stack" style={{ marginBottom: 8 }}>
          <p className="muted" style={{ margin: 0 }}>
            O sistema monta o XML, confere no leiaute oficial (XSD), <strong>assina com o certificado A1 deste estabelecimento</strong> (envie-o no card “Certificado digital A1”, acima) e fala direto com a SEFAZ. Exige que a empresa já esteja <strong>credenciada</strong> para emitir NF-e/NFC-e.
          </p>
          <div className="alert warn" role="status"><div><strong>Cobertura:</strong> hoje só <strong>Minas Gerais</strong> tem os endereços oficiais verificados{uf && uf !== 'MG' ? <> — este estabelecimento é de <strong>{uf}</strong>, então a emissão direta <strong>não funciona</strong> aqui ainda</> : null}. O fluxo <strong>nunca foi testado contra a SEFAZ real</strong> (precisa de certificado e credenciamento): use primeiro a homologação e confira o resultado.</div></div>
        </div>
      )}
      <ul style={{ listStyle: 'none', margin: '0 0 12px', padding: 0, display: 'grid', gap: 8 }}>
        {envRow('HOMOLOGACAO', 'Homologação')}
        {envRow('PRODUCAO', 'Produção')}
      </ul>
      {manage && (
        <form onSubmit={save}>
          {choice === 'FOCUS_NFE' ? (
            <div className="form-grid">
              <div><label htmlFor="pth">Token de homologação</label><input id="pth" name="th" type="password" autoComplete="off" placeholder={v.homologacao.configured ? 'deixe vazio para manter' : ''} maxLength={200} /></div>
              <div><label htmlFor="ptp">Token de produção</label><input id="ptp" name="tp" type="password" autoComplete="off" placeholder={v.producao.configured ? 'deixe vazio para manter' : ''} maxLength={200} /></div>
            </div>
          ) : (
            <>
              <p className="muted" style={{ margin: '0 0 8px' }}>CSC da NFC-e (obtido no portal da SEFAZ; <strong>só para NFC-e</strong>, cada ambiente tem o seu). Deixe vazio para emitir só NF-e.</p>
              <div className="form-grid">
                <div><label htmlFor="cih">Identificador do CSC — homologação</label><input id="cih" name="cih" inputMode="numeric" maxLength={6} placeholder={v.csc.homologacao.configured ? 'deixe vazio para manter' : ''} /></div>
                <div><label htmlFor="cth">Código CSC — homologação</label><input id="cth" name="cth" type="password" autoComplete="off" maxLength={64} /></div>
                <div><label htmlFor="cip">Identificador do CSC — produção</label><input id="cip" name="cip" inputMode="numeric" maxLength={6} placeholder={v.csc.producao.configured ? 'deixe vazio para manter' : ''} /></div>
                <div><label htmlFor="ctp">Código CSC — produção</label><input id="ctp" name="ctp" type="password" autoComplete="off" maxLength={64} /></div>
              </div>
            </>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <button className={`btn primary ${busy === 'save' ? 'loading' : ''}`} disabled={!!busy}>{choice === 'FOCUS_NFE' ? 'Salvar token' : direct ? 'Salvar CSC' : 'Ativar emissão direta'}</button>
            {v.provider && <button type="button" className="btn" onClick={remove} disabled={!!busy}><Trash2 aria-hidden />Remover configuração</button>}
          </div>
          <p className="muted" style={{ marginBottom: 0, fontSize: '0.82rem' }}>Tokens e CSC são cifrados no servidor e nunca voltam ao navegador (só o final). O ambiente usado na emissão é o definido na configuração fiscal.</p>
        </form>
      )}
    </section>
  );
}
