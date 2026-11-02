import test from 'node:test';
import assert from 'node:assert/strict';
import { ERP,scaled,ratio,today,addDays,dateValue,hashPassword,verifyPassword } from '../src/core.mjs';
import { printDocument } from '../src/print.mjs';
import { seedDemo } from '../src/seed.mjs';

function fixture(t){
 const e=new ERP();t.after(()=>e.close());
 const admin=e.setup({username:'admin',password:'test-password-2026',company:'測試公司',name:'管理員'});
 const customer=e.savePartner(admin,{code:'C1',name:'測試客戶',kind:'customer',payment_days:30});
 const supplier=e.savePartner(admin,{code:'V1',name:'測試廠商',kind:'supplier'});
 const product=e.saveProduct(admin,{sku:'P1',name:'商品一',unit:'個',price:'100',cost:'40',safety_qty:'5'});
 const second=e.saveProduct(admin,{sku:'P2',name:'商品二',price:'25',cost:'10'});
 const wh2=e.saveWarehouse(admin,{code:'W2',name:'第二倉'});
 const doc=(kind='order',lines=[{product_id:product.id,qty:'3',price:'100'}],extra={},u=admin)=>e.saveDoc(u,{kind,partner_id:kind==='purchase'?supplier.id:customer.id,warehouse_id:1,date:today(),due_date:addDays(today(),3),valid_until:addDays(today(),30),tax_mode:'exclusive',tax_bp:500,lines,...extra});
 const approve=d=>{e.transition(admin,d.id,'submit');return e.transition(admin,d.id,'approve');};
 const stock=(p=product.id,q='20',cost='40',w=1)=>e.adjust(admin,{product_id:p,warehouse_id:w,qty:q,unit_cost:cost,reason:'測試備料'});
 const user=role=>{const username=role+'-'+e.get('SELECT count(*) n FROM users').n;e.saveUser(admin,{username,name:username,role,password:'test-password-2026'});return e.get('SELECT id,username,name,role,active FROM users WHERE username=?',username);};
 const check=()=>assert.deepEqual(e.integrity(admin).problems,[]);
 return {e,admin,customer,supplier,product,second,wh2,doc,approve,stock,user,check};
}
const rejects=(fn,pattern)=>assert.throws(fn,pattern);

test('money and quantity parsing preserves decimal precision and rejects malformed values',()=>{
 assert.equal(scaled('0.29'),29);assert.equal(scaled('12.345',3),12345);assert.equal(scaled('-1.250',3,-10000),-1250);
 assert.equal(ratio(1_000_000_001,999_999,1000),999_999_001_000);
 for(const s of ['1e3','NaN','Infinity','1.234','',null,true])rejects(()=>scaled(s),/數字|數值/);
 rejects(()=>dateValue('2026-02-30'),/日期/);assert.equal(dateValue('2026-11-02'),'2026-11-02');
});
test('initial setup is one-time and passwords are salted hashes',t=>{
 const {e,admin}=fixture(t);const hash=e.get('SELECT password FROM users WHERE id=?',admin.id).password;
 assert.equal(verifyPassword('test-password-2026',hash),true);assert.equal(verifyPassword('wrong',hash),false);
 assert.notEqual(hashPassword('same-password-2026'),hashPassword('same-password-2026'));
 rejects(()=>hashPassword('short'),/12/);rejects(()=>e.setup({}),/初始化/);
});
test('draft totals, discount and tax modes are recalculated by server',t=>{
 const {doc}=fixture(t);
 const d=doc('quote',[{product_id:1,qty:'2.500',price:'123.45',discount_bp:9000}]);
 assert.equal(d.net,27777);assert.equal(d.tax,1389);assert.equal(d.total,29166);
 const inclusive=doc('quote',[{product_id:1,qty:'1',price:'105'}],{tax_mode:'inclusive'});assert.equal(inclusive.net,10000);assert.equal(inclusive.tax,500);
 const free=doc('quote',[{product_id:1,qty:'1',price:'105'}],{tax_mode:'none'});assert.equal(free.total,10500);assert.equal(free.tax,0);
});
test('optimistic versions protect document and master edits from lost updates',t=>{
 const {e,admin,doc,product}=fixture(t);const d=doc();
 const b={...d,lines:[{product_id:1,qty:'4',price:'100'}]};e.saveDoc(admin,b);
 rejects(()=>e.saveDoc(admin,b),/其他人修改/);assert.equal(e.doc(admin,d.id).lines[0].qty,4000);
 e.saveProduct(admin,{...product,price:'99',cost:'40',safety_qty:'5'});
 rejects(()=>e.saveProduct(admin,{...product,price:'50',cost:'40'}),/更新/);
});
test('quote approval does not reserve inventory and conversion carries snapshots once',t=>{
 const {e,admin,doc,approve,check}=fixture(t);const q=approve(doc('quote'));
 assert.equal(e.get('SELECT count(*) n FROM stocks').n,0);
 const order=e.convertQuote(admin,q.id);assert.equal(order.source_id,q.id);assert.equal(order.total,q.total);assert.equal(order.status,'draft');
 assert.equal(e.doc(admin,q.id).status,'converted');rejects(()=>e.convertQuote(admin,q.id),/核准/);check();
});
test('order-to-cash supports partial shipment and collection with balanced ledgers',t=>{
 const {e,admin,doc,approve,stock,check}=fixture(t);stock();const d=approve(doc());
 assert.equal(e.stock(1,1).qty,20000);assert.equal(e.stock(1,1).reserved,3000);
 e.fulfil(admin,d.id,{lines:[{line_id:d.lines[0].id,qty:'1'}]});assert.equal(e.doc(admin,d.id).status,'partial');assert.equal(e.stock(1,1).qty,19000);assert.equal(e.stock(1,1).reserved,2000);
 e.fulfil(admin,d.id,{});assert.equal(e.doc(admin,d.id).status,'completed');assert.equal(e.stock(1,1).reserved,0);
 const items=e.all('SELECT * FROM open_items');assert.equal(items.reduce((s,x)=>s+x.amount,0),31500);
 e.pay(admin,{open_item_id:items[0].id,amount:'50',method:'bank',date:today()});assert.equal(e.get('SELECT paid FROM open_items WHERE id=?',items[0].id).paid,5000);check();
});
test('competing orders cannot reserve the same available stock',t=>{
 const {e,admin,doc,approve,stock,check}=fixture(t);stock(1,'5');approve(doc());const second=doc();e.transition(admin,second.id,'submit');
 rejects(()=>e.transition(admin,second.id,'approve'),/庫存不足/);assert.equal(e.stock(1,1).reserved,3000);assert.equal(e.doc(admin,second.id).status,'pending');check();
});
test('failed multiline approval rolls back reservations on earlier lines',t=>{
 const {e,admin,doc,stock,check}=fixture(t);stock(1,'5');const d=doc('order',[{product_id:1,qty:'2',price:'100'},{product_id:2,qty:'5',price:'20'}]);e.transition(admin,d.id,'submit');
 rejects(()=>e.transition(admin,d.id,'approve'),/庫存不足/);assert.equal(e.stock(1,1).reserved,0);check();
});
test('approved documents cannot be edited and cancellation releases reservations',t=>{
 const {e,admin,doc,approve,stock,check}=fixture(t);stock();const d=approve(doc());
 rejects(()=>e.saveDoc(admin,{...d,lines:[]}),/只能編輯/);rejects(()=>e.transition(admin,d.id,'cancel',{}),/欄位/);
 e.transition(admin,d.id,'cancel',{reason:'客戶取消'});assert.equal(e.stock(1,1).reserved,0);assert.equal(e.stock(1,1).qty,20000);check();
});
test('stale transitions, over-shipment and duplicate or foreign lines leave state intact',t=>{
 const {e,admin,doc,approve,stock,check}=fixture(t);stock();const d=approve(doc());
 rejects(()=>e.transition(admin,d.id,'cancel',{version:1,reason:'取消'}),/更新/);
 for(const lines of [[{line_id:d.lines[0].id,qty:'4'}],[{line_id:9999,qty:'1'}],[{line_id:d.lines[0].id,qty:'1'},{line_id:d.lines[0].id,qty:'1'}]])rejects(()=>e.fulfil(admin,d.id,{lines}),/超過|不屬於|重複/);
 assert.equal(e.stock(1,1).qty,20000);assert.equal(e.get('SELECT count(*) n FROM fulfilments').n,0);check();
});
test('inclusive purchase receipts allocate exact cents across tiny lines and partial receipts',t=>{
 const {e,admin,doc,approve,check}=fixture(t);
 for(let i=3;i<=20;i++)e.saveProduct(admin,{sku:'P'+i,name:'微額商品'+i,price:'0.01',cost:'0'});
 const lines=Array.from({length:20},(_,i)=>({product_id:i+1,qty:'3',price:'0.01'}));const d=approve(doc('purchase',lines,{tax_mode:'inclusive'}));
 for(let n=0;n<3;n++)e.fulfil(admin,d.id,{lines:d.lines.map(l=>({line_id:l.id,qty:'1'}))});
 const totals=e.get('SELECT sum(net) net,sum(tax) tax,sum(total) total FROM fulfilments');assert.equal(totals.net,d.net);assert.equal(totals.tax,d.tax);assert.equal(totals.total,d.total);assert.equal(e.get('SELECT sum(value) n FROM stocks').n,d.net);check();
});
test('fractional quantities and repeated partial shipping conserve document tax and revenue',t=>{
 const {e,admin,doc,approve,stock,check}=fixture(t);stock(1,'10','0.29');const d=approve(doc('order',[{product_id:1,qty:'0.333',price:'1.17'}]));
 for(let n=0;n<3;n++)e.fulfil(admin,d.id,{lines:[{line_id:d.lines[0].id,qty:'0.111'}]});
 const totals=e.get('SELECT sum(net) net,sum(tax) tax,sum(total) total FROM fulfilments');assert.equal(totals.net,d.net);assert.equal(totals.tax,d.tax);assert.equal(totals.total,d.total);check();
});
test('repeated sales returns restore original cost and reverse exact original receivable',t=>{
 const {e,admin,doc,approve,stock,check}=fixture(t);stock(1,'10','0.29');const d=approve(doc('order',[{product_id:1,qty:'3',price:'0.17'}],{tax_mode:'inclusive'}));const f=e.fulfil(admin,d.id,{});const fl=e.fulfilment(admin,f.id).lines[0];
 for(let n=0;n<3;n++)e.returnGoods(admin,{fulfilment_id:f.id,reason:'測試退回',lines:[{line_id:fl.id,qty:'1'}]});
 assert.equal(e.stock(1,1).qty,10000);assert.equal(e.stock(1,1).value,290);assert.equal(e.get('SELECT amount FROM open_items').amount,0);
 rejects(()=>e.returnGoods(admin,{fulfilment_id:f.id,reason:'超退',lines:[{line_id:fl.id,qty:'1'}]}),/超過/);check();
});
test('return requiring refund is blocked atomically instead of silently producing negative AR',t=>{
 const {e,admin,doc,approve,stock,check}=fixture(t);stock();const d=approve(doc()),f=e.fulfil(admin,d.id,{}),item=e.get('SELECT * FROM open_items'),fl=e.fulfilment(admin,f.id).lines[0];
 e.pay(admin,{open_item_id:item.id,amount:'315',date:today()});const before=e.stock(1,1);
 rejects(()=>e.returnGoods(admin,{fulfilment_id:f.id,reason:'退回',lines:[{line_id:fl.id,qty:'1'}]}),/退款/);assert.deepEqual(e.stock(1,1),before);assert.equal(e.get('SELECT count(*) n FROM returns').n,0);check();
});
test('purchase return uses current average and posts valuation variance',t=>{
 const {e,admin,doc,approve,stock,check}=fixture(t);stock(1,'2','20');const d=approve(doc('purchase',[{product_id:1,qty:'2',price:'10'}])),f=e.fulfil(admin,d.id,{}),fl=e.fulfilment(admin,f.id).lines[0];
 assert.equal(e.stock(1,1).value,6000);const ret=e.returnGoods(admin,{fulfilment_id:f.id,reason:'退供應商',lines:[{line_id:fl.id,qty:'2'}]});assert.equal(e.stock(1,1).qty,2000);assert.equal(e.stock(1,1).value,3000);assert.equal(e.get("SELECT sum(l.debit-l.credit) n FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE l.account='5100' AND j.reference=?",ret.no).n,1000);check();
});
test('transfers conserve total cost and cannot take reserved units',t=>{
 const {e,admin,doc,approve,stock,wh2,check}=fixture(t);stock(1,'5','0.33');approve(doc());
 rejects(()=>e.transfer(admin,{product_id:1,from_id:1,to_id:wh2.id,qty:'3'}),/不足/);
 e.transfer(admin,{product_id:1,from_id:1,to_id:wh2.id,qty:'2'});assert.equal(e.stock(1,wh2.id).value,66);assert.equal(e.get('SELECT sum(value) n FROM stocks').n,165);check();
});
test('BOM snapshot is used at completion even after BOM edits',t=>{
 const {e,admin,stock,check}=fixture(t);stock(1,'10','4');stock(2,'10','2');const finished=e.saveProduct(admin,{sku:'KIT',name:'組合品',price:'20',cost:'0'});
 e.saveBOM(admin,{product_id:finished.id,name:'組裝',lines:[{product_id:1,qty:'1'},{product_id:2,qty:'2'}]});const wo=e.createWork(admin,{product_id:finished.id,warehouse_id:1,qty:'2'});
 e.saveBOM(admin,{product_id:finished.id,name:'新版組裝',version:1,lines:[{product_id:1,qty:'5'}]});e.completeWork(admin,wo.id);
 assert.equal(e.stock(1,1).qty,8000);assert.equal(e.stock(2,1).qty,6000);assert.equal(e.stock(finished.id,1).value,1600);rejects(()=>e.completeWork(admin,wo.id),/已完工/);check();
});
test('assembly shortage rolls back all material movements and rejects cyclic BOMs',t=>{
 const {e,admin,stock,check}=fixture(t);stock(1,'10');const kit=e.saveProduct(admin,{sku:'KIT',name:'組成',price:'10',cost:'0'});
 rejects(()=>e.saveBOM(admin,{product_id:1,lines:[{product_id:1,qty:'1'}]}),/自己/);
 e.saveBOM(admin,{product_id:kit.id,lines:[{product_id:1,qty:'1'},{product_id:2,qty:'1'}]});const wo=e.createWork(admin,{product_id:kit.id,warehouse_id:1,qty:'2'}),before=e.stock(1,1);
 rejects(()=>e.completeWork(admin,wo.id),/不足/);assert.deepEqual(e.stock(1,1),before);assert.equal(e.get('SELECT status FROM work_orders WHERE id=?',wo.id).status,'draft');check();
});
test('outbound and inbound loans and partial returns preserve control accounts',t=>{
 const {e,admin,stock,customer,check}=fixture(t);stock();const outbound=e.loan(admin,{kind:'out',partner_id:customer.id,product_id:1,warehouse_id:1,qty:'3',due_date:today()});
 e.returnLoan(admin,outbound.id,{qty:'1'});e.returnLoan(admin,outbound.id,{qty:'2'});assert.equal(e.stock(1,1).qty,20000);
 const inbound=e.loan(admin,{kind:'in',partner_id:customer.id,product_id:1,warehouse_id:1,qty:'2',unit_cost:'50',due_date:today()});
 e.returnLoan(admin,inbound.id,{qty:'2'});assert.equal(e.stock(1,1).qty,20000);assert.equal(e.get("SELECT sum(debit-credit) n FROM journal_lines WHERE account='2200'").n,0);check();
});
test('collections cannot exceed balance and period lock prevents backdated transactions',t=>{
 const {e,admin,doc,approve,stock,check}=fixture(t);stock();const d=approve(doc());e.fulfil(admin,d.id,{});const item=e.get('SELECT * FROM open_items');
 rejects(()=>e.pay(admin,{open_item_id:item.id,amount:'315.01',date:today()}),/超過/);
 e.saveSettings(admin,{company:'測試',closed_until:today()});rejects(()=>e.pay(admin,{open_item_id:item.id,amount:'1',date:today()}),/結帳/);rejects(()=>stock(),/結帳/);rejects(()=>e.saveSettings(admin,{company:'測試',closed_until:''}),/回退/);check();
});
test('sales role can access only assigned customers and own documents, without costs',t=>{
 const {e,admin,customer,user,doc,approve,stock}=fixture(t);const sales=user('sales'),other=user('sales'),warehouse=user('warehouse'),finance=user('finance'),viewer=user('viewer');
 e.savePartner(admin,{...customer,owner_id:sales.id,credit_limit:'10000'});stock();const d=approve(doc('order',undefined,{},sales));e.fulfil(admin,d.id,{});
 rejects(()=>e.partner(other,customer.id),/負責/);rejects(()=>e.doc(other,d.id),/自己的/);rejects(()=>e.transition(sales,d.id,'approve'),/權限/);
 const data=e.bootstrap(sales);assert.equal('cost' in data.products[0],false);assert.equal('value' in data.stocks[0],false);assert.equal('accounts' in data,false);assert.equal('cost' in e.publicDoc(sales,d.id).fulfilments[0],false);
 const po=approve(doc('purchase'));const f=e.fulfil(warehouse,po.id,{});assert.equal('price' in e.publicDoc(warehouse,po.id).lines[0],false);assert.equal('cost' in e.fulfilment(warehouse,f.id),false);assert.equal('total' in e.bootstrap(warehouse).fulfilments.find(x=>x.id===f.id),false);
 for(const u of [sales,warehouse,viewer])rejects(()=>e.manualJournal(u,{lines:[]}),/權限/);assert.ok(e.bootstrap(finance).accounts.length);
});
test('sales cannot set another owner or grant payment terms and credit limits',t=>{
 const {e,user,customer,admin}=fixture(t);const sales=user('sales'),other=user('sales');
 const p=e.savePartner(sales,{code:'NEW',name:'新增客戶',kind:'customer',owner_id:other.id,payment_days:365,credit_limit:'999999'});assert.equal(p.owner_id,sales.id);assert.equal(p.payment_days,30);assert.equal(p.credit_limit,0);
 e.savePartner(admin,{...customer,credit_limit:'500',owner_id:sales.id});const current=e.partner(sales,customer.id);
 const edited=e.savePartner(sales,{...current,name:'客戶更名',payment_days:100,credit_limit:'0'});assert.equal(edited.credit_limit,50000);assert.equal(edited.payment_days,30);
});
test('credit policy includes open receivables and unshipped commitments',t=>{
 const {e,admin,customer,stock,doc,approve,check}=fixture(t);e.savePartner(admin,{...customer,credit_limit:'500'});stock();const first=approve(doc());const second=doc();e.transition(admin,second.id,'submit');
 rejects(()=>e.transition(admin,second.id,'approve'),/信用額度/);e.fulfil(admin,first.id,{});rejects(()=>e.transition(admin,second.id,'approve'),/信用額度/);
 const item=e.get('SELECT * FROM open_items');e.pay(admin,{open_item_id:item.id,amount:'200',date:today()});e.transition(admin,second.id,'approve');check();
});
test('last admin cannot be disabled and password changes revoke sessions',t=>{
 const {e,admin}=fixture(t);rejects(()=>e.saveUser(admin,{id:admin.id,name:'管理員',role:'viewer',active:true}),/至少/);
 e.run('INSERT INTO sessions VALUES(?,?,?,?)','hash',admin.id,'csrf',Date.now()+10000);rejects(()=>e.changePassword(admin,{old_password:'wrong',password:'new-password-2026'}),/原密碼/);
 e.changePassword(admin,{old_password:'test-password-2026',password:'new-password-2026'});assert.equal(e.get('SELECT count(*) n FROM sessions').n,0);
});
test('manual journals must balance and cannot bypass control ledgers',t=>{
 const {e,admin,check}=fixture(t);rejects(()=>e.manualJournal(admin,{memo:'不平衡',lines:[{account:'1000',debit:'10'},{account:'4000',credit:'9'}]}),/不平衡/);
 rejects(()=>e.manualJournal(admin,{memo:'控制科目',lines:[{account:'1200',debit:'10'},{account:'3000',credit:'10'}]}),/控制科目/);
 e.manualJournal(admin,{memo:'資金投入',date:today(),lines:[{account:'1000',debit:'100'},{account:'3000',credit:'100'}]});check();
});
test('import preview reports row errors and atomic commit cannot duplicate opening stock',t=>{
 const {e,admin,check}=fixture(t);const bad=e.importPreview(admin,{kind:'products',rows:[{sku:'P1',name:'重複'},{sku:'P3',name:''}]});assert.equal(bad.errors.length,2);rejects(()=>e.importCommit(admin,bad.id),/修正/);
 const valid=e.importPreview(admin,{kind:'products',rows:[{sku:'IM1',name:'匯入商品',price:'100.01',cost:'40'}]});assert.equal(valid.errors.length,0);e.importCommit(admin,valid.id);rejects(()=>e.importCommit(admin,valid.id),/已執行/);
 const opening=e.importPreview(admin,{kind:'opening_stock',rows:[{sku:'IM1',warehouse_code:'WH01',qty:'12.500',unit_cost:'40'}]});e.importCommit(admin,opening.id);assert.equal(e.get("SELECT s.qty FROM stocks s JOIN products p ON p.id=s.product_id WHERE p.sku='IM1'").qty,12500);
 const second=e.importPreview(admin,{kind:'opening_stock',rows:[{sku:'IM1',warehouse_code:'WH01',qty:'1',unit_cost:'40'}]});assert.equal(second.errors.length,1);check();
});
test('import race or later bad row rolls back the whole batch',t=>{
 const {e,admin}=fixture(t);const batch=e.importPreview(admin,{kind:'products',rows:[{sku:'B1',name:'第一筆'},{sku:'B2',name:'第二筆'}]});e.saveProduct(admin,{sku:'B2',name:'另一位先建立',price:'1',cost:'1'});
 rejects(()=>e.importCommit(admin,batch.id),/UNIQUE/);assert.equal(e.get("SELECT id FROM products WHERE sku='B1'"),undefined);assert.equal(e.get('SELECT status FROM imports WHERE id=?',batch.id).status,'preview');
});
test('stock, journal and audit ledgers reject updates and deletes',t=>{
 const {e,stock,doc,approve,admin}=fixture(t);stock();e.fulfil(admin,approve(doc()).id,{});
 for(const table of ['stock_moves','journals','journal_lines','audit']){rejects(()=>e.run(`DELETE FROM ${table}`),/immutable/);rejects(()=>e.run(`UPDATE ${table} SET id=id`),/immutable/);}
});
test('integrity checker detects quantity or ledger discrepancies',t=>{
 const {e,admin,stock}=fixture(t);stock();assert.equal(e.integrity(admin).ok,true);e.run('UPDATE stocks SET qty=qty+1 WHERE product_id=1 AND warehouse_id=1');assert.equal(e.integrity(admin).ok,false);assert.equal(e.integrity(admin).problems[0].type,'stock_ledger');
});
test('yellow print uses stored customer snapshot and safely escapes HTML',t=>{
 const {e,admin,customer,doc}=fixture(t);e.savePartner(admin,{...customer,name:'客戶 <script>alert(1)</script>'});const d=doc('quote');e.savePartner(admin,{...e.partner(admin,customer.id),name:'後來的新名稱'});
 const html=printDocument(e.doc(admin,d.id),e.settings(),'a5');assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>alert/);assert.doesNotMatch(html,/後來的新名稱/);assert.match(html,/草稿／尚未核准/);assert.match(html,/A5 landscape/);assert.match(html,/非統一發票/);
});
test('seeded demo supports all ledger checks without a real company database',t=>{
 const e=new ERP();t.after(()=>e.close());const u=seedDemo(e);assert.equal(e.bootstrap(u).documents.length,7);assert.equal(e.integrity(u).ok,true);assert.equal(seedDemo(e).id,u.id);
});
