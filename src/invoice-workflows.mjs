import { createHash } from 'node:crypto';
import { permit,has,fail,integer,scaled,txt,dateValue,now } from './core.mjs';
import { printPage } from './operations.mjs';
import { escapeHTML as E } from './print.mjs';
import { readCSV } from './tabular.mjs';

const exchangeFields=['invoice_no','date','buyer_tax_id','net','tax','total','provider_ref'];
const csvCell=v=>'"'+String(typeof v==='string'&&/^[=+\-@\t\r\n]/.test(v)?"'"+v:v).replaceAll('"','""')+'"';
export class InvoiceWorkflows {
  constructor(e){this.e=e;}
  addRanges(u,b){
    permit(u,'finance');return this.e.tx(()=>{
      const rows=b.rows||[b];if(!Array.isArray(rows)||!rows.length||rows.length>200)fail('請提供 1–200 筆字軌區間');const ids=[];
      for(const r of rows){
        const year=integer(r.year,2000,2200),month=integer(r.start_month,1,12),letters=txt(r.letters,2,true).toUpperCase(),start=integer(r.start_no,0,99999999),end=integer(r.end_no,start,99999999);
        if(month%2!==1||!/^[A-Z]{2}$/.test(letters))fail('發票字軌為兩碼英文字母，期別起月須為單數月');
        if(this.e.get('SELECT id FROM invoice_ranges WHERE year=? AND start_month=? AND letters=? AND start_no<=? AND end_no>=?',year,month,letters,end,start))fail('字軌區間與既有資料重疊',409);
        const id=Number(this.e.run('INSERT INTO invoice_ranges(year,start_month,letters,start_no,end_no,created_by) VALUES(?,?,?,?,?,?)',year,month,letters,start,end,u.id).lastInsertRowid);ids.push(id);this.e.log(u,'register_invoice_range','invoice_range',id,{year,month,letters,start,end});
      }return {ids,count:ids.length};
    });
  }
  range(id){const range=this.e.get('SELECT * FROM invoice_ranges WHERE id=?',integer(id,1));if(!range)fail('字軌區間不存在',404);return range;}
  numberAction(u,b){
    permit(u,'finance');return this.e.tx(()=>{
      const range=this.range(b.range_id),number=integer(b.number,range.start_no,range.end_no),reason=txt(b.reason,1000,true),old=this.e.get('SELECT * FROM invoice_numbers WHERE range_id=? AND number=?',range.id,number);let id;
      if(b.action==='reserve'){
        if(old)fail('號碼已保留、使用或作廢，不得重複使用',409);
        id=Number(this.e.run("INSERT INTO invoice_numbers(range_id,number,status,reason,created_by) VALUES(?,?,'reserved',?,?)",range.id,number,reason,u.id).lastInsertRowid);
      }else if(b.action==='void'){
        if(old?.status==='used')fail('已使用發票須透過正式加值中心作廢流程，不能只改本地狀態',409);
        if(old?.status==='void')fail('號碼已作廢',409);
        if(old){id=old.id;this.e.run("UPDATE invoice_numbers SET status='void',reason=? WHERE id=?",reason,id);}
        else id=Number(this.e.run("INSERT INTO invoice_numbers(range_id,number,status,reason,created_by) VALUES(?,?,'void',?,?)",range.id,number,reason,u.id).lastInsertRowid);
      }else fail('字軌操作錯誤');
      this.e.run('INSERT INTO invoice_number_events(number_id,action,reason,created_by,created_at) VALUES(?,?,?,?,?)',id,b.action,reason,u.id,now());this.e.log(u,'invoice_number_'+b.action,'invoice_number',id,{reason});return {id,invoice_no:range.letters+String(number).padStart(8,'0')};
    });
  }
  blanks(u,id){
    permit(u,'finance');const range=this.range(id),numbers=this.e.all('SELECT * FROM invoice_numbers WHERE range_id=? ORDER BY number',range.id),blanks=[];let next=range.start_no;
    for(const r of numbers){if(r.number>next)blanks.push({from:next,to:r.number-1});next=r.number+1;}
    if(next<=range.end_no)blanks.push({from:next,to:range.end_no});
    return {range,numbers,blanks,unused_count:blanks.reduce((n,r)=>n+r.to-r.from+1,0)};
  }
  printProfile(u,b){
    permit(u,'admin');return this.e.tx(()=>{
      const old=b.id?this.e.get('SELECT * FROM invoice_print_profiles WHERE id=?',integer(b.id,1)):null;
      if(b.id&&(!old||old.version!==integer(b.version,1)))fail('列印設定已更新或不存在',409);
      if(!['a4','a5','receipt'].includes(b.paper))fail('列印紙型錯誤');
      const donation=txt(b.donation_code,7);if(donation&&!/^\d{3,7}$/.test(donation))fail('捐贈碼需為 3–7 碼數字');
      const logo=txt(b.logo??old?.logo??'',100000);
      if(logo){const m=/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(logo);if(!m)fail('抬頭圖請使用 PNG／JPEG，最大 64 KB');const raw=Buffer.from(m[2],'base64');if(raw.length>65536||(m[1]==='png'?!raw.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):!(raw[0]===255&&raw[1]===216&&raw[2]===255)))fail('抬頭圖內容或大小錯誤');}
      const vals=[txt(b.name,100,true),b.paper,integer(b.width??80,40,297),integer(b.height??200,40,420),txt(b.device_name,100),logo,donation,txt(b.footer,500)];let id=old?.id;
      if(id)this.e.run('UPDATE invoice_print_profiles SET name=?,paper=?,width=?,height=?,device_name=?,logo=?,donation_code=?,footer=?,version=version+1 WHERE id=?',...vals,id);
      else id=Number(this.e.run('INSERT INTO invoice_print_profiles(name,paper,width,height,device_name,logo,donation_code,footer) VALUES(?,?,?,?,?,?,?,?)',...vals).lastInsertRowid);
      this.e.log(u,'save_invoice_print_profile','invoice_print_profile',id,{name:vals[0],device:vals[4]});return {id};
    });
  }
  proof(u,id){
    permit(u,'finance');const p=this.e.get('SELECT * FROM invoice_print_profiles WHERE id=?',integer(id,1));if(!p)fail('列印設定不存在',404);
    const settings=this.e.settings();return printPage('發票列印設定校樣（非正式憑證）',`${p.logo?`<img alt="公司抬頭圖" src="${E(p.logo)}" style="max-width:100%;max-height:25mm">`:''}<p>${E(settings.company)} · ${E(settings.tax_id)}</p><p>設備：${E(p.device_name)}<br>測試號碼：XX00000000<br>測試品項：列印比例與繁體中文字形核對<br>捐贈碼：${E(p.donation_code||'未設定')}</p><p>${E(p.footer)}</p><p>本頁僅為設定校樣，不是發票證明聯，也不表示設備或正式開票服務已連線。</p>`,`@page{size:${p.paper==='receipt'?p.width+'mm '+p.height+'mm':p.paper.toUpperCase()}}`);
  }
  exchangeProfile(u,b){
    permit(u,'admin');return this.e.tx(()=>{
      if(!b.columns||exchangeFields.some(k=>!txt(b.columns[k],100,true))||new Set(Object.values(b.columns)).size!==exchangeFields.length||Object.keys(b.columns).some(k=>!exchangeFields.includes(k)))fail('請完整設定七項欄位且不可重複');
      if(![',','\t','|'].includes(b.delimiter))fail('分隔符僅支援逗號、Tab 或直線');
      const old=b.id?this.e.get('SELECT * FROM invoice_exchange_profiles WHERE id=?',integer(b.id,1)):null;if(b.id&&(!old||old.version!==integer(b.version,1)))fail('交換設定已更新',409);
      const vals=[txt(b.name,100,true),txt(b.spec_version,100,true),JSON.stringify(b.columns),b.delimiter];let id=old?.id;
      if(id)this.e.run('UPDATE invoice_exchange_profiles SET name=?,spec_version=?,columns=?,delimiter=?,version=version+1 WHERE id=?',...vals,id);
      else id=Number(this.e.run('INSERT INTO invoice_exchange_profiles(name,spec_version,columns,delimiter) VALUES(?,?,?,?)',...vals).lastInsertRowid);
      this.e.log(u,'save_invoice_exchange_profile','invoice_exchange_profile',id,{name:vals[0],spec_version:vals[1]});return {id};
    });
  }
  canonical(u,profile,raw){
    const columns=JSON.parse(profile.columns),seen=new Set(),rows=[],errors=[];
    if(!Array.isArray(raw)||!raw.length||raw.length>2000)fail('請提供 1–2,000 筆外部發票紀錄');
    raw.forEach((r,index)=>{try{
      const val=k=>txt(String(r[columns[k]]??''),200),invoice_no=val('invoice_no').toUpperCase(),date=dateValue(val('date')),buyer=val('buyer_tax_id');
      if(!/^[A-Z]{2}\d{8}$/.test(invoice_no)||seen.has(invoice_no))fail('發票號碼格式錯誤或重複');seen.add(invoice_no);
      if(buyer&&!/^\d{8}$/.test(buyer))fail('買受人統編格式錯誤');
      const net=scaled(val('net')),tax=scaled(val('tax')),total=scaled(val('total'));if(net+tax!==total)fail('未稅＋稅額不等於合計');
      const number=Number(invoice_no.slice(2)),month=Number(date.slice(5,7)),range=this.e.get('SELECT * FROM invoice_ranges WHERE year=? AND start_month=? AND letters=? AND start_no<=? AND end_no>=?',Number(date.slice(0,4)),month%2?month:month-1,invoice_no.slice(0,2),number,number);
      if(!range)fail('發票日期／號碼不在已登錄字軌中');
      const old=this.e.get('SELECT * FROM invoice_numbers WHERE range_id=? AND number=?',range.id,number);if(old&&old.status!=='reserved')fail('發票號碼已使用或作廢');
      rows.push({invoice_no,date,buyer_tax_id:buyer,net,tax,total,provider_ref:txt(val('provider_ref'),200,true),range_id:range.id,number});
    }catch(error){errors.push({row:index+2,message:error.message});}});return {rows,errors};
  }
  preview(u,b){
    permit(u,'finance');return this.e.tx(()=>{
      const p=this.e.get('SELECT * FROM invoice_exchange_profiles WHERE id=?',integer(b.profile_id,1));if(!p)fail('交換設定不存在',404);
      let raw=b.rows;if(b.text!==undefined){const text=txt(b.text,1000000,true);raw=p.delimiter===','?readCSV(text):this.delimited(text,p.delimiter);}
      const result=this.canonical(u,p,raw),total=result.rows.reduce((n,r)=>n+r.total,0);
      if(integer(b.expected_count,1,2000)!==raw.length)result.errors.push({row:0,message:'宣告筆數與檔案筆數不符'});
      if(scaled(b.expected_total)!==total)result.errors.push({row:0,message:'宣告合計金額與有效紀錄不符'});
      const source_hash=createHash('sha256').update(JSON.stringify(raw)).digest('hex'),id=Number(this.e.run('INSERT INTO invoice_exchange_jobs(profile_id,profile_version,rows,errors,source_hash,created_by,created_at) VALUES(?,?,?,?,?,?,?)',p.id,p.version,JSON.stringify(raw),JSON.stringify(result.errors),source_hash,u.id,now()).lastInsertRowid);
      return {id,rows:result.rows,errors:result.errors,count:raw.length,total,spec_version:p.spec_version,source_hash,notice:'只匯入外部既有紀錄；未連線驗證加值中心回執或當期官方交換格式。'};
    });
  }
  delimited(text,delimiter){const lines=text.replace(/^\uFEFF/,'').trim().split(/\r?\n/),headers=lines.shift().split(delimiter);if(new Set(headers).size!==headers.length)fail('交換檔欄名重複');return lines.map(line=>{const values=line.split(delimiter);if(values.length!==headers.length)fail('TXT 交換檔欄數錯誤');return Object.fromEntries(headers.map((h,i)=>[h,values[i]]));});}
  commit(u,id){
    permit(u,'finance');return this.e.tx(()=>{
      const e=this.e,job=e.get('SELECT * FROM invoice_exchange_jobs WHERE id=?',integer(id,1));if(!job||job.status!=='preview')fail('交換批次不存在或已匯入',409);
      if(JSON.parse(job.errors).length)fail('請先修正預覽錯誤');const profile=e.get('SELECT * FROM invoice_exchange_profiles WHERE id=?',job.profile_id),result=this.canonical(u,profile,JSON.parse(job.rows));
      if(profile.version!==job.profile_version||result.errors.length)fail('格式設定或號碼狀態已改變，請重新預覽',409);
      for(const r of result.rows){let number=e.get('SELECT id FROM invoice_numbers WHERE range_id=? AND number=?',r.range_id,r.number);
        if(!number)number={id:Number(e.run("INSERT INTO invoice_numbers(range_id,number,status,reason,created_by) VALUES(?,?,'used',?,?)",r.range_id,r.number,'匯入外部發票紀錄',u.id).lastInsertRowid)};
        else e.run("UPDATE invoice_numbers SET status='used' WHERE id=?",number.id);
        e.run('INSERT INTO invoice_records(number_id,invoice_no,date,buyer_tax_id,net,tax,total,provider_ref,job_id,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',number.id,r.invoice_no,r.date,r.buyer_tax_id,r.net,r.tax,r.total,r.provider_ref,job.id,u.id,now());
        e.run('INSERT INTO invoice_number_events(number_id,action,reason,created_by,created_at) VALUES(?,?,?,?,?)',number.id,'import_external_record',r.provider_ref,u.id,now());
      }
      e.run("UPDATE invoice_exchange_jobs SET status='committed' WHERE id=?",job.id);e.log(u,'import_invoice_records','invoice_exchange_job',job.id,{count:result.rows.length,source_hash:job.source_hash});return {id:job.id,count:result.rows.length};
    });
  }
  export(u,id){
    permit(u,'finance');const p=this.e.get('SELECT * FROM invoice_exchange_profiles WHERE id=?',integer(id,1));if(!p)fail('交換設定不存在',404);
    const columns=JSON.parse(p.columns),rows=this.e.all('SELECT * FROM invoice_records ORDER BY date,id'),format=r=>exchangeFields.map(k=>['net','tax','total'].includes(k)?(r[k]/100).toFixed(2):r[k]);
    const cells=[exchangeFields.map(k=>columns[k]),...rows.map(format)],content=p.delimiter===','?cells.map(row=>row.map(csvCell).join(',')).join('\r\n'):cells.map(row=>row.map(value=>{const s=String(value);if(s.includes(p.delimiter)||/[\r\n]/.test(s))fail('TXT 欄位包含分隔字元，請改用 CSV');return s;}).join(p.delimiter)).join('\r\n');
    return {spec_version:p.spec_version,count:rows.length,total:rows.reduce((n,r)=>n+r.total,0),content,notice:'此為已設定欄位的資料交換檔；正式上傳須依當期官方或加值中心規格另行驗證。'};
  }
  data(u){if(!has(u,'finance'))return {};return {invoice_ranges:this.e.all('SELECT * FROM invoice_ranges ORDER BY year DESC,start_month DESC,letters,start_no'),invoice_print_profiles:this.e.all('SELECT id,name,paper,width,height,device_name,donation_code,footer,version FROM invoice_print_profiles'),invoice_exchange_profiles:this.e.all('SELECT * FROM invoice_exchange_profiles').map(p=>({...p,columns:JSON.parse(p.columns)})),invoice_records:this.e.all('SELECT * FROM invoice_records ORDER BY id DESC LIMIT 2000')};}
}
