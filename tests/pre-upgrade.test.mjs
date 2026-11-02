import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,existsSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ERP } from '../src/core.mjs';
import { Companies } from '../src/companies.mjs';

test('upgrade backup validates the root and every company on copies while leaving live databases unchanged',t=>{
  const directory=mkdtempSync(join(tmpdir(),'erp-pre-upgrade-')),path=join(directory,'root.sqlite'),e=new ERP(path),u=e.setup({username:'admin',password:'upgrade-test-password-2026'}),companies=new Companies(e,path);
  t.after(()=>{companies.close();e.close();rmSync(directory,{recursive:true,force:true});});
  companies.create({slug:'default',erp:e},u,{slug:'branch',name:'測試分店',username:'admin',password:'branch-upgrade-test-2026'});
  const branch=companies.resolve('branch').erp;branch.savePartner(branch.user(1),{code:'C',name:'保留客戶'});
  const before=JSON.stringify(e.settings()),branchBefore=JSON.stringify(branch.all('SELECT * FROM partners'));
  const childEnv={...process.env};delete childEnv.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,['scripts/pre-upgrade.mjs','--db',path,'--all-companies'],{cwd:new URL('..',import.meta.url),encoding:'utf8',env:childEnv});
  assert.ifError(result.error);assert.equal(result.status,0,result.stderr);assert.ok(result.stdout.trim(),'CLI must report its completed backups');const report=JSON.parse(result.stdout);assert.equal(report.databases.length,2);
  for(const database of report.databases){assert.equal(database.schema,'11');assert.equal(database.existing_rows_preserved,true);assert.equal(database.integrity,true);assert.ok(existsSync(database.backup));const metadata=JSON.parse(readFileSync(database.backup+'.json','utf8'));assert.equal(metadata.existing_rows_preserved,true);}
  assert.equal(JSON.stringify(e.settings()),before);assert.equal(JSON.stringify(branch.all('SELECT * FROM partners')),branchBefore);
});
test('opening a newer schema fails before any old schema tables or journal-mode changes are written',t=>{
  const directory=mkdtempSync(join(tmpdir(),'erp-newer-schema-')),path=join(directory,'newer.sqlite');t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const db=new DatabaseSync(path);db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO settings VALUES('schema_version','99');");db.close();
  assert.throws(()=>new ERP(path),/版本比程式新/);
  const after=new DatabaseSync(path,{readOnly:true});assert.deepEqual(after.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name),['settings']);assert.equal(after.prepare('PRAGMA journal_mode').get().journal_mode,'delete');after.close();
});
