import { legacySales } from './access-control.mjs';
import { permit,has,fail,integer,scaled,ratio,txt,dateValue,addDays,today,now } from './core.mjs';
import { Trade } from './trade.mjs';
import { Finance } from './finance.mjs';
import { printPage } from './operations.mjs';
import { escapeHTML as E } from './print.mjs';

export class ServiceWorkflows {
  constructor(e){this.e=e;}
  policy(){return JSON.parse(this.e.settings().service_policy||'{"warranty_days":365,"cycle_days":30,"current_period_full_fee":true}');}
  configure(u,b){permit(u,'admin');const policy={warranty_days:integer(b.warranty_days,0,3650),cycle_days:integer(b.cycle_days,1,366),current_period_full_fee:true};this.e.run("INSERT INTO settings(key,value) VALUES('service_policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",JSON.stringify(policy));this.e.log(u,'configure_services','settings','service_policy',policy);return policy;}
  event(u,repair,contract,action,detail){this.e.run('INSERT INTO service_events(repair_id,contract_id,action,detail,created_by,created_at) VALUES(?,?,?,?,?,?)',repair,contract,action,JSON.stringify(detail),u.id,now());this.e.log(u,action,repair?'repair':'service_contract',repair||contract,detail);}
  repair(u,id){permit(u,'all');const r=this.e.get('SELECT t.*,p.name partner_name FROM repair_tickets t JOIN partners p ON p.id=t.partner_id WHERE t.id=?',integer(id,1));if(!r)fail('維修單不存在',404);this.e.partner(u,r.partner_id);r.events=this.e.all('SELECT * FROM service_events WHERE repair_id=? ORDER BY id',r.id);if(has(u,'cost'))r.parts=this.e.all('SELECT * FROM repair_parts WHERE ticket_id=?',r.id);return r;}
  createRepair(u,b){
    permit(u,'sell');return this.e.tx(()=>{
      const e=this.e,p=e.partner(u,b.partner_id,'customer'),product=b.product_id?e.product(b.product_id):null,serial=txt(b.serial,100),source=b.source_line_id?e.get('SELECT l.*,f.date,d.partner_id FROM fulfilment_lines l JOIN fulfilments f ON f.id=l.fulfilment_id JOIN documents d ON d.id=f.document_id WHERE l.id=? AND f.kind=\'shipment\'',integer(b.source_line_id,1)):null;
      if(b.source_line_id&&(!source||source.partner_id!==p.id||source.product_id!==product?.id))fail('來源出貨與客戶／商品不符');
      const warranty=b.warranty_until?dateValue(b.warranty_until):(source?addDays(source.date,this.policy().warranty_days):''),no=e.number('RP');
      const id=Number(e.run('INSERT INTO repair_tickets(no,partner_id,product_id,source_line_id,serial,description,warranty_until,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',no,p.id,product?.id??null,source?.id??null,serial,txt(b.description,2000,true),warranty,u.id,now()).lastInsertRowid);
      this.event(u,id,null,'repair_received',{description:txt(b.description,2000,true),warranty_until:warranty});return this.repair(u,id);
    });
  }
  repairAction(u,id,b){
    permit(u,'approve');return this.e.tx(()=>{
      const e=this.e,r=this.repair(u,id);if(r.version!==integer(b.version,1))fail('維修單已更新',409);
      const reason=txt(b.reason,2000,true),next=b.status,allowed={received:['diagnosed','cancelled'],diagnosed:['approved','cancelled'],approved:['repairing','cancelled'],repairing:['ready'],ready:['returned']};
      if(!allowed[r.status]?.includes(next))fail('維修狀態不允許此操作',409);
      let service=r.service_product_id,fee=r.fee,diagnosis=r.diagnosis,fid=r.fulfilment_id;
      if(next==='diagnosed'){diagnosis=txt(b.diagnosis,2000,true);fee=scaled(b.fee??'0');if(fee){const product=e.product(b.service_product_id);if(product.track_stock)fail('維修收費需使用非庫存服務品號');service=product.id;}}
      if(next==='cancelled'&&e.get('SELECT id FROM repair_parts WHERE ticket_id=? LIMIT 1',r.id))fail('已有領料成本，請完成維修或另作核准的退料調整',409);
      if(next==='returned'&&fee){const f=new Trade(e).direct(u,{kind:'order',partner_id:r.partner_id,warehouse_id:b.warehouse_id||1,lines:[{product_id:service,qty:'1',price:String(fee/100)}],notes:'維修收費 '+r.no});fid=f.id;}
      e.run('UPDATE repair_tickets SET status=?,diagnosis=?,fee=?,service_product_id=?,fulfilment_id=?,version=version+1 WHERE id=?',next,diagnosis,fee,service,fid,r.id);this.event(u,r.id,null,'repair_'+next,{reason,fee,fulfilment_id:fid});return this.repair(u,id);
    });
  }
  repairPart(u,id,b){
    permit(u,'approve');return this.e.tx(()=>{
      const e=this.e,r=this.repair(u,id);if(r.status!=='repairing'||r.version!==integer(b.version,1))fail('維修尚未開始或修訂已更新',409);
      const p=e.product(b.product_id),w=e.warehouse(b.warehouse_id),qty=scaled(b.qty,3,1),cost=e.costOut(p.id,w.id,qty),reason=txt(b.reason,1000,true);
      const movement=e.adjust(u,{product_id:p.id,warehouse_id:w.id,qty:String(-qty/1000),reason:'維修領料 '+r.no+' '+reason,lots:b.lots});
      e.journal(u,'維修用料成本',movement.no,[['5200',cost,0],['5100',0,cost]]);
      e.run('INSERT INTO repair_parts(ticket_id,product_id,warehouse_id,qty,cost,reference,created_by) VALUES(?,?,?,?,?,?,?)',r.id,p.id,w.id,qty,cost,movement.no,u.id);
      e.run('UPDATE repair_tickets SET version=version+1 WHERE id=?',r.id);this.event(u,r.id,null,'repair_parts',{product_id:p.id,qty,reference:movement.no});return this.repair(u,id);
    });
  }
  contract(u,id){
    permit(u,'all');const c=this.e.get('SELECT c.*,p.name partner_name,pr.sku,pr.name product_name,pr.unit,w.name holding_warehouse FROM service_contracts c JOIN partners p ON p.id=c.partner_id JOIN products pr ON pr.id=c.product_id JOIN warehouses w ON w.id=c.holding_warehouse_id WHERE c.id=?',integer(id,1));if(!c)fail('寄售／租賃合約不存在',404);this.e.partner(u,c.partner_id);c.periods=this.e.all('SELECT * FROM rental_periods WHERE contract_id=? ORDER BY start_date',c.id);c.events=this.e.all('SELECT * FROM service_events WHERE contract_id=? ORDER BY id',c.id);return c;
  }
  createContract(u,b){
    permit(u,'approve');return this.e.tx(()=>{
      const e=this.e,kind=b.kind;if(!['consignment','rental'].includes(kind))fail('合約類型錯誤');
      const partner=e.partner(u,b.partner_id,'customer'),p=e.product(b.product_id),warehouse=e.warehouse(b.warehouse_id),qty=scaled(b.qty,3,1),start=dateValue(b.start_date),end=dateValue(b.end_date),cycle=integer(b.cycle_days??this.policy().cycle_days,1,366);
      if(!p.track_stock)fail('寄售／出租標的需為實體庫存商品');if(start>today()||end<start)fail('交付日起訖錯誤，未交付的未來合約請於交付日建立');
      let service=null;if(kind==='rental'){service=e.product(b.service_product_id);if(service.track_stock)fail('租金需使用非庫存服務品號');if(Math.ceil((Date.parse(end)-Date.parse(start))/86400000/cycle)>120)fail('單一租約最多 120 期');}
      const no=e.number(kind==='rental'?'RENT':'CON'),holding=e.saveWarehouse(u,{code:no,name:(kind==='rental'?'出租保管｜':'寄售保管｜')+partner.name+'｜'+no});
      e.transfer(u,{product_id:p.id,from_id:warehouse.id,to_id:holding.id,qty:String(qty/1000),lots:b.lots});
      let fund=null;if(kind==='rental'&&scaled(b.deposit??'0'))fund=new Finance(e).advance(u,{kind:'customer_advance',partner_id:partner.id,bank_account_id:b.bank_account_id,amount:b.deposit,notes:'租賃押金 '+no});
      const id=Number(e.run('INSERT INTO service_contracts(no,kind,partner_id,product_id,source_warehouse_id,holding_warehouse_id,qty,price,service_product_id,cycle_days,start_date,end_date,deposit_fund_id,notes,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',no,kind,partner.id,p.id,warehouse.id,holding.id,qty,scaled(b.price),service?.id??null,cycle,start,end,fund?.id??null,txt(b.notes,2000),u.id,now()).lastInsertRowid);
      if(kind==='rental')for(let date=start;date<=end;date=addDays(date,cycle)){const next=addDays(date,cycle-1);e.run('INSERT INTO rental_periods(contract_id,start_date,end_date) VALUES(?,?,?)',id,date,next>end?end:next);}
      this.event(u,null,id,'contract_delivered',{kind,qty,holding_warehouse_id:holding.id,deposit_fund_id:fund?.id??null,policy:'租賃已開始的當期按整期租金；押金另經實際退款流程。'});return this.contract(u,id);
    });
  }
  consignmentSale(u,id,b){
    permit(u,'approve');return this.e.tx(()=>{
      const e=this.e,c=this.contract(u,id),qty=scaled(b.qty,3,1);if(c.kind!=='consignment'||c.status!=='active'||c.version!==integer(b.version,1)||qty>c.qty-c.sold_qty-c.returned_qty)fail('寄售合約已更新、結束或數量超過在外數量',409);
      const f=new Trade(e).direct(u,{kind:'order',partner_id:c.partner_id,warehouse_id:c.holding_warehouse_id,lines:[{product_id:c.product_id,qty:String(qty/1000),price:String(c.price/100)}],notes:'寄售結算 '+c.no});
      e.run('INSERT INTO consignment_sales(contract_id,fulfilment_id,qty,created_by) VALUES(?,?,?,?)',c.id,f.id,qty,u.id);e.run('UPDATE service_contracts SET sold_qty=sold_qty+?,version=version+1 WHERE id=?',qty,c.id);
      if(c.sold_qty+c.returned_qty+qty===c.qty)e.run("UPDATE service_contracts SET status='closed' WHERE id=?",c.id);
      this.event(u,null,c.id,'consignment_sale',{qty,fulfilment_id:f.id});return this.contract(u,id);
    });
  }
  charge(u,periodId){
    permit(u,'approve');return this.e.tx(()=>{
      const e=this.e,p=e.get('SELECT * FROM rental_periods WHERE id=?',integer(periodId,1));if(!p)fail('租期不存在',404);
      const c=this.contract(u,p.contract_id);if(c.kind!=='rental'||p.status!=='pending'||p.start_date>today())fail('租期尚未開始或已計費／取消',409);
      const qty=c.qty-c.returned_qty;if(!qty)fail('標的已全數歸還，沒有可計費數量');
      const f=new Trade(e).direct(u,{kind:'order',partner_id:c.partner_id,warehouse_id:c.holding_warehouse_id,lines:[{product_id:c.service_product_id,qty:String(qty/1000),price:String(c.price/100)}],notes:`租金 ${c.no}｜${p.start_date}–${p.end_date}｜當期整期計費`});
      e.run("UPDATE rental_periods SET status='billed',fulfilment_id=? WHERE id=?",f.id,p.id);this.event(u,null,c.id,'rental_charge',{period_id:p.id,fulfilment_id:f.id,qty});return this.contract(u,c.id);
    });
  }
  returnContract(u,id,b){
    permit(u,'approve');return this.e.tx(()=>{
      const e=this.e,c=this.contract(u,id),qty=scaled(b.qty,3,1),reason=txt(b.reason,1000,true);
      if(c.status!=='active'||c.version!==integer(b.version,1)||qty>c.qty-c.sold_qty-c.returned_qty)fail('合約已更新、結束或退回數量超過在外量',409);
      if(c.kind==='rental'){
        const due=c.periods.filter(p=>p.status==='pending'&&p.start_date<=today());if(due.length&&b.bill_started_periods!==true)fail('請確認將已開始的租期立帳後再歸還',409);
        for(const period of due)this.charge(u,period.id);
      }
      e.transfer(u,{product_id:c.product_id,from_id:c.holding_warehouse_id,to_id:c.source_warehouse_id,qty:String(qty/1000),lots:b.lots});
      const closed=c.returned_qty+c.sold_qty+qty===c.qty;e.run('UPDATE service_contracts SET returned_qty=returned_qty+?,version=version+1,status=? WHERE id=?',qty,closed?'closed':'active',c.id);
      if(closed&&c.kind==='rental')e.run("UPDATE rental_periods SET status='skipped' WHERE contract_id=? AND status='pending'",c.id);
      this.event(u,null,c.id,'contract_return',{qty,reason,closed,deposit_fund_id:c.deposit_fund_id,refund:'押金未自動退款，請由資金流程核對後記錄實際退款。'});return this.contract(u,id);
    });
  }
  print(u,kind,id){const c=kind==='repairs'?this.repair(u,id):this.contract(u,id);return printPage((kind==='repairs'?'維修受理單 ':'寄售／租賃合約 ')+c.no,`<p>往來：${E(c.partner_name)}</p>${kind==='repairs'?`<p>序號：${E(c.serial)}<br>保固至：${E(c.warranty_until||'依來源另行核對')}<br>送修說明：${E(c.description)}<br>診斷：${E(c.diagnosis)}</p>`:`<p>標的：${E(c.sku)} · ${E(c.product_name)}<br>數量：${c.qty/1000} ${E(c.unit)}<br>期間：${E(c.start_date)}–${E(c.end_date)}<br>保管倉：${E(c.holding_warehouse)}<br>備註：${E(c.notes)}</p>`}<p>狀態：${E(c.status)}</p><table><tr><th>時間</th><th>事件</th><th>內容</th></tr>${c.events.map(event=>`<tr><td>${E(event.created_at)}</td><td>${E(event.action)}</td><td>${E(event.detail)}</td></tr>`).join('')}</table>`);}
  data(u){
    const e=this.e,filter=legacySales(u)?' WHERE p.owner_id IS NULL OR p.owner_id=?':'',args=legacySales(u)?[u.id]:[];
    return {service_policy:this.policy(),repair_tickets:e.all(`SELECT t.*,p.name partner_name FROM repair_tickets t JOIN partners p ON p.id=t.partner_id${filter} ORDER BY t.id DESC LIMIT 1000`,...args),service_contracts:e.all(`SELECT c.*,p.name partner_name,pr.name product_name FROM service_contracts c JOIN partners p ON p.id=c.partner_id JOIN products pr ON pr.id=c.product_id${filter} ORDER BY c.id DESC LIMIT 1000`,...args)};
  }
}
