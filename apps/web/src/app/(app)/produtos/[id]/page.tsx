'use client';

import { ArrowLeft, Plus, Save, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Alert, PageHeader, Skeleton, useUi } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Channels, QualityPanel } from './channels';
import { Photos } from './photos';

interface Attr { name: string; value: string }
interface Product {
  id: string; sku: string; name: string; title: string | null; barcode: string | null; brand: string | null; model: string | null; mpn: string | null; condition: string; warrantyMonths: number | null;
  categoryId: string | null; saleUnit: string; purchaseUnit: string; unitConversion: number; shortDescription: string | null; description: string | null; attributes: Attr[];
  netWeightG: number | null; grossWeightG: number | null; heightMm: number | null; widthMm: number | null; lengthMm: number | null;
  costPrice: string | null; extraCost: string | null; suggestedPrice: string | null; minPrice: string | null; targetMarginPct: string | null;
  minStock: number; maxStock: number | null; reorderPoint: number | null; leadTimeDays: number | null; locationNote: string | null;
  ncm: string | null; cest: string | null; taxOrigin: number | null; taxUnit: string | null; taxGtin: string | null; active: boolean;
}
interface Category { id: string; name: string }

const SUGGESTED_ATTRS = ['Cor', 'Material', 'Acabamento', 'Tamanho', 'Voltagem', 'Potência', 'Capacidade', 'Peso', 'Largura', 'Altura', 'Comprimento', 'Modelo', 'Garantia', 'Origem', 'Conteúdo da embalagem'];
const TEXT = ['name', 'title', 'brand', 'model', 'mpn', 'barcode', 'shortDescription', 'description', 'locationNote', 'ncm', 'cest', 'taxGtin', 'taxUnit'] as const;
const INTS = ['warrantyMonths', 'netWeightG', 'grossWeightG', 'heightMm', 'widthMm', 'lengthMm', 'maxStock', 'reorderPoint', 'leadTimeDays', 'taxOrigin'] as const;
const DECS = ['costPrice', 'extraCost', 'suggestedPrice', 'minPrice', 'targetMarginPct'] as const;

/** Dígito verificador de GTIN/EAN (8, 12, 13 ou 14 dígitos). */
function gtinOk(c: string) {
  if (![8, 12, 13, 14].includes(c.length) || !/^\d+$/.test(c)) return false;
  const d = c.split('').map(Number);
  const check = d.pop()!;
  const sum = d.reverse().reduce((a, v, i) => a + v * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

function Card({ id, title, why, children }: { id?: string; title: string; why?: string; children: ReactNode }) {
  return <section className="card editor-card" id={id}><div className="card-head" style={{ marginBottom: 4 }}><h2>{title}</h2></div>{why && <p className="muted" style={{ margin: '0 0 12px', fontSize: '0.86rem' }}>{why}</p>}{children}</section>;
}
const Field = ({ id, label, hint, req, children }: { id: string; label: string; hint?: ReactNode; req?: boolean; children: ReactNode }) => (
  <div><label htmlFor={id} className={req ? 'req' : ''}>{label}</label>{children}{hint && <div className="hint muted" style={{ fontSize: '0.78rem', marginTop: 4 }}>{hint}</div>}</div>
);

export default function ProdutoEditorPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = id === 'novo';
  const router = useRouter();
  const ui = useUi();
  const { can } = useSession();
  const manage = can('products.manage');
  const [p, setP] = useState<Product | null>(null);
  const [cats, setCats] = useState<Category[]>([]);
  const [attrs, setAttrs] = useState<Attr[]>([]);
  const [title, setTitle] = useState('');
  const [barcode, setBarcode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [qKey, setQKey] = useState(0);
  const [missing, setMissing] = useState(false);

  const load = useCallback(() => {
    if (isNew) return;
    api<Product>(`/products/${id}`).then((x) => { setP(x); setAttrs(Array.isArray(x.attributes) ? x.attributes : []); setTitle(x.title ?? ''); setBarcode(x.barcode ?? ''); }).catch((e) => { if (e instanceof ApiError && e.status === 404) setMissing(true); else setError(e.message); });
  }, [id, isNew]);
  useEffect(() => { load(); api<Category[]>('/categories').then(setCats).catch(() => undefined); }, [load]);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  async function newCategory() {
    const name = await ui.prompt({ title: 'Nova categoria', label: 'Nome da categoria', confirmLabel: 'Criar categoria' });
    if (!name) return;
    try { await api('/categories', 'POST', { name }); setCats(await api<Category[]>('/categories')); } catch (e) { ui.toast.error((e as Error).message); }
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> = {};
    const s = (k: string) => String(f.get(k) ?? '').trim();
    if (isNew) body.sku = s('sku');
    for (const k of TEXT) { const v = s(k); if (v) body[k] = v; else if (!isNew && k !== 'name') body[k] = null; }
    for (const k of INTS) { const v = s(k); if (v) body[k] = Number(v); else if (!isNew) body[k] = null; }
    for (const k of DECS) { const v = s(k).replace(',', '.'); if (v) body[k] = Number(v); else if (!isNew) body[k] = null; }
    for (const k of ['minStock', 'unitConversion']) { const v = s(k); if (v) body[k] = Number(v); }
    for (const k of ['saleUnit', 'purchaseUnit']) { const v = s(k); if (v) body[k] = v.toUpperCase(); }
    body.condition = s('condition') || 'NEW';
    if (s('categoryId')) body.categoryId = s('categoryId'); else if (!isNew) body.categoryId = null;
    body.attributes = attrs.map((a) => ({ name: a.name.trim(), value: a.value.trim() })).filter((a) => a.name && a.value);
    try {
      if (isNew) {
        const r = await api<{ id: string }>('/products', 'POST', body);
        ui.toast.ok('Produto criado. Agora adicione as fotos e confira a qualidade do cadastro.');
        setDirty(false); router.replace(`/produtos/${r.id}`);
      } else {
        await api(`/products/${id}`, 'PATCH', body);
        ui.toast.ok('Produto salvo.'); setDirty(false); load(); setQKey((k) => k + 1);
      }
    } catch (err) { setError((err as Error).message); window.scrollTo({ top: 0, behavior: 'smooth' }); } finally { setBusy(false); }
  }

  if (missing) return <><PageHeader title="Produto não encontrado" actions={<Link className="btn" href="/produtos"><ArrowLeft aria-hidden />Voltar</Link>} /></>;
  if (!isNew && !p && !error) return <Skeleton rows={6} />;
  const v = <K extends keyof Product>(k: K) => (p?.[k] ?? '') as string | number;
  const gtinState = !barcode ? null : gtinOk(barcode.replace(/\D/g, ''));
  const dis = !manage;

  return (
    <>
      <PageHeader
        title={isNew ? 'Novo produto' : (p?.title || p?.name || 'Produto')}
        description={isNew ? 'Cadastre como se fosse anunciar: o que você preencher aqui é o que vai para os marketplaces (título, fotos, ficha técnica, medidas).' : <>SKU <strong>{p?.sku}</strong>{p && !p.active && <span className="badge warn" style={{ marginLeft: 8 }}>Inativo</span>}</>}
        actions={<Link className="btn" href="/produtos"><ArrowLeft aria-hidden />Voltar para a lista</Link>}
      />
      {error && <Alert kind="error">{error}</Alert>}
      {isNew && <Alert kind="info">Depois de salvar, você poderá <strong>enviar as fotos</strong> e <strong>publicar nos marketplaces</strong>.</Alert>}

      <div className="editor">
        <form onSubmit={save} onChange={() => setDirty(true)} className="editor-main" key={p?.id ?? 'novo'}>
          <fieldset disabled={dis || busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }} className="stack">
            <Card id="basico" title="Informações do anúncio" why="O que o comprador vê primeiro. Quanto mais completo, melhor o produto aparece nas buscas.">
              <div className="form-grid">
                <Field id="sku" label="SKU (código interno)" req hint={isNew ? 'Único por produto. Letras, números . _ - /' : 'O SKU não muda depois de criado.'}><input id="sku" name="sku" required defaultValue={p?.sku} disabled={!isNew} maxLength={60} /></Field>
                <Field id="name" label="Nome interno" req hint="Como você chama o produto no dia a dia."><input id="name" name="name" required minLength={2} defaultValue={p?.name} maxLength={200} /></Field>
                <div style={{ gridColumn: '1 / -1' }}>
                  <Field id="title" label="Título do anúncio" hint={<>Marca + produto + característica principal. <span style={{ color: title.length > 60 ? 'var(--danger)' : undefined, fontWeight: 600 }}>{title.length}/60</span> — marketplaces como o Mercado Livre aceitam até 60 caracteres. Vazio = usa o nome interno.</>}>
                    <input id="title" name="title" maxLength={150} defaultValue={p?.title ?? ''} onInput={(e) => setTitle(e.currentTarget.value)} placeholder="Ex.: Parafuso Sextavado M8 x 40 Aço Zincado" />
                  </Field>
                </div>
                <Field id="brand" label="Marca" req><input id="brand" name="brand" defaultValue={p?.brand ?? ''} maxLength={100} /></Field>
                <Field id="model" label="Modelo"><input id="model" name="model" defaultValue={p?.model ?? ''} maxLength={100} /></Field>
                <Field id="mpn" label="Código do fabricante (MPN)"><input id="mpn" name="mpn" defaultValue={p?.mpn ?? ''} maxLength={60} /></Field>
                <Field id="barcode" label="Código de barras (GTIN/EAN)" hint={gtinState === null ? 'Marketplaces pedem o GTIN. 8, 12, 13 ou 14 dígitos.' : gtinState ? <span style={{ color: 'var(--ok)' }}>Dígito verificador confere.</span> : <span style={{ color: 'var(--danger)' }}>O dígito verificador não confere: revise o código.</span>}>
                  <input id="barcode" name="barcode" inputMode="numeric" maxLength={14} defaultValue={p?.barcode ?? ''} onInput={(e) => setBarcode(e.currentTarget.value)} />
                </Field>
                <Field id="condition" label="Condição" req><select id="condition" name="condition" defaultValue={p?.condition ?? 'NEW'}><option value="NEW">Novo</option><option value="USED">Usado</option><option value="REFURBISHED">Recondicionado</option></select></Field>
                <Field id="warrantyMonths" label="Garantia (meses)"><input id="warrantyMonths" name="warrantyMonths" type="number" min={0} max={240} defaultValue={p?.warrantyMonths ?? ''} /></Field>
                <Field id="categoryId" label="Categoria interna" req hint="É ligada à categoria do canal em Marketplaces → Categorias.">
                  <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
                    <select id="categoryId" name="categoryId" defaultValue={p?.categoryId ?? ''}><option value="">Sem categoria</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                    {manage && <button type="button" className="btn icon" onClick={newCategory} aria-label="Nova categoria" title="Nova categoria"><Plus /></button>}
                  </div>
                </Field>
                <Field id="saleUnit" label="Unidade de venda"><input id="saleUnit" name="saleUnit" defaultValue={p?.saleUnit ?? 'UN'} maxLength={6} /></Field>
              </div>
            </Card>

            {!isNew && (
              <Card id="fotos" title="Fotos" why="Sem foto o anúncio não é aceito. A primeira é a principal.">
                <Photos productId={id} manage={manage} onChange={() => setQKey((k) => k + 1)} />
              </Card>
            )}

            <Card id="descricao" title="Descrição" why="Texto simples (sem HTML). Descreva uso, medidas, conteúdo da embalagem e diferenciais.">
              <div className="form-grid">
                <div style={{ gridColumn: '1 / -1' }}><Field id="shortDescription" label="Resumo (até 300 caracteres)"><input id="shortDescription" name="shortDescription" maxLength={300} defaultValue={p?.shortDescription ?? ''} /></Field></div>
                <div style={{ gridColumn: '1 / -1' }}><Field id="description" label="Descrição completa" hint="Até 5.000 caracteres."><textarea id="description" name="description" rows={7} maxLength={5000} defaultValue={p?.description ?? ''} /></Field></div>
              </div>
            </Card>

            <Card id="ficha" title="Ficha técnica" why="Pares nome/valor (cor, material, voltagem…). Os canais usam isso nos filtros de busca; atributos obrigatórios de cada categoria aparecem na pré-visualização do anúncio.">
              <datalist id="attr-names">{SUGGESTED_ATTRS.map((a) => <option key={a} value={a} />)}</datalist>
              {attrs.length === 0 && <p className="muted" style={{ marginTop: 0 }}>Nenhum atributo ainda.</p>}
              <div className="stack" style={{ gap: 8 }}>
                {attrs.map((a, i) => (
                  <div className="attr-row" key={i}>
                    <input aria-label={`Atributo ${i + 1}: nome`} list="attr-names" placeholder="Nome (ex.: Cor)" value={a.name} maxLength={60} onChange={(e) => { setAttrs(attrs.map((x, k) => (k === i ? { ...x, name: e.target.value } : x))); setDirty(true); }} />
                    <input aria-label={`Atributo ${i + 1}: valor`} placeholder="Valor (ex.: Prata)" value={a.value} maxLength={255} onChange={(e) => { setAttrs(attrs.map((x, k) => (k === i ? { ...x, value: e.target.value } : x))); setDirty(true); }} />
                    <button type="button" className="btn icon ghost" aria-label={`Remover atributo ${i + 1}`} onClick={() => { setAttrs(attrs.filter((_, k) => k !== i)); setDirty(true); }}><Trash2 /></button>
                  </div>
                ))}
              </div>
              {attrs.length < 50 && manage && <p style={{ margin: '10px 0 0' }}><button type="button" className="btn sm" onClick={() => { setAttrs([...attrs, { name: '', value: '' }]); setDirty(true); }}><Plus aria-hidden />Adicionar atributo</button></p>}
            </Card>

            <Card id="preco" title="Preço e custo" why="O preço de venda por canal é aprovado em Preços e margens; aqui fica o preço sugerido e o custo que alimenta a margem.">
              <div className="form-grid">
                <Field id="costPrice" label="Custo (R$)"><input id="costPrice" name="costPrice" inputMode="decimal" defaultValue={v('costPrice')} /></Field>
                <Field id="extraCost" label="Custos extras (R$)" hint="Embalagem, frete de compra, etc."><input id="extraCost" name="extraCost" inputMode="decimal" defaultValue={v('extraCost')} /></Field>
                <Field id="suggestedPrice" label="Preço sugerido de venda (R$)" req><input id="suggestedPrice" name="suggestedPrice" inputMode="decimal" defaultValue={v('suggestedPrice')} /></Field>
                <Field id="minPrice" label="Preço mínimo (R$)" hint="Abaixo disso o sistema bloqueia o envio do preço."><input id="minPrice" name="minPrice" inputMode="decimal" defaultValue={v('minPrice')} /></Field>
                <Field id="targetMarginPct" label="Margem alvo (%)"><input id="targetMarginPct" name="targetMarginPct" inputMode="decimal" defaultValue={v('targetMarginPct')} /></Field>
              </div>
            </Card>

            <Card id="frete" title="Peso e embalagem" why="Necessários para calcular o frete nos marketplaces. Peso em gramas, medidas em milímetros (da embalagem pronta para envio).">
              <div className="form-grid">
                <Field id="grossWeightG" label="Peso com embalagem (g)" req><input id="grossWeightG" name="grossWeightG" type="number" min={0} defaultValue={v('grossWeightG')} /></Field>
                <Field id="netWeightG" label="Peso líquido (g)"><input id="netWeightG" name="netWeightG" type="number" min={0} defaultValue={v('netWeightG')} /></Field>
                <Field id="lengthMm" label="Comprimento (mm)" req><input id="lengthMm" name="lengthMm" type="number" min={0} defaultValue={v('lengthMm')} /></Field>
                <Field id="widthMm" label="Largura (mm)" req><input id="widthMm" name="widthMm" type="number" min={0} defaultValue={v('widthMm')} /></Field>
                <Field id="heightMm" label="Altura (mm)" req><input id="heightMm" name="heightMm" type="number" min={0} defaultValue={v('heightMm')} /></Field>
              </div>
            </Card>

            <Card id="estoque" title="Estoque" why="Parâmetros de reposição. O saldo em si é movimentado em Estoque.">
              <div className="form-grid">
                <Field id="minStock" label="Estoque mínimo"><input id="minStock" name="minStock" type="number" min={0} defaultValue={p?.minStock ?? 0} /></Field>
                <Field id="maxStock" label="Estoque máximo"><input id="maxStock" name="maxStock" type="number" min={0} defaultValue={v('maxStock')} /></Field>
                <Field id="reorderPoint" label="Ponto de reposição"><input id="reorderPoint" name="reorderPoint" type="number" min={0} defaultValue={v('reorderPoint')} /></Field>
                <Field id="leadTimeDays" label="Prazo de reposição (dias)"><input id="leadTimeDays" name="leadTimeDays" type="number" min={0} defaultValue={v('leadTimeDays')} /></Field>
                <Field id="purchaseUnit" label="Unidade de compra"><input id="purchaseUnit" name="purchaseUnit" defaultValue={p?.purchaseUnit ?? 'UN'} maxLength={6} /></Field>
                <Field id="unitConversion" label="Unidades por unidade de compra"><input id="unitConversion" name="unitConversion" type="number" min={1} defaultValue={p?.unitConversion ?? 1} /></Field>
                <Field id="locationNote" label="Localização no depósito"><input id="locationNote" name="locationNote" maxLength={100} defaultValue={p?.locationNote ?? ''} /></Field>
              </div>
            </Card>

            <Card id="fiscal" title="Dados fiscais" why="Nunca preenchidos automaticamente: valide com o seu contador. Produto sem NCM aparece como pendência fiscal.">
              <div className="form-grid">
                <Field id="ncm" label="NCM (8 dígitos)"><input id="ncm" name="ncm" inputMode="numeric" maxLength={8} defaultValue={p?.ncm ?? ''} /></Field>
                <Field id="cest" label="CEST (7 dígitos)"><input id="cest" name="cest" inputMode="numeric" maxLength={7} defaultValue={p?.cest ?? ''} /></Field>
                <Field id="taxOrigin" label="Origem da mercadoria (0 a 8)"><input id="taxOrigin" name="taxOrigin" type="number" min={0} max={8} defaultValue={v('taxOrigin')} /></Field>
                <Field id="taxUnit" label="Unidade tributável"><input id="taxUnit" name="taxUnit" maxLength={6} defaultValue={p?.taxUnit ?? ''} /></Field>
                <Field id="taxGtin" label="GTIN tributável"><input id="taxGtin" name="taxGtin" inputMode="numeric" maxLength={14} defaultValue={p?.taxGtin ?? ''} placeholder="8 a 14 dígitos" /></Field>
              </div>
            </Card>
          </fieldset>

          {manage && (
            <div className="savebar">
              <span className="muted">{dirty ? 'Alterações não salvas' : isNew ? 'Preencha e salve para continuar' : 'Tudo salvo'}</span>
              <button className={`btn primary ${busy ? 'loading' : ''}`} disabled={busy}><Save aria-hidden />{isNew ? 'Criar produto' : 'Salvar produto'}</button>
            </div>
          )}
        </form>

        {!isNew && (
          <aside className="editor-side">
            <QualityPanel productId={id} refreshKey={qKey} />
            <section className="card" style={{ marginTop: 16 }}>
              <div className="card-head" style={{ marginBottom: 8 }}><h2>Canais de venda</h2></div>
              <p className="muted" style={{ marginTop: 0, fontSize: '0.84rem' }}>Veja o anúncio pronto e publique no marketplace. Para trazer anúncios que já existem no canal, use <Link href="/integracoes">Marketplaces → Produtos do canal</Link>.</p>
              <Channels productId={id} manage={manage && can('integrations.manage')} onChange={() => { load(); setQKey((k) => k + 1); }} />
            </section>
          </aside>
        )}
      </div>
    </>
  );
}
