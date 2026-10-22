'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

interface Row { uf: string; model: '55' | '65'; state: string; authorizer: string | null; notes: string[]; pending: string[]; lastVerified: string | null }
interface Data { schemas: { source: string; package: string; files: number }; rows: Row[] }

const LABEL: Record<string, string> = { NAO_ANALISADO: 'Não analisado', DOCUMENTACAO_ANALISADA: 'Documentação analisada', EM_DESENVOLVIMENTO: 'Em desenvolvimento', HOMOLOGACAO_PARCIAL: 'Homologação parcial', HOMOLOGACAO_APROVADA: 'Homologação aprovada', PRODUCAO_HABILITADA: 'Produção habilitada', INDISPONIVEL: 'Indisponível ou suspenso' };
const TONE: Record<string, string> = { NAO_ANALISADO: '', EM_DESENVOLVIMENTO: 'warn', HOMOLOGACAO_APROVADA: 'ok', PRODUCAO_HABILITADA: 'ok' };

/** Matriz nacional: o que foi (e o que NÃO foi) verificado por UF e documento na emissão direta. */
export function CoverageCard() {
  const [d, setD] = useState<Data | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => { api<Data>('/fiscal/sefaz/coverage').then(setD).catch(() => setD(null)); }, []);
  if (!d) return null;
  const ufs = [...new Set(d.rows.map((r) => r.uf))];
  const at = (uf: string, m: string) => d.rows.find((r) => r.uf === uf && r.model === m)!;
  const analyzed = d.rows.filter((r) => r.state !== 'NAO_ANALISADO').length;
  return (
    <section className="card" aria-label="Cobertura nacional da emissão direta">
      <div className="card-head"><h2>Cobertura nacional (emissão direta)</h2><span className="badge">{analyzed} de {d.rows.length} combinações analisadas</span></div>
      <p className="muted" style={{ marginTop: 0 }}>Cada estado só entra depois que os endereços oficiais são verificados e a comunicação é testada em homologação. <strong>Nenhum estado está habilitado para produção.</strong> Pela emissão por provedor (Focus NFe) a cobertura é a do provedor.</p>
      <button className="btn sm" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Ocultar matriz' : 'Ver matriz das 27 UFs'}</button>
      {open && (
        <>
          <div className="table-wrap" style={{ marginTop: 12 }}><table>
            <thead><tr><th>UF</th><th>NF-e (55)</th><th>NFC-e (65)</th><th>Pendências</th></tr></thead>
            <tbody>{ufs.map((uf) => {
              const a = at(uf, '55'); const b = at(uf, '65');
              return <tr key={uf}><td><strong>{uf}</strong></td><td><span className={`badge ${TONE[a.state] ?? ''}`}>{LABEL[a.state]}</span></td><td><span className={`badge ${TONE[b.state] ?? ''}`}>{LABEL[b.state]}</span></td><td className="muted" style={{ fontSize: '0.8rem' }}>{a.pending[0]}</td></tr>;
            })}</tbody>
          </table></div>
          <p className="muted" style={{ fontSize: '0.8rem', marginBottom: 0 }}>Schemas (XSD) em uso: {d.schemas.source}</p>
        </>
      )}
    </section>
  );
}
