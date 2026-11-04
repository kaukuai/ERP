import { createHash } from 'node:crypto';
import { permit,has,fail,integer,scaled,ratio,txt,dateValue,today,now } from './core.mjs';
import { Finance } from './finance.mjs';
import { readCSV,readXLSX,excelDate } from './tabular.mjs';
import { printPage } from './operations.mjs';
import { escapeHTML as E } from './print.mjs';

export class FinanceWorkflows {
  constructor(e){this.e=e;this.finance=new Finance(e);}
  debt(id){const row=this.e.get('SELECT * FROM bad_debts WHERE id=?',integer(id,1));if(!row)fail('呆帳申請不存在',404);return row;}
  proposeDebt(u,b){
    permit(u,'finance');return this.e.tx(()=>{
      const e=this.e,o=this.finance.item(b.open_item_id),amount=scaled(b.amount,2,1),tax=scaled(b.tax??'0');
      if(o.kind!=='receivable'||amount>o.amount-o.paid)fail('呆帳金額超過應收未結餘額',409);
      if(tax>amount)fail('稅額調整不得超過呆帳金額');
      const original=e.get('SELECT tax FROM fulfilments WHERE id=?',o.fulfilment_id),used=e.get("SELECT COALESCE(sum(tax),0) n FROM bad_debts WHERE open_item_id=? AND status IN ('draft','approved')",o.id).n;
      const returnedTax=e.get('SELECT COALESCE(sum(tax),0) n FROM returns WHERE fulfilment_id=?',o.fulfilment_id).n,allowanceTax=e.get('SELECT COALESCE(sum(tax),0) n FROM allowances WHERE fulfilment_id=?',o.fulfilment_id).n;if(tax>original.tax-returnedTax-allowanceTax-used)fail('稅額調整超過來源尚未沖回稅額；請由財務核對');
      const no=e.number('BD'),date=dateValue(b.date);e.checkPeriod(date);
      const id=Number(e.run('INSERT INTO bad_debts(no,open_item_id,amount,tax,reason,date,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',no,o.id,amount,tax,txt(b.reason,2000,true),date,u.id,now()).lastInsertRowid);
      e.log(u,'propose_bad_debt','bad_debt',id,{no,amount,tax});return this.debt(id);
    });
  }
  debtAction(u,id,b){
    permit(u,b.action==='recover'?'finance':'approve');return this.e.tx(()=>{
      const e=this.e,d=this.debt(id),o=this.finance.item(d.open_item_id),date=dateValue(b.date),reason=txt(b.reason,2000,true);e.checkPeriod(date);
      if(date<d.date||date>today())fail('呆帳操作日期不得早於申請或晚於今天');
      const no=e.number('BDE');let amount=d.amount,bank=null;
      if(b.action==='approve'){
        if(d.status!=='draft'||amount>o.amount-o.paid)fail('申請已處理或未結金額已異動',409);
        e.run("UPDATE bad_debts SET status='approved',approved_by=? WHERE id=?",u.id,d.id);e.run('UPDATE open_items SET paid=paid+? WHERE id=?',amount,o.id);
        e.journal(u,'呆帳核准 '+reason,no,[['5301',amount-d.tax,0],['2100',d.tax,0],['1100',0,amount]],date);
      }else if(b.action==='reject'){
        if(d.status!=='draft')fail('僅可駁回待審呆帳申請',409);e.run("UPDATE bad_debts SET status='rejected' WHERE id=?",d.id);
      }else if(b.action==='recover'){
        if(d.status!=='approved')fail('僅可收回已核准呆帳',409);
        amount=scaled(b.amount,2,1);if(amount>d.amount-d.recovered)fail('收回金額超過尚未收回呆帳',409);
        bank=this.finance.bank(b.bank_account_id);const tax=ratio(d.tax,d.recovered+amount,d.amount)-ratio(d.tax,d.recovered,d.amount);
        e.run('UPDATE bad_debts SET recovered=recovered+? WHERE id=?',amount,d.id);
        e.journal(u,'呆帳收回 '+reason,no,[[bank.gl_code,amount,0],['5301',0,amount-tax],['2100',0,tax]],date);
      }else if(b.action==='reverse'){
        if(d.status!=='approved'||d.recovered)fail('僅可沖回尚未收回的已核准呆帳',409);
        if(o.paid<amount)fail('來源帳款已沖餘額不符',409);
        e.run("UPDATE bad_debts SET status='reversed' WHERE id=?",d.id);e.run('UPDATE open_items SET paid=paid-? WHERE id=?',amount,o.id);
        e.journal(u,'呆帳沖回 '+reason,no,[['1100',amount,0],['5301',0,amount-d.tax],['2100',0,d.tax]],date);
      }else fail('呆帳操作錯誤');
      e.run('INSERT INTO bad_debt_events(bad_debt_id,action,amount,date,bank_account_id,reason,created_by) VALUES(?,?,?,?,?,?,?)',d.id,b.action,amount,date,bank?.id??null,reason,u.id);
      e.log(u,b.action+'_bad_debt','bad_debt',d.id,{no,amount,date});return this.debt(id);
    });
  }
  allocationPreview(u,b){
    permit(u,'finance');const e=this.e,expense=e.get('SELECT x.*,c.gl_code FROM expenses x JOIN expense_categories c ON c.id=x.category_id WHERE x.id=?',integer(b.expense_id,1));
    if(!expense||!expense.net)fail('請選擇有未稅金額的費用');
    if(e.get('SELECT id FROM expense_allocations WHERE expense_id=?',expense.id))fail('此費用已分攤',409);
    if(!['amount','quantity'].includes(b.basis)||!Array.isArray(b.lines)||!b.lines.length||b.lines.length>200)fail('請選擇分攤基礎及 1–200 筆來源明細');
    const seen=new Set(),rows=b.lines.map(line=>{
      const id=integer(line.fulfilment_line_id,1),r=e.get('SELECT l.*,f.no source_no,f.kind,d.warehouse_id,d.no document_no,p.unit base_unit FROM fulfilment_lines l JOIN fulfilments f ON f.id=l.fulfilment_id JOIN documents d ON d.id=f.document_id JOIN products p ON p.id=l.product_id WHERE l.id=?',id);
      if(!r||seen.has(id)||r.qty===r.returned_qty)fail('來源不存在、重複或已全退');seen.add(id);
      if(!['inventory','cost','selling'].includes(line.target)||(r.kind==='shipment')!==(line.target==='selling')||(line.target==='inventory'&&!r.track_stock))fail('銷貨費用需列銷售費用；進貨費用可列存貨或已售成本');
      const stock=e.stock(r.product_id,r.warehouse_id);
      if(line.target==='inventory'&&!stock.qty)fail('沒有剩餘庫存，請選擇已售成本');
      return {...r,target:line.target,stock,weight:b.basis==='quantity'?ratio(r.base_qty,r.qty-r.returned_qty,r.qty):ratio(r.net||r.amount,r.qty-r.returned_qty,r.qty)};
    });
    if(b.basis==='quantity'&&new Set(rows.map(r=>r.base_unit)).size>1)fail('不同基本單位不可直接按數量分攤，請改按金額');
    const weight=rows.reduce((n,r)=>n+r.weight,0);if(!weight)fail('分攤基礎合計不得為零');
    let cumulative=0,allocated=0;for(const r of rows){cumulative+=r.weight;const target=ratio(expense.net,cumulative,weight);r.allocation=target-allocated;allocated=target;}
    const token=createHash('sha256').update(JSON.stringify({expense,rows,basis:b.basis})).digest('hex');
    return {expense,rows,basis:b.basis,token,total:expense.net};
  }
  allocate(u,b){
    permit(u,'finance');return this.e.tx(()=>{
      const e=this.e,p=this.allocationPreview(u,b);
      if(p.token!==b.token)fail('來源或庫存已變更，請重新預覽分攤',409);
      const date=dateValue(b.date),reason=txt(b.reason,2000,true),no=e.number('EA');e.checkPeriod(date);
      if(date<p.expense.date)fail('分攤日不得早於費用日期');
      const id=Number(e.run('INSERT INTO expense_allocations(no,expense_id,basis,date,reason,created_by) VALUES(?,?,?,?,?,?)',no,p.expense.id,b.basis,date,reason,u.id).lastInsertRowid),entries=[];
      for(const r of p.rows){
        e.run('INSERT INTO expense_allocation_lines(allocation_id,fulfilment_line_id,amount,target,basis_snapshot) VALUES(?,?,?,?,?)',id,r.id,r.allocation,r.target,JSON.stringify({weight:r.weight,qty:r.qty,returned_qty:r.returned_qty,base_qty:r.base_qty,net:r.net,stock_qty:r.stock.qty,stock_value:r.stock.value}));
        if(r.target==='inventory'&&r.allocation)e.stockMove(u,r.product_id,r.warehouse_id,0,r.allocation,'expense_allocation',no,reason);
        entries.push([r.target==='inventory'?'1200':r.target==='cost'?'5000':'5401',r.allocation,0]);
      }
      entries.push([p.expense.gl_code,0,p.total]);e.journal(u,'進銷貨費用分攤 '+reason,no,entries,date);e.log(u,'allocate_expense','expense_allocation',id,{no,total:p.total,basis:b.basis,lines:p.rows.map(r=>({id:r.id,target:r.target,amount:r.allocation}))});return {id,no,total:p.total};
    });
  }
  allocation(u,id){
    permit(u,'finance');const a=this.e.get('SELECT a.*,x.no expense_no,x.net FROM expense_allocations a JOIN expenses x ON x.id=a.expense_id WHERE a.id=?',integer(id,1));if(!a)fail('費用分攤單不存在',404);
    a.lines=this.e.all('SELECT a.*,f.no source_no,d.no document_no,dl.sku,dl.name,dl.unit FROM expense_allocation_lines a JOIN fulfilment_lines fl ON fl.id=a.fulfilment_line_id JOIN fulfilments f ON f.id=fl.fulfilment_id JOIN document_lines dl ON dl.id=fl.document_line_id JOIN documents d ON d.id=f.document_id WHERE a.allocation_id=? ORDER BY a.id',a.id).map(l=>({...l,basis_snapshot:JSON.parse(l.basis_snapshot)}));return a;
  }
  printAllocation(u,id){
    const a=this.allocation(u,id),m=n=>(n/100).toFixed(2);return printPage('費用分攤單 '+a.no,`<p>費用單 ${E(a.expense_no)} · ${E(a.date)} · ${a.basis==='amount'?'按未稅金額':'按基本數量'}分攤</p><p>核對原因：${E(a.reason)}</p><table><tr><th>來源</th><th>品號／品名</th><th>分攤基礎快照</th><th>去向</th><th>未稅分攤</th></tr>${a.lines.map(l=>`<tr><td>${E(l.document_no)}<br>${E(l.source_no)}</td><td>${E(l.sku)} ${E(l.name)}</td><td>${l.basis_snapshot.weight/(a.basis==='amount'?100:1000)}</td><td>${E({inventory:'存貨',cost:'已售成本',selling:'銷售費用'}[l.target])}</td><td>${m(l.amount)}</td></tr>`).join('')}</table><p>未稅分攤合計 TWD ${m(a.net)}</p>`);
  }
  fileRows(b){
    if(!b.file)return b.rows;
    if(typeof b.file.base64!=='string'||b.file.base64.length>2800000||!/^[-\w .\u3400-\u9fff]+\.(xlsx|csv)$/i.test(txt(b.file.name,150,true)))fail('請使用 2 MB 以下的 .xlsx 或 .csv');
    const bytes=Buffer.from(b.file.base64,'base64');return b.file.name.toLowerCase().endsWith('.xlsx')?readXLSX(bytes):readCSV(bytes.toString('utf8'));
  }
  reconcilePreview(u,b){
    permit(u,'finance');return this.e.tx(()=>{
      const e=this.e,bank=this.finance.bank(b.bank_account_id),raw=this.fileRows(b);
      if(bank.kind!=='bank'||!Array.isArray(raw)||!raw.length||raw.length>2000)fail('請指定銀行帳戶及 1–2,000 筆資料');
      const columns=b.columns;if(!columns||['external_id','date','amount','partner_code','reference'].some(key=>!txt(columns[key],100,true)))fail('請設定交易編號、日期、金額、往來代號及參考單號欄位');
      const seen=new Set(),rows=raw.map((raw,index)=>{
        try{
          const val=key=>txt(String(raw[columns[key]]??''),150),external_id=txt(val('external_id'),100,true),date=dateValue(excelDate(val('date'))),signed=scaled(val('amount'),2,-1e12,1e12);
          if(!signed)fail('交易金額不可為零');if(seen.has(external_id)||e.get('SELECT id FROM reconciled_entries WHERE bank_account_id=? AND external_id=?',bank.id,external_id))fail('銀行交易編號重複或已入帳');seen.add(external_id);
          const p=e.get('SELECT * FROM partners WHERE code=? AND active=1',val('partner_code')),reference=val('reference'),kind=signed>0?'receivable':'payable';
          let candidates=[];
          if(p)candidates=e.all("SELECT o.* FROM open_items o JOIN fulfilments f ON f.id=o.fulfilment_id JOIN documents d ON d.id=f.document_id LEFT JOIN billing_batches bb ON bb.id=o.billing_batch_id WHERE o.partner_id=? AND o.kind=? AND o.billing_state='posted' AND o.amount>o.paid AND (f.no=? OR d.no=? OR bb.no=?) ORDER BY o.id",p.id,kind,reference,reference,reference);
          let left=Math.abs(signed);const allocations=[];for(const o of candidates){const amount=Math.min(left,o.amount-o.paid);if(amount)allocations.push({open_item_id:o.id,amount:String(amount/100)});left-=amount;}
          return {index,external_id,date,amount:signed,partner_id:p?.id??null,partner_name:p?.name||val('partner_code'),reference,allocations:!left?allocations:[],exception:!p?'找不到往來代號，請人工配對':left?'參考單號無法完整配對，請人工核對':'',valid:true};
        }catch(error){return {index,valid:false,exception:error.message};}
      });
      const id=Number(e.run('INSERT INTO reconcile_jobs(bank_account_id,rows,created_by,created_at) VALUES(?,?,?,?)',bank.id,JSON.stringify(rows),u.id,now()).lastInsertRowid);
      e.log(u,'preview_reconciliation','reconcile_job',id,{rows:rows.length});return {id,bank_account_id:bank.id,rows};
    });
  }
  reconcileCommit(u,id,b){
    permit(u,'finance');return this.e.tx(()=>{
      const e=this.e,job=e.get('SELECT * FROM reconcile_jobs WHERE id=?',integer(id,1));if(!job||job.status!=='preview')fail('對帳批次不存在或已入帳',409);
      const rows=JSON.parse(job.rows),bank=this.finance.bank(job.bank_account_id);
      if(rows.some(r=>!r.valid))fail('請先修正原始交易編號、日期或金額，再重新匯入');
      if(!Array.isArray(b.matches)||b.matches.length!==rows.length||new Set(b.matches.map(m=>m.index)).size!==rows.length)fail('每筆銀行交易均需核對');
      for(const r of rows){
        const match=b.matches.find(m=>m.index===r.index);if(!match)fail('缺少銀行交易配對');
        const lines=this.finance.allocations({kind:r.amount>0?'receivable':'payable',partner_id:match.partner_id||r.partner_id,lines:match.lines});
        if(lines.reduce((n,l)=>n+l.allocation,0)!==Math.abs(r.amount))fail('分配金額與銀行交易不符');
        if(r.date>today()||lines.some(l=>{const f=e.get('SELECT date FROM fulfilments WHERE id=?',l.fulfilment_id),bill=l.billing_batch_id?e.get('SELECT date FROM billing_batches WHERE id=?',l.billing_batch_id):null;return r.date<f.date||(bill&&r.date<bill.date);}))fail('銀行交易日期早於來源立帳或晚於今天；預收付請使用預收付流程');
        const entry=Number(e.run('INSERT INTO reconciled_entries(job_id,bank_account_id,external_id,date,amount,created_by) VALUES(?,?,?,?,?,?)',job.id,bank.id,r.external_id,r.date,r.amount,u.id).lastInsertRowid);
        for(const l of lines){const result=e.pay(u,{open_item_id:l.id,amount:String(l.allocation/100),bank_account_id:bank.id,method:'bank',date:r.date,reference:'銀行對帳 '+r.external_id});const payment=e.get('SELECT id FROM payments WHERE no=?',result.no);e.run('INSERT INTO reconciliation_payments VALUES(?,?)',entry,payment.id);}
      }
      e.run("UPDATE reconcile_jobs SET status='committed' WHERE id=?",job.id);e.log(u,'commit_reconciliation','reconcile_job',job.id,{entries:rows.length});return {id:job.id,count:rows.length};
    });
  }
  data(u){
    if(!has(u,'finance'))return {};
    return {bad_debts:this.e.all('SELECT b.*,p.name partner_name,f.no source_no FROM bad_debts b JOIN open_items o ON o.id=b.open_item_id JOIN partners p ON p.id=o.partner_id JOIN fulfilments f ON f.id=o.fulfilment_id ORDER BY b.id DESC'),expense_allocations:this.e.all('SELECT a.*,x.no expense_no,x.net FROM expense_allocations a JOIN expenses x ON x.id=a.expense_id ORDER BY a.id DESC'),reconcile_jobs:this.e.all('SELECT id,bank_account_id,status,created_at FROM reconcile_jobs ORDER BY id DESC LIMIT 500')};
  }
}
