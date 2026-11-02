import test from 'node:test';
import assert from 'node:assert/strict';
import { ERP,today } from '../src/core.mjs';
import { FulfilmentBatches } from '../src/fulfilment-batches.mjs';
import { MonthlyBilling } from '../src/billing.mjs';
import { Finance } from '../src/finance.mjs';
import { Trade } from '../src/trade.mjs';
import { Operations } from '../src/operations.mjs';
import { rebuildPreview } from '../src/rebuild.mjs';

function fixture(t, batch = false) {
  const e = new ERP(); t.after(()=>e.close());
  const u = e.setup({username:'admin',password:'workflow-tests-2026'});
  const p = e.saveProduct(u,{sku:'P',name:'測試商品',barcode:'BAR',price:'100',cost:'40'});
  const c = e.savePartner(u,{code:'C',name:'測試客戶',billing_policy:batch?'batch':'individual',payment_mode:'cutoff',closing_day:Number(today().slice(-2))});
  const v = e.savePartner(u,{code:'V',name:'測試供應商',kind:'supplier',billing_policy:batch?'batch':'individual',payment_mode:'cutoff',closing_day:Number(today().slice(-2))});
  const docs = (kind='order',partner_id=kind==='order'?c.id:v.id,extra={}) => [2,3].map(qty=>{
    const d=e.saveDoc(u,{kind,partner_id,warehouse_id:1,lines:[{product_id:p.id,qty:String(qty),price:'10.01'}],...extra});
    e.transition(u,d.id,'submit');return e.transition(u,d.id,'approve');
  });
  const stock = ()=>e.adjust(u,{product_id:p.id,warehouse_id:1,qty:'100',unit_cost:'40',reason:'測試期初'});
  const combine = new FulfilmentBatches(e), billing=new MonthlyBilling(e),finance=new Finance(e);
  const request = ds=>({documents:ds.map(d=>({document_id:d.id,version:d.version}))});
  const check=()=>assert.deepEqual(e.integrity(u).problems,[]);
  const closeRequest=(kind='receivable',partner_id=c.id)=>{
    const b={kind,partner_id,account_period:today().slice(0,7)},preview=billing.pending(u,b);
    return {...b,date:today(),items:preview.rows.map(r=>({id:r.id,amount:r.amount}))};
  };
  return {e,u,p,c,v,docs,stock,combine,billing,finance,request,check,closeRequest};
}

test('combined shipments retain every order line, partial quantities, immutable snapshots and printable trace',t=>{
  const {e,u,p,docs,stock,combine,request,check}=fixture(t);stock();const ds=docs();
  const b=request(ds);b.documents[0].lines=[{line_id:ds[0].lines[0].id,qty:'0.5'}];
  const result=combine.create(u,b);
  assert.equal(result.sources.length,2);assert.equal(result.lines.length,2);
  assert.equal(result.lines[0].qty,500);assert.equal(e.doc(u,ds[0].id).status,'partial');
  assert.equal(e.stock(p.id,1).qty,96500);assert.equal(e.stock(p.id,1).reserved,1500);
  const html=combine.print(u,result.id);for(const d of ds)assert.ok(html.includes(d.no));
  assert.ok(html.includes(result.no));assert.throws(()=>e.run('DELETE FROM fulfilment_batches'),/immutable/);
  e.returnGoods(u,{fulfilment_id:result.sources[0].id,reason:'退回本次半個',lines:[{line_id:result.lines[0].id,qty:'0.5'}]});
  assert.equal(combine.get(u,result.id).lines[0].returned_qty,500);check();
});
test('combined receipts keep source tax, unit conversion and purchase costs hidden from warehouse users',t=>{
  const {e,u,p,docs,combine,request,check}=fixture(t),trade=new Trade(e);
  const unit=trade.saveUnit(u,{product_id:p.id,name:'箱',ratio:'12',price:'120',cost:'40'});
  const ds=docs('purchase',undefined,{lines:[{product_id:p.id,unit_id:unit.id,qty:'1',price:'40',tax_mode:'inclusive'}]});
  const result=combine.create({...u,role:'warehouse'},request(ds));
  assert.equal(result.total,undefined);assert.equal(result.sources[0].total,undefined);
  assert.equal(result.lines[0].amount,undefined);assert.equal(result.lines[0].cost,undefined);
  assert.equal(e.stock(p.id,1).qty,24000);assert.equal(combine.get(u,result.id).total,8000);
  assert.doesNotMatch(combine.print({...u,role:'warehouse'},result.id),/未稅|合計 TWD/);check();
});
test('combined posting rolls every earlier source back on a later overdelivery or stale version',t=>{
  const {e,u,p,docs,stock,combine,request,check}=fixture(t);stock();const ds=docs(),before=e.stock(p.id,1);
  const b=request(ds);b.documents[1].lines=[{line_id:ds[1].lines[0].id,qty:'99'}];
  assert.throws(()=>combine.create(u,b),/超過/);
  assert.deepEqual(e.stock(p.id,1),before);assert.equal(e.get('SELECT count(*) n FROM fulfilments').n,0);
  assert.equal(e.get('SELECT count(*) n FROM fulfilment_batches').n,0);
  assert.equal(e.doc(u,ds[0].id).version,ds[0].version);
  const stale=request(ds);stale.documents[1].version--;
  assert.throws(()=>combine.create(u,stale),/已更新/);check();
});
test('combined posting rejects mixed counterparties, duplicate sources, mismatched addresses, active picks and unauthorized roles',t=>{
  const {e,u,docs,stock,combine,request}=fixture(t);stock();const ds=docs();
  assert.throws(()=>combine.create(u,request([ds[0],ds[0]])),/重複/);
  const other=e.savePartner(u,{code:'OTHER',name:'另一客戶'}),od=docs('order',other.id);
  assert.throws(()=>combine.create(u,request([ds[0],od[0]])),/同一/);
  const addressed=docs('order',undefined,{shipping_address:'另一送貨地址'});
  assert.throws(()=>combine.create(u,request([ds[0],addressed[0]])),/地址/);
  new Operations(e).createPick(u,{warehouse_id:1,document_ids:[ds[0].id]});
  assert.throws(()=>combine.create(u,request(ds)),/揀貨/);
  for(const role of ['sales','finance','viewer'])assert.throws(()=>combine.create({...u,role},request(ds)),/權限/);
});
test('batch customers defer AR until a single monthly bill transfers the exact balance once',t=>{
  const {e,u,docs,stock,combine,billing,request,closeRequest,check}=fixture(t,true);stock();combine.create(u,request(docs()));
  const balance=code=>e.get('SELECT COALESCE(sum(debit-credit),0) n FROM journal_lines WHERE account=?',code).n;
  const total=e.get('SELECT sum(total) n FROM fulfilments').n;
  assert.equal(balance('1100'),0);assert.equal(balance('1110'),total);
  assert.equal(e.bootstrap(u).open_items.length,0);
  const b=closeRequest(),result=billing.close(u,b);
  assert.equal(result.lines.length,2);assert.equal(result.amount_snapshot,total);
  assert.equal(balance('1100'),total);assert.equal(balance('1110'),0);
  assert.throws(()=>billing.close(u,b),/已完成|沒有待/);
  assert.equal(e.get('SELECT count(*) n FROM billing_batches').n,1);
  for(const line of result.lines)assert.ok(billing.print(u,result.id).includes(line.source_no));check();
});
test('pending bills reject payments, funds and cheque allocation; source policy is frozen on each posting',t=>{
  const {e,u,c,docs,stock,billing,finance,closeRequest,check}=fixture(t,true);stock();
  e.fulfil(u,docs()[0].id,{});const o=e.get('SELECT * FROM open_items');
  assert.throws(()=>e.pay(u,{open_item_id:o.id,amount:'1'}),/尚未月結/);
  assert.throws(()=>finance.allocations({kind:'receivable',partner_id:c.id,lines:[{open_item_id:o.id,amount:'1'}]}),/尚未月結/);
  assert.throws(()=>finance.allowance(u,{open_item_id:o.id,amount:'1',reason:'尚未立帳'}),/尚未月結/);
  e.savePartner(u,{...c,billing_policy:'individual',credit_limit:'0'});
  assert.equal(e.get('SELECT billing_state FROM open_items').billing_state,'pending');
  billing.close(u,closeRequest());check();
});
test('monthly preview detects changed source amounts and rejects premature, future and unauthorized closing',t=>{
  const {e,u,docs,stock,billing,closeRequest}=fixture(t,true);stock();const f=e.fulfil(u,docs()[0].id,{}),b=closeRequest();
  e.returnGoods(u,{fulfilment_id:f.id,reason:'退回一個',lines:[{line_id:e.fulfilment(u,f.id).lines[0].id,qty:'1'}]});
  assert.throws(()=>billing.close(u,b),/異動/);assert.equal(e.get('SELECT count(*) n FROM billing_batches').n,0);
  for(const role of ['sales','warehouse','viewer'])assert.throws(()=>billing.close({...u,role},closeRequest()),/權限/);
  const early=closeRequest();early.date='2000-01-01';assert.throws(()=>billing.close(u,early),/截止日/);
  const future=closeRequest();future.date='2099-01-01';assert.throws(()=>billing.close(u,future),/晚於今天/);
});
test('returns before monthly billing reverse pending AR; later returns and partial monthly payments reconcile the posted account',t=>{
  const {e,u,docs,stock,billing,finance,closeRequest,check}=fixture(t,true);stock();const ds=docs(),f=e.fulfil(u,ds[0].id,{});
  e.fulfil(u,ds[1].id,{});
  const line=e.fulfilment(u,f.id).lines[0];
  e.returnGoods(u,{fulfilment_id:f.id,reason:'立帳前退一個',lines:[{line_id:line.id,qty:'1'}]});check();
  const bill=billing.close(u,closeRequest());
  const bank=finance.saveBank(u,{code:'BANK',name:'收款銀行',kind:'bank'});
  const paid=billing.pay(u,bill.id,{bank_account_id:bank.id,amount:'1.00',date:today()});assert.equal(paid.paid,100);check();
  e.returnGoods(u,{fulfilment_id:f.id,reason:'立帳後退一個',lines:[{line_id:line.id,qty:'1'}],allow_credit:true});check();
  const remaining=billing.get(u,bill.id).outstanding;
  billing.pay(u,bill.id,{bank_account_id:bank.id,amount:String(remaining/100),date:today()});
  assert.equal(billing.get(u,bill.id).outstanding,0);assert.equal(rebuildPreview(e,u).changes.length,0);check();
});
test('batch supplier receipts transfer pending AP at closing and pay the combined balance without duplicate expenses',t=>{
  const {e,u,v,docs,billing,finance,closeRequest,check}=fixture(t,true);
  for(const d of docs('purchase'))e.fulfil(u,d.id,{});
  const before=e.get("SELECT COALESCE(sum(debit-credit),0) n FROM journal_lines WHERE account='2005'").n;
  assert.ok(before<0);const bill=billing.close(u,closeRequest('payable',v.id));
  const bank=finance.saveBank(u,{code:'BANK',name:'付款銀行',kind:'bank'});
  billing.pay(u,bill.id,{bank_account_id:bank.id,amount:String(bill.outstanding/100),date:today()});
  assert.equal(billing.get(u,bill.id).outstanding,0);check();
});
