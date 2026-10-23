'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { Alert, PageHeader, Skeleton } from '@/components/ui';
import { useSession } from '@/lib/session';

type Regime = 'SIMPLES_NACIONAL' | 'LUCRO_PRESUMIDO' | 'LUCRO_REAL' | 'MEI';
interface IcmsRow { uf: string; cst: string; ratePct?: number }
interface IbsRow { uf: string; cst: string; classification: string }
interface Config { regime: Regime; pisRate: number; cofinsRate: number; scArticle: string | null; showTotalTaxes: boolean; presumedCredit: boolean; exceededSublimit: boolean; icmsByUf: IcmsRow[]; ibsCbsByUf: IbsRow[]; updatedAt: string }
interface Item { company: { id: string; legalName: string; tradeName: string | null; cnpj: string | null; taxRegime: Regime | null }; config: Config | null }

const REGIME: Record<Regime, string> = { SIMPLES_NACIONAL: 'Simples Nacional', LUCRO_PRESUMIDO: 'Lucro Presumido', LUCRO_REAL: 'Lucro Real', MEI: 'Microempreendedor Individual (MEI)' };
const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];
const num = (v: string) => Number(v.replace(',', '.'));
const fmt = (n: number) => String(n).replace('.', ',');

/** Impostos federais da empresa. Os valores são do contador: o sistema não sugere alíquotas. */
export default function ImpostosPage() {
  const { can } = useSession();
  const manage = can('fiscal.manage');
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const load = useCallback(() => { api<Item[]>('/fiscal/federal-taxes').then(setItems).catch((e) => setError(e.message)); }, []);
  useEffect(load, [load]);

  return (
    <>
      <PageHeader title="Impostos" description={<>Impostos federais e listas por Estado da empresa. <strong>Os valores devem ser informados e conferidos pelo seu contador</strong>: o sistema não traz alíquotas prontas.</>} />
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}
      <Alert kind="info">Esta configuração fica registrada por empresa. <strong>Ainda não alimenta o cálculo das notas</strong>: o cálculo continua usando as regras tributárias aprovadas em Fiscal → Regras tributárias.</Alert>
      {!items && !error && <Skeleton rows={4} />}
      {items?.length === 0 && <div className="card empty">Cadastre uma empresa em “Empresa e estrutura” para configurar os impostos.</div>}
      {items?.map((it) => <CompanyForm key={it.company.id} item={it} manage={manage} onSaved={() => { setOk('Impostos salvos.'); setError(''); load(); }} onError={(m) => { setError(m); setOk(''); }} />)}
    </>
  );
}

function CompanyForm({ item, manage, onSaved, onError }: { item: Item; manage: boolean; onSaved: () => void; onError: (m: string) => void }) {
  const c = item.config;
  const [regime, setRegime] = useState<Regime>(c?.regime ?? item.company.taxRegime ?? 'SIMPLES_NACIONAL');
  const [pis, setPis] = useState(c ? fmt(c.pisRate) : '');
  const [cofins, setCofins] = useState(c ? fmt(c.cofinsRate) : '');
  const [article, setArticle] = useState(c?.scArticle ?? '');
  const [showTotal, setShowTotal] = useState(c?.showTotalTaxes ?? false);
  const [presumed, setPresumed] = useState(c?.presumedCredit ?? false);
  const [sublimit, setSublimit] = useState(c?.exceededSublimit ?? false);
  const [icms, setIcms] = useState<IcmsRow[]>(c?.icmsByUf ?? []);
  const [ibs, setIbs] = useState<IbsRow[]>(c?.ibsCbsByUf ?? []);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (pis.trim() === '' || cofins.trim() === '') return onError('Informe as alíquotas de PIS e COFINS (use 0 se não se aplica).');
    setBusy(true);
    try {
      await api(`/fiscal/federal-taxes/${item.company.id}`, 'PUT', {
        regime, pisRate: num(pis), cofinsRate: num(cofins), scArticle: article.trim() || null, showTotalTaxes: showTotal, presumedCredit: presumed, exceededSublimit: sublimit,
        icmsByUf: icms.map((r) => ({ uf: r.uf, cst: r.cst, ...(r.ratePct !== undefined && !Number.isNaN(r.ratePct) ? { ratePct: r.ratePct } : {}) })),
        ibsCbsByUf: ibs,
      });
      onSaved();
    } catch (err) { onError((err as Error).message); }
    setBusy(false);
  }
  const free = (used: string[]) => UFS.find((u) => !used.includes(u)) ?? 'MG';

  return (
    <form className="card" style={{ marginBottom: 16 }} onSubmit={save}>
      <h2>{item.company.tradeName ?? item.company.legalName}</h2>
      <p className="muted" style={{ marginTop: 0 }}>Preencha os campos a seguir para configurar os impostos desta empresa. {c ? `Última alteração em ${new Date(c.updatedAt).toLocaleString('pt-BR')}.` : 'Ainda não configurado.'}</p>

      <h3 style={{ fontSize: '1rem' }}>Impostos federais</h3>
      <fieldset disabled={!manage} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="form-grid">
          <div><label htmlFor={`rg-${item.company.id}`}>Regime tributário *</label>
            <select id={`rg-${item.company.id}`} value={regime} onChange={(e) => setRegime(e.target.value as Regime)}>{(Object.keys(REGIME) as Regime[]).map((k) => <option key={k} value={k}>{REGIME[k]}</option>)}</select></div>
          <div><label htmlFor={`pis-${item.company.id}`}>Alíquota PIS (%) *</label><input id={`pis-${item.company.id}`} inputMode="decimal" value={pis} onChange={(e) => setPis(e.target.value)} placeholder="Informada pelo contador" /></div>
          <div><label htmlFor={`cof-${item.company.id}`}>Alíquota COFINS (%) *</label><input id={`cof-${item.company.id}`} inputMode="decimal" value={cofins} onChange={(e) => setCofins(e.target.value)} placeholder="Informada pelo contador" /></div>
          <div><label htmlFor={`art-${item.company.id}`}>Artigo SC – MVA</label><input id={`art-${item.company.id}`} value={article} onChange={(e) => setArticle(e.target.value)} placeholder="Nenhum" maxLength={60} />
            <span className="muted" style={{ fontSize: '0.78rem' }}>De acordo com o decreto nº 3.467, esta empresa se enquadra no artigo informado.</span></div>
        </div>

        <div className="stack" style={{ marginTop: 12 }}>
          <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}><input type="checkbox" checked={showTotal} onChange={(e) => setShowTotal(e.target.checked)} /><span><strong>Total dos tributos nos documentos fiscais</strong><br /><span className="muted">Exibir o total dos tributos nos documentos fiscais, conforme a lei nº 12.741: valor aproximado correspondente à totalidade dos tributos federais, estaduais e municipais.</span></span></label>
          <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}><input type="checkbox" checked={presumed} onChange={(e) => setPresumed(e.target.checked)} /><span><strong>Aproveitamento de crédito presumido</strong><br /><span className="muted">Marque para permitir a geração do aproveitamento de crédito presumido de ICMS.</span></span></label>
          <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}><input type="checkbox" checked={sublimit} onChange={(e) => setSublimit(e.target.checked)} /><span><strong>Ultrapassou o sublimite de receita bruta</strong><br /><span className="muted">Marque quando ultrapassar o sublimite de receita bruta.</span></span></label>
        </div>

        <h3 style={{ fontSize: '1rem', marginTop: 20 }}>ICMS por Estado</h3>
        <p className="muted" style={{ marginTop: 0 }}>Esta lista de CSTs/CSOSN por UF será usada para o ICMS dos produtos que não tiverem configuração específica na UF de destino.</p>
        {icms.map((r, i) => (
          <div className="row" key={i} style={{ gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
            <select aria-label="UF" value={r.uf} onChange={(e) => setIcms(icms.map((x, k) => (k === i ? { ...x, uf: e.target.value } : x)))} style={{ width: 90 }}>{UFS.map((u) => <option key={u}>{u}</option>)}</select>
            <input aria-label="CST/CSOSN" placeholder="CST/CSOSN (ex.: 00, 102)" value={r.cst} maxLength={3} onChange={(e) => setIcms(icms.map((x, k) => (k === i ? { ...x, cst: e.target.value.replace(/\D/g, '') } : x)))} style={{ width: 170 }} />
            <input aria-label="Alíquota %" placeholder="Alíquota % (opcional)" inputMode="decimal" value={r.ratePct === undefined ? '' : fmt(r.ratePct)} onChange={(e) => setIcms(icms.map((x, k) => (k === i ? { ...x, ratePct: e.target.value === '' ? undefined : num(e.target.value) } : x)))} style={{ width: 170 }} />
            {manage && <button type="button" className="btn icon ghost" aria-label={`Remover ICMS ${r.uf}`} onClick={() => setIcms(icms.filter((_, k) => k !== i))}><Trash2 /></button>}
          </div>
        ))}
        {manage && icms.length < 27 && <button type="button" className="btn sm" onClick={() => setIcms([...icms, { uf: free(icms.map((x) => x.uf)), cst: '' }])}><Plus aria-hidden />UF</button>}

        <h3 style={{ fontSize: '1rem', marginTop: 20 }}>IBS/CBS por Estado</h3>
        <p className="muted" style={{ marginTop: 0 }}>Esta lista de CSTs e classificações tributárias por UF será usada para o IBS/CBS dos produtos que não tiverem configuração específica na UF de destino.</p>
        {ibs.map((r, i) => (
          <div className="row" key={i} style={{ gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
            <select aria-label="UF" value={r.uf} onChange={(e) => setIbs(ibs.map((x, k) => (k === i ? { ...x, uf: e.target.value } : x)))} style={{ width: 90 }}>{UFS.map((u) => <option key={u}>{u}</option>)}</select>
            <input aria-label="CST" placeholder="CST (3 dígitos)" value={r.cst} maxLength={3} onChange={(e) => setIbs(ibs.map((x, k) => (k === i ? { ...x, cst: e.target.value.replace(/\D/g, '') } : x)))} style={{ width: 150 }} />
            <input aria-label="Classificação tributária" placeholder="Classificação tributária" value={r.classification} maxLength={10} onChange={(e) => setIbs(ibs.map((x, k) => (k === i ? { ...x, classification: e.target.value } : x)))} style={{ width: 200 }} />
            {manage && <button type="button" className="btn icon ghost" aria-label={`Remover IBS/CBS ${r.uf}`} onClick={() => setIbs(ibs.filter((_, k) => k !== i))}><Trash2 /></button>}
          </div>
        ))}
        {manage && ibs.length < 27 && <button type="button" className="btn sm" onClick={() => setIbs([...ibs, { uf: free(ibs.map((x) => x.uf)), cst: '', classification: '' }])}><Plus aria-hidden />UF</button>}
      </fieldset>

      {manage ? <div className="row" style={{ marginTop: 16 }}><button className={`btn primary ${busy ? 'loading' : ''}`} disabled={busy}>Salvar impostos</button></div> : <p className="muted">Você pode consultar, mas não alterar (permissão de configuração fiscal).</p>}
    </form>
  );
}
