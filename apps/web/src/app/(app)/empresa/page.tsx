'use client';

import { Pencil, Plus, Power, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { PageHeader, Alert, Skeleton, useUi } from '@/components/ui';
import { CepField, DocumentField, MaskedInput, UfSelect } from '@/components/fields';
import { formatCnpj } from '@/lib/format';
import { useSession } from '@/lib/session';

interface Warehouse { id: string; code: string; name: string; kind: string; active: boolean; establishmentId: string }
interface Establishment {
  id: string; companyId: string; name: string; kind: string; cnpj: string | null; stateRegistration: string | null; cnae: string | null; zipCode: string | null; street: string | null;
  number: string | null; complement: string | null; district: string | null; city: string | null; state: string | null; active: boolean; warehouses: Warehouse[];
}
interface Company { id: string; legalName: string; tradeName: string | null; cnpj: string | null; taxRegime: string | null; responsible: string | null; contactEmail: string | null; contactPhone: string | null; active: boolean; establishments: Establishment[] }

type FormState =
  | { kind: 'company'; item?: Company }
  | { kind: 'establishment'; item?: Establishment }
  | { kind: 'warehouse'; item?: Warehouse }
  | null;

const REGIMES = [['SIMPLES_NACIONAL', 'Simples Nacional'], ['LUCRO_PRESUMIDO', 'Lucro Presumido'], ['LUCRO_REAL', 'Lucro Real'], ['MEI', 'MEI']];
const KINDS = [['MATRIZ', 'Matriz'], ['FILIAL', 'Filial'], ['CENTRO_DISTRIBUICAO', 'Centro de distribuição']];
const WKINDS = [['PROPRIO', 'Próprio'], ['TERCEIROS', 'De terceiros'], ['CONSIGNADO', 'Consignado']];
const PATHS = { company: 'companies', establishment: 'establishments', warehouse: 'warehouses' } as const;

/** Criação: campos vazios são omitidos. Edição: campos vazios viram `null` (limpam o valor); campos desabilitados nem são enviados. */
function payload(f: FormData, editing: boolean) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of f.entries()) {
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (t !== '') out[k] = t;
    else if (editing) out[k] = null;
  }
  return out;
}

export default function EmpresaPage() {
  const { can } = useSession();
  const ui = useUi();
  const manage = can('company.manage');
  const manageWh = can('warehouse.manage');
  const [tree, setTree] = useState<Company[] | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [form, setForm] = useState<FormState>(null);

  const load = useCallback(() => {
    api<Company[]>('/structure').then(setTree).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const open = (f: FormState) => { setForm(f); setError(''); setOk(''); if (f) window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const editing = !!form?.item;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!form) return;
    setError(''); setOk('');
    const label = { company: 'Empresa', establishment: 'Estabelecimento', warehouse: 'Depósito' }[form.kind];
    try {
      const body = payload(new FormData(e.currentTarget), editing);
      if (form.item) await api(`/${PATHS[form.kind]}/${form.item.id}`, 'PATCH', body);
      else await api(`/${PATHS[form.kind]}`, 'POST', body);
      setOk(`${label} ${editing ? 'atualizado(a)' : 'cadastrado(a)'}.`.replace('Empresa atualizado(a)', 'Empresa atualizada').replace('Empresa cadastrado(a)', 'Empresa cadastrada'));
      setForm(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function toggle(kind: keyof typeof PATHS, id: string, active: boolean) {
    setError(''); setOk('');
    try { await api(`/${PATHS[kind]}/${id}`, 'PATCH', { active: !active }); load(); } catch (err) { setError((err as Error).message); }
  }

  async function remove(kind: keyof typeof PATHS, id: string, name: string, warn: string) {
    const confirmed = await ui.confirm({
      title: `Excluir "${name}"?`, danger: true, confirmLabel: 'Excluir', cancelLabel: 'Voltar',
      message: <>{warn} A exclusão é <strong>definitiva</strong> e só é possível para cadastros sem movimentação, notas ou vínculos; nesses casos, desative em vez de excluir.</>,
    });
    if (!confirmed) return;
    setError(''); setOk('');
    try { await api(`/${PATHS[kind]}/${id}`, 'DELETE'); ui.toast.ok('Registro excluído.'); load(); } catch (err) { setError((err as Error).message); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  }

  const establishments = tree?.flatMap((c) => c.establishments.map((e) => ({ ...e, company: c.legalName }))) ?? [];
  const cItem = form?.kind === 'company' ? form.item : undefined;
  const eItem = form?.kind === 'establishment' ? form.item : undefined;
  const wItem = form?.kind === 'warehouse' ? form.item : undefined;
  const formKey = `${form?.kind}-${form?.item?.id ?? 'new'}`;
  const Buttons = () => <div className="row" style={{ marginTop: 12 }}><button className="btn primary">{editing ? 'Salvar alterações' : 'Salvar'}</button><button type="button" className="btn" onClick={() => setForm(null)}>Cancelar</button></div>;

  return (
    <>
      <PageHeader title="Empresa, estabelecimentos e depósitos" description={<>Empresa ≠ estabelecimento (CNPJ/IE) ≠ depósito (local físico do estoque).</>} actions={<>
          {manage && <button className="btn" onClick={() => open({ kind: 'company' })}><Plus aria-hidden />Empresa</button>}
          {manage && <button className="btn" onClick={() => open({ kind: 'establishment' })} disabled={!tree?.length}><Plus aria-hidden />Estabelecimento</button>}
          {manageWh && <button className="btn" onClick={() => open({ kind: 'warehouse' })} disabled={!establishments.length}><Plus aria-hidden />Depósito</button>}
        </>} />
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}

      {form?.kind === 'company' && (
        <form key={formKey} className="card" style={{ marginBottom: 16 }} onSubmit={submit}>
          <h2>{cItem ? `Editar empresa — ${cItem.legalName}` : 'Nova empresa'}</h2>
          <div className="form-grid">
            <div><label htmlFor="cnpj">CNPJ</label><DocumentField id="cnpj" name="cnpj" kind="cnpj" defaultValue={cItem?.cnpj ?? undefined} fill={{ legalName: 'legalName', tradeName: 'tradeName', contactEmail: 'email', contactPhone: 'phone' }} /></div>
            <div><label htmlFor="legalName" className="req">Razão social</label><input id="legalName" name="legalName" required defaultValue={cItem?.legalName} /></div>
            <div><label htmlFor="tradeName">Nome fantasia</label><input id="tradeName" name="tradeName" defaultValue={cItem?.tradeName ?? ''} /></div>
            <div><label htmlFor="taxRegime">Regime tributário</label><select id="taxRegime" name="taxRegime" defaultValue={cItem?.taxRegime ?? ''}><option value="">Selecione…</option>{REGIMES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            <div><label htmlFor="responsible">Responsável</label><input id="responsible" name="responsible" defaultValue={cItem?.responsible ?? ''} /></div>
            <div><label htmlFor="contactEmail">E-mail de contato</label><input id="contactEmail" name="contactEmail" type="email" defaultValue={cItem?.contactEmail ?? ''} /></div>
            <div><label htmlFor="contactPhone">Telefone de contato</label><MaskedInput id="contactPhone" name="contactPhone" kind="phone" defaultValue={cItem?.contactPhone ?? undefined} /></div>
          </div>
          <p className="muted">O regime tributário informado aqui deve ser validado pelo seu contador.</p>
          <Buttons />
        </form>
      )}

      {form?.kind === 'establishment' && (
        <form key={formKey} className="card" style={{ marginBottom: 16 }} onSubmit={submit}>
          <h2>{eItem ? `Editar estabelecimento — ${eItem.name}` : 'Novo estabelecimento'}</h2>
          {eItem && <p className="muted">Se o estabelecimento já tem documentos fiscais, CNPJ, UF e inscrição estadual ficam bloqueados (compõem a chave de acesso das notas).</p>}
          <div className="form-grid">
            <div><label htmlFor="companyId" className="req">Empresa</label><select id="companyId" name="companyId" required disabled={editing} defaultValue={eItem?.companyId}>{tree?.map((c) => <option key={c.id} value={c.id}>{c.legalName}</option>)}</select></div>
            <div><label htmlFor="kind" className="req">Tipo</label><select id="kind" name="kind" required disabled={editing} defaultValue={eItem?.kind}>{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            <div><label htmlFor="ecnpj">CNPJ do estabelecimento</label><DocumentField id="ecnpj" name="cnpj" kind="cnpj" defaultValue={eItem?.cnpj ?? undefined} fill={{ name: 'displayName', cnae: 'cnae', zipCode: 'zipCode', street: 'street', number: 'number', complement: 'complement', district: 'district', city: 'city', state: 'state' }} /></div>
            <div><label htmlFor="name" className="req">Nome</label><input id="name" name="name" required defaultValue={eItem?.name} /></div>
            <div><label htmlFor="stateRegistration">Inscrição estadual</label><input id="stateRegistration" name="stateRegistration" inputMode="numeric" defaultValue={eItem?.stateRegistration ?? ''} /><div className="hint muted" style={{ fontSize: '0.78rem', marginTop: 4 }}>Não consta na consulta pública: informe conforme o cadastro estadual.</div></div>
            <div><label htmlFor="cnae">CNAE principal</label><MaskedInput id="cnae" name="cnae" kind="cnae" defaultValue={eItem?.cnae ?? undefined} /></div>
            <div><label htmlFor="zipCode">CEP</label><CepField id="zipCode" defaultValue={eItem?.zipCode ?? undefined} fill={{ street: 'street', district: 'district', city: 'city', state: 'state' }} /></div>
            <div><label htmlFor="street">Logradouro</label><input id="street" name="street" defaultValue={eItem?.street ?? ''} /></div>
            <div><label htmlFor="number">Número</label><input id="number" name="number" defaultValue={eItem?.number ?? ''} /></div>
            <div><label htmlFor="complement">Complemento</label><input id="complement" name="complement" defaultValue={eItem?.complement ?? ''} /></div>
            <div><label htmlFor="district">Bairro</label><input id="district" name="district" defaultValue={eItem?.district ?? ''} /></div>
            <div><label htmlFor="city">Município</label><input id="city" name="city" defaultValue={eItem?.city ?? ''} /></div>
            <div><label htmlFor="state">UF</label><UfSelect id="state" defaultValue={eItem?.state ?? ''} /></div>
          </div>
          <Buttons />
        </form>
      )}

      {form?.kind === 'warehouse' && (
        <form key={formKey} className="card" style={{ marginBottom: 16 }} onSubmit={submit}>
          <h2>{wItem ? `Editar depósito — ${wItem.code}` : 'Novo depósito'}</h2>
          <div className="form-grid">
            <div><label htmlFor="establishmentId" className="req">Estabelecimento</label><select id="establishmentId" name="establishmentId" required disabled={editing} defaultValue={wItem?.establishmentId}>{establishments.map((e) => <option key={e.id} value={e.id}>{e.name} — {e.company}</option>)}</select></div>
            <div><label htmlFor="code" className="req">Código</label><input id="code" name="code" required placeholder="CD01" disabled={editing} defaultValue={wItem?.code} />{editing && <div className="hint muted" style={{ fontSize: '0.78rem', marginTop: 4 }}>O código não pode ser alterado (identifica o depósito em movimentos e planilhas).</div>}</div>
            <div><label htmlFor="wname" className="req">Nome</label><input id="wname" name="name" required defaultValue={wItem?.name} /></div>
            <div><label htmlFor="wkind">Tipo</label><select id="wkind" name="kind" defaultValue={wItem?.kind ?? 'PROPRIO'}>{WKINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
          </div>
          <Buttons />
        </form>
      )}

      {!tree && !error && <Skeleton rows={3} />}
      {tree?.length === 0 && <div className="card empty">Nenhuma empresa cadastrada ainda. Use “+ Empresa” para começar.</div>}
      {tree?.map((c) => (
        <section className="card" key={c.id} style={{ marginBottom: 16, opacity: c.active ? 1 : 0.75 }}>
          <div className="card-head">
            <div>
              <h2 style={{ marginBottom: 2 }}>{c.legalName} {c.taxRegime && <span className="badge">{REGIMES.find(([v]) => v === c.taxRegime)?.[1]}</span>} {!c.active && <span className="badge warn">Inativa</span>}</h2>
              <p className="muted" style={{ margin: 0 }}>{c.tradeName ?? '—'} · CNPJ {c.cnpj ? formatCnpj(c.cnpj) : 'não informado'}</p>
            </div>
            {manage && (
              <div className="row">
                <button className="btn sm" onClick={() => open({ kind: 'company', item: c })}><Pencil aria-hidden />Editar</button>
                <button className="btn sm" onClick={() => toggle('company', c.id, c.active)}><Power aria-hidden />{c.active ? 'Desativar' : 'Reativar'}</button>
                <button className="btn sm danger" onClick={() => remove('company', c.id, c.legalName, 'A empresa será removida.')}><Trash2 aria-hidden />Excluir</button>
              </div>
            )}
          </div>
          {c.establishments.length === 0 && <div className="empty">Sem estabelecimentos.</div>}
          {c.establishments.map((e) => (
            <div key={e.id} style={{ marginTop: 12 }}>
              <div className="row">
                <strong>{e.name}</strong>
                <span className="badge">{KINDS.find(([v]) => v === e.kind)?.[1]}</span>
                {!e.active && <span className="badge warn">Inativo</span>}
                <span className="muted">{[e.city, e.state].filter(Boolean).join('/')} · IE {e.stateRegistration ?? 'pendente'}</span>
                {manage && (
                  <span className="row" style={{ marginLeft: 'auto' }}>
                    <button className="btn sm" onClick={() => open({ kind: 'establishment', item: e })}><Pencil aria-hidden />Editar</button>
                    <button className="btn sm" onClick={() => toggle('establishment', e.id, e.active)}><Power aria-hidden />{e.active ? 'Desativar' : 'Reativar'}</button>
                    <button className="btn sm danger" onClick={() => remove('establishment', e.id, e.name, 'O estabelecimento será removido (os depósitos precisam ser excluídos antes).')}><Trash2 aria-hidden />Excluir</button>
                  </span>
                )}
              </div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Código</th><th>Depósito</th><th>Tipo</th><th>Situação</th><th /></tr></thead>
                  <tbody>
                    {e.warehouses.length === 0 && <tr><td colSpan={5} className="muted">Sem depósitos.</td></tr>}
                    {e.warehouses.map((w) => (
                      <tr key={w.id}>
                        <td className="mono">{w.code}</td><td>{w.name}</td><td>{WKINDS.find(([v]) => v === w.kind)?.[1]}</td>
                        <td><span className={`badge ${w.active ? 'ok' : 'warn'}`}>{w.active ? 'Ativo' : 'Inativo'}</span></td>
                        <td className="actions">{manageWh && (
                          <span className="row" style={{ flexWrap: 'nowrap', justifyContent: 'flex-end' }}>
                            <button className="btn sm" onClick={() => open({ kind: 'warehouse', item: w })}><Pencil aria-hidden />Editar</button>
                            <button className="btn sm" onClick={() => toggle('warehouse', w.id, w.active)}><Power aria-hidden />{w.active ? 'Desativar' : 'Reativar'}</button>
                            <button className="btn sm danger" onClick={() => remove('warehouse', w.id, `${w.code} — ${w.name}`, 'O depósito será removido.')}><Trash2 aria-hidden />Excluir</button>
                          </span>
                        )}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </section>
      ))}
    </>
  );
}
