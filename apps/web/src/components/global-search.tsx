'use client';

import { Search, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

interface Result { id: string; title: string; subtitle?: string | null; href: string }
interface Group { type: string; label: string; items: Result[] }

export function GlobalSearch() {
  const [open, setOpen] = useState(false); const [q, setQ] = useState(''); const [groups, setGroups] = useState<Group[]>([]); const [busy, setBusy] = useState(false); const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen(true); setTimeout(() => input.current?.focus(), 0); } if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    if (q.trim().length < 2) { setGroups([]); return; }
    const timer = setTimeout(() => { setBusy(true); api<{ groups: Group[] }>(`/search?q=${encodeURIComponent(q)}&limit=6`).then((r) => setGroups(r.groups)).catch(() => setGroups([])).finally(() => setBusy(false)); }, 220);
    return () => clearTimeout(timer);
  }, [q]);
  return <>
    <button className="btn ghost search-trigger" onClick={() => { setOpen(true); setTimeout(() => input.current?.focus(), 0); }} title="Busca global (Ctrl+K)"><Search size={17} /><span className="hide-sm">Buscar</span><kbd className="hide-sm">Ctrl K</kbd></button>
    {open && <div className="search-overlay" role="dialog" aria-modal="true" aria-label="Busca global" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="search-panel">
        <div className="search-input"><Search /><input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Produto, cliente, fornecedor, pedido ou lançamento…" aria-label="Termo da busca" /><button className="btn ghost icon" onClick={() => setOpen(false)} aria-label="Fechar"><X /></button></div>
        <div className="search-results">
          {busy && <p className="muted">Buscando…</p>}
          {!busy && q.length >= 2 && groups.length === 0 && <p className="muted">Nenhum resultado acessível para este termo.</p>}
          {groups.map((g) => <section key={g.type}><h3>{g.label}</h3>{g.items.map((r) => <Link key={`${g.type}-${r.id}`} href={r.href} onClick={() => setOpen(false)}><strong>{r.title}</strong>{r.subtitle && <span>{r.subtitle}</span>}</Link>)}</section>)}
        </div>
      </div>
    </div>}
  </>;
}
