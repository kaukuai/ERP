import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { dirname,join } from 'node:path';
import { existsSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { ERP,permit,has,fail,txt,hashPassword } from './core.mjs';

export const companyContext=new AsyncLocalStorage();
export function companyProxy(defaultErp){
  return new Proxy(defaultErp,{
    get(target,key){const current=companyContext.getStore()?.erp||target,value=Reflect.get(current,key);return typeof value==='function'?value.bind(current):value;},
    set(target,key,value){const current=companyContext.getStore()?.erp||target;Reflect.set(current,key,value);return true;},
  });
}
export class Companies {
  constructor(root,path){this.root=root;this.path=path;this.directory=path===':memory:'?null:join(dirname(path),'.company-workspaces');this.cache=new Map();}
  list(){return [{slug:'default',name:this.root.settings().company||'主要帳套'},...this.root.all('SELECT slug,name FROM company_catalog ORDER BY name')];}
  resolve(slug='default'){
    if(!/^[a-z][a-z0-9-]{0,31}$/.test(slug))fail('公司帳套代碼錯誤',400);
    if(slug==='default')return {slug,erp:this.root};
    const row=this.root.get('SELECT * FROM company_catalog WHERE slug=?',slug);if(!row)fail('公司帳套不存在',404);
    if(!this.cache.has(slug)){
      if(!this.directory||!/^company-[0-9a-f-]{36}\.sqlite$/.test(row.filename))fail('公司帳套位置無法還原，請核對環境資料',409);
      const path=join(this.directory,row.filename);if(!existsSync(path))fail('公司資料庫檔案缺失，請從受控備份還原，不能建立空庫替代',409);
      this.cache.set(slug,new ERP(path));
    }return {slug,erp:this.cache.get(slug)};
  }
  create(context,u,b){
    permit(u,'admin');if(context.slug!=='default')fail('請從主要帳套建立公司／分店',403);
    const slug=txt(b.slug,32,true),name=txt(b.name,100,true),username=txt(b.username,50,true);
    if(!/^[a-z][a-z0-9-]{0,31}$/.test(slug)||slug==='default'||this.root.get('SELECT slug FROM company_catalog WHERE slug=?',slug))fail('公司代碼需為小寫英數連字號，且不可重複',409);
    if(!/^[\w.@-]{3,50}$/.test(username))fail('管理員帳號格式錯誤');hashPassword(b.password);
    const warehouseName=txt(b.warehouse_name||'主倉庫',100,true),warehouseCode=txt(b.warehouse_code||'WH01',40,true),filename='company-'+randomUUID()+'.sqlite';
    let company,path,created=false;
    try{
      if(this.directory){mkdirSync(this.directory,{recursive:true});path=join(this.directory,filename);writeFileSync(path,'',{flag:'wx',mode:0o600});created=true;}
      company=new ERP(path||':memory:');company.setup({username,password:b.password,name:txt(b.admin_name||'系統管理員',80,true),company:name});
      company.run('UPDATE warehouses SET code=?,name=? WHERE id=1',warehouseCode,warehouseName);
      this.root.tx(()=>{this.root.run('INSERT INTO company_catalog VALUES(?,?,?)',slug,name,filename);this.root.log(u,'create_company','company',slug,{name,warehouse_code:warehouseCode});});
      this.cache.set(slug,company);return {slug,name};
    }catch(error){company?.close();if(created)for(const suffix of ['','-wal','-shm'])rmSync(path+suffix,{force:true});throw error;}
  }
  grant(context,u,b){
    permit(u,'admin');if(context.slug==='default')fail('請登入要授權的公司帳套，再授權主要帳套使用者',409);
    const username=txt(b.root_username,50,true);
    if(!this.root.get('SELECT id FROM users WHERE username=? AND active=1',username))fail('找不到啟用的主要帳套帳號');
    if(b.enabled===false)context.erp.run('DELETE FROM company_summary_grants WHERE root_username=?',username);
    else context.erp.run('INSERT INTO company_summary_grants(root_username,include_cost) VALUES(?,?) ON CONFLICT(root_username) DO UPDATE SET include_cost=excluded.include_cost',username,b.include_cost===true?1:0);
    context.erp.log(u,'summary_grant','company',context.slug,{root_username:username,enabled:b.enabled!==false,include_cost:b.include_cost===true});return {root_username:username};
  }
  summary(context,u){
    permit(u,'finance');if(context.slug!=='default')fail('請從主要帳套查閱已授權的公司彙總',403);
    const rows=[];
    for(const company of this.list()){
      const e=this.resolve(company.slug).erp,grant=company.slug==='default'?{include_cost:has(u,'cost')}:e.get('SELECT * FROM company_summary_grants WHERE root_username=?',u.username);
      if(!grant)continue;
      const row={slug:company.slug,name:e.settings().company,currency:e.settings().currency||'TWD',sales_net:e.get("SELECT COALESCE(sum(f.net-COALESCE((SELECT sum(net) FROM returns WHERE fulfilment_id=f.id),0)-COALESCE((SELECT sum(net) FROM allowances WHERE fulfilment_id=f.id),0)),0) n FROM fulfilments f WHERE f.kind='shipment'").n};
      for(const [key,kind,state]of [['receivables','receivable','posted'],['payables','payable','posted'],['pending_receivables','receivable','pending'],['pending_payables','payable','pending']])row[key]=e.get('SELECT COALESCE(sum(amount-paid),0) n FROM open_items WHERE kind=? AND billing_state=?',kind,state).n+(state==='posted'?e.get('SELECT COALESCE(sum(amount-paid),0) n FROM opening_items WHERE kind=?',kind).n:0);
      row.foreign_receivables_base=e.get("SELECT COALESCE(sum(book_value),0) n FROM foreign_accounts WHERE kind='receivable' AND status='posted'").n;row.foreign_payables_base=e.get("SELECT COALESCE(sum(book_value),0) n FROM foreign_accounts WHERE kind='payable' AND status='posted'").n;row.receivables+=row.foreign_receivables_base;row.payables+=row.foreign_payables_base;
      if(grant.include_cost&&has(u,'cost')){row.inventory_value=e.get('SELECT COALESCE(sum(value),0) n FROM stocks').n;row.cost=e.get("SELECT COALESCE(sum(f.cost-COALESCE((SELECT sum(cost) FROM returns WHERE fulfilment_id=f.id),0)),0) n FROM fulfilments f WHERE f.kind='shipment'").n;}
      rows.push(row);
    }
    this.root.log(u,'read_company_summary','company','default',{companies:rows.map(r=>r.slug)});return {rows,note:'僅列各帳套明確授權的管理彙總；未抵銷內部交易，不等於法定合併報表。'};
  }
  data(context,u){return {company_info:{slug:context.slug,root:context.slug==='default'},company_catalog:this.list(),company_summary_grants:u.role==='admin'?context.erp.all('SELECT * FROM company_summary_grants'):undefined};}
  close(){for(const company of this.cache.values())company.close();this.cache.clear();}
}
