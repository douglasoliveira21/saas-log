'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useUi, PageHeader, Alert, Skeleton } from '@/components/ui';
import { useSession } from '@/lib/session';
import { ChannelCatalog } from './catalog-import';
import { ChannelGallery, type Provider, type Support } from './gallery';

interface Connection {
  id: string; provider: string; label: string; status: string; externalAccountId: string | null; warehouseId: string | null; config: Record<string, unknown>;
  tokenExpiresAt: string | null; testedAt: string | null; lastSyncAt: string | null; lastError: string | null; failedJobs: number; queuedJobs: number;
}
interface Overview {
  connection: Connection; jobs: Record<string, number>; webhooks: Record<string, number>; logs24h: Record<string, number>; responseMs: { avg: number; max: number };
  nextScheduled: { runAt: string; type: string } | null; recentFailures: { id: string; type: string; status: string; lastError: string | null; attempts: number }[]; attention: string[];
}
interface Job { id: string; type: string; status: string; attempts: number; maxAttempts: number; runAt: string; lastError: string | null; createdAt: string }
interface LogRow { id: string; level: string; operation: string; message: string; durationMs: number | null; createdAt: string }

const STATUS: Record<string, [string, string]> = {
  NOT_CONNECTED: ['Não conectada', ''], AWAITING_AUTHORIZATION: ['Aguardando autorização', 'warn'], TEST_PENDING: ['Teste pendente', 'warn'],
  INCOMPLETE_CONFIG: ['Configuração incompleta', 'warn'], CONNECTED: ['Conectada (pronta para ativar)', 'ok'], ACTIVE: ['Ativa', 'ok'], PAUSED: ['Pausada', ''],
  TOKEN_EXPIRED: ['Token expirado', 'warn'], SYNC_ERROR: ['Erro de sincronização', 'warn'], DISCONNECTED: ['Desconectada', ''],
};
const CAP: Record<string, string> = { authorization: 'Autorização', orders: 'Pedidos', catalog: 'Catálogo', publishing: 'Publicação', price: 'Preço', inventory: 'Estoque', shipments: 'Envios', webhooks: 'Notificações' };
const SUP: Record<Support, string> = { SUPPORTED: 'Disponível', IMPLEMENTED_UNVERIFIED: 'Implementado, sem validação com conta real', PLANNED: 'Planejado', UNSUPPORTED: 'Não suportado' };
const LEDGER: Record<string, [string, string]> = { IMPORTED: ['Importado', 'ok'], NEEDS_ATTENTION: ['Precisa de atenção', 'warn'], AWAITING_PAYMENT: ['Aguardando pagamento', ''], CANCELLED: ['Cancelado', ''] };
interface LedgerRow { id: string; externalId: string; status: string; externalStatus: string | null; reason: string | null; salesOrderId: string | null; updatedAt: string }
interface ProductLite { id: string; sku: string; name: string }
interface Margin { marginPct: number; contribution: number; markupPct: number | null }
interface ListingRow {
  productId: string; sku: string; name: string; externalItemId: string | null; status: string; price: number | null; lastPublishedPrice: number | null; lastPublishedQty: number | null;
  syncStatus: string | null; syncError: string | null; lastSyncAt: string | null; availableQty: number; publishableQty: number; minPrice?: number | null; margin?: Margin | null;
}
interface Fees { commissionPct: number; paymentPct: number; taxPct: number; fixedFee: number; shippingSubsidy: number; packaging: number; minMarginPct: number }
interface CatMap { id: string; categoryId: string; externalCategoryId: string; externalCategoryName: string | null; category: { name: string } }
interface Cat { id: string; name: string }
const SYNC: Record<string, [string, string]> = { OK: ['Sincronizado', 'ok'], BLOCKED: ['Envio indisponível no conector', 'warn'], ERROR: ['Erro', 'warn'] };
const FEE_LABELS: [keyof Fees, string][] = [['commissionPct', 'Comissão do canal (%)'], ['paymentPct', 'Tarifa de pagamento (%)'], ['taxPct', 'Tributos estimados (%) — informado por você'], ['fixedFee', 'Tarifa fixa por pedido (R$)'], ['shippingSubsidy', 'Frete subsidiado (R$)'], ['packaging', 'Embalagem (R$)'], ['minMarginPct', 'Margem mínima (%)']];
const money = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));

export default function IntegracoesPage() {
  const { can } = useSession();
  const ui = useUi();
  const manage = can('integrations.manage');
  const [providers, setProviders] = useState<Provider[]>([]);
  const [conns, setConns] = useState<Connection[] | null>(null);
  const [whs, setWhs] = useState<{ id: string; code: string; name: string; active: boolean }[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [orders, setOrders] = useState<LedgerRow[]>([]);
  const [listings, setListings] = useState<ListingRow[]>([]);
  const [fees, setFees] = useState<Fees | null>(null);
  const [catMap, setCatMap] = useState<CatMap[]>([]);
  const [cats, setCats] = useState<Cat[]>([]);
  const [products, setProducts] = useState<ProductLite[]>([]);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [secret, setSecret] = useState<{ path: string; secret: string } | null>(null);

  const load = useCallback(() => { api<Connection[]>('/integrations/connections').then(setConns).catch((e) => setError(e.message)); }, []);
  const loadDetail = useCallback((id: string) => {
    api<Overview>(`/integrations/connections/${id}`).then(setOv).catch((e) => setError(e.message));
    api<Job[]>(`/integrations/jobs?connectionId=${id}&limit=20`).then(setJobs).catch(() => undefined);
    api<LogRow[]>(`/integrations/logs?connectionId=${id}&limit=30`).then(setLogs).catch(() => undefined);
    api<LedgerRow[]>(`/integrations/connections/${id}/orders`).then(setOrders).catch(() => undefined);
    api<ListingRow[]>(`/integrations/connections/${id}/listings`).then(setListings).catch(() => undefined);
    api<Fees>(`/integrations/connections/${id}/fees`).then(setFees).catch(() => setFees(null));
    api<CatMap[]>(`/integrations/connections/${id}/category-map`).then(setCatMap).catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    api<Cat[]>('/categories').then(setCats).catch(() => undefined);
    api<{ items: ProductLite[] }>('/products?limit=200').then((r) => setProducts(r.items)).catch(() => undefined);
    api<Provider[]>('/integrations/providers').then(setProviders).catch(() => undefined);
    api<{ establishments: { warehouses: { id: string; code: string; name: string; active: boolean }[] }[] }[]>('/structure').then((t) => setWhs(t.flatMap((c) => c.establishments.flatMap((e) => e.warehouses)).filter((w) => w.active))).catch(() => undefined);
    const q = new URLSearchParams(window.location.search);
    if (q.get('connected')) {
      const id = q.get('connected')!;
      setSel(id); setOk('Conta autorizada. Testando a conexão…');
      api(`/integrations/connections/${id}/test`, 'POST')
        .then(() => { setOk('Conta autorizada e testada com sucesso. Clique em “Ativar” para começar a importar pedidos.'); load(); loadDetail(id); })
        .catch((e) => { setOk(''); setError(`Conta autorizada, mas o teste falhou: ${(e as Error).message}`); load(); loadDetail(id); });
    }
    if (q.get('error')) setError(q.get('error')!);
    window.history.replaceState(null, '', '/integracoes');
  }, [load]);
  useEffect(() => { if (sel) loadDetail(sel); else setOv(null); }, [sel, loadDetail]);

  const act = async (fn: () => Promise<unknown>, message: string) => {
    setError(''); setOk('');
    try { await fn(); setOk(message); load(); if (sel) loadDetail(sel); } catch (e) { setError((e as Error).message); load(); if (sel) loadDetail(sel); }
  };
  const post = (id: string, action: string) => api(`/integrations/connections/${id}/${action}`, 'POST');

  /** Um passo: cria a conexão, grava o depósito e leva o usuário à autorização no canal (o teste roda ao voltar). */
  async function connect(p: Provider, label: string, warehouseId: string) {
    setError(''); setOk('');
    let created: (Connection & { webhook: { path: string; secret: string } }) | null = null;
    try {
      created = await api<Connection & { webhook: { path: string; secret: string } }>('/integrations/connections', 'POST', { provider: p.provider, label });
      setSel(created.id); load();
      await api(`/integrations/connections/${created.id}/config`, 'PUT', { warehouseId });
      const r = await api<{ authorizationUrl: string }>(`/integrations/connections/${created.id}/authorize`, 'POST');
      window.location.href = r.authorizationUrl;
    } catch (e) {
      if (created) setSecret(created.webhook);
      setError(`${(e as Error).message}${created ? ' A conexão foi criada; corrija o problema e use "Autorizar" em Gerenciar.' : ''}`);
      load();
    }
  }

  async function authorize(c: Connection) {
    setError('');
    try { const r = await api<{ authorizationUrl: string }>(`/integrations/connections/${c.id}/authorize`, 'POST'); window.location.href = r.authorizationUrl; }
    catch (e) { setError((e as Error).message); load(); }
  }

  async function saveConfig(c: Connection, form: FormData) {
    await act(() => api(`/integrations/connections/${c.id}/config`, 'PUT', {
      warehouseId: form.get('warehouseId') || undefined,
      reconcileMinutes: Number(form.get('reconcileMinutes')) || undefined,
      initialImportDays: Number(form.get('initialImportDays')) || undefined,
      safetyStock: form.get('safetyStock') === '' ? undefined : Number(form.get('safetyStock')),
      orderImport: form.get('orderImport') === 'on', stockSync: form.get('stockSync') === 'on', priceSync: form.get('priceSync') === 'on',
      cancellationPolicy: form.get('cancellationPolicy') || undefined,
    }), 'Configuração salva.');
  }

  const confirmThen = async (msg: string, fn: () => void) => { if (await ui.confirm({ title: 'Confirmar ação', message: msg, danger: true, confirmLabel: 'Continuar', cancelLabel: 'Voltar' })) fn(); };
  const meta = (p: string) => providers.find((x) => x.provider === p);
  const current = conns?.find((c) => c.id === sel);

  return (
    <>
      <PageHeader title="Marketplaces e integrações" description={<>Central de conexões por empresa. Credenciais ficam cifradas no servidor e nunca chegam ao navegador. Conectores marcados como “Planejado” ainda não executam chamadas ao canal.</>} />
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}
      {secret && (
        <div className="alert" role="status">
          <strong>Segredo do webhook (exibido uma única vez):</strong> <code>{secret.secret}</code><br />
          URL: <code>{secret.path}</code> — assine o corpo com HMAC-SHA256 e envie em <code>x-dh-signature: sha256=…</code>.
          <div style={{ marginTop: 8 }}><button className="btn sm" onClick={() => setSecret(null)}>Já guardei</button></div>
        </div>
      )}

      <ChannelGallery providers={providers} warehouses={whs} manage={manage} onConnect={connect} />

      <section className="card" style={{ marginBottom: 16 }}>
        <h2>Conexões</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Conexão</th><th>Canal</th><th>Situação</th><th>Última sincronização</th><th>Fila</th><th /></tr></thead>
          <tbody>
            {!conns && !error && <tr><td colSpan={6}><Skeleton rows={3} /></td></tr>}
            {conns?.length === 0 && <tr><td colSpan={6} className="empty">Nenhum canal conectado. Adicione uma conexão acima para começar.</td></tr>}
            {conns?.map((c) => (
              <tr key={c.id} style={c.id === sel ? { background: 'var(--surface-2)' } : undefined}>
                <td>{c.label}</td><td>{meta(c.provider)?.displayName ?? c.provider}</td>
                <td><span className={`badge ${STATUS[c.status][1]}`}>{STATUS[c.status][0]}</span></td>
                <td>{c.lastSyncAt ? new Date(c.lastSyncAt).toLocaleString('pt-BR') : '—'}</td>
                <td>{c.queuedJobs} na fila{c.failedJobs > 0 && <span className="badge warn" style={{ marginLeft: 6 }}>{c.failedJobs} com falha</span>}</td>
                <td><button className="btn sm" onClick={() => setSel(c.id)}>Gerenciar</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>

      {current && ov && (
        <section className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2>{current.label} <span className={`badge ${STATUS[current.status][1]}`}>{STATUS[current.status][0]}</span></h2>
            {manage && current.status !== 'DISCONNECTED' && (
              <div className="row">
                {['NOT_CONNECTED', 'TOKEN_EXPIRED', 'TEST_PENDING', 'INCOMPLETE_CONFIG', 'CONNECTED', 'AWAITING_AUTHORIZATION'].includes(current.status) && <button className="btn" onClick={() => authorize(current)}>{current.status === 'NOT_CONNECTED' ? 'Conectar conta' : 'Reautorizar'}</button>}
                {current.status !== 'NOT_CONNECTED' && <button className="btn" onClick={() => act(() => post(current.id, 'test'), 'Teste de conexão concluído com sucesso.')}>Testar conexão</button>}
                {['TEST_PENDING', 'INCOMPLETE_CONFIG', 'CONNECTED', 'NOT_CONNECTED'].includes(current.status) && <button className="btn primary" onClick={() => act(() => post(current.id, 'activate'), 'Conexão ativada.')}>Ativar</button>}
                {['PAUSED', 'SYNC_ERROR'].includes(current.status) && <button className="btn primary" onClick={() => act(() => post(current.id, 'activate'), 'Sincronização retomada.')}>{current.status === 'PAUSED' ? 'Retomar' : 'Reativar'}</button>}
                {['ACTIVE', 'SYNC_ERROR'].includes(current.status) && <button className="btn" onClick={() => confirmThen('Pausar interrompe as sincronizações automáticas (pedidos, estoque, preços) e cancela as tarefas pendentes. Os dados históricos são mantidos e as notificações recebidas ficam guardadas até retomar. Continuar?', () => void act(() => post(current.id, 'pause'), 'Conexão pausada.'))}>Pausar</button>}
                <button className="btn" onClick={() => confirmThen('Desconectar apaga as credenciais do servidor, cancela as tarefas pendentes e encerra as notificações. Se o conector não revogar a autorização no canal (Mercado Livre: ainda não), revogue também em Minha conta → Aplicativos conectados. O histórico é mantido. Continuar?', () => void act(() => post(current.id, 'disconnect'), 'Conexão desconectada.'))}>Desconectar</button>
              </div>
            )}
          </div>

          {ov.attention.length > 0 && <div className="alert error">{ov.attention.map((a) => <div key={a}>{a}</div>)}</div>}
          <div className="grid cols-4" style={{ marginBottom: 12 }}>
            <div className="card stat"><div className="muted">Jobs concluídos</div><div className="n">{ov.jobs.SUCCEEDED ?? 0}</div></div>
            <div className="card stat"><div className="muted">Jobs com falha</div><div className="n">{(ov.jobs.FAILED ?? 0) + (ov.jobs.DEAD ?? 0)}</div></div>
            <div className="card stat"><div className="muted">Notificações pendentes</div><div className="n">{ov.webhooks.RECEIVED ?? 0}</div></div>
            <div className="card stat"><div className="muted">Resposta média (24h)</div><div className="n">{ov.responseMs.avg} ms</div></div>
          </div>
          <p className="muted">Próxima execução: {ov.nextScheduled ? `${new Date(ov.nextScheduled.runAt).toLocaleString('pt-BR')} (${ov.nextScheduled.type})` : 'nada agendado'} · token {current.tokenExpiresAt ? `expira em ${new Date(current.tokenExpiresAt).toLocaleString('pt-BR')}` : '—'}{current.lastError && <> · <span style={{ color: 'var(--danger)' }}>último erro: {current.lastError}</span></>}</p>

          {manage && !['DISCONNECTED'].includes(current.status) && (
            <form className="card" style={{ marginBottom: 16, background: 'var(--surface-2)' }} onSubmit={(e) => { e.preventDefault(); void saveConfig(current, new FormData(e.currentTarget)); }}>
              <h2>Regras de sincronização</h2>
              <div className="form-grid">
                <div><label htmlFor="wh">Depósito de origem *</label><select id="wh" name="warehouseId" defaultValue={current.warehouseId ?? ''}><option value="">Selecione…</option>{whs.map((w) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select></div>
                <div><label htmlFor="rm">Reconciliação a cada (min)</label><input id="rm" name="reconcileMinutes" type="number" min={5} max={1440} defaultValue={Number(current.config.reconcileMinutes ?? 15)} /></div>
                <div><label htmlFor="iid">Primeira importação: últimos (dias)</label><input id="iid" name="initialImportDays" type="number" min={1} max={60} defaultValue={Number(current.config.initialImportDays ?? 7)} /></div>
                <div><label htmlFor="ss">Estoque de segurança</label><input id="ss" name="safetyStock" type="number" min={0} defaultValue={current.config.safetyStock === undefined ? '' : Number(current.config.safetyStock)} /></div>
                <div><label htmlFor="cp">Cancelamentos</label><select id="cp" name="cancellationPolicy" defaultValue={String(current.config.cancellationPolicy ?? 'RELEASE_RESERVATION')}><option value="RELEASE_RESERVATION">Liberar reserva automaticamente</option><option value="MANUAL_REVIEW">Revisar manualmente</option></select></div>
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                {([['orderImport', 'Importar pedidos', true], ['stockSync', 'Atualizar estoque no canal', false], ['priceSync', 'Atualizar preços no canal', false]] as const).map(([k, l, d]) => (
                  <label key={k} className="row" style={{ fontWeight: 400, margin: 0 }}><input type="checkbox" name={k} defaultChecked={(current.config[k] as boolean | undefined) ?? d} style={{ width: 'auto' }} /> {l}</label>
                ))}
              </div>
              <p className="muted">Estas regras serão aplicadas pelos conectores a partir da Fase 5. Preço por canal, mapeamento de categorias e margens mínimas ainda não existem.</p>
              <button className="btn primary">Salvar</button>
              <button type="button" className="btn" style={{ marginLeft: 8 }} onClick={() => act(async () => setSecret(await api<{ path: string; secret: string }>(`/integrations/connections/${current.id}/webhook-secret`, 'POST')), 'Novo segredo de webhook gerado; o anterior deixou de valer.')}>Gerar novo segredo de webhook</button>
            </form>
          )}

          <h2>Produtos do canal</h2>
          <ChannelCatalog connectionId={current.id} supported={['SUPPORTED', 'IMPLEMENTED_UNVERIFIED'].includes(meta(current.provider)?.capabilities.catalog ?? 'PLANNED')} manage={manage && can('products.manage')} canImport={can('products.manage')} />

          <h2 style={{ marginTop: 24 }}>Anúncios e preços ({listings.length})</h2>
          <p className="muted">Estoque publicável = disponível do depósito − estoque de segurança (limitado pelo teto de publicação). Preço enviado = preço aprovado abaixo, revalidado no envio. O envio só acontece se o conector do canal implementar a operação — caso contrário o anúncio fica “Envio indisponível”, nunca “Sincronizado”.</p>
          {manage && (
            <form className="row" style={{ marginBottom: 8 }} onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void act(() => api(`/integrations/connections/${current.id}/listings`, 'POST', { productId: f.get('product'), externalItemId: String(f.get('item') ?? '').trim() || undefined }), 'Anúncio salvo.'); }}>
              <select name="product" aria-label="Produto" required style={{ width: 280 }}><option value="">Produto do ERP…</option>{products.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}</select>
              <input name="item" aria-label="ID do anúncio no canal" placeholder="ID do anúncio (opcional)" style={{ width: 220 }} />
              <button className="btn">Salvar anúncio</button>
              {['ACTIVE', 'SYNC_ERROR'].includes(current.status) && <button type="button" className="btn" onClick={() => act(async () => { await api(`/integrations/connections/${current.id}/sync`, 'POST'); }, 'Sincronização enfileirada.')}>Sincronizar agora</button>}
            </form>
          )}
          <div className="table-wrap"><table>
            <thead><tr><th>Produto</th><th>Anúncio</th><th>Disp.</th><th>Publicável</th><th>Preço aprovado</th><th>Margem</th><th>Enviado</th><th>Situação</th><th /></tr></thead>
            <tbody>
              {listings.length === 0 && <tr><td colSpan={9} className="empty">Nenhum anúncio cadastrado neste canal.</td></tr>}
              {listings.map((l) => (
                <tr key={l.productId}>
                  <td>{l.sku} — {l.name}</td><td>{l.externalItemId ?? <span className="muted">rascunho</span>}</td><td>{l.availableQty}</td><td><strong>{l.publishableQty}</strong></td>
                  <td className="num">{money(l.price)}</td><td>{l.margin ? `${l.margin.marginPct.toFixed(1)}%` : '—'}</td>
                  <td className="muted">{l.lastPublishedQty ?? '—'} un · {money(l.lastPublishedPrice)}</td>
                  <td>{l.syncStatus ? <span className={`badge ${SYNC[l.syncStatus][1]}`} title={l.syncError ?? ''}>{SYNC[l.syncStatus][0]}</span> : '—'}{l.syncError && <div className="muted">{l.syncError}</div>}</td>
                  <td>{can('pricing.manage') && <button className="btn sm" onClick={async () => {
                    const res = await ui.form({ title: `Preço aprovado — ${l.sku}`, confirmLabel: 'Definir preço', fields: [{ name: 'price', label: 'Novo preço aprovado (R$)', required: true, defaultValue: l.price?.toString() ?? '' }, { name: 'reason', label: 'Motivo da alteração', type: 'textarea', required: true }] });
                    if (!res) return;
                    const reason = res.reason;
                    const price = Number(res.price.replace(',', '.'));
                    void act(async () => {
                      try { await api(`/integrations/connections/${current.id}/listings/${l.productId}/price`, 'PUT', { price, reason }); }
                      catch (e) { if (/acima de 20%/.test((e as Error).message) && await ui.confirm({ title: 'Variação grande de preço', message: (e as Error).message + ' Confirmar mesmo assim?', confirmLabel: 'Confirmar' })) await api(`/integrations/connections/${current.id}/listings/${l.productId}/price`, 'PUT', { price, reason, confirmLargeChange: true }); else throw e; }
                    }, 'Preço aprovado e registrado no histórico.');
                  }}>Definir preço</button>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>

          {fees && can('pricing.view') && (
            <form className="card" style={{ margin: '16px 0', background: 'var(--surface-2)' }} onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const body = Object.fromEntries(FEE_LABELS.map(([k]) => [k, Number(String(f.get(k)).replace(',', '.')) || 0])); void act(() => api(`/integrations/connections/${current.id}/fees`, 'PUT', body), 'Perfil de tarifas salvo (registrado na auditoria).'); }}>
              <h2>Tarifas e margem mínima do canal</h2>
              <div className="form-grid">{FEE_LABELS.map(([k, label]) => <div key={k}><label htmlFor={`fee-${k}`}>{label}</label><input id={`fee-${k}`} name={k} inputMode="decimal" defaultValue={fees[k]} disabled={!can('pricing.manage')} /></div>)}</div>
              <p className="muted">Nada é presumido: informe as tarifas do seu contrato com o canal. Tributos aqui são apenas uma estimativa sua; o cálculo oficial virá do módulo Fiscal.</p>
              {can('pricing.manage') && <button className="btn primary">Salvar tarifas</button>}
            </form>
          )}

          <h2>Categorias do canal</h2>
          <p className="muted">Vincule categorias do ERP às categorias do canal (o identificador é informado por você; a consulta automática depende do conector).</p>
          {manage && (
            <form className="row" style={{ marginBottom: 8 }} onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void act(() => api(`/integrations/connections/${current.id}/category-map`, 'PUT', { categoryId: f.get('cat'), externalCategoryId: String(f.get('ext')).trim(), externalCategoryName: String(f.get('name') ?? '').trim() || undefined }), 'Categoria mapeada.'); }}>
              <select name="cat" aria-label="Categoria do ERP" required style={{ width: 220 }}><option value="">Categoria do ERP…</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
              <input name="ext" aria-label="ID da categoria no canal" placeholder="ID no canal (ex.: MLB1648)" required style={{ width: 200 }} />
              <input name="name" aria-label="Nome da categoria no canal" placeholder="Nome (opcional)" style={{ width: 200 }} />
              <button className="btn">Mapear</button>
            </form>
          )}
          <div className="table-wrap"><table>
            <thead><tr><th>Categoria do ERP</th><th>Categoria no canal</th><th /></tr></thead>
            <tbody>
              {catMap.length === 0 && <tr><td colSpan={3} className="empty">Nenhuma categoria mapeada.</td></tr>}
              {catMap.map((m) => <tr key={m.id}><td>{m.category.name}</td><td>{m.externalCategoryId}{m.externalCategoryName && <span className="muted"> · {m.externalCategoryName}</span>}</td><td>{manage && <button className="btn sm" onClick={() => act(async () => { await api(`/integrations/connections/${current.id}/category-map/${m.categoryId}`, 'DELETE'); }, 'Mapeamento removido.')}>Remover</button>}</td></tr>)}
            </tbody>
          </table></div>

          <h2 style={{ marginTop: 16 }}>Pedidos do canal ({orders.length})</h2>
          <p className="muted">Cada pedido pago vira um pedido de venda do ERP (origem Marketplace), com reserva de estoque. Pedidos que não puderam ser importados ficam aqui com o motivo.</p>
          {manage && orders.some((o) => o.status === 'NEEDS_ATTENTION') && (
            <div className="row" style={{ marginBottom: 8 }}>
              <button className="btn" onClick={() => act(async () => { await api(`/integrations/connections/${current.id}/orders/reprocess`, 'POST'); }, 'Pedidos pendentes reprocessados.')}>Reprocessar pendentes</button>
              <form className="row" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void act(() => api(`/integrations/connections/${current.id}/mappings`, 'POST', { externalItemId: String(f.get('item')).trim(), productId: f.get('product') }), 'Anúncio vinculado ao produto. Reprocesse os pendentes.'); }}>
                <input name="item" aria-label="ID do anúncio no canal" placeholder="ID do anúncio (ex.: MLB123…)" required style={{ width: 220 }} />
                <select name="product" aria-label="Produto" required style={{ width: 260 }}><option value="">Produto do ERP…</option>{products.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}</select>
                <button className="btn">Vincular anúncio</button>
              </form>
            </div>
          )}
          <div className="table-wrap"><table>
            <thead><tr><th>Pedido no canal</th><th>Situação no canal</th><th>No ERP</th><th>Motivo</th><th /></tr></thead>
            <tbody>
              {orders.length === 0 && <tr><td colSpan={5} className="empty">Nenhum pedido importado ainda.</td></tr>}
              {orders.map((o) => (
                <tr key={o.id}><td>{o.externalId}</td><td>{o.externalStatus ?? '—'}</td><td><span className={`badge ${LEDGER[o.status]?.[1] ?? ''}`}>{LEDGER[o.status]?.[0] ?? o.status}</span></td><td className="muted">{o.reason ?? ''}</td>
                  <td>{manage && o.status === 'NEEDS_ATTENTION' && <button className="btn sm" onClick={() => act(async () => { await api(`/integrations/connections/${current.id}/orders/${o.id}/reprocess`, 'POST'); }, 'Pedido reprocessado.')}>Reprocessar</button>}</td></tr>
              ))}
            </tbody>
          </table></div>

          <h2 style={{ marginTop: 16 }}>Tarefas recentes</h2>
          <div className="table-wrap"><table>
            <thead><tr><th>Tipo</th><th>Situação</th><th>Tentativas</th><th>Erro</th><th /></tr></thead>
            <tbody>
              {jobs.length === 0 && <tr><td colSpan={5} className="empty">Nenhuma tarefa ainda.</td></tr>}
              {jobs.map((j) => (
                <tr key={j.id}><td>{j.type}</td><td><span className={`badge ${j.status === 'SUCCEEDED' ? 'ok' : ['FAILED', 'DEAD'].includes(j.status) ? 'warn' : ''}`}>{j.status}</span></td><td>{j.attempts}/{j.maxAttempts}</td><td className="muted">{j.lastError ?? ''}</td>
                  <td>{manage && ['FAILED', 'DEAD'].includes(j.status) && <button className="btn sm" onClick={() => act(() => api(`/integrations/jobs/${j.id}/retry`, 'POST', {}), 'Tarefa reenfileirada.')}>Reprocessar</button>}</td></tr>
              ))}
            </tbody>
          </table></div>

          <h2 style={{ marginTop: 16 }}>Logs (segredos removidos)</h2>
          <div className="table-wrap"><table>
            <thead><tr><th>Quando</th><th>Nível</th><th>Operação</th><th>Mensagem</th><th>ms</th></tr></thead>
            <tbody>
              {logs.length === 0 && <tr><td colSpan={5} className="empty">Sem registros.</td></tr>}
              {logs.map((l) => <tr key={l.id}><td>{new Date(l.createdAt).toLocaleString('pt-BR')}</td><td><span className={`badge ${l.level === 'error' ? 'warn' : ''}`}>{l.level}</span></td><td>{l.operation}</td><td className="muted">{l.message}</td><td>{l.durationMs ?? ''}</td></tr>)}
            </tbody>
          </table></div>
        </section>
      )}
    </>
  );
}
