import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { ERP } from '../src/core.mjs';
import { Companies,companyContext,companyProxy } from '../src/companies.mjs';

function fixture(t,persistent=false){
  const directory=persistent?mkdtempSync(join(tmpdir(),'erp-companies-')):null,path=directory?join(directory,'root.sqlite'):':memory:',root=new ERP(path),u=root.setup({username:'rootadmin',password:'root-company-tests-2026',company:'主要帳套'}),companies=new Companies(root,path),context={slug:'default',erp:root};
  t.after(()=>{companies.close();root.close();if(directory)rmSync(directory,{recursive:true,force:true});});
  const create=(slug)=>companies.create(context,u,{slug,name:'公司 '+slug,username:'localadmin',password:'local-company-tests-2026',warehouse_code:'MAIN',warehouse_name:'公司主倉'});
  return {root,u,companies,context,create,directory};
}
test('company creation isolates users, warehouses, products, transactions and proxy state across async contexts',async t=>{
  const {root,companies,create}=fixture(t);create('alpha');create('beta');
  const a=companies.resolve('alpha'),b=companies.resolve('beta'),proxy=companyProxy(root);
  const localA=a.erp.get("SELECT id,username,role FROM users WHERE username='localadmin'"),localB=b.erp.get("SELECT id,username,role FROM users WHERE username='localadmin'");
  await Promise.all([
    companyContext.run(a,async()=>{await setTimeout(5);proxy.saveProduct(localA,{sku:'SAME',name:'公司 A 商品',price:'10',cost:'4'});proxy.inventorySelection={company:'alpha'};await setTimeout(5);assert.equal(proxy.inventorySelection.company,'alpha');}),
    companyContext.run(b,async()=>{proxy.saveProduct(localB,{sku:'SAME',name:'公司 B 商品',price:'20',cost:'8'});proxy.inventorySelection={company:'beta'};await setTimeout(15);assert.equal(proxy.inventorySelection.company,'beta');}),
  ]);
  assert.equal(a.erp.get('SELECT name FROM products').name,'公司 A 商品');assert.equal(b.erp.get('SELECT name FROM products').name,'公司 B 商品');assert.equal(root.get('SELECT count(*) n FROM products').n,0);
  assert.equal(a.erp.get('SELECT code FROM warehouses').code,'MAIN');assert.equal(root.get("SELECT username FROM users WHERE id=1").username,'rootadmin');
});
test('cross-company summaries require each target company explicit grant and support cost-free summaries and revocation',t=>{
  const {u,companies,context,create}=fixture(t);create('alpha');create('beta');
  assert.deepEqual(companies.summary(context,u).rows.map(r=>r.slug),['default']);
  const a=companies.resolve('alpha'),admin=a.erp.user(1);
  companies.grant(a,admin,{root_username:u.username,enabled:true,include_cost:false});
  let summary=companies.summary(context,u);assert.equal(summary.rows.length,2);assert.equal(summary.rows.find(r=>r.slug==='alpha').inventory_value,undefined);
  companies.grant(a,admin,{root_username:u.username,enabled:true,include_cost:true});summary=companies.summary(context,u);assert.equal(summary.rows.find(r=>r.slug==='alpha').inventory_value,0);
  companies.grant(a,admin,{root_username:u.username,enabled:false});assert.equal(companies.summary(context,u).rows.length,1);
  assert.throws(()=>companies.summary(a,admin),/主要帳套/);assert.throws(()=>companies.grant(context,u,{root_username:u.username}),/登入/);
});
test('company catalogue persists exact isolated database files and refuses silent replacement of missing company data',t=>{
  const {root,companies,create,directory}=fixture(t,true);create('alpha');const a=companies.resolve('alpha'),u=a.erp.user(1);a.erp.savePartner(u,{code:'C',name:'持久化客戶'});companies.close();
  assert.equal(companies.resolve('alpha').erp.get("SELECT name FROM partners WHERE code='C'").name,'持久化客戶');
  companies.close();const row=root.get("SELECT filename FROM company_catalog WHERE slug='alpha'"),file=join(directory,'.company-workspaces',row.filename);renameSync(file,file+'.backup');
  assert.throws(()=>companies.resolve('alpha'),/檔案缺失/);
});
test('company setup rejects traversal, duplicate IDs, weak passwords and creation from a child company',t=>{
  const {root,u,companies,context,create}=fixture(t);assert.throws(()=>create('../escape'),/代碼/);assert.throws(()=>companies.resolve('../escape'),/代碼/);
  assert.throws(()=>companies.create(context,u,{slug:'weak',name:'無效公司',username:'admin',password:'short'}),/密碼/);
  assert.equal(root.get('SELECT count(*) n FROM company_catalog').n,0);create('alpha');assert.throws(()=>create('alpha'),/重複/);
  const a=companies.resolve('alpha');assert.throws(()=>companies.create(a,a.erp.user(1),{slug:'child'}),/主要帳套/);
  assert.throws(()=>companies.create(context,{...u,role:'manager'},{slug:'other'}),/權限/);
});
