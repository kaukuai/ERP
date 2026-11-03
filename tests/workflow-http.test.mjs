import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { serverEnv } from './support/server-env.mjs';

test('new workflow HTTP routes and multi-company authentication isolation',async t=>{
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const directory=mkdtempSync(join(tmpdir(),'erp-workflow-http-')),base='http://127.0.0.1:'+port;
  const server=spawn(process.execPath,['src/server.mjs','--demo'],{cwd:new URL('..',import.meta.url),env:serverEnv({ERP_HOST:'127.0.0.1',PORT:String(port),ERP_DB:join(directory,'demo.sqlite')}),stdio:['ignore','pipe','pipe']});let errors='';server.stderr.on('data',data=>errors+=data);server.stdout.resume();
  t.after(async()=>{if(server.exitCode===null){server.kill();await once(server,'exit');}rmSync(directory,{recursive:true,force:true});});
  for(let attempt=0;attempt<100;attempt++){if(server.exitCode!==null)throw Error(errors);try{if((await fetch(base+'/api/status')).ok)break;}catch{}await setTimeout(50);}
  async function call(path,body,session,company='default',extra={}){
    const headers={'X-ERP-Company':company,...(body===undefined?{}:{'Content-Type':'application/json','X-ERP-Request':'1','X-CSRF-Token':session?.csrf||'','Idempotency-Key':extra.key||crypto.randomUUID(),Origin:base}),...(session?{Cookie:session.cookie}:{}),...extra.headers};
    const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)}),text=await response.text();
    return {status:response.status,data:response.headers.get('content-type')?.includes('application/json')?JSON.parse(text):text,headers:response.headers};
  }
  async function login(company='default'){
    const result=await call(company==='default'?'/api/demo':'/api/login',company==='default'?{}:{username:'admin',password:'isolated-company-test-2026'},null,company);assert.equal(result.status,200,JSON.stringify(result.data));return {csrf:result.data.csrf,cookie:result.headers.get('set-cookie').split(';')[0]};
  }
  const root=await login();
  await t.test('workflow assets and aggregate bootstrap load without exposing financial data to unauthenticated callers',async()=>{
    assert.equal((await call('/api/bootstrap')).status,401);
    for(const file of ['workflows-ui.js','workflows-extra-ui.js','workflow-finance-ui.js','workflow-stock-invoice-ui.js','workflow-service-pos-ui.js','workflow-company-ui.js'])assert.equal((await call('/'+file)).status,200);
    const result=await call('/api/bootstrap',undefined,root);assert.equal(result.status,200);assert.equal(result.data.company_info.slug,'default');assert.ok(Array.isArray(result.data.pos_stores));assert.ok(Array.isArray(result.data.inventory_lots));
  });
  let combined;
  await t.test('combined posting enforces CSRF, atomically posts both sources and returns a stable idempotent result',async()=>{
    const docs=[];
    for(let index=0;index<2;index++){
      const d=await call('/api/documents',{kind:'order',partner_id:1,warehouse_id:1,lines:[{product_id:1,qty:'1',price:'100'}]},root);assert.equal(d.status,200);
      await call('/api/documents/'+d.data.id+'/submit',{},root);const approved=await call('/api/documents/'+d.data.id+'/approve',{},root);assert.equal(approved.status,200);docs.push(approved.data);
    }
    const b={documents:docs.map(d=>({document_id:d.id,version:d.version}))},key=crypto.randomUUID();
    assert.equal((await call('/api/fulfilment-batches',b,root,'default',{headers:{'X-CSRF-Token':'invalid'}})).status,403);
    const first=await call('/api/fulfilment-batches',b,root,'default',{key}),again=await call('/api/fulfilment-batches',b,root,'default',{key});assert.equal(first.status,200);assert.deepEqual(first.data,again.data);combined=first.data;
    const print=await call('/print/fulfilment-batches/'+combined.id,undefined,root);assert.equal(print.status,200);for(const d of docs)assert.ok(print.data.includes(d.no));
  });
  await t.test('custom report view and print routes execute the saved column design',async()=>{
    const saved=await call('/api/custom-reports',{name:'HTTP 庫存報表',dataset:'stocks',columns:[{key:'sku',label:'品號'},{key:'qty',label:'數量'}],view_roles:['admin'],print_roles:['admin'],paper:'a4',orientation:'portrait'},root);assert.equal(saved.status,200);
    const run=await call('/api/custom-reports/'+saved.data.id,undefined,root);assert.equal(run.status,200);assert.ok(run.data.rows.length>0);
    const print=await call('/print/custom-reports/'+saved.data.id,undefined,root);assert.equal(print.status,200);assert.match(print.data,/HTTP 庫存報表/);
  });
  await t.test('company creation is repeatable with one idempotency key and never grants a shared login',async()=>{
    const key=crypto.randomUUID(),body={slug:'alpha',name:'獨立公司 A',username:'admin',password:'isolated-company-test-2026',warehouse_name:'A 公司主倉'};
    const first=await call('/api/companies',body,root,'default',{key}),again=await call('/api/companies',body,root,'default',{key});assert.equal(first.status,200);assert.deepEqual(first.data,again.data);
    assert.equal((await call('/api/bootstrap',undefined,root,'alpha')).status,401);
    assert.equal((await call('/api/demo',{},null,'alpha')).status,404);
    assert.equal((await call('/api/bootstrap',undefined,root,'unknown-company')).status,404);
  });
  const alpha=await login('alpha');
  await t.test('company session cookies, CSRF, databases and print routes remain isolated under the same server',async()=>{
    assert.notEqual(alpha.cookie.split('=')[0],root.cookie.split('=')[0]);
    const data=await call('/api/bootstrap',undefined,alpha,'alpha');assert.equal(data.status,200);assert.equal(data.data.settings.company,'獨立公司 A');assert.equal(data.data.products.length,0);assert.equal(data.data.documents.length,0);
    assert.equal((await call('/api/partners',{code:'A1',name:'隔離客戶'},alpha,'alpha',{headers:{'X-CSRF-Token':root.csrf}})).status,403);
    assert.equal((await call('/api/partners',{code:'A1',name:'隔離客戶'},alpha,'alpha')).status,200);
    assert.equal((await call('/api/bootstrap',undefined,root)).data.partners.some(p=>p.code==='A1'),false);
    assert.equal((await call('/print/fulfilment-batches/'+combined.id+'?company=alpha',undefined,root,'alpha')).status,401);
    assert.equal((await call('/api/status?company=alpha',undefined,root,'default')).status,400);
    assert.equal((await call('/api/companies',{slug:'nested',name:'禁止子公司建立公司'},alpha,'alpha')).status,403);
  });
  await t.test('only the target company administrator can grant or revoke a root user summary access',async()=>{
    let summary=await call('/api/company-summary',undefined,root);assert.deepEqual(summary.data.rows.map(r=>r.slug),['default']);
    assert.equal((await call('/api/company-summary-grants',{root_username:'demo',enabled:true,include_cost:false},alpha,'alpha')).status,200);
    summary=await call('/api/company-summary',undefined,root);assert.equal(summary.data.rows.length,2);assert.equal(summary.data.rows.find(r=>r.slug==='alpha').inventory_value,undefined);
    assert.equal((await call('/api/company-summary',undefined,alpha,'alpha')).status,403);
    assert.equal((await call('/api/company-summary-grants',{root_username:'demo',enabled:false},alpha,'alpha')).status,200);
    assert.equal((await call('/api/company-summary',undefined,root)).data.rows.length,1);
  });
  assert.equal((await call('/api/integrity',undefined,root)).data.ok,true);
  assert.equal((await call('/api/integrity',undefined,alpha,'alpha')).data.ok,true);
});
