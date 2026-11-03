import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { demoCodec,DemoStateError } from '../src/demo-state.mjs';
import { createDemoHandler } from '../src/vercel-demo.mjs';

async function fixture(t){
  const key=randomBytes(32),server=http.createServer((req,res)=>createDemoHandler({key,env:{}})(req,res));
  // A fresh handler on every request models independent serverless workers.
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
  const base='http://127.0.0.1:'+server.address().port;
  function client(){
    let state,csrf='';
    return {get state(){return state;},get csrf(){return csrf;},
      async call(path,body,{company='default',headers={},key=crypto.randomUUID()}={}){
        const response=await fetch(base+'/api/demo-action',{method:'POST',headers:{'Content-Type':'application/json','X-ERP-Demo':'1',Origin:base},body:JSON.stringify({state,path,method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body),headers:{'x-erp-company':company,'x-erp-request':'1','x-csrf-token':csrf,'idempotency-key':key,...headers}})});
        const packet=await response.json();assert.equal(response.status,200,JSON.stringify(packet));state=packet.state;
        const bytes=Buffer.from(packet.body,'base64'),text=bytes.toString('utf8'),type=Object.entries(packet.headers).find(([key])=>key.toLowerCase()==='content-type')?.[1]||'';
        const data=type.includes('json')?JSON.parse(text):null;if(data?.csrf)csrf=data.csrf;
        return {status:packet.status,data,text,bytes,headers:packet.headers};
      },
    };
  }
  return {base,key,client};
}
test('web demo supports a real quote, order, partial fulfilment, stock, accounts, print and binary backup across cold workers',async t=>{
  const {client}=await fixture(t),c=client();
  assert.equal((await c.call('/api/status')).data.ephemeral_demo,true);assert.equal((await c.call('/api/bootstrap')).status,401);assert.equal((await c.call('/api/demo',{})).status,200);
  const initial=(await c.call('/api/bootstrap')).data;assert.equal(initial.products.length,12);assert.equal(initial.settings.company,'展示工作空間');
  const body={sku:'COLD-WORKER',name:'展示商品',price:'105.01',cost:'40'},key=crypto.randomUUID();
  const first=await c.call('/api/products',body,{key}),repeat=await c.call('/api/products',body,{key});assert.equal(first.status,200);assert.deepEqual(first.data,repeat.data);
  assert.equal((await c.call('/api/products',{sku:'BAD',name:'錯誤驗證'},{headers:{'x-csrf-token':'wrong'}})).status,403);
  let doc=(await c.call('/api/documents',{kind:'quote',partner_id:1,warehouse_id:1,lines:[{product_id:1,qty:'3',price:'450'}]})).data;
  for(const action of ['submit','approve']){const r=await c.call('/api/documents/'+doc.id+'/'+action,{});assert.equal(r.status,200,r.text);doc=r.data;}
  doc=(await c.call('/api/documents/'+doc.id+'/convert',{})).data;assert.equal(doc.kind,'order');
  for(const action of ['submit','approve'])doc=(await c.call('/api/documents/'+doc.id+'/'+action,{})).data;
  const fulfilled=await c.call('/api/documents/'+doc.id+'/fulfil',{lines:[{line_id:doc.lines[0].id,qty:'1'}]});assert.equal(fulfilled.status,200,fulfilled.text);assert.equal(fulfilled.data.document.status,'partial');
  const updated=(await c.call('/api/bootstrap')).data;assert.equal(updated.products.filter(p=>p.sku==='COLD-WORKER').length,1);assert.equal(updated.open_items.length,initial.open_items.length+1);
  const printed=await c.call('/print/'+doc.id+'?size=a5');assert.equal(printed.status,200);assert.match(printed.text,/訂購單/);assert.match(printed.text,/PD-001/);
  const exported=await c.call('/api/export?kind=products');assert.equal(exported.status,200);assert.match(exported.text,/COLD-WORKER/);
  const backup=await c.call('/api/backup');assert.equal(backup.status,200);assert.equal(backup.bytes.subarray(0,15).toString(),'SQLite format 3');
  assert.equal((await c.call('/api/integrity')).data.ok,true);
});
test('separate demo states never share edits or sessions, including newly created company workspaces',async t=>{
  const {client}=await fixture(t),a=client(),b=client();await a.call('/api/demo',{});const rootCsrf=a.csrf;
  await a.call('/api/products',{sku:'ONLY-A',name:'獨立展示資料'});
  assert.equal((await b.call('/api/bootstrap')).status,401);await b.call('/api/demo',{});
  assert.equal((await b.call('/api/bootstrap')).data.products.some(p=>p.sku==='ONLY-A'),false);
  const company=await a.call('/api/companies',{slug:'branch',name:'展示分店',username:'admin',password:'web-demo-branch-test-2026'});assert.equal(company.status,200,company.text);
  assert.equal((await a.call('/api/bootstrap',undefined,{company:'branch'})).status,401);
  await a.call('/api/login',{username:'admin',password:'web-demo-branch-test-2026'},{company:'branch'});
  assert.equal((await a.call('/api/bootstrap',undefined,{company:'branch'})).data.products.length,0);
  assert.equal((await a.call('/api/products',{sku:'FORGED',name:'跨公司驗證'},{company:'branch',headers:{'x-csrf-token':rootCsrf}})).status,403);
  const branch=await a.call('/api/products',{sku:'BRANCH',name:'分店商品'},{company:'branch'});assert.equal(branch.status,200,branch.text);
  assert.equal((await a.call('/api/bootstrap',undefined,{company:'default'})).data.products.some(p=>p.sku==='BRANCH'),false);
  assert.equal((await b.call('/api/status',undefined,{company:'branch'})).status,404);
});
test('demo rejects tampered or redeployed state, cross origins, nested dispatch and requests for the private build key',async t=>{
  const {base,client}=await fixture(t),c=client();await c.call('/api/demo',{});
  const packet={state:c.state.slice(0,40)+(c.state[40]==='A'?'B':'A')+c.state.slice(41),path:'/api/status',method:'GET',headers:{}};
  const invoke=(body,headers={})=>fetch(base+'/api/demo-action',{method:'POST',headers:{'Content-Type':'application/json','X-ERP-Demo':'1',Origin:base,...headers},body:JSON.stringify(body)});
  assert.equal((await invoke(packet)).status,409);
  assert.equal((await invoke({...packet,state:c.state},{Origin:'https://other.example.invalid'})).status,403);
  assert.equal((await invoke({...packet,state:c.state,path:'/api/demo-action'})).status,400);
  assert.equal((await invoke({...packet,state:c.state},{'X-ERP-Demo':''})).status,403);
  assert.equal((await fetch(base+'/demo-private/key.json')).status,404);
  const script=await fetch(base+'/runtime.js');assert.equal(script.status,200);assert.match(await script.text(),/ERP_DEMO_MODE=true/);
  const page=await fetch(base+'/print/1');assert.equal(page.status,200);assert.match(await page.text(),/demo-print.js/);
  const invalid=await fetch(base+'/api/demo-action',{method:'POST',headers:{'Content-Type':'application/json','X-ERP-Demo':'1'},body:'{broken'});assert.equal(invalid.status,400);
});
test('demo state is authenticated, expires and cannot be opened with another deployment key',()=>{
  const key=randomBytes(32),codec=demoCodec(key,{clock:()=>1000}),token=codec.encode({cookies:{},files:{}});
  assert.equal(codec.decode(token).version,1);
  assert.throws(()=>demoCodec(randomBytes(32)).decode(token),DemoStateError);
  assert.throws(()=>demoCodec(key,{clock:()=>1000+9*3600000}).decode(token),DemoStateError);
  assert.throws(()=>codec.decode('not-a-valid-snapshot'),DemoStateError);
});
