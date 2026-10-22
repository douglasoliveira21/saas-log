'use client';

import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, CheckCircle2, Info, Inbox, X, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';

/* ───────────────────────── toasts + diálogos ───────────────────────── */

type ToastKind = 'ok' | 'error' | 'info';
interface ToastItem { id: number; kind: ToastKind; message: string }

export interface FormField {
  name: string; label: string; type?: 'text' | 'number' | 'textarea' | 'select'; defaultValue?: string | number; required?: boolean;
  hint?: string; min?: number; max?: number; step?: string; options?: { value: string; label: string }[];
}
interface DialogOpts { title: string; message?: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean }
interface FormOpts extends DialogOpts { fields: FormField[] }

interface UiApi {
  toast: { ok: (m: string) => void; error: (m: string) => void; info: (m: string) => void };
  confirm: (o: DialogOpts) => Promise<boolean>;
  form: (o: FormOpts) => Promise<Record<string, string> | null>;
  /** Pede um único texto (substitui window.prompt). Retorna null se cancelado. */
  prompt: (o: DialogOpts & { label: string; defaultValue?: string; required?: boolean; multiline?: boolean }) => Promise<string | null>;
}

const Ctx = createContext<UiApi | null>(null);
export function useUi(): UiApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useUi fora do UiProvider');
  return v;
}

type Pending = { kind: 'confirm'; o: DialogOpts; resolve: (v: boolean) => void } | { kind: 'form'; o: FormOpts; resolve: (v: Record<string, string> | null) => void };

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [dialog, setDialog] = useState<Pending | null>(null);
  const seq = useRef(0);

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-3), { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4500);
  }, []);

  const api = useMemo<UiApi>(() => ({
    toast: { ok: (m) => push('ok', m), error: (m) => push('error', m), info: (m) => push('info', m) },
    confirm: (o) => new Promise((resolve) => setDialog({ kind: 'confirm', o, resolve })),
    form: (o) => new Promise((resolve) => setDialog({ kind: 'form', o, resolve })),
    prompt: async (o) => {
      const r = await new Promise<Record<string, string> | null>((resolve) =>
        setDialog({ kind: 'form', o: { ...o, fields: [{ name: 'v', label: o.label, type: o.multiline ? 'textarea' : 'text', defaultValue: o.defaultValue, required: o.required ?? true }] }, resolve }));
      return r ? r.v : null;
    },
  }), [push]);

  const close = (result: boolean | Record<string, string> | null) => {
    if (!dialog) return;
    (dialog.resolve as (v: unknown) => void)(dialog.kind === 'confirm' ? result === true : result && typeof result === 'object' ? result : null);
    setDialog(null);
  };

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind === 'ok' ? <CheckCircle2 className="t-ico" /> : t.kind === 'error' ? <XCircle className="t-ico" /> : <Info className="t-ico" />}
            <span className="t-msg">{t.message}</span>
            <button className="btn ghost sm icon" aria-label="Fechar aviso" onClick={() => setToasts((x) => x.filter((i) => i.id !== t.id))}><X /></button>
          </div>
        ))}
      </div>
      {dialog && <Modal pending={dialog} onClose={close} />}
    </Ctx.Provider>
  );
}

function Modal({ pending, onClose }: { pending: Pending; onClose: (r: boolean | Record<string, string> | null) => void }) {
  const titleId = useId();
  const { o } = pending;
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input, select, textarea') ?? ref.current?.querySelector<HTMLElement>('button.primary, button.danger');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose(pending.kind === 'confirm' ? false : null);
      if (e.key === 'Tab' && ref.current) { // mantém o foco dentro do diálogo
        const els = [...ref.current.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href]')].filter((el) => !el.hasAttribute('disabled'));
        if (!els.length) return;
        const [a, b] = [els[0], els[els.length - 1]];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
        else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return; // evita envio duplicado
    setBusy(true);
    if (pending.kind === 'confirm') return onClose(true);
    const f = new FormData(e.currentTarget);
    onClose(Object.fromEntries(pending.o.fields.map((fd) => [fd.name, String(f.get(fd.name) ?? '').trim()])));
  }

  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(pending.kind === 'confirm' ? false : null); }}>
      <form className="modal" role={pending.kind === 'confirm' && o.danger ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby={titleId} ref={ref as never} onSubmit={submit}>
        <div className="modal-head"><h2 id={titleId}>{o.title}</h2></div>
        <div className="modal-body">
          {o.message && <div style={{ marginBottom: pending.kind === 'form' ? 12 : 0 }}>{o.message}</div>}
          {pending.kind === 'form' && (
            <div className="stack" style={{ gap: 12 }}>
              {pending.o.fields.map((fd) => (
                <div key={fd.name}>
                  <label htmlFor={`${titleId}-${fd.name}`} className={fd.required ? 'req' : ''}>{fd.label}</label>
                  {fd.type === 'textarea' ? <textarea id={`${titleId}-${fd.name}`} name={fd.name} defaultValue={fd.defaultValue} required={fd.required} />
                    : fd.type === 'select' ? <select id={`${titleId}-${fd.name}`} name={fd.name} defaultValue={fd.defaultValue} required={fd.required}>{fd.options?.map((op) => <option key={op.value} value={op.value}>{op.label}</option>)}</select>
                    : <input id={`${titleId}-${fd.name}`} name={fd.name} type={fd.type ?? 'text'} defaultValue={fd.defaultValue} required={fd.required} min={fd.min} max={fd.max} step={fd.step} />}
                  {fd.hint && <div className="hint muted" style={{ fontSize: '0.78rem', marginTop: 4 }}>{fd.hint}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={() => onClose(pending.kind === 'confirm' ? false : null)}>{o.cancelLabel ?? 'Cancelar'}</button>
          <button type="submit" className={`btn ${o.danger ? 'danger' : 'primary'}`} disabled={busy}>{o.confirmLabel ?? 'Confirmar'}</button>
        </div>
      </form>
    </div>
  );
}

/* ───────────────────────── blocos de página ───────────────────────── */

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="titles"><h1>{title}</h1>{description && <p>{description}</p>}</div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="ico">{icon ?? <Inbox size={22} />}</div>
      <strong>{title}</strong>
      {children && <span>{children}</span>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return <div aria-busy="true" aria-label="Carregando">{Array.from({ length: rows }, (_, i) => <span key={i} className="skeleton row-h" />)}</div>;
}

export function StatCard({ label, value, icon, hint, tone }: { label: string; value: ReactNode; icon?: ReactNode; hint?: ReactNode; tone?: 'ok' | 'warn' | 'danger' }) {
  return (
    <div className={`card stat ${tone ?? ''}`}>
      <div className="label"><span>{label}</span>{icon && <span className="stat-ico" aria-hidden>{icon}</span>}</div>
      <div className="n">{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Alert({ kind, children }: { kind: 'error' | 'ok' | 'warn' | 'info'; children: ReactNode }) {
  const I = kind === 'error' ? XCircle : kind === 'ok' ? CheckCircle2 : kind === 'warn' ? AlertTriangle : Info;
  return <div className={`alert ${kind}`} role={kind === 'error' ? 'alert' : 'status'}><I aria-hidden />{<div>{children}</div>}</div>;
}

/* ───────────────────────── ordenação de tabelas ───────────────────────── */

type Dir = 'asc' | 'desc';
export function useSort<T>(rows: T[] | null | undefined, accessors: Record<string, (r: T) => string | number | null | undefined>, initial?: { key: string; dir: Dir }) {
  const [sort, setSort] = useState<{ key: string; dir: Dir } | null>(initial ?? null);
  const sorted = useMemo(() => {
    if (!rows) return rows ?? null;
    if (!sort) return rows;
    const get = accessors[sort.key];
    if (!get) return rows;
    const mult = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const [x, y] = [get(a), get(b)];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'pt-BR', { numeric: true, sensitivity: 'base' })) * mult;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort]);
  const toggle = (key: string) => setSort((s) => (s?.key === key ? (s.dir === 'asc' ? { key, dir: 'desc' } : null) : { key, dir: 'asc' }));
  return { rows: sorted, sort, toggle };
}

export function SortTh({ label, k, sort, toggle, className }: { label: string; k: string; sort: { key: string; dir: Dir } | null; toggle: (k: string) => void; className?: string }) {
  const active = sort?.key === k;
  return (
    <th className={`sortable ${className ?? ''}`} aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button type="button" onClick={() => toggle(k)} style={{ all: 'unset', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 2 }} title={`Ordenar por ${label}`}>
        {label}<span className="sort" aria-hidden>{active ? (sort!.dir === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />) : <ArrowUpDown size={13} />}</span>
      </button>
    </th>
  );
}

/* ───────────────────────── diálogo com conteúdo livre (formulários longos) ───────────────────────── */

/** Janela modal com foco preso, Esc para fechar e rolagem interna. O conteúdo (ex.: <form>) fica por conta de quem chama. */
export function Dialog({ title, description, onClose, children, wide, xl }: { title: string; description?: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; xl?: boolean }) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'Tab' && ref.current) {
        const els = [...ref.current.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href]')].filter((el) => !el.hasAttribute('disabled'));
        if (!els.length) return;
        const [a, b] = [els[0], els[els.length - 1]];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
        else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prevOverflow; prev?.focus(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide || xl ? 'wide' : ''} ${xl ? 'xl' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="modal-head">
          <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'nowrap', alignItems: 'flex-start' }}>
            <div><h2 id={titleId}>{title}</h2>{description && <p className="muted" style={{ margin: '4px 0 0', fontSize: '0.88rem' }}>{description}</p>}</div>
            <button type="button" className="btn ghost icon sm" onClick={onClose} aria-label="Fechar"><X /></button>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
