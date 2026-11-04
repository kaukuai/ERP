import { readFileSync,mkdirSync,mkdtempSync,unlinkSync,rmdirSync,existsSync } from 'node:fs';
import { resolve,dirname,join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash,randomBytes } from 'node:crypto';
import { backup } from 'node:sqlite';
import { ERP,DomainError,fail,verifyPassword,permit,has,now,integer,txt } from './core.mjs';
import { accessContext } from './access-control.mjs';
import { guardRequest } from './access-routes.mjs';
import { printDocument } from './print.mjs';
import { seedDemo } from './seed.mjs';
import { Finance } from './finance.mjs';
import { Trade } from './trade.mjs';
import { Operations } from './operations.mjs';
import { saveNumbering } from './numbering.mjs';
import { tradingReport } from './reports.mjs';
import { rebuildPreview,rebuildCommit } from './rebuild.mjs';
import { capabilityAudit } from './capabilities.mjs';
import { FulfilmentBatches } from './fulfilment-batches.mjs';
import { MonthlyBilling } from './billing.mjs';
import { CompletionWorkflows } from './completion-workflows.mjs';
import { WorkflowHub } from './workflow-hub.mjs';
import { Companies,companyContext,companyProxy } from './companies.mjs';
import { appVersion,allowedHostnames,requestSite,secretMatches,validateSecret } from './deployment.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function createApplication({dbPath=':memory:',demo=false,port=4320,allowed=allowedHostnames(),secureCookie=false,ephemeralDemo=false,proxySecret=process.env.ERP_PROXY_SECRET,setupKey=process.env.ERP_SETUP_KEY,localInstance}={}){
const defaultErp=new ERP(dbPath),erp=companyProxy(defaultErp),demoUser=demo?seedDemo(defaultErp):null;
const companies=new Companies(defaultErp,dbPath);
const finance=new Finance(erp),trade=new Trade(erp),operations=new Operations(erp);
const fulfilmentBatches=new FulfilmentBatches(erp),monthlyBilling=new MonthlyBilling(erp);
const workflowHub=new WorkflowHub(erp),completion=new CompletionWorkflows(erp);
if(ephemeralDemo&&!defaultErp.get('SELECT id FROM pos_stores LIMIT 1')){
  const cash=finance.saveBank(demoUser,{code:'WEB-DEMO-CASH',name:'展示收銀現金',kind:'cash',opening_balance:'1000'}),bank=finance.saveBank(demoUser,{code:'WEB-DEMO-BANK',name:'展示收款帳戶',kind:'bank'});
  workflowHub.pos.saveStore(demoUser,{code:'DEMO-SHOP',name:'展示門市',warehouse_id:1,customer_id:1,cash_account_id:cash.id,bank_account_id:bank.id,scanner_mode:'keyboard',receipt_width:80,payment_provider:'manual',user_ids:[demoUser.id]});
  workflowHub.pos.member(demoUser,{code:'DEMO-MEMBER',name:'展示會員',partner_id:1});
}
const allowedHosts=allowed;
const sha=s=>createHash('sha256').update(s).digest('hex'),secure=secureCookie;
const currentCompany=()=>companyContext.getStore()||{slug:'default',erp:defaultErp};
const cookieName=()=> 'cheng_session_'+port+'_'+currentCompany().slug;
const attempts=new Map();
const security={
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'same-origin','Cache-Control':'no-store','Permissions-Policy':'camera=(), microphone=(), geolocation=()'
};
// These endpoints return validated form definitions or authorized standalone records.
// Their custom keys (e.g. page.margin) are not transaction cost/privacy fields.
const isFormPayload=path=>/^\/api\/(form-templates|form-entries)(?:\/|$)/.test(path);
function json(res,data,status=200,headers={},formPayload=false){res.writeHead(status,{...security,'Content-Type':'application/json; charset=utf-8',...headers});res.end(JSON.stringify(formPayload?data:erp.access.sanitize(accessContext.getStore()?.policy,data)));}
function session(req){const prefix=cookieName()+'=',token=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(prefix))?.slice(prefix.length);if(!token)return null;const s=erp.get('SELECT s.*,u.username,u.name,u.role,u.active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.active=1',sha(token),Date.now());if(!s)return null;return {user:erp.user(s.user_id),csrf:s.csrf};}
function createSession(res,user){const token=randomBytes(32).toString('hex'),csrf=randomBytes(24).toString('hex');erp.run('DELETE FROM sessions WHERE expires<=?',Date.now());erp.run('INSERT INTO sessions(token,user_id,csrf,expires) VALUES(?,?,?,?)',sha(token),user.id,csrf,Date.now()+8*3600000);json(res,{user,csrf},200, {'Set-Cookie':`${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure?'; Secure':''}`});}
async function body(req){let n=0;const chunks=[];for await(const chunk of req){n+=chunk.length;if(n>2*1024*1024)fail('請求內容不得超過 2MB',413);chunks.push(chunk);}let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{fail('JSON 格式錯誤');}if(value===null||typeof value!=='object'||Array.isArray(value))fail('JSON 請求需為物件');return value;}
function csvCell(value){let s=String(value??'');if(/^[=+\-@\t\r\n]/.test(s)&&typeof value!=='number')s="'"+s;return '"'+s.replaceAll('"','""')+'"';}
function exportCSV(u,kind){const d=erp.bootstrap(u);let rows,columns;
  if(kind==='products'){rows=d.products.map(x=>({...x,price:x.price/100,cost:x.cost===undefined?'':x.cost/100,safety_qty:x.safety_qty/1000}));columns=['sku','name','spec','category','unit','barcode','price',...(d.permissions.cost?['cost']:[]),'safety_qty'];}
  else if(kind==='partners'){rows=d.partners.map(x=>({...x,credit_limit:x.credit_limit/100}));columns=['code','name','kind','contact','phone','email','tax_id','address','payment_days','credit_limit'];}
  else if(kind==='stocks'){rows=d.stocks.map(x=>({...x,qty:x.qty/1000,reserved:x.reserved/1000,available:(x.qty-x.reserved)/1000,value:x.value===undefined?'':x.value/100}));columns=['sku','name','warehouse_name','qty','reserved','available','unit',...(d.permissions.cost?['value']:[])];}
  else if(kind==='documents'){rows=d.documents.map(x=>({...x,net:x.net/100,tax:x.tax/100,total:x.total/100}));columns=['no','kind','status','date','due_date','partner_name','owner_name','net','tax','total'];}
  else if(kind==='open_items'){permit(u,'finance');const opening=erp.all('SELECT o.*,p.name partner_name,o.no source_no FROM opening_items o JOIN partners p ON p.id=o.partner_id');rows=[...d.open_items.map(x=>({...x,origin:'transaction'})),...opening.map(x=>({...x,origin:'opening'}))].map(x=>({...x,amount:x.amount/100,paid:x.paid/100,outstanding:(x.amount-x.paid)/100}));columns=['origin','kind','partner_name','source_no','due_date','amount','paid','outstanding'];}
  else if(kind==='moves'){permit(u,'stock');rows=d.moves.map(x=>({...x,qty:x.qty/1000,value:x.value===undefined?'':x.value/100}));columns=['no','created_at','kind','sku','name','warehouse_name','qty',...(d.permissions.cost?['value']:[]),'reference','notes'];}
  else fail('匯出類型錯誤');return '\uFEFF'+[columns,...rows.map(r=>columns.map(c=>r[c]))].map(r=>r.map(csvCell).join(',')).join('\r\n');
}
async function handle(req,res){
 try{
  let site;try{site=requestSite(req,allowedHosts,proxySecret);}catch(error){fail(error.message,403);}
  const url=new URL(req.url,'http://localhost'),path=url.pathname,method=req.method;
  if(!['GET','POST'].includes(method))fail('方法不支援',405);
  if(method==='POST'){
    if(req.headers['x-erp-request']!=='1')fail('缺少必要請求標頭',403);
    const origin=req.headers.origin;if(origin){let o;try{o=new URL(origin);}catch{fail('來源錯誤',403);}if(o.host!==site.host||!['http:','https:'].includes(o.protocol)||(site.proxied&&o.protocol!==site.protocol+':'))fail('不允許跨來源操作',403);}
    if(!String(req.headers['content-type']||'').startsWith('application/json'))fail('請使用 JSON',415);
  }
  if(method==='GET'&&path==='/runtime.js'){res.writeHead(200,{...security,'Content-Type':'text/javascript; charset=utf-8'});return res.end('window.ERP_DEMO_MODE=false;');}
  if(method==='GET'&&path==='/api/companies')return json(res,companies.list());
  if(method==='GET'&&path==='/healthz')return json(res,{ok:true,version:appVersion,ephemeral_demo:ephemeralDemo,...(localInstance?{local_instance:localInstance}:{})});
  if(method==='GET'&&path==='/api/status')return json(res,{initialized:!!erp.get('SELECT id FROM users LIMIT 1'),setup_key_required:!!setupKey,demo:demo&&currentCompany().slug==='default',company:currentCompany().slug,today:new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei'}).format(new Date()).slice(0,10),version:appVersion,ephemeral_demo:ephemeralDemo});
  if(method==='POST'&&path==='/api/setup'){if(demo&&currentCompany().slug==='default')fail('示範模式不允許初始化');const b=await body(req);if(setupKey&&!secretMatches(b.setup_key,setupKey))fail('初始化密鑰不正確',403);const u=erp.setup(b);return createSession(res,u);}
  if(method==='POST'&&(path==='/api/login'||path==='/api/demo')){
    const b=await body(req);if(path==='/api/demo'){if(!demo||currentCompany().slug!=='default')fail('示範模式未啟用',404);return createSession(res,demoUser);}
    const key=currentCompany().slug+':'+req.socket.remoteAddress+':'+String(b.username||'').slice(0,50);let a=attempts.get(key);if(!a||a.until<Date.now()){a={n:0,until:Date.now()+15*60000};if(attempts.size>10000)attempts.clear();attempts.set(key,a);}if(a.n>=10)fail('登入嘗試過多，請 15 分鐘後再試',429);a.n++;
    if(typeof b.password!=='string'||b.password.length>128)fail('帳號或密碼不正確',401);
    const u=erp.get('SELECT * FROM users WHERE username=? AND active=1',String(b.username||'').slice(0,50));
    const dummy='00000000000000000000000000000000:'+('00'.repeat(64));if(!verifyPassword(b.password,u?.password||dummy)||!u)fail('帳號或密碼不正確',401);attempts.delete(key);erp.log(u,'login','user',u.id);return createSession(res,erp.user(u.id));
  }
  if(method==='GET'&&['/','/index.html','/app.js','/form-model.js','/forms-ui.js','/forms.css','/demo-client.js','/demo-print.js','/completion-ui.js','/access-ui.js','/master-imports-ui.js','/finance-ui.js','/operations-ui.js','/workflows-ui.js','/workflows-extra-ui.js','/workflow-finance-ui.js','/workflow-stock-invoice-ui.js','/workflow-company-ui.js','/workflow-service-pos-ui.js','/style.css','/print.js','/favicon.svg'].includes(path)){
    if(path==='/print.js'){res.writeHead(200,{...security,'Content-Type':'text/javascript; charset=utf-8'});return res.end("document.getElementById('print').addEventListener('click',()=>window.print());");}
    const name=path==='/'?'index.html':path.slice(1),type=name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':'text/html';res.writeHead(200,{...security,'Content-Type':type+'; charset=utf-8'});return res.end(readFileSync(resolve(root,'public',name)));
  }
  const auth=session(req);if(!auth)fail('請先登入',401);const u=auth.user;return await accessContext.run({policy:erp.access.policy(u),reading:method==='GET'},async()=>{
  if(method==='POST'&&req.headers['x-csrf-token']!==auth.csrf)fail('驗證已失效，請重新登入',403);
  if(method==='GET'){
    guardRequest(erp,u,path,method,{},Object.fromEntries(url.searchParams));
    if(path.startsWith('/api/completion/')){const q=Object.fromEntries(url.searchParams);const methods={'stock-detail':()=>completion.stockDetail(u,q.id),'stock-print':()=>completion.stockPrint(u,q.id),history:()=>completion.history(u,q),'stock-history':()=>completion.stockHistory(u,q),matrix:()=>completion.matrix(u,q),aging:()=>completion.historicalAging(u,q)};const fn=methods[path.split('/')[3]];if(!fn)fail('入口不存在',404);const result=fn();if(path.endsWith('/stock-print')){res.writeHead(200,{...security,'Content-Type':'text/html; charset=utf-8'});return res.end(result);}if(q.format==='csv'){const sanitized=erp.access.sanitize(erp.access.policy(u),result),rows=sanitized.cells||sanitized.nodes||sanitized.rows||[],columns=[...new Set(rows.flatMap(r=>Object.keys(r).filter(k=>typeof r[k]!=='object')))],csv='\uFEFF'+[columns,...rows.map(r=>columns.map(k=>r[k]))].map(row=>row.map(csvCell).join(',')).join('\r\n');return json(res,{csv});}return json(res,result);}
    if(path==='/api/access/admin')return json(res,erp.access.administration(u));
    const extra=workflowHub.get(u,path,Object.fromEntries(url.searchParams));if(extra!==undefined)return json(res,extra,200,{},isFormPayload(path));
    if(path==='/print/completion-statement'){const html=completion.statement(u,Object.fromEntries(url.searchParams));res.writeHead(200,{...security,'Content-Type':'text/html; charset=utf-8'});return res.end(html);}
    if(/^\/print\/completion-stock\/\d+$/.test(path)){const html=completion.stockPrint(u,path.split('/')[3]);res.writeHead(200,{...security,'Content-Type':'text/html; charset=utf-8'});return res.end(html);}
    const printed=workflowHub.print(u,path,Object.fromEntries(url.searchParams));if(printed!==undefined){res.writeHead(200,{...security,'Content-Type':'text/html; charset=utf-8'});return res.end(printed);}
    if(path==='/api/company-summary')return json(res,companies.summary(currentCompany(),u));
    if(path==='/api/session')return json(res,auth);
    if(path==='/api/bootstrap'){const d=erp.bootstrap(u);return json(res,{...d,...finance.data(u,d),...operations.data(u),...fulfilmentBatches.data(u),...monthlyBilling.data(u),...workflowHub.data(u),...companies.data(currentCompany(),u),...erp.access.data(u),...completion.data(u),capability_audit:capabilityAudit()});}
    if(/^\/api\/fulfilment-batches\/\d+$/.test(path))return json(res,fulfilmentBatches.get(u,path.split('/').at(-1)));
    if(/^\/api\/monthly-bills\/\d+$/.test(path))return json(res,monthlyBilling.get(u,path.split('/').at(-1)));
    if(path==='/api/monthly-bills/preview')return json(res,monthlyBilling.pending(u,Object.fromEntries(url.searchParams)));
    if(/^\/print\/(fulfilment-batches|monthly-bills)\/\d+$/.test(path)){const html=path.startsWith('/print/fulfilment-batches/')?fulfilmentBatches.print(u,path.split('/').at(-1)):monthlyBilling.print(u,path.split('/').at(-1));res.writeHead(200,{...security,'Content-Type':'text/html; charset=utf-8'});return res.end(html);}
    if(/^\/api\/picks\/\d+$/.test(path))return json(res,operations.pick(u,path.split('/').at(-1)));
    if(/^\/api\/product-images\/\d+$/.test(path)){erp.product(path.split('/').at(-1));const img=erp.get('SELECT * FROM product_images WHERE product_id=?',Number(path.split('/').at(-1)));if(!img)fail('尚未上傳圖片',404);res.writeHead(200,{...security,'Content-Type':img.mime,'Content-Length':img.data.length,'Cache-Control':'private, no-cache'});return res.end(Buffer.from(img.data));}
    if(path==='/print/labels'||/^\/print\/(picks|counts)\/\d+$/.test(path)){const html=path==='/print/labels'?operations.labels(u,Object.fromEntries(url.searchParams)):path.startsWith('/print/picks/')?operations.printPick(u,path.split('/').at(-1)):operations.printCount(u,path.split('/').at(-1),url.searchParams.get('blank')!=='0');res.writeHead(200,{...security,'Content-Type':'text/html; charset=utf-8'});return res.end(html);}
    if(path==='/api/rebuilds/preview')return json(res,rebuildPreview(erp,u,url.searchParams.get('kind')||'all'));
    if(path==='/api/reports/trading')return json(res,tradingReport(erp,u,Object.fromEntries(url.searchParams)));
    if(path==='/api/capabilities')return json(res,capabilityAudit());
    if(path==='/api/sales-price')return json(res,finance.price(u,url.searchParams.get('partner_id'),url.searchParams.get('product_id'),url.searchParams.get('unit_id')));
    if(/^\/api\/documents\/\d+$/.test(path))return json(res,erp.publicDoc(u,path.split('/').at(-1)));
    if(/^\/api\/fulfilments\/\d+$/.test(path))return json(res,erp.fulfilment(u,path.split('/').at(-1)));
    if(/^\/api\/journals\/\d+$/.test(path))return json(res,erp.journalDetail(u,path.split('/').at(-1)));
    if(/^\/api\/inventory-counts\/\d+$/.test(path))return json(res,erp.count(u,path.split('/').at(-1)));
    if(path==='/api/integrity')return json(res,erp.integrity(u));
    if(path==='/api/export'){const csv=exportCSV(u,url.searchParams.get('kind'));res.writeHead(200,{...security,'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="erp-export.csv"'});return res.end(csv);}
    if(/^\/print\/\d+$/.test(path)){const doc=erp.doc(u,path.split('/').at(-1));if(doc.kind==='purchase'&&!has(u,'cost'))fail('沒有檢視採購金額的權限',403);const html=printDocument(doc,erp.settings(),url.searchParams.get('size')==='a5'?'a5':'a4');res.writeHead(200,{...security,'Content-Type':'text/html; charset=utf-8'});return res.end(html);}
    if(path==='/api/backup'){permit(u,'admin');const dir=mkdtempSync(join(tmpdir(),'cheng-erp-backup-')),file=join(dir,'backup.sqlite');let buf;try{erp.log(u,'backup','database',1);await backup(erp.db,file);buf=readFileSync(file);}finally{for(const suffix of ['','-wal','-shm'])if(existsSync(file+suffix))unlinkSync(file+suffix);rmdirSync(dir);}res.writeHead(200,{...security,'Content-Type':'application/vnd.sqlite3','Content-Disposition':'attachment; filename="cheng-erp-backup.sqlite"'});return res.end(buf);}
    fail('找不到此路徑',404);
  }
  const b=await body(req);
  guardRequest(erp,u,path,method,b,Object.fromEntries(url.searchParams));
  if(path==='/api/logout'){erp.run('DELETE FROM sessions WHERE csrf=? AND user_id=?',auth.csrf,u.id);return json(res,{ok:true},200,{'Set-Cookie':`${cookieName()}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`});}
  if(path==='/api/form-preview')return json(res,workflowHub.forms.preview(u,b));
  if(path==='/api/label-preview'){operations.labels(u,b);return json(res,{valid:true});}
  if(path==='/api/document-preview'){permit(u,b.kind==='purchase'?'buy':'sell');const p=trade.preview(b);return json(res,{net:p.net,tax:p.tax,total:p.total,header_discount:p.header,lines:p.rows.map(l=>({amount:l.amount,net:l.net,tax:l.tax,total:l.total,base_qty:l.base_qty,header_discount_amount:l.header_discount_amount}))});}
  const key=String(req.headers['idempotency-key']||'');if(!/^[\w-]{16,100}$/.test(key))fail('缺少有效的冪等請求識別碼');const fingerprint=sha(u.role+'\n'+erp.access.policy(u).revision+'\n'+path+'\n'+JSON.stringify(b));
  let rebuildBackup=null;
  if(path==='/api/rebuilds/commit'){permit(u,'admin');txt(b.reason,1000,true);const prior=erp.get('SELECT * FROM requests WHERE key=? AND user_id=?',key,u.id);if(prior){if(prior.fingerprint!==fingerprint)fail('請求識別碼已用於不同內容',409);return json(res,JSON.parse(prior.response));}const plan=rebuildPreview(erp,u,b.kind);if(!plan.valid||plan.token!==b.token||!plan.changes.length)fail('請先重新預覽有效的重建差異',409);const dir=dbPath===':memory:'?mkdtempSync(join(tmpdir(),'cheng-rebuild-')):resolve(dirname(dbPath),'backups');mkdirSync(dir,{recursive:true});rebuildBackup='before-rebuild-'+Date.now()+'-'+randomBytes(6).toString('hex')+'.sqlite';await backup(erp.db,join(dir,rebuildBackup));erp.log(u,'backup_for_rebuild','database',1,{file:rebuildBackup});}
  const result=erp.tx(()=>{
    erp.access.revision(erp.access.policy(u));
    erp.access.hydrate(u);
    accessContext.getStore().policy=erp.access.policy(u);
    guardRequest(erp,u,path,method,b,Object.fromEntries(url.searchParams));
    const previous=erp.get('SELECT * FROM requests WHERE key=? AND user_id=?',key,u.id);if(previous){if(previous.fingerprint!==fingerprint)fail('請求識別碼已用於不同內容',409);return JSON.parse(previous.response);}
    let r;
    const completionMethods={'invoice-link':'invoiceLink',assign:'assign',standards:'standards','cost-policy':'costPolicy','monthly-cost-preview':'monthlyCostPreview','monthly-cost':'monthlyCost',preferences:'preferences',category:'category','custom-field':'customDefinition','product-attributes':'productAttributes','opening-fund':'openingFund',closing:'closing','closing-preview':'closingPreview','stock-document':'stockDocument','stock-action':'stockAction','replenishment-policy':'policy',replenish:'replenish','count-rebase':'countRebase','count-preview':'countPreview','count-file':'countFile',disassemble:'disassemble','kit-sale':'kitSale','partial-release':'partialRelease',settlement:'settlement','cost-batch':'costBatch'};
    const extra=path.startsWith('/api/completion/')?(completionMethods[path.split('/')[3]]?completion[completionMethods[path.split('/')[3]]](u,b):fail('入口不存在',404)):path==='/api/access/profiles'?erp.access.saveProfile(u,b):path==='/api/access/roles'?erp.access.saveRole(u,b):path==='/api/access/simulate'?erp.access.simulate(u,b):path==='/api/companies'?companies.create(currentCompany(),u,b):path==='/api/company-summary-grants'?companies.grant(currentCompany(),u,b):workflowHub.post(u,path,b);
    if(extra!==undefined)r=extra;
    else if(path==='/api/fulfilment-batches')r=fulfilmentBatches.create(u,b);
    else if(path==='/api/monthly-bills')r=monthlyBilling.close(u,b);
    else if(/^\/api\/monthly-bills\/\d+\/pay$/.test(path))r=monthlyBilling.pay(u,path.split('/')[3],b);
    else if(path==='/api/partners')r=erp.savePartner(u,b);
    else if(path==='/api/products')r=erp.saveProduct(u,b);
    else if(path==='/api/product-units')r=trade.saveUnit(u,b);
    else if(path==='/api/product-images')r=operations.image(u,b);

    else if(path==='/api/direct-trades')r=trade.direct(u,b);
    else if(/^\/api\/documents\/\d+\/close$/.test(path))r=trade.close(u,path.split('/')[3],b);
    else if(path==='/api/cost-adjustments')r=operations.cost(u,b);
    else if(path==='/api/picks')r=operations.createPick(u,b);
    else if(/^\/api\/picks\/\d+\/(scan|post|cancel)$/.test(path)){const id=path.split('/')[3],action=path.split('/')[4];r=action==='scan'?operations.scan(u,id,b):action==='post'?operations.postPick(u,id,b):operations.cancelPick(u,id,b);}
    else if(/^\/api\/inventory-counts\/\d+\/import-(preview|commit)$/.test(path))r=operations.countImport(u,path.split('/')[3],b,path.endsWith('commit'));
    else if(path==='/api/banks')r=operations.saveBank(u,b);
    else if(path==='/api/rebuilds/commit')r=rebuildCommit(erp,u,b,rebuildBackup);
    else if(path==='/api/numbering-rules')r=saveNumbering(erp,u,b);
    else if(path==='/api/checkbooks')r=operations.saveCheckbook(u,b);
    else if(path==='/api/checkbooks/void-number')r=operations.voidNumber(u,b);

    else if(path==='/api/warehouses')r=erp.saveWarehouse(u,b);
    else if(path==='/api/prices')r=erp.savePrice(u,b);
    else if(path==='/api/documents')r=erp.saveDoc(u,b);
    else if(/^\/api\/documents\/\d+\/(submit|approve|reject|cancel|convert|fulfil|purchase)$/.test(path)){const [, , ,id,action]=path.split('/');r=action==='convert'?erp.convertQuote(u,id):action==='fulfil'?erp.fulfil(u,id,b):action==='purchase'?erp.purchaseForOrder(u,id,b):erp.transition(u,id,action,b);}
    else if(path==='/api/inventory-counts')r=erp.createCount(u,b);
    else if(/^\/api\/inventory-counts\/\d+\/(save|post|cancel)$/.test(path)){const id=path.split('/')[3],a=path.split('/')[4];r=a==='save'?erp.saveCount(u,id,b):a==='post'?erp.postCount(u,id,b):erp.cancelCount(u,id,b);}
    else if(path==='/api/payments')r=erp.pay(u,b);
    else if(path==='/api/finance/accounts')r=finance.saveBank(u,b);
    else if(path==='/api/finance/transfers')r=finance.transfer(u,b);
    else if(path==='/api/finance/batch-payments')r=finance.batchPay(u,b);
    else if(path==='/api/finance/payment-reversals')r=finance.reversePayment(u,b);
    else if(path==='/api/finance/advances')r=finance.advance(u,b);
    else if(path==='/api/finance/applications')r=finance.apply(u,b);
    else if(path==='/api/finance/refunds')r=finance.refund(u,b);
    else if(path==='/api/finance/opening-items')r=finance.opening(u,b);
    else if(path==='/api/finance/opening-payments')r=finance.payOpening(u,b);
    else if(path==='/api/finance/bills')r=b.checkbook_id?operations.issueBill(u,b):finance.registerBill(u,b);
    else if(path==='/api/finance/bill-events')r=finance.billAction(u,b);
    else if(path==='/api/finance/expense-categories')r=finance.saveCategory(u,b);
    else if(path==='/api/finance/expenses')r=finance.expense(u,b);
    else if(path==='/api/finance/expense-payments')r=finance.payExpense(u,b);
    else if(path==='/api/finance/allowances')r=finance.allowance(u,b);
    else if(path==='/api/contacts')r=finance.contact(u,b);
    else if(path==='/api/addresses')r=finance.contact(u,b,true);
    else if(path==='/api/departments')r=finance.saveDepartment(u,b);
    else if(path==='/api/employees')r=finance.saveEmployee(u,b);
    else if(path==='/api/adjustments')r=erp.adjust(u,b);
    else if(path==='/api/transfers')r=erp.transfer(u,b);
    else if(path==='/api/boms')r=erp.saveBOM(u,b);
    else if(path==='/api/work-orders')r=erp.createWork(u,b);
    else if(/^\/api\/work-orders\/\d+\/complete$/.test(path))r=erp.completeWork(u,path.split('/')[3]);
    else if(path==='/api/returns')r=erp.returnGoods(u,b);
    else if(path==='/api/loans')r=erp.loan(u,b);
    else if(/^\/api\/loans\/\d+\/return$/.test(path))r=erp.returnLoan(u,path.split('/')[3],b);
    else if(path==='/api/activities')r=erp.activity(u,b);
    else if(path==='/api/journals')r=erp.manualJournal(u,b);
    else if(path==='/api/settings')r=erp.saveSettings(u,b);
    else if(path==='/api/users')r=erp.saveUser(u,b);
    else if(path==='/api/password')r=erp.changePassword(u,b);
    else if(path==='/api/imports/preview')r=erp.importPreview(u,b);
    else if(/^\/api\/imports\/\d+\/commit$/.test(path))r=erp.importCommit(u,path.split('/')[3]);
    else fail('找不到此操作',404);
    if(r?.document?.id)r.document=erp.publicDoc(u,r.document.id);
    if(!isFormPayload(path)&&r?.id&&['quote','order','purchase'].includes(r.kind))r=erp.publicDoc(u,r.id);
    erp.run('INSERT INTO requests(key,user_id,fingerprint,response,created_at) VALUES(?,?,?,?,?)',key,u.id,fingerprint,JSON.stringify(r),now());return r;
  });json(res,result,200,{},isFormPayload(path));
 });
 }catch(e){
  if(res.headersSent){res.destroy();return;}
  const constraint=String(e.message).includes('UNIQUE constraint failed'),foreign=String(e.message).includes('FOREIGN KEY constraint');
  const status=e instanceof DomainError?e.status:constraint?409:foreign?400:500;
  if(status===500)console.error('ERP request failed:',e.stack);
  json(res,{error:e instanceof DomainError?e.message:constraint?'代號、條碼或資料已存在，請檢查後重試':foreign?'關聯資料不存在或已變更':'系統發生錯誤，請查看伺服器紀錄'},status);
 }
}
const handler=(req,res)=>{try{const url=new URL(req.url,'http://localhost'),header=req.headers['x-erp-company'],query=url.searchParams.get('company');if(header&&query&&header!==query)fail('公司帳套選擇不一致',400);const context=companies.resolve(String(header||query||'default'));return companyContext.run(context,()=>handle(req,res));}catch(error){json(res,{error:error instanceof DomainError?error.message:'公司帳套載入失敗'},error instanceof DomainError?error.status:500);}};
return {handler,close(){companies.close();defaultErp.close();}};
}
