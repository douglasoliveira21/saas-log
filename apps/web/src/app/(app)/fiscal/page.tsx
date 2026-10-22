'use client';

import { Plus } from 'lucide-react';
import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { brl } from '@/lib/format';
import { useUi, PageHeader, Alert, Skeleton } from '@/components/ui';
import { formatAccessKey, formatCnpj } from '@/lib/format';
import { useSession } from '@/lib/session';
import { ProviderCard } from './provider-card';
import { CoverageCard } from './coverage-card';

type Tab = 'config' | 'inbound' | 'rules' | 'outgoing';
interface Est { id: string; name: string; cnpj: string | null; company: string; environment: string; configStatus: string; certificate: Cert | null }
interface Cert { id: string; subject: string; cnpj: string | null; serial: string; notAfter: string; daysToExpire: number; expired: boolean; expiringSoon: boolean }
interface ReadinessItem { key: string; label: string; status: 'OK' | 'PENDING' | 'BLOCKING'; detail?: string; blocksHomologation: boolean; blocksProduction: boolean }
interface ConfigView {
  establishment: { state: string | null };
  config: { environment: string; status: string; nfeSeries: number; accountantName: string | null; accountantEmail: string | null; approvedAt: string | null };
  certificate: Cert | null; readiness: ReadinessItem[]; readyForHomologation: boolean; readyForProduction: boolean; questionsForAccountant: string[];
}
interface Issue { severity: string; code: string; message: string }
interface InDoc { id: string; accessKey: string; number: number; series: number; status: string; emitterName: string; totalInvoice: string; environment: string; issues: Issue[]; supplierId: string | null }
interface InItem { id: string; line: number; supplierCode: string | null; description: string; unit: string; quantity: string; totalValue: string; ncm: string | null; productId: string | null; matchedBy: string | null; stockQty: number | null; product: { sku: string } | null }
interface RuleVersion { id: string; version: number; status: string; validFrom: string; validTo: string | null; sourceReference: string; config: { cfop?: string; taxes: Record<string, { ratePct?: number; cst?: string; csosn?: string; kind?: string }> } }
interface Rule { id: string; name: string; operation: string; originUf: string | null; destUf: string | null; ncmPrefix: string | null; regime: string | null; active: boolean; versions: RuleVersion[] }
interface OutDoc { id: string; model?: string; status: string; number: number | null; series: number | null; accessKey: string | null; environment: string; totalInvoice: string; issues: Issue[]; authProtocol: string | null; salesOrder: { number: number; customer: { name: string } } | null }
interface Product { id: string; sku: string; name: string }
interface PO { id: string; number: number; status: string; supplier: { legalName: string } }
interface OrderRow { id: string; number: number; status: string; fiscalDocType?: string; customer: { name: string } }

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Rascunho', PENDING_ACCOUNTANT: 'Aguardando contador', APPROVED: 'Validada', NOT_STARTED: 'Não iniciada', IMPORTED: 'Importada', RECEIVED: 'Recebida',
  PENDING_VALIDATION: 'Pendências', READY_TO_TRANSMIT: 'Pronta para transmitir', TRANSMITTING: 'Transmitindo', AUTHORIZED: 'Autorizada', REJECTED: 'Rejeitada',
  PENDING_CONSULT: 'Aguardando consulta', CANCELLED: 'Cancelada', COMMUNICATION_FAILURE: 'Falha de comunicação', PENDING_APPROVAL: 'Aguardando aprovação', SUPERSEDED: 'Substituída',
};
const badge = (s: string) => (['APPROVED', 'AUTHORIZED', 'RECEIVED', 'READY_TO_TRANSMIT', 'OK'].includes(s) ? 'ok' : ['REJECTED', 'PENDING_VALIDATION', 'PENDING_CONSULT', 'COMMUNICATION_FAILURE', 'BLOCKING'].includes(s) ? 'warn' : '');
const OPS = ['SALE', 'PURCHASE', 'RETURN_SALE', 'RETURN_PURCHASE', 'TRANSFER', 'OTHER'];
const sev = (s: string) => (s === 'BLOCKING' ? 'warn' : s === 'INFO' ? '' : 'warn');

function IssueList({ issues }: { issues: Issue[] }) {
  if (!issues?.length) return null;
  return <ul style={{ margin: '8px 0' }}>{issues.map((i, k) => <li key={k}><span className={`badge ${sev(i.severity)}`}>{i.severity === 'BLOCKING' ? 'impede' : i.severity === 'WARNING' ? 'atenção' : 'info'}</span> {i.message}</li>)}</ul>;
}

export default function FiscalPage() {
  const { can } = useSession();
  const [tab, setTab] = useState<Tab>('config');
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const act = async (fn: () => Promise<unknown>, message: string, reload: () => void) => {
    setError(''); setOk('');
    try { await fn(); setOk(message); reload(); } catch (e) { setError((e as Error).message); reload(); }
  };

  return (
    <>
      <PageHeader title="Fiscal" />
      <div className="alert">O sistema <strong>não traz alíquotas nem regras tributárias prontas</strong>: tudo é cadastrado e validado pelo seu contador. A <strong>transmissão para a SEFAZ ainda não está disponível</strong> (provedor pendente) e a autenticidade dos XML recebidos <strong>não é verificada</strong> por este sistema.</div>
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}
      <div className="tabs" role="tablist" aria-label="Seções do fiscal">
        {([['config', 'Configuração e certificado'], ['inbound', 'XML recebidos'], ['rules', 'Regras tributárias'], ['outgoing', 'Notas de saída']] as [Tab, string][]).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => { setTab(k); setError(''); setOk(''); }}>{l}</button>
        ))}
      </div>
      {tab === 'config' && <ConfigTab act={act} can={can} />}
      {tab === 'inbound' && <InboundTab act={act} can={can} />}
      {tab === 'rules' && <RulesTab act={act} can={can} />}
      {tab === 'outgoing' && <OutgoingTab act={act} can={can} />}
    </>
  );
}

type TabProps = { act: (fn: () => Promise<unknown>, m: string, r: () => void) => Promise<void>; can: (p?: string) => boolean };

function ConfigTab({ act, can }: TabProps) {
  const ui = useUi();
  const [ests, setEsts] = useState<Est[]>([]);
  const [sel, setSel] = useState('');
  const [view, setView] = useState<ConfigView | null>(null);
  const load = useCallback(() => { api<Est[]>('/fiscal/establishments').then((e) => { setEsts(e); setSel((s) => s || e[0]?.id || ''); }).catch(() => undefined); }, []);
  const loadView = useCallback(() => { if (sel) api<ConfigView>(`/fiscal/establishments/${sel}/config`).then(setView).catch(() => setView(null)); }, [sel]);
  useEffect(load, [load]);
  useEffect(loadView, [loadView]);
  const reload = () => { load(); loadView(); };
  const manage = can('fiscal.manage');

  async function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const file = f.get('pfx') as File;
    const password = String(f.get('password'));
    const form = e.currentTarget;
    const b64 = btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())));
    await act(async () => { await api(`/fiscal/establishments/${sel}/certificate`, 'POST', { pfxBase64: b64, password }); form.reset(); }, 'Certificado validado e guardado com criptografia.', reload);
  }

  if (!ests.length) return <div className="card empty">Cadastre um estabelecimento em “Empresa e depósitos” para configurar o fiscal.</div>;
  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <label htmlFor="est">Estabelecimento</label>
        <select id="est" value={sel} onChange={(e) => setSel(e.target.value)} style={{ maxWidth: 420 }}>{ests.map((e) => <option key={e.id} value={e.id}>{e.name} — {e.company} ({STATUS_LABEL[e.configStatus]})</option>)}</select>
      </div>
      {view && (
        <div className="grid cols-2">
          <section className="card">
            <h2>Assistente: o que falta</h2>
            <p>
              <span className={`badge ${view.readyForHomologation ? 'ok' : 'warn'}`}>{view.readyForHomologation ? 'Apto para homologação' : 'Não apto para homologação'}</span>{' '}
              <span className={`badge ${view.readyForProduction ? 'ok' : 'warn'}`}>{view.readyForProduction ? 'Apto para produção' : 'Impedido para produção'}</span>
            </p>
            <ul className="checklist">
              {view.readiness.map((i) => (
                <li key={i.key}><span className={`tick ${i.status === 'OK' ? 'done' : ''}`}>{i.status === 'OK' ? '✓' : ''}</span>
                  <span>{i.label}{i.status !== 'OK' && <div className="muted">{i.detail} {i.blocksHomologation ? '· impede homologação' : ''} {i.blocksProduction ? '· impede produção' : ''}</div>}</span></li>
              ))}
            </ul>
          </section>
          <section className="card">
            <h2>Parâmetros e validação do contador</h2>
            <form onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void act(() => api(`/fiscal/establishments/${sel}/config`, 'PUT', { environment: f.get('env'), nfeSeries: Number(f.get('series')), accountantName: f.get('an') || undefined, accountantEmail: f.get('ae') || undefined }), 'Configuração salva — a validação do contador foi reaberta.', reload); }}>
              <div className="form-grid">
                <div><label htmlFor="env">Ambiente</label><select id="env" name="env" defaultValue={view.config.environment} disabled={!manage}><option value="HOMOLOGACAO">Homologação (sem valor fiscal)</option><option value="PRODUCAO">Produção</option></select></div>
                <div><label htmlFor="series">Série da NF-e</label><input id="series" name="series" type="number" min={1} defaultValue={view.config.nfeSeries} disabled={!manage} /></div>
                <div><label htmlFor="an">Contador responsável</label><input id="an" name="an" defaultValue={view.config.accountantName ?? ''} disabled={!manage} /></div>
                <div><label htmlFor="ae">E-mail do contador</label><input id="ae" name="ae" type="email" defaultValue={view.config.accountantEmail ?? ''} disabled={!manage} /></div>
              </div>
              <p><span className={`badge ${badge(view.config.status)}`}>{STATUS_LABEL[view.config.status]}</span> {view.config.approvedAt && <span className="muted">validada em {new Date(view.config.approvedAt).toLocaleString('pt-BR')}</span>}</p>
              <div className="row">
                {manage && <button className="btn primary">Salvar</button>}
                {manage && view.config.status === 'DRAFT' && <button type="button" className="btn" onClick={() => act(() => api(`/fiscal/establishments/${sel}/config/submit`, 'POST'), 'Enviada para validação do contador.', reload)}>Enviar ao contador</button>}
                {can('fiscal.approve') && view.config.status === 'PENDING_ACCOUNTANT' && <>
                  <button type="button" className="btn primary" onClick={() => act(() => api(`/fiscal/establishments/${sel}/config/approve`, 'POST'), 'Configuração validada.', reload)}>Validar (contador)</button>
                  <button type="button" className="btn" onClick={async () => { const r = await ui.prompt({ title: 'Devolver configuração', label: 'Motivo da devolução', multiline: true, confirmLabel: 'Devolver' }); if (r) void act(() => api(`/fiscal/establishments/${sel}/config/reject`, 'POST', { reason: r }), 'Configuração devolvida.', reload); }}>Devolver</button>
                </>}
              </div>
            </form>
          </section>
          <section className="card">
            <h2>Certificado digital A1</h2>
            {view.certificate ? (
              <p>{view.certificate.subject}<br /><span className="muted">CNPJ {view.certificate.cnpj ? formatCnpj(view.certificate.cnpj) : '—'} · série {view.certificate.serial} · vence em {new Date(view.certificate.notAfter).toLocaleDateString('pt-BR')} ({view.certificate.daysToExpire} dia(s))</span>{view.certificate.expiringSoon && <span className="badge warn" style={{ marginLeft: 8 }}>vence em breve</span>}</p>
            ) : <p className="muted">Nenhum certificado cadastrado.</p>}
            {manage && (
              <form onSubmit={upload}>
                <div className="field"><label htmlFor="pfx">Arquivo .pfx / .p12 (A1)</label><input id="pfx" name="pfx" type="file" accept=".pfx,.p12" required /></div>
                <div className="field"><label htmlFor="pw">Senha do certificado</label><input id="pw" name="password" type="password" autoComplete="off" required /></div>
                <button className="btn primary">{view.certificate ? 'Substituir certificado' : 'Enviar certificado'}</button>
                <p className="muted">O arquivo e a senha são cifrados no servidor e nunca voltam ao navegador. O certificado anterior é apagado ao ser substituído.</p>
              </form>
            )}
          </section>
          <ProviderCard establishmentId={sel} uf={view.establishment.state} manage={manage} onChange={reload} />
          <CoverageCard />
          <section className="card">
            <h2>Perguntas para o contador</h2>
            <ul>{view.questionsForAccountant.map((q) => <li key={q}>{q}</li>)}</ul>
            <button className="btn sm" onClick={() => void navigator.clipboard.writeText(view.questionsForAccountant.map((q, i) => `${i + 1}. ${q}`).join('\n'))}>Copiar lista</button>
          </section>
        </div>
      )}
    </>
  );
}

function InboundTab({ act, can }: TabProps) {
  const ui = useUi();
  const [docs, setDocs] = useState<InDoc[] | null>(null);
  const [sel, setSel] = useState<(InDoc & { items: InItem[]; supplier: { legalName: string } | null }) | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [pos, setPos] = useState<PO[]>([]);
  const [po, setPo] = useState('');
  const [rec, setRec] = useState<any>(null);
  const [xml, setXml] = useState('');
  const load = useCallback(() => { api<InDoc[]>('/fiscal/inbound').then(setDocs).catch(() => setDocs([])); }, []);
  const open = useCallback(async (id: string) => { setRec(null); setPo(''); setSel(await api(`/fiscal/inbound/${id}`)); }, []);
  useEffect(() => {
    load();
    api<{ items: Product[] }>('/products?limit=200').then((r) => setProducts(r.items)).catch(() => undefined);
    api<{ items: PO[] }>('/purchases?limit=100').then((r) => setPos(r.items.filter((p) => ['APPROVED', 'PARTIALLY_RECEIVED'].includes(p.status)))).catch(() => undefined);
  }, [load]);
  const reload = () => { load(); if (sel) void open(sel.id); };
  const import_ = (text: string) => act(async () => { const r = await api<{ id: string }>('/fiscal/inbound/import', 'POST', { xml: text }); setXml(''); await open(r.id); }, 'XML importado.', load);
  const onFile = (e: ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (f) void f.text().then(setXml); };

  return (
    <>
      {can('fiscal.import') && (
        <section className="card" style={{ marginBottom: 16 }}>
          <h2>Importar NF-e recebida</h2>
          <input type="file" accept=".xml,text/xml" onChange={onFile} aria-label="Arquivo XML" style={{ width: 'auto' }} />
          <textarea aria-label="Conteúdo do XML" value={xml} onChange={(e) => setXml(e.target.value)} rows={4} style={{ width: '100%', marginTop: 8, fontFamily: 'monospace' }} />
          <button className="btn primary" disabled={!xml} onClick={() => import_(xml)} style={{ marginTop: 8 }}>Validar e importar</button>
          <p className="muted">Validamos a estrutura, a chave de acesso, o destinatário, o protocolo e os totais. A assinatura digital e a situação na SEFAZ não são verificadas aqui.</p>
        </section>
      )}
      <section className="card" style={{ marginBottom: 16 }}>
        <div className="table-wrap"><table>
          <thead><tr><th>Nº/Série</th><th>Emitente</th><th>Valor</th><th>Ambiente</th><th>Situação</th><th /></tr></thead>
          <tbody>
            {!docs && <tr><td colSpan={6}><Skeleton rows={3} /></td></tr>}
            {docs?.length === 0 && <tr><td colSpan={6} className="empty">Nenhuma nota importada.</td></tr>}
            {docs?.map((d) => <tr key={d.id}><td>{d.number}/{d.series}</td><td>{d.emitterName}</td><td className="num">{brl(d.totalInvoice)}</td><td>{d.environment === 'HOMOLOGACAO' ? <span className="badge warn">homologação</span> : 'produção'}</td><td><span className={`badge ${badge(d.status)}`}>{STATUS_LABEL[d.status]}</span></td><td><button className="btn sm" onClick={() => open(d.id)}>Abrir</button></td></tr>)}
          </tbody>
        </table></div>
      </section>
      {sel && (
        <section className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2>NF-e {sel.number}/{sel.series} — {sel.emitterName}</h2>
            {!sel.supplierId && can('suppliers.manage') && <button className="btn" onClick={() => act(() => api(`/fiscal/inbound/${sel.id}/supplier`, 'POST'), 'Fornecedor cadastrado a partir do emitente.', reload)}>Cadastrar fornecedor</button>}
          </div>
          <p className="muted">Chave <span className="mono">{formatAccessKey(sel.accessKey)}</span> · fornecedor {sel.supplier?.legalName ?? 'não vinculado'}</p>
          <IssueList issues={sel.issues} />
          <div className="table-wrap"><table>
            <thead><tr><th>#</th><th>Código</th><th>Descrição</th><th>Qtd. XML</th><th>Un.</th><th>Total</th><th>NCM</th><th>Produto do ERP</th><th>Estoque</th></tr></thead>
            <tbody>
              {sel.items.map((i) => (
                <tr key={i.id}><td>{i.line}</td><td>{i.supplierCode}</td><td>{i.description}</td><td>{Number(i.quantity)}</td><td>{i.unit}</td><td className="num">{brl(i.totalValue)}</td><td>{i.ncm ?? '—'}</td>
                  <td>{sel.status === 'IMPORTED' && can('fiscal.import')
                    ? <select aria-label={`Produto do item ${i.line}`} value={i.productId ?? ''} onChange={(e) => e.target.value && act(() => api(`/fiscal/inbound/${sel.id}/items/${i.line}/product`, 'PUT', { productId: e.target.value }), 'Item vinculado.', reload)}><option value="">Vincular…</option>{products.map((p) => <option key={p.id} value={p.id}>{p.sku}</option>)}</select>
                    : (i.product?.sku ?? '—')} {i.matchedBy && <span className="badge">{i.matchedBy}</span>}</td>
                  <td>{i.stockQty ?? <span className="badge warn">revisar</span>}</td></tr>
              ))}
            </tbody>
          </table></div>
          {sel.status === 'IMPORTED' && can('fiscal.import') && (
            <div style={{ marginTop: 12 }}>
              <h2>Conciliar com ordem de compra</h2>
              <div className="row">
                <select aria-label="Ordem de compra" value={po} onChange={async (e) => { setPo(e.target.value); setRec(e.target.value ? await api(`/fiscal/inbound/${sel.id}/reconcile?purchaseOrderId=${e.target.value}`).catch((er: Error) => ({ error: er.message })) : null); }} style={{ maxWidth: 360 }}>
                  <option value="">Selecione…</option>{pos.map((p) => <option key={p.id} value={p.id}>OC {p.number} — {p.supplier.legalName}</option>)}
                </select>
              </div>
              {rec?.error && <div className="alert error">{rec.error}</div>}
              {rec?.lines && (
                <>
                  <div className="table-wrap"><table>
                    <thead><tr><th>Item</th><th>Situação</th><th>Detalhe</th><th>Qtd. NF</th><th>Pendente OC</th><th>Custo NF</th><th>Custo OC</th></tr></thead>
                    <tbody>{rec.lines.map((l: any) => <tr key={l.line}><td>{l.line}</td><td><span className={`badge ${l.status === 'OK' ? 'ok' : 'warn'}`}>{l.status}</span></td><td className="muted">{l.detail}</td><td>{l.nfQty ?? '—'}</td><td>{l.poPending ?? '—'}</td><td>{l.nfUnitCost ?? '—'}</td><td>{l.poUnitCost ?? '—'}</td></tr>)}</tbody>
                  </table></div>
                  {rec.notDelivered?.length > 0 && <p className="muted">Itens da OC não constantes na nota: {rec.notDelivered.map((n: any) => `${n.sku} (${n.pending})`).join(', ')}.</p>}
                  {rec.blockers?.length > 0 && <div className="alert error">{rec.blockers.map((b: string) => <div key={b}>{b}</div>)}</div>}
                  {can('purchases.receive') && <button className="btn primary" disabled={!rec.canReceive} onClick={async () => {
                    const accept = rec.costDivergent ? await ui.confirm({ title: 'Divergência de custo', message: 'Há divergência de custo em relação à ordem de compra. Receber mesmo assim, com o custo da nota?', confirmLabel: 'Receber com o custo da nota' }) : undefined;
                    if (rec.costDivergent && !accept) return;
                    void act(() => api(`/fiscal/inbound/${sel.id}/receive`, 'POST', { purchaseOrderId: po, acceptCostDivergence: accept }), 'Recebimento registrado e estoque atualizado.', reload);
                  }}>Receber mercadoria</button>}
                </>
              )}
            </div>
          )}
        </section>
      )}
    </>
  );
}

function RulesTab({ act, can }: TabProps) {
  const ui = useUi();
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [calc, setCalc] = useState<any>(null);
  const load = useCallback(() => { api<Rule[]>('/fiscal/rules').then(setRules).catch(() => setRules([])); }, []);
  useEffect(load, [load]);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const n = (k: string) => (String(f.get(k) ?? '').trim() === '' ? undefined : Number(String(f.get(k)).replace(',', '.')));
    const taxes: Record<string, object> = {};
    for (const code of ['ICMS', 'IPI', 'PIS', 'COFINS']) {
      const rate = n(`${code}_rate`);
      if (rate !== undefined) taxes[code] = { ratePct: rate, ...(f.get(`${code}_cst`) ? { [code === 'ICMS' && String(f.get(`${code}_cst`)).length === 3 ? 'csosn' : 'cst']: String(f.get(`${code}_cst`)) } : {}), ...(n(`${code}_red`) !== undefined ? { baseReductionPct: n(`${code}_red`) } : {}) };
    }
    const form = e.currentTarget;
    await act(async () => {
      await api('/fiscal/rules', 'POST', {
        rule: { name: f.get('name'), operation: f.get('op'), originUf: f.get('ouf') || undefined, destUf: f.get('duf') || undefined, ncmPrefix: f.get('ncm') || undefined, regime: f.get('regime') || undefined },
        version: { validFrom: new Date(String(f.get('from'))).toISOString(), sourceReference: f.get('src'), config: { cfop: f.get('cfop') || undefined, includeFreightInBase: f.get('frete') === 'on', taxes } },
      });
      form.reset(); setAdding(false);
    }, 'Regra criada como rascunho. Envie para aprovação do contador.', load);
  }

  async function simulate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      setCalc(await api('/fiscal/engine/calculate', 'POST', { operation: f.get('op'), originUf: f.get('ouf'), destUf: f.get('duf'), regime: f.get('regime') || undefined, date: new Date(String(f.get('date'))).toISOString(), items: [{ key: '1', ncm: f.get('ncm'), value: Number(String(f.get('value')).replace(',', '.')) }] }));
    } catch (er) { setCalc({ error: (er as Error).message }); }
  }
  const summary = (v: RuleVersion) => Object.entries(v.config.taxes).map(([c, p]) => `${c} ${p.kind && p.kind !== 'PERCENT' ? p.kind : `${p.ratePct}%`}${p.cst ? ` CST ${p.cst}` : ''}${p.csosn ? ` CSOSN ${p.csosn}` : ''}`).join(' · ');

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <p className="muted">Regras são do seu contador: cada versão tem vigência, fonte (base legal/parecer) e só vale depois de aprovada por outra pessoa. Versão aprovada nunca é alterada — cria-se uma nova. O motor ainda <strong>não calcula ST, DIFAL e FCP</strong> (vira pendência).</p>
        {can('fiscal.rules') && <button className="btn primary" onClick={() => setAdding(true)}><Plus aria-hidden />Regra</button>}
      </div>
      {adding && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={create}>
          <h2>Nova regra (rascunho)</h2>
          <div className="form-grid">
            <div><label htmlFor="rn">Nome *</label><input id="rn" name="name" required /></div>
            <div><label htmlFor="op">Operação *</label><select id="op" name="op">{OPS.map((o) => <option key={o}>{o}</option>)}</select></div>
            <div><label htmlFor="ouf">UF de origem</label><input id="ouf" name="ouf" maxLength={2} /></div>
            <div><label htmlFor="duf">UF de destino</label><input id="duf" name="duf" maxLength={2} /></div>
            <div><label htmlFor="rncm">NCM (prefixo)</label><input id="rncm" name="ncm" inputMode="numeric" /></div>
            <div><label htmlFor="rreg">Regime</label><select id="rreg" name="regime" defaultValue=""><option value="">Qualquer</option><option>SIMPLES_NACIONAL</option><option>LUCRO_PRESUMIDO</option><option>LUCRO_REAL</option><option>MEI</option></select></div>
            <div><label htmlFor="from">Vigência a partir de *</label><input id="from" name="from" type="date" required /></div>
            <div><label htmlFor="cfop">CFOP</label><input id="cfop" name="cfop" maxLength={4} inputMode="numeric" /></div>
          </div>
          <h2 style={{ marginTop: 12 }}>Tributos (valores definidos pelo contador)</h2>
          {['ICMS', 'IPI', 'PIS', 'COFINS'].map((c) => (
            <div className="row" key={c} style={{ marginBottom: 6 }}>
              <strong style={{ width: 70 }}>{c}</strong>
              <input name={`${c}_cst`} placeholder={c === 'ICMS' ? 'CST (2) ou CSOSN (3)' : 'CST'} style={{ width: 170 }} aria-label={`${c} CST`} />
              <input name={`${c}_rate`} placeholder="Alíquota %" inputMode="decimal" style={{ width: 120 }} aria-label={`${c} alíquota`} />
              <input name={`${c}_red`} placeholder="Redução de base %" inputMode="decimal" style={{ width: 150 }} aria-label={`${c} redução de base`} />
            </div>
          ))}
          <label className="row" style={{ fontWeight: 400 }}><input type="checkbox" name="frete" style={{ width: 'auto' }} /> Incluir frete na base</label>
          <div className="field"><label htmlFor="src">Fonte / base legal / parecer do contador * (mín. 10 caracteres)</label><input id="src" name="src" required minLength={10} /></div>
          <div className="row"><button className="btn primary">Salvar rascunho</button><button type="button" className="btn" onClick={() => setAdding(false)}>Cancelar</button></div>
        </form>
      )}
      <section className="card" style={{ marginBottom: 16 }}>
        <div className="table-wrap"><table>
          <thead><tr><th>Regra</th><th>Escopo</th><th>Versão</th><th>Situação</th><th>Vigência</th><th>Parâmetros</th><th /></tr></thead>
          <tbody>
            {!rules && <tr><td colSpan={7}><Skeleton rows={3} /></td></tr>}
            {rules?.length === 0 && <tr><td colSpan={7} className="empty">Nenhuma regra cadastrada. Sem regra aprovada, o motor devolve pendência — nunca uma alíquota presumida.</td></tr>}
            {rules?.flatMap((r) => r.versions.map((v, idx) => (
              <tr key={v.id} style={r.active ? undefined : { opacity: 0.55 }}>
                <td>{idx === 0 && <strong>{r.name}</strong>}</td><td className="muted">{idx === 0 && [r.operation, r.originUf && `de ${r.originUf}`, r.destUf && `para ${r.destUf}`, r.ncmPrefix && `NCM ${r.ncmPrefix}*`, r.regime].filter(Boolean).join(' · ')}</td>
                <td>v{v.version}</td><td><span className={`badge ${badge(v.status)}`}>{STATUS_LABEL[v.status]}</span></td>
                <td className="muted">{new Date(v.validFrom).toLocaleDateString('pt-BR')} → {v.validTo ? new Date(v.validTo).toLocaleDateString('pt-BR') : 'em aberto'}</td>
                <td className="muted">{v.config.cfop && `CFOP ${v.config.cfop} · `}{summary(v)}<div>{v.sourceReference}</div></td>
                <td>
                  {v.status === 'DRAFT' && can('fiscal.rules') && <button className="btn sm" onClick={() => act(() => api(`/fiscal/rules/versions/${v.id}/submit`, 'POST'), 'Enviada para aprovação.', load)}>Enviar p/ aprovação</button>}
                  {v.status === 'PENDING_APPROVAL' && can('fiscal.approve') && <>
                    <button className="btn sm primary" onClick={() => act(() => api(`/fiscal/rules/versions/${v.id}/approve`, 'POST'), 'Versão aprovada.', load)}>Aprovar</button>{' '}
                    <button className="btn sm" onClick={async () => { const re = await ui.prompt({ title: 'Devolver a rascunho', label: 'Motivo', multiline: true, confirmLabel: 'Devolver' }); if (re) void act(() => api(`/fiscal/rules/versions/${v.id}/reject`, 'POST', { reason: re }), 'Devolvida a rascunho.', load); }}>Devolver</button>
                  </>}
                  {idx === 0 && can('fiscal.rules') && <button className="btn sm" onClick={() => act(() => api(`/fiscal/rules/${r.id}/active`, 'PUT', { active: !r.active }), r.active ? 'Regra desativada.' : 'Regra ativada.', load)}>{r.active ? 'Desativar' : 'Ativar'}</button>}
                </td>
              </tr>
            )))}
          </tbody>
        </table></div>
      </section>
      <form className="card" onSubmit={simulate}>
        <h2>Simular o motor</h2>
        <div className="form-grid">
          <div><label htmlFor="sop">Operação</label><select id="sop" name="op">{OPS.map((o) => <option key={o}>{o}</option>)}</select></div>
          <div><label htmlFor="souf">UF origem</label><input id="souf" name="ouf" maxLength={2} required /></div>
          <div><label htmlFor="sduf">UF destino</label><input id="sduf" name="duf" maxLength={2} required /></div>
          <div><label htmlFor="sreg">Regime</label><select id="sreg" name="regime" defaultValue=""><option value="">—</option><option>SIMPLES_NACIONAL</option><option>LUCRO_PRESUMIDO</option><option>LUCRO_REAL</option><option>MEI</option></select></div>
          <div><label htmlFor="sncm">NCM</label><input id="sncm" name="ncm" required inputMode="numeric" /></div>
          <div><label htmlFor="sval">Valor (R$)</label><input id="sval" name="value" required inputMode="decimal" /></div>
          <div><label htmlFor="sdt">Data do documento</label><input id="sdt" name="date" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} /></div>
        </div>
        <button className="btn" style={{ marginTop: 10 }}>Calcular</button>
        {calc?.error && <div className="alert error" style={{ marginTop: 10 }}>{calc.error}</div>}
        {calc && !calc.error && (
          <div style={{ marginTop: 10 }}>
            <p><span className={`badge ${calc.ready ? 'ok' : 'warn'}`}>{calc.ready ? 'Calculado' : 'Com pendências'}</span> motor v{calc.engineVersion}</p>
            {calc.pendencies.map((p: any, i: number) => <div key={i} className="alert error">{p.message}</div>)}
            {calc.items.map((i: any) => <p key={i.key}>CFOP {i.cfop ?? '—'}: {Object.entries(i.taxes).map(([c, t]: any) => `${c} ${t.amount.toFixed(2)} (base ${t.base.toFixed(2)} × ${t.ratePct}%)`).join(' · ') || '—'}</p>)}
            {calc.rulesUsed.map((r: any) => <p key={r.versionId} className="muted">Regra “{r.name}” v{r.version} — {r.sourceReference}</p>)}
          </div>
        )}
      </form>
    </>
  );
}

interface VoidRow { id: string; model: string; series: number; fromNumber: number; toNumber: number; environment: string; protocol: string; reason: string; createdAt: string }
/** Inutilização de faixa de numeração (emissão direta na SEFAZ): só numeração que nunca virou nota. */
function VoidCard({ act }: Pick<TabProps, 'act'>) {
  const [ests, setEsts] = useState<Est[]>([]);
  const [rows, setRows] = useState<VoidRow[]>([]);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => { api<VoidRow[]>('/fiscal/inutilizacao').then(setRows).catch(() => undefined); }, []);
  useEffect(() => { load(); api<Est[]>('/fiscal/establishments').then(setEsts).catch(() => undefined); }, [load]);
  return (
    <section className="card" style={{ marginBottom: 16 }} aria-label="Inutilização de numeração">
      <div className="card-head"><h2>Inutilizar numeração</h2><button className="btn sm" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Fechar' : 'Abrir'}</button></div>
      {open && (
        <>
          <p className="muted" style={{ marginTop: 0 }}>Use quando um número foi pulado e não vai virar nota. Só vale para a emissão direta na SEFAZ e a SEFAZ precisa confirmar. Não dá para inutilizar número de nota já emitida.</p>
          <form onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void act(async () => { await api('/fiscal/inutilizacao', 'POST', { establishmentId: f.get('est'), model: f.get('model'), series: Number(f.get('series')), from: Number(f.get('from')), to: Number(f.get('to')), reason: f.get('reason') }); }, 'Numeração inutilizada e registrada.', load); }}>
            <div className="form-grid">
              <div><label htmlFor="ve">Estabelecimento</label><select id="ve" name="est" required>{ests.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></div>
              <div><label htmlFor="vm">Documento</label><select id="vm" name="model"><option value="55">NF-e (55)</option><option value="65">NFC-e (65)</option></select></div>
              <div><label htmlFor="vs">Série</label><input id="vs" name="series" inputMode="numeric" defaultValue="1" required /></div>
              <div><label htmlFor="vf">Do número</label><input id="vf" name="from" inputMode="numeric" required /></div>
              <div><label htmlFor="vt">Até o número</label><input id="vt" name="to" inputMode="numeric" required /></div>
              <div style={{ gridColumn: '1 / -1' }}><label htmlFor="vr">Justificativa (15 a 255 caracteres)</label><input id="vr" name="reason" minLength={15} maxLength={255} required /></div>
            </div>
            <div className="row" style={{ marginTop: 12 }}><button className="btn primary">Inutilizar</button></div>
          </form>
          {rows.length > 0 && <div className="table-wrap" style={{ marginTop: 12 }}><table><thead><tr><th>Modelo</th><th>Série</th><th>Faixa</th><th>Protocolo</th><th>Ambiente</th></tr></thead><tbody>{rows.map((r) => <tr key={r.id}><td>{r.model}</td><td>{r.series}</td><td>{r.fromNumber}–{r.toNumber}</td><td className="mono">{r.protocol}</td><td>{r.environment}</td></tr>)}</tbody></table></div>}
        </>
      )}
    </section>
  );
}

function OutgoingTab({ act, can }: TabProps) {
  const ui = useUi();
  const [docs, setDocs] = useState<OutDoc[] | null>(null);
  const [sel, setSel] = useState<(OutDoc & { items: { line: number; description: string; ncm: string | null; cfop: string | null; totalValue: string; declaredTax: { taxes?: Record<string, { amount: number }> } }[] }) | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const load = useCallback(() => { api<OutDoc[]>('/fiscal/outgoing').then(setDocs).catch(() => setDocs([])); }, []);
  const open = useCallback(async (id: string) => setSel(await api(`/fiscal/outgoing/${id}`)), []);
  useEffect(() => {
    load();
    api<{ items: OrderRow[] }>('/sales/orders?limit=100').then((r) => setOrders(r.items.filter((o) => !['DRAFT', 'PENDING_APPROVAL', 'CANCELLED'].includes(o.status)))).catch(() => undefined);
  }, [load]);
  const reload = () => { load(); if (sel) void open(sel.id); };
  const emit = can('fiscal.emit');

  return (
    <>
      <div className="alert info">A nota é preparada e validada aqui (destinatário, regras e impostos) e <strong>transmitida à SEFAZ pelo provedor</strong> configurado na aba Configuração (Focus NFe). Sem o token do provedor, “Transmitir” informa a pendência e não consome numeração. Comece sempre pela <strong>homologação</strong>: só o ambiente de produção tem valor fiscal.</div>
      {emit && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void act(async () => { const r = await api<{ id: string }>('/fiscal/outgoing/prepare', 'POST', { salesOrderId: f.get('order'), ...(f.get('model') ? { model: f.get('model') } : {}), ...(f.get('pay') ? { paymentMethod: f.get('pay') } : {}) }); await open(r.id); }, 'Nota preparada.', load); }}>
          <h2>Preparar nota a partir de um pedido</h2>
          <div className="row"><select name="order" required aria-label="Pedido" style={{ maxWidth: 420 }}><option value="">Pedido…</option>{orders.map((o) => <option key={o.id} value={o.id}>Pedido {o.number} — {o.customer.name} ({o.status})</option>)}</select><select name="model" aria-label="Documento" style={{ maxWidth: 220 }} defaultValue=""><option value="">Documento: o escolhido na venda</option><option value="55">NF-e (modelo 55)</option><option value="65">NFC-e (modelo 65)</option></select><select name="pay" aria-label="Forma de pagamento" style={{ maxWidth: 220 }} defaultValue=""><option value="">Forma de pagamento…</option><option value="CASH">Dinheiro</option><option value="PIX">PIX</option><option value="CREDIT">Cartão de crédito</option><option value="DEBIT">Cartão de débito</option><option value="BOLETO">Boleto</option><option value="CHECK">Cheque</option><option value="OTHER">Outros</option></select><button className="btn primary">Preparar</button></div>
          <p className="muted" style={{ marginBottom: 0, fontSize: '0.82rem' }}>A forma de pagamento é obrigatória para emitir (NFC-e e NF-e pelo provedor).</p>
        </form>
      )}
      {emit && <VoidCard act={act} />}
      <section className="card" style={{ marginBottom: 16 }}>
        <div className="table-wrap"><table>
          <thead><tr><th>Pedido</th><th>Cliente</th><th>Nº/Série</th><th>Valor</th><th>Ambiente</th><th>Situação</th><th /></tr></thead>
          <tbody>
            {!docs && <tr><td colSpan={7}><Skeleton rows={3} /></td></tr>}
            {docs?.length === 0 && <tr><td colSpan={7} className="empty">Nenhuma nota de saída preparada.</td></tr>}
            {docs?.map((d) => <tr key={d.id}><td>{d.salesOrder?.number}</td><td>{d.salesOrder?.customer.name}</td><td>{d.number ? `${d.number}/${d.series}` : '—'}</td><td className="num">{brl(d.totalInvoice)}</td><td>{d.environment}</td><td><span className={`badge ${badge(d.status)}`}>{STATUS_LABEL[d.status]}</span></td><td><button className="btn sm" onClick={() => open(d.id)}>Abrir</button></td></tr>)}
          </tbody>
        </table></div>
      </section>
      {sel && (
        <section className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2>Pedido {sel.salesOrder?.number} <span className={`badge ${badge(sel.status)}`}>{STATUS_LABEL[sel.status]}</span></h2>
            {emit && (
              <div className="row">
                {['PENDING_VALIDATION', 'READY_TO_TRANSMIT', 'REJECTED'].includes(sel.status) && <button className="btn" onClick={() => act(() => api(`/fiscal/outgoing/${sel.id}/revalidate`, 'POST'), 'Documento revalidado.', reload)}>Revalidar</button>}
                {['READY_TO_TRANSMIT', 'COMMUNICATION_FAILURE'].includes(sel.status) && <button className="btn primary" onClick={async () => { if (await ui.confirm({ title: 'Transmitir nota?', message: `A nota será enviada à SEFAZ pelo provedor no ambiente de ${sel.environment === 'PRODUCAO' ? 'PRODUÇÃO (tem valor fiscal)' : 'homologação (sem valor fiscal)'}. Só pode ser desfeita por cancelamento.`, confirmLabel: 'Transmitir' })) void act(() => api(`/fiscal/outgoing/${sel.id}/transmit`, 'POST'), 'Resultado da transmissão registrado.', reload); }}>Transmitir</button>}
                {['PENDING_CONSULT', 'COMMUNICATION_FAILURE'].includes(sel.status) && <button className="btn" onClick={() => act(() => api(`/fiscal/outgoing/${sel.id}/consult`, 'POST'), 'Consulta realizada.', reload)}>Consultar situação</button>}
                {sel.status === 'AUTHORIZED' && <>
                  <a className="btn" href={`/api/fiscal/outgoing/${sel.id}/file?kind=danfe`} target="_blank" rel="noreferrer">{sel.model === '65' ? 'Ver cupom (DANFCe)' : 'Ver DANFE'}</a>
                  <a className="btn" href={`/api/fiscal/outgoing/${sel.id}/file?kind=xml`}>Baixar XML</a>
                  <button className="btn" onClick={async () => { const reason = await ui.prompt({ title: 'Cancelar a nota?', message: 'O cancelamento é enviado à SEFAZ pelo provedor e tem prazo e regras definidos pelo estado (em geral, até 24 horas para NF-e e 30 minutos para NFC-e). Não pode ser desfeito.', label: 'Justificativa (15 a 255 caracteres)', danger: true, confirmLabel: 'Cancelar nota', cancelLabel: 'Voltar' }); if (reason) void act(() => api(`/fiscal/outgoing/${sel.id}/cancel`, 'POST', { reason }), 'Nota cancelada.', reload); }}>Cancelar nota</button>
                </>}
              </div>
            )}
          </div>
          {sel.status === 'PENDING_CONSULT' && <div className="alert error">A resposta da transmissão é desconhecida. <strong>Não reenvie</strong>: use “Consultar situação” para evitar nota duplicada.</div>}
          {sel.status === 'CANCELLED' && <div className="alert warn">Nota cancelada. O pedido pode ser faturado de novo.</div>}
          {sel.accessKey && <p className="muted">Chave <span className="mono">{formatAccessKey(sel.accessKey)}</span> · protocolo {sel.authProtocol ?? '—'}</p>}
          <IssueList issues={sel.issues} />
          <div className="table-wrap"><table>
            <thead><tr><th>#</th><th>Descrição</th><th>NCM</th><th>CFOP</th><th>Total</th><th>Impostos calculados (regra aprovada)</th></tr></thead>
            <tbody>{sel.items.map((i) => <tr key={i.line}><td>{i.line}</td><td>{i.description}</td><td>{i.ncm ?? '—'}</td><td>{i.cfop ?? '—'}</td><td className="num">{brl(i.totalValue)}</td><td className="muted">{Object.entries(i.declaredTax?.taxes ?? {}).map(([c, t]) => `${c} ${t.amount.toFixed(2)}`).join(' · ') || '—'}</td></tr>)}</tbody>
          </table></div>
        </section>
      )}
    </>
  );
}
