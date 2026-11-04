import { schemaVersion } from '../src/schema-version.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync,backup } from 'node:sqlite';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ERP } from '../src/core.mjs';
import { migrateV2 } from '../src/migrations.mjs';
import { migrateV3 } from '../src/migrate-v3.mjs';

test('v3 database copy migrates additively, preserves every old column and row, and reopens without reapplying migrations',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'erp-migration-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'original.sqlite'),copy=join(dir,'copy.sqlite'),db=new DatabaseSync(path);
  db.exec(readFileSync(new URL('../src/schema.sql',import.meta.url),'utf8'));
  db.prepare("INSERT INTO settings VALUES('schema_version','1')").run();migrateV2(db);migrateV3(db);
  db.exec(`INSERT INTO users(id,username,name,password,role,created_at) VALUES(1,'admin','管理員','test-only-unused-hash','admin','2026-01-01');
    INSERT INTO warehouses(id,code,name) VALUES(1,'WH01','主倉');
    INSERT INTO partners(id,code,name,kind) VALUES(1,'C','舊客戶','customer');
    INSERT INTO products(id,sku,name) VALUES(1,'P','舊商品');
    INSERT INTO documents(id,no,kind,partner_id,warehouse_id,owner_id,date,due_date,net,tax,total,partner_snapshot,created_at,updated_at) VALUES(1,'OLD-SO','order',1,1,1,'2026-01-01','2026-01-01',100,5,105,'{}','2026-01-01','2026-01-01');
    INSERT INTO document_lines(document_id,product_id,sku,name,spec,unit,qty,price,amount) VALUES(1,1,'P','舊商品','','個',1000,100,100);
    INSERT INTO audit(actor_id,action,entity,entity_id,detail,created_at) VALUES(1,'old_action','document','1','{}','2026-01-01');`);
  const snapshots=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(({name})=>{
    const cols=db.prepare(`PRAGMA table_info("${name}")`).all().map(c=>'"'+c.name+'"').join(','),max=db.prepare(`SELECT COALESCE(max(rowid),0) n FROM "${name}"`).get().n;
    const sql=`SELECT ${cols} FROM "${name}" WHERE rowid<=${max}`+(name==='settings'?" AND key<>'schema_version'":'')+' ORDER BY rowid';
    return {sql,rows:JSON.stringify(db.prepare(sql).all())};
  });
  await backup(db,copy);db.close();
  let migrated=new ERP(copy);
  for(const snapshot of snapshots)assert.equal(JSON.stringify(migrated.all(snapshot.sql)),snapshot.rows);
  assert.equal(migrated.settings().schema_version,String(schemaVersion));assert.deepEqual(migrated.all('PRAGMA foreign_key_check'),[]);migrated.close();
  migrated=new ERP(copy);assert.equal(migrated.get('SELECT no FROM documents WHERE id=1').no,'OLD-SO');migrated.close();
  const original=new DatabaseSync(path,{readOnly:true});assert.equal(original.prepare("SELECT value FROM settings WHERE key='schema_version'").get().value,'3');original.close();
});
