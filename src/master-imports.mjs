import { createHash } from 'node:crypto';
import { permit,fail,integer,txt } from './core.mjs';
import { readCSV,readXLSX } from './tabular.mjs';

export const importFields={
  products:['sku','name','spec','category','unit','barcode','invoice_name','price','cost','safety_qty'],
  partners:['code','name','kind','contact','phone','email','tax_id','address','payment_days','credit_limit','notes'],
  opening_stock:['sku','warehouse_code','qty','unit_cost'],
};
const required={products:['sku','name'],partners:['code','name'],opening_stock:['sku','warehouse_code','qty']};
function configuration(kind,columns,defaults={}){
  if(!Object.hasOwn(importFields,kind))fail('匯入類型錯誤');
  for(const [value,label]of [[columns,'欄位映射'],[defaults,'固定值']])if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!importFields[kind].includes(key)))fail(label+'含未支援的欄位');
  const mapped=Object.fromEntries(Object.entries(columns).map(([key,value])=>[key,txt(value,100,true)]));
  const fixed=Object.fromEntries(Object.entries(defaults).map(([key,value])=>[key,txt(value,2000)]));
  if(new Set(Object.values(mapped)).size!==Object.keys(mapped).length)fail('來源欄位不可重複映射');
  if(Object.keys(fixed).some(key=>Object.hasOwn(mapped,key)))fail('同欄不能同時映射及設定固定值');
  if(required[kind].some(key=>!mapped[key]&&!fixed[key]))fail('請設定必要欄位：'+required[kind].join('、'));
  return {columns:mapped,defaults:fixed};
}
export class MasterImports {
  constructor(e){this.e=e;}
  data(u){if(u.role!=='admin')return {};return {master_import_fields:importFields,master_import_templates:this.e.all('SELECT * FROM master_import_templates ORDER BY kind,name').map(row=>({...row,columns:JSON.parse(row.columns),defaults:JSON.parse(row.defaults)}))};}
  save(u,b){permit(u,'admin');return this.e.tx(()=>{
    const config=configuration(b.kind,b.columns,b.defaults),name=txt(b.name,100,true);
    const old=b.id?this.e.get('SELECT * FROM master_import_templates WHERE id=?',integer(b.id,1)):null;
    if(b.id&&(!old||old.version!==integer(b.version,1)))fail('匯入範本已變更，請重新讀取',409);
    if(old&&old.kind!==b.kind)fail('不可更換既有範本的匯入類型',409);
    let id=old?.id;
    if(id)this.e.run('UPDATE master_import_templates SET name=?,columns=?,defaults=?,version=version+1 WHERE id=?',name,JSON.stringify(config.columns),JSON.stringify(config.defaults),id);
    else id=Number(this.e.run('INSERT INTO master_import_templates(kind,name,columns,defaults) VALUES(?,?,?,?)',b.kind,name,JSON.stringify(config.columns),JSON.stringify(config.defaults)).lastInsertRowid);
    this.e.log(u,'save_master_import_template','master_import_template',id,{kind:b.kind,name});return {id};
  });}
  preview(u,b){permit(u,'admin');return this.e.tx(()=>{
    const template=this.e.get('SELECT * FROM master_import_templates WHERE id=?',integer(b.template_id,1));if(!template)fail('匯入範本不存在',404);
    let rows,bytes;
    if(b.format==='csv'){if(typeof b.text!=='string')fail('CSV 格式錯誤');const text=b.text;bytes=Buffer.from(text,'utf8');if(bytes.length>1500000)fail('CSV 請小於 1.5 MB');rows=readCSV(text);}
    else if(b.format==='xlsx'){
      if(typeof b.base64!=='string'||b.base64.length>1400000||b.base64.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(b.base64))fail('XLSX 檔案編碼錯誤或超過 1 MB');
      bytes=Buffer.from(b.base64,'base64');if(bytes.length>1048576)fail('XLSX 請小於 1 MB');rows=readXLSX(bytes);
    }else fail('僅支援 UTF-8 CSV 或純值 XLSX');
    if(!rows.length)fail('檔案沒有資料列');
    const config=configuration(template.kind,JSON.parse(template.columns),JSON.parse(template.defaults));
    const headers=Object.keys(rows[0]),missing=Object.values(config.columns).filter(key=>!headers.includes(key));
    if(missing.length)fail('來源缺少欄位：'+missing.join('、'));
    const hash=createHash('sha256').update(bytes).digest('hex');
    this.checkDuplicate(template.kind,hash);
    const canonical=rows.map(row=>({...config.defaults,...Object.fromEntries(Object.entries(config.columns).map(([target,source])=>[target,row[source]]))}));
    const result=this.e.importPreview(u,{kind:template.kind,rows:canonical});
    this.e.run('INSERT INTO master_import_sources VALUES(?,?,?,?,?,?)',result.id,template.id,template.version,hash,b.format,JSON.stringify({name:template.name,kind:template.kind,...config}));
    return {...result,rows:canonical.slice(0,30),template_name:template.name,template_version:template.version,source_hash:hash,format:b.format};
  });}
  checkDuplicate(kind,hash){if(this.e.get("SELECT s.import_id FROM master_import_sources s JOIN imports i ON i.id=s.import_id WHERE i.kind=? AND s.source_hash=? AND i.status='committed'",kind,hash))fail('相同檔案已完成此類型匯入，請核對匯入紀錄',409);}
  commit(u,id){permit(u,'admin');return this.e.tx(()=>{
    const source=this.e.get('SELECT s.*,i.kind,t.version current_version FROM master_import_sources s JOIN imports i ON i.id=s.import_id JOIN master_import_templates t ON t.id=s.template_id WHERE s.import_id=?',integer(id,1));
    if(source){if(source.template_version!==source.current_version)fail('範本已變更，請重新上傳預覽',409);this.checkDuplicate(source.kind,source.source_hash);}
    return this.e.importCommit(u,id);
  });}
}
