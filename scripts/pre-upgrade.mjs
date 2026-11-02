// Backup a live local database; validate migration on a disposable COPY first.
import { DatabaseSync,backup } from 'node:sqlite';
import { mkdirSync,copyFileSync,unlinkSync,existsSync,writeFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { createHash } from 'node:crypto';
import { ERP } from '../src/core.mjs';
const root=resolve(import.meta.dirname,'..'),name=process.argv[2]||'company';
if(!['company','demo'].includes(name))throw Error('Only company or demo is supported');
const stamp=new Date().toISOString().replace(/[:.]/g,'-'),dir=join(root,'data','backups');mkdirSync(dir,{recursive:true});
const source=new DatabaseSync(join(root,'data',name+'.sqlite'),{readOnly:true}),target=join(dir,`${name}-before-v03-${stamp}.sqlite`);
await backup(source,target);source.close();
const before=new DatabaseSync(target,{readOnly:true}),tables=before.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
const digest=rows=>createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const snapshots=tables.map(({name})=>{const cols=before.prepare(`PRAGMA table_info(${name})`).all().map(c=>c.name),max=before.prepare(`SELECT COALESCE(max(rowid),0) n FROM "${name}"`).get().n,sql=`SELECT ${cols.map(c=>'"'+c+'"').join(',')} FROM "${name}" WHERE rowid<=${max}`+(name==='settings'?" AND key<>'schema_version'":'')+' ORDER BY rowid',rows=before.prepare(sql).all();return {name,sql,count:rows.length,hash:digest(rows)};});before.close();
const copy=join(dir,`${name}-migration-validation-${stamp}.sqlite`);copyFileSync(target,copy);let e;
try{e=new ERP(copy);for(const t of snapshots)if(digest(e.all(t.sql))!==t.hash)throw Error('Migration changed existing rows: '+t.name);const admin=e.get("SELECT id,role,name,active FROM users WHERE role='admin' AND active=1 LIMIT 1");const integrity=admin?e.integrity(admin):{ok:true,problems:[]};if(!integrity.ok)throw Error('Migration copy failed integrity: '+JSON.stringify(integrity.problems));const report={backup:target,schema:e.settings().schema_version,preserved_tables:snapshots.map(({name,count})=>({name,count})),existing_rows_preserved:true,integrity:integrity.ok};writeFileSync(target+'.json',JSON.stringify(report,null,2));console.log(JSON.stringify({backup:target,schema:report.schema,existing_rows_preserved:true,integrity:report.integrity}));}
finally{e?.close();for(const suffix of ['','-wal','-shm'])if(existsSync(copy+suffix))unlinkSync(copy+suffix);}
