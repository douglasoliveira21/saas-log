'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';

interface Settings { 'commission.event': string; 'sales.maxDiscountPct': number; 'purchases.approvalLimit': number }

export default function ConfiguracoesPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  useEffect(() => { api<Settings>('/settings').then(setS).catch((e) => setError(e.message)); }, []);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(''); setOk('');
    const f = new FormData(e.currentTarget);
    try {
      setS(await api<Settings>('/settings', 'PUT', {
        'commission.event': f.get('event'),
        'sales.maxDiscountPct': Number(String(f.get('disc')).replace(',', '.')),
        'purchases.approvalLimit': Number(String(f.get('limit')).replace(',', '.')),
      }));
      setOk('Políticas salvas (alteração registrada na auditoria).');
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <>
      <h1>Políticas comerciais</h1>
      <p className="muted">Valem para novos pedidos e ordens; documentos já confirmados não são recalculados.</p>
      {error && <div className="alert error" role="alert">{error}</div>}
      {ok && <div className="alert ok" role="status">{ok}</div>}
      {!s && !error && <p className="muted">Carregando…</p>}
      {s && (
        <form className="card" onSubmit={save} style={{ maxWidth: 560 }}>
          <div className="field">
            <label htmlFor="event">Quando a comissão é reconhecida (aprovada)</label>
            <select id="event" name="event" defaultValue={s['commission.event']}>
              <option value="CONFIRMED">Pedido aprovado/confirmado</option><option value="SHIPPED">Pedido enviado</option><option value="DELIVERED">Pedido entregue</option>
            </select>
            <p className="muted">“Venda faturada” e “recebimento confirmado” ficarão disponíveis com os módulos Fiscal e Financeiro.</p>
          </div>
          <div className="field"><label htmlFor="disc">Desconto máximo sem aprovação (%)</label><input id="disc" name="disc" inputMode="decimal" defaultValue={s['sales.maxDiscountPct']} /></div>
          <div className="field"><label htmlFor="limit">Compras: aprovação automática até (R$)</label><input id="limit" name="limit" inputMode="decimal" defaultValue={s['purchases.approvalLimit']} /></div>
          <button className="btn primary">Salvar</button>
        </form>
      )}
    </>
  );
}
