import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localHome } from '../scripts/local.mjs';
import { packageLocal } from '../scripts/package-local.mjs';
import { acquireLocalLock } from '../src/local-lock.mjs';

test('local storage has stable per-user locations independent of the extracted program folder',()=>{
  const root=join(tmpdir(),'local-path-test'),profile=join(root,'profile'),appData=join(root,'appdata');
  assert.equal(localHome({LOCALAPPDATA:appData},'win32',profile),join(appData,'ERP-Local'));
  assert.equal(localHome({},'darwin',profile),join(profile,'Library','Application Support','ERP-Local'));
  assert.equal(localHome({XDG_DATA_HOME:appData},'linux',profile),join(appData,'ERP-Local'));
  assert.equal(localHome({ERP_LOCAL_HOME:root},'win32',profile),root);assert.throws(()=>localHome({ERP_LOCAL_HOME:'relative'}),/絕對路徑/);
});
test('local packaging refuses to delete unknown folders or packages containing retained business data',t=>{
  const folder=mkdtempSync(join(tmpdir(),'erp-package-guard-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));
  writeFileSync(join(folder,'keep.txt'),'保留');assert.throws(()=>packageLocal(folder),/拒絕清除/);
  writeFileSync(join(folder,'local-package.json'),'{}');mkdirSync(join(folder,'data'));writeFileSync(join(folder,'data/company.sqlite'),'保留資料');assert.throws(()=>packageLocal(folder),/拒絕清除/);
});
test('the local data lock rejects a second owner and becomes available again after release',t=>{
  const folder=mkdtempSync(join(tmpdir(),'erp-local-lock-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));
  const release=acquireLocalLock(join(folder,'company.sqlite'));try{assert.throws(()=>acquireLocalLock(join(folder,'company.sqlite')),/資料鎖/);}finally{release();}
  const next=acquireLocalLock(join(folder,'company.sqlite'));next();
});
