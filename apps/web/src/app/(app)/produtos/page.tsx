'use client';

import { Search, Plus } from 'lucide-react';
import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { api, ApiError } from '@/lib/api';
import { useUi, PageHeader, Alert, Skeleton, EmptyState, SortTh, useSort } from '@/components/ui';
import { formatNcm } from '@/lib/format';
import { useSession } from '@/lib/session';

interface Product { id: string; sku: string; name: string; barcode: string | null; brand: string | null; saleUnit: string; costPrice: string | null; suggestedPrice: string | null; minStock: number; ncm: string | null; active: boolean; fiscalPending: boolean; category: { name: string } | null }
interface Category { id: string; name: string }
interface ImportReport { committed: boolean; created: number; updated: number; initialized: number; errors: { line: number; message: string }[] }

const brl = (v: string | null) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const TEMPLATE = 'sku;nome;codigo_barras;marca;categoria;unidade;custo;preco_venda;estoque_minimo;ncm;deposito;saldo_inicial\nPARAF-001;Parafuso sextavado M8;7891234567895;Acme;Ferragens;UN;1,50;3,90;50;73181500;CD01;200\n';

export default function ProdutosPage() {
  const { can } = useSession();
  const ui = useUi();
  const manage = can('products.manage');
  const [items, setItems] = useState<Product[] | null>(null);
  const [total, setTotal] = useState(0);
  const [cats, setCats] = useState<Category[]>([]);
  const [search, setSearch] = useState('');
  const [fiscal, setFiscal] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [panel, setPanel] = useState<'new' | 'import' | null>(null);
  const [csv, setCsv] = useState('');
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    const qs = new URLSearchParams({ limit: '100' });
    if (search) qs.set('search', search);
    if (fiscal) qs.set('fiscal', 'pending');
    api<{ total: number; items: Product[] }>(`/products?${qs}`).then((r) => { setItems(r.items); setTotal(r.total); }).catch((e) => setError(e.message));
  }, [search, fiscal]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);
  useEffect(() => { api<Category[]>('/categories').then(setCats).catch(() => undefined); }, []);

  const { rows: sortedItems, sort, toggle: toggleSort } = useSort(items, { sku: (p) => p.sku, name: (p) => p.name, cat: (p) => p.category?.name, cost: (p) => (p.costPrice == null ? null : Number(p.costPrice)), price: (p) => (p.suggestedPrice == null ? null : Number(p.suggestedPrice)), min: (p) => p.minStock });
  const sortProps = { sort, toggle: toggleSort };

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(''); setOk('');
    const f = Object.fromEntries([...new FormData(e.currentTarget).entries()].filter(([, v]) => String(v).trim() !== ''));
    for (const k of ['costPrice', 'suggestedPrice', 'minStock']) if (f[k] !== undefined) f[k] = Number(String(f[k]).replace(',', '.')) as never;
    try {
      await api('/products', 'POST', f);
      setOk('Produto cadastrado.'); setPanel(null); load();
    } catch (err) { setError((err as Error).message); }
  }

  async function newCategory() {
    const name = await ui.prompt({ title: 'Nova categoria', label: 'Nome da categoria', confirmLabel: 'Criar categoria' });
    if (!name) return;
    try { await api('/categories', 'POST', { name }); setCats(await api<Category[]>('/categories')); } catch (err) { setError((err as Error).message); }
  }

  async function toggle(p: Product) {
    try { await api(`/products/${p.id}`, 'PATCH', { active: !p.active }); load(); } catch (err) { setError((err as Error).message); }
  }

  async function runImport(dryRun: boolean) {
    setBusy(true); setError(''); setOk(''); setReport(null);
    try {
      const r = await api<ImportReport>('/products/import', 'POST', { csv, dryRun, skipInvalid });
      setReport(r);
      if (r.committed) { setOk(`Importação concluída: ${r.created} criados, ${r.updated} atualizados, ${r.initialized} saldos iniciais.`); load(); }
    } catch (err) {
      setError((err as Error).message);
      if (err instanceof ApiError && err.status === 422) {
        // o corpo do 422 traz o relatório; reexecuta como simulação para exibi-lo
        const r = await api<ImportReport>('/products/import', 'POST', { csv, dryRun: true, skipInvalid });
        setReport(r);
      }
    } finally { setBusy(false); }
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) file.text().then(setCsv);
  }

  return (
    <>
      <PageHeader title="Produtos e catálogo" description={<>Cadastro mestre por SKU. Dados fiscais nunca são preenchidos automaticamente: produto sem NCM aparece como pendente.</>} actions={<>
          {manage && <div className="row"><button className="btn" onClick={() => setPanel('import')}>Importar planilha</button><button className="btn primary" onClick={() => setPanel('new')}><Plus aria-hidden />Produto</button></div>}
        </>} />
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}

      {panel === 'new' && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={create}>
          <h2>Novo produto</h2>
          <div className="form-grid">
            <div><label htmlFor="sku">SKU *</label><input id="sku" name="sku" required /></div>
            <div><label htmlFor="name">Nome *</label><input id="name" name="name" required minLength={2} /></div>
            <div><label htmlFor="barcode">Código de barras (GTIN)</label><input id="barcode" name="barcode" inputMode="numeric" /></div>
            <div><label htmlFor="brand">Marca</label><input id="brand" name="brand" /></div>
            <div><label htmlFor="categoryId">Categoria <button type="button" className="btn sm" onClick={newCategory}><Plus aria-hidden />nova</button></label>
              <select id="categoryId" name="categoryId" defaultValue=""><option value="">Sem categoria</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            <div><label htmlFor="saleUnit">Unidade</label><input id="saleUnit" name="saleUnit" defaultValue="UN" maxLength={6} /></div>
            <div><label htmlFor="costPrice">Custo (R$)</label><input id="costPrice" name="costPrice" inputMode="decimal" /></div>
            <div><label htmlFor="suggestedPrice">Preço sugerido (R$)</label><input id="suggestedPrice" name="suggestedPrice" inputMode="decimal" /></div>
            <div><label htmlFor="minStock">Estoque mínimo</label><input id="minStock" name="minStock" inputMode="numeric" /></div>
            <div><label htmlFor="ncm">NCM (validar com o contador)</label><input id="ncm" name="ncm" inputMode="numeric" maxLength={8} /></div>
          </div>
          <div className="row" style={{ marginTop: 12 }}><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={() => setPanel(null)}>Cancelar</button></div>
        </form>
      )}

      {panel === 'import' && (
        <section className="card" style={{ marginBottom: 16 }}>
          <h2>Importar planilha (CSV)</h2>
          <p className="muted">No Excel: Salvar como → CSV UTF-8. Colunas aceitas: sku, nome, codigo_barras, marca, fabricante, categoria, unidade, custo, preco_venda, preco_minimo, estoque_minimo, ncm, cest, deposito, saldo_inicial. SKU existente é atualizado. Saldo inicial exige permissão de ajuste e só vale para produto sem saldo no depósito (fica registrado no razão).</p>
          <div className="row"><input type="file" accept=".csv,text/csv,text/plain" onChange={onFile} aria-label="Arquivo CSV" style={{ width: 'auto' }} />
            <button type="button" className="btn sm" onClick={() => setCsv(TEMPLATE)}>Usar modelo</button></div>
          <div className="field" style={{ marginTop: 10 }}><label htmlFor="csv">Conteúdo</label><textarea id="csv" value={csv} onChange={(e) => setCsv(e.target.value)} rows={7} style={{ width: '100%', fontFamily: 'monospace' }} /></div>
          <label className="row" style={{ fontWeight: 400 }}><input type="checkbox" checked={skipInvalid} onChange={(e) => setSkipInvalid(e.target.checked)} style={{ width: 'auto' }} /> Importar só as linhas válidas</label>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn" disabled={busy || !csv} onClick={() => runImport(true)}>Simular</button>
            <button className="btn primary" disabled={busy || !csv} onClick={() => runImport(false)}>Importar</button>
            <button className="btn" onClick={() => { setPanel(null); setReport(null); }}>Fechar</button>
          </div>
          {report && (
            <div style={{ marginTop: 12 }}>
              <p><strong>{report.committed ? 'Concluído' : 'Simulação'}:</strong> {report.created} novos · {report.updated} atualizações · {report.initialized} saldos iniciais · {report.errors.length} problemas</p>
              {report.errors.length > 0 && <ul>{report.errors.slice(0, 50).map((e, i) => <li key={i}>Linha {e.line}: {e.message}</li>)}</ul>}
            </div>
          )}
        </section>
      )}

      <section className="card">
        <div className="toolbar">
          <div className="search"><Search aria-hidden /><input aria-label="Buscar produtos" placeholder="Buscar por SKU, nome ou código de barras" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
          <label className="check"><input type="checkbox" checked={fiscal} onChange={(e) => setFiscal(e.target.checked)} /> Só com pendência fiscal</label>
          <span className="muted" style={{ marginLeft: 'auto' }}>{total} produto(s)</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><SortTh label="SKU" k="sku" {...sortProps} /><SortTh label="Produto" k="name" {...sortProps} /><SortTh label="Categoria" k="cat" {...sortProps} /><SortTh label="Custo" k="cost" className="num" {...sortProps} /><SortTh label="Preço sugerido" k="price" className="num" {...sortProps} /><SortTh label="Mín." k="min" className="num" {...sortProps} /><th>Fiscal</th><th><span className="sr-only">Ações</span></th></tr></thead>
            <tbody>
              {!items && !error && <tr><td colSpan={8}><Skeleton rows={3} /></td></tr>}
              {items?.length === 0 && <tr><td colSpan={8}><EmptyState title={search || fiscal ? 'Nenhum produto com esses filtros' : 'Nenhum produto cadastrado'}>{search || fiscal ? 'Ajuste a busca ou limpe os filtros.' : manage ? 'Cadastre manualmente ou importe uma planilha.' : 'Peça a um gestor para cadastrar os produtos.'}</EmptyState></td></tr>}
              {sortedItems?.map((p) => (
                <tr key={p.id} style={p.active ? undefined : { opacity: 0.55 }}>
                  <td className="mono">{p.sku}</td><td>{p.name}{p.brand && <span className="muted"> · {p.brand}</span>}</td><td>{p.category?.name ?? '—'}</td>
                  <td className="num">{brl(p.costPrice)}</td><td className="num">{brl(p.suggestedPrice)}</td><td className="num">{p.minStock}</td>
                  <td>{p.fiscalPending ? <span className="badge warn">NCM pendente</span> : <span className="badge ok">NCM {formatNcm(p.ncm)}</span>}</td>
                  <td className="actions">{manage && <button className="btn sm" onClick={() => toggle(p)}>{p.active ? 'Inativar' : 'Reativar'}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
