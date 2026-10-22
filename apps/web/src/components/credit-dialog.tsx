'use client';

import { useEffect, useState } from 'react';
import { Alert, Dialog, Skeleton, useUi } from '@/components/ui';
import { api } from '@/lib/api';
import { brl } from '@/lib/format';

export interface CreditInfo { limit: string | null; exposure: string; available: string | null; overdue: string; openTitles: number }

/** Limite de crédito do cliente e quanto já está em uso (contas a receber em aberto). */
export function CreditDialog({ customerId, customerName, canManage, onClose }: { customerId: string; customerName: string; canManage: boolean; onClose: () => void }) {
  const ui = useUi();
  const [info, setInfo] = useState<CreditInfo | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { api<CreditInfo>(`/customers/${customerId}/credit`).then((r) => { setInfo(r); setValue(r.limit === null ? '' : String(Number(r.limit)).replace('.', ',')); }).catch((e) => setError(e.message)); }, [customerId]);

  async function save() {
    setError('');
    const n = value.trim() === '' ? null : Number(value.replace(/\./g, '').replace(',', '.'));
    if (n !== null && (!Number.isFinite(n) || n < 0)) { setError('Informe um valor válido (0 ou mais), ou deixe vazio para não controlar.'); return; }
    try { const r = await api<CreditInfo>(`/customers/${customerId}/credit-limit`, 'PUT', { creditLimit: n }); setInfo(r); ui.toast.ok(n === null ? 'Limite removido: o cliente não é mais controlado.' : 'Limite de crédito salvo.'); } catch (e) { setError((e as Error).message); }
  }
  const pct = info?.limit && Number(info.limit) > 0 ? Math.min(100, (Number(info.exposure) / Number(info.limit)) * 100) : null;

  return (
    <Dialog title={`Crédito — ${customerName}`} description="Limite para vendas a prazo (boleto, cheque ou outra forma). Pix, dinheiro e cartão não usam o limite." onClose={onClose}>
      <div className="modal-body">
        {error && <Alert kind="error">{error}</Alert>}
        {!info && !error && <Skeleton rows={3} />}
        {info && <>
          <div className="meta" style={{ marginBottom: 12 }}><span><b>Em aberto:</b> {brl(info.exposure)} ({info.openTitles} título(s))</span><span><b>Vencido:</b> {brl(info.overdue)}</span><span><b>Disponível:</b> {info.available === null ? 'sem controle' : brl(info.available)}</span></div>
          {pct !== null && <div className="progress" aria-hidden style={{ marginBottom: 12 }}><span style={{ width: `${pct}%`, background: pct >= 100 ? 'var(--danger)' : pct >= 80 ? 'var(--warn)' : undefined }} /></div>}
          {canManage ? <>
            <label htmlFor="cr-l">Limite de crédito (R$)</label>
            <input id="cr-l" inputMode="decimal" placeholder="Vazio = sem controle" value={value} onChange={(e) => setValue(e.target.value)} />
            <p className="muted" style={{ fontSize: '0.82rem' }}>Quando uma venda a prazo faria o total em aberto passar do limite, o pedido vai para <strong>aprovação</strong> de um gestor. Limite 0 manda toda venda a prazo para aprovação.</p>
          </> : <p className="muted">Limite: {info.limit === null ? 'sem controle' : brl(info.limit)}</p>}
        </>}
      </div>
      {canManage && info && <div className="modal-foot"><button className="btn" onClick={onClose}>Fechar</button><button className="btn primary" onClick={save}>Salvar limite</button></div>}
    </Dialog>
  );
}
