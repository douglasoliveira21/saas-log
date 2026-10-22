'use client';

import { Download } from 'lucide-react';
import { useState } from 'react';
import { Alert } from '@/components/ui';

const today = () => new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 8)}01`;

/** Pacote do contador: ZIP com planilhas e XML do período. Não é o arquivo SPED. */
export function AccountantPackage() {
  const [from, setFrom] = useState(monthStart()); const [to, setTo] = useState(today());
  const href = `/api/management/accountant-package?from=${from}&to=${to}`;
  return (
    <section className="card" aria-label="Pacote do contador">
      <div className="card-head"><h2>Pacote do contador</h2></div>
      <p className="muted" style={{ marginTop: 0 }}>Um arquivo ZIP com o que o escritório contábil pede todo mês: notas de saída e de entrada (planilha e XML), lançamentos e baixas financeiras, plano de contas e DRE gerencial.</p>
      <Alert kind="warn">Este pacote <strong>não é o arquivo SPED</strong> (EFD ICMS/IPI, EFD Contribuições ou ECD). Ele reúne os dados e os XML para o contador conferir e gerar o SPED no sistema dele.</Alert>
      <div className="toolbar" style={{ marginTop: 12 }}>
        <div><label htmlFor="ac-f" className="muted" style={{ fontSize: '0.8rem' }}>De</label><input id="ac-f" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label htmlFor="ac-t" className="muted" style={{ fontSize: '0.8rem' }}>Até</label><input id="ac-t" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <a className="btn primary" href={href} download><Download aria-hidden />Baixar pacote (.zip)</a>
      </div>
      <p className="muted" style={{ fontSize: '0.8rem', marginBottom: 0 }}>Notas em rascunho ou com pendências não entram. O XML vai só para notas autorizadas (saída) e importadas (entrada), até 5.000 por pacote.</p>
    </section>
  );
}
