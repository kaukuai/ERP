import test from 'node:test';
import assert from 'node:assert/strict';
import { ERP,today } from '../src/core.mjs';
import { OrderWorkflows } from '../src/order-workflows.mjs';
import { SkuOrders } from '../src/sku-orders.mjs';
import { CustomReports } from '../src/custom-reports.mjs';

function fixture(t){
  const e=new ERP();t.after(()=>e.close());const u=e.setup({username:'admin',password:'order-workflow-test-2026'});
  const p=e.saveProduct(u,{sku:'P',name:'商品',price:'100',cost:'40'}),c=e.savePartner(u,{code:'C',name:'客戶'});
  e.adjust(u,{product_id:p.id,warehouse_id:1,qty:'100',unit_cost:'40',reason:'測試期初'});
  const doc=()=>e.saveDoc(u,{kind:'order',partner_id:c.id,warehouse_id:1,lines:[{product_id:p.id,qty:'6',price:'100'}]});
  const approve=d=>{e.transition(u,d.id,'submit');return e.transition(u,d.id,'approve');};
  return {e,u,p,c,doc,approve,orders:new OrderWorkflows(e),imports:new SkuOrders(e),reports:new CustomReports(e),check:()=>assert.deepEqual(e.integrity(u).problems,[])};
}
test('external order fields validate carrier/donation rules, optimistic versions, unique references and approval freeze',t=>{
  const {e,u,doc,approve,orders}=fixture(t),a=doc(),b=doc();
  const saved=orders.metadata(u,a.id,{version:a.version,platform:'shop',external_ref:'ORDER1',carrier_type:'mobile',carrier_id:'/ABC1234',buyer_tax_id:'12345678',tracking_no:'TRACK'});
  assert.equal(saved.version,a.version+1);assert.equal(orders.getMetadata(u,a.id).tracking_no,'TRACK');
  assert.throws(()=>orders.metadata(u,a.id,{version:a.version}),/更新/);
  assert.throws(()=>orders.metadata(u,b.id,{version:b.version,carrier_type:'mobile',carrier_id:'invalid'}),/格式/);
  assert.throws(()=>orders.metadata(u,b.id,{version:b.version,carrier_type:'mobile',carrier_id:'/ABC1234',donation_code:'123'}),/擇一/);
  assert.throws(()=>orders.metadata(u,b.id,{version:b.version,platform:'shop',external_ref:'ORDER1'}),/UNIQUE/);
  const approved=approve(e.doc(u,a.id));assert.throws(()=>orders.metadata(u,a.id,{version:approved.version}),/草稿/);
  assert.throws(()=>orders.metadata({...u,role:'viewer'},b.id,{version:b.version}),/權限/);
});
test('subscription schedules execute exact partial quantities, pause/resume, skip and preserve immutable history',t=>{
  const {e,u,p,doc,approve,orders,check}=fixture(t),d=approve(doc());
  const plan=orders.createPlan(u,{document_id:d.id,version:d.version,periods:[1,2,3].map(()=>({due_date:today(),lines:[{line_id:d.lines[0].id,qty:'2'}]}))});
  let next=orders.changePlan(u,plan.id,{version:plan.version,status:'paused',reason:'客戶要求'});
  assert.throws(()=>orders.execute(u,plan.periods[0].id,{version:1}),/暫停/);
  next=orders.changePlan(u,plan.id,{version:next.version,status:'active',reason:'恢復交貨'});
  orders.execute(u,plan.periods[0].id,{version:1});assert.equal(e.stock(p.id,1).qty,98000);
  assert.throws(()=>orders.execute(u,plan.periods[0].id,{version:1}),/更新|結束/);
  orders.changePeriod(u,plan.periods[1].id,{version:1,action:'skip',reason:'跳過一期'});
  orders.changePeriod(u,plan.periods[2].id,{version:1,action:'adjust',due_date:today(),reason:'改交剩餘量',lines:[{line_id:d.lines[0].id,qty:'4'}]});
  orders.execute(u,plan.periods[2].id,{version:2});assert.equal(e.doc(u,d.id).status,'completed');
  assert.equal(orders.plan(u,plan.id).events.length,7);assert.throws(()=>e.run('DELETE FROM subscription_events'),/immutable/);check();
});
test('subscription plans reject over-allocation, future execution and bypasses by unauthorized users',t=>{
  const {u,doc,approve,orders}=fixture(t),d=approve(doc());
  assert.throws(()=>orders.createPlan(u,{document_id:d.id,version:d.version,periods:[{due_date:today(),lines:[{line_id:d.lines[0].id,qty:'7'}]}]}),/超過/);
  const p=orders.createPlan(u,{document_id:d.id,version:d.version,periods:[{due_date:'2099-01-01',lines:[{line_id:d.lines[0].id,qty:'6'}]}]});
  assert.throws(()=>orders.execute(u,p.periods[0].id,{version:1}),/尚未到/);
  assert.throws(()=>orders.changePeriod(u,p.periods[0].id,{version:1,action:'adjust',reason:'超量',due_date:today(),lines:[{line_id:d.lines[0].id,qty:'6.001'}]}),/超過/);
  for(const role of ['sales','warehouse','viewer'])assert.throws(()=>orders.createPlan({...u,role},{}),/權限/);
});
function template(imports,u){return imports.saveTemplate(u,{name:'平台 A',namespace:'shopA',columns:{order_ref:'訂單',customer_code:'客戶',warehouse_code:'倉庫',sku:'商品',qty:'數量',price:'單價'}});}
const row=(ref,sku='EXT')=>({'訂單':ref,'客戶':'C','倉庫':'WH01','商品':sku,'數量':'1','單價':'100'});
test('order import groups exact mapped SKUs, keeps missing mappings in exception queue and prevents duplicate import',t=>{
  const {e,u,p,imports,check}=fixture(t),tpl=template(imports,u);
  let preview=imports.preview(u,{template_id:tpl.id,rows:[row('A')]});assert.equal(preview.errors.length,1);assert.throws(()=>imports.commit(u,preview.id),/修正/);
  const map=imports.saveMapping(u,{platform:'shopA',external_sku:'EXT',product_id:p.id});
  assert.throws(()=>imports.saveMapping(u,{platform:'shopA',external_sku:'ANOTHER',product_id:p.id}),/UNIQUE/);
  preview=imports.preview(u,{template_id:tpl.id,rows:[row('A'),row('B')]});assert.deepEqual(preview.errors,[]);
  assert.equal(JSON.stringify(preview).includes('cost'),false);
  const result=imports.commit(u,preview.id);assert.equal(result.count,2);
  assert.equal(e.get('SELECT count(*) n FROM order_import_sources').n,2);
  assert.equal(e.get('SELECT count(*) n FROM documents').n,2);
  assert.throws(()=>imports.commit(u,preview.id),/已執行/);
  assert.match(imports.preview(u,{template_id:tpl.id,rows:[row('A')]}).errors[0].message,/已匯入/);
  assert.throws(()=>e.run('DELETE FROM order_import_sources'),/immutable/);assert.ok(map.id);check();
});
test('import commit rejects changed mappings and master records and atomically rolls back all draft orders',t=>{
  const {e,u,p,imports}=fixture(t),tpl=template(imports,u),map=imports.saveMapping(u,{platform:'shopA',external_sku:'EXT',product_id:p.id});
  let preview=imports.preview(u,{template_id:tpl.id,rows:[row('A'),row('B')]});
  imports.saveMapping(u,{...map,external_sku:'NEW'});assert.throws(()=>imports.commit(u,preview.id),/異動/);
  assert.equal(e.get('SELECT count(*) n FROM documents').n,0);
  imports.saveMapping(u,{...imports.data(u).sku_mappings[0],external_sku:'EXT'});
  preview=imports.preview(u,{template_id:tpl.id,rows:[row('A'),row('B')]});
  e.saveProduct(u,{...p,price:'101',cost:'40'});assert.throws(()=>imports.commit(u,preview.id),/異動/);
  assert.equal(e.get('SELECT count(*) n FROM documents').n,0);
});
test('sales import and external metadata cannot read or create another salesperson customer orders',t=>{
  const {e,u,p,imports,doc,orders}=fixture(t);
  e.saveUser(u,{username:'sales',name:'業務',password:'sales-test-password-2026',role:'sales'});
  const sales=e.get("SELECT * FROM users WHERE username='sales'");
  const customer=e.get("SELECT * FROM partners WHERE code='C'");e.savePartner(u,{...customer,owner_id:u.id,credit_limit:'0'});
  imports.saveMapping(u,{platform:'shopA',external_sku:'EXT',product_id:p.id});const tpl=template(imports,u);
  const preview=imports.preview(sales,{template_id:tpl.id,rows:[row('A')]});assert.match(preview.errors[0].message,/自己負責/);
  const d=doc();assert.throws(()=>orders.getMetadata(sales,d.id),/本人|自己|存取/);
});
test('custom reports enforce separate view/print permissions, cost masking and safe column selection',t=>{
  const {u,reports}=fixture(t);
  const body={name:'庫存',dataset:'stocks',columns:[{key:'sku',label:'品號'},{key:'qty',label:'數量'}],view_roles:['admin','warehouse'],print_roles:['admin'],paper:'a4',orientation:'landscape'};
  const r=reports.save(u,body),warehouse={...u,role:'warehouse'};
  assert.equal(reports.run(warehouse,r.id).rows.length,1);
  assert.throws(()=>reports.print(warehouse,r.id,{}),/權限/);
  assert.throws(()=>reports.run({...u,role:'sales'},r.id),/權限/);
  assert.throws(()=>reports.save(u,{...body,name:'unsafe',columns:[{key:'password',label:'密碼'}]}),/不支援/);
  const cost=reports.save(u,{...body,name:'成本',columns:[{key:'value',label:'存貨金額'}]});assert.throws(()=>reports.run(warehouse,cost.id),/成本權限/);
  assert.match(reports.print(u,r.id,{}),/A4 landscape/);
  assert.throws(()=>reports.save(warehouse,body),/權限/);
});
