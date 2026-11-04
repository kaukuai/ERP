import { inflateRawSync } from 'node:zlib';
import { fail } from './core.mjs';

const crcTable=Array.from({length:256},(_,n)=>{for(let bit=0;bit<8;bit++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
const crc32=bytes=>{let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;};
function unzip(bytes){
  if(bytes.length<22||bytes.length>2*1024*1024)fail('Excel 檔案大小錯誤（上限 2 MB）');
  let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){end=i;break;}
  if(end<0||bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6))fail('不支援的 Excel 壓縮格式');
  const count=bytes.readUInt16LE(end+10),offset=bytes.readUInt32LE(end+16),entries=new Map();let at=offset,total=0;
  if(count>500||offset>=end)fail('Excel 內容過多或索引錯誤');
  for(let i=0;i<count;i++){
    if(at+46>end||bytes.readUInt32LE(at)!==0x02014b50)fail('Excel 壓縮索引損壞');
    const flags=bytes.readUInt16LE(at+8),method=bytes.readUInt16LE(at+10),crc=bytes.readUInt32LE(at+16),compressed=bytes.readUInt32LE(at+20),size=bytes.readUInt32LE(at+24),nameLen=bytes.readUInt16LE(at+28),extra=bytes.readUInt16LE(at+30),comment=bytes.readUInt16LE(at+32),local=bytes.readUInt32LE(at+42);
    const name=bytes.subarray(at+46,at+46+nameLen).toString('utf8');at+=46+nameLen+extra+comment;
    if(flags&1||![0,8].includes(method)||size>4*1024*1024||(total+=size)>12*1024*1024||at>end||local+30>offset||bytes.readUInt32LE(local)!==0x04034b50||entries.has(name))fail('Excel 壓縮內容不支援或已損壞');
    const start=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);
    if(start+compressed>offset)fail('Excel 壓縮資料超出範圍');
    let content;
    try{content=method===0?bytes.subarray(start,start+compressed):inflateRawSync(bytes.subarray(start,start+compressed),{maxOutputLength:4*1024*1024});}catch{fail('Excel 壓縮資料損壞');}
    if(content.length!==size||crc32(content)!==crc)fail('Excel 檔案校驗失敗');
    entries.set(name,content.toString('utf8'));
  }return entries;
}
const xmlText=text=>text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(_,entity)=>{
  if(entity.startsWith('#')){const n=entity[1].toLowerCase()==='x'?parseInt(entity.slice(2),16):Number(entity.slice(1));if(!Number.isInteger(n)||n<1||n>0x10ffff)fail('Excel 文字編碼錯誤');return String.fromCodePoint(n);}
  return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[entity.toLowerCase()];
});
function rowsToObjects(rows){
  if(rows.length<2||rows.length>2001)fail('請提供表頭及 1–2,000 列資料');
  const headers=rows[0].map(x=>String(x??'').trim().replace(/^\uFEFF/,''));
  if(!headers.length||headers.length>60||headers.some(x=>!x)||new Set(headers).size!==headers.length)fail('欄名不得空白或重複（上限 60 欄）');
  return rows.slice(1).filter(row=>row.some(x=>String(x??'').trim())).map(row=>{if(row.length>headers.length)fail('資料列欄數超過表頭');return Object.fromEntries(headers.map((h,i)=>[h,String(row[i]??'').trim()]));});
}
export function readCSV(text){
  if(typeof text!=='string'||text.length>2*1024*1024)fail('CSV 內容過大');
  const rows=[],row=[];let cell='',quoted=false,ended=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;ended=true;}}else cell+=c;}
    else if(c==='"'){if(cell||ended)fail('CSV 引號位置錯誤');quoted=true;}
    else if(c===','||c==='\n'||c==='\r'){row.push(cell);cell='';ended=false;if(c!==','){if(c==='\r'&&text[i+1]==='\n')i++;rows.push(row.splice(0));if(rows.length>2001)fail('CSV 最多 2,000 筆資料');}}
    else {if(ended&&!/\s/.test(c))fail('CSV 引號結束後有多餘文字');cell+=c;}
  }
  if(quoted)fail('CSV 引號未結束');if(cell||row.length){row.push(cell);rows.push(row);}
  return rowsToObjects(rows);
}
export function readXLSX(bytes){
  const entries=unzip(bytes);
  if(!entries.has('[Content_Types].xml')||!entries.has('xl/worksheets/sheet1.xml'))fail('請使用含第一張工作表的 .xlsx（不支援舊 .xls）');
  for(const xml of entries.values())if(/<!DOCTYPE|<!ENTITY/i.test(xml))fail('Excel 不允許外部實體宣告');
  if([...entries.keys()].some(name=>/vbaProject|\.bin$/i.test(name)))fail('不接受巨集或二進位工作簿');
  const shared=[...(entries.get('xl/sharedStrings.xml')||'').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m=>[...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x=>xmlText(x[1])).join(''));
  const sheet=entries.get('xl/worksheets/sheet1.xml');if((sheet.match(/<row\b/g)||[]).length>2001)fail('Excel 最多 2,000 筆資料');
  const rows=[];
  for(const row of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)){
    const values=[];
    for(const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)){
      const ref=/\br="([A-Z]+)\d+"/.exec(cell[1]);if(!ref)fail('Excel 儲存格缺少位置');
      let index=0;for(const ch of ref[1])index=index*26+ch.charCodeAt(0)-64;index--;
      if(index>=60)fail('工作表最多 60 欄');
      const content=cell[2]||'',type=/\bt="([^"]+)"/.exec(cell[1])?.[1];
      if(/<f\b/.test(content)||type==='e')fail('請以純值匯出 Excel；不接受公式或錯誤儲存格');
      const raw=/<v\b[^>]*>([\s\S]*?)<\/v>/.exec(content)?.[1]||'';
      let value;
      if(type==='s'){const n=Number(raw);if(!Number.isInteger(n)||!Object.hasOwn(shared,n))fail('Excel 字串索引錯誤');value=shared[n];}
      else if(type==='inlineStr')value=[...content.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m=>xmlText(m[1])).join('');
      else value=xmlText(raw);
      values[index]=value;
    }
    if(values.some(x=>x!==''))rows.push(Array.from({length:values.length},(_,i)=>values[i]??''));
    if(rows.length>2001)fail('Excel 最多 2,000 筆資料');
  }return rowsToObjects(rows);
}
export function excelDate(value){
  const s=String(value??'').trim();
  if(/^\d{1,7}$/.test(s)){const n=Number(s);if(n<1||n>2958465)fail('Excel 日期超出範圍');return new Date(Date.UTC(1899,11,30)+n*86400000).toISOString().slice(0,10);}
  return s;
}
