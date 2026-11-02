// Online backup; validate the current migrations on disposable copies only.
import { DatabaseSync,backup } from 'node:sqlite';
import { mkdirSync,copyFileSync,unlinkSync,existsSync,writeFileSync } from 'node:fs';
import { resolve,join,dirname,basename } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { ERP } from '../src/core.mjs';
const root=resolve(import.meta.dirname,'..'),args=process.argv.slice(2);
let sourcePath=join(root,'data','company.sqlite'),allCompanies=false;
for(let i=0;i<args.length;i++){
  if(args[i]==='--db'){if(!args[i+1]||args[i+1].startsWith('--'))throw Error('--db requires a local SQLite path');sourcePath=resolve(args[++i]);}
  else if(args[i]==='--all-companies')allCompanies=true;
  else if(['company','demo'].includes(args[i]))sourcePath=join(root,'data',args[i]+'.sqlite');
  else throw Error('Usage: node scripts/pre-upgrade.mjs [company|demo|--db PATH] [--all-companies]');
}
if(!existsSync(sourcePath))throw Error('Source database does not exist; no empty replacement will be created');
const jobs=[sourcePath];
if(allCompanies){
  const source=new DatabaseSync(sourcePath,{readOnly:true});
  try{
    if(source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='company_catalog'").get())for(const company of source.prepare('SELECT filename FROM company_catalog ORDER BY slug').all()){
      if(!/^company-[0-9a-f-]{36}\.sqlite$/.test(company.filename))throw Error('Invalid company catalogue filename');
      const path=join(dirname(sourcePath),'.company-workspaces',company.filename);
      if(!existsSync(path))throw Error('A company database is missing; restore it before upgrading');jobs.push(path);
    }
  }finally{source.close();}
}
const digest=rows=>createHash('sha256').update(JSON.stringify(rows)).digest('hex'),quote=name=>'"'+name.replaceAll('"','""')+'"',reports=[];
for(const path of jobs){
  const stamp=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8),directory=join(dirname(path),'backups'),label=basename(path).replace(/[^\w.-]/g,'_');mkdirSync(directory,{recursive:true});
  const target=join(directory,`${label}-before-v04-${stamp}.sqlite`),copy=join(directory,`${label}-migration-validation-${stamp}.sqlite`);
  const source=new DatabaseSync(path,{readOnly:true});try{await backup(source,target);}finally{source.close();}
  const before=new DatabaseSync(target,{readOnly:true});let snapshots;
  try{
    snapshots=before.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>{
      const columns=before.prepare(`PRAGMA table_info(${quote(name)})`).all().map(c=>quote(c.name)),max=before.prepare(`SELECT COALESCE(max(rowid),0) n FROM ${quote(name)}`).get().n;
      const sql=`SELECT ${columns.join(',')} FROM ${quote(name)} WHERE rowid<=${max}`+(name==='settings'?" AND key<>'schema_version'":'')+' ORDER BY rowid',rows=before.prepare(sql).all();return {name,sql,count:rows.length,hash:digest(rows)};
    });
  }finally{before.close();}
  copyFileSync(target,copy);let e;
  try{
    e=new ERP(copy);
    for(const table of snapshots)if(digest(e.all(table.sql))!==table.hash)throw Error('Migration changed existing rows: '+table.name);
    const integrity=e.integrity({role:'admin'});if(!integrity.ok)throw Error('Migration copy failed integrity: '+JSON.stringify(integrity.problems));
    const report={backup:target,schema:e.settings().schema_version,preserved_tables:snapshots.map(({name,count})=>({name,count})),existing_rows_preserved:true,integrity:true};
    writeFileSync(target+'.json',JSON.stringify(report,null,2));reports.push(report);
  }finally{e?.close();for(const suffix of ['','-wal','-shm'])if(existsSync(copy+suffix))unlinkSync(copy+suffix);}
}
console.log(JSON.stringify(reports.length===1?reports[0]:{databases:reports,validated_on_copies:true,source_databases_unchanged:true}));
