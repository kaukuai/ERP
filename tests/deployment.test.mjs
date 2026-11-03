import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn,spawnSync } from 'node:child_process';
import { mkdtempSync,rmSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGateway } from '../src/vercel-gateway.mjs';
import { allowedHostnames } from '../src/deployment.mjs';
import { serverEnv } from './support/server-env.mjs';

const secret='test-proxy-secret-2026-abcdefghijklmnopqrstuvwxyz',setupKey='test-setup-key-2026-abcdefghijklmnopqrstuvwxyz';
async function listen(handler){const server=http.createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');return server;}
const close=server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
function request(server,path='/',body,extra={}){
  return new Promise((resolve,reject)=>{
    const headers={Host:'app.example.invalid',...(body===undefined?{}:{'Content-Type':'application/json','X-ERP-Request':'1',Origin:'https://app.example.invalid','Idempotency-Key':crypto.randomUUID()}),...extra};
    const req=http.request({hostname:'127.0.0.1',port:typeof server==='number'?server:server.address().port,path,method:body===undefined?'GET':'POST',headers},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const bytes=Buffer.concat(chunks),text=bytes.toString('utf8');resolve({status:res.statusCode,headers:res.headers,bytes,text,data:res.headers['content-type']?.includes('json')?JSON.parse(text):null});});});
    req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
}
test('gateway without a backend shows actionable setup instead of initializing an ephemeral database',async t=>{
  const server=await listen(createGateway({}));t.after(()=>close(server));
  const page=await request(server);assert.equal(page.status,503);assert.match(page.text,/ERP_BACKEND_URL/);assert.match(page.text,/持久/);
  const status=await request(server,'/api/status');assert.equal(status.status,503);assert.equal(status.data.code,'ERP_DEPLOYMENT_NOT_CONFIGURED');assert.equal(status.headers['cache-control'],'no-store');
});
test('managed hosting accepts its exact platform hostname while preserving the configured frontend allowlist',()=>{
  const allowed=allowedHostnames({RENDER:'true',RENDER_EXTERNAL_HOSTNAME:'backend.example.invalid',ERP_ALLOWED_HOSTS:'app.example.invalid'});
  assert.equal(allowed.has('backend.example.invalid'),true);assert.equal(allowed.has('app.example.invalid'),true);assert.equal(allowed.has('other.example.invalid'),false);
  assert.equal(allowedHostnames({RENDER_EXTERNAL_HOSTNAME:'untrusted.example.invalid'}).has('untrusted.example.invalid'),false);
});
test('gateway, persistent backend, secure initialization and separate company sessions work across a backend restart',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'erp-deployment-')),path=join(dir,'root.sqlite');
  const probe=await listen((req,res)=>res.end());const port=probe.address().port;await close(probe);
  let child,stderr='';
  async function stop(){if(child&&child.exitCode===null){child.kill();await once(child,'exit');}}
  t.after(async()=>{await stop();rmSync(dir,{recursive:true,force:true});});
  async function start(){
    const env=serverEnv({PORT:String(port),ERP_HOST:'127.0.0.1',ERP_DB:path,ERP_ALLOWED_HOSTS:'app.example.invalid,preview.example.invalid',ERP_PROXY_SECRET:secret,ERP_SETUP_KEY:setupKey,ERP_REQUIRE_SETUP_KEY:'1',ERP_SECURE_COOKIE:'1'});
    child=spawn(process.execPath,['src/server.mjs'],{cwd:new URL('..',import.meta.url),env,stdio:['ignore','ignore','pipe']});child.stderr.on('data',b=>stderr+=b);
    for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(stderr);try{if((await request(port,'/healthz',undefined,{Host:'localhost'})).status===200)return;}catch{}await new Promise(resolve=>setTimeout(resolve,30));}throw Error('backend failed to start');
  }
  await start();
  const gateway=await listen(createGateway({ERP_BACKEND_URL:'http://127.0.0.1:'+port,ERP_PROXY_SECRET:secret,ERP_ALLOWED_HOSTS:'app.example.invalid',VERCEL_URL:'preview.example.invalid'},{allowLocalHTTP:true}));t.after(()=>close(gateway));
  assert.equal((await request(gateway,'/api/status',undefined,{Host:'preview.example.invalid'})).status,200);
  assert.equal((await request(gateway,'/api/status',undefined,{Host:'evil.example.invalid'})).status,403);
  assert.equal((await request(gateway,'//evil.example.invalid/api/status')).status,400);
  assert.equal((await request(port,'/api/status',undefined,{'X-ERP-Proxy-Token':'forged','X-ERP-Public-Host':'app.example.invalid','X-ERP-Public-Proto':'https'})).status,403);
  assert.equal((await request(port,'/api/status',undefined,{Host:'evil.example.invalid','X-Forwarded-Host':'app.example.invalid'})).status,403);
  const status=await request(gateway,'/api/status');assert.equal(status.data.setup_key_required,true);assert.equal(status.data.initialized,false);
  const setup={company:'雲端測試帳套',username:'admin',password:'cloud-test-password-2026'};
  assert.equal((await request(gateway,'/api/setup',{...setup,setup_key:'wrong'})).status,403);
  assert.equal((await request(gateway,'/api/status')).data.initialized,false);
  const initialized=await request(gateway,'/api/setup',{...setup,setup_key:setupKey});assert.equal(initialized.status,200,initialized.text);
  assert.match(initialized.headers['set-cookie'][0],/; Secure/);const cookie=initialized.headers['set-cookie'][0].split(';')[0],csrf=initialized.data.csrf,auth={Cookie:cookie,'X-CSRF-Token':csrf};
  assert.equal((await request(gateway,'/api/bootstrap')).status,401);
  assert.equal((await request(gateway,'/api/products',{sku:'P',name:'保存商品'}, {...auth,'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await request(gateway,'/api/products',{sku:'P',name:'保存商品'}, {...auth,Origin:'https://evil.example.invalid'})).status,403);
  assert.equal((await request(gateway,'/api/products',{sku:'P',name:'保存商品'}, {...auth,Origin:'http://app.example.invalid'})).status,403);
  const key=crypto.randomUUID(),product={sku:'P',name:'保存商品',price:'105.01'};
  for(let i=0;i<2;i++)assert.equal((await request(gateway,'/api/products',product,{...auth,'Idempotency-Key':key,'X-ERP-Proxy-Token':'forged','X-ERP-Public-Host':'evil.example.invalid'})).status,200);
  assert.equal((await request(gateway,'/api/bootstrap',undefined,auth)).data.products.length,1);
  const company=await request(gateway,'/api/companies',{slug:'branch',name:'獨立分店',username:'admin',password:'branch-cloud-test-2026'},auth);assert.equal(company.status,200,company.text);
  assert.equal((await request(gateway,'/api/bootstrap',undefined,{...auth,'X-ERP-Company':'branch'})).status,401);
  assert.equal((await request(gateway,'/api/status',undefined,{'X-ERP-Company':'absent'})).status,404);
  const branch=await request(gateway,'/api/login',{username:'admin',password:'branch-cloud-test-2026'},{'X-ERP-Company':'branch'});assert.equal(branch.status,200);
  const branchAuth={Cookie:branch.headers['set-cookie'][0].split(';')[0],'X-CSRF-Token':branch.data.csrf,'X-ERP-Company':'branch'};
  assert.equal((await request(gateway,'/api/bootstrap',undefined,branchAuth)).data.products.length,0);
  const backup=await request(gateway,'/api/backup',undefined,auth);assert.equal(backup.status,200);assert.equal(backup.bytes.subarray(0,15).toString(),'SQLite format 3');
  await stop();await start();
  assert.equal((await request(gateway,'/api/status')).data.initialized,true);
  assert.equal((await request(gateway,'/api/bootstrap',undefined,auth)).data.products[0].sku,'P');
  assert.equal((await request(gateway,'/api/bootstrap',undefined,branchAuth)).data.products.length,0);
  assert.equal((await request(gateway,'/api/integrity',undefined,auth)).data.ok,true);
  const bad=await listen(createGateway({ERP_BACKEND_URL:'http://127.0.0.1:'+port,ERP_PROXY_SECRET:secret+'wrong',ERP_ALLOWED_HOSTS:'app.example.invalid'},{allowLocalHTTP:true}));t.after(()=>close(bad));
  const rejected=await request(bad,'/api/status');assert.equal(rejected.status,403);assert.ok(!rejected.text.includes(secret));
});
test('gateway timeout returns a bounded error without exposing internal connection details',async t=>{
  const backend=await listen(()=>{});t.after(()=>close(backend));
  const gateway=await listen(createGateway({ERP_BACKEND_URL:'http://127.0.0.1:'+backend.address().port,ERP_PROXY_SECRET:secret,ERP_ALLOWED_HOSTS:'app.example.invalid'},{allowLocalHTTP:true,timeout:40}));t.after(()=>close(gateway));
  const result=await request(gateway,'/api/status');assert.equal(result.status,502);assert.equal(result.data.code,'ERP_BACKEND_UNAVAILABLE');assert.ok(!result.text.includes(secret));assert.ok(!result.text.includes('127.0.0.1'));
});
test('gateway preserves JSON semantics when platform helpers have already consumed the request stream',async t=>{
  const backend=await listen(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);res.setHeader('Content-Type','application/json');res.end(Buffer.concat(chunks));});t.after(()=>close(backend));
  const handler=createGateway({ERP_BACKEND_URL:'http://127.0.0.1:'+backend.address().port,ERP_PROXY_SECRET:secret,ERP_ALLOWED_HOSTS:'app.example.invalid'},{allowLocalHTTP:true});
  const gateway=await listen(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);req.body=JSON.parse(Buffer.concat(chunks));await handler(req,res);});t.after(()=>close(gateway));
  const body={name:'中文商品',price:'105.01',source:'00123',lines:[{qty:'1.250'}]},result=await request(gateway,'/api/products',body);assert.equal(result.status,200);assert.deepEqual(result.data,body);
});
test('server refuses an unsafe cloud startup before creating a database',t=>{
  const dir=mkdtempSync(join(tmpdir(),'erp-startup-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  for(const extra of [{VERCEL:'1'},{ERP_REQUIRE_SETUP_KEY:'1'}]){
    const path=join(dir,crypto.randomUUID()+'.sqlite'),env=serverEnv({ERP_DB:path,...extra});
    const child=spawnSync(process.execPath,['src/server.mjs'],{cwd:new URL('..',import.meta.url),env,encoding:'utf8'});
    assert.notEqual(child.status,0);assert.equal(existsSync(path),false);assert.match(child.stderr,/api\/index|ERP_SETUP_KEY/);
  }
});
