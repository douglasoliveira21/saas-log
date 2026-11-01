import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';

const PASSWORD='Senha#Segura123'; const H={'x-dh-csrf':'1'}; const run=Date.now().toString(36);
describe('Onboarding, migração, busca, suporte temporário e operações',()=>{
  let app:INestApplication; let admin:PrismaClient; type Agent=ReturnType<typeof request.agent>;
  async function tenant(label:string){const a=request.agent(app.getHttpServer());const reg=await a.post('/api/auth/register').set(H).send({companyName:`Co ${label} ${run}`,name:`Dono ${label}`,email:`${label}-${run}@teste.local`,password:PASSWORD}).expect(201);const me=(await a.get('/api/auth/me').expect(200)).body;return{a,tenantId:reg.body.tenantId as string,userId:me.user.id as string};}
  let root:{a:Agent;tenantId:string;userId:string};let client:{a:Agent;tenantId:string;userId:string};
  beforeAll(async()=>{const mod=await Test.createTestingModule({imports:[AppModule]}).compile();app=mod.createNestApplication();configureApp(app);await app.listen(0);admin=new PrismaClient({datasources:{db:{url:process.env.DIRECT_URL}}});root=await tenant('wsroot');client=await tenant('wsclient');await admin.$executeRaw`INSERT INTO platform_admins(user_id) VALUES(${root.userId}::uuid) ON CONFLICT DO NOTHING`;});
  afterAll(async()=>{await admin.$disconnect();await app.close();});

  it('guia o onboarding a partir do estado real',async()=>{const s=(await client.a.get('/api/onboarding').expect(200)).body;expect(s.steps.map((x:any)=>x.key)).toEqual(['company','warehouse','users','certificate','fiscal','migration']);expect(s.completed).toBe(0);await client.a.post('/api/onboarding/complete').set(H).expect(200);expect((await client.a.get('/api/onboarding').expect(200)).body.dismissedAt).toBeTruthy();});

  it('valida e aplica produtos, clientes, fornecedores, estoque, títulos e histórico sem duplicar',async()=>{
    const company=(await client.a.post('/api/companies').set(H).send({legalName:'Cliente LTDA'}).expect(201)).body;
    const est=(await client.a.post('/api/establishments').set(H).send({companyId:company.id,kind:'MATRIZ',name:'Matriz'}).expect(201)).body;
    await client.a.post('/api/warehouses').set(H).send({establishmentId:est.id,code:'CD01',name:'Principal'}).expect(201);
    const imp=(entity:string,csv:string,dryRun:boolean)=>client.a.post('/api/migration/import').set(H).send({entity,csv,dryRun,fileName:`${entity}.csv`});
    const preview=await imp('PRODUCTS','sku;nome;custo;preco_venda\nLEG-1;Produto legado;5,00;10,00',true).expect(200);expect(preview.body).toMatchObject({committed:false,created:1,rejected:0});
    await imp('PRODUCTS','sku;nome;custo;preco_venda\nLEG-1;Produto legado;5,00;10,00',false).expect(200);
    await imp('CUSTOMERS','id;nome;cpf_cnpj\nC1;Cliente legado;52998224725',false).expect(200);
    await imp('SUPPLIERS','razao_social;cnpj\nFornecedor legado;11222333000181',false).expect(200);
    await imp('STOCK','sku;deposito;quantidade\nLEG-1;CD01;25',false).expect(200);
    await imp('OPEN_TITLES','id;tipo;descricao;valor;vencimento\nT1;receber;Saldo inicial;123,45;2027-01-10',false).expect(200);
    await imp('HISTORY','id;tipo;data;descricao;valor\nH1;VENDA;2025-01-10;Venda antiga;99,90',false).expect(200);
    const search=(await client.a.get('/api/search?q=legado').expect(200)).body;expect(search.total).toBeGreaterThanOrEqual(3);
    expect((await client.a.get('/api/migration/runs').expect(200)).body.length).toBeGreaterThanOrEqual(7);
  });

  it('suporte exige aprovação, respeita somente leitura, expira por sessão e aparece na operação',async()=>{
    const req=await root.a.post(`/api/platform/tenants/${client.tenantId}/support`).set(H).send({reason:'Diagnosticar divergência informada pelo cliente',minutes:30}).expect(201);
    const pending=(await client.a.get('/api/support').expect(200)).body.find((x:any)=>x.id===req.body.id);expect(pending.status).toBe('REQUESTED');
    await client.a.post(`/api/support/${req.body.id}/decision`).set(H).send({approve:true,minutes:30,allowWrite:false}).expect(200);
    // Mesmo que o agente também possua membership no tenant, o token de suporte deve
    // continuar limitado pela autorização temporária (nunca herdar escrita da membership).
    const ownerRole=await admin.role.findUniqueOrThrow({where:{tenantId_key:{tenantId:client.tenantId,key:'owner'}}});
    await admin.membership.create({data:{tenantId:client.tenantId,userId:root.userId,roleId:ownerRole.id}});
    await root.a.post(`/api/platform/support/${req.body.id}/enter`).set(H).expect(200);
    const me=(await root.a.get('/api/auth/me').expect(200)).body;expect(me).toMatchObject({tenant:{id:client.tenantId},role:{key:'support'},support:{sessionId:req.body.id,allowWrite:false}});
    await root.a.get('/api/search?q=legado').expect(200);
    await root.a.post('/api/onboarding/complete').set(H).expect(403);
    await root.a.post('/api/platform/support/exit').set(H).expect(200);
    const ops=(await root.a.get('/api/platform/operations').expect(200)).body;expect(ops.tenants.total).toBeGreaterThanOrEqual(2);expect(ops.tenantHealth.length).toBeGreaterThanOrEqual(2);
  });
});
