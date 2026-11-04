import { mkdtempSync,rmSync,readFileSync,readdirSync,existsSync,cpSync,appendFileSync,unlinkSync,writeFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:net';
import http from 'node:http';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const execute=promisify(execFile),folder=resolve(process.argv[2]||'artifacts/local/ERP-local'),scratch=mkdtempSync(join(tmpdir(),'erp-local-package-'));
const home=join(scratch,'user-data'),nodeName=process.platform==='win32'?'node.exe':'node';let active,port,base;
const env={...process.env,ERP_LOCAL_HOME:home,ERP_MODE:'demo',ERP_PROXY_SECRET:'ignored-cloud-setting',VERCEL:'1'};delete env.NODE_TEST_CONTEXT;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function stop(){
  const current=active;active=null;if(!current)return;
  if(current.exitCode===null&&current.signalCode===null){current.kill();await once(current,'exit');}
  for(let i=0;i<100;i++){try{await fetch(base+'/healthz',{signal:AbortSignal.timeout(300)});}catch{return;}await pause(50);}throw Error('停止啟動器後服務仍在執行');
}
async function launch(directory,args=[]){
  active=spawn(join(directory,'runtime',nodeName),[join(directory,'app/scripts/local.mjs'),'--no-browser','--port',String(port),...args],{env,stdio:['ignore','pipe','pipe','ipc']});let output='';active.stdout.on('data',b=>output+=b);active.stderr.on('data',b=>output+=b);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('服務啟動逾時：'+output)),20000);active.once('message',message=>{clearTimeout(timer);assert.equal(message.type,'ready');resolve();});active.once('exit',code=>{clearTimeout(timer);reject(Error('服務提早結束 '+code+'：'+output));});active.once('error',reject);});
}
async function sharedRequest(path,body,headers={}){return new Promise((resolve,reject)=>{const request=http.request(new URL(base+path),{method:body===undefined?'GET':'POST',headers:{Host:'erp.example.test',...(body===undefined?{}:{'Content-Type':'application/json','X-ERP-Request':'1','Idempotency-Key':crypto.randomUUID(),Origin:'https://erp.example.test'}),...headers}},response=>{let text='';response.on('data',b=>text+=b);response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,data:JSON.parse(text)}));});request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body));});}
async function call(path,body,auth={}){
  const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json','X-ERP-Request':'1','Idempotency-Key':crypto.randomUUID(),Origin:base}),...auth},body:body===undefined?undefined:JSON.stringify(body)}),data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return {data,headers:r.headers};
}
try{
  const metadata=JSON.parse(readFileSync(join(folder,'local-package.json'),'utf8'));assert.equal(metadata.platform,process.platform);assert.equal(metadata.arch,process.arch);assert.equal(metadata.contains_business_data,false);
  for(const line of readFileSync(join(folder,'SHA256SUMS.txt'),'utf8').trim().split('\n')){const at=line.indexOf('  '),hash=line.slice(0,at),name=line.slice(at+2);assert.equal(createHash('sha256').update(readFileSync(join(folder,name))).digest('hex'),hash,name);}
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');port=probe.address().port;await new Promise(r=>probe.close(r));base='http://127.0.0.1:'+port;
  await assert.rejects(execute(join(folder,'runtime',nodeName),[join(folder,'app/scripts/local.mjs'),'--site','https://erp.example.test','--no-browser','--port',String(port)],{env}),error=>/本機模式建立公司及管理員/.test(error.stderr));
  await launch(folder);const initial=await call('/api/status');assert.equal(initial.data.demo,false);assert.equal(initial.data.setup_key_required,false);
  const existing=await execute(join(folder,'runtime',nodeName),[join(folder,'app/scripts/local.mjs'),'--no-browser','--port',String(port)],{env});assert.match(existing.stdout,/已在執行/);
  const setup=await call('/api/setup',{company:'本機驗證帳套',username:'admin',password:'local-package-test-2026'}),auth={Cookie:setup.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':setup.data.csrf};
  await call('/api/products',{sku:'PERSIST-001',name:'永久保存商品',price:'105.01'},auth);
  await call('/api/companies',{slug:'branch',name:'本機分店',username:'admin',password:'local-package-branch-2026'},auth);
  const login=await call('/api/login',{username:'admin',password:'local-package-branch-2026'},{'X-ERP-Company':'branch'}),branchAuth={Cookie:login.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':login.data.csrf,'X-ERP-Company':'branch'};await call('/api/products',{sku:'BRANCH-001',name:'分店永久商品'},branchAuth);
  const scheduled=JSON.parse((await execute(join(folder,'runtime',nodeName),[join(folder,'app/scripts/backup-service.mjs'),'--retain','2','--destination',join(scratch,'second-drive')],{env})).stdout);assert.equal(scheduled.verified,true);assert.equal(scheduled.databases,2);assert.equal(scheduled.offsite_copied,true);const restored=JSON.parse((await execute(join(folder,'runtime',nodeName),[join(folder,'app/scripts/backup-service.mjs'),'--verify',scheduled.manifest],{env})).stdout);assert.equal(restored.verified,true);
  await stop();
  const config=JSON.parse(readFileSync(join(home,'company.json')));config.pid=process.pid;writeFileSync(join(home,'company.json'),JSON.stringify(config));
  await execute(join(folder,'runtime',nodeName),[join(folder,'app/scripts/local.mjs'),'--backup','--no-browser','--port',String(port)],{env});
  const backupDir=join(home,'data/backups'),before=readdirSync(backupDir).filter(name=>name.startsWith('local-backup-'));assert.equal(before.length,1);
  const next=join(scratch,'新版本 program');cpSync(folder,next,{recursive:true});appendFileSync(join(next,'app/public/style.css'),'\n/* isolated upgrade verification */\n');
  await launch(next);assert.equal((await call('/api/bootstrap',undefined,auth)).data.products[0].sku,'PERSIST-001');assert.equal((await call('/api/bootstrap',undefined,auth)).data.products[0].price,10501);assert.equal((await call('/api/bootstrap',undefined,branchAuth)).data.products[0].sku,'BRANCH-001');
  assert.equal((await call('/api/integrity',undefined,auth)).data.ok,true);assert.equal((await call('/api/integrity',undefined,branchAuth)).data.ok,true);
  const after=readdirSync(backupDir).filter(name=>name.startsWith('local-backup-'));assert.equal(after.length,2);for(const name of after){const manifest=JSON.parse(readFileSync(join(backupDir,name)));assert.equal(manifest.databases.length,2);assert.ok(manifest.databases.every(d=>d.integrity&&d.existing_rows_preserved&&existsSync(d.backup)));}
  await stop();
  await launch(next,['--site','https://erp.example.test']);
  assert.equal(JSON.parse(readFileSync(join(home,'company.json'))).publicSite,'https://erp.example.test');
  const shared=await sharedRequest('/api/login',{username:'admin',password:'local-package-test-2026'});assert.equal(shared.status,200);assert.match(shared.headers['set-cookie'][0],/; Secure/);
  const sharedCookie=shared.headers['set-cookie'][0].split(';')[0],sharedData=await sharedRequest('/api/bootstrap',undefined,{Cookie:sharedCookie});assert.equal(sharedData.status,200);assert.equal(sharedData.data.products[0].sku,'PERSIST-001');
  assert.equal((await sharedRequest('/api/status',undefined,{Host:'unlisted.example.test'})).status,403);
  const sameShared=await execute(join(next,'runtime',nodeName),[join(next,'app/scripts/local.mjs'),'--no-browser','--port',String(port)],{env});assert.match(sameShared.stdout,/https:\/\/erp.example.test/);
  await stop();await launch(next,['--local-only']);assert.equal(JSON.parse(readFileSync(join(home,'company.json'))).publicSite,'');
  await stop();unlinkSync(join(home,'data/company.sqlite'));
  await assert.rejects(execute(join(next,'runtime',nodeName),[join(next,'app/scripts/local.mjs'),'--no-browser','--port',String(port)],{env}),error=>/不會建立空庫/.test(error.stderr));assert.equal(existsSync(join(home,'data/company.sqlite')),false);
  assert.equal(existsSync(join(folder,'data')),false);assert.equal(existsSync(join(folder,'app/data')),false);
  console.log(JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,checksums:true,persistentRestart:true,newProgramFolder:true,upgradeBackups:true,scheduledOnlineBackup:true,restorationVerified:true,multipleCompanies:true,repeatedStart:true,reusedPidHandled:true,missingDatabaseRejected:true,businessDataPackaged:false,sharedHttpsConfiguration:true,uninitializedSharedRejected:true}));
}finally{await stop().catch(()=>{});rmSync(scratch,{recursive:true,force:true});}
