'use client';

import { useEffect, useState, type ChangeEvent } from 'react';
import { Alert, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { dateBr } from '@/lib/format';

const TYPES = [
  ['PRODUCTS','Produtos','sku;nome;codigo_de_barras;custo;preco_venda;ncm'],['CUSTOMERS','Clientes','id;nome;cpf_cnpj;email;telefone;cidade;uf'],['SUPPLIERS','Fornecedores','razao_social;cnpj;nome_fantasia;email;telefone'],
  ['STOCK','Saldo de estoque','sku;deposito;quantidade'],['OPEN_TITLES','Contas em aberto','id;tipo;descricao;valor;vencimento;cliente_fornecedor;documento'],['HISTORY','Histórico legado','id;tipo;data;descricao;valor'],
] as const;
interface Result { committed: boolean; total: number; created: number; updated: number; rejected: number; errors: { line: number; message: string }[] }
interface Run { id: string; entity: string; status: string; dryRun: boolean; totalRows: number; created: number; updated: number; rejected: number; createdAt: string }

export default function MigrationPage() {
  const [entity, setEntity] = useState('PRODUCTS'); const [csv, setCsv] = useState(''); const [name, setName] = useState(''); const [result, setResult] = useState<Result>(); const [runs, setRuns] = useState<Run[]>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const load = () => api<Run[]>('/migration/runs').then(setRuns).catch(() => undefined); useEffect(() => { void load(); }, []);
  async function file(e: ChangeEvent<HTMLInputElement>) { const f=e.target.files?.[0]; if (!f) return; setName(f.name); setCsv(await f.text()); }
  async function run(dryRun: boolean) { setBusy(true); setError(''); try { const r=await api<Result>('/migration/import','POST',{entity,csv,fileName:name||undefined,dryRun}); setResult(r); if (!dryRun && r.rejected===0) setCsv(''); load(); } catch(e){ setError((e as Error).message); } finally { setBusy(false); } }
  const sample=TYPES.find((x)=>x[0]===entity)?.[2];
  return <>
    <PageHeader title="Migração de dados" description="Importe dados de outro ERP com duas fases: validar primeiro e confirmar somente quando não houver erros. Cada execução é auditada." />
    <Alert kind="warn">O histórico legado é preservado para consulta e auditoria, sem criar movimentações fiscais ou financeiras retroativas. Saldos de estoque geram um ajuste rastreável.</Alert>
    {error&&<Alert kind="error">{error}</Alert>}
    <div className="card" style={{marginTop:16}}><div className="form-grid"><div><label htmlFor="entity">Conjunto de dados</label><select id="entity" value={entity} onChange={(e)=>{setEntity(e.target.value);setResult(undefined);}}>{TYPES.map((x)=><option key={x[0]} value={x[0]}>{x[1]}</option>)}</select></div><div><label htmlFor="file">Arquivo CSV (até 5.000 linhas)</label><input id="file" type="file" accept=".csv,text/csv" onChange={file}/></div></div>
      <p className="muted">Cabeçalho esperado: <code>{sample}</code>. Separador “;” ou “,”.</p><textarea value={csv} onChange={(e)=>setCsv(e.target.value)} rows={10} placeholder={sample} style={{width:'100%'}} />
      <div className="row" style={{marginTop:12}}><button className={`btn ${busy?'loading':''}`} disabled={busy||!csv} onClick={()=>run(true)}>1. Validar sem gravar</button><button className={`btn primary ${busy?'loading':''}`} disabled={busy||!csv||!result||result.rejected>0} onClick={()=>run(false)}>2. Confirmar importação</button></div>
    </div>
    {result&&<div className="card" style={{marginTop:16}}><h2>{result.committed?'Importação concluída':'Resultado da validação'}</h2><div className="row"><span className="badge">{result.total} linhas</span><span className="badge ok">{result.created} novas</span><span className="badge">{result.updated} atualizadas</span><span className={`badge ${result.rejected?'warn':'ok'}`}>{result.rejected} rejeitadas</span></div>{result.errors.length>0&&<div className="table-wrap"><table><thead><tr><th>Linha</th><th>Problema</th></tr></thead><tbody>{result.errors.map((e,i)=><tr key={i}><td>{e.line}</td><td>{e.message}</td></tr>)}</tbody></table></div>}</div>}
    <div className="card" style={{marginTop:16}}><h2>Execuções recentes</h2><div className="table-wrap"><table><thead><tr><th>Data</th><th>Tipo</th><th>Modo</th><th>Resultado</th></tr></thead><tbody>{runs.map((r)=><tr key={r.id}><td>{dateBr(r.createdAt)}</td><td>{r.entity}</td><td>{r.dryRun?'Validação':'Gravação'}</td><td>{r.created} novas · {r.updated} atualizadas · {r.rejected} rejeitadas</td></tr>)}</tbody></table></div></div>
  </>;
}
