'use client';

import { ExternalLink, Link2, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { EmptyState, useUi } from '@/components/ui';
import { MarketplaceLogo } from '@/components/marketplace-logo';

export type Support = 'SUPPORTED' | 'IMPLEMENTED_UNVERIFIED' | 'PLANNED' | 'UNSUPPORTED';
export interface Provider {
  provider: string; displayName: string; docsUrl: string; authType: string; sandbox?: boolean; notes?: string; category: 'MARKETPLACE' | 'STORE_PLATFORM' | 'HUB'; region: 'BR' | 'GLOBAL';
  capabilities: Record<string, Support>;
}
interface Warehouse { id: string; code: string; name: string }

const CATS: [string, string][] = [['ALL', 'Todos'], ['MARKETPLACE', 'Marketplaces'], ['STORE_PLATFORM', 'Lojas virtuais'], ['HUB', 'ERPs e integradores']];
const CAP: Record<string, string> = { authorization: 'Autorização', orders: 'Pedidos', catalog: 'Catálogo', publishing: 'Publicação', price: 'Preço', inventory: 'Estoque', shipments: 'Envios', webhooks: 'Notificações' };
const SUP: Record<Support, string> = { SUPPORTED: 'Disponível', IMPLEMENTED_UNVERIFIED: 'Implementado, sem validação com conta real', PLANNED: 'Planejado', UNSUPPORTED: 'Não suportado' };
const AUTH: Record<string, string> = { OAUTH2: 'Login do canal (OAuth)', SIGNED_OAUTH2: 'Login do canal com assinatura', API_KEY: 'Chave de API' };

export const isConnectable = (p: Provider) => ['SUPPORTED', 'IMPLEMENTED_UNVERIFIED'].includes(p.capabilities.authorization);

/** Galeria de canais: o que já conecta fica em destaque com um clique; o restante mostra o que falta, sem prometer o que não existe. */
export function ChannelGallery({ providers, warehouses, manage, onConnect }: {
  providers: Provider[]; warehouses: Warehouse[]; manage: boolean; onConnect: (p: Provider, label: string, warehouseId: string) => Promise<void>;
}) {
  const ui = useUi();
  const [cat, setCat] = useState('ALL');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    return providers
      .filter((p) => (cat === 'ALL' || p.category === cat) && (!term || p.displayName.toLowerCase().includes(term)))
      .sort((a, b) => Number(isConnectable(b)) - Number(isConnectable(a)) || Number(a.region === 'GLOBAL') - Number(b.region === 'GLOBAL') || a.displayName.localeCompare(b.displayName, 'pt-BR'));
  }, [providers, cat, q]);
  const available = providers.filter(isConnectable).length;

  async function connect(p: Provider) {
    if (!warehouses.length) { ui.toast.error('Cadastre um depósito em Empresa antes de conectar um canal: ele define de onde sai o estoque.'); return; }
    const r = await ui.form({
      title: `Conectar ${p.displayName}`, confirmLabel: 'Continuar para o canal',
      message: <>Você será levado ao {p.displayName} para autorizar o acesso à sua conta. Depois volta aqui e o teste de conexão roda sozinho.</>,
      fields: [
        { name: 'label', label: 'Nome da conexão', required: true, defaultValue: p.displayName, hint: 'Aparece na lista de conexões (ex.: Loja principal).' },
        { name: 'warehouseId', label: 'Depósito de origem do estoque', type: 'select', required: true, defaultValue: warehouses[0]?.id, options: warehouses.map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` })) },
      ],
    });
    if (r) await onConnect(p, r.label, r.warehouseId);
  }

  return (
    <section className="card" style={{ marginBottom: 16 }} aria-label="Canais de venda">
      <div className="card-head">
        <div>
          <h2>Conectar um canal</h2>
          <p className="muted" style={{ margin: 0 }}>{available} disponível(is) agora; os demais estão planejados e aparecem aqui para você ver o que vem e o que cada um exige.</p>
        </div>
      </div>
      <div className="toolbar">
        <div className="tabs" role="tablist" aria-label="Tipo de canal" style={{ margin: 0, border: 0, flex: 1 }}>
          {CATS.map(([k, l]) => <button key={k} role="tab" aria-selected={cat === k} className={`tab ${cat === k ? 'active' : ''}`} onClick={() => setCat(k)}>{l}</button>)}
        </div>
        <div className="search"><Search aria-hidden /><input aria-label="Buscar canal" placeholder="Buscar canal" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      </div>
      {list.length === 0 && <EmptyState title="Nenhum canal encontrado">Ajuste a busca ou o filtro.</EmptyState>}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
        {list.map((p) => {
          const can = isConnectable(p);
          const unverified = p.capabilities.authorization === 'IMPLEMENTED_UNVERIFIED';
          const expanded = open === p.provider;
          return (
            <article key={p.provider} className="card" style={{ background: 'var(--surface-2)', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="row" style={{ flexWrap: 'nowrap', gap: 12 }}>
                <MarketplaceLogo provider={p.provider} name={p.displayName} />
                <div style={{ minWidth: 0 }}>
                  <strong style={{ display: 'block', overflowWrap: 'anywhere' }}>{p.displayName}</strong>
                  <span className="muted" style={{ fontSize: '0.78rem' }}>{p.region === 'BR' ? 'Brasil' : 'Global'} · {CATS.find(([k]) => k === p.category)?.[1]}</span>
                </div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                {p.sandbox ? <span className="badge warn">Sandbox (testes)</span> : can ? <span className="badge ok dot">Disponível</span> : <span className="badge">Em breve</span>}
                {unverified && <span className="badge warn" title="Implementado e testado com servidor simulado; falta validar com uma conta real.">sem validação com conta real</span>}
              </div>
              <div className="row" style={{ marginTop: 'auto' }}>
                {can && manage && <button className="btn primary sm" onClick={() => connect(p)}><Link2 aria-hidden />Conectar</button>}
                <button className="btn sm" onClick={() => setOpen(expanded ? null : p.provider)} aria-expanded={expanded}>{expanded ? 'Ocultar' : 'Detalhes'}</button>
              </div>
              {expanded && (
                <div style={{ fontSize: '0.85rem', borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                  <p className="muted" style={{ marginTop: 0 }}>{p.notes}</p>
                  <p style={{ margin: '0 0 8px' }}><strong>Autenticação prevista:</strong> {AUTH[p.authType] ?? p.authType}</p>
                  <div className="row" style={{ gap: 4, marginBottom: 8 }}>{Object.entries(p.capabilities).map(([k, v]) => <span key={k} className={`badge ${v === 'SUPPORTED' ? 'ok' : ''}`} title={SUP[v]}>{CAP[k]}: {v === 'PLANNED' ? 'planejado' : v === 'IMPLEMENTED_UNVERIFIED' ? 'implementado*' : SUP[v].toLowerCase()}</span>)}</div>
                  {p.docsUrl ? <a href={p.docsUrl} target="_blank" rel="noreferrer" className="row" style={{ gap: 4 }}>Documentação oficial <ExternalLink size={13} aria-hidden /></a> : <span className="muted">Documentação pública não localizada: consulte o canal.</span>}
                  {unverified && <p className="muted" style={{ marginBottom: 0, marginTop: 6 }}>* testado com servidor simulado; sem validação com conta real.</p>}
                </div>
              )}
            </article>
          );
        })}
      </div>
      <p className="muted" style={{ marginBottom: 0, marginTop: 14, fontSize: '0.78rem' }}>Nomes e logotipos pertencem aos respectivos titulares e identificam apenas o canal. Quando o ícone oficial não está instalado, mostramos um ícone genérico ou a sigla do canal.</p>
    </section>
  );
}
