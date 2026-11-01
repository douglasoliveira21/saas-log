// Carga autenticada, somente leitura (a importação usa dryRun). Rode contra ambiente isolado.
// LOAD_BASE_URL=http://localhost:3000 LOAD_EMAIL=... LOAD_PASSWORD=... npm run test:load
const base = (process.env.LOAD_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const email = process.env.LOAD_EMAIL; const password = process.env.LOAD_PASSWORD;
const durationMs = Math.max(5, Number(process.env.LOAD_DURATION_SECONDS ?? 30)) * 1000;
const concurrency = Math.max(1, Math.min(100, Number(process.env.LOAD_CONCURRENCY ?? 10)));
const fiscalDocId = process.env.LOAD_FISCAL_DOC_ID;
if (!email || !password) throw new Error('Defina LOAD_EMAIL e LOAD_PASSWORD de uma conta de teste com permissões administrativas.');

const login = await fetch(`${base}/api/auth/login`, { method:'POST', headers:{'content-type':'application/json','x-dh-csrf':'1'}, body:JSON.stringify({email,password}), redirect:'manual' });
if (!login.ok) throw new Error(`Login falhou (${login.status}): ${await login.text()}`);
const rawCookies = login.headers.getSetCookie?.() ?? [login.headers.get('set-cookie') ?? ''];
const cookie = rawCookies.map((x)=>x.split(';')[0]).filter(Boolean).join('; ');
if (!cookie) throw new Error('Login não devolveu cookies.');

const products = Array.from({length:200},(_,i)=>`LOAD-${i+1};Produto carga ${i+1};${(10+i/100).toFixed(2)};${(20+i/100).toFixed(2)}`).join('\n');
const scenarios = [
  { name:'fechamento financeiro', method:'GET', path:'/api/finance/dre' },
  { name:'estoque', method:'GET', path:'/api/stock/overview' },
  { name:'emissão fiscal (cálculo)', method:'POST', path:'/api/fiscal/engine/calculate', body:{operation:'SALE',originUf:'SP',destUf:'MG',regime:'SIMPLES_NACIONAL',recipientKind:'CONTRIBUINTE',items:[{key:'LOAD-FISCAL',ncm:'22021000',productOrigin:0,value:125.90,freight:10,discount:0}],persist:false} },
  { name:'busca global', method:'GET', path:'/api/search?q=produto&limit=8' },
  { name:'importação dry-run', method:'POST', path:'/api/migration/import', body:{entity:'PRODUCTS',dryRun:true,fileName:'carga.csv',csv:`sku;nome;custo;preco_venda\n${products}`} },
];
if (fiscalDocId) scenarios.push({ name:'emissão fiscal (revalidação)', method:'POST', path:`/api/fiscal/outgoing/${encodeURIComponent(fiscalDocId)}/revalidate` });
const stats = new Map(scenarios.map((s)=>[s.name,{times:[],ok:0,errors:0,status:{}}]));
const end = Date.now()+durationMs;
async function worker(seed){let i=seed;while(Date.now()<end){const s=scenarios[i++%scenarios.length];const started=performance.now();let status=0;try{const r=await fetch(`${base}${s.path}`,{method:s.method,headers:{cookie,'x-dh-csrf':'1',...(s.body?{'content-type':'application/json'}:{})},body:s.body?JSON.stringify(s.body):undefined});status=r.status;await r.arrayBuffer();const st=stats.get(s.name);st.times.push(performance.now()-started);st.status[status]=(st.status[status]??0)+1;r.ok?st.ok++:st.errors++;}catch{const st=stats.get(s.name);st.times.push(performance.now()-started);st.errors++;st.status.network=(st.status.network??0)+1;}}}
await Promise.all(Array.from({length:concurrency},(_,i)=>worker(i)));
const pct=(a,p)=>a.length?a[Math.min(a.length-1,Math.floor(a.length*p))]:0;
let failures=0;console.log(`Carga: ${concurrency} concorrentes por ${durationMs/1000}s em ${base}`);
for(const [name,s] of stats){s.times.sort((a,b)=>a-b);failures+=s.errors;console.log(`${name.padEnd(24)} req=${String(s.times.length).padStart(5)} ok=${String(s.ok).padStart(5)} err=${String(s.errors).padStart(3)} p50=${pct(s.times,.5).toFixed(0)}ms p95=${pct(s.times,.95).toFixed(0)}ms p99=${pct(s.times,.99).toFixed(0)}ms status=${JSON.stringify(s.status)}`);}
if(failures) process.exitCode=1;
