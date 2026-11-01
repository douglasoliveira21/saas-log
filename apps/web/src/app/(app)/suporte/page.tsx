'use client';

import { useEffect, useState } from 'react';
import { Alert, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { dateBr } from '@/lib/format';

interface Session { id: string; requester: string; reason: string; status: string; allow_write: boolean; requested_minutes: number; expires_at: string | null; created_at: string }

export default function SupportPage() {
  const [rows,setRows]=useState<Session[]>([]); const [error,setError]=useState(''); const [ok,setOk]=useState(''); const load=()=>api<Session[]>('/support').then(setRows).catch((e)=>setError(e.message)); useEffect(()=>{void load();},[]);
  async function decide(id:string,approve:boolean,allowWrite=false){setError('');try{await api(`/support/${id}/decision`,'POST',{approve,minutes:30,allowWrite});setOk(approve?'Acesso autorizado por 30 minutos.':'Solicitação recusada.');load();}catch(e){setError((e as Error).message);}}
  async function revoke(id:string){try{await api(`/support/${id}/revoke`,'POST');setOk('Acesso revogado imediatamente.');load();}catch(e){setError((e as Error).message);}}
  return <><PageHeader title="Acesso do suporte" description="O suporte nunca entra na sua empresa sem autorização. Você escolhe leitura ou escrita, o acesso expira e todas as ações ficam na auditoria." />{error&&<Alert kind="error">{error}</Alert>}{ok&&<Alert kind="ok">{ok}</Alert>}
    <Alert kind="warn">Autorize escrita apenas quando uma correção exigir alteração. O modo somente leitura é suficiente para diagnóstico.</Alert>
    <div className="card" style={{marginTop:16}}><h2>Solicitações e sessões</h2><div className="table-wrap"><table><thead><tr><th>Solicitado</th><th>Responsável</th><th>Motivo</th><th>Situação</th><th>Expira</th><th /></tr></thead><tbody>{rows.length===0&&<tr><td colSpan={6} className="muted">Nenhuma solicitação.</td></tr>}{rows.map((s)=><tr key={s.id}><td>{dateBr(s.created_at)}</td><td>{s.requester}</td><td>{s.reason}</td><td><span className={`badge ${s.status==='APPROVED'?'ok':s.status==='REQUESTED'?'warn':''}`}>{s.status}</span>{s.status==='APPROVED'&&<div className="muted">{s.allow_write?'escrita autorizada':'somente leitura'}</div>}</td><td>{dateBr(s.expires_at)}</td><td>{s.status==='REQUESTED'?<div className="row"><button className="btn sm" onClick={()=>decide(s.id,true,false)}>Autorizar leitura</button><button className="btn sm warn" onClick={()=>decide(s.id,true,true)}>Autorizar escrita</button><button className="btn sm" onClick={()=>decide(s.id,false)}>Recusar</button></div>:s.status==='APPROVED'?<button className="btn sm warn" onClick={()=>revoke(s.id)}>Revogar agora</button>:null}</td></tr>)}</tbody></table></div></div>
  </>;
}
