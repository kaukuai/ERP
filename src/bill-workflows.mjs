import { permit,has,fail,integer,scaled,txt,dateValue,today,now } from './core.mjs';
import { Finance } from './finance.mjs';

export class BillWorkflows {
  constructor(e){this.e=e;this.finance=new Finance(e);}
  restrictions(u,b){
    permit(u,'finance');return this.e.tx(()=>{
      const e=this.e,bill=e.get('SELECT * FROM bills WHERE id=?',integer(b.bill_id,1));if(!bill)fail('票據不存在',404);
      if(!['received','issued'].includes(bill.status)||e.get('SELECT id FROM endorsements WHERE bill_id=? LIMIT 1',bill.id))fail('票據已流轉，不能修改抬頭或轉讓限制',409);
      const payee=txt(b.named_payee,100,true),crossed=b.crossed===true?1:0,nontransferable=b.nontransferable===true?1:0;
      e.run('UPDATE bills SET named_payee=?,crossed=?,nontransferable=? WHERE id=?',payee,crossed,nontransferable,bill.id);
      e.run('INSERT INTO bill_events(bill_id,action,date,notes,created_by,created_at) VALUES(?,?,?,?,?,?)',bill.id,'restrictions',today(),JSON.stringify({payee,crossed,nontransferable}),u.id,now());
      e.log(u,'bill_restrictions','bill',bill.id,{payee,crossed,nontransferable});return {id:bill.id};
    });
  }
  endorse(u,b){
    permit(u,'finance');return this.e.tx(()=>{
      const e=this.e,bill=e.get('SELECT * FROM bills WHERE id=?',integer(b.bill_id,1));
      if(!bill||bill.kind!=='receivable'||bill.status!=='received'||bill.nontransferable)fail('僅可背書未託收且允許轉讓的應收票據',409);
      const rows=this.finance.allocations({...b,kind:'payable'}),amount=rows.reduce((n,r)=>n+r.allocation,0),date=dateValue(b.date),reason=txt(b.reason,1000,true);e.checkPeriod(date);
      if(amount!==bill.amount)fail('背書分配合計必須等於票面金額');
      const last=e.get('SELECT max(date) date FROM bill_events WHERE bill_id=?',bill.id);if(date<last.date||date>today())fail('背書日期不得早於前次事件或晚於今天');
      const no=e.number('EN'),id=Number(e.run('INSERT INTO endorsements(no,bill_id,partner_id,date,reason,created_by) VALUES(?,?,?,?,?,?)',no,bill.id,integer(b.partner_id,1),date,reason,u.id).lastInsertRowid);
      for(const row of rows){e.run('INSERT INTO endorsement_allocations VALUES(?,?,?)',id,row.id,row.allocation);e.run('UPDATE open_items SET paid=paid+? WHERE id=?',row.allocation,row.id);}
      e.journal(u,'應收票據背書抵付 '+reason,no,[['2000',amount,0],['1105',0,amount]],date);
      e.run("UPDATE bills SET status='endorsed' WHERE id=?",bill.id);this.event(u,bill.id,'endorse',date,{endorsement_id:id,from:e.settings().company,to:rows[0].partner_id,reason});
      return {id,no,bill_id:bill.id};
    });
  }
  event(u,bill,action,date,detail){this.e.run('INSERT INTO bill_events(bill_id,action,date,notes,created_by,created_at) VALUES(?,?,?,?,?,?)',bill,action,date,JSON.stringify(detail),u.id,now());this.e.log(u,action,'bill',bill,detail);}
  endorsementAction(u,id,b){
    permit(u,'finance');return this.e.tx(()=>{
      const e=this.e,en=e.get('SELECT * FROM endorsements WHERE id=?',integer(id,1));if(!en||en.status!=='active')fail('背書紀錄不存在或已結束',409);
      const bill=e.get('SELECT * FROM bills WHERE id=?',en.bill_id),date=dateValue(b.date),reason=txt(b.reason,1000,true);e.checkPeriod(date);
      if(bill.status!=='endorsed'||date<en.date||date>today())fail('票據狀態或日期錯誤',409);
      const no=e.number('ENE');let state;
      if(b.action==='clear'){
        if(date<bill.due_date)fail('不可在到期日前記錄背書票據兌現');
        state='cleared';e.run("UPDATE bills SET status='endorsed_cleared' WHERE id=?",bill.id);
        // The recipient receives funds. This company's bank is never touched.
      }else if(['return','bounce'].includes(b.action)){
        for(const row of e.all('SELECT * FROM endorsement_allocations WHERE endorsement_id=?',en.id)){
          const o=this.finance.item(row.open_item_id);if(o.paid<row.amount)fail('供應商帳款沖帳餘額不符',409);
          e.run('UPDATE open_items SET paid=paid-? WHERE id=?',row.amount,o.id);
        }
        e.journal(u,'背書票據退回 '+reason,no,[['1105',bill.amount,0],['2000',0,bill.amount]],date);
        e.run("UPDATE bills SET status='received' WHERE id=?",bill.id);state='returned';
        if(b.action==='bounce'){
          this.finance.billAction(u,{bill_id:bill.id,action:'bounce',date,notes:reason});state='bounced';
        }
      }else fail('背書操作錯誤');
      e.run('UPDATE endorsements SET status=? WHERE id=?',state,en.id);this.event(u,bill.id,'endorsement_'+b.action,date,{endorsement_id:en.id,reason});return {id:en.id,no,status:state};
    });
  }
  nontrade(u,b){
    permit(u,'finance');return this.e.tx(()=>{
      const e=this.e,kind=b.kind;if(!['receivable','payable'].includes(kind))fail('票據方向錯誤');
      const bank=this.finance.bank(b.bank_account_id);if(bank.kind!=='bank')fail('票據需選擇銀行帳戶');
      const number=txt(b.bill_number,80,true);
      if(e.get('SELECT id FROM bills WHERE kind=? AND bill_number=?',kind,number))fail('票號已被交易票據使用',409);
      const employee=b.employee_id?e.get('SELECT * FROM employees WHERE id=?',integer(b.employee_id,1)):null;if(b.employee_id&&!employee)fail('員工不存在');
      const amount=scaled(b.amount,2,1),date=dateValue(b.date),due=dateValue(b.due_date),reason=txt(b.reason,2000,true);e.checkPeriod(date);if(due<date)fail('到期日不得早於登錄日');
      let account=kind==='receivable'?'4900':'5200',expense=null;
      if(b.expense_id){
        if(kind!=='payable')fail('費用票據需為應付方向');expense=e.get('SELECT * FROM expenses WHERE id=?',integer(b.expense_id,1));
        if(!expense||expense.total-expense.paid<amount)fail('費用未結金額不足',409);account='2500';
      }
      const no=e.number('NTB'),id=Number(e.run('INSERT INTO nontrade_bills(no,bill_number,kind,party_name,employee_id,bank_account_id,account_code,expense_id,amount,date,due_date,status,reason,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',no,number,kind,txt(b.party_name||employee?.name,100,true),employee?.id??null,bank.id,account,expense?.id??null,amount,date,due,kind==='receivable'?'received':'issued',reason,u.id).lastInsertRowid);
      if(expense)e.run('UPDATE expenses SET paid=paid+? WHERE id=?',amount,expense.id);
      e.journal(u,'非帳款對象票據 '+reason,no,kind==='receivable'?[['1105',amount,0],[account,0,amount]]:[[account,amount,0],['2010',0,amount]],date);
      this.nontradeEvent(u,id,'register',date,reason);return {id,no};
    });
  }
  nontradeEvent(u,id,action,date,reason){this.e.run('INSERT INTO nontrade_bill_events(bill_id,action,date,reason,created_by) VALUES(?,?,?,?,?)',id,action,date,reason,u.id);this.e.log(u,action,'nontrade_bill',id,{date,reason});}
  nontradeAction(u,id,b){
    permit(u,'finance');return this.e.tx(()=>{
      const e=this.e,bill=e.get('SELECT * FROM nontrade_bills WHERE id=?',integer(id,1));if(!bill)fail('票據不存在',404);
      const date=dateValue(b.date),reason=txt(b.reason,1000,true),bank=this.finance.bank(bill.bank_account_id),no=e.number('NTBE');e.checkPeriod(date);
      const last=e.get('SELECT max(date) date FROM nontrade_bill_events WHERE bill_id=?',bill.id);if(date<last.date)fail('事件日期不得早於前次事件');
      const receivable=bill.kind==='receivable';let status;
      if(b.action==='deposit'&&receivable&&bill.status==='received')status='deposited';
      else if(b.action==='deliver'&&!receivable&&bill.status==='issued')status='delivered';
      else if(b.action==='clear'&&bill.status===(receivable?'deposited':'delivered')){
        if(date<bill.due_date)fail('不可提前兌現');if(!receivable)this.finance.cashCheck(bank,bill.amount);
        e.journal(u,'非帳款票據兌現',no,receivable?[[bank.gl_code,bill.amount,0],['1105',0,bill.amount]]:[['2010',bill.amount,0],[bank.gl_code,0,bill.amount]],date);status='cleared';
      }else if(['cancel','bounce'].includes(b.action)&&['received','deposited','issued','delivered'].includes(bill.status)){
        if(bill.expense_id){const x=e.get('SELECT * FROM expenses WHERE id=?',bill.expense_id);if(x.paid<bill.amount)fail('費用已沖餘額不符',409);e.run('UPDATE expenses SET paid=paid-? WHERE id=?',bill.amount,x.id);}
        e.journal(u,'非帳款票據撤銷 '+reason,no,receivable?[[bill.account_code,bill.amount,0],['1105',0,bill.amount]]:[['2010',bill.amount,0],[bill.account_code,0,bill.amount]],date);status=b.action==='cancel'?'cancelled':'bounced';
      }else fail('票據狀態不允許此操作',409);
      e.run('UPDATE nontrade_bills SET status=? WHERE id=?',status,bill.id);this.nontradeEvent(u,bill.id,b.action,date,reason);return {id:bill.id,no,status};
    });
  }
  data(u){if(!has(u,'finance'))return {};return {endorsements:this.e.all('SELECT en.*,b.no bill_no,b.bill_number,p.name partner_name FROM endorsements en JOIN bills b ON b.id=en.bill_id JOIN partners p ON p.id=en.partner_id ORDER BY en.id DESC'),nontrade_bills:this.e.all('SELECT * FROM nontrade_bills ORDER BY id DESC'),nontrade_bill_events:this.e.all('SELECT * FROM nontrade_bill_events ORDER BY id DESC LIMIT 1000')};}
}
