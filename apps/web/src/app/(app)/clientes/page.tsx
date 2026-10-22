'use client';

import { Plus } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { PageHeader, Alert, Skeleton } from '@/components/ui';
import { CepField, DocumentField, MaskedInput, UfSelect } from '@/components/fields';
import { docOrDash, formatPhone } from '@/lib/format';
import { useSession } from '@/lib/session';
import { PurchaseBadge, type PurchaseInfo } from '@/components/purchase-badge';
import { CreditDialog } from '@/components/credit-dialog';

interface Customer { id: string; kind: 'PF' | 'PJ'; name: string; document: string | null; email: string | null; phone: string | null; city: string | null; state: string | null; active: boolean; purchase?: PurchaseInfo }

export default function ClientesPage() {
  const { can } = useSession();
  const manage = can('customers.manage');
  const [items, setItems] = useState<Customer[] | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [adding, setAdding] = useState(false);
  const [credit, setCredit] = useState<Customer | null>(null);

  const load = useCallback(() => { api<Customer[]>(`/customers${search ? `?search=${encodeURIComponent(search)}` : ''}`).then(setItems).catch((e) => setError(e.message)); }, [search]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(''); setOk('');
    const f = Object.fromEntries([...new FormData(e.currentTarget).entries()].filter(([, v]) => String(v).trim() !== ''));
    try { await api('/customers', 'POST', f); setOk('Cliente cadastrado.'); setAdding(false); load(); } catch (err) { setError((err as Error).message); }
  }
  async function toggle(c: Customer) {
    try { await api(`/customers/${c.id}`, 'PATCH', { active: !c.active }); load(); } catch (err) { setError((err as Error).message); }
  }

  return (
    <>
      <PageHeader title="Clientes" description={<>Pessoas físicas e jurídicas. Dados pessoais ficam restritos às permissões do módulo.</>} actions={<>
          {manage && <button className="btn primary" onClick={() => setAdding(true)}><Plus aria-hidden />Cliente</button>}
        </>} />
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}
      {adding && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={create}>
          <h2>Novo cliente</h2>
          <div className="form-grid">
            <div><label htmlFor="kind">Tipo *</label><select id="kind" name="kind" defaultValue="PJ"><option value="PJ">Pessoa jurídica</option><option value="PF">Pessoa física</option></select></div>
            <div><label htmlFor="name">Nome / razão social *</label><input id="name" name="name" required /></div>
            <div><label htmlFor="document">CPF/CNPJ</label><DocumentField id="document" name="document" fill={{name: 'legalName',email: 'email',phone: 'phone',zipCode: 'zipCode',street: 'street',number: 'number',complement: 'complement',district: 'district',city: 'city',state: 'state'}} /></div>
            <div><label htmlFor="stateRegistration">Inscrição estadual</label><input id="stateRegistration" name="stateRegistration" /></div>
            <div><label htmlFor="email">E-mail</label><input id="email" name="email" type="email" /></div>
            <div><label htmlFor="phone">Telefone</label><MaskedInput id="phone" name="phone" kind="phone" /></div>
            <div><label htmlFor="zipCode">CEP</label><CepField id="zipCode" fill={{ street: 'street', district: 'district', city: 'city', state: 'state' }} /></div>
            <div><label htmlFor="street">Logradouro</label><input id="street" name="street" /></div>
            <div><label htmlFor="number">Número</label><input id="number" name="number" /></div>
            <div><label htmlFor="district">Bairro</label><input id="district" name="district" /></div>
            <div><label htmlFor="city">Município</label><input id="city" name="city" /></div>
            <div><label htmlFor="state">UF</label><UfSelect id="state" /></div>
          </div>
          <div className="row" style={{ marginTop: 12 }}><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={() => setAdding(false)}>Cancelar</button></div>
        </form>
      )}
      <section className="card">
        <input aria-label="Buscar clientes" placeholder="Buscar por nome ou documento" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 340, marginBottom: 12 }} />
        <div className="table-wrap">
          <table>
            <thead><tr><th>Nome</th><th>Tipo</th><th>Documento</th><th>Contato</th><th>Local</th><th>Perfil de compra</th><th /></tr></thead>
            <tbody>
              {!items && !error && <tr><td colSpan={7}><Skeleton rows={3} /></td></tr>}
              {items?.length === 0 && <tr><td colSpan={7} className="empty">Nenhum cliente encontrado.</td></tr>}
              {items?.map((c) => (
                <tr key={c.id} style={c.active ? undefined : { opacity: 0.55 }}>
                  <td>{c.name}</td><td>{c.kind}</td><td className="nowrap">{docOrDash(c.document)}</td><td>{[c.email, c.phone ? formatPhone(c.phone) : null].filter(Boolean).join(' · ') || '—'}</td>
                  <td>{[c.city, c.state].filter(Boolean).join('/') || '—'}</td>
                  <td><PurchaseBadge type={c.purchase?.type} daysSince={c.purchase?.daysSince} at="now" />{c.purchase && c.purchase.orders > 0 && <div className="muted" style={{ fontSize: '0.76rem' }}>{c.purchase.orders} pedido(s) · última {c.purchase.lastPurchaseAt ? new Date(c.purchase.lastPurchaseAt).toLocaleDateString('pt-BR') : '—'}</div>}</td>
                  <td className="actions"><button className="btn sm" onClick={() => setCredit(c)}>Crédito</button> {manage && <button className="btn sm" onClick={() => toggle(c)}>{c.active ? 'Inativar' : 'Reativar'}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {credit && <CreditDialog customerId={credit.id} customerName={credit.name} canManage={can('credit.manage')} onClose={() => setCredit(null)} />}
    </>
  );
}
