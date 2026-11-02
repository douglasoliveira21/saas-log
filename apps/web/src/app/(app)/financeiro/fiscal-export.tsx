'use client';

import { Download } from 'lucide-react';
import { useState } from 'react';
import { Alert } from '@/components/ui';

const today = () => new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 8)}01`;

/** Exportação fiscal e financeira em ZIP. Não é um arquivo SPED. */
export function FiscalExport() {
  const [from, setFrom] = useState(monthStart()); const [to, setTo] = useState(today());
  const href = `/api/management/fiscal-export?from=${from}&to=${to}`;
  return (
    <section className="card" aria-label="Exportação fiscal">
      <div className="card-head"><h2>Exportação fiscal</h2></div>
      <p className="muted" style={{ marginTop: 0 }}>Arquivo ZIP com notas de saída e entrada, XML, lançamentos, baixas financeiras, plano de contas e DRE gerencial.</p>
      <Alert kind="warn">Esta exportação <strong>não é um arquivo SPED</strong> (EFD ICMS/IPI, EFD Contribuições ou ECD).</Alert>
      <div className="toolbar" style={{ marginTop: 12 }}>
        <div><label htmlFor="fx-f" className="muted" style={{ fontSize: '0.8rem' }}>De</label><input id="fx-f" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label htmlFor="fx-t" className="muted" style={{ fontSize: '0.8rem' }}>Até</label><input id="fx-t" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <a className="btn primary" href={href} download><Download aria-hidden />Baixar exportação (.zip)</a>
      </div>
      <p className="muted" style={{ fontSize: '0.8rem', marginBottom: 0 }}>Notas em rascunho ou com pendências não entram. O XML vai apenas para notas autorizadas de saída e importadas de entrada, até 5.000 por arquivo.</p>
    </section>
  );
}
