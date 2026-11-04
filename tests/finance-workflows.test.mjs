import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ERP,today } from '../src/core.mjs';
import { Trade } from '../src/trade.mjs';
import { Finance } from '../src/finance.mjs';
import { FinanceWorkflows } from '../src/finance-workflows.mjs';
import { BillWorkflows } from '../src/bill-workflows.mjs';
import { readCSV,readXLSX,excelDate } from '../src/tabular.mjs';
import { rebuildPreview } from '../src/rebuild.mjs';

function fixture(t){
  const e=new ERP();t.after(()=>e.close());const u=e.setup({username:'admin',password:'finance-workflow-test-2026'}),finance=new Finance(e),work=new FinanceWorkflows(e),bills=new BillWorkflows(e),trade=new Trade(e);
  const p=e.saveProduct(u,{sku:'P',name:'商品',price:'100',cost:'40'}),c=e.savePartner(u,{code:'C',name:'客戶'}),v=e.savePartner(u,{code:'V',name:'供應商',kind:'supplier'}),bank=finance.saveBank(u,{code:'BANK',name:'銀行',kind:'bank'});
  const fulfil=(kind='order',qty='1',price='100')=>{
    if(kind==='order')e.adjust(u,{product_id:p.id,warehouse_id:1,qty:'10',unit_cost:'40',reason:'測試期初'});
    const f=trade.direct(u,{kind,partner_id:kind==='order'?c.id:v.id,warehouse_id:1,lines:[{product_id:p.id,qty,price}]});
    return {...f,item:e.get('SELECT * FROM open_items WHERE fulfilment_id=?',f.id)};
  };
  const check=()=>{assert.deepEqual(e.integrity(u).problems,[]);assert.equal(rebuildPreview(e,u).changes.length,0);};
  return {e,u,finance,work,bills,p,c,v,bank,fulfil,check};
}
test('bad debt requires approval, recovers exact residuals without reopening AR and preserves source checks',t=>{
  const {e,u,work,fulfil,bank,check}=fixture(t),f=fulfil(),debt=work.proposeDebt(u,{open_item_id:f.item.id,amount:'30.03',tax:'1.43',reason:'經核准的測試呆帳',date:today()});
  assert.equal(e.get('SELECT paid FROM open_items WHERE id=?',f.item.id).paid,0);
  assert.throws(()=>work.debtAction({...u,role:'finance'},debt.id,{action:'approve',reason:'不可自行核准'}),/權限/);
  work.debtAction(u,debt.id,{action:'approve',date:today(),reason:'主管核准'});check();
  assert.throws(()=>work.debtAction(u,debt.id,{action:'approve',date:today(),reason:'重複核准'}),/已處理/);
  for(const amount of ['0.01','10.01','20.01'])work.debtAction(u,debt.id,{action:'recover',amount,bank_account_id:bank.id,date:today(),reason:'分次收回'});
  assert.equal(work.debt(debt.id).recovered,3003);assert.equal(e.get('SELECT paid FROM open_items WHERE id=?',f.item.id).paid,3003);
  assert.throws(()=>work.debtAction(u,debt.id,{action:'recover',amount:'0.01',bank_account_id:bank.id,date:today(),reason:'超額'}),/超過/);check();
});
test('unrecovered approved debt can be reversed; returns cannot create refunds from written-off receivables',t=>{
  const {e,u,work,fulfil,check}=fixture(t),f=fulfil(),d=work.proposeDebt(u,{open_item_id:f.item.id,amount:'105',reason:'測試'});
  work.debtAction(u,d.id,{action:'approve',reason:'核准'});
  const body={fulfilment_id:f.id,reason:'退回',allow_credit:true,lines:[{line_id:e.fulfilment(u,f.id).lines[0].id,qty:'1'}]};
  assert.throws(()=>e.returnGoods(u,body),/呆帳/);
  work.debtAction(u,d.id,{action:'reverse',reason:'回復帳款'});e.returnGoods(u,body);assert.equal(e.get('SELECT amount FROM open_items').amount,0);check();
});
test('a rejected debt proposal leaves the receivable unchanged and releases its proposed tax adjustment',t=>{
  const {e,u,work,fulfil,check}=fixture(t),f=fulfil(),d=work.proposeDebt(u,{open_item_id:f.item.id,amount:'105',tax:'5',reason:'待審提案'});
  work.debtAction(u,d.id,{action:'reject',reason:'資料不足駁回'});
  assert.equal(work.debt(d.id).status,'rejected');assert.equal(e.get('SELECT paid FROM open_items WHERE id=?',f.item.id).paid,0);
  const next=work.proposeDebt(u,{open_item_id:f.item.id,amount:'105',tax:'5',reason:'補齊後重新提案'});assert.ok(next.id);
  assert.throws(()=>work.debtAction(u,d.id,{action:'approve',reason:'不能核准已駁回申請'}),/已處理/);check();
});
test('expense allocation conserves cents, capitalizes selected stock and rejects duplicate or stale inventory snapshots',t=>{
  const {e,u,p,finance,work,fulfil,check}=fixture(t),a=fulfil('purchase','1','40'),b=fulfil('purchase','2','40');
  const cat=finance.saveCategory(u,{code:'FREIGHT',name:'運費'}),expense=finance.expense(u,{category_id:cat.id,net:'10.01',tax:'0.50',purpose:'採購運費'});
  const body={expense_id:expense.id,basis:'quantity',lines:[a,b].map(f=>({fulfilment_line_id:e.fulfilment(u,f.id).lines[0].id,target:'inventory'}))};
  const preview=work.allocationPreview(u,body);assert.equal(preview.rows.reduce((n,r)=>n+r.allocation,0),1001);
  const before=e.stock(p.id,1).value,allocated=work.allocate(u,{...body,token:preview.token,reason:'按實際剩餘存貨核對',date:today()});
  const detail=work.allocation(u,allocated.id);assert.equal(detail.lines.reduce((n,l)=>n+l.amount,0),1001);assert.ok(detail.lines.every(l=>l.basis_snapshot.stock_qty===3000));assert.match(work.printAllocation(u,allocated.id),/費用分攤單/);
  assert.equal(e.stock(p.id,1).value,before+1001);assert.throws(()=>work.allocationPreview(u,body),/已分攤/);check();
  const other=finance.expense(u,{category_id:cat.id,net:'3',purpose:'第二筆運費'}),next={...body,expense_id:other.id},stale=work.allocationPreview(u,next);
  e.adjust(u,{product_id:p.id,warehouse_id:1,qty:'1',unit_cost:'40',reason:'預覽後異動'});
  assert.throws(()=>work.allocate(u,{...next,token:stale.token,reason:'過期快照'}),/已變更/);check();
});
test('Excel and CSV readers parse actual workbook values, quotes and date serials and reject corrupt archives',()=>{
  const bytes=readFileSync(new URL('./fixtures/bank-statement.xlsx',import.meta.url)),rows=readXLSX(bytes);
  assert.equal(rows.length,2);assert.equal(rows[0].external_id,'BANK-001');assert.equal(rows[1].amount,'-42.00');assert.match(excelDate(rows[0].date),/^2026-/);
  assert.deepEqual(readCSV('a,b\r\n"x,y","say ""hi"""\r\n'),[{a:'x,y',b:'say "hi"'}]);
  const corrupt=Buffer.from(bytes);corrupt[100]^=1;assert.throws(()=>readXLSX(corrupt),/損壞|校驗/);
  assert.throws(()=>readCSV('a,a\n1,2'),/重複/);
});
test('bank reconciliation matches exact references, supports explicit exception allocation and prevents duplicate posting',t=>{
  const {e,u,c,bank,fulfil,work,check}=fixture(t),f=fulfil(),columns={external_id:'id',date:'date',amount:'amount',partner_code:'partner',reference:'ref'};
  const preview=work.reconcilePreview(u,{bank_account_id:bank.id,columns,rows:[{id:'BANK-1',date:today(),amount:'100',partner:'C',ref:f.no}]});
  assert.equal(preview.rows[0].exception,'');
  const result=work.reconcileCommit(u,preview.id,{matches:[{index:0,lines:preview.rows[0].allocations}]});assert.equal(result.count,1);
  assert.equal(e.get('SELECT paid FROM open_items WHERE id=?',f.item.id).paid,10000);
  assert.throws(()=>work.reconcileCommit(u,preview.id,{matches:[]}),/已入帳/);
  const duplicate=work.reconcilePreview(u,{bank_account_id:bank.id,columns,rows:[{id:'BANK-1',date:today(),amount:'100',partner:'C',ref:f.no}]});assert.equal(duplicate.rows[0].valid,false);
  const manual=work.reconcilePreview(u,{bank_account_id:bank.id,columns,rows:[{id:'BANK-2',date:today(),amount:'5',partner:'UNKNOWN',ref:'UNKNOWN'}]});
  assert.ok(manual.rows[0].exception);work.reconcileCommit(u,manual.id,{matches:[{index:0,partner_id:c.id,lines:[{open_item_id:f.item.id,amount:'5'}]}]});check();
});
test('a later reconciliation mismatch rolls back earlier payment, deduplication entry and all bank movements',t=>{
  const {e,u,bank,fulfil,work,check}=fixture(t),f=fulfil(),columns=Object.fromEntries(['external_id','date','amount','partner_code','reference'].map(x=>[x,x]));
  const preview=work.reconcilePreview(u,{bank_account_id:bank.id,columns,rows:[1,2].map(i=>({external_id:'R'+i,date:today(),amount:'1',partner_code:'C',reference:f.no}))});
  assert.throws(()=>work.reconcileCommit(u,preview.id,{matches:[{index:0,lines:preview.rows[0].allocations},{index:1,lines:[{open_item_id:f.item.id,amount:'2'}]}]}),/不符/);
  assert.equal(e.get('SELECT count(*) n FROM payments').n,0);assert.equal(e.get('SELECT count(*) n FROM reconciled_entries').n,0);check();
});
test('endorsement settles supplier AP, preserves the ownership trail and handles bounce without touching the bank',t=>{
  const {e,u,c,v,bank,finance,bills,fulfil,check}=fixture(t),sale=fulfil(),purchase=fulfil('purchase');
  const bill=finance.registerBill(u,{kind:'receivable',partner_id:c.id,bank_account_id:bank.id,bill_number:'CHEQUE1',amount:'105',due_date:today(),lines:[{open_item_id:sale.item.id,amount:'105'}]});
  bills.restrictions(u,{bill_id:bill.id,named_payee:'測試公司',crossed:true,nontransferable:true});
  assert.throws(()=>bills.endorse(u,{bill_id:bill.id}),/允許轉讓/);
  bills.restrictions(u,{bill_id:bill.id,named_payee:'測試公司',crossed:true,nontransferable:false});
  const en=bills.endorse(u,{bill_id:bill.id,partner_id:v.id,lines:[{open_item_id:purchase.item.id,amount:'105'}],reason:'背書抵付採購'});check();
  assert.equal(e.get('SELECT paid FROM open_items WHERE id=?',purchase.item.id).paid,10500);
  assert.throws(()=>e.returnGoods(u,{fulfilment_id:purchase.id,reason:'未兌現不能退貨',lines:[{line_id:e.fulfilment(u,purchase.id).lines[0].id,qty:'1'}]}),/背書/);
  bills.endorsementAction(u,en.id,{action:'bounce',reason:'第三方退票'});
  assert.equal(e.get('SELECT paid FROM open_items WHERE id=?',purchase.item.id).paid,0);assert.equal(e.get('SELECT paid FROM open_items WHERE id=?',sale.item.id).paid,0);
  assert.equal(e.get("SELECT COALESCE(sum(debit-credit),0) n FROM journal_lines WHERE account=(SELECT gl_code FROM bank_accounts WHERE id=?)",bank.id).n,0);check();
});
test('nontrade employee reimbursement cheques restore expense on cancellation and update bank only on clearing',t=>{
  const {e,u,bank,finance,bills,check}=fixture(t),employee=finance.saveEmployee(u,{code:'E',name:'員工'}),category=finance.saveCategory(u,{code:'E',name:'代墊費用'}),expense=finance.expense(u,{category_id:category.id,net:'50',purpose:'員工代墊'});
  const body={kind:'payable',employee_id:employee.id,bank_account_id:bank.id,expense_id:expense.id,bill_number:'N1',amount:'50',due_date:today(),reason:'費用報銷'};
  const first=bills.nontrade(u,body);check();assert.equal(e.get('SELECT paid FROM expenses WHERE id=?',expense.id).paid,5000);
  bills.nontradeAction(u,first.id,{action:'cancel',reason:'更換票據'});assert.equal(e.get('SELECT paid FROM expenses WHERE id=?',expense.id).paid,0);check();
  const next=bills.nontrade(u,{...body,bill_number:'N2'});bills.nontradeAction(u,next.id,{action:'deliver',reason:'已交付'});bills.nontradeAction(u,next.id,{action:'clear',reason:'銀行已兌現'});check();
  assert.throws(()=>bills.nontradeAction(u,next.id,{action:'cancel',reason:'不得撤銷已兌現票'}),/狀態/);
});
