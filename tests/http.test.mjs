import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync,writeFileSync,unlinkSync,rmdirSync,existsSync,readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve,join } from 'node:path';
import { ERP,today } from '../src/core.mjs';
import { serverEnv } from './support/server-env.mjs';

test('HTTP end-to-end: security, idempotency, permissions, quotation, stock, cash and backup restore',async t=>{
 const portServer=createServer();portServer.listen(0,'127.0.0.1');await once(portServer,'listening');const port=portServer.address().port;await new Promise(r=>portServer.close(r));
 const tmp=mkdtempSync(join(tmpdir(),'cheng-erp-test-')),dbfile=join(tmp,'company.sqlite');
 const child=spawn(process.execPath,['src/server.mjs'],{cwd:resolve(import.meta.dirname,'..'),env:serverEnv({ERP_HOST:'127.0.0.1',ERP_DB:dbfile,PORT:String(port)}),stdio:['ignore','pipe','pipe'],windowsHide:true});let stderr='',stdout='',lastConnectionError='';child.stderr.on('data',b=>stderr+=b.toString());child.stdout.on('data',b=>stdout+=b.toString());
 t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'exit');}for(const name of ['company.sqlite','company.sqlite-wal','company.sqlite-shm','restored.sqlite','restored.sqlite-wal','restored.sqlite-shm']){const p=join(tmp,name);if(existsSync(p))unlinkSync(p);}const backups=join(tmp,'backups');if(existsSync(backups)){for(const file of readdirSync(backups))if(/^before-rebuild-\d+-[a-f0-9]+\.sqlite$/.test(file))unlinkSync(join(backups,file));rmdirSync(backups);}rmdirSync(tmp);});
 const base='http://127.0.0.1:'+port;
 let ready=false;for(let i=0;i<200;i++){if(child.exitCode!==null||child.signalCode!==null)throw Error('server failed: '+stderr);try{if((await fetch(base+'/api/status')).ok){ready=true;break;}}catch(e){lastConnectionError=String(e.cause||e);}await new Promise(r=>setTimeout(r,100));}assert.ok(ready,'server starts: '+stdout+' '+stderr+' '+lastConnectionError);
 async function call(path,b,session,extra={}){const headers=b===undefined?{}:{'Content-Type':'application/json','X-ERP-Request':'1','X-CSRF-Token':session?.csrf||'','Idempotency-Key':extra.key||crypto.randomUUID(),'Origin':base};if(session)headers.Cookie=session.cookie;Object.assign(headers,extra.headers||{});const r=await fetch(base+path,{method:b===undefined?'GET':'POST',headers,body:b===undefined?undefined:JSON.stringify(b)});const content=await r.text();return {status:r.status,data:r.headers.get('content-type')?.includes('json')?JSON.parse(content):content,headers:r.headers};}
 let admin;
 await t.test('unauthenticated access, cross origin and missing request headers are blocked',async()=>{
  assert.equal((await call('/api/bootstrap')).status,401);
  assert.equal((await call('/api/setup',null)).status,400);assert.equal((await call('/api/login',[])).status,400);
  const badHost=await new Promise((resolve,reject)=>{const req=httpRequest(base+'/api/status',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(badHost,403);
  assert.equal((await call('/api/setup',{},null,{headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await call('/api/setup',{},null,{headers:{'X-ERP-Request':''}})).status,403);
  const page=await call('/');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal(page.headers.get('access-control-allow-origin'),null);
 });
 await t.test('setup yields a protected session, is one-time, and rejects bad CSRF',async()=>{
  const r=await call('/api/setup',{username:'admin',name:'測試管理員',company:'HTTP 測試公司',password:'test-http-password-2026'});assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);admin={csrf:r.data.csrf,cookie:r.headers.get('set-cookie').split(';')[0]};
  assert.equal((await call('/api/setup',{})).status,409);assert.equal((await call('/api/login',{username:'admin',password:'wrong'})).status,401);
  assert.equal((await call('/api/products',{sku:'P1',name:'商品'},admin,{headers:{'X-CSRF-Token':'wrong'}})).status,403);
 });
 let customer,supplier,product,quote,order,fulfilment,item;
 await t.test('concurrent repeated request writes only one product and mismatched reuse conflicts',async()=>{
  const key=crypto.randomUUID(),body={sku:'P1',name:'<測試商品>',price:'105',cost:'40',safety_qty:'2'};
  const rs=await Promise.all([call('/api/products',body,admin,{key}),call('/api/products',body,admin,{key})]);assert.equal(rs[0].status,200);assert.deepEqual(rs[0].data,rs[1].data);product=rs[0].data;
  assert.equal((await call('/api/products',{...body,price:'1'},admin,{key})).status,409);
  assert.equal((await call('/api/bootstrap',undefined,admin)).data.products.length,1);
 });
 await t.test('sales quotation to approved order, yellow slip and partial delivery form a complete chain',async()=>{
  customer=(await call('/api/partners',{code:'C1',name:'HTTP 測試客戶',kind:'customer',address:'測試地址'},admin)).data;
  supplier=(await call('/api/partners',{code:'V1',name:'HTTP 測試廠商',kind:'supplier'},admin)).data;
  assert.equal((await call('/api/adjustments',{product_id:product.id,warehouse_id:1,qty:'10',unit_cost:'40',reason:'測試備料'},admin)).status,200);
  quote=(await call('/api/documents',{kind:'quote',partner_id:customer.id,warehouse_id:1,date:today(),due_date:today(),valid_until:today(),tax_mode:'inclusive',tax_bp:500,lines:[{product_id:product.id,qty:'3',price:'105'}]},admin)).data;
  assert.equal((await call(`/api/documents/${quote.id}/submit`,{version:quote.version},admin)).status,200);assert.equal((await call(`/api/documents/${quote.id}/approve`,{},admin)).status,200);
  order=(await call(`/api/documents/${quote.id}/convert`,{},admin)).data;assert.equal(order.kind,'order');assert.equal(order.status,'draft');
  const print=await call('/print/'+order.id,undefined,admin);assert.equal(print.status,200);assert.match(print.data,/&lt;測試商品&gt;/);assert.match(print.data,/訂購單/);
  await call(`/api/documents/${order.id}/submit`,{},admin);order=(await call(`/api/documents/${order.id}/approve`,{},admin)).data;
  const r=await call(`/api/documents/${order.id}/fulfil`,{lines:[{line_id:order.lines[0].id,qty:'1'}]},admin);assert.equal(r.status,200);assert.equal(r.data.document.status,'partial');fulfilment=r.data.id;
  item=(await call('/api/bootstrap',undefined,admin)).data.open_items[0];assert.equal(item.amount,10500);
 });
 await t.test('payment retries are idempotent and overpayment is rejected',async()=>{
  const key=crypto.randomUUID(),b={open_item_id:item.id,amount:'50',date:today(),method:'bank'};
  const a=await call('/api/payments',b,admin,{key}),r=await call('/api/payments',b,admin,{key});assert.equal(a.status,200);assert.deepEqual(a.data,r.data);
  const d=(await call('/api/bootstrap',undefined,admin)).data;assert.equal(d.payments.length,1);assert.equal(d.open_items[0].paid,5000);
  assert.equal((await call('/api/payments',{...b,amount:'56'},admin)).status,409);
 });
 await t.test('role and customer ownership enforced by direct API, including cost redaction',async()=>{
  for(const role of ['sales','warehouse'])assert.equal((await call('/api/users',{username:role,name:role,role,password:'test-http-password-2026'},admin)).status,200);
  async function login(name){const r=await call('/api/login',{username:name,password:'test-http-password-2026'});assert.equal(r.status,200);return {csrf:r.data.csrf,cookie:r.headers.get('set-cookie').split(';')[0]};}
  const sales=await login('sales');assert.equal((await call('/api/documents/'+order.id,undefined,sales)).status,403);assert.equal((await call('/api/backup',undefined,sales)).status,403);assert.equal((await call('/api/products',{sku:'HACK',name:'不應建立'},sales)).status,403);
  const po=(await call('/api/documents',{kind:'purchase',partner_id:supplier.id,warehouse_id:1,lines:[{product_id:product.id,qty:'1',price:'40'}]},admin)).data;await call(`/api/documents/${po.id}/submit`,{},admin);await call(`/api/documents/${po.id}/approve`,{},admin);
  const warehouse=await login('warehouse'),received=await call(`/api/documents/${po.id}/fulfil`,{},warehouse);assert.equal(received.status,200);assert.equal('total' in received.data.document,false);assert.equal('header_discount' in received.data.document,false);assert.equal('price' in received.data.document.lines[0],false);
  assert.equal((await call('/print/'+po.id,undefined,warehouse)).status,403);const data=(await call('/api/bootstrap',undefined,sales)).data;assert.equal('cost' in data.products[0],false);assert.equal('value' in data.stocks[0],false);
 });
 await t.test('20 independent sales sessions can concurrently create distinct owned orders',async()=>{
  for(let i=1;i<=20;i++){const r=await call('/api/users',{username:'worker'+i,name:'測試業務'+i,role:'sales',password:'test-http-password-2026'},admin);assert.equal(r.status,200);}
  const sessions=await Promise.all(Array.from({length:20},async(_,i)=>{const r=await call('/api/login',{username:'worker'+(i+1),password:'test-http-password-2026'});assert.equal(r.status,200);return {csrf:r.data.csrf,cookie:r.headers.get('set-cookie').split(';')[0]};}));
  const start=performance.now(),created=await Promise.all(sessions.map((s,i)=>call('/api/documents',{kind:'order',partner_id:customer.id,warehouse_id:1,date:today(),due_date:today(),notes:'20 人並行測試 '+i,lines:[{product_id:product.id,qty:'1',price:'105'}]},s)));
  for(const r of created)assert.equal(r.status,200);assert.equal(new Set(created.map(r=>r.data.no)).size,20);assert.equal(new Set(created.map(r=>r.data.owner_id)).size,20);
  for(let i=0;i<20;i++){const d=(await call('/api/bootstrap',undefined,sessions[i])).data;assert.equal(d.documents.length,1);assert.equal(d.documents[0].owner_id,created[i].data.owner_id);assert.equal('cost' in d.products[0],false);}
  t.diagnostic('20 independent users concurrently created 20 unique orders; write phase '+Math.round(performance.now()-start)+'ms including ownership checks. Functional test only, not a production load SLA.');
 });
 await t.test('v0.2 finance API supports idempotent advances, real bill lifecycle and permission redaction',async()=>{
  const bank=await call('/api/finance/accounts',{code:'BANK01',name:'測試銀行',kind:'bank',opening_balance:'1000'},admin);assert.equal(bank.status,200);
  const key=crypto.randomUUID(),body={kind:'customer_advance',partner_id:customer.id,bank_account_id:bank.data.id,amount:'20'};
  const a=await call('/api/finance/advances',body,admin,{key}),retry=await call('/api/finance/advances',body,admin,{key});assert.equal(a.status,200);assert.deepEqual(a.data,retry.data);
  assert.equal((await call('/api/finance/applications',{fund_id:a.data.id,open_item_id:item.id,amount:'10'},admin)).status,200);
  assert.equal((await call('/api/finance/refunds',{fund_id:a.data.id,bank_account_id:bank.data.id,amount:'10',notes:'退餘額'},admin)).status,200);
  const bill=await call('/api/finance/bills',{kind:'receivable',partner_id:customer.id,bank_account_id:bank.data.id,bill_number:'B0001',amount:'45',due_date:today(),lines:[{open_item_id:item.id,amount:'45'}]},admin);assert.equal(bill.status,200);
  assert.equal((await call('/api/finance/bill-events',{bill_id:bill.data.id,action:'deposit',notes:'託收'},admin)).status,200);
  assert.equal((await call('/api/finance/bill-events',{bill_id:bill.data.id,action:'clear',notes:'銀行確認兌現'},admin)).status,200);
  assert.equal((await call('/api/finance/bill-events',{bill_id:bill.data.id,action:'clear',notes:'重複'},admin)).status,409);
  const login=await call('/api/login',{username:'sales',password:'test-http-password-2026'}),sales={csrf:login.data.csrf,cookie:login.headers.get('set-cookie').split(';')[0]};
  assert.equal((await call('/api/finance/advances',body,sales)).status,403);assert.equal((await call('/api/finance/bill-events',{bill_id:bill.data.id,action:'cancel',notes:'越權'},sales)).status,403);
  const data=(await call('/api/bootstrap',undefined,sales)).data;assert.equal(data.bank_accounts,undefined);assert.equal(data.funds,undefined);assert.ok(data.capability_audit.rows.length>=100);
  const opening=await call('/api/finance/opening-items',{kind:'receivable',partner_id:customer.id,amount:'300',due_date:today(),reference:'歷史未結'},admin);assert.equal(opening.status,200);const csv=await call('/api/export?kind=open_items',undefined,admin);assert.match(csv.data,/opening/);assert.ok(csv.data.includes(opening.data.no));
  assert.equal((await call('/finance-ui.js')).status,200);assert.equal((await call('/api/integrity',undefined,admin)).data.ok,true);
 });
 await t.test('v0.3 services, units, mixed-tax preview, direct trades, picking and authenticated labels operate end to end',async()=>{
  const p=(await call('/api/products',{sku:'V3-GOODS',name:'新版商品',unit:'個',barcode:'V3BASE',price:'100',cost:'40'},admin)).data;
  const svc=(await call('/api/products',{sku:'V3-SERVICE',name:'新版服務',unit:'次',track_stock:false,price:'10',cost:'0'},admin)).data;
  const unit=await call('/api/product-units',{product_id:p.id,name:'箱',ratio:'12',barcode:'V3BOX',price:'1100',cost:'480'},admin);assert.equal(unit.status,200);
  const receipt=await call('/api/direct-trades',{kind:'purchase',partner_id:supplier.id,warehouse_id:1,lines:[{product_id:p.id,unit_id:unit.data.id,qty:'3',price:'480'}]},admin);assert.equal(receipt.status,200);
  const before=(await call('/api/bootstrap',undefined,admin)).data.documents.length,body={kind:'order',partner_id:customer.id,warehouse_id:1,header_discount:'10',lines:[{product_id:p.id,unit_id:unit.data.id,qty:'1',price:'1100',tax_mode:'inclusive'},{product_id:svc.id,qty:'1',price:'10',tax_mode:'none'}]};
  const preview=await call('/api/document-preview',body,admin);assert.equal(preview.status,200);assert.equal((await call('/api/bootstrap',undefined,admin)).data.documents.length,before);
  const d=(await call('/api/documents',body,admin)).data;assert.equal(d.total,preview.data.total);assert.equal((await call(`/api/documents/${d.id}/submit`,{},admin)).status,200);assert.equal((await call(`/api/documents/${d.id}/approve`,{},admin)).status,200);
  const key=crypto.randomUUID(),pick=await call('/api/picks',{warehouse_id:1,document_ids:[d.id]},admin,{key}),retry=await call('/api/picks',{warehouse_id:1,document_ids:[d.id]},admin,{key});assert.equal(pick.status,200);assert.equal(pick.data.id,retry.data.id);
  assert.equal((await call('/api/picks/'+pick.data.id+'/scan',{barcode:'V3BOX'},admin)).status,200);assert.equal((await call('/api/picks/'+pick.data.id+'/post',{},admin)).status,200);
  assert.equal((await call('/api/label-preview',{product_id:p.id,unit_id:unit.data.id,count:2,paper:'a5'},admin)).status,200);
  const labels=await call('/print/labels?product_id='+p.id+'&unit_id='+unit.data.id+'&count=2&paper=a5',undefined,admin);assert.equal(labels.status,200);assert.match(labels.data,/<svg/);assert.match(labels.data,/size:A5/);
  assert.equal((await call('/print/picks/'+pick.data.id,undefined,admin)).status,200);const current=(await call('/api/documents/'+d.id,undefined,admin)).data;assert.equal((await call('/api/documents/'+d.id+'/close',{version:current.version,reason:'服務另案處理'},admin)).status,200);
  const base64='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGvsAAAAASUVORK5CYII=';assert.equal((await call('/api/product-images',{product_id:p.id,base64},admin)).status,200);assert.equal((await call('/api/product-images/'+p.id)).status,401);const image=await fetch(base+'/api/product-images/'+p.id,{headers:{Cookie:admin.cookie}});assert.equal(image.headers.get('content-type'),'image/png');assert.equal((await image.arrayBuffer()).byteLength,Buffer.from(base64,'base64').length);
  const report=await call('/api/reports/trading?from='+today()+'&to='+today()+'&kind=sales&group=product',undefined,admin);assert.equal(report.status,200);assert.ok(report.data.rows.some(r=>r.sku==='V3-GOODS'));assert.equal((await call('/api/integrity',undefined,admin)).data.ok,true);
 });
 await t.test('administrative rebuild creates a durable backup before repairing a corrupted cache',async()=>{
  const corrupt=new ERP(dbfile);try{corrupt.run('UPDATE stocks SET qty=qty+1000 WHERE product_id=? AND warehouse_id=1',product.id);}finally{corrupt.close();}
  const plan=await call('/api/rebuilds/preview?kind=all',undefined,admin);assert.equal(plan.status,200);assert.ok(plan.data.changes.length>0);const key=crypto.randomUUID(),body={kind:'all',token:plan.data.token,reason:'測試環境核對流水修復'};const fixed=await call('/api/rebuilds/commit',body,admin,{key});assert.equal(fixed.status,200);assert.equal(fixed.data.integrity,true);assert.ok(existsSync(join(tmp,'backups',fixed.data.backup)));assert.deepEqual((await call('/api/rebuilds/commit',body,admin,{key})).data,fixed.data);
 });
 await t.test('CSV export neutralizes spreadsheet formulas',async()=>{
  await call('/api/partners',{code:'=FORMULA',name:'@危險字首測試',kind:'customer'},admin);const csv=await call('/api/export?kind=partners',undefined,admin);assert.equal(csv.status,200);assert.match(csv.data,/'=FORMULA/);assert.match(csv.data,/'@危險/);
 });
 await t.test('online backup can be restored and reconciles subsidiary ledgers',async()=>{
  const r=await fetch(base+'/api/backup',{headers:{Cookie:admin.cookie}});assert.equal(r.status,200);const buf=Buffer.from(await r.arrayBuffer());assert.equal(buf.subarray(0,15).toString(),'SQLite format 3');const path=join(tmp,'restored.sqlite');writeFileSync(path,buf);
  const restored=new ERP(path);try{const admin=restored.user(1);assert.equal(restored.integrity(admin).ok,true);assert.ok(restored.bootstrap(admin).documents.length>=3);assert.equal(restored.get('SELECT count(*) n FROM payments').n,1);}finally{restored.close();}
 });
 await t.test('integrity passes after API chain and logout revokes the session',async()=>{
  const r=await call('/api/integrity',undefined,admin);assert.equal(r.status,200);assert.equal(r.data.ok,true);await call('/api/logout',{},admin);assert.equal((await call('/api/bootstrap',undefined,admin)).status,401);
 });
 assert.equal(stderr,'','server emitted no unexpected errors');
});
