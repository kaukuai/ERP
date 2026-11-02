import { createHash } from 'node:crypto';
import { permit,has,fail,integer,scaled,ratio,txt,dateValue,today,now } from './core.mjs';
import { Trade } from './trade.mjs';
import { Finance } from './finance.mjs';
import { printPage } from './operations.mjs';
import { escapeHTML as E } from './print.mjs';

export class POS {
  constructor(e){this.e=e;}
  policy(){return JSON.parse(this.e.settings().loyalty_policy||'{"earn_per":10000,"point_net_value":100,"max_redeem_bp":2000}');}
  configure(u,b){permit(u,'admin');const policy={earn_per:scaled(b.earn_per,2,1),point_net_value:scaled(b.point_net_value,2,1),max_redeem_bp:integer(b.max_redeem_bp,0,10000)};this.e.run("INSERT INTO settings(key,value) VALUES('loyalty_policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",JSON.stringify(policy));this.e.log(u,'configure_loyalty','settings','loyalty_policy',policy);return policy;}
  saveStore(u,b){
    permit(u,'admin');return this.e.tx(()=>{
      const e=this.e,w=e.warehouse(b.warehouse_id),p=e.partner(u,b.customer_id,'customer'),finance=new Finance(e),cash=finance.bank(b.cash_account_id),bank=finance.bank(b.bank_account_id);
      if(cash.kind!=='cash'||bank.kind!=='bank')fail('請分別指定現金與銀行帳戶');
      if(!['keyboard','manual'].includes(b.scanner_mode)||!['manual','external_terminal'].includes(b.payment_provider))fail('設備設定不支援');
      const old=b.id?e.get('SELECT * FROM pos_stores WHERE id=?',integer(b.id,1)):null;if(b.id&&(!old||old.version!==integer(b.version,1)))fail('門市設定已更新',409);
      const vals=[txt(b.code,40,true),txt(b.name,100,true),w.id,p.id,cash.id,bank.id,b.scanner_mode,integer(b.receipt_width??80,40,120),b.payment_provider,txt(b.payment_note,1000),b.active===false?0:1];let id=old?.id;
      if(id)e.run('UPDATE pos_stores SET code=?,name=?,warehouse_id=?,customer_id=?,cash_account_id=?,bank_account_id=?,scanner_mode=?,receipt_width=?,payment_provider=?,payment_note=?,active=?,version=version+1 WHERE id=?',...vals,id);
      else id=Number(e.run('INSERT INTO pos_stores(code,name,warehouse_id,customer_id,cash_account_id,bank_account_id,scanner_mode,receipt_width,payment_provider,payment_note,active) VALUES(?,?,?,?,?,?,?,?,?,?,?)',...vals).lastInsertRowid);
      if(!Array.isArray(b.user_ids)||new Set(b.user_ids).size!==b.user_ids.length)fail('門市帳號設定錯誤');
      e.run('DELETE FROM pos_store_users WHERE store_id=?',id);for(const user of b.user_ids){const account=e.user(integer(user,1));if(!account?.active||!['admin','manager','sales'].includes(account.role))fail('收銀帳號需為啟用的管理員、主管或業務');e.run('INSERT INTO pos_store_users VALUES(?,?)',id,account.id);}
      e.log(u,'save_pos_store','pos_store',id,{name:vals[1],users:b.user_ids});return {id};
    });
  }
  store(u,id){permit(u,'all');const s=this.e.get('SELECT * FROM pos_stores WHERE id=? AND active=1',integer(id,1));if(!s)fail('門市不存在或停用',404);if(!has(u,'approve')&&!this.e.get('SELECT user_id FROM pos_store_users WHERE store_id=? AND user_id=?',s.id,u.id))fail('沒有此門市的收銀權限',403);return s;}
  member(u,b){
    permit(u,'masters');return this.e.tx(()=>{
      const old=b.id?this.e.get('SELECT * FROM loyalty_members WHERE id=?',integer(b.id,1)):null;if(b.id&&(!old||old.version!==integer(b.version,1)))fail('會員資料已更新',409);
      const partner=b.partner_id?this.e.partner(u,b.partner_id,'customer'):null,vals=[txt(b.code,60,true),txt(b.name,100,true),partner?.id??null,txt(b.tier||'standard',40,true),b.active===false?0:1];let id=old?.id;
      if(id)this.e.run('UPDATE loyalty_members SET code=?,name=?,partner_id=?,tier=?,active=?,version=version+1 WHERE id=?',...vals,id);else id=Number(this.e.run('INSERT INTO loyalty_members(code,name,partner_id,tier,active) VALUES(?,?,?,?,?)',...vals).lastInsertRowid);
      this.e.log(u,'save_loyalty_member','member',id,{code:vals[0]});return {id};
    });
  }
  promotion(u,b){
    permit(u,'masters');return this.e.tx(()=>{
      const old=b.id?this.e.get('SELECT * FROM pos_promotions WHERE id=?',integer(b.id,1)):null;if(b.id&&(!old||old.version!==integer(b.version,1)))fail('促銷設定已更新',409);
      if(b.store_id)this.store(u,b.store_id);if(b.product_id)this.e.product(b.product_id);
      const from=dateValue(b.start_date),to=dateValue(b.end_date);if(to<from)fail('促銷迄日不得早於起日');
      const vals=[txt(b.name,100,true),b.store_id?integer(b.store_id,1):null,b.product_id?integer(b.product_id,1):null,txt(b.category,100),txt(b.member_tier,40),integer(b.discount_bp,0,10000),from,to,b.active===false?0:1];let id=old?.id;
      if(id)this.e.run('UPDATE pos_promotions SET name=?,store_id=?,product_id=?,category=?,member_tier=?,discount_bp=?,start_date=?,end_date=?,active=?,version=version+1 WHERE id=?',...vals,id);else id=Number(this.e.run('INSERT INTO pos_promotions(name,store_id,product_id,category,member_tier,discount_bp,start_date,end_date,active) VALUES(?,?,?,?,?,?,?,?,?)',...vals).lastInsertRowid);
      this.e.log(u,'save_pos_promotion','promotion',id,{name:vals[0]});return {id};
    });
  }
  shift(u,b){
    const store=this.store(u,b.store_id);return this.e.tx(()=>{
      if(b.action==='open'){const id=Number(this.e.run('INSERT INTO pos_shifts(store_id,user_id,opening_cash,opened_at) VALUES(?,?,?,?)',store.id,u.id,scaled(b.opening_cash),now()).lastInsertRowid);this.e.log(u,'open_pos_shift','pos_shift',id);return {id};}
      const shift=this.e.get("SELECT * FROM pos_shifts WHERE id=? AND closed_at=''",integer(b.shift_id,1));if(!shift||shift.store_id!==store.id||(shift.user_id!==u.id&&!has(u,'approve')))fail('班別不存在或沒有結班權限',403);
      const received=this.e.get("SELECT COALESCE(sum(t.amount),0) n FROM pos_tenders t JOIN pos_sales s ON s.id=t.sale_id JOIN bank_accounts a ON a.id=t.bank_account_id WHERE s.shift_id=? AND a.kind='cash'",shift.id).n;
      const refunded=this.e.get("SELECT COALESCE(sum(r.amount),0) n FROM pos_refunds r JOIN bank_accounts a ON a.id=r.bank_account_id WHERE r.shift_id=? AND a.kind='cash'",shift.id).n;
      const expected=shift.opening_cash+received-refunded,counted=scaled(b.counted_cash),reason=txt(b.reason,1000,expected!==counted);if(b.action!=='close')fail('班別操作錯誤');
      this.e.run('UPDATE pos_shifts SET closed_at=?,counted_cash=?,expected_cash=?,reason=? WHERE id=?',now(),counted,expected,reason,shift.id);this.e.log(u,'close_pos_shift','pos_shift',shift.id,{expected,counted,reason});return {id:shift.id,expected,counted,difference:counted-expected};
    });
  }
  quote(u,b){
    const e=this.e,store=this.store(u,b.store_id),member=b.member_id?e.get('SELECT * FROM loyalty_members WHERE id=? AND active=1',integer(b.member_id,1)):null;if(b.member_id&&!member)fail('會員不存在或停用');
    const customer=member?.partner_id||store.customer_id;e.partner({...u,role:'manager'},customer,'customer');
    if(!Array.isArray(b.lines)||!b.lines.length||b.lines.length>200)fail('請新增 1–200 筆商品');const seen=new Set(),promotions=e.all('SELECT * FROM pos_promotions WHERE active=1 AND start_date<=? AND end_date>=?',today(),today());
    const lines=b.lines.map(l=>{
      let productId=l.product_id,unitId=l.unit_id;
      if(l.barcode){const barcode=txt(l.barcode,100,true),p=e.get('SELECT id FROM products WHERE barcode=? AND active=1',barcode),unit=p?null:e.get('SELECT * FROM product_units WHERE barcode=? AND active=1',barcode);if(!p&&!unit)fail('條碼未建立，請先設定商品／單位');productId=p?.id||unit.product_id;unitId=unit?.id;}
      const p=e.product(productId),unit=new Trade(e).unit(p.id,unitId);if(seen.has(p.id))fail('相同商品請合併為一列');seen.add(p.id);
      const eligible=promotions.filter(x=>(!x.store_id||x.store_id===store.id)&&(!x.product_id||x.product_id===p.id)&&(!x.category||x.category===p.category)&&(!x.member_tier||x.member_tier===member?.tier));
      return {product_id:p.id,unit_id:unit.id,qty:String(scaled(l.qty,3,1)/1000),price:String(unit.price/100),discount_bp:Math.min(10000,...eligible.map(x=>x.discount_bp))};
    });
    const policy=this.policy(),points=integer(b.redeem_points??0,0,Math.max(0,member?.points||0));if(points&&!member)fail('折抵點數需指定會員');
    const before=new Trade(e).preview({lines}),discount=integer(points*policy.point_net_value);if(discount>ratio(before.net,policy.max_redeem_bp,10000))fail('點數折抵超過門市政策上限');
    const body={kind:'order',partner_id:customer,warehouse_id:store.warehouse_id,lines,header_discount:String(discount/100),notes:'門市銷售 '+store.name},preview=new Trade(e).preview(body);
    if(preview.total<=0)fail('POS 結帳合計須大於零');
    const earned=Math.floor(preview.net/policy.earn_per),token=createHash('sha256').update(JSON.stringify({store,member,body,promotions,policy,stock:lines.map(l=>e.stock(l.product_id,store.warehouse_id)),points})).digest('hex');
    return {store,member_id:member?.id,points,earned,body,token,net:preview.net,tax:preview.tax,total:preview.total,lines:preview.rows.map(r=>({product_id:r.product.id,sku:r.product.sku,name:r.product.name,unit:r.unit.name,qty:r.qty,net:r.net,tax:r.tax,total:r.total})),notice:'促銷逐列擇最優惠一項；點數為促銷折抵，按未稅金額計算。外部終端付款需先取得實際成功結果，再記錄參考號。'};
  }
  checkout(u,b){
    return this.e.tx(()=>{
      const e=this.e,q=this.quote(u,b);if(q.token!==b.token)fail('商品、促銷、點數或庫存已更新，請重新結帳預覽',409);
      const shift=e.get("SELECT * FROM pos_shifts WHERE id=? AND closed_at=''",integer(b.shift_id,1));if(!shift||shift.user_id!==u.id||shift.store_id!==q.store.id)fail('請先開啟自己的門市班別',409);
      if(!Array.isArray(b.tenders)||!b.tenders.length||b.tenders.length>5)fail('請填寫 1–5 種實收方式');
      const tenders=b.tenders.map(t=>{if(!['cash','bank','terminal'].includes(t.method))fail('收款方式錯誤');const amount=scaled(t.amount,2,1),received=scaled(t.received??t.amount,2,1),reference=txt(t.reference,200,t.method!=='cash');if(received<amount||(t.method!=='cash'&&received!==amount))fail('實收不得低於分配，非現金不得產生找零');if(t.method==='terminal'&&t.confirmed!==true)fail('請先在外部終端確認付款成功');return {method:t.method,amount,received,reference,bank_account_id:t.method==='cash'?q.store.cash_account_id:q.store.bank_account_id};});
      if(tenders.reduce((n,t)=>n+t.amount,0)!==q.total)fail('各收款方式分配合計須等於結帳金額');
      // Store-specific authorization above grants this narrowly constructed sale flow.
      // Client-supplied prices, permissions, warehouses and approval flags are ignored.
      const cashier={...u,role:'manager'},previous=e.forceImmediateBilling;let f;
      try{e.forceImmediateBilling=true;f=new Trade(e).direct(cashier,q.body);}finally{e.forceImmediateBilling=previous;}
      const o=e.get('SELECT * FROM open_items WHERE fulfilment_id=?',f.id),no=e.number('POS'),id=Number(e.run('INSERT INTO pos_sales(no,store_id,shift_id,fulfilment_id,member_id,earned_points,redeemed_points,total,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',no,q.store.id,shift.id,f.id,q.member_id??null,q.member_id?q.earned:0,q.points,q.total,u.id,now()).lastInsertRowid);
      for(const tender of tenders){const bank=new Finance(e).bank(tender.bank_account_id);e.pay(cashier,{open_item_id:o.id,bank_account_id:bank.id,method:bank.kind,amount:String(tender.amount/100),reference:no+' '+tender.reference});e.run('INSERT INTO pos_tenders(sale_id,bank_account_id,amount,method,reference,received) VALUES(?,?,?,?,?,?)',id,bank.id,tender.amount,tender.method,tender.reference,tender.received);}
      if(q.member_id)this.points(u,q.member_id,q.earned-q.points,no);
      e.log(u,'pos_checkout','pos_sale',id,{no,store_id:q.store.id,total:q.total,member_id:q.member_id,earned:q.earned,redeemed:q.points});return this.sale(u,id);
    });
  }
  points(u,member,points,reference){this.e.run('UPDATE loyalty_members SET points=points+?,version=version+1 WHERE id=?',points,member);this.e.run('INSERT INTO loyalty_events(member_id,points,reference,created_by,created_at) VALUES(?,?,?,?,?)',member,points,reference,u.id,now());}
  sale(u,id){const sale=this.e.get('SELECT * FROM pos_sales WHERE id=?',integer(id,1));if(!sale)fail('收銀單不存在',404);this.store(u,sale.store_id);sale.fulfilment=this.e.fulfilment({...u,role:'viewer'},sale.fulfilment_id);sale.tenders=this.e.all('SELECT * FROM pos_tenders WHERE sale_id=?',sale.id);return sale;}
  refund(u,id,b){
    permit(u,'approve');return this.e.tx(()=>{
      const e=this.e,sale=this.sale(u,id),store=this.store(u,sale.store_id),bank=integer(b.bank_account_id,1);if(![store.cash_account_id,store.bank_account_id].includes(bank))fail('退款帳戶不屬於此門市');
      if(b.confirm_actual_refund!==true)fail('請核對並確認實際退款方式；本系統不會自動向銀行退款');
      const prior=e.get('SELECT COALESCE(sum(total),0) n FROM returns WHERE fulfilment_id=?',sale.fulfilment_id).n;
      const shift=e.get("SELECT * FROM pos_shifts WHERE store_id=? AND user_id=? AND closed_at=''",store.id,u.id);if(!shift)fail('請先開啟本次退款的門市班別',409);let r;const previous=e.posRefundContext;try{e.posRefundContext=true;r=e.returnGoods(u,{fulfilment_id:sale.fulfilment_id,lines:b.lines,reason:txt(b.reason,1000,true),allow_credit:true,lots:b.lots});}finally{e.posRefundContext=previous;}const returned=e.get('SELECT * FROM returns WHERE id=?',r.id);
      const fund=e.get('SELECT * FROM funds WHERE source_return_id=?',r.id);if(fund)new Finance(e).refund(u,{fund_id:fund.id,bank_account_id:bank,amount:String(fund.amount/100),notes:'POS 實際退款 '+sale.no});
      e.run('INSERT INTO pos_refunds(sale_id,return_id,shift_id,bank_account_id,amount,created_by,created_at) VALUES(?,?,?,?,?,?,?)',sale.id,r.id,shift.id,bank,returned.total,u.id,now());
      if(sale.member_id){const earned=ratio(sale.earned_points,prior+returned.total,sale.total)-ratio(sale.earned_points,prior,sale.total),restored=ratio(sale.redeemed_points,prior+returned.total,sale.total)-ratio(sale.redeemed_points,prior,sale.total);this.points(u,sale.member_id,restored-earned,r.no);}
      e.log(u,'pos_refund','pos_sale',sale.id,{return_id:r.id,total:returned.total});return this.sale(u,id);
    });
  }
  receipt(u,id){const sale=this.sale(u,id),store=this.store(u,sale.store_id),m=n=>(n/100).toFixed(2);return printPage('門市收銀明細 '+sale.no,`<p>${E(this.e.settings().company)}<br>${E(store.name)} · ${E(sale.created_at)}</p><table><tr><th>商品</th><th>數量</th><th>含稅金額</th></tr>${sale.fulfilment.lines.map(l=>`<tr><td>${E(l.sku)} ${E(l.name)}</td><td>${l.qty/1000} ${E(l.unit)}</td><td>${m(l.total)}</td></tr>`).join('')}</table><p>合計 TWD ${m(sale.total)}</p>${sale.tenders.map(t=>`<p>${E(t.method)} 分配 ${m(t.amount)} · 實收 ${m(t.received)} · 找零 ${m(t.received-t.amount)}<br>${E(t.reference)}</p>`).join('')}<p>會員本次獲得 ${sale.earned_points} 點，折抵 ${sale.redeemed_points} 點。</p><p>此為收銀明細，非統一發票。${E(store.payment_note)}</p>`,`@page{size:${store.receipt_width}mm 240mm}`);}
  data(u){
    const stores=this.e.all('SELECT * FROM pos_stores ORDER BY code').filter(s=>has(u,'approve')||this.e.get('SELECT 1 FROM pos_store_users WHERE store_id=? AND user_id=?',s.id,u.id));
    if(!stores.length&&!has(u,'admin'))return {};const ids=new Set(stores.map(s=>s.id));
    return {pos_stores:stores,pos_store_users:u.role==='admin'?this.e.all('SELECT * FROM pos_store_users'):undefined,pos_members:this.e.all('SELECT * FROM loyalty_members WHERE active=1 ORDER BY code'),pos_promotions:has(u,'masters')?this.e.all('SELECT * FROM pos_promotions ORDER BY id DESC'):undefined,pos_shifts:this.e.all('SELECT * FROM pos_shifts ORDER BY id DESC LIMIT 500').filter(s=>ids.has(s.store_id)&&(s.user_id===u.id||has(u,'approve'))),pos_sales:this.e.all('SELECT * FROM pos_sales ORDER BY id DESC LIMIT 1000').filter(s=>ids.has(s.store_id)),loyalty_policy:this.policy()};
  }
}
