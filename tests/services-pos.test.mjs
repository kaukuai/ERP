import test from 'node:test';
import assert from 'node:assert/strict';
import { ERP,today,addDays } from '../src/core.mjs';
import { Finance } from '../src/finance.mjs';
import { ServiceWorkflows } from '../src/service-workflows.mjs';
import { POS } from '../src/pos.mjs';
import { rebuildPreview } from '../src/rebuild.mjs';

function fixture(t){
  const e=new ERP();t.after(()=>e.close());const u=e.setup({username:'admin',password:'services-pos-test-2026'}),finance=new Finance(e),services=new ServiceWorkflows(e),pos=new POS(e);
  const p=e.saveProduct(u,{sku:'P',name:'實體商品',barcode:'BARCODE',price:'100',cost:'40'}),service=e.saveProduct(u,{sku:'S',name:'維修／租金服務',unit:'次',track_stock:false,price:'100',cost:'0'}),c=e.savePartner(u,{code:'C',name:'客戶'});
  e.adjust(u,{product_id:p.id,warehouse_id:1,qty:'100',unit_cost:'40',reason:'測試期初'});
  const cash=finance.saveBank(u,{code:'CASH',name:'現金',kind:'cash',opening_balance:'1000'}),bank=finance.saveBank(u,{code:'BANK',name:'銀行',kind:'bank'});
  const check=()=>{assert.deepEqual(e.integrity(u).problems,[]);assert.equal(rebuildPreview(e,u).changes.length,0);};
  const store=()=>pos.saveStore(u,{code:'SHOP',name:'測試門市',warehouse_id:1,customer_id:c.id,cash_account_id:cash.id,bank_account_id:bank.id,scanner_mode:'keyboard',receipt_width:80,payment_provider:'external_terminal',user_ids:[]});
  return {e,u,finance,services,pos,p,service,c,cash,bank,check,store};
}
test('repair ticket progresses through diagnosis, approval, parts, return and one traceable service invoice',t=>{
  const {e,u,p,c,service,services,check}=fixture(t);let r=services.createRepair(u,{partner_id:c.id,product_id:p.id,serial:'CUSTOMER-ASSET',description:'檢修客戶自有商品',warranty_until:'2090-01-01'});
  assert.equal(e.stock(p.id,1).qty,100000);
  r=services.repairAction(u,r.id,{version:r.version,status:'diagnosed',diagnosis:'更換耗材',fee:'100',service_product_id:service.id,reason:'公司確認的非保固收費'});
  r=services.repairAction(u,r.id,{version:r.version,status:'approved',reason:'客戶同意報價'});
  r=services.repairAction(u,r.id,{version:r.version,status:'repairing',reason:'開始維修'});
  r=services.repairPart(u,r.id,{version:r.version,product_id:p.id,warehouse_id:1,qty:'1',reason:'維修材料'});assert.equal(e.stock(p.id,1).qty,99000);
  assert.throws(()=>services.repairAction(u,r.id,{version:r.version,status:'cancelled',reason:'不能刪已領料維修'}),/狀態/);
  r=services.repairAction(u,r.id,{version:r.version,status:'ready',reason:'維修完成'});
  r=services.repairAction(u,r.id,{version:r.version,status:'returned',warehouse_id:1,reason:'客戶領回'});
  assert.ok(r.fulfilment_id);assert.equal(e.get('SELECT amount FROM open_items WHERE fulfilment_id=?',r.fulfilment_id).amount,10500);
  assert.throws(()=>services.repairAction(u,r.id,{version:r.version,status:'returned',reason:'重複領回'}),/狀態/);assert.match(services.print(u,'repairs',r.id),/CUSTOMER-ASSET/);check();
});
test('consignment keeps ownership at delivery, bills only reported sales and supports customer returns and unsold stock retrieval',t=>{
  const {e,u,p,c,services,check}=fixture(t);let contract=services.createContract(u,{kind:'consignment',partner_id:c.id,product_id:p.id,warehouse_id:1,qty:'5',price:'100',start_date:today(),end_date:addDays(today(),30)});
  assert.equal(e.get('SELECT count(*) n FROM open_items').n,0);assert.equal(e.stock(p.id,contract.holding_warehouse_id).qty,5000);check();
  contract=services.consignmentSale(u,contract.id,{version:contract.version,qty:'2'});assert.equal(contract.sold_qty,2000);
  const sale=e.get('SELECT * FROM consignment_sales WHERE contract_id=?',contract.id),line=e.fulfilment(u,sale.fulfilment_id).lines[0];
  e.returnGoods(u,{fulfilment_id:sale.fulfilment_id,reason:'寄售客戶退貨',lines:[{line_id:line.id,qty:'1'}]});
  contract=services.contract(u,contract.id);assert.equal(contract.sold_qty,1000);assert.equal(contract.status,'active');
  contract=services.returnContract(u,contract.id,{version:contract.version,qty:'4',reason:'退回未售商品'});assert.equal(contract.status,'closed');assert.equal(e.stock(p.id,contract.holding_warehouse_id).qty,0);check();
});
test('rental assets remain in inventory, started periods bill once and deposits require a separate actual refund',t=>{
  const {e,u,p,c,service,services,bank,finance,check}=fixture(t);let contract=services.createContract(u,{kind:'rental',partner_id:c.id,product_id:p.id,warehouse_id:1,qty:'2',price:'10',service_product_id:service.id,cycle_days:30,start_date:today(),end_date:addDays(today(),59),deposit:'100',bank_account_id:bank.id});
  assert.equal(contract.periods.length,2);assert.equal(e.get('SELECT count(*) n FROM open_items').n,0);check();
  assert.throws(()=>services.returnContract(u,contract.id,{version:contract.version,qty:'2',reason:'歸還'}),/確認/);
  contract=services.returnContract(u,contract.id,{version:contract.version,qty:'2',reason:'歸還資產',bill_started_periods:true});
  assert.equal(contract.status,'closed');assert.equal(contract.periods[0].status,'billed');assert.equal(contract.periods[1].status,'skipped');
  assert.equal(e.stock(p.id,1).qty,100000);assert.equal(e.get('SELECT refunded FROM funds WHERE id=?',contract.deposit_fund_id).refunded,0);
  finance.refund(u,{fund_id:contract.deposit_fund_id,bank_account_id:bank.id,amount:'100',notes:'實際退還押金'});
  assert.throws(()=>services.charge(u,contract.periods[0].id),/已計費/);check();
});
test('POS uses authoritative prices and promotions, takes split tenders and accrues cross-store member points',t=>{
  const {e,u,c,pos,p,store,check}=fixture(t),s=store();pos.shift(u,{store_id:s.id,action:'open',opening_cash:'1000'});
  const shift=e.get("SELECT id FROM pos_shifts WHERE closed_at=''"),member=pos.member(u,{code:'M1',name:'跨門市會員',partner_id:c.id});
  pos.promotion(u,{name:'限時九折',discount_bp:9000,product_id:p.id,start_date:today(),end_date:today()});
  const b={store_id:s.id,member_id:member.id,lines:[{barcode:'BARCODE',qty:'2',price:'0.01'}],redeem_points:0},q=pos.quote(u,b);assert.equal(q.net,18000);assert.equal(q.total,18900);
  const sale=pos.checkout(u,{...b,shift_id:shift.id,token:q.token,tenders:[{method:'cash',amount:'100',received:'200'},{method:'terminal',amount:'89',reference:'TEST-APPROVAL',confirmed:true}]});
  assert.equal(sale.total,18900);assert.equal(sale.tenders[0].received-sale.tenders[0].amount,10000);
  assert.equal(e.get('SELECT points FROM loyalty_members WHERE id=?',member.id).points,1);assert.equal(e.get('SELECT amount-paid outstanding FROM open_items WHERE fulfilment_id=?',sale.fulfilment_id).outstanding,0);
  assert.match(pos.receipt(u,sale.id),/非統一發票/);check();
});
test('POS rejects stale quotes, missing shifts, unconfirmed terminal results, incorrect totals and unauthorized stores atomically',t=>{
  const {e,u,pos,p,store,check}=fixture(t),s=store(),b={store_id:s.id,lines:[{product_id:p.id,qty:'1'}]},q=pos.quote(u,b);
  assert.throws(()=>pos.checkout(u,{...b,token:q.token,shift_id:1,tenders:[]}),/班別/);
  const shift=pos.shift(u,{store_id:s.id,action:'open',opening_cash:'0'});
  assert.throws(()=>pos.checkout(u,{...b,token:q.token,shift_id:shift.id,tenders:[{method:'terminal',amount:'105',reference:'REF'}]}),/確認付款/);
  assert.throws(()=>pos.checkout(u,{...b,token:q.token,shift_id:shift.id,tenders:[{method:'cash',amount:'1'}]}),/合計/);
  e.saveProduct(u,{...p,price:'101',cost:'40'});assert.throws(()=>pos.checkout(u,{...b,token:q.token,shift_id:shift.id,tenders:[{method:'cash',amount:'105'}]}),/已更新/);
  assert.throws(()=>pos.quote({...u,role:'sales'},b),/門市/);assert.equal(e.get('SELECT count(*) n FROM pos_sales').n,0);assert.equal(e.get('SELECT count(*) n FROM fulfilments').n,0);check();
});
test('POS refunds use the active refund shift, restore member points and cannot bypass the dedicated refund flow',t=>{
  const {e,u,c,pos,p,cash,store,check}=fixture(t),s=store(),shift=pos.shift(u,{store_id:s.id,action:'open',opening_cash:'1000'}),member=pos.member(u,{code:'M',name:'會員',partner_id:c.id});
  const b={store_id:s.id,member_id:member.id,lines:[{product_id:p.id,qty:'2'}]},q=pos.quote(u,b),sale=pos.checkout(u,{...b,token:q.token,shift_id:shift.id,tenders:[{method:'cash',amount:String(q.total/100)}]});
  const lines=sale.fulfilment.lines.map(l=>({line_id:l.id,qty:String(l.qty/1000)}));
  assert.throws(()=>e.returnGoods(u,{fulfilment_id:sale.fulfilment_id,lines,reason:'不得繞過 POS',allow_credit:true}),/POS/);
  pos.shift(u,{store_id:s.id,shift_id:shift.id,action:'close',counted_cash:'1210',reason:'現金核對'});
  const refundShift=pos.shift(u,{store_id:s.id,action:'open',opening_cash:'1210'});
  pos.refund(u,sale.id,{bank_account_id:cash.id,confirm_actual_refund:true,lines,reason:'實際退還現金'});
  assert.equal(e.get('SELECT points FROM loyalty_members WHERE id=?',member.id).points,0);
  assert.equal(e.get('SELECT shift_id FROM pos_refunds').shift_id,refundShift.id);
  const closed=pos.shift(u,{store_id:s.id,shift_id:refundShift.id,action:'close',counted_cash:'1000',reason:'退款班結帳'});assert.equal(closed.difference,0);check();
});
test('POS immediately settles a retail sale even if the walk-in customer is configured for monthly billing',t=>{
  const {e,u,c,pos,p,store,check}=fixture(t);e.savePartner(u,{...c,billing_policy:'batch',payment_mode:'month_end',credit_limit:'0'});
  const s=store(),shift=pos.shift(u,{store_id:s.id,action:'open',opening_cash:'0'}),b={store_id:s.id,lines:[{product_id:p.id,qty:'1'}]},q=pos.quote(u,b);
  pos.checkout(u,{...b,token:q.token,shift_id:shift.id,tenders:[{method:'cash',amount:'105'}]});assert.equal(e.get('SELECT billing_state FROM open_items').billing_state,'posted');assert.equal(e.partner(u,c.id).billing_policy,'batch');check();
});
test('an explicitly assigned cashier can serve a cross-store member without gaining ordinary office customer access',t=>{
  const {e,u,c,pos,p,cash,bank,check}=fixture(t);e.saveUser(u,{username:'cashier',name:'門市收銀員',role:'sales',password:'cashier-test-password-2026'});const cashier=e.get("SELECT id,username,name,role,active FROM users WHERE username='cashier'");
  e.savePartner(u,{...c,owner_id:u.id,credit_limit:'0'});
  const member=pos.member(u,{code:'CROSS',name:'跨店會員',partner_id:c.id}),s=pos.saveStore(u,{code:'S',name:'已授權門市',warehouse_id:1,customer_id:c.id,cash_account_id:cash.id,bank_account_id:bank.id,scanner_mode:'keyboard',payment_provider:'manual',user_ids:[cashier.id]});
  assert.throws(()=>e.partner(cashier,c.id),/自己負責/);
  const shift=pos.shift(cashier,{store_id:s.id,action:'open',opening_cash:'0'}),b={store_id:s.id,member_id:member.id,lines:[{product_id:p.id,qty:'1',price:'0.01'}]},q=pos.quote(cashier,b);
  const sale=pos.checkout(cashier,{...b,token:q.token,shift_id:shift.id,tenders:[{method:'cash',amount:'105'}]});assert.equal(sale.total,10500);
  assert.throws(()=>e.partner(cashier,c.id),/自己負責/);assert.equal(e.get('SELECT owner_id FROM documents WHERE id=(SELECT document_id FROM fulfilments WHERE id=?)',sale.fulfilment_id).owner_id,cashier.id);check();
});
