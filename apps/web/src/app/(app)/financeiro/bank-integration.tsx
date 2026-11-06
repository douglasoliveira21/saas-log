'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';

interface BankConfig {
  configured: boolean; provider: string | null; environment: string | null; enabled: boolean;
  cooperative?: string | null; agency?: string | null; accountNumber?: string | null; wallet?: string | null; pixKey?: string | null;
  hasClientId?: boolean; hasClientSecret?: boolean; hasCertificate?: boolean; webhookRegisteredAt?: string | null;
}

export function BankIntegration({ canManage }: { canManage: boolean }) {
  const [cfg, setCfg] = useState<BankConfig | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [saving, setSaving] = useState(false);
  const [certName, setCertName] = useState('');
  useEffect(() => { api<BankConfig>('/finance/bank-integration').then(setCfg).catch((e) => setError(e.message)); }, []);
  if (!cfg) return <div className="card"><p className="muted">Carregando configuração bancária…</p></div>;
  if (!canManage) return <div className="card"><h2>Banco para cobrança</h2><p className="muted">Provedor: {cfg.provider ?? 'não configurado'} · Ambiente: {cfg.environment ?? '—'} · {cfg.enabled ? 'Ativo' : 'Inativo'}</p></div>;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setSaving(true); setError(''); setOk('');
    try {
      const f = new FormData(e.currentTarget);
      const file = (e.currentTarget.elements.namedItem('certificate') as HTMLInputElement).files?.[0];
      const body: Record<string, unknown> = {
        provider: 'SICOOB', environment: f.get('environment'), enabled: f.get('enabled') === 'on',
        clientId: String(f.get('clientId') || '').trim() || undefined, clientSecret: String(f.get('clientSecret') || '').trim() || undefined,
        certificatePassword: String(f.get('certificatePassword') || '').trim() || undefined,
        cooperative: String(f.get('cooperative') || '').trim() || undefined, agency: String(f.get('agency') || '').trim() || undefined,
        accountNumber: String(f.get('accountNumber') || '').trim() || undefined, wallet: String(f.get('wallet') || '').trim() || undefined,
        pixKey: String(f.get('pixKey') || '').trim() || undefined,
      };
      if (file) { const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; bytes.forEach((b) => { binary += String.fromCharCode(b); }); body.certificateBase64 = btoa(binary); }
      const next = await api<BankConfig>('/finance/bank-integration', 'PUT', body); setCfg(next); setOk('Configuração do Sicoob salva com segurança.'); e.currentTarget.reset(); setCertName('');
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  }
  return <form className="card" onSubmit={submit}>
    <h2>Banco para cobrança</h2>
    <p className="muted">A configuração é exclusiva deste tenant. As credenciais e o certificado são armazenados criptografados e nunca são exibidos novamente.</p>
    {error && <div className="alert error">{error}</div>}{ok && <div className="alert ok">{ok}</div>}
    <div className="form-grid">
      <div><label>Provedor</label><select name="provider" disabled defaultValue="SICOOB"><option value="SICOOB">Sicoob</option></select></div>
      <div><label>Ambiente</label><select name="environment" defaultValue={cfg.environment ?? 'SANDBOX'}><option value="SANDBOX">Homologação (sandbox)</option><option value="PRODUCTION">Produção</option></select></div>
      <div><label>Client ID</label><input name="clientId" placeholder={cfg.hasClientId ? 'Já configurado — informe apenas para substituir' : ''} /></div>
      <div><label>Client secret</label><input name="clientSecret" type="password" placeholder={cfg.hasClientSecret ? 'Já configurado — informe apenas para substituir' : ''} /></div>
      <div><label>Certificado mTLS (.p12/.pfx)</label><input name="certificate" type="file" accept=".p12,.pfx" onChange={(e) => setCertName(e.target.files?.[0]?.name ?? '')} /><small className="muted">{certName || (cfg.hasCertificate ? 'Certificado já configurado' : 'Obrigatório para a API Sicoob')}</small></div>
      <div><label>Senha do certificado</label><input name="certificatePassword" type="password" /></div>
      <div><label>Cooperativa</label><input name="cooperative" defaultValue={cfg.cooperative ?? ''} /></div>
      <div><label>Agência</label><input name="agency" defaultValue={cfg.agency ?? ''} /></div>
      <div><label>Conta corrente</label><input name="accountNumber" defaultValue={cfg.accountNumber ?? ''} /></div>
      <div><label>Carteira</label><input name="wallet" defaultValue={cfg.wallet ?? ''} /></div>
      <div><label>Chave Pix</label><input name="pixKey" defaultValue={cfg.pixKey ?? ''} /></div>
    </div>
    <label className="row" style={{ gap: 8, marginTop: 12 }}><input type="checkbox" name="enabled" defaultChecked={cfg.enabled} style={{ width: 'auto' }} /> Ativar integração após validar as credenciais</label>
    <div className="row" style={{ marginTop: 12 }}><button className="btn primary" disabled={saving}>{saving ? 'Salvando…' : 'Salvar configuração'}</button></div>
    <p className="muted" style={{ marginBottom: 0 }}>A emissão de boleto/Pix e o webhook de pagamento só devem ser ativados após a homologação no portal do Sicoob e o cadastro do certificado mTLS.</p>
  </form>;
}
