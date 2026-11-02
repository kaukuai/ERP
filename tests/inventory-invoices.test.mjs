import test from 'node:test';
import assert from 'node:assert/strict';
import { ERP,today } from '../src/core.mjs';
import { InventoryTracking } from '../src/inventory-tracking.mjs';
import { InvoiceWorkflows } from '../src/invoice-workflows.mjs';

function fixture(t,mode='lot'){
  const e=new ERP();t.after(()=>e.close());const u=e.setup({username:'admin',password:'inventory-invoice-test-2026'}),p=e.saveProduct(u,{sku:'P',name:'追蹤商品',price:'100',cost:'40'}),c=e.savePartner(u,{code:'C',name:'客戶'}),v=e.savePartner(u,{code:'V',name:'供應商',kind:'supplier'}),tracking=new InventoryTracking(e),invoices=new InvoiceWorkflows(e);
  tracking.configure(u,{product_id:p.id,version:p.version,tracking_mode:mode});
  const document=(kind='order',qty='1')=>{const d=e.saveDoc(u,{kind,partner_id:kind==='order'?c.id:v.id,warehouse_id:1,lines:[{product_id:p.id,qty,price:'100'}]});e.transition(u,d.id,'submit');return e.transition(u,d.id,'approve');};
  const add=(code,qty='1',expiry='')=>e.adjust(u,{product_id:p.id,warehouse_id:1,qty,unit_cost:'40',reason:'批號期初',lots:[{product_id:p.id,code,qty,expiry}]});
  return {e,u,p,c,v,tracking,invoices,document,add,check:()=>assert.deepEqual(e.integrity(u).problems,[])};
}
test('FEFO shipping skips expired lots, chooses the earliest valid expiry and returns only original lots',t=>{
  const {e,u,p,document,add,tracking,check}=fixture(t);add('EXPIRED','1','2020-01-01');add('LATER','1','2090-01-01');add('EARLY','1','2080-01-01');
  const d=document(),f=e.fulfil(u,d.id,{}),move=e.get('SELECT * FROM lot_moves WHERE reference=?',f.no),lot=tracking.trace(u,move.lot_id);
  assert.equal(lot.code,'EARLY');assert.equal(lot.qty,0);assert.equal(e.stock(p.id,1).qty,2000);
  const line=e.fulfilment(u,f.id).lines[0],b={fulfilment_id:f.id,reason:'原批號退回',lines:[{line_id:line.id,qty:'1'}]};
  assert.throws(()=>e.returnGoods(u,{...b,lots:[{product_id:p.id,code:'WRONG',qty:'1'}]}),/不屬於/);
  e.returnGoods(u,b);assert.equal(tracking.trace(u,move.lot_id).qty,1000);check();
});
test('tracked receipt requires exact lot allocations, explicit shipping is enforced and transfers preserve the same lot',t=>{
  const {e,u,p,document,tracking,check}=fixture(t),d=document('purchase','2');
  assert.throws(()=>e.fulfil(u,d.id,{}),/批號/);assert.equal(e.get('SELECT count(*) n FROM fulfilments').n,0);
  e.fulfil(u,d.id,{lots:[{product_id:p.id,code:'BATCH',qty:'2',expiry:'2090-01-01'}]});
  const w=e.saveWarehouse(u,{code:'WH2',name:'第二倉'});e.transfer(u,{product_id:p.id,from_id:1,to_id:w.id,qty:'1'});
  const lot=e.get('SELECT * FROM inventory_lots WHERE warehouse_id=?',w.id);assert.equal(lot.code,'BATCH');assert.equal(lot.expiry,'2090-01-01');assert.equal(tracking.trace(u,lot.id).moves.length,3);
  const sale=document();assert.throws(()=>e.fulfil(u,sale.id,{lots:[{product_id:p.id,code:'UNKNOWN',qty:'1'}]}),/不足/);check();
});
test('serial numbers are unique across warehouses, represent exactly one unit and cannot bypass the stock ledger',t=>{
  const {e,u,p,add,tracking,check}=fixture(t,'serial');
  assert.throws(()=>add('SERIAL','2'),/必須為 1/);add('SERIAL');assert.throws(()=>add('SERIAL'),/已在其他庫存/);
  const w=e.saveWarehouse(u,{code:'W2',name:'另一倉'});e.transfer(u,{product_id:p.id,from_id:1,to_id:w.id,qty:'1'});
  assert.equal(e.get("SELECT qty FROM inventory_lots WHERE warehouse_id=? AND code='SERIAL'",w.id).qty,1000);
  assert.throws(()=>tracking.configure(u,{product_id:p.id,version:e.product(p.id).version,tracking_mode:'none'}),/歷史/);
  assert.throws(()=>e.run('DELETE FROM lot_moves'),/immutable/);check();
});
test('expired lots can be explicitly written off without making them eligible for a shipment',t=>{
  const {e,u,p,add,document,check}=fixture(t);add('EXPIRED','1','2020-01-01');const d=document();assert.throws(()=>e.fulfil(u,d.id,{}),/效期已過/);
  e.transition(u,d.id,'cancel',{reason:'過期無法出貨'});e.adjust(u,{product_id:p.id,warehouse_id:1,qty:'-1',reason:'過期報廢',lots:[{product_id:p.id,code:'EXPIRED',qty:'1'}]});assert.equal(e.stock(p.id,1).qty,0);check();
});
test('invoice range import rejects overlaps atomically and blank-number reporting preserves reserved and void numbers',t=>{
  const {u,invoices}=fixture(t),r={year:2026,start_month:11,letters:'AB',start_no:1,end_no:10};
  const id=invoices.addRanges(u,r).ids[0];
  assert.throws(()=>invoices.addRanges(u,{rows:[{...r,letters:'CD'},{...r,start_no:5,end_no:15}]}),/重疊/);
  invoices.numberAction(u,{range_id:id,number:2,action:'reserve',reason:'測試保留'});
  invoices.numberAction(u,{range_id:id,number:4,action:'void',reason:'空白號碼作廢'});
  const report=invoices.blanks(u,id);assert.equal(report.unused_count,8);assert.deepEqual(report.blanks,[{from:1,to:1},{from:3,to:3},{from:5,to:10}]);
  assert.throws(()=>invoices.numberAction(u,{range_id:id,number:4,action:'reserve',reason:'不得重用'}),/重複/);
});
test('invoice exchange verifies counts, exact amounts, range/period and duplicate numbers before committing',t=>{
  const {e,u,invoices}=fixture(t);invoices.addRanges(u,{year:2026,start_month:11,letters:'AB',start_no:1,end_no:10});
  const columns=Object.fromEntries(['invoice_no','date','buyer_tax_id','net','tax','total','provider_ref'].map(k=>[k,k])),profile=invoices.exchangeProfile(u,{name:'外部紀錄 CSV',spec_version:'公司設定測試格式 v1',columns,delimiter:','}),row={invoice_no:'AB00000001',date:'2026-11-02',buyer_tax_id:'12345678',net:'100',tax:'5',total:'105',provider_ref:'TEST-RECEIPT'};
  let p=invoices.preview(u,{profile_id:profile.id,rows:[row],expected_count:2,expected_total:'105'});assert.ok(p.errors.length);assert.throws(()=>invoices.commit(u,p.id),/修正/);
  p=invoices.preview(u,{profile_id:profile.id,rows:[row],expected_count:1,expected_total:'105'});assert.deepEqual(p.errors,[]);invoices.commit(u,p.id);
  assert.equal(e.get('SELECT count(*) n FROM invoice_records').n,1);assert.match(invoices.export(u,profile.id).content,/AB00000001/);
  assert.throws(()=>invoices.commit(u,p.id),/已匯入/);
  assert.throws(()=>invoices.numberAction(u,{range_id:1,number:1,action:'void',reason:'不可本地假作廢'}),/正式/);
  assert.ok(invoices.preview(u,{profile_id:profile.id,rows:[{...row,date:'2026-09-01'}],expected_count:1,expected_total:'105'}).errors.length);
});
test('invoice print settings provide paper/device/donation configuration with a clearly identified proof only',t=>{
  const {u,invoices}=fixture(t),profile=invoices.printProfile(u,{name:'收據機',paper:'receipt',width:80,height:200,device_name:'使用者設定的印表機',donation_code:'12345',footer:'測試'});
  const proof=invoices.proof(u,profile.id);assert.match(proof,/80mm 200mm/);assert.match(proof,/非正式憑證/);assert.match(proof,/12345/);
  assert.throws(()=>invoices.printProfile({...u,role:'finance'},{name:'不能修改'}),/權限/);
  assert.throws(()=>invoices.printProfile(u,{name:'不安全抬頭圖',paper:'a4',logo:'data:image/svg+xml;base64,PHN2Zz4='}),/PNG/);
});
