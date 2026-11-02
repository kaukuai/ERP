import { permit,has,fail,integer,txt,dateValue } from './core.mjs';
import { escapeHTML as E } from './print.mjs';
import { printPage } from './operations.mjs';

const roles=['admin','manager','sales','warehouse','finance','viewer'];
export const reportCatalog={
  documents:{name:'單據',fields:{no:'單號',kind:'類型',partner_name:'往來',warehouse_name:'倉庫',status:'狀態',date:'日期',due_date:'預定日期',net:'未稅',tax:'稅額',total:'合計',notes:'備註'}},
  fulfilments:{name:'出入庫',fields:{no:'出入庫單號',document_no:'來源單號',kind:'類型',partner_name:'往來',date:'日期',net:'未稅',tax:'稅額',total:'合計',cost:'成本'}},
  stocks:{name:'庫存',fields:{sku:'品號',name:'品名',warehouse_name:'倉庫',qty:'現存量',reserved:'預留量',available:'可用量',unit:'單位',value:'存貨金額'}},
  partners:{name:'往來主檔',fields:{code:'代號',name:'名稱',kind:'類型',contact:'聯絡人',phone:'電話',address:'地址',tax_id:'統編',payment_days:'付款天數'}},
};
const moneyFields=new Set(['net','tax','total','cost','value']),qtyFields=new Set(['qty','reserved','available']);
export class CustomReports {
  constructor(e){this.e=e;}
  definition(u,id,printing=false){
    permit(u,'all');const r=this.e.get('SELECT * FROM report_designs WHERE id=?',integer(id,1));if(!r)fail('報表不存在',404);
    for(const key of ['columns','view_roles','print_roles'])r[key]=JSON.parse(r[key]);
    if(!r.view_roles.includes(u.role)||(printing&&!r.print_roles.includes(u.role)))fail('沒有此報表的檢視或列印權限',403);return r;
  }
  save(u,b){
    permit(u,'admin');return this.e.tx(()=>{
      const old=b.id?this.e.get('SELECT * FROM report_designs WHERE id=?',integer(b.id,1)):null;
      if(b.id&&(!old||old.version!==integer(b.version,1)))fail('報表版型已更新或不存在',409);
      if(!Object.hasOwn(reportCatalog,b.dataset)||!Array.isArray(b.columns)||!b.columns.length||b.columns.length>16)fail('報表資料集或欄位錯誤');
      const seen=new Set(),columns=b.columns.map(c=>{if(!Object.hasOwn(reportCatalog[b.dataset].fields,c.key)||seen.has(c.key))fail('報表欄位重複或不支援');seen.add(c.key);return {key:c.key,label:txt(c.label||reportCatalog[b.dataset].fields[c.key],40,true)};});
      for(const key of ['view_roles','print_roles'])if(!Array.isArray(b[key])||new Set(b[key]).size!==b[key].length||b[key].some(r=>!roles.includes(r)))fail('報表角色設定錯誤');
      if(!b.view_roles.includes('admin')||b.print_roles.some(r=>!b.view_roles.includes(r)))fail('需保留管理員檢視權，列印角色必須也有檢視權');
      if(!['a4','a5'].includes(b.paper)||!['portrait','landscape'].includes(b.orientation))fail('紙型或方向錯誤');
      const vals=[txt(b.name,100,true),b.dataset,JSON.stringify(columns),JSON.stringify(b.view_roles),JSON.stringify(b.print_roles),b.paper,b.orientation];let id=old?.id;
      if(id)this.e.run('UPDATE report_designs SET name=?,dataset=?,columns=?,view_roles=?,print_roles=?,paper=?,orientation=?,version=version+1 WHERE id=?',...vals,id);
      else id=Number(this.e.run('INSERT INTO report_designs(name,dataset,columns,view_roles,print_roles,paper,orientation,created_by) VALUES(?,?,?,?,?,?,?,?)',...vals,u.id).lastInsertRowid);
      this.e.log(u,'save_report_design','report_design',id,{name:vals[0],columns});return this.definition(u,id);
    });
  }
  run(u,id,filters={},printing=false){
    const r=this.definition(u,id,printing);
    if(!has(u,'cost')&&r.columns.some(c=>['cost','value'].includes(c.key)))fail('此報表包含需要成本權限的欄位',403);
    if(r.dataset==='fulfilments'&&u.role==='sales')fail('沒有出入庫報表權限',403);
    const data=this.e.bootstrap(u);let rows=data[r.dataset]||[];
    if(filters.from||filters.to){if(!['documents','fulfilments'].includes(r.dataset))fail('此資料集不支援日期查詢');const from=dateValue(filters.from,'0001-01-01'),to=dateValue(filters.to,'9999-12-31');if(from>to)fail('起日不得晚於迄日');rows=rows.filter(row=>row.date>=from&&row.date<=to);}
    if(filters.kind)rows=rows.filter(row=>row.kind===filters.kind);
    if(filters.status)rows=rows.filter(row=>row.status===filters.status);
    if(filters.partner_id)rows=rows.filter(row=>row.partner_id===integer(filters.partner_id,1));
    return {design:r,rows:rows.map(row=>Object.fromEntries(r.columns.map(c=>[c.key,c.key==='available'?row.qty-row.reserved:row[c.key]??null]))),note:'依目前帳號可見資料查詢；單據上限 2,000 筆，出入庫上限 1,000 筆。'};
  }
  print(u,id,filters){
    const result=this.run(u,id,filters,true),r=result.design;
    const display=(key,value)=>value===null?'—':moneyFields.has(key)?(value/100).toFixed(2):qtyFields.has(key)?String(value/1000):String(value);
    this.e.log(u,'print_custom_report','report_design',r.id,{count:result.rows.length});
    return printPage(r.name,`<p>${E(result.note)}</p><table><thead><tr>${r.columns.map(c=>`<th>${E(c.label)}</th>`).join('')}</tr></thead><tbody>${result.rows.map(row=>`<tr>${r.columns.map(c=>`<td>${E(display(c.key,row[c.key]))}</td>`).join('')}</tr>`).join('')}</tbody></table>`,`@page{size:${r.paper.toUpperCase()} ${r.orientation}}`);
  }
  data(u){return {report_catalog:u.role==='admin'?reportCatalog:undefined,report_designs:this.e.all('SELECT * FROM report_designs ORDER BY name').filter(r=>JSON.parse(r.view_roles).includes(u.role)).map(r=>({...r,columns:JSON.parse(r.columns),view_roles:JSON.parse(r.view_roles),print_roles:JSON.parse(r.print_roles)}))};}
}
