import { permit,fail,integer,scaled,txt,dateValue,today,now } from './core.mjs';
import { baseQuantity } from './trade.mjs';

export class OrderWorkflows {
  constructor(e){this.e=e;}
  metadata(u,id,b){
    permit(u,'sell');return this.e.tx(()=>{
      const e=this.e,d=e.doc(u,id);
      if(d.kind==='purchase'||!['draft','rejected'].includes(d.status))fail('只可修改銷售草稿的外部欄位',409);
      if(d.version!==integer(b.version,1))fail('來源單據已更新',409);
      const fields=['platform','external_ref','buyer_tax_id','carrier_type','carrier_id','donation_code','logistics_provider','tracking_no'];
      const v=Object.fromEntries(fields.map(key=>[key,txt(b[key],key==='carrier_id'?64:100)]));
      if(v.buyer_tax_id&&!/^\d{8}$/.test(v.buyer_tax_id))fail('買受人統編需為 8 碼');
      if(v.carrier_type&&!['mobile','citizen','other'].includes(v.carrier_type))fail('載具類型錯誤');
      if(v.carrier_type==='mobile'&&!/^\/[0-9A-Z.+-]{7}$/.test(v.carrier_id))fail('手機載具格式錯誤');
      if(v.carrier_type==='citizen'&&!/^[A-Z]{2}\d{14}$/.test(v.carrier_id))fail('自然人憑證載具格式錯誤');
      if(Boolean(v.carrier_type)!==Boolean(v.carrier_id))fail('載具類型與號碼需一起填寫');
      if(v.donation_code&&!/^\d{3,7}$/.test(v.donation_code))fail('捐贈碼需為 3–7 碼數字');
      if(v.donation_code&&v.carrier_id)fail('捐贈與載具請擇一');
      if(Boolean(v.platform)!==Boolean(v.external_ref))fail('外部平台與單號需一起填寫');
      e.run(`INSERT INTO order_metadata(document_id,${fields.join(',')}) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET ${fields.map(k=>k+'=excluded.'+k).join(',')}`,d.id,...fields.map(k=>v[k]));
      e.run('UPDATE documents SET version=version+1,updated_at=? WHERE id=?',now(),d.id);
      e.log(u,'save_external_fields','document',d.id,{fields:fields.filter(k=>v[k])});
      return {document_id:d.id,version:d.version+1,...v};
    });
  }
  getMetadata(u,id){const d=this.e.doc(u,id);if(d.kind==='purchase')fail('採購單不適用此欄位');return this.e.get('SELECT * FROM order_metadata WHERE document_id=?',d.id)||{document_id:d.id};}
  plan(u,id){
    permit(u,'all');const p=this.e.get('SELECT * FROM subscription_plans WHERE id=?',integer(id,1));
    if(!p)fail('分期排程不存在',404);
    const d=this.e.doc(u,p.document_id);
    return {...p,document_no:d.no,periods:this.e.all('SELECT * FROM subscription_periods WHERE plan_id=? ORDER BY due_date,id',p.id).map(r=>({...r,lines:JSON.parse(r.lines)})),events:this.e.all('SELECT * FROM subscription_events WHERE plan_id=? ORDER BY id',p.id)};
  }
  event(u,p,period,action,detail){this.e.run('INSERT INTO subscription_events(plan_id,period_id,action,detail,created_by,created_at) VALUES(?,?,?,?,?,?)',p,period,action,JSON.stringify(detail),u.id,now());this.e.log(u,action,'subscription_plan',p,detail);}
  quantities(d,lines){
    if(!Array.isArray(lines)||!lines.length||lines.length>200)fail('請填寫分期明細');
    const seen=new Set();return lines.map(l=>{
      const id=integer(l.line_id,1),source=d.lines.find(x=>x.id===id),qty=scaled(l.qty,3,1);
      if(!source||seen.has(id))fail('分期來源明細重複或不屬於訂單');seen.add(id);baseQuantity(qty,source.unit_ratio);
      return {line_id:id,qty:String(qty/1000)};
    });
  }
  capacity(d,periods){
    for(const line of d.lines){const total=periods.reduce((sum,p)=>sum+p.lines.filter(l=>l.line_id===line.id).reduce((n,l)=>n+scaled(l.qty,3),0),0);if(total>line.qty-line.done_qty-line.closed_qty)fail('各期待交合計超過訂單未交量',409);}
  }
  createPlan(u,b){
    permit(u,'approve');return this.e.tx(()=>{
      const e=this.e,d=e.doc(u,b.document_id);
      if(d.kind!=='order'||!['approved','partial'].includes(d.status))fail('分期排程須使用已核准未交完的訂單',409);
      if(d.version!==integer(b.version,1))fail('訂單已更新',409);
      if(!Array.isArray(b.periods)||!b.periods.length||b.periods.length>120)fail('請建立 1–120 期');
      const periods=b.periods.map(p=>({due_date:dateValue(p.due_date),lines:this.quantities(d,p.lines)}));this.capacity(d,periods);
      const no=e.number('SP'),id=Number(e.run('INSERT INTO subscription_plans(no,document_id,created_by,created_at) VALUES(?,?,?,?)',no,d.id,u.id,now()).lastInsertRowid);
      for(const p of periods)e.run('INSERT INTO subscription_periods(plan_id,due_date,lines) VALUES(?,?,?)',id,p.due_date,JSON.stringify(p.lines));
      this.event(u,id,null,'create_schedule',{periods});return this.plan(u,id);
    });
  }
  changePlan(u,id,b){
    permit(u,'approve');return this.e.tx(()=>{
      const p=this.plan(u,id);if(p.version!==integer(b.version,1))fail('排程已更新',409);
      if(!['active','paused','closed'].includes(b.status)||p.status==='closed')fail('排程狀態不允許此操作',409);
      const reason=txt(b.reason,1000,true);this.e.run('UPDATE subscription_plans SET status=?,version=version+1 WHERE id=?',b.status,p.id);this.event(u,p.id,null,'schedule_status',{status:b.status,reason});return this.plan(u,id);
    });
  }
  changePeriod(u,id,b){
    permit(u,'approve');return this.e.tx(()=>{
      const e=this.e,r=e.get('SELECT * FROM subscription_periods WHERE id=?',integer(id,1));if(!r)fail('期別不存在',404);
      const p=this.plan(u,r.plan_id),d=e.doc(u,p.document_id);
      if(p.status==='closed'||r.status!=='pending'||r.version!==integer(b.version,1))fail('期別已更新或結束',409);
      const reason=txt(b.reason,1000,true);
      if(b.action==='skip'){e.run("UPDATE subscription_periods SET status='skipped',version=version+1 WHERE id=?",r.id);this.event(u,p.id,r.id,'skip_period',{reason});}
      else if(b.action==='adjust'){
        const lines=this.quantities(d,b.lines),date=dateValue(b.due_date);
        this.capacity(d,[...p.periods.filter(x=>x.status==='pending'&&x.id!==r.id),{lines}]);
        e.run('UPDATE subscription_periods SET lines=?,due_date=?,version=version+1 WHERE id=?',JSON.stringify(lines),date,r.id);this.event(u,p.id,r.id,'adjust_period',{reason,lines,due_date:date});
      }else fail('期別操作錯誤');return this.plan(u,p.id);
    });
  }
  execute(u,id,b){
    permit(u,'stock');return this.e.tx(()=>{
      const e=this.e,r=e.get('SELECT * FROM subscription_periods WHERE id=?',integer(id,1));if(!r)fail('期別不存在',404);
      const p=this.plan(u,r.plan_id);
      if(p.status!=='active'||r.status!=='pending'||r.version!==integer(b.version,1))fail('期別已更新、暫停或結束',409);
      if(r.due_date>today())fail('尚未到此期出貨日期',409);
      if(e.get("SELECT pl.id FROM pick_lines pl JOIN pick_lists pk ON pk.id=pl.pick_id JOIN document_lines dl ON dl.id=pl.document_line_id WHERE dl.document_id=? AND pk.status='draft' LIMIT 1",p.document_id))fail('請先完成或取消作業中的揀貨單',409);
      const f=e.fulfil(u,p.document_id,{lines:JSON.parse(r.lines)});
      e.run("UPDATE subscription_periods SET status='completed',fulfilment_id=?,version=version+1 WHERE id=?",f.id,r.id);
      this.event(u,p.id,r.id,'execute_period',{fulfilment_id:f.id});return this.plan(u,p.id);
    });
  }
  data(u){const out=[];for(const row of this.e.all('SELECT id,document_id FROM subscription_plans ORDER BY id DESC LIMIT 1000')){try{this.e.doc(u,row.document_id);}catch(err){if(err.status===403)continue;throw err;}const p=this.plan(u,row.id);delete p.events;out.push(p);}return {subscription_plans:out};}
}
