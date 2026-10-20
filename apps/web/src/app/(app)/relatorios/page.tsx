'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { PageHeader, Alert } from '@/components/ui';
import { useSession } from '@/lib/session';

interface Report { key: string; title: string; columns: { key: string; label: string }[]; filters: string[]; canExport: boolean }
interface Preview { columns: { key: string; label: string }[]; rows: Record<string, string | number | null>[]; truncated: boolean }
interface Exp { id: string; report: string; format: string; status: string; rowCount: number | null; error: string | null; createdAt: string }

const iso = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

export default function RelatoriosPage() {
  const { can } = useSession();
  const [reports, setReports] = useState<Report[]>([]);
  const [key, setKey] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({ from: iso(-30), to: iso(30) });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [exports, setExports] = useState<Exp[]>([]);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const current = reports.find((r) => r.key === key);
  const canExport = can('reports.export');

  const loadExports = () => { if (canExport) api<Exp[]>('/reports/exports').then(setExports).catch(() => undefined); };
  useEffect(() => { api<Report[]>('/reports').then((r) => { setReports(r); setKey((k) => k || r[0]?.key || ''); }).catch((e) => setError(e.message)); loadExports(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const qs = (extra = '') => new URLSearchParams(Object.entries(filters).filter(([k, v]) => v && current?.filters.includes(k))).toString() + extra;
  useEffect(() => {
    if (!key) return;
    setError('');
    api<Preview>(`/reports/${key}?${qs()}`).then(setPreview).catch((e) => { setPreview(null); setError(e.message); });
  }, [key, filters]); // eslint-disable-line react-hooks/exhaustive-deps

  async function download(path: string, method: 'GET' | 'POST') {
    setError(''); setOk('');
    const res = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: { 'x-dh-csrf': '1' } });
    if (res.status === 202) { const j = await res.json(); setOk(j.message); loadExports(); return; }
    if (!res.ok) { setError((await res.json().catch(() => ({ message: 'Falha na exportação.' }))).message); return; }
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'relatorio';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href);
    loadExports();
  }

  return (
    <>
      <PageHeader title="Relatórios" description={<>Você vê apenas relatórios dos módulos aos quais tem acesso. Exportações ficam registradas na auditoria; planilhas neutralizam fórmulas em textos.</>} />
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">{ok}</Alert>}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
          <div><label htmlFor="r">Relatório</label><select id="r" value={key} onChange={(e) => setKey(e.target.value)}>{reports.map((r) => <option key={r.key} value={r.key}>{r.title}</option>)}</select></div>
          {current?.filters.includes('from') && <div><label htmlFor="f">De</label><input id="f" type="date" value={filters.from ?? ''} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></div>}
          {current?.filters.includes('to') && <div><label htmlFor="t">Até</label><input id="t" type="date" value={filters.to ?? ''} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></div>}
          {canExport && current && <><button className="btn" onClick={() => download(`/reports/${key}/export?format=csv&${qs()}`, 'POST')}>Exportar CSV</button><button className="btn" onClick={() => download(`/reports/${key}/export?format=xlsx&${qs()}`, 'POST')}>Exportar Excel</button></>}
        </div>
      </div>
      {preview && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="table-wrap"><table>
            <thead><tr>{preview.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
            <tbody>
              {preview.rows.length === 0 && <tr><td colSpan={preview.columns.length} className="muted">Sem dados no período.</td></tr>}
              {preview.rows.map((r, i) => <tr key={i}>{preview.columns.map((c) => <td key={c.key}>{r[c.key] ?? ''}</td>)}</tr>)}
            </tbody>
          </table></div>
          {preview.truncated && <p className="muted">Prévia limitada a 200 linhas; a exportação contém tudo (acima de 5.000 linhas é gerada em segundo plano).</p>}
        </div>
      )}
      {canExport && exports.length > 0 && (
        <div className="card">
          <h2>Minhas exportações <button className="btn sm" onClick={loadExports}>Atualizar</button></h2>
          <div className="table-wrap"><table>
            <thead><tr><th>Relatório</th><th>Formato</th><th>Situação</th><th>Linhas</th><th /></tr></thead>
            <tbody>{exports.map((e) => <tr key={e.id}><td>{e.report}</td><td>{e.format.toUpperCase()}</td><td><span className={`badge ${e.status === 'READY' ? 'ok' : e.status === 'FAILED' ? 'warn' : ''}`}>{e.status === 'READY' ? 'Pronta' : e.status === 'FAILED' ? (e.error ?? 'Falhou') : 'Em preparo'}</span></td><td>{e.rowCount ?? '—'}</td><td>{e.status === 'READY' && <button className="btn sm" onClick={() => download(`/reports/exports/${e.id}/download`, 'GET')}>Baixar</button>}</td></tr>)}</tbody>
          </table></div>
        </div>
      )}
    </>
  );
}
