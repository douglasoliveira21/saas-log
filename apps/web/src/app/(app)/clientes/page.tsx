'use client';

import { Plus } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { PageHeader, Alert, Dialog, Skeleton } from '@/components/ui';
import { CepField, DocumentField, MaskedInput, UfSelect } from '@/components/fields';
import { docOrDash, formatPhone } from '@/lib/format';
import { useSession } from '@/lib/session';
import { PurchaseBadge, type PurchaseInfo } from '@/components/purchase-badge';
import { CreditDialog } from '@/components/credit-dialog';

interface Customer { id: string; kind: 'PF' | 'PJ'; name: string; document: string | null; email: string | null; phone: string | null; city: string | null; state: string | null; stateRegistration?: string | null; zipCode?: string | null; street?: string | null; number?: string | null; district?: string | null; active: boolean; priceTable?: string; salespersonId?: string | null; purchase?: PurchaseInfo }
interface Seller { id: string; name: string; active: boolean }

export default function ClientesPage() {
  const { can } = useSession();
  const manage = can('customers.manage');
  const [items, setItems] = useState<Customer[] | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [credit, setCredit] = useState<Customer | null>(null);
  const [sellers, setSellers] = useState<Seller[]>([]);
  useEffect(() => { if (can('sales.view_all') && can('commissions.view')) api<Seller[]>('/salespeople').then((s) => setSellers(s.filter((x) => x.active))).catch(() => undefined); }, [can]);

  const load = useCallback(() => { api<Customer[]>(`/customers${search ? `?search=${encodeURIComponent(search)}` : ''}`).then(setItems).catch((e) => setError(e.message)); }, [search]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const OPTIONAL = ['stateRegistration', 'email', 'phone', 'zipCode', 'street', 'number', 'district', 'city', 'state'];
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(''); setOk('');
    const entries = [...new FormData(e.currentTarget).entries()];
    try {
      if (editing) {
        // na edição, campo opcional esvaziado é apagado (null); tipo e carteira não mudam por aqui
        const body: Record<string, unknown> = {};
        for (const [k, v] of entries) {
          const val = String(v).trim();
          if (k === 'kind' || k === 'salespersonId') continue;
          if (val === '') { if (OPTIONAL.includes(k)) body[k] = null; continue; }
          body[k] = val;
        }
        await api(`/customers/${editing.id}`, 'PATCH', body);
        setOk('Cliente atualizado.'); setEditing(null);
      } else {
        await api('/customers', 'POST', Object.fromEntries(entries.filter(([, v]) => String(v).trim() !== '')));
        setOk('Cliente cadastrado.'); setAdding(false);
      }
      load();
    } catch (err) { setError((err as Error).message); }
  }
  function startEdit(c: Customer) { setAdding(false); setEditing(c); setError(''); setOk(''); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  async function toggle(c: Customer) {
    try { await api(`/customers/${c.id}`, 'PATCH', { active: !c.active }); load(); } catch (err) { setError((err as Error).message); }
  }

  return (
    <>
      <PageHeader title="Clientes" description={<>Pessoas físicas e jurídicas. Dados pessoais ficam restritos às permissões do módulo.</>} actions={<>
          {manage && <button className="btn primary" onClick={() => { setEditing(null); setAdding(true); }}><Plus aria-hidden />Cliente</button>}
        </>} />
      {error && !(adding || editing) && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}
      {(adding || editing) && (
        <Dialog title={editing ? `Editar cliente — ${editing.name}` : 'Novo cliente'} description={editing ? 'Altere os dados e salve. O tipo (pessoa física ou jurídica) não muda.' : undefined} onClose={() => { setAdding(false); setEditing(null); }} xl>
        <form key={editing?.id ?? 'novo'} onSubmit={save}>
          <div className="modal-body">
          {error && <Alert kind="error">{error}</Alert>}
          <div className="form-grid">
            <div><label htmlFor="kind">Tipo *</label><select id="kind" name="kind" defaultValue={editing?.kind ?? 'PJ'} disabled={!!editing} title={editing ? 'O tipo não pode ser alterado' : undefined}><option value="PJ">Pessoa jurídica</option><option value="PF">Pessoa física</option></select></div>
            <div><label htmlFor="name">Nome / razão social *</label><input id="name" name="name" required defaultValue={editing?.name} /></div>
            <div><label htmlFor="document">CPF/CNPJ</label><DocumentField id="document" name="document" defaultValue={editing?.document ?? undefined} fill={editing ? undefined : {name: 'legalName',email: 'email',phone: 'phone',zipCode: 'zipCode',street: 'street',number: 'number',complement: 'complement',district: 'district',city: 'city',state: 'state'}} /></div>
            <div><label htmlFor="stateRegistration">Inscrição estadual</label><input id="stateRegistration" name="stateRegistration" defaultValue={editing?.stateRegistration ?? ''} /></div>
            <div><label htmlFor="email">E-mail</label><input id="email" name="email" type="email" defaultValue={editing?.email ?? ''} /></div>
            <div><label htmlFor="phone">Telefone</label><MaskedInput id="phone" name="phone" kind="phone" defaultValue={editing?.phone ?? undefined} /></div>
            <div><label htmlFor="zipCode">CEP</label><CepField id="zipCode" defaultValue={editing?.zipCode ?? undefined} fill={{ street: 'street', district: 'district', city: 'city', state: 'state' }} /></div>
            <div><label htmlFor="street">Logradouro</label><input id="street" name="street" defaultValue={editing?.street ?? ''} /></div>
            <div><label htmlFor="number">Número</label><input id="number" name="number" defaultValue={editing?.number ?? ''} /></div>
            <div><label htmlFor="district">Bairro</label><input id="district" name="district" defaultValue={editing?.district ?? ''} /></div>
            <div><label htmlFor="city">Município</label><input id="city" name="city" defaultValue={editing?.city ?? ''} /></div>
            <div><label htmlFor="state">UF</label><UfSelect id="state" defaultValue={editing?.state ?? ''} /></div>
            <div><label htmlFor="priceTable">Tabela de preço padrão</label><select id="priceTable" name="priceTable" defaultValue={editing?.priceTable ?? 'RETAIL'}><option value="RETAIL">Varejo</option><option value="WHOLESALE">Atacado</option></select></div>
            {!editing && sellers.length > 0 && <div><label htmlFor="salespersonId">Vendedor da carteira</label><select id="salespersonId" name="salespersonId" defaultValue=""><option value="">Sem carteira (ou a minha)</option>{sellers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>}
          </div>
          </div>
          <div className="modal-foot"><button type="button" className="btn" onClick={() => { setAdding(false); setEditing(null); }}>Cancelar</button><button className="btn primary">{editing ? 'Salvar alterações' : 'Salvar'}</button></div>
        </form>
        </Dialog>
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
                  <td>{c.name}{c.priceTable === 'WHOLESALE' && <span className="badge" style={{ marginLeft: 6 }}>atacado</span>}</td><td>{c.kind}</td><td className="nowrap">{docOrDash(c.document)}</td><td className="contact-cell">{c.email || c.phone ? <>{c.email && <div className="ct-line" title={c.email}>{c.email}</div>}{c.phone && <div className="ct-line nowrap">{formatPhone(c.phone)}</div>}</> : '—'}</td>
                  <td>{[c.city, c.state].filter(Boolean).join('/') || '—'}</td>
                  <td><PurchaseBadge type={c.purchase?.type} daysSince={c.purchase?.daysSince} at="now" />{c.purchase && c.purchase.orders > 0 && <div className="muted" style={{ fontSize: '0.76rem' }}>{c.purchase.orders} pedido(s) · última {c.purchase.lastPurchaseAt ? new Date(c.purchase.lastPurchaseAt).toLocaleDateString('pt-BR') : '—'}</div>}</td>
                  <td className="actions">{manage && <button className="btn sm" onClick={() => startEdit(c)} aria-label={`Editar ${c.name}`}>Editar</button>} <button className="btn sm" onClick={() => setCredit(c)}>Crédito</button> {manage && <button className="btn sm" onClick={() => toggle(c)}>{c.active ? 'Inativar' : 'Reativar'}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {credit && <CreditDialog customerId={credit.id} customerName={credit.name} canManage={can('credit.manage')} canEditCustomer={manage} onClose={() => setCredit(null)} />}
    </>
  );
}
