import { permit,has,fail,integer,txt,dateValue,today,now } from './core.mjs';
import { Trade } from './trade.mjs';

const fields=['order_ref','customer_code','warehouse_code','sku','qty','price','date','due_date','tax_mode','notes'];
const required=['order_ref','customer_code','warehouse_code','sku','qty','price'];
export class SkuOrders {
  constructor(e){this.e=e;}
  saveMapping(u,b){
    permit(u,'masters');return this.e.tx(()=>{
      const e=this.e,platform=txt(b.platform,80,true),sku=txt(b.external_sku,100,true),p=e.product(b.product_id),unit=b.unit_id?new Trade(e).unit(p.id,b.unit_id):null;
      const old=b.id?e.get('SELECT * FROM sku_mappings WHERE id=?',integer(b.id,1)):null;
      if(b.id&&(!old||old.version!==integer(b.version,1)))fail('SKU 映射已更新或不存在',409);
      let id=old?.id;
      if(id)e.run('UPDATE sku_mappings SET platform=?,external_sku=?,product_id=?,unit_id=?,version=version+1 WHERE id=?',platform,sku,p.id,unit?.id??null,id);
      else id=Number(e.run('INSERT INTO sku_mappings(platform,external_sku,product_id,unit_id) VALUES(?,?,?,?)',platform,sku,p.id,unit?.id??null).lastInsertRowid);
      e.log(u,'save_mapping','sku_mapping',id,{platform,external_sku:sku,product_id:p.id,unit_id:unit?.id??null});return e.get('SELECT * FROM sku_mappings WHERE id=?',id);
    });
  }
  template(u,id){permit(u,'sell');const t=this.e.get('SELECT * FROM order_import_templates WHERE id=?',integer(id,1));if(!t)fail('匯入範本不存在',404);return {...t,columns:JSON.parse(t.columns)};}
  saveTemplate(u,b){
    permit(u,'sell');return this.e.tx(()=>{
      const e=this.e,old=b.id?this.template(u,b.id):null;
      if(old&&old.created_by!==u.id&&!has(u,'masters'))fail('不可修改他人匯入範本',403);
      if(old&&old.version!==integer(b.version,1))fail('匯入範本已更新',409);
      if(!b.columns||typeof b.columns!=='object'||Array.isArray(b.columns))fail('請設定欄位映射');
      const columns={};for(const key of Object.keys(b.columns)){if(!fields.includes(key))fail('不支援的匯入欄位');columns[key]=txt(b.columns[key],100,true);}
      if(required.some(key=>!columns[key])||new Set(Object.values(columns)).size!==Object.keys(columns).length)fail('必要欄位需完整且不能重複映射');
      const vals=[txt(b.name,100,true),txt(b.namespace,80,true),JSON.stringify(columns)];let id=old?.id;
      if(id)e.run('UPDATE order_import_templates SET name=?,namespace=?,columns=?,version=version+1 WHERE id=?',...vals,id);
      else id=Number(e.run('INSERT INTO order_import_templates(name,namespace,columns,created_by) VALUES(?,?,?,?)',...vals,u.id).lastInsertRowid);
      e.log(u,'save_template','order_import_template',id,{name:vals[0],namespace:vals[1]});return this.template(u,id);
    });
  }
  validate(u,template,raw){
    if(!Array.isArray(raw)||!raw.length||raw.length>2000)fail('請提供 1–2,000 列訂單資料');
    const e=this.e,groups=new Map(),errors=[];
    for(let i=0;i<raw.length;i++)try{
      const r=raw[i];if(!r||typeof r!=='object'||Array.isArray(r))fail('資料列格式錯誤');
      const values={};for(const [key,column]of Object.entries(template.columns)){if(!Object.hasOwn(r,column))fail('缺少欄位：'+column);values[key]=txt(String(r[column]??''),key==='notes'?2000:100);}
      const ref=txt(values.order_ref,100,true);
      if(e.get('SELECT document_id FROM order_import_sources WHERE namespace=? AND reference=?',template.namespace,ref)||e.get('SELECT document_id FROM order_metadata WHERE platform=? AND external_ref=?',template.namespace,ref))fail('外部單號已匯入：'+ref,409);
      const p=e.get('SELECT id FROM partners WHERE code=?',values.customer_code),w=e.get('SELECT id FROM warehouses WHERE code=?',values.warehouse_code);
      if(!p||!w)fail('客戶或倉庫代號不存在');const partner=e.partner(u,p.id,'customer');e.warehouse(w.id);
      // External SKU mappings are explicit; no name or fuzzy matching.
      const map=e.get('SELECT * FROM sku_mappings WHERE platform=? AND external_sku=?',template.namespace,values.sku);
      if(!map)fail('SKU 尚未映射：'+values.sku);
      const product=e.product(map.product_id),unit=new Trade(e).unit(product.id,map.unit_id);
      const line={product_id:product.id,unit_id:unit.id,qty:values.qty,price:values.price},date=dateValue(values.date||today()),due=dateValue(values.due_date||date),tax=values.tax_mode||'exclusive';
      const signature=JSON.stringify([p.id,w.id,date,due,tax,values.notes||'']);let group=groups.get(ref);
      if(!group){group={reference:ref,signature,partner_version:partner.version,checks:[],body:{kind:'order',partner_id:p.id,warehouse_id:w.id,date,due_date:due,tax_mode:tax,notes:values.notes||'',lines:[]}};groups.set(ref,group);}
      if(group.signature!==signature)fail('同一外部訂單的客戶、倉庫、日期、稅別或備註不一致');
      if(group.body.lines.some(l=>l.product_id===product.id))fail('同一訂單的商品重複，請先依交易單位合併數量');
      group.body.lines.push(line);group.checks.push([product.id,product.version,map.id,map.version,unit.id]);
      new Trade(e).preview(group.body);
    }catch(error){errors.push({row:i+2,message:error.message});}
    return {orders:[...groups.values()],errors};
  }
  preview(u,b){
    permit(u,'sell');return this.e.tx(()=>{
      const template=this.template(u,b.template_id),result=this.validate(u,template,b.rows);
      const payload={raw:b.rows,template_version:template.version,orders:result.orders};
      const id=Number(this.e.run('INSERT INTO order_import_jobs(template_id,namespace,rows,errors,created_by,created_at) VALUES(?,?,?,?,?,?)',template.id,template.namespace,JSON.stringify(payload),JSON.stringify(result.errors),u.id,now()).lastInsertRowid);
      this.e.log(u,'preview_order_import','order_import_job',id,{orders:result.orders.length,errors:result.errors.length});return {id,count:result.orders.length,errors:result.errors,orders:result.orders.map(g=>{const p=new Trade(this.e).preview(g.body);return {reference:g.reference,lines:g.body.lines.length,net:p.net,tax:p.tax,total:p.total};})};
    });
  }
  commit(u,id){
    permit(u,'sell');return this.e.tx(()=>{
      const e=this.e,job=e.get('SELECT * FROM order_import_jobs WHERE id=?',integer(id,1));
      if(!job||job.status!=='preview')fail('匯入批次不存在或已執行',409);
      if(job.created_by!==u.id&&!has(u,'masters'))fail('不可執行他人的匯入批次',403);
      if(JSON.parse(job.errors).length)fail('請先修正錯誤或 SKU 映射，再重新預覽');
      const saved=JSON.parse(job.rows),template=this.template(u,job.template_id),current=this.validate(u,template,saved.raw);
      if(template.version!==saved.template_version||current.errors.length||JSON.stringify(current.orders)!==JSON.stringify(saved.orders))fail('範本、SKU、主檔或來源單號已異動，請重新預覽',409);
      const documents=[];
      for(const g of current.orders){const d=e.saveDoc(u,g.body);e.run('INSERT INTO order_import_sources VALUES(?,?,?,?)',job.namespace,g.reference,d.id,job.id);e.run('INSERT INTO order_metadata(document_id,platform,external_ref) VALUES(?,?,?)',d.id,job.namespace,g.reference);documents.push({id:d.id,no:d.no,reference:g.reference});}
      e.run("UPDATE order_import_jobs SET status='committed' WHERE id=?",job.id);e.log(u,'commit_order_import','order_import_job',job.id,{documents});return {id:job.id,count:documents.length,documents};
    });
  }
  data(u){
    const data={};
    if(has(u,'sell')){
      data.sku_mappings=this.e.all('SELECT m.*,p.sku,p.name FROM sku_mappings m JOIN products p ON p.id=m.product_id ORDER BY m.platform,m.external_sku');
      data.order_import_templates=this.e.all('SELECT * FROM order_import_templates ORDER BY name').map(t=>({...t,columns:JSON.parse(t.columns)}));
      data.order_import_jobs=this.e.all(`SELECT id,template_id,namespace,errors,status,created_by,created_at FROM order_import_jobs ${has(u,'masters')?'':'WHERE created_by=?'} ORDER BY id DESC LIMIT 500`,...(has(u,'masters')?[]:[u.id])).map(j=>({...j,errors:JSON.parse(j.errors)}));
    }return data;
  }
}
