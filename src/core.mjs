import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { migrateV2 } from './migrations.mjs';
import { migrateV3 } from './migrate-v3.mjs';
import { migrateV4 } from './migrate-v4.mjs';
import { migrateV5 } from './migrate-v5.mjs';
import { migrateV6 } from './migrate-v6.mjs';
import { migrateV7 } from './migrate-v7.mjs';
import { migrateV8 } from './migrate-v8.mjs';
import { migrateV9 } from './migrate-v9.mjs';
import { migrateV10 } from './migrate-v10.mjs';
import { migrateV11 } from './migrate-v11.mjs';
import { migrateV12 } from './migrate-v12.mjs';
import { schemaVersion } from './schema-version.mjs';
import { withInventorySelection,prepareLotMove,commitLotMove } from './inventory-tracking.mjs';
import { recordOpenItem,itemAccount } from './billing.mjs';
import { Trade,baseQuantity } from './trade.mjs';
import { nextNumber } from './numbering.mjs';
import { FUND_ACCOUNTS } from './rules.mjs';

export class DomainError extends Error {
  constructor(message, status=400) { super(message); this.status=status; }
}
export const fail=(message,status=400)=>{ throw new DomainError(message,status); };
export const now=()=>new Date().toISOString();
export const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export const addDays=(date,n)=>new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
export function txt(value,max=500,required=false) {
  if(value!==undefined && value!==null && typeof value!=='string') fail('文字欄位格式錯誤');
  const s=String(value??'').trim(); if(s.length>max || (required&&!s)) fail(`欄位不得為空或超過 ${max} 字`); return s;
}
export function integer(value,min=0,max=1e12) { const n=Number(value); if(!Number.isSafeInteger(n)||n<min||n>max) fail('數值超出範圍'); return n; }
export function scaled(value,places=2,min=0,max=1e12) {
  if(value===null||(!['number','string','undefined'].includes(typeof value)))fail('數字格式錯誤');
  const s=String(value??'0').trim();
  if(!new RegExp(`^-?\\d{1,12}(?:\\.\\d{1,${places}})?$`).test(s)) fail(`數字最多 ${places} 位小數`);
  const negative=s.startsWith('-'), [a,b='']=(negative?s.slice(1):s).split('.');
  const n=Number(BigInt(a)*10n**BigInt(places)+BigInt(b.padEnd(places,'0')))*(negative?-1:1);
  return integer(n,min,max);
}
export function ratio(a,b,c) { const x=BigInt(a)*BigInt(b), d=BigInt(c); const n=Number((x+d/2n)/d); return integer(n); }
export function dateValue(v,fallback=today()) { const s=String(v||fallback); if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s+'T00:00:00Z'))||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s) fail('日期格式錯誤'); return s; }
export function hashPassword(password) { if(typeof password!=='string'||password.length<12||password.length>128) fail('密碼需為 12–128 字'); const salt=randomBytes(16).toString('hex'); return salt+':'+scryptSync(password,salt,64).toString('hex'); }
export function verifyPassword(password,hash) { try {const [salt,h]=hash.split(':'); return timingSafeEqual(scryptSync(String(password),salt,64),Buffer.from(h,'hex'));} catch {return false;} }
const ROLES=['admin','manager','sales','warehouse','finance','viewer'];
const ACCESS={
  masters:['admin','manager'], partners:['admin','manager','sales'], sell:['admin','manager','sales'], buy:['admin','manager'],
  approve:['admin','manager'], stock:['admin','manager','warehouse'], finance:['admin','manager','finance'], admin:['admin'],
  cost:['admin','manager','finance'], all:['admin','manager','sales','warehouse','finance','viewer']
};
export function permit(user,action) { if(!user||!ACCESS[action]?.includes(user.role)) fail('此帳號沒有這項操作權限',403); }
export const has=(u,a)=>Boolean(u&&ACCESS[a]?.includes(u.role));

export class ERP {
  constructor(path=':memory:') {
    if(path!==':memory:') mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);try{
    if(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get()){const version=Number(this.db.prepare("SELECT value FROM settings WHERE key='schema_version'").get()?.value||1);if(!Number.isInteger(version)||version<1||version>schemaVersion)throw Error('資料庫版本比程式新或版本記錄無效，請使用相符版本');}
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    this.db.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
    this.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run('schema_version','1');
    const accounts=[['1000','銀行及現金','asset'],['1100','應收帳款','asset'],['1200','存貨','asset'],['1250','借出存貨','asset'],['1300','進項稅額','asset'],['2000','應付帳款','liability'],['2100','銷項稅額','liability'],['2200','借入存貨義務','liability'],['3000','期初權益','equity'],['4000','銷貨收入','revenue'],['5000','銷貨成本','expense'],['5100','存貨調整損益','expense']];
    for(const a of accounts) this.db.prepare('INSERT OR IGNORE INTO accounts VALUES(?,?,?)').run(...a);
    migrateV2(this.db);migrateV3(this.db);migrateV4(this.db);migrateV5(this.db);migrateV6(this.db);migrateV7(this.db);migrateV8(this.db);migrateV9(this.db);migrateV10(this.db);migrateV11(this.db);migrateV12(this.db);
    }catch(error){this.db.close();throw error;}
  }
  close(){this.db.close();}
  get(sql,...args){return this.db.prepare(sql).get(...args);}
  all(sql,...args){return this.db.prepare(sql).all(...args);}
  run(sql,...args){return this.db.prepare(sql).run(...args);}
  tx(fn){if(this.inTx)return fn();this.db.exec('BEGIN IMMEDIATE');this.inTx=true;try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}finally{this.inTx=false;}}
  log(user,action,entity,id,detail={}){this.run('INSERT INTO audit(actor_id,action,entity,entity_id,detail,created_at) VALUES(?,?,?,?,?,?)',user?.id??null,action,entity,String(id),JSON.stringify(detail),now());}
  settings(){return Object.fromEntries(this.all('SELECT key,value FROM settings').map(x=>[x.key,x.value]));}
  number(prefix){return nextNumber(this,prefix);}
  setup(body){
    if(this.get('SELECT id FROM users LIMIT 1')) fail('已完成初始化',409);
    const hash=hashPassword(body.password),username=txt(body.username,50,true),name=txt(body.name||'系統管理員',80,true),company=txt(body.company||'我的工作空間',100,true);
    if(!/^[\w.@-]{3,50}$/.test(username)) fail('帳號需為 3–50 個英數、點、@ 或連字號');
    return this.tx(()=>{
      if(this.get('SELECT id FROM users LIMIT 1')) fail('已完成初始化',409);
      const r=this.run('INSERT INTO users(username,name,password,role,created_at) VALUES(?,?,?,?,?)',username,name,hash,'admin',now());
      for(const [k,v] of Object.entries({company,phone:'',address:'',tax_id:'',tax_bp:'500',closed_until:'',currency:'TWD'})) this.run('INSERT OR REPLACE INTO settings VALUES(?,?)',k,v);
      this.run('INSERT INTO warehouses(code,name) VALUES(?,?)','WH01','主倉庫');
      const user=this.get('SELECT id,username,name,role,active FROM users WHERE id=?',Number(r.lastInsertRowid));
      this.log(user,'setup','company',1,{company}); return user;
    });
  }
  user(id){return this.get('SELECT id,username,name,role,active FROM users WHERE id=?',id);}
  saveUser(u,b){permit(u,'admin');return this.tx(()=>{
    const id=b.id?integer(b.id,1):0,role=txt(b.role,20,true);if(!ROLES.includes(role))fail('角色錯誤');
    const name=txt(b.name,80,true),active=b.active===false?0:1;
    if(id){const old=this.user(id);if(!old)fail('找不到帳號',404);if(old.role==='admin'&&old.active&&(!active||role!=='admin')&&this.get("SELECT count(*) n FROM users WHERE role='admin' AND active=1").n<=1)fail('至少需要一位啟用的管理員');
      this.run('UPDATE users SET name=?,role=?,active=? WHERE id=?',name,role,active,id);
      if(b.password)this.run('UPDATE users SET password=? WHERE id=?',hashPassword(b.password),id);
      this.run('DELETE FROM sessions WHERE user_id=?',id);
    }else{const username=txt(b.username,50,true);if(!/^[\w.@-]{3,50}$/.test(username))fail('帳號格式錯誤');this.run('INSERT INTO users(username,name,password,role,active,created_at) VALUES(?,?,?,?,?,?)',username,name,hashPassword(b.password),role,active,now());}
    this.log(u,id?'update':'create','user',id||b.username,{name,role,active});return {ok:true};
  });}
  changePassword(u,b){if(!verifyPassword(b.old_password,this.get('SELECT password FROM users WHERE id=?',u.id).password))fail('原密碼不正確',403);return this.tx(()=>{this.run('UPDATE users SET password=? WHERE id=?',hashPassword(b.password),u.id);this.run('DELETE FROM sessions WHERE user_id=?',u.id);this.log(u,'password_changed','user',u.id);return {ok:true};});}
  saveSettings(u,b){permit(u,'admin');return this.tx(()=>{
    const fields={company:txt(b.company,100,true),phone:txt(b.phone,60),address:txt(b.address,300),tax_id:txt(b.tax_id,20),tax_bp:String(integer(b.tax_bp??500,0,10000)),closed_until:b.closed_until?dateValue(b.closed_until):''};
    const old=this.settings().closed_until;if(old && fields.closed_until<old)fail('本版本不允許回退結帳日');
    for(const [k,v] of Object.entries(fields))this.run('INSERT OR REPLACE INTO settings VALUES(?,?)',k,v);
    this.log(u,'update','settings',1,fields);return this.settings();
  });}
  checkPeriod(d=today()){const closed=this.settings().closed_until;if(closed&&d<=closed)fail('此日期已結帳，不能新增過帳資料',409);}
  partner(u,id,kind){const p=this.get('SELECT * FROM partners WHERE id=? AND active=1',integer(id,1));if(!p)fail('找不到啟用的客戶／供應商',404);if(kind&&p.kind!==kind&&p.kind!=='both')fail('往來對象類型錯誤');if(u.role==='sales'&&p.owner_id&&p.owner_id!==u.id)fail('只能存取自己負責的客戶',403);return p;}
  savePartner(u,b){permit(u,'partners');return this.tx(()=>{
    const id=b.id?integer(b.id,1):0,old=id?this.partner(u,id):null;
    const kind=txt(b.kind||'customer',20);if(!['customer','supplier','both'].includes(kind))fail('往來對象類型錯誤');if(u.role==='sales'&&kind!=='customer')fail('業務只能建立客戶',403);
    if(old&&integer(b.version,1)!==old.version)fail('資料已被其他人修改，請重新載入',409);
    const owner=u.role==='sales'?u.id:(b.owner_id?integer(b.owner_id,1):null);if(owner&&!this.get('SELECT id FROM users WHERE id=? AND active=1',owner))fail('負責人不存在');
    const vals=[txt(b.code,40,true),txt(b.name,100,true),kind,txt(b.contact,80),txt(b.phone,60),txt(b.email,100),txt(b.tax_id,20),txt(b.address,300),integer(b.payment_days??30,0,365),scaled(b.credit_limit??'0'),owner,txt(b.notes,2000)];
    if(u.role==='sales'){vals[8]=old?.payment_days??30;vals[9]=old?.credit_limit??0;}
    let rid=id;if(id)this.run('UPDATE partners SET code=?,name=?,kind=?,contact=?,phone=?,email=?,tax_id=?,address=?,payment_days=?,credit_limit=?,owner_id=?,notes=?,version=version+1 WHERE id=?',...vals,id);
    else rid=Number(this.run('INSERT INTO partners(code,name,kind,contact,phone,email,tax_id,address,payment_days,credit_limit,owner_id,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',...vals).lastInsertRowid);
    const mode=u.role==='sales'?(old?.payment_mode||'days'):(b.payment_mode??old?.payment_mode??'days'),policy=u.role==='sales'?(old?.price_policy||'standard'):(b.price_policy??old?.price_policy??'standard'),cutoff=u.role==='sales'?(old?.closing_day||31):integer(b.closing_day??old?.closing_day??31,1,31);
    if(!['days','month_end','cutoff'].includes(mode)||!['standard','retail','wholesale','online','last'].includes(policy))fail('月結條件或價格政策錯誤');
    const billing=u.role==='sales'?(old?.billing_policy||'individual'):(b.billing_policy??old?.billing_policy??'individual');
    if(!['individual','batch'].includes(billing)||(billing==='batch'&&mode==='days'))fail('批次月結請設定月底或指定截止日');
    this.run('UPDATE partners SET payment_mode=?,closing_day=?,price_policy=?,billing_policy=? WHERE id=?',mode,cutoff,policy,billing,rid);
    this.log(u,id?'update':'create','partner',rid,{code:vals[0],name:vals[1]});return this.get('SELECT * FROM partners WHERE id=?',rid);
  });}
  saveWarehouse(u,b){permit(u,'masters');return this.tx(()=>{const id=Number(this.run('INSERT INTO warehouses(code,name) VALUES(?,?)',txt(b.code,40,true),txt(b.name,100,true)).lastInsertRowid);this.log(u,'create','warehouse',id);return {id};});}
  saveProduct(u,b){permit(u,'masters');return this.tx(()=>{
    const id=b.id?integer(b.id,1):0,old=id?this.get('SELECT * FROM products WHERE id=?',id):null;if(id&&!old)fail('產品不存在',404);if(old&&old.version!==integer(b.version,1))fail('資料已更新，請重新載入',409);
    const supplier=b.supplier_id?this.partner(u,b.supplier_id,'supplier').id:null;
    const tracked=b.track_stock===undefined?(old?.track_stock??1):([false,0,'0'].includes(b.track_stock)?0:1);if(old&&(tracked!==old.track_stock||txt(b.unit||'個',20,true)!==old.unit)&&(this.get('SELECT id FROM document_lines WHERE product_id=? LIMIT 1',id)||this.get('SELECT id FROM stock_moves WHERE product_id=? LIMIT 1',id)))fail('商品已有交易紀錄，請另建品號以改變庫存類型或基本單位',409);if(b.barcode&&this.get('SELECT id FROM product_units WHERE barcode=?',txt(b.barcode,80)))fail('條碼已被換算單位使用',409);
    const v=[txt(b.sku,60,true),txt(b.name,150,true),txt(b.spec,300),txt(b.category,80),txt(b.unit||'個',20,true),txt(b.barcode,80),scaled(b.price),scaled(b.cost),scaled(b.safety_qty??'0',3),supplier];
    let rid=id;if(id)this.run('UPDATE products SET sku=?,name=?,spec=?,category=?,unit=?,barcode=?,price=?,cost=?,safety_qty=?,supplier_id=?,version=version+1 WHERE id=?',...v,id);else rid=Number(this.run('INSERT INTO products(sku,name,spec,category,unit,barcode,price,cost,safety_qty,supplier_id) VALUES(?,?,?,?,?,?,?,?,?,?)',...v).lastInsertRowid);
    this.run('UPDATE products SET retail_price=?,wholesale_price=?,online_price=? WHERE id=?',...['retail_price','wholesale_price','online_price'].map(k=>b[k]===undefined?(old?.[k]??v[6]):scaled(b[k])),rid);
    this.run('UPDATE products SET track_stock=?,invoice_name=? WHERE id=?',tracked,txt(b.invoice_name??old?.invoice_name??'',150),rid);
    this.log(u,id?'update':'create','product',rid,{sku:v[0]});return this.get('SELECT * FROM products WHERE id=?',rid);
  });}
  savePrice(u,b){permit(u,'masters');return this.tx(()=>{this.partner(u,b.partner_id,'customer');this.product(b.product_id);this.run('INSERT INTO prices(partner_id,product_id,price) VALUES(?,?,?) ON CONFLICT(partner_id,product_id) DO UPDATE SET price=excluded.price',integer(b.partner_id,1),integer(b.product_id,1),scaled(b.price));this.log(u,'set_price','price',b.product_id,{partner_id:b.partner_id});return {ok:true};});}
  product(id){const p=this.get('SELECT * FROM products WHERE id=? AND active=1',integer(id,1));if(!p)fail('產品不存在',404);return p;}
  warehouse(id){const w=this.get('SELECT * FROM warehouses WHERE id=? AND active=1',integer(id,1));if(!w)fail('倉庫不存在',404);return w;}
  stock(p,w){this.run('INSERT OR IGNORE INTO stocks(product_id,warehouse_id) VALUES(?,?)',p,w);return this.get('SELECT * FROM stocks WHERE product_id=? AND warehouse_id=?',p,w);}
  stockMove(u,p,w,q,value,kind,ref,notes='',lotOptions){
    this.checkPeriod();if(!this.product(p).track_stock)fail('非庫存商品不能執行庫存作業');const s=this.stock(p,w);if(s.qty+q<0||s.qty+q<s.reserved)fail('庫存不足或已被其他訂單預留',409);if(s.value+value<0)fail('庫存金額不足',409);integer(s.qty+q);integer(s.value+value);
    const lots=prepareLotMove(this,p,w,q,kind,ref,lotOptions);
    this.run('UPDATE stocks SET qty=qty+?,value=value+? WHERE product_id=? AND warehouse_id=?',q,value,p,w);
    const no=this.number('SM');const move=this.run('INSERT INTO stock_moves(no,product_id,warehouse_id,qty,value,kind,reference,notes,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',no,p,w,q,value,kind,ref,notes,u.id,now());commitLotMove(this,u,Number(move.lastInsertRowid),ref,lots);return no;
  }
  costOut(p,w,q){const s=this.stock(p,w);if(q>s.qty-s.reserved)fail('可用庫存不足',409);return q===s.qty?s.value:ratio(s.value,q,s.qty);}
  journal(u,memo,reference,entries,d=today()){
    this.checkPeriod(d);const lines=entries.filter(x=>x[1]>0||x[2]>0);if(lines.length===0)return null;
    let debit=0,credit=0;for(const l of lines){integer(l[1]);integer(l[2]);debit+=l[1];credit+=l[2];}if(debit!==credit)fail('分錄借貸不平衡',500);
    const id=Number(this.run('INSERT INTO journals(no,date,memo,reference,created_by,created_at) VALUES(?,?,?,?,?,?)',this.number('JV'),d,memo,reference,u.id,now()).lastInsertRowid);
    for(const l of lines)this.run('INSERT INTO journal_lines(journal_id,account,debit,credit) VALUES(?,?,?,?)',id,...l);return id;
  }
  doc(u,id){
    const d=this.get('SELECT d.*,p.name partner_name,w.name warehouse_name,us.name owner_name FROM documents d JOIN partners p ON p.id=d.partner_id JOIN warehouses w ON w.id=d.warehouse_id JOIN users us ON us.id=d.owner_id WHERE d.id=?',integer(id,1));
    if(!d)fail('單據不存在',404);if(u.role==='sales'&&(d.owner_id!==u.id||d.kind==='purchase'))fail('只能存取自己的銷售單據',403);
    d.lines=this.all('SELECT * FROM document_lines WHERE document_id=? ORDER BY id',d.id);d.fulfilments=this.all('SELECT * FROM fulfilments WHERE document_id=? ORDER BY id',d.id);
    if(d.kind==='order')for(const l of d.lines)l.procured_qty=this.get("SELECT COALESCE(sum(dl.base_qty-dl.closed_qty*dl.unit_ratio/1000),0) n FROM document_links lk JOIN documents po ON po.id=lk.target_id JOIN document_lines dl ON dl.document_id=po.id WHERE lk.source_id=? AND po.status<>'cancelled' AND dl.product_id=?",d.id,l.product_id).n*1000/l.unit_ratio;
    return d;
  }
  publicDoc(u,id){const d=this.doc(u,id);if(!has(u,'cost')){for(const f of d.fulfilments){delete f.cost;if(f.kind==='receipt')for(const key of ['net','tax','total'])delete f[key];}if(d.kind==='purchase'){for(const key of ['net','tax','total','header_discount'])delete d[key];for(const l of d.lines){for(const key of ['price','amount','net','tax','total','pre_discount_amount','header_discount_amount'])delete l[key];}}}return d;}
  totals(amount,mode,bp){if(mode==='none')return {net:amount,tax:0,total:amount};if(mode==='inclusive'){const net=ratio(amount,10000,10000+bp);return {net,tax:amount-net,total:amount};}const tax=ratio(amount,bp,10000);return {net:amount,tax,total:amount+tax};}
  saveDoc(u,b){return new Trade(this).saveDoc(u,b);}
  transition(u,id,action,b={}){return this.tx(()=>{
    const d=this.doc(u,id);if(b.version!==undefined&&integer(b.version,1)!==d.version)fail('單據已更新，請重新載入',409);
    let status=d.status;
    if(action==='submit'){permit(u,d.kind==='purchase'?'buy':'sell');if(status!=='draft')fail('只有草稿可以送審',409);status='pending';}
    else if(action==='approve'){
      permit(u,'approve');if(status!=='pending')fail('只有待審核單據可以核准',409);
      if(d.kind==='quote'&&d.valid_until<today())fail('報價已過有效期限');
      if(d.kind==='order'){
        const p=this.partner(u,d.partner_id);const exposure=this.get("SELECT COALESCE(sum(amount-paid),0) n FROM open_items WHERE partner_id=? AND kind='receivable'",p.id).n+this.get("SELECT COALESCE(sum(amount-paid),0) n FROM opening_items WHERE partner_id=? AND kind='receivable'",p.id).n+this.get("SELECT COALESCE(sum(amount),0) n FROM bills WHERE partner_id=? AND kind='receivable' AND status IN ('received','deposited')",p.id).n;
        const committed=this.get("SELECT COALESCE(sum(d.total - COALESCE((SELECT sum(f.total) FROM fulfilments f WHERE f.document_id=d.id),0)),0) n FROM documents d WHERE d.partner_id=? AND d.kind='order' AND d.status IN ('approved','partial')",p.id).n;
        if(p.credit_limit&&exposure+committed+d.total>p.credit_limit)fail('此訂單會超過客戶信用額度，請先收款或調整額度',409);
        for(const l of d.lines){if(!l.track_stock)continue;const s=this.stock(l.product_id,d.warehouse_id);if(s.qty-s.reserved<l.base_qty)fail(`${l.name} 可用庫存不足，請先進貨或調撥`,409);this.run('UPDATE stocks SET reserved=reserved+? WHERE product_id=? AND warehouse_id=?',l.base_qty,l.product_id,d.warehouse_id);}
      }status='approved';
    }else if(action==='reject'){permit(u,'approve');if(status!=='pending')fail('狀態不允許退回',409);if(!txt(b.reason,500,true))fail('請填退回原因');status='rejected';}
    else if(action==='cancel'){
      permit(u,'approve');txt(b.reason,500,true);if(['cancelled','completed','partial','converted'].includes(status)||d.lines.some(l=>l.done_qty>0))fail('已有後續交易或已結案，不能取消；請使用退貨流程',409);
      if(d.kind==='order'&&status==='approved')for(const l of d.lines.filter(l=>l.track_stock))this.run('UPDATE stocks SET reserved=reserved-? WHERE product_id=? AND warehouse_id=?',l.base_qty,l.product_id,d.warehouse_id);status='cancelled';
    }else fail('未知單據操作');
    this.run('UPDATE documents SET status=?,version=version+1,updated_at=? WHERE id=?',status,now(),d.id);this.log(u,action,'document',d.id,{from:d.status,to:status,reason:b.reason||''});return this.doc(u,d.id);
  });}
  convertQuote(u,id){return new Trade(this).convert(u,id);}
  purchaseForOrder(u,id,b){return new Trade(this).procure(u,id,b);}
  createCount(u,b){permit(u,'stock');return this.tx(()=>{
    const w=this.warehouse(b.warehouse_id),n=this.get('SELECT count(*) n FROM products WHERE active=1 AND track_stock=1').n;if(!n||n>2000)fail('盤點範圍需有 1–2,000 個啟用商品');
    const snapshot=this.get('SELECT COALESCE(max(id),0) n FROM stock_moves WHERE warehouse_id=?',w.id).n,no=this.number('IC');
    const id=Number(this.run('INSERT INTO inventory_counts(no,warehouse_id,snapshot_move_id,notes,created_by,created_at) VALUES(?,?,?,?,?,?)',no,w.id,snapshot,txt(b.notes,2000),u.id,now()).lastInsertRowid);
    for(const p of this.all('SELECT p.id,COALESCE(s.qty,0) qty FROM products p LEFT JOIN stocks s ON s.product_id=p.id AND s.warehouse_id=? WHERE p.active=1 AND p.track_stock=1',w.id))this.run('INSERT INTO inventory_count_lines(count_id,product_id,expected_qty,actual_qty) VALUES(?,?,?,?)',id,p.id,p.qty,p.qty);
    this.log(u,'create','inventory_count',id,{warehouse_id:w.id,snapshot});return this.count(u,id);
  });}
  count(u,id){if(u.role==='sales')fail('沒有盤點權限',403);const c=this.get('SELECT c.*,w.name warehouse_name FROM inventory_counts c JOIN warehouses w ON w.id=c.warehouse_id WHERE c.id=?',integer(id,1));if(!c)fail('盤點單不存在',404);c.lines=this.all('SELECT l.*,p.sku,p.name,p.unit FROM inventory_count_lines l JOIN products p ON p.id=l.product_id WHERE l.count_id=? ORDER BY p.sku',c.id);return c;}
  saveCount(u,id,b){permit(u,'stock');return this.tx(()=>{
    const c=this.count(u,id);if(c.status!=='draft')fail('只能編輯草稿盤點單',409);if(integer(b.version,1)!==c.version)fail('盤點單已更新，請重新載入',409);if(!Array.isArray(b.lines)||b.lines.length!==c.lines.length)fail('請提供完整的盤點明細');const seen=new Set();
    for(const r of b.lines){const lid=integer(r.line_id,1);if(seen.has(lid)||!c.lines.some(l=>l.id===lid))fail('盤點明細重複或不屬於本單');seen.add(lid);this.run('UPDATE inventory_count_lines SET actual_qty=? WHERE id=?',scaled(r.actual_qty,3),lid);}
    this.run('UPDATE inventory_counts SET notes=?,version=version+1 WHERE id=?',txt(b.notes,2000),c.id);this.log(u,'save','inventory_count',c.id);return this.count(u,c.id);
  });}
  postCount(u,id,b){permit(u,'approve');return this.tx(()=>{
    this.checkPeriod();const c=this.count(u,id);if(c.status!=='draft')fail('盤點單已過帳或取消',409);if(integer(b.version,1)!==c.version)fail('盤點單已更新，請重新載入',409);
    const latest=this.get('SELECT COALESCE(max(id),0) n FROM stock_moves WHERE warehouse_id=?',c.warehouse_id).n;if(latest!==c.snapshot_move_id)fail('此倉庫自建立盤點單後已有庫存異動，請取消並重新建立盤點單',409);
    let positive=0,negative=0;for(const l of c.lines){const q=l.actual_qty-l.expected_qty;if(!q)continue;const p=this.product(l.product_id),s=this.stock(p.id,c.warehouse_id);const cost=q>0?(s.qty?ratio(s.value,q,s.qty):ratio(p.cost,q,1000)):this.costOut(p.id,c.warehouse_id,-q);this.stockMove(u,p.id,c.warehouse_id,q,q>0?cost:-cost,'stock_count',c.no,txt(c.notes,2000),{lots:b.lots});if(q>0)positive+=cost;else negative+=cost;}
    this.journal(u,'庫存盤點差異',c.no,[['1200',positive,0],['5100',0,positive],['5100',negative,0],['1200',0,negative]]);this.run("UPDATE inventory_counts SET status='posted',version=version+1,posted_at=? WHERE id=?",now(),c.id);this.log(u,'post','inventory_count',c.id,{positive,negative});return this.count(u,c.id);
  });}
  cancelCount(u,id,b){permit(u,'approve');return this.tx(()=>{const c=this.count(u,id);if(c.status!=='draft')fail('只能取消草稿盤點單',409);if(integer(b.version,1)!==c.version)fail('盤點單已更新',409);txt(b.reason,500,true);this.run("UPDATE inventory_counts SET status='cancelled',version=version+1 WHERE id=?",c.id);this.log(u,'cancel','inventory_count',c.id,{reason:b.reason});return {ok:true};});}
  replenishment(u){if(u.role==='sales')fail('無權存取採購建議',403);return this.all("SELECT p.id product_id,p.sku,p.name,p.unit,p.safety_qty,p.supplier_id,pa.name supplier_name,COALESCE((SELECT sum(s.qty-s.reserved) FROM stocks s WHERE s.product_id=p.id),0) available_qty,COALESCE((SELECT sum((l.qty-l.done_qty-l.closed_qty)*l.unit_ratio/1000) FROM document_lines l JOIN documents d ON d.id=l.document_id WHERE l.product_id=p.id AND d.kind='purchase' AND d.status IN ('approved','partial')),0) incoming_qty FROM products p LEFT JOIN partners pa ON pa.id=p.supplier_id WHERE p.active=1 AND p.track_stock=1 ORDER BY p.sku").map(r=>({...r,suggested_qty:Math.max(0,r.safety_qty-r.available_qty-r.incoming_qty)})).filter(r=>r.available_qty<r.safety_qty);}
  fulfil(u,id,b){return withInventorySelection(this,{lots:b.lots},()=>new Trade(this).fulfil(u,id,b));}
  fulfilLegacy(u,id,b){permit(u,'stock');return this.tx(()=>{
    this.checkPeriod();const d=this.doc(u,id);if(!['order','purchase'].includes(d.kind)||!['approved','partial'].includes(d.status))fail('請先核准訂單或採購單',409);
    const kind=d.kind==='order'?'shipment':'receipt';const requested=new Map();if(b.lines!==undefined){if(!Array.isArray(b.lines))fail('明細格式錯誤');for(const l of b.lines){const lid=integer(l.line_id,1);if(requested.has(lid))fail('明細重複');requested.set(lid,scaled(l.qty,3));}for(const lid of requested.keys())if(!d.lines.some(l=>l.id===lid))fail('明細不屬於此單據');}
    const rows=[];for(const l of d.lines){const q=b.lines===undefined?l.qty-l.done_qty:(requested.get(l.id)||0);if(q>l.qty-l.done_qty)fail('出入庫數量超過未交量');if(q===0)continue;const amount=ratio(l.amount,l.done_qty+q,l.qty)-ratio(l.amount,l.done_qty,l.qty);rows.push({...l,q,alloc:amount});}if(!rows.length)fail('請輸入本次出入庫數量');
    const prior=this.get('SELECT COALESCE(sum(total),0) total,COALESCE(sum(net),0) net,COALESCE(sum(tax),0) tax FROM fulfilments WHERE document_id=?',d.id);
    const priorBase=d.tax_mode==='inclusive'?prior.total:prior.net,newBase=priorBase+rows.reduce((s,l)=>s+l.alloc,0),cum=this.totals(newBase,d.tax_mode,d.tax_bp);
    const net=cum.net-prior.net,tax=cum.tax-prior.tax,total=cum.total-prior.total,no=this.number(kind==='shipment'?'SH':'RC');let cost=0;
    for(const l of rows){
      if(kind==='shipment'){this.run('UPDATE stocks SET reserved=reserved-? WHERE product_id=? AND warehouse_id=?',l.q,l.product_id,d.warehouse_id);l.moveCost=this.costOut(l.product_id,d.warehouse_id,l.q);this.stockMove(u,l.product_id,d.warehouse_id,-l.q,-l.moveCost,kind,no);}
      else{l.moveCost=d.tax_mode==='inclusive'?ratio(l.alloc,10000,10000+d.tax_bp):l.alloc;}
      cost+=l.moveCost;
    }
    // Reconcile inclusive-tax receipt allocation to the exact document-level net.
    if(kind==='receipt'){let baseSoFar=0,allocated=0;const baseTotal=rows.reduce((s,l)=>s+l.alloc,0);for(const l of rows){baseSoFar+=l.alloc;const target=baseTotal?ratio(net,baseSoFar,baseTotal):0;l.moveCost=target-allocated;allocated=target;this.stockMove(u,l.product_id,d.warehouse_id,l.q,l.moveCost,kind,no);}cost=net;}
    const fid=Number(this.run('INSERT INTO fulfilments(no,document_id,kind,date,net,tax,total,cost,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',no,d.id,kind,today(),net,tax,total,cost,u.id,now()).lastInsertRowid);
    for(const l of rows){this.run('INSERT INTO fulfilment_lines(fulfilment_id,document_line_id,product_id,qty,amount,cost) VALUES(?,?,?,?,?,?)',fid,l.id,l.product_id,l.q,l.alloc,l.moveCost);this.run('UPDATE document_lines SET done_qty=done_qty+? WHERE id=?',l.q,l.id);}
    const p=this.partner(u,d.partner_id),controlAccount=recordOpenItem(this,fid,kind==='shipment'?'receivable':'payable',p,total);
    const entries=kind==='shipment'?[[controlAccount,total,0],['4000',0,net],['2100',0,tax],['5000',cost,0],['1200',0,cost]]:[['1200',net,0],['1300',tax,0],[controlAccount,0,total]];
    this.journal(u,kind==='shipment'?'銷貨出庫與應收':'採購入庫與應付',no,entries);
    const remaining=this.get('SELECT sum(qty-done_qty-closed_qty) n FROM document_lines WHERE document_id=?',d.id).n;this.run('UPDATE documents SET status=?,version=version+1,updated_at=? WHERE id=?',remaining?'partial':'completed',now(),d.id);this.log(u,kind,'document',d.id,{no,total,cost});return {id:fid,no,document:this.doc(u,d.id)};
  });}
  pay(u,b){permit(u,'finance');return this.tx(()=>{
    const item=this.get('SELECT * FROM open_items WHERE id=?',integer(b.open_item_id,1));if(!item)fail('帳款不存在',404);if(item.billing_state==='pending')fail('此交易尚未月結立帳，不能收付款',409);const amount=scaled(b.amount,2,1);if(amount>item.amount-item.paid)fail('沖帳金額超過未結餘額',409);const d=dateValue(b.date);this.checkPeriod(d);const method=txt(b.method||'bank',30,true);if(!['bank','cash','cheque'].includes(method))fail('付款方式錯誤');const no=this.number(item.kind==='receivable'?'AR':'AP');
    if(method==='cheque')fail('支票請從「資金與票據」登錄，並完成託收／兌現流程');
    const bank=b.bank_account_id?this.get('SELECT * FROM bank_accounts WHERE id=? AND active=1',integer(b.bank_account_id,1)):null;if(b.bank_account_id&&!bank)fail('資金帳戶不存在');const account=bank?.gl_code||'1000';if(bank&&bank.kind!==method)fail('付款方式與資金帳戶類型不符');
    if(bank?.kind==='cash'&&item.kind==='payable'&&this.get('SELECT COALESCE(sum(debit-credit),0) n FROM journal_lines WHERE account=?',account).n<amount)fail('現金餘額不足',409);
    this.run('INSERT INTO payments(no,open_item_id,amount,method,date,reference,created_by,created_at,bank_account_id,account_code) VALUES(?,?,?,?,?,?,?,?,?,?)',no,item.id,amount,method,d,txt(b.reference,300),u.id,now(),bank?.id??null,account);this.run('UPDATE open_items SET paid=paid+? WHERE id=?',amount,item.id);
    this.journal(u,item.kind==='receivable'?'收款沖帳':'付款沖帳',no,item.kind==='receivable'?[[account,amount,0],['1100',0,amount]]:[['2000',amount,0],[account,0,amount]],d);this.log(u,'payment','open_item',item.id,{no,amount});return {no};
  });}
  adjust(u,b){permit(u,'approve');return this.tx(()=>{
    this.checkPeriod();const p=this.product(b.product_id),w=this.warehouse(b.warehouse_id),q=scaled(b.qty,3,-1e10,1e10);if(!q)fail('數量不可為零');const reason=txt(b.reason,1000,true),no=this.number('AD');
    const value=q>0?ratio(q,scaled(b.unit_cost??(p.cost/100)),1000):this.costOut(p.id,w.id,-q);this.stockMove(u,p.id,w.id,q,q>0?value:-value,'adjustment',no,reason,{lots:b.lots});
    this.journal(u,'庫存調整',no,q>0?[['1200',value,0],['5100',0,value]]:[['5100',value,0],['1200',0,value]]);this.log(u,'adjust','stock',no,{product_id:p.id,qty:q,reason});return {no};
  });}
  transfer(u,b){permit(u,'stock');return this.tx(()=>{
    const p=this.product(b.product_id),from=this.warehouse(b.from_id),to=this.warehouse(b.to_id);if(from.id===to.id)fail('來源倉與目的倉不可相同');const q=scaled(b.qty,3,1,1e10),value=this.costOut(p.id,from.id,q),no=this.number('TR');this.stockMove(u,p.id,from.id,-q,-value,'transfer',no,'',{lots:b.lots});this.stockMove(u,p.id,to.id,q,value,'transfer',no);this.log(u,'transfer','stock',no,{product_id:p.id,from:from.id,to:to.id,qty:q});return {no};
  });}
  saveBOM(u,b){permit(u,'masters');return this.tx(()=>{
    const p=this.product(b.product_id);if(!Array.isArray(b.lines)||!b.lines.length||b.lines.length>100)fail('請新增組成材料');const seen=new Set();const lines=b.lines.map(l=>{const item=this.product(l.product_id);if(item.id===p.id||seen.has(item.id))fail('組成品不可包含自己或重複材料');if(this.get('SELECT id FROM boms WHERE product_id=?',item.id))fail('本版本僅支援單階組裝，材料不可為另一個組裝品');seen.add(item.id);return [item.id,scaled(l.qty,3,1,1e10)];});if(this.get('SELECT id FROM bom_lines WHERE product_id=?',p.id))fail('此產品已作為其他組裝品材料，請先調整該 BOM');
    const old=this.get('SELECT * FROM boms WHERE product_id=?',p.id);let id;if(old){if(integer(b.version,1)!==old.version)fail('BOM 已更新，請重新載入',409);id=old.id;this.run('UPDATE boms SET name=?,version=version+1 WHERE id=?',txt(b.name||p.name,150,true),id);this.run('DELETE FROM bom_lines WHERE bom_id=?',id);}else id=Number(this.run('INSERT INTO boms(product_id,name) VALUES(?,?)',p.id,txt(b.name||p.name,150,true)).lastInsertRowid);
    for(const l of lines)this.run('INSERT INTO bom_lines(bom_id,product_id,qty) VALUES(?,?,?)',id,...l);this.log(u,'save_bom','bom',id);return {id};
  });}
  createWork(u,b){permit(u,'stock');return this.tx(()=>{const bom=this.get('SELECT * FROM boms WHERE product_id=?',integer(b.product_id,1));if(!bom)fail('請先建立 BOM');this.product(b.product_id);this.warehouse(b.warehouse_id);const q=scaled(b.qty,3,1,1e10),no=this.number('WO'),lines=this.all('SELECT * FROM bom_lines WHERE bom_id=?',bom.id);const id=Number(this.run('INSERT INTO work_orders(no,product_id,warehouse_id,qty,bom_snapshot,created_by,created_at) VALUES(?,?,?,?,?,?,?)',no,bom.product_id,integer(b.warehouse_id,1),q,JSON.stringify(lines),u.id,now()).lastInsertRowid);this.log(u,'create','work_order',id);return {id,no};});}
  completeWork(u,id){permit(u,'stock');return this.tx(()=>{
    const wo=this.get('SELECT * FROM work_orders WHERE id=?',integer(id,1));if(!wo)fail('工單不存在',404);if(wo.status!=='draft')fail('工單已完工',409);let cost=0;
    for(const l of JSON.parse(wo.bom_snapshot)){const q=ratio(l.qty,wo.qty,1000);if(!q)fail('材料用量小於最小精度 0.001');const v=this.costOut(l.product_id,wo.warehouse_id,q);cost+=v;this.stockMove(u,l.product_id,wo.warehouse_id,-q,-v,'assembly_material',wo.no);}
    this.stockMove(u,wo.product_id,wo.warehouse_id,wo.qty,cost,'assembly_finished',wo.no);this.run("UPDATE work_orders SET status='completed',cost=? WHERE id=?",cost,wo.id);this.log(u,'complete','work_order',wo.id,{cost});return {ok:true};
  });}
  returnGoods(u,b){const source=this.get('SELECT no FROM fulfilments WHERE id=?',integer(b.fulfilment_id,1));return withInventorySelection(this,{lots:b.lots,origin:source?.no},()=>new Trade(this).returns(u,b));}
  returnGoodsLegacy(u,b){permit(u,'approve');return this.tx(()=>{
    this.checkPeriod();const f=this.get('SELECT * FROM fulfilments WHERE id=?',integer(b.fulfilment_id,1));if(!f)fail('找不到出入庫單',404);if(this.get("SELECT b.id FROM bad_debts b JOIN open_items o ON o.id=b.open_item_id WHERE o.fulfilment_id=? AND b.status='approved' LIMIT 1",f.id))fail('來源有已核准呆帳，請先由財務沖回或核對',409);const d=this.doc(u,f.document_id),open=this.get('SELECT * FROM open_items WHERE fulfilment_id=?',f.id);if(this.get("SELECT en.id FROM endorsement_allocations a JOIN endorsements en ON en.id=a.endorsement_id WHERE a.open_item_id=? AND en.status='active' LIMIT 1",open.id))fail('來源帳款有未結束的背書票據',409);const all=this.all('SELECT * FROM fulfilment_lines WHERE fulfilment_id=?',f.id);if(this.get("SELECT b.id FROM bills b JOIN bill_allocations a ON a.bill_id=b.id WHERE a.open_item_id=? AND b.status IN ('received','deposited','issued','delivered','endorsed') LIMIT 1",open.id))fail('來源帳款有未兌現票據，請先完成票據處理再退貨',409);if(!Array.isArray(b.lines)||!b.lines.length)fail('請輸入退貨明細');const seen=new Set(),rows=[];
    for(const r of b.lines){const id=integer(r.line_id,1),l=all.find(x=>x.id===id);if(!l||seen.has(id))fail('退貨明細錯誤');seen.add(id);const q=scaled(r.qty,3);if(!q)continue;if(q>l.qty-l.returned_qty)fail('退貨超過可退量',409);const amount=ratio(l.amount,l.returned_qty+q,l.qty)-ratio(l.amount,l.returned_qty,l.qty),cost=ratio(l.cost,l.returned_qty+q,l.qty)-ratio(l.cost,l.returned_qty,l.qty);rows.push({...l,q,alloc:amount,returnCost:cost});}if(!rows.length)fail('退貨量不可全為零');
    const prior=this.get('SELECT COALESCE(sum(total),0) total,COALESCE(sum(net),0) net,COALESCE(sum(tax),0) tax FROM returns WHERE fulfilment_id=?',f.id);
    const baseTotal=all.reduce((s,l)=>s+l.amount,0),base=all.reduce((s,l)=>s+ratio(l.amount,l.returned_qty,l.qty),0)+rows.reduce((s,l)=>s+l.alloc,0),cum={net:baseTotal?ratio(f.net,base,baseTotal):0,tax:baseTotal?ratio(f.tax,base,baseTotal):0};
    // Reverse the exact original residual when every line has been returned.
    const complete=all.every(l=>l.returned_qty+(rows.find(r=>r.id===l.id)?.q||0)===l.qty);const net=complete?f.net-prior.net:cum.net-prior.net,tax=complete?f.tax-prior.tax:cum.tax-prior.tax,total=net+tax;
    if(this.get('SELECT id FROM allowances WHERE fulfilment_id=? LIMIT 1',f.id))fail('此單已有金額折讓，請先由財務核對；本版不允許再做實物退貨',409);
    const reduce=Math.min(total,open.amount-open.paid),credit=total-reduce;
    if(credit&&b.allow_credit!==true)fail('此退貨會超過尚未沖帳金額；請勾選建立待退款後再進行退款流程',409);
    let cost=rows.reduce((s,l)=>s+l.returnCost,0);const no=this.number(f.kind==='shipment'?'SR':'PR');
    if(f.kind==='receipt'){
      // Purchase returns leave at current moving-average value; variance is posted explicitly.
      cost=0;for(const l of rows){l.currentCost=this.costOut(l.product_id,d.warehouse_id,l.q);cost+=l.currentCost;this.stockMove(u,l.product_id,d.warehouse_id,-l.q,-l.currentCost,'purchase_return',no);}
    }else for(const l of rows)this.stockMove(u,l.product_id,d.warehouse_id,l.q,l.returnCost,'sales_return',no);
    const rid=Number(this.run('INSERT INTO returns(no,fulfilment_id,net,tax,total,cost,reason,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',no,f.id,net,tax,total,cost,txt(b.reason,1000,true),u.id,now()).lastInsertRowid);
    for(const l of rows){this.run('INSERT INTO return_lines(return_id,fulfilment_line_id,qty) VALUES(?,?,?)',rid,l.id,l.q);this.run('UPDATE fulfilment_lines SET returned_qty=returned_qty+? WHERE id=?',l.q,l.id);}
    this.run('UPDATE open_items SET amount=amount-? WHERE id=?',reduce,open.id);
    if(credit)this.run('INSERT INTO funds(no,kind,partner_id,amount,source_return_id,date,notes,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',this.number('CR'),f.kind==='shipment'?'customer_credit':'supplier_credit',d.partner_id,credit,rid,today(),'退貨待退款 '+no,u.id,now());
    const entries=f.kind==='shipment'?[['4000',net,0],['2100',tax,0],[itemAccount(open),0,reduce],['2300',0,credit],['1200',cost,0],['5000',0,cost]]:[[itemAccount(open),reduce,0],['1150',credit,0],['1300',0,tax],['1200',0,cost],...(cost>net?[['5100',cost-net,0]]:[['5100',0,net-cost]])];this.journal(u,'退貨折讓',no,entries);this.log(u,'return','fulfilment',f.id,{no,total,cost,credit});return {id:rid,no,credit};
  });}
  loan(u,b){permit(u,'stock');return this.tx(()=>{
    const kind=b.kind;if(!['in','out'].includes(kind))fail('借出入類型錯誤');const p=this.product(b.product_id),w=this.warehouse(b.warehouse_id);this.partner(u,b.partner_id);const q=scaled(b.qty,3,1,1e10),cost=kind==='out'?this.costOut(p.id,w.id,q):ratio(q,scaled(has(u,'cost')?(b.unit_cost??p.cost/100):p.cost/100),1000),no=this.number(kind==='out'?'LO':'LI');
    this.stockMove(u,p.id,w.id,kind==='out'?-q:q,kind==='out'?-cost:cost,kind==='out'?'loan_out':'loan_in',no,txt(b.notes,1000),{lots:b.lots});
    this.journal(u,kind==='out'?'借出存貨':'借入存貨',no,kind==='out'?[['1250',cost,0],['1200',0,cost]]:[['1200',cost,0],['2200',0,cost]]);
    const id=Number(this.run('INSERT INTO loans(no,kind,partner_id,product_id,warehouse_id,qty,cost,due_date,notes,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',no,kind,integer(b.partner_id,1),p.id,w.id,q,cost,dateValue(b.due_date),txt(b.notes,1000),u.id,now()).lastInsertRowid);this.log(u,'create','loan',id,{kind,q});return {id,no};
  });}
  returnLoan(u,id,b){permit(u,'stock');return this.tx(()=>{const l=this.get('SELECT * FROM loans WHERE id=?',integer(id,1));if(!l)fail('借用單不存在',404);const q=scaled(b.qty,3,1,1e10);if(q>l.qty-l.returned_qty)fail('歸還量超過未還量');const original=ratio(l.cost,l.returned_qty+q,l.qty)-ratio(l.cost,l.returned_qty,l.qty),no=this.number('LR');
    if(l.kind==='out'){this.stockMove(u,l.product_id,l.warehouse_id,q,original,'loan_return_in',no,'',{lots:b.lots,origin:l.no});this.journal(u,'借出還入',no,[['1200',original,0],['1250',0,original]]);}else{const cost=this.costOut(l.product_id,l.warehouse_id,q);this.stockMove(u,l.product_id,l.warehouse_id,-q,-cost,'loan_return_out',no,'',{lots:b.lots,origin:l.no});this.journal(u,'借入還出',no,[['2200',original,0],['1200',0,cost],...(cost>original?[['5100',cost-original,0]]:[['5100',0,original-cost]])]);}
    this.run('UPDATE loans SET returned_qty=returned_qty+? WHERE id=?',q,l.id);this.log(u,'return','loan',l.id,{q});return {no};});}
  activity(u,b){permit(u,'partners');return this.tx(()=>{this.partner(u,b.partner_id,'customer');const id=Number(this.run('INSERT INTO activities(partner_id,title,notes,next_date,owner_id,created_at) VALUES(?,?,?,?,?,?)',integer(b.partner_id,1),txt(b.title,150,true),txt(b.notes,2000),b.next_date?dateValue(b.next_date):'',u.id,now()).lastInsertRowid);this.log(u,'create','activity',id);return {id};});}
  manualJournal(u,b){permit(u,'finance');return this.tx(()=>{if(!Array.isArray(b.lines)||b.lines.length<2||b.lines.length>100)fail('請輸入 2–100 筆分錄');const lines=b.lines.map(l=>{const code=txt(l.account,20,true);if(!this.get('SELECT code FROM accounts WHERE code=?',code))fail('科目不存在');if(['1100','1110','2005','1105','1150','1200','1250','1400','2000','2010','2200','2300','2400','2500'].includes(code)||this.get('SELECT id FROM bank_accounts WHERE gl_code=?',code))fail('控制科目須透過應收付／庫存流程過帳');const d=scaled(l.debit||'0'),c=scaled(l.credit||'0');if((d>0)===(c>0))fail('每列只能借方或貸方');return [code,d,c];});const no=this.number('MJ'),id=this.journal(u,txt(b.memo,500,true),no,lines,dateValue(b.date));this.log(u,'manual_journal','journal',id);return {id,no};});}
  bootstrap(u){
    const sales=u.role==='sales',cost=has(u,'cost'),where=sales?'WHERE (p.owner_id IS NULL OR p.owner_id=?) AND p.kind IN (\'customer\',\'both\')':'',args=sales?[u.id]:[];
    const partners=this.all(`SELECT p.*,us.name owner_name FROM partners p LEFT JOIN users us ON us.id=p.owner_id ${where} ORDER BY p.code`,...args);
    const products=this.all('SELECT * FROM products WHERE active=1 ORDER BY sku').map(p=>{if(!cost){delete p.cost;delete p.supplier_id;}return p;});
    const stocks=this.all('SELECT s.*,p.sku,p.name,p.unit,p.safety_qty,w.name warehouse_name FROM stocks s JOIN products p ON p.id=s.product_id JOIN warehouses w ON w.id=s.warehouse_id ORDER BY p.sku,w.code').map(s=>{if(!cost)delete s.value;return s;});
    const docs=this.all(`SELECT d.*,p.name partner_name,us.name owner_name,w.name warehouse_name,COALESCE((SELECT sum(qty-done_qty-closed_qty) FROM document_lines WHERE document_id=d.id),0) remaining_qty FROM documents d JOIN partners p ON p.id=d.partner_id JOIN users us ON us.id=d.owner_id JOIN warehouses w ON w.id=d.warehouse_id ${sales?"WHERE d.owner_id=? AND d.kind<>'purchase'":''} ORDER BY d.id DESC LIMIT 2000`,...(sales?[u.id]:[]));
    if(!cost)for(const doc of docs)if(doc.kind==='purchase')for(const key of ['net','tax','total','header_discount'])delete doc[key];
    const prices=this.all(`SELECT pr.* FROM prices pr JOIN partners p ON p.id=pr.partner_id ${sales?'WHERE p.owner_id IS NULL OR p.owner_id=?':''}`,...args);
    const data={user:u,settings:this.settings(),today:today(),partners,products,stocks,prices,documents:docs,warehouses:this.all('SELECT * FROM warehouses WHERE active=1'),owners:this.all('SELECT id,name FROM users WHERE active=1'),activities:this.all(`SELECT a.*,p.name partner_name,us.name owner_name FROM activities a JOIN partners p ON p.id=a.partner_id JOIN users us ON us.id=a.owner_id ${sales?'WHERE a.owner_id=?':''} ORDER BY a.id DESC LIMIT 500`,...args),permissions:Object.fromEntries(Object.keys(ACCESS).map(k=>[k,has(u,k)]))};
    if(!sales){data.fulfilments=this.all('SELECT f.*,p.name partner_name,d.no document_no FROM fulfilments f JOIN documents d ON d.id=f.document_id JOIN partners p ON p.id=d.partner_id ORDER BY f.id DESC LIMIT 1000').map(f=>{if(!cost){delete f.cost;if(f.kind==='receipt')for(const key of ['net','tax','total'])delete f[key];}return f;});data.moves=this.all('SELECT m.*,p.sku,p.name,w.name warehouse_name,us.name user_name FROM stock_moves m JOIN products p ON p.id=m.product_id JOIN warehouses w ON w.id=m.warehouse_id JOIN users us ON us.id=m.created_by ORDER BY m.id DESC LIMIT 1000').map(m=>{if(!cost)delete m.value;return m;});data.boms=this.all('SELECT b.*,p.sku,p.name product_name FROM boms b JOIN products p ON p.id=b.product_id').map(b=>({...b,lines:this.all('SELECT l.*,p.name,p.sku,p.unit FROM bom_lines l JOIN products p ON p.id=l.product_id WHERE l.bom_id=?',b.id)}));data.work_orders=this.all('SELECT wo.*,p.name product_name,p.unit,w.name warehouse_name FROM work_orders wo JOIN products p ON p.id=wo.product_id JOIN warehouses w ON w.id=wo.warehouse_id ORDER BY wo.id DESC LIMIT 500').map(w=>{if(!cost)delete w.cost;return w;});data.loans=this.all('SELECT l.*,p.name product_name,p.unit,pa.name partner_name,w.name warehouse_name FROM loans l JOIN products p ON p.id=l.product_id JOIN partners pa ON pa.id=l.partner_id JOIN warehouses w ON w.id=l.warehouse_id ORDER BY l.id DESC LIMIT 500').map(l=>{if(!cost)delete l.cost;return l;});data.returns=this.all('SELECT r.*,f.no source_no FROM returns r JOIN fulfilments f ON f.id=r.fulfilment_id ORDER BY r.id DESC LIMIT 500').map(r=>{if(!cost){delete r.cost;const f=this.get('SELECT kind FROM fulfilments WHERE id=?',r.fulfilment_id);if(f.kind==='receipt')for(const key of ['net','tax','total'])delete r[key];}return r;});}
    if(!sales){data.inventory_counts=this.all('SELECT c.*,w.name warehouse_name FROM inventory_counts c JOIN warehouses w ON w.id=c.warehouse_id ORDER BY c.id DESC LIMIT 500');data.replenishment=this.replenishment(u);data.document_links=this.all('SELECT l.*,s.no source_no,t.no target_no,t.status target_status FROM document_links l JOIN documents s ON s.id=l.source_id JOIN documents t ON t.id=l.target_id');}
    if(cost){data.open_items=this.all('SELECT o.*,p.name partner_name,f.no source_no,d.no document_no FROM open_items o JOIN partners p ON p.id=o.partner_id JOIN fulfilments f ON f.id=o.fulfilment_id JOIN documents d ON d.id=f.document_id WHERE o.billing_state=\'posted\' ORDER BY o.id DESC');data.payments=this.all('SELECT pay.*,p.name partner_name,o.kind FROM payments pay JOIN open_items o ON o.id=pay.open_item_id JOIN partners p ON p.id=o.partner_id ORDER BY pay.id DESC LIMIT 1000');data.accounts=this.all('SELECT a.*,COALESCE(sum(l.debit),0) debit,COALESCE(sum(l.credit),0) credit FROM accounts a LEFT JOIN journal_lines l ON l.account=a.code GROUP BY a.code ORDER BY a.code');data.journals=this.all('SELECT j.*,COALESCE((SELECT sum(debit) FROM journal_lines WHERE journal_id=j.id),0) amount FROM journals j ORDER BY id DESC LIMIT 1000');data.sales_report=this.all("SELECT p.name partner_name,us.name owner_name,substr(f.date,1,7) month,sum(f.net-COALESCE(r.net,0)) revenue,sum(f.cost-COALESCE(r.cost,0)) cost FROM fulfilments f JOIN documents d ON d.id=f.document_id JOIN partners p ON p.id=d.partner_id JOIN users us ON us.id=d.owner_id LEFT JOIN (SELECT fulfilment_id,sum(net) net,sum(cost) cost FROM returns GROUP BY fulfilment_id) r ON r.fulfilment_id=f.id WHERE f.kind='shipment' GROUP BY p.id,us.id,substr(f.date,1,7)");}
    if(has(u,'approve'))data.audit=this.all('SELECT a.*,u.name actor_name FROM audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 500');
    if(u.role==='admin')data.users=this.all('SELECT id,username,name,role,active,created_at FROM users ORDER BY id');return data;
  }
  fulfilment(u,id){if(u.role==='sales')fail('無權存取出入庫資料',403);const f=this.get('SELECT * FROM fulfilments WHERE id=?',integer(id,1));if(!f)fail('單據不存在',404);this.doc(u,f.document_id);f.lines=this.all('SELECT f.*,d.sku,d.name,d.unit FROM fulfilment_lines f JOIN document_lines d ON d.id=f.document_line_id WHERE f.fulfilment_id=?',f.id).map(l=>{if(!has(u,'cost')){delete l.cost;if(f.kind==='receipt')for(const key of ['amount','net','tax','total'])delete l[key];}return l;});if(!has(u,'cost')){delete f.cost;if(f.kind==='receipt')for(const key of ['net','tax','total'])delete f[key];}return f;}
  journalDetail(u,id){permit(u,'finance');const j=this.get('SELECT * FROM journals WHERE id=?',integer(id,1));if(!j)fail('傳票不存在',404);return {...j,lines:this.all('SELECT l.*,a.name FROM journal_lines l JOIN accounts a ON a.code=l.account WHERE l.journal_id=?',j.id)};}
  integrity(u){permit(u,'admin');const problems=[];
    const stockDiff=this.all('SELECT s.product_id,s.warehouse_id,s.qty,s.value,COALESCE(sum(m.qty),0) ledger_qty,COALESCE(sum(m.value),0) ledger_value FROM stocks s LEFT JOIN stock_moves m ON m.product_id=s.product_id AND m.warehouse_id=s.warehouse_id GROUP BY s.product_id,s.warehouse_id HAVING s.qty<>COALESCE(sum(m.qty),0) OR s.value<>COALESCE(sum(m.value),0)');if(stockDiff.length)problems.push({type:'stock_ledger',rows:stockDiff});
    const reserve=this.all("SELECT s.product_id,s.warehouse_id,s.reserved,COALESCE((SELECT sum((l.qty-l.done_qty-l.closed_qty)*l.unit_ratio/1000) FROM document_lines l JOIN documents d ON d.id=l.document_id WHERE l.product_id=s.product_id AND d.warehouse_id=s.warehouse_id AND d.kind='order' AND l.track_stock=1 AND d.status IN ('approved','partial')),0) expected FROM stocks s WHERE reserved<>COALESCE((SELECT sum((l.qty-l.done_qty-l.closed_qty)*l.unit_ratio/1000) FROM document_lines l JOIN documents d ON d.id=l.document_id WHERE l.product_id=s.product_id AND d.warehouse_id=s.warehouse_id AND d.kind='order' AND l.track_stock=1 AND d.status IN ('approved','partial')),0)");if(reserve.length)problems.push({type:'reservations',rows:reserve});
    const journals=this.all('SELECT journal_id,sum(debit)-sum(credit) difference FROM journal_lines GROUP BY journal_id HAVING sum(debit)<>sum(credit)');if(journals.length)problems.push({type:'journals',rows:journals});
    const balance=code=>this.get('SELECT COALESCE(sum(debit-credit),0) n FROM journal_lines WHERE account=?',code).n;
    const control=[['inventory',balance('1200'),this.get('SELECT COALESCE(sum(value),0) n FROM stocks').n],...['receivable','payable'].map(k=>[k,(k==='receivable'?1:-1)*balance(k==='receivable'?'1100':'2000'),this.get('SELECT COALESCE(sum(amount-paid),0) n FROM open_items WHERE kind=? AND billing_state=\'posted\'',k).n+this.get('SELECT COALESCE(sum(amount-paid),0) n FROM opening_items WHERE kind=?',k).n]),...Object.entries(FUND_ACCOUNTS).map(([k,a])=>[k,(k.startsWith('customer')?-1:1)*balance(a),this.get('SELECT COALESCE(sum(amount-applied-refunded),0) n FROM funds WHERE kind=?',k).n]),...['receivable','payable'].map(k=>['bill_'+k,(k==='receivable'?1:-1)*balance(k==='receivable'?'1105':'2010'),this.get("SELECT COALESCE(sum(amount),0) n FROM bills WHERE kind=? AND status IN ('received','deposited','issued','delivered')",k).n]),['expenses',-balance('2500'),this.get('SELECT COALESCE(sum(total-paid),0) n FROM expenses').n]];
    for(const [kind,account,sign] of [['receivable','1110',1],['payable','2005',-1]])control.push(['pending_'+kind,sign*balance(account),this.get("SELECT COALESCE(sum(amount-paid),0) n FROM open_items WHERE kind=? AND billing_state='pending'",kind).n]);
    for(const [kind,account,sign] of [['receivable','1105',1],['payable','2010',-1]]){const c=control.find(row=>row[0]==='bill_'+kind);c[2]+=this.get("SELECT COALESCE(sum(amount),0) n FROM nontrade_bills WHERE kind=? AND status IN ('received','deposited','issued','delivered')",kind).n;}
    for(const [type,ledger,subsidiary] of control)if(ledger!==subsidiary)problems.push({type,ledger,subsidiary});
    const lotDiff=this.all("SELECT s.product_id,s.warehouse_id,s.qty,COALESCE((SELECT sum(qty) FROM inventory_lots l WHERE l.product_id=s.product_id AND l.warehouse_id=s.warehouse_id),0) lot_qty FROM stocks s JOIN products p ON p.id=s.product_id WHERE p.tracking_mode<>'none' AND s.qty<>COALESCE((SELECT sum(qty) FROM inventory_lots l WHERE l.product_id=s.product_id AND l.warehouse_id=s.warehouse_id),0)");if(lotDiff.length)problems.push({type:'lot_stock',rows:lotDiff});
    const lotLedger=this.all('SELECT l.id,l.qty,COALESCE(sum(m.qty),0) ledger_qty FROM inventory_lots l LEFT JOIN lot_moves m ON m.lot_id=l.id GROUP BY l.id HAVING l.qty<>COALESCE(sum(m.qty),0)');if(lotLedger.length)problems.push({type:'lot_ledger',rows:lotLedger});
    const sqlite=this.get('PRAGMA integrity_check').integrity_check;const foreign=this.all('PRAGMA foreign_key_check');if(sqlite!=='ok'||foreign.length)problems.push({type:'sqlite',sqlite,foreign});return {ok:!problems.length,checks:['批號與序號流水','SQLite','外鍵完整性','庫存數量與金額','庫存預留','傳票借貸平衡','存貨總帳','應收子帳','應付子帳','預收預付與待退款','應收應付票據','應付費用'],problems};
  }
  importPreview(u,b){permit(u,'admin');if(!['products','partners','opening_stock'].includes(b.kind))fail('匯入類型錯誤');if(!Array.isArray(b.rows)||!b.rows.length||b.rows.length>2000)fail('單次可匯入 1–2000 列');const errors=[],seen=new Set(),barcodes=new Set();
    const rows=b.rows.map((r,i)=>{try{
      if(b.kind==='products'){const sku=txt(r.sku,60,true);if(seen.has(sku)||this.get('SELECT id FROM products WHERE sku=?',sku))fail('品號重複');seen.add(sku);txt(r.name,150,true);scaled(r.price??'0');scaled(r.cost??'0');scaled(r.safety_qty??'0',3);const barcode=txt(r.barcode,80);if(barcode){if(barcodes.has(barcode)||this.get('SELECT id FROM products WHERE barcode=?',barcode)||this.get('SELECT id FROM product_units WHERE barcode=?',barcode))fail('條碼重複');barcodes.add(barcode);}}
      if(b.kind==='partners'){const code=txt(r.code,40,true);if(seen.has(code)||this.get('SELECT id FROM partners WHERE code=?',code))fail('代號重複');seen.add(code);txt(r.name,100,true);if(!['customer','supplier','both'].includes(r.kind||'customer'))fail('類型錯誤');integer(r.payment_days??30,0,365);scaled(r.credit_limit??'0');}
      if(b.kind==='opening_stock'){const p=this.get('SELECT * FROM products WHERE sku=?',txt(r.sku,60,true)),w=this.get('SELECT * FROM warehouses WHERE code=?',txt(r.warehouse_code,40,true));if(!p||!w)fail('品號或倉庫代號不存在');if(!p.track_stock)fail('非庫存服務不可匯入期初庫存');if(p.tracking_mode!=='none')fail('批號／序號商品請使用批號入庫流程');const key=p.id+':'+w.id;if(seen.has(key)||this.get('SELECT id FROM stock_moves WHERE product_id=? AND warehouse_id=? LIMIT 1',p.id,w.id))fail('此品項倉庫已有流水，不能重複匯入期初');seen.add(key);scaled(r.qty,3,1);scaled(r.unit_cost??'0');}
      return r;
    }catch(e){errors.push({row:i+2,message:e.message});return r;}});
    return this.tx(()=>{const summary={count:rows.length,errors};const id=Number(this.run('INSERT INTO imports(kind,payload,summary,created_by,created_at) VALUES(?,?,?,?,?)',b.kind,JSON.stringify(rows),JSON.stringify(summary),u.id,now()).lastInsertRowid);this.log(u,'preview','import',id,{kind:b.kind,count:rows.length,errors:errors.length});return {id,...summary};});
  }
  importCommit(u,id){permit(u,'admin');return this.tx(()=>{
    const batch=this.get('SELECT * FROM imports WHERE id=?',integer(id,1));if(!batch||batch.status!=='preview')fail('匯入批次不存在或已執行',409);if(JSON.parse(batch.summary).errors.length)fail('請先修正預覽錯誤');const rows=JSON.parse(batch.payload);this.checkPeriod();
    for(const r of rows){if(batch.kind==='products'){
      this.saveProduct(u,r);
    }else if(batch.kind==='partners')this.run('INSERT INTO partners(code,name,kind,contact,phone,email,tax_id,address,payment_days,credit_limit,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?)',txt(r.code,40,true),txt(r.name,100,true),r.kind||'customer',txt(r.contact,80),txt(r.phone,60),txt(r.email,100),txt(r.tax_id,20),txt(r.address,300),integer(r.payment_days??30,0,365),scaled(r.credit_limit??'0'),txt(r.notes,2000));
    else{const p=this.get('SELECT * FROM products WHERE sku=?',r.sku),w=this.get('SELECT * FROM warehouses WHERE code=?',r.warehouse_code);if(!p||!w||this.get('SELECT id FROM stock_moves WHERE product_id=? AND warehouse_id=? LIMIT 1',p.id,w.id))fail('期初資料已變更，請重新預覽',409);const qty=scaled(r.qty,3,1),value=ratio(qty,scaled(r.unit_cost??'0'),1000),no=this.number('OP');this.stockMove(u,p.id,w.id,qty,value,'opening',no,'期初匯入');this.journal(u,'期初存貨',no,[['1200',value,0],['3000',0,value]]);}}
    this.run("UPDATE imports SET status='committed' WHERE id=?",batch.id);this.log(u,'commit','import',batch.id,{count:rows.length});return {count:rows.length};
  });}
}
