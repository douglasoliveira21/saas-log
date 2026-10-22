'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { PageHeader, Alert, Skeleton } from '@/components/ui';

interface Settings { 'commission.event': string; 'sales.maxDiscountPct': number; 'purchases.approvalLimit': number; 'sales.cutoffTime': string; 'sales.cutoffBusinessDaysOnly': boolean; 'customers.inactiveAfterDays': number; 'fiscal.nfceMaxValue': number; 'warehouse.requireCheck': boolean }

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
        'sales.cutoffTime': String(f.get('cutoff') ?? ''),
        'sales.cutoffBusinessDaysOnly': f.get('weekdays') === 'on',
        'customers.inactiveAfterDays': Number(f.get('inactive')),
        'warehouse.requireCheck': f.get('reqcheck') === 'on',
        'fiscal.nfceMaxValue': Number(String(f.get('nfcemax') ?? '0').replace(/\./g, '').replace(',', '.')),
      }));
      setOk('Políticas salvas (alteração registrada na auditoria).');
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <>
      <PageHeader title="Políticas comerciais" description={<>Valem para novos pedidos e ordens; documentos já confirmados não são recalculados.</>} />
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}
      {!s && !error && <Skeleton rows={3} />}
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
          <h2 style={{ marginTop: 20 }}>Horário de corte das vendas</h2>
          <p className="muted" style={{ marginTop: 0 }}>Vale para vendas <strong>fora de marketplace</strong>. Pedido confirmado antes do horário sai no mesmo dia; a partir dele, no próximo dia de saída. Deixe vazio para não usar corte. Fuso de Brasília; feriados não são considerados.</p>
          <div className="field"><label htmlFor="cutoff">Horário de corte</label><input id="cutoff" name="cutoff" type="time" defaultValue={s['sales.cutoffTime']} style={{ maxWidth: 160 }} /></div>
          <div className="field"><label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" name="weekdays" defaultChecked={s['sales.cutoffBusinessDaysOnly']} style={{ width: 'auto' }} />Considerar só dias úteis (seg–sex); fim de semana sai na segunda</label></div>
          <h2 style={{ marginTop: 20 }}>Armazém</h2>
          <div className="field"><label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" name="reqcheck" defaultChecked={s['warehouse.requireCheck']} style={{ width: 'auto' }} />Exigir conferência por código de barras (sem divergência) antes de marcar o pedido como embalado</label></div>
          <h2 style={{ marginTop: 20 }}>Cupom fiscal (NFC-e)</h2>
          <div className="field"><label htmlFor="nfcemax">Valor máximo de cada cupom (R$)</label><input id="nfcemax" name="nfcemax" inputMode="decimal" defaultValue={String(s['fiscal.nfceMaxValue']).replace('.', ',')} style={{ maxWidth: 160 }} /><p className="muted">Pedido em NFC-e acima desse valor é dividido automaticamente em vários cupons, cada um até o limite (ex.: R$ 400.000,00 com limite de R$ 9.999,00 vira 41 cupons). Uma unidade nunca é partida, então um cupom pode fechar um pouco abaixo do limite. Use <strong>0</strong> para não dividir. Não vale para NF-e.</p></div>
          <h2 style={{ marginTop: 20 }}>Perfil do cliente</h2>
          <div className="field"><label htmlFor="inactive">Cliente inativo após quantos dias sem comprar?</label><input id="inactive" name="inactive" inputMode="numeric" defaultValue={s['customers.inactiveAfterDays']} style={{ maxWidth: 160 }} /><p className="muted">Quem compra pela primeira vez é <strong>novo</strong>; quem comprou dentro desse prazo é <strong>ativo</strong>; quem volta depois de mais dias é marcado como <strong>voltou a comprar</strong>.</p></div>
          <button className="btn primary">Salvar</button>
        </form>
      )}
    </>
  );
}
