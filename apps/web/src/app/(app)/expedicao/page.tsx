'use client';

import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '@/components/ui';
import { useSession } from '@/lib/session';
import { EnviosTab } from './envios-tab';
import { FilaTab } from './fila-tab';
import { PainelTab } from './painel-tab';

type Tab = 'painel' | 'fila' | 'envios';

/**
 * Expedição: o pedido confirmado em Vendas chega aqui para separar, conferir, embalar e expedir. Vendas só acompanha a situação.
 * Painel (alertas e indicadores), Fila de trabalho (quadro por etapa) e Envios e rastreio (transportadora).
 */
export default function ExpedicaoPage() {
  const { can } = useSession();
  const [tab, setTab] = useState<Tab>('painel');
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  // permite abrir direto uma aba por link (#fila, #envios), como faz o painel principal
  useEffect(() => { const h = window.location.hash.replace('#', ''); if (h === 'fila' || h === 'envios') setTab(h); }, []);
  const go = useCallback((t: Tab, f = '', s = '') => { setTab(t); setFilter(f); setSearch(s); window.history.replaceState(null, '', `#${t === 'painel' ? '' : t}`); }, []);

  const tabs: [Tab, string][] = [['painel', 'Painel e alertas'], ['fila', 'Fila de trabalho']];
  if (can('logistics.view')) tabs.push(['envios', 'Envios e rastreio']);

  return (
    <>
      <PageHeader title="Expedição" description={<>Pedidos confirmados em <strong>Vendas</strong> chegam aqui: separe, confira, embale e expeça. Vendas só acompanha a situação de cada pedido.</>} />
      <div className="tabs" role="tablist" aria-label="Seções da expedição">
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => go(k)}>{l}</button>)}
      </div>
      {tab === 'painel' && <PainelTab onOpenQueue={(f, s) => go('fila', f, s)} />}
      {tab === 'fila' && <FilaTab initialFilter={filter} initialSearch={search} onRegisterShipment={() => (can('logistics.view') ? go('envios') : undefined)} />}
      {tab === 'envios' && can('logistics.view') && <EnviosTab />}
    </>
  );
}
