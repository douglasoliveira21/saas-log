'use client';

import { CheckCircle2, KeyRound, Trash2, XCircle } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useUi } from '@/components/ui';
import { api } from '@/lib/api';

interface ProviderView {
  available: { key: string; name: string }[]; provider: string | null; providerName: string | null;
  homologacao: { configured: boolean; hint: string | null }; producao: { configured: boolean; hint: string | null };
}
type Env = 'HOMOLOGACAO' | 'PRODUCAO';

/** Token do provedor de emissão (Focus NFe) por estabelecimento. O token é cifrado no servidor e nunca volta ao navegador. */
export function ProviderCard({ establishmentId, manage, onChange }: { establishmentId: string; manage: boolean; onChange: () => void }) {
  const ui = useUi();
  const [v, setV] = useState<ProviderView | null>(null);
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState<{ env: Env; ok: boolean; message: string } | null>(null);
  const load = () => api<ProviderView>(`/fiscal/establishments/${establishmentId}/provider`).then(setV).catch(() => setV(null));
  useEffect(() => { setResult(null); void load(); }, [establishmentId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget; // o evento é reciclado depois do await
    const f = new FormData(form);
    const body = { provider: 'FOCUS_NFE', tokenHomologacao: String(f.get('th') ?? '').trim() || undefined, tokenProducao: String(f.get('tp') ?? '').trim() || undefined };
    if (!body.tokenHomologacao && !body.tokenProducao) { ui.toast.error('Informe ao menos um token.'); return; }
    setBusy('save');
    try { await api(`/fiscal/establishments/${establishmentId}/provider`, 'PUT', body); form.reset(); ui.toast.ok('Token salvo com criptografia.'); await load(); onChange(); } catch (err) { ui.toast.error((err as Error).message); }
    setBusy('');
  }

  async function test(env: Env) {
    setBusy(env); setResult(null);
    try { const r = await api<{ ok: boolean; message: string }>(`/fiscal/establishments/${establishmentId}/provider/test`, 'POST', { environment: env }); setResult({ env, ...r }); } catch (err) { setResult({ env, ok: false, message: (err as Error).message }); }
    setBusy('');
  }

  async function remove() {
    if (!(await ui.confirm({ title: 'Remover o provedor?', message: 'Os tokens salvos são apagados e este estabelecimento deixa de poder transmitir notas. Notas já autorizadas não são afetadas.', danger: true, confirmLabel: 'Remover', cancelLabel: 'Voltar' }))) return;
    try { await api(`/fiscal/establishments/${establishmentId}/provider`, 'DELETE'); ui.toast.ok('Provedor removido.'); await load(); onChange(); } catch (err) { ui.toast.error((err as Error).message); }
  }

  if (!v) return null;
  const Row = ({ env, label, s }: { env: Env; label: string; s: { configured: boolean; hint: string | null } }) => (
    <li style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ minWidth: 120 }}>{label}</span>
      {s.configured ? <span className="badge ok">salvo {s.hint}</span> : <span className="badge">sem token</span>}
      {s.configured && manage && <button className={`btn sm ${busy === env ? 'loading' : ''}`} disabled={!!busy} onClick={() => test(env)}>Testar</button>}
      {result?.env === env && <span className={result.ok ? '' : 'muted'} role="status" style={{ display: 'inline-flex', gap: 4, alignItems: 'center', color: result.ok ? 'var(--ok)' : 'var(--danger)' }}>{result.ok ? <CheckCircle2 size={14} aria-hidden /> : <XCircle size={14} aria-hidden />}{result.message}</span>}
    </li>
  );

  return (
    <section className="card" aria-label="Provedor de emissão">
      <div className="card-head"><h2><KeyRound size={16} aria-hidden style={{ verticalAlign: '-2px' }} /> Provedor de emissão (Focus NFe)</h2>{v.provider ? <span className="badge ok">Configurado</span> : <span className="badge warn">Não configurado</span>}</div>
      <p className="muted" style={{ marginTop: 0 }}>
        A nota é gerada, assinada e transmitida à SEFAZ pelo provedor, na <strong>sua conta</strong> dele. Crie a conta, cadastre a empresa, o <strong>certificado A1</strong> e (para NFC-e) o <strong>CSC</strong> no painel do Focus NFe e cole aqui o token de cada ambiente. Use primeiro a <strong>homologação</strong> (sem valor fiscal).
      </p>
      <ul style={{ listStyle: 'none', margin: '0 0 12px', padding: 0, display: 'grid', gap: 8 }}>
        <Row env="HOMOLOGACAO" label="Homologação" s={v.homologacao} />
        <Row env="PRODUCAO" label="Produção" s={v.producao} />
      </ul>
      {manage && (
        <form onSubmit={save}>
          <div className="form-grid">
            <div><label htmlFor="pth">Token de homologação</label><input id="pth" name="th" type="password" autoComplete="off" placeholder={v.homologacao.configured ? 'deixe vazio para manter' : ''} maxLength={200} /></div>
            <div><label htmlFor="ptp">Token de produção</label><input id="ptp" name="tp" type="password" autoComplete="off" placeholder={v.producao.configured ? 'deixe vazio para manter' : ''} maxLength={200} /></div>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className={`btn primary ${busy === 'save' ? 'loading' : ''}`} disabled={!!busy}>Salvar token</button>
            {v.provider && <button type="button" className="btn" onClick={remove} disabled={!!busy}><Trash2 aria-hidden />Remover provedor</button>}
          </div>
          <p className="muted" style={{ marginBottom: 0, fontSize: '0.82rem' }}>O token é cifrado no servidor e nunca volta ao navegador (só os 4 últimos caracteres). O ambiente usado na emissão é o definido na configuração fiscal.</p>
        </form>
      )}
    </section>
  );
}
