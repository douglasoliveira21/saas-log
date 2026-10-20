'use client';

import { Loader2, MapPin, Search } from 'lucide-react';
import { useRef, useState, type ComponentProps } from 'react';
import { api } from '@/lib/api';
import { digits, formatCep, formatCnae, formatCnpj, formatCpf, formatCpfCnpj, formatPhone } from '@/lib/format';

export type MaskKind = 'cnpj' | 'cpf' | 'cpfcnpj' | 'phone' | 'cep' | 'cnae' | 'tracking';

const MASKS: Record<MaskKind, { fn: (v: string) => string; max: number; placeholder: string; mode: 'numeric' | 'text' }> = {
  cnpj: { fn: formatCnpj, max: 18, placeholder: '00.000.000/0000-00', mode: 'numeric' },
  cpf: { fn: formatCpf, max: 14, placeholder: '000.000.000-00', mode: 'numeric' },
  cpfcnpj: { fn: formatCpfCnpj, max: 18, placeholder: 'CPF ou CNPJ', mode: 'numeric' },
  phone: { fn: formatPhone, max: 15, placeholder: '(00) 00000-0000', mode: 'numeric' },
  cep: { fn: formatCep, max: 9, placeholder: '00000-000', mode: 'numeric' },
  cnae: { fn: formatCnae, max: 9, placeholder: '0000-0/00', mode: 'numeric' },
  tracking: { fn: (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 13), max: 13, placeholder: 'AA123456789BR', mode: 'text' },
};
export const maskValue = (kind: MaskKind, v: string) => MASKS[kind].fn(v);

type InputProps = Omit<ComponentProps<'input'>, 'type'>;

/** Campo com máscara aplicada enquanto se digita (CPF, CNPJ, telefone, CEP, CNAE). O valor enviado é o formatado; o servidor guarda só os dígitos. */
export function MaskedInput({ kind, defaultValue, onInput, ...rest }: InputProps & { kind: MaskKind }) {
  const m = MASKS[kind];
  return (
    <input
      type="text" inputMode={m.mode} autoComplete="off" maxLength={m.max} placeholder={m.placeholder} data-mask={kind}
      defaultValue={defaultValue != null ? m.fn(String(defaultValue)) : undefined}
      onInput={(e) => { const el = e.currentTarget; const next = m.fn(el.value); if (next !== el.value) el.value = next; onInput?.(e); }}
      {...rest}
    />
  );
}

export const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];

export function UfSelect({ id, name = 'state', defaultValue = '', required }: { id?: string; name?: string; defaultValue?: string; required?: boolean }) {
  return (
    <select id={id} name={name} defaultValue={defaultValue} required={required}>
      <option value="">—</option>
      {UFS.map((u) => <option key={u} value={u}>{u}</option>)}
    </select>
  );
}

/** Resultado das consultas (mesmos nomes devolvidos por /lookup). */
export interface LookupResult {
  legalName?: string; tradeName?: string; displayName?: string; email?: string; phone?: string; cnae?: string;
  zipCode?: string; street?: string; number?: string; complement?: string; district?: string; city?: string; state?: string;
}
/** { nome do campo no formulário: chave do resultado } */
export type FillMap = Record<string, keyof LookupResult>;

function setField(form: HTMLFormElement, name: string, value: string | undefined, overwrite: boolean) {
  if (!value) return;
  const el = form.elements.namedItem(name);
  if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) return;
  if (!overwrite && el.value.trim()) return;
  const mask = el.dataset.mask as MaskKind | undefined;
  const v = mask && MASKS[mask] ? MASKS[mask].fn(value) : value;
  if (el instanceof HTMLSelectElement && ![...el.options].some((o) => o.value === v)) return;
  el.value = v;
}
function fill(form: HTMLFormElement | null, map: FillMap, data: LookupResult, overwrite: boolean) {
  if (form) for (const [field, key] of Object.entries(map)) setField(form, field, data[key], overwrite);
}

type Status = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ok'; text: string; warn?: boolean } | { kind: 'error'; text: string };

function StatusLine({ s }: { s: Status }) {
  if (s.kind === 'idle') return null;
  if (s.kind === 'loading') return <div className="hint muted" aria-live="polite">Consultando…</div>;
  return <div className="hint" role={s.kind === 'error' ? 'alert' : 'status'} style={{ color: s.kind === 'error' || (s.kind === 'ok' && s.warn) ? 'var(--warn)' : 'var(--ok)', fontSize: '0.78rem', marginTop: 4 }}>{s.text}</div>;
}

/**
 * CPF/CNPJ com máscara. Com 14 dígitos (CNPJ válido) consulta a base pública e preenche os campos vazios do formulário;
 * o botão "Buscar" refaz a consulta substituindo os campos. CPF não tem consulta pública: só máscara e validação no envio.
 */
export function DocumentField({ id, name, kind = 'cpfcnpj', fill: map, defaultValue, required }: { id: string; name: string; kind?: 'cnpj' | 'cpfcnpj'; fill?: FillMap; defaultValue?: string; required?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [st, setSt] = useState<Status>({ kind: 'idle' });

  async function run(overwrite: boolean) {
    const el = ref.current;
    if (!el) return;
    const d = digits(el.value);
    if (d.length !== 14) { setSt({ kind: 'error', text: 'Informe um CNPJ completo (14 dígitos) para consultar.' }); return; }
    setSt({ kind: 'loading' });
    try {
      const r = await api<LookupResult & { legalName: string; status: string; active: boolean; branch: string | null; address: LookupResult }>(`/lookup/cnpj/${d}`);
      const flat: LookupResult = { ...r.address, legalName: r.legalName, tradeName: r.tradeName, displayName: r.tradeName ?? r.legalName, email: r.email, phone: r.phone, cnae: r.cnae };
      fill(el.form, map ?? {}, flat, overwrite);
      setSt({ kind: 'ok', text: `${r.legalName} — situação ${r.status.toLowerCase()}${r.branch ? ` · ${r.branch.toLowerCase()}` : ''}. Confira os dados preenchidos.`, warn: !r.active });
    } catch (e) {
      setSt({ kind: 'error', text: (e as Error).message });
    }
  }

  return (
    <div>
      <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
        <MaskedInput id={id} name={name} kind={kind} ref={ref} defaultValue={defaultValue} required={required} onInput={(e) => { if (map && digits(e.currentTarget.value).length === 14) void run(false); else if (st.kind !== 'idle') setSt({ kind: 'idle' }); }} />
        {map && (
          <button type="button" className="btn icon" onClick={() => run(true)} aria-label="Buscar dados do CNPJ na Receita Federal" title="Buscar dados do CNPJ" disabled={st.kind === 'loading'}>
            {st.kind === 'loading' ? <Loader2 className="spin" aria-hidden /> : <Search aria-hidden />}
          </button>
        )}
      </div>
      <StatusLine s={st} />
    </div>
  );
}

/** CEP com máscara; com 8 dígitos consulta o endereço e preenche os campos vazios (botão refaz e substitui). */
export function CepField({ id, name = 'zipCode', fill: map, defaultValue }: { id: string; name?: string; fill: FillMap; defaultValue?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [st, setSt] = useState<Status>({ kind: 'idle' });

  async function run(overwrite: boolean) {
    const el = ref.current;
    if (!el) return;
    const d = digits(el.value);
    if (d.length !== 8) { setSt({ kind: 'error', text: 'Informe os 8 dígitos do CEP.' }); return; }
    setSt({ kind: 'loading' });
    try {
      const r = await api<LookupResult>(`/lookup/cep/${d}`);
      fill(el.form, map, r, overwrite);
      setSt({ kind: 'ok', text: [r.street, r.district, r.city && r.state ? `${r.city}/${r.state}` : r.city].filter(Boolean).join(' — ') || 'CEP encontrado.' });
      const next = el.form?.elements.namedItem('number');
      if (next instanceof HTMLInputElement && !next.value) next.focus();
    } catch (e) {
      setSt({ kind: 'error', text: (e as Error).message });
    }
  }

  return (
    <div>
      <div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
        <MaskedInput id={id} name={name} kind="cep" ref={ref} defaultValue={defaultValue} onInput={(e) => { if (digits(e.currentTarget.value).length === 8) void run(false); else if (st.kind !== 'idle') setSt({ kind: 'idle' }); }} />
        <button type="button" className="btn icon" onClick={() => run(true)} aria-label="Buscar endereço pelo CEP" title="Buscar endereço" disabled={st.kind === 'loading'}>
          {st.kind === 'loading' ? <Loader2 className="spin" aria-hidden /> : <MapPin aria-hidden />}
        </button>
      </div>
      <StatusLine s={st} />
    </div>
  );
}
