'use client';

import { Plus } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { PageHeader, Alert, Skeleton } from '@/components/ui';
import { CepField, DocumentField, MaskedInput, UfSelect } from '@/components/fields';
import { formatCnpj } from '@/lib/format';
import { useSession } from '@/lib/session';

interface Warehouse { id: string; code: string; name: string; kind: string; active: boolean }
interface Establishment { id: string; name: string; kind: string; cnpj: string | null; stateRegistration: string | null; city: string | null; state: string | null; active: boolean; warehouses: Warehouse[] }
interface Company { id: string; legalName: string; tradeName: string | null; cnpj: string | null; taxRegime: string | null; establishments: Establishment[] }

const REGIMES = [['SIMPLES_NACIONAL', 'Simples Nacional'], ['LUCRO_PRESUMIDO', 'Lucro Presumido'], ['LUCRO_REAL', 'Lucro Real'], ['MEI', 'MEI']];
const KINDS = [['MATRIZ', 'Matriz'], ['FILIAL', 'Filial'], ['CENTRO_DISTRIBUICAO', 'Centro de distribuição']];
const WKINDS = [['PROPRIO', 'Próprio'], ['TERCEIROS', 'De terceiros'], ['CONSIGNADO', 'Consignado']];

const clean = (f: FormData) =>
  Object.fromEntries([...f.entries()].filter(([, v]) => typeof v === 'string' && v.trim() !== '').map(([k, v]) => [k, (v as string).trim()]));

export default function EmpresaPage() {
  const { can } = useSession();
  const manage = can('company.manage');
  const manageWh = can('warehouse.manage');
  const [tree, setTree] = useState<Company[] | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [form, setForm] = useState<'company' | 'establishment' | 'warehouse' | null>(null);

  const load = useCallback(() => {
    api<Company[]>('/structure').then(setTree).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function submit(e: FormEvent<HTMLFormElement>, path: string, message: string) {
    e.preventDefault();
    setError('');
    setOk('');
    try {
      await api(path, 'POST', clean(new FormData(e.currentTarget)));
      setOk(message);
      setForm(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function toggle(path: string, active: boolean) {
    setError('');
    try {
      await api(path, 'PATCH', { active: !active });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const establishments = tree?.flatMap((c) => c.establishments.map((e) => ({ ...e, company: c.legalName }))) ?? [];

  return (
    <>
      <PageHeader title="Empresa, estabelecimentos e depósitos" description={<>Empresa ≠ estabelecimento (CNPJ/IE) ≠ depósito (local físico do estoque).</>} actions={<>
          {manage && <button className="btn" onClick={() => setForm('company')}><Plus aria-hidden />Empresa</button>}
          {manage && <button className="btn" onClick={() => setForm('establishment')} disabled={!tree?.length}><Plus aria-hidden />Estabelecimento</button>}
          {manageWh && <button className="btn" onClick={() => setForm('warehouse')} disabled={!establishments.length}><Plus aria-hidden />Depósito</button>}
        </>} />
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}

      {form === 'company' && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={(e) => submit(e, '/companies', 'Empresa cadastrada.')}>
          <h2>Nova empresa</h2>
          <div className="form-grid">
            <div><label htmlFor="cnpj">CNPJ</label><DocumentField id="cnpj" name="cnpj" kind="cnpj" fill={{ legalName: 'legalName', tradeName: 'tradeName', contactEmail: 'email', contactPhone: 'phone' }} /></div>
            <div><label htmlFor="legalName">Razão social *</label><input id="legalName" name="legalName" required /></div>
            <div><label htmlFor="tradeName">Nome fantasia</label><input id="tradeName" name="tradeName" /></div>
            <div><label htmlFor="taxRegime">Regime tributário</label><select id="taxRegime" name="taxRegime" defaultValue=""><option value="">Selecione…</option>{REGIMES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            <div><label htmlFor="responsible">Responsável</label><input id="responsible" name="responsible" /></div>
            <div><label htmlFor="contactEmail">E-mail de contato</label><input id="contactEmail" name="contactEmail" type="email" /></div>
            <div><label htmlFor="contactPhone">Telefone de contato</label><MaskedInput id="contactPhone" name="contactPhone" kind="phone" /></div>
          </div>
          <p className="muted">O regime tributário informado aqui deve ser validado pelo seu contador (assistente fiscal na Fase 6).</p>
          <div className="row"><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={() => setForm(null)}>Cancelar</button></div>
        </form>
      )}

      {form === 'establishment' && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={(e) => submit(e, '/establishments', 'Estabelecimento cadastrado.')}>
          <h2>Novo estabelecimento</h2>
          <div className="form-grid">
            <div><label htmlFor="companyId">Empresa *</label><select id="companyId" name="companyId" required>{tree?.map((c) => <option key={c.id} value={c.id}>{c.legalName}</option>)}</select></div>
            <div><label htmlFor="kind">Tipo *</label><select id="kind" name="kind" required>{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            <div><label htmlFor="ecnpj">CNPJ do estabelecimento</label><DocumentField id="ecnpj" name="cnpj" kind="cnpj" fill={{name: 'displayName',cnae: 'cnae',zipCode: 'zipCode',street: 'street',number: 'number',complement: 'complement',district: 'district',city: 'city',state: 'state'}} /></div>
            <div><label htmlFor="name">Nome *</label><input id="name" name="name" required /></div>
            <div><label htmlFor="stateRegistration">Inscrição estadual</label><input id="stateRegistration" name="stateRegistration" inputMode="numeric" /><div className="hint muted" style={{ fontSize: '0.78rem', marginTop: 4 }}>Não consta na consulta pública: informe conforme o cadastro estadual.</div></div>
            <div><label htmlFor="cnae">CNAE principal</label><MaskedInput id="cnae" name="cnae" kind="cnae" /></div>
            <div><label htmlFor="zipCode">CEP</label><CepField id="zipCode" fill={{ street: 'street', district: 'district', city: 'city', state: 'state' }} /></div>
            <div><label htmlFor="street">Logradouro</label><input id="street" name="street" /></div>
            <div><label htmlFor="number">Número</label><input id="number" name="number" /></div>
            <div><label htmlFor="complement">Complemento</label><input id="complement" name="complement" /></div>
            <div><label htmlFor="district">Bairro</label><input id="district" name="district" /></div>
            <div><label htmlFor="city">Município</label><input id="city" name="city" /></div>
            <div><label htmlFor="state">UF</label><UfSelect id="state" /></div>
          </div>
          <div className="row" style={{ marginTop: 12 }}><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={() => setForm(null)}>Cancelar</button></div>
        </form>
      )}

      {form === 'warehouse' && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={(e) => submit(e, '/warehouses', 'Depósito cadastrado.')}>
          <h2>Novo depósito</h2>
          <div className="form-grid">
            <div><label htmlFor="establishmentId">Estabelecimento *</label><select id="establishmentId" name="establishmentId" required>{establishments.map((e) => <option key={e.id} value={e.id}>{e.name} — {e.company}</option>)}</select></div>
            <div><label htmlFor="code">Código *</label><input id="code" name="code" required placeholder="CD01" /></div>
            <div><label htmlFor="wname">Nome *</label><input id="wname" name="name" required /></div>
            <div><label htmlFor="wkind">Tipo</label><select id="wkind" name="kind" defaultValue="PROPRIO">{WKINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
          </div>
          <div className="row" style={{ marginTop: 12 }}><button className="btn primary">Salvar</button><button type="button" className="btn" onClick={() => setForm(null)}>Cancelar</button></div>
        </form>
      )}

      {!tree && !error && <Skeleton rows={3} />}
      {tree?.length === 0 && <div className="card empty">Nenhuma empresa cadastrada ainda. Use “+ Empresa” para começar.</div>}
      {tree?.map((c) => (
        <section className="card" key={c.id} style={{ marginBottom: 16 }}>
          <h2>{c.legalName} {c.taxRegime && <span className="badge">{REGIMES.find(([v]) => v === c.taxRegime)?.[1]}</span>}</h2>
          <p className="muted">{c.tradeName ?? '—'} · CNPJ {c.cnpj ? formatCnpj(c.cnpj) : 'não informado'}</p>
          {c.establishments.length === 0 && <div className="empty">Sem estabelecimentos.</div>}
          {c.establishments.map((e) => (
            <div key={e.id} style={{ marginTop: 12 }}>
              <div className="row">
                <strong>{e.name}</strong>
                <span className="badge">{KINDS.find(([v]) => v === e.kind)?.[1]}</span>
                {!e.active && <span className="badge warn">Inativo</span>}
                <span className="muted">{[e.city, e.state].filter(Boolean).join('/')} · IE {e.stateRegistration ?? 'pendente'}</span>
                {manage && <button className="btn sm" onClick={() => toggle(`/establishments/${e.id}`, e.active)}>{e.active ? 'Desativar' : 'Reativar'}</button>}
              </div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Código</th><th>Depósito</th><th>Tipo</th><th>Situação</th><th /></tr></thead>
                  <tbody>
                    {e.warehouses.length === 0 && <tr><td colSpan={5} className="muted">Sem depósitos.</td></tr>}
                    {e.warehouses.map((w) => (
                      <tr key={w.id}>
                        <td>{w.code}</td><td>{w.name}</td><td>{WKINDS.find(([v]) => v === w.kind)?.[1]}</td>
                        <td><span className={`badge ${w.active ? 'ok' : 'warn'}`}>{w.active ? 'Ativo' : 'Inativo'}</span></td>
                        <td>{manageWh && <button className="btn sm" onClick={() => toggle(`/warehouses/${w.id}`, w.active)}>{w.active ? 'Desativar' : 'Reativar'}</button>}</td>
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
