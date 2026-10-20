'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { PageHeader, Alert } from '@/components/ui';

interface Product { id: string; sku: string; name: string }
interface Conn { id: string; label: string; provider: string }
interface Check { ok: boolean; reason?: string }
interface Ev { price: number; percentDeductions: number; fixedCosts: number; contribution: number; marginPct: number; markupPct: number | null; check: Check }
interface Result {
  product: { sku: string; name: string; cost: number; extraCost: number; minPrice: number | null; suggestedPrice: number | null };
  fees: Record<string, number>; note: string; breakEvenPrice: number | null; recommendedPrice: number | null; targetMarginPct: number | null; evaluations: Ev[];
}
const brl = (v: number | null) => (v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const FIELDS: [string, string][] = [['commissionPct', 'Comissão (%)'], ['paymentPct', 'Pagamento (%)'], ['taxPct', 'Tributos estimados (%)'], ['fixedFee', 'Tarifa fixa (R$)'], ['shippingSubsidy', 'Frete subsidiado (R$)'], ['packaging', 'Embalagem (R$)']];

export default function PrecosPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [conns, setConns] = useState<Conn[]>([]);
  const [res, setRes] = useState<Result | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ items: Product[] }>('/products?limit=200').then((r) => setProducts(r.items)).catch((e) => setError(e.message));
    api<Conn[]>('/integrations/connections').then(setConns).catch(() => undefined);
  }, []);

  async function run(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(''); setRes(null);
    const f = new FormData(e.currentTarget);
    const num = (k: string) => (String(f.get(k) ?? '').trim() === '' ? undefined : Number(String(f.get(k)).replace(',', '.')));
    const fees = Object.fromEntries(FIELDS.map(([k]) => [k, num(k)]).filter(([, v]) => v !== undefined));
    const prices = String(f.get('prices') ?? '').split(/[;\s]+/).map((v) => Number(v.replace(',', '.'))).filter((v) => v > 0);
    try {
      setRes(await api<Result>('/integrations/pricing/simulate', 'POST', {
        productId: f.get('product'), connectionId: f.get('conn') || undefined, fees: Object.keys(fees).length ? fees : undefined,
        prices: prices.length ? prices : undefined, targetMarginPct: num('target'),
      }));
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <>
      <PageHeader title="Preços e margens" description={<>Margem é sobre a <strong>venda</strong>; markup é sobre o <strong>custo</strong> — são coisas diferentes. Deixe os campos de tarifa em branco para usar o perfil salvo no canal; preencher sobrescreve apenas esta simulação.</>} />
      {error && <Alert kind="error">{error}</Alert>}
      <form className="card" onSubmit={run} style={{ marginBottom: 16 }}>
        <div className="form-grid">
          <div><label htmlFor="p">Produto *</label><select id="p" name="product" required><option value="">Selecione…</option>{products.map((p) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}</select></div>
          <div><label htmlFor="c">Canal (perfil de tarifas)</label><select id="c" name="conn" defaultValue=""><option value="">Nenhum (informar abaixo)</option>{conns.map((c) => <option key={c.id} value={c.id}>{c.label} ({c.provider})</option>)}</select></div>
          <div><label htmlFor="pr">Preços a comparar (R$, separados por ;)</label><input id="pr" name="prices" placeholder="99,90; 129,90; 149,90" /></div>
          <div><label htmlFor="t">Margem desejada sobre a venda (%)</label><input id="t" name="target" inputMode="decimal" /></div>
          {FIELDS.map(([k, label]) => <div key={k}><label htmlFor={k}>{label}</label><input id={k} name={k} inputMode="decimal" placeholder="perfil do canal" /></div>)}
        </div>
        <div style={{ marginTop: 12 }}><button className="btn primary">Simular</button></div>
      </form>

      {res && (
        <section className="card">
          <h2>{res.product.sku} — {res.product.name}</h2>
          <p className="muted">Custo {brl(res.product.cost)} + adicional {brl(res.product.extraCost)} · mínimo autorizado {brl(res.product.minPrice)} · {res.note}</p>
          <div className="grid cols-4" style={{ marginBottom: 12 }}>
            <div className="card stat"><div className="muted">Preço de equilíbrio</div><div className="n">{brl(res.breakEvenPrice)}</div></div>
            <div className="card stat"><div className="muted">Recomendado{res.targetMarginPct != null ? ` p/ ${res.targetMarginPct}%` : ''}</div><div className="n">{res.targetMarginPct != null ? (res.recommendedPrice != null ? brl(res.recommendedPrice) : 'impossível') : '—'}</div></div>
          </div>
          <div className="table-wrap"><table>
            <thead><tr><th>Preço</th><th>Retido em %</th><th>Custos fixos</th><th>Resultado/un.</th><th>Margem s/ venda</th><th>Markup s/ custo</th><th>Proteções</th></tr></thead>
            <tbody>
              {res.evaluations.length === 0 && <tr><td colSpan={7} className="empty">Informe preços para comparar.</td></tr>}
              {res.evaluations.map((e) => (
                <tr key={e.price}><td className="num">{brl(e.price)}</td><td className="num">{brl(e.percentDeductions)}</td><td className="num">{brl(e.fixedCosts)}</td><td className="num">{brl(e.contribution)}</td><td>{e.marginPct.toFixed(2)}%</td><td>{e.markupPct == null ? '—' : `${e.markupPct.toFixed(2)}%`}</td>
                  <td>{e.check.ok ? <span className="badge ok">dentro dos limites</span> : <span className="badge warn">{e.check.reason}</span>}</td></tr>
              ))}
            </tbody>
          </table></div>
        </section>
      )}
    </>
  );
}
