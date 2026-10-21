'use client';

import { Building2, Check, ImageUp, MapPin, Pencil, Plus, Power, Store, Trash2, Warehouse as WarehouseIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { Alert, Dialog, EmptyState, PageHeader, Skeleton, useUi } from '@/components/ui';
import { CepField, DocumentField, MaskedInput, UfSelect } from '@/components/fields';
import { formatCep, formatCnpj, formatPhone } from '@/lib/format';
import { useSession } from '@/lib/session';

interface Warehouse { id: string; code: string; name: string; kind: string; active: boolean; establishmentId: string }
interface Establishment {
  id: string; companyId: string; name: string; kind: string; cnpj: string | null; stateRegistration: string | null; cnae: string | null; zipCode: string | null; street: string | null;
  number: string | null; complement: string | null; district: string | null; city: string | null; state: string | null; active: boolean; warehouses: Warehouse[];
}
interface Company { id: string; legalName: string; tradeName: string | null; cnpj: string | null; taxRegime: string | null; responsible: string | null; contactEmail: string | null; contactPhone: string | null; active: boolean; establishments: Establishment[] }

type FormState =
  | { kind: 'company'; item?: Company }
  | { kind: 'establishment'; item?: Establishment; companyId?: string }
  | { kind: 'warehouse'; item?: Warehouse; establishmentId?: string }
  | null;

const REGIMES = [['SIMPLES_NACIONAL', 'Simples Nacional'], ['LUCRO_PRESUMIDO', 'Lucro Presumido'], ['LUCRO_REAL', 'Lucro Real'], ['MEI', 'MEI']];
const KINDS = [['MATRIZ', 'Matriz'], ['FILIAL', 'Filial'], ['CENTRO_DISTRIBUICAO', 'Centro de distribuição']];
const WKINDS = [['PROPRIO', 'Próprio'], ['TERCEIROS', 'De terceiros'], ['CONSIGNADO', 'Consignado']];
const PATHS = { company: 'companies', establishment: 'establishments', warehouse: 'warehouses' } as const;
const label = (list: string[][], v: string | null) => list.find(([k]) => k === v)?.[1] ?? v ?? '';

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

/** Reduz a imagem (máx. 600 px) no navegador para o envio ficar leve; PNG/WebP viram PNG (mantém transparência), JPEG segue JPEG. */
async function prepareLogo(file: File): Promise<{ contentType: string; base64: string }> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Use uma imagem PNG, JPG ou WebP (SVG não é aceito).');
  const toBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] ?? ''); r.onerror = () => reject(new Error('Não foi possível ler o arquivo.')); r.readAsDataURL(blob); });
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('Imagem inválida ou corrompida.')); i.src = url; });
    const max = Math.max(img.naturalWidth, img.naturalHeight);
    if (max <= 600 && file.size <= 1_000_000) return { contentType: file.type, base64: await toBase64(file) };
    const scale = Math.min(1, 600 / max);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Falha ao reduzir a imagem.'))), type, 0.9));
    return { contentType: type, base64: await toBase64(blob) };
  } finally { URL.revokeObjectURL(url); }
}

function Section({ title, why, children }: { title: string; why?: string; children: React.ReactNode }) {
  return <div className="form-section"><h3>{title}</h3>{why && <p className="why">{why}</p>}{children}</div>;
}
const Hint = ({ children }: { children: React.ReactNode }) => <div className="hint muted" style={{ fontSize: '0.78rem', marginTop: 4 }}>{children}</div>;

export default function EmpresaPage() {
  const { me, can, reload } = useSession();
  const ui = useUi();
  const manage = can('company.manage');
  const manageWh = can('warehouse.manage');
  const [tree, setTree] = useState<Company[] | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [form, setForm] = useState<FormState>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [logoBusy, setLogoBusy] = useState(false);

  const load = useCallback(() => { api<Company[]>('/structure').then(setTree).catch((e) => setError(e.message)); }, []);
  useEffect(load, [load]);

  const editing = !!form?.item;
  const open = (f: FormState) => { setForm(f); setError(''); setOk(''); };

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!form || busy) return;
    setBusy(true); setError(''); setOk('');
    const names = { company: ['Empresa', 'a'], establishment: ['Estabelecimento', 'o'], warehouse: ['Depósito', 'o'] }[form.kind];
    try {
      const body = payload(new FormData(e.currentTarget), editing);
      if (form.item) await api(`/${PATHS[form.kind]}/${form.item.id}`, 'PATCH', body);
      else await api(`/${PATHS[form.kind]}`, 'POST', body);
      ui.toast.ok(`${names[0]} ${editing ? `atualizad${names[1]}` : `cadastrad${names[1]}`}.`);
      setForm(null); load();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
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
    setError('');
    try { await api(`/${PATHS[kind]}/${id}`, 'DELETE'); ui.toast.ok('Registro excluído.'); load(); } catch (err) { setError((err as Error).message); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  }

  async function uploadLogo(file: File | undefined) {
    if (!file) return;
    setLogoBusy(true); setError('');
    try {
      const { contentType, base64 } = await prepareLogo(file);
      await api('/branding/logo', 'PUT', { contentType, contentBase64: base64 });
      await reload();
      ui.toast.ok('Logotipo atualizado. Ele já aparece no menu lateral.');
    } catch (e) { setError((e as Error).message); } finally { setLogoBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  }
  async function removeLogo() {
    if (!(await ui.confirm({ title: 'Remover o logotipo?', message: 'O menu volta a mostrar o nome do sistema.', confirmLabel: 'Remover', danger: true, cancelLabel: 'Voltar' }))) return;
    try { await api('/branding/logo', 'DELETE'); await reload(); ui.toast.ok('Logotipo removido.'); } catch (e) { setError((e as Error).message); }
  }

  const establishments = tree?.flatMap((c) => c.establishments.map((e) => ({ ...e, company: c.legalName }))) ?? [];
  const warehousesCount = establishments.reduce((n, e) => n + e.warehouses.length, 0);
  const hasCompany = !!tree?.length;
  const hasEst = establishments.length > 0;
  const hasWh = warehousesCount > 0;
  const allDone = hasCompany && hasEst && hasWh;
  const cItem = form?.kind === 'company' ? form.item : undefined;
  const eItem = form?.kind === 'establishment' ? form.item : undefined;
  const wItem = form?.kind === 'warehouse' ? form.item : undefined;
  const formKey = `${form?.kind}-${form?.item?.id ?? 'new'}`;
  const dialogTitle = form ? ({ company: 'empresa', establishment: 'estabelecimento', warehouse: 'depósito' }[form.kind]) : '';
  const Foot = () => (
    <div className="modal-foot">
      <button type="button" className="btn" onClick={() => setForm(null)}>Cancelar</button>
      <button className={`btn primary ${busy ? 'loading' : ''}`} disabled={busy}>{editing ? 'Salvar alterações' : 'Salvar'}</button>
    </div>
  );

  const steps = [
    { n: 1, icon: Building2, done: hasCompany, title: 'Cadastre a empresa', text: 'É o seu negócio perante a lei: razão social e CNPJ. Digite o CNPJ e buscamos os dados na Receita.', cta: 'Cadastrar empresa', go: () => open({ kind: 'company' }), enabled: manage },
    { n: 2, icon: Store, done: hasEst, title: 'Cadastre o estabelecimento', text: 'Cada local com CNPJ e inscrição estadual (matriz, filial). É ele quem emite notas fiscais.', cta: 'Cadastrar estabelecimento', go: () => open({ kind: 'establishment', companyId: tree?.[0]?.id }), enabled: manage && hasCompany },
    { n: 3, icon: WarehouseIcon, done: hasWh, title: 'Cadastre o depósito', text: 'O lugar físico onde o estoque fica. Sem depósito não há controle de estoque nem vendas.', cta: 'Cadastrar depósito', go: () => open({ kind: 'warehouse', establishmentId: establishments[0]?.id }), enabled: manageWh && hasEst },
  ];
  const firstTodo = steps.find((s) => !s.done);

  return (
    <>
      <PageHeader title="Empresa e estrutura" description="Aqui você diz quem é a sua empresa, onde ela opera e onde fica o estoque. Tudo no sistema (notas, estoque, vendas) se apoia nesta estrutura."
        actions={manage ? <button className="btn primary" onClick={() => open({ kind: 'company' })}><Plus aria-hidden />Nova empresa</button> : undefined} />
      {error && !form && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}

      {tree && (
        <section className="card" style={{ marginBottom: 16 }} aria-label="Passo a passo">
          <div className="card-head">
            <div>
              <h2>{allDone ? 'Estrutura configurada' : 'Comece por aqui'}</h2>
              <p className="muted" style={{ margin: 0 }}>{allDone ? 'Empresa → estabelecimento → depósito: tudo no lugar. Use os botões em cada cartão abaixo para ajustar.' : 'Siga os 3 passos na ordem. Cada um libera o próximo.'}</p>
            </div>
          </div>
          <div className="steps">
            {steps.map((s) => (
              <div key={s.n} className={`step ${s.done ? 'done' : s === firstTodo ? 'todo' : ''}`}>
                <span className="num-badge">{s.done ? <Check size={16} aria-label="concluído" /> : s.n}</span>
                <div>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                  {!s.done && s.enabled && <button className="btn sm primary" onClick={s.go}>{s.cta}</button>}
                  {!s.done && !s.enabled && <span className="muted" style={{ fontSize: '0.8rem' }}>{manage || manageWh ? 'Conclua o passo anterior primeiro.' : 'Peça a um administrador.'}</span>}
                  {s.done && <span className="badge ok">Concluído</span>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {manage && (
        <section className="card" style={{ marginBottom: 16 }} aria-label="Logotipo">
          <div className="card-head"><h2>Logotipo da empresa</h2></div>
          <div className="brand-box">
            <div className={`logo-preview ${me.tenant?.logoVersion ? '' : 'empty-logo'}`}>
              {me.tenant?.logoVersion
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={`/api/branding/logo?v=${me.tenant.logoVersion}`} alt={`Logotipo de ${me.tenant.name}`} />
                : <span>Sem logotipo.<br />O menu mostra o nome do sistema.</span>}
            </div>
            <div style={{ flex: 1, minWidth: 240 }}>
              <p style={{ marginTop: 0 }}>O logotipo aparece no <strong>topo do menu lateral</strong> no lugar do nome do sistema e será usado em outras telas e documentos.</p>
              <ul className="muted" style={{ margin: '0 0 12px', fontSize: '0.84rem' }}>
                <li>Formatos: <strong>PNG, JPG ou WebP</strong> (até 1 MB; reduzimos automaticamente).</li>
                <li>Melhor resultado: imagem <strong>horizontal</strong>, com <strong>fundo transparente</strong> (PNG).</li>
                <li>Use apenas uma imagem que você tem direito de usar.</li>
              </ul>
              <div className="row">
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => void uploadLogo(e.target.files?.[0])} aria-label="Selecionar logotipo" />
                <button className={`btn primary ${logoBusy ? 'loading' : ''}`} disabled={logoBusy} onClick={() => fileRef.current?.click()}><ImageUp aria-hidden />{me.tenant?.logoVersion ? 'Trocar logotipo' : 'Enviar logotipo'}</button>
                {me.tenant?.logoVersion && <button className="btn" onClick={removeLogo}><Trash2 aria-hidden />Remover</button>}
              </div>
            </div>
          </div>
        </section>
      )}

      {!tree && !error && <Skeleton rows={3} />}
      {tree?.length === 0 && <div className="card"><EmptyState icon={<Building2 size={22} />} title="Nenhuma empresa cadastrada ainda">Use o passo 1 acima para começar.</EmptyState></div>}

      {tree?.map((c) => {
        const whTotal = c.establishments.reduce((n, e) => n + e.warehouses.length, 0);
        return (
          <section className="org" key={c.id} style={{ opacity: c.active ? 1 : 0.8 }}>
            <div className="org-head">
              <div style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 8, marginBottom: 2 }}><Building2 size={18} aria-hidden style={{ color: 'var(--brand)' }} /><span className="muted" style={{ fontSize: '0.74rem', textTransform: 'uppercase', letterSpacing: '0.07em', fontWeight: 650 }}>Empresa</span>{!c.active && <span className="badge warn">Inativa</span>}</div>
                <h2>{c.legalName}</h2>
                <div className="meta">
                  {c.tradeName && <span><b>Fantasia:</b> {c.tradeName}</span>}
                  <span><b>CNPJ:</b> {c.cnpj ? formatCnpj(c.cnpj) : 'não informado'}</span>
                  <span><b>Regime:</b> {c.taxRegime ? label(REGIMES, c.taxRegime) : 'não informado'}</span>
                  {c.responsible && <span><b>Responsável:</b> {c.responsible}</span>}
                  {c.contactPhone && <span><b>Telefone:</b> {formatPhone(c.contactPhone)}</span>}
                  {c.contactEmail && <span><b>E-mail:</b> {c.contactEmail}</span>}
                </div>
                <div className="meta" style={{ marginTop: 4 }}><span>{c.establishments.length} estabelecimento(s) · {whTotal} depósito(s)</span></div>
              </div>
              {manage && (
                <div className="row">
                  <button className="btn sm" onClick={() => open({ kind: 'company', item: c })}><Pencil aria-hidden />Editar</button>
                  <button className="btn sm" onClick={() => toggle('company', c.id, c.active)}><Power aria-hidden />{c.active ? 'Desativar' : 'Reativar'}</button>
                  <button className="btn sm danger" onClick={() => remove('company', c.id, c.legalName, 'A empresa será removida.')}><Trash2 aria-hidden />Excluir</button>
                </div>
              )}
            </div>

            <div className="level">
              <div className="level-title">Estabelecimentos desta empresa</div>
              {c.establishments.length === 0 && (
                <div className="hint-empty">
                  <span>Nenhum estabelecimento ainda. É preciso ao menos um (a matriz) para emitir notas e ter depósitos.</span>
                  {manage && <button className="btn sm primary" onClick={() => open({ kind: 'establishment', companyId: c.id })}><Plus aria-hidden />Adicionar estabelecimento</button>}
                </div>
              )}
              {c.establishments.map((e) => (
                <div className="est" key={e.id} style={{ opacity: e.active ? 1 : 0.75 }}>
                  <div className="est-head">
                    <div style={{ minWidth: 0 }}>
                      <div className="row" style={{ gap: 8 }}>
                        <Store size={16} aria-hidden style={{ color: 'var(--brand)' }} /><strong>{e.name}</strong>
                        <span className="badge">{label(KINDS, e.kind)}</span>
                        {!e.active && <span className="badge warn">Inativo</span>}
                        {!e.stateRegistration && <span className="badge warn" title="Necessária para emitir notas fiscais">IE pendente</span>}
                      </div>
                      <div className="meta" style={{ marginTop: 4 }}>
                        {e.cnpj && <span><b>CNPJ:</b> {formatCnpj(e.cnpj)}</span>}
                        {e.stateRegistration && <span><b>IE:</b> {e.stateRegistration}</span>}
                        {(e.city || e.zipCode) && <span><MapPin size={12} aria-hidden style={{ verticalAlign: '-1px' }} /> {[e.street && `${e.street}${e.number ? `, ${e.number}` : ''}`, e.district, e.city && `${e.city}${e.state ? `/${e.state}` : ''}`, e.zipCode && formatCep(e.zipCode)].filter(Boolean).join(' · ')}</span>}
                      </div>
                    </div>
                    {manage && (
                      <div className="row">
                        <button className="btn sm" onClick={() => open({ kind: 'establishment', item: e })}><Pencil aria-hidden />Editar</button>
                        <button className="btn sm" onClick={() => toggle('establishment', e.id, e.active)}><Power aria-hidden />{e.active ? 'Desativar' : 'Reativar'}</button>
                        <button className="btn sm danger" onClick={() => remove('establishment', e.id, e.name, 'O estabelecimento será removido (os depósitos precisam ser excluídos antes).')}><Trash2 aria-hidden />Excluir</button>
                      </div>
                    )}
                  </div>
                  <div className="wh-list">
                    <div className="level-title" style={{ margin: '8px 0 4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>Depósitos (onde o estoque fica)</span>
                      {manageWh && <button className="btn sm" onClick={() => open({ kind: 'warehouse', establishmentId: e.id })}><Plus aria-hidden />Depósito</button>}
                    </div>
                    {e.warehouses.length === 0 && <div className="muted" style={{ fontSize: '0.85rem', padding: '6px 0' }}>Nenhum depósito neste estabelecimento. Sem depósito não há como controlar estoque aqui.</div>}
                    {e.warehouses.map((w) => (
                      <div className="wh" key={w.id} style={{ opacity: w.active ? 1 : 0.7 }}>
                        <span className="code">{w.code}</span>
                        <span className="grow"><strong style={{ fontWeight: 600 }}>{w.name}</strong> <span className="muted">· {label(WKINDS, w.kind)}</span></span>
                        <span className={`badge ${w.active ? 'ok' : 'warn'}`}>{w.active ? 'Ativo' : 'Inativo'}</span>
                        {manageWh && (
                          <span className="row" style={{ gap: 6 }}>
                            <button className="btn sm" onClick={() => open({ kind: 'warehouse', item: w })}><Pencil aria-hidden />Editar</button>
                            <button className="btn sm" onClick={() => toggle('warehouse', w.id, w.active)}><Power aria-hidden />{w.active ? 'Desativar' : 'Reativar'}</button>
                            <button className="btn sm danger" onClick={() => remove('warehouse', w.id, `${w.code} — ${w.name}`, 'O depósito será removido.')}><Trash2 aria-hidden />Excluir</button>
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {c.establishments.length > 0 && manage && (
                <p style={{ margin: '0 0 14px' }}><button className="btn sm" onClick={() => open({ kind: 'establishment', companyId: c.id })}><Plus aria-hidden />Adicionar estabelecimento</button></p>
              )}
            </div>
          </section>
        );
      })}

      {form && (
        <Dialog wide onClose={() => setForm(null)} title={`${editing ? 'Editar' : 'Novo(a)'} ${dialogTitle}`.replace('Novo(a) empresa', 'Nova empresa').replace('Novo(a) estabelecimento', 'Novo estabelecimento').replace('Novo(a) depósito', 'Novo depósito')}
          description={form.kind === 'company' ? 'Dados do seu negócio. Comece pelo CNPJ: buscamos o restante para você.' : form.kind === 'establishment' ? 'Um local com CNPJ e inscrição estadual (matriz ou filial).' : 'O lugar físico onde o estoque fica.'}>
          <form key={formKey} onSubmit={submit}>
            <div className="modal-body">
              {error && <Alert kind="error">{error}</Alert>}

              {form.kind === 'company' && (
                <>
                  <Section title="Identificação" why="Informe o CNPJ primeiro: ao completar os 14 dígitos, razão social, nome fantasia e contato são preenchidos (você pode corrigir).">
                    <div className="form-grid">
                      <div><label htmlFor="cnpj">CNPJ</label><DocumentField id="cnpj" name="cnpj" kind="cnpj" defaultValue={cItem?.cnpj ?? undefined} fill={{ legalName: 'legalName', tradeName: 'tradeName', contactEmail: 'email', contactPhone: 'phone' }} /></div>
                      <div><label htmlFor="legalName" className="req">Razão social</label><input id="legalName" name="legalName" required defaultValue={cItem?.legalName} /></div>
                      <div><label htmlFor="tradeName">Nome fantasia</label><input id="tradeName" name="tradeName" defaultValue={cItem?.tradeName ?? ''} /></div>
                      <div><label htmlFor="taxRegime">Regime tributário</label><select id="taxRegime" name="taxRegime" defaultValue={cItem?.taxRegime ?? ''}><option value="">Selecione…</option>{REGIMES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select><Hint>Confirme com o seu contador.</Hint></div>
                    </div>
                  </Section>
                  <Section title="Contato" why="Quem responde pela empresa e como falar com ela.">
                    <div className="form-grid">
                      <div><label htmlFor="responsible">Responsável</label><input id="responsible" name="responsible" defaultValue={cItem?.responsible ?? ''} /></div>
                      <div><label htmlFor="contactEmail">E-mail de contato</label><input id="contactEmail" name="contactEmail" type="email" defaultValue={cItem?.contactEmail ?? ''} /></div>
                      <div><label htmlFor="contactPhone">Telefone de contato</label><MaskedInput id="contactPhone" name="contactPhone" kind="phone" defaultValue={cItem?.contactPhone ?? undefined} /></div>
                    </div>
                  </Section>
                </>
              )}

              {form.kind === 'establishment' && (
                <>
                  {eItem && <Alert kind="info">Se o estabelecimento já tem documentos fiscais, CNPJ, UF e inscrição estadual ficam bloqueados (fazem parte da chave de acesso das notas).</Alert>}
                  <Section title="Identificação" why="A qual empresa pertence e qual o tipo. Se tiver CNPJ próprio, digite-o para preencher nome e endereço.">
                    <div className="form-grid">
                      <div><label htmlFor="companyId" className="req">Empresa</label><select id="companyId" name="companyId" required disabled={editing} defaultValue={eItem?.companyId ?? (form.kind === 'establishment' ? form.companyId : undefined)}>{tree?.map((c) => <option key={c.id} value={c.id}>{c.legalName}</option>)}</select></div>
                      <div><label htmlFor="kind" className="req">Tipo</label><select id="kind" name="kind" required disabled={editing} defaultValue={eItem?.kind}>{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
                      <div><label htmlFor="ecnpj">CNPJ do estabelecimento</label><DocumentField id="ecnpj" name="cnpj" kind="cnpj" defaultValue={eItem?.cnpj ?? undefined} fill={{ name: 'displayName', cnae: 'cnae', zipCode: 'zipCode', street: 'street', number: 'number', complement: 'complement', district: 'district', city: 'city', state: 'state' }} /></div>
                      <div><label htmlFor="name" className="req">Nome</label><input id="name" name="name" required defaultValue={eItem?.name} placeholder="Ex.: Matriz Campinas" /></div>
                    </div>
                  </Section>
                  <Section title="Dados fiscais" why="Usados nas notas fiscais. A inscrição estadual não vem da consulta pública: informe conforme o cadastro da Sefaz.">
                    <div className="form-grid">
                      <div><label htmlFor="stateRegistration">Inscrição estadual</label><input id="stateRegistration" name="stateRegistration" inputMode="numeric" defaultValue={eItem?.stateRegistration ?? ''} /></div>
                      <div><label htmlFor="cnae">CNAE principal</label><MaskedInput id="cnae" name="cnae" kind="cnae" defaultValue={eItem?.cnae ?? undefined} /></div>
                    </div>
                  </Section>
                  <Section title="Endereço" why="Digite o CEP e o endereço é preenchido; falta só o número.">
                    <div className="form-grid">
                      <div><label htmlFor="zipCode">CEP</label><CepField id="zipCode" defaultValue={eItem?.zipCode ?? undefined} fill={{ street: 'street', district: 'district', city: 'city', state: 'state' }} /></div>
                      <div><label htmlFor="street">Logradouro</label><input id="street" name="street" defaultValue={eItem?.street ?? ''} /></div>
                      <div><label htmlFor="number">Número</label><input id="number" name="number" defaultValue={eItem?.number ?? ''} /></div>
                      <div><label htmlFor="complement">Complemento</label><input id="complement" name="complement" defaultValue={eItem?.complement ?? ''} /></div>
                      <div><label htmlFor="district">Bairro</label><input id="district" name="district" defaultValue={eItem?.district ?? ''} /></div>
                      <div><label htmlFor="city">Município</label><input id="city" name="city" defaultValue={eItem?.city ?? ''} /></div>
                      <div><label htmlFor="state">UF</label><UfSelect id="state" defaultValue={eItem?.state ?? ''} /></div>
                    </div>
                  </Section>
                </>
              )}

              {form.kind === 'warehouse' && (
                <Section title="Depósito" why="O código identifica o depósito em movimentos e planilhas (ex.: CD01) e não pode ser alterado depois.">
                  <div className="form-grid">
                    <div><label htmlFor="establishmentId" className="req">Estabelecimento</label><select id="establishmentId" name="establishmentId" required disabled={editing} defaultValue={wItem?.establishmentId ?? (form.kind === 'warehouse' ? form.establishmentId : undefined)}>{establishments.map((e) => <option key={e.id} value={e.id}>{e.name} — {e.company}</option>)}</select></div>
                    <div><label htmlFor="code" className="req">Código</label><input id="code" name="code" required placeholder="CD01" disabled={editing} defaultValue={wItem?.code} /></div>
                    <div><label htmlFor="wname" className="req">Nome</label><input id="wname" name="name" required defaultValue={wItem?.name} placeholder="Ex.: Depósito principal" /></div>
                    <div><label htmlFor="wkind">Tipo</label><select id="wkind" name="kind" defaultValue={wItem?.kind ?? 'PROPRIO'}>{WKINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select><Hint>Próprio: é seu. De terceiros: guardado por outra empresa. Consignado: mercadoria em poder de terceiro.</Hint></div>
                  </div>
                </Section>
              )}
            </div>
            <Foot />
          </form>
        </Dialog>
      )}
    </>
  );
}
