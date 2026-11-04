import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ERP } from '../src/core.mjs';
import { MasterImports } from '../src/master-imports.mjs';

function fixture(t){const e=new ERP(),u=e.setup({username:'admin',password:'master-import-test-2026'}),work=new MasterImports(e);t.after(()=>e.close());return {e,u,work};}
test('saved CSV mappings preserve text identifiers and exact prices, apply fixed values and import only after confirmation',t=>{
  const {e,u,work}=fixture(t),template=work.save(u,{kind:'products',name:'商品映射',columns:{sku:'商品代號',name:'商品名稱',price:'售價'},defaults:{unit:'件',cost:'0'}});
  const file={template_id:template.id,format:'csv',text:'商品代號,商品名稱,售價,忽略欄\r\n00123,"測試,商品",105.01,不匯入\r\n'};
  const preview=work.preview(u,file);assert.deepEqual(preview.errors,[]);assert.equal(e.get('SELECT count(*) n FROM products').n,0);assert.equal(preview.rows[0].sku,'00123');
  work.commit(u,preview.id);const product=e.get('SELECT * FROM products');assert.equal(product.sku,'00123');assert.equal(product.price,10501);assert.equal(product.unit,'件');
  const snapshot=JSON.parse(e.get('SELECT template_snapshot FROM master_import_sources WHERE import_id=?',preview.id).template_snapshot);assert.equal(snapshot.columns.sku,'商品代號');assert.equal(snapshot.defaults.unit,'件');
  assert.throws(()=>work.preview(u,file),/相同檔案/);assert.throws(()=>work.commit(u,preview.id),/相同檔案|已執行/);
  assert.equal(e.integrity(u).ok,true);assert.throws(()=>e.run('DELETE FROM master_import_sources'),/immutable/);
});
test('real XLSX first-sheet values map to partner fields without executing workbook content',t=>{
  const {e,u,work}=fixture(t),template=work.save(u,{kind:'partners',name:'Excel 往來映射',columns:{code:'external_id',name:'reference'},defaults:{kind:'customer'}});
  const file=readFileSync(new URL('./fixtures/bank-statement.xlsx',import.meta.url));
  const preview=work.preview(u,{template_id:template.id,format:'xlsx',base64:file.toString('base64')});assert.equal(preview.count,2);assert.deepEqual(preview.errors,[]);
  work.commit(u,preview.id);assert.equal(e.get('SELECT count(*) n FROM partners').n,2);assert.equal(e.get("SELECT code FROM partners WHERE code='BANK-001'").code,'BANK-001');
  const corrupt=Buffer.from(file);corrupt[100]^=1;assert.throws(()=>work.preview(u,{template_id:template.id,format:'xlsx',base64:corrupt.toString('base64')}),/損壞|校驗/);
  const formula=readFileSync(new URL('./fixtures/formula.xlsx',import.meta.url));assert.throws(()=>work.preview(u,{template_id:template.id,format:'xlsx',base64:formula.toString('base64')}),/公式/);
});
test('mapping changes invalidate pending imports and reject stale template edits',t=>{
  const {e,u,work}=fixture(t),body={kind:'products',name:'版本範本',columns:{sku:'sku',name:'name'},defaults:{}},template=work.save(u,body);
  const preview=work.preview(u,{template_id:template.id,format:'csv',text:'sku,name\nP,商品'});
  work.save(u,{...body,id:template.id,version:1,defaults:{unit:'件'}});
  assert.throws(()=>work.commit(u,preview.id),/範本已變更/);assert.throws(()=>work.save(u,{...body,id:template.id,version:1}),/已變更/);assert.equal(e.get('SELECT count(*) n FROM products').n,0);
});
test('conflicting master data added after preview rolls back every row in the batch',t=>{
  const {e,u,work}=fixture(t),template=work.save(u,{kind:'products',name:'原子匯入',columns:{sku:'代號',name:'名稱'}}),preview=work.preview(u,{template_id:template.id,format:'csv',text:'代號,名稱\nP1,第一筆\nP2,第二筆'});
  e.saveProduct(u,{sku:'P2',name:'其他使用者先建立'});assert.throws(()=>work.commit(u,preview.id));assert.equal(e.get("SELECT id FROM products WHERE sku='P1'"),undefined);assert.equal(e.get('SELECT status FROM imports WHERE id=?',preview.id).status,'preview');
});
test('opening-stock mapping posts exact balances and rejects prior movement or duplicate imports',t=>{
  const {e,u,work}=fixture(t),p=e.saveProduct(u,{sku:'P',name:'期初商品'}),template=work.save(u,{kind:'opening_stock',name:'期初映射',columns:{sku:'品號',qty:'實際數量',unit_cost:'單位成本'},defaults:{warehouse_code:'WH01'}});
  const preview=work.preview(u,{template_id:template.id,format:'csv',text:'品號,實際數量,單位成本\nP,1.250,12.34'});assert.deepEqual(preview.errors,[]);work.commit(u,preview.id);
  assert.equal(e.stock(p.id,1).qty,1250);assert.equal(e.stock(p.id,1).value,1543);assert.equal(e.integrity(u).ok,true);
  const again=work.preview(u,{template_id:template.id,format:'csv',text:'品號,實際數量,單位成本\nP,2,12.34'});assert.equal(again.errors.length,1);assert.throws(()=>work.commit(u,again.id),/修正/);
  const tracked=e.saveProduct(u,{sku:'TRACKED',name:'批號商品'});e.run("UPDATE products SET tracking_mode='lot' WHERE id=?",tracked.id);
  const lot=work.preview(u,{template_id:template.id,format:'csv',text:'品號,實際數量,單位成本\nTRACKED,1,12.34'});assert.match(lot.errors[0].message,/批號/);assert.throws(()=>work.commit(u,lot.id),/修正/);
});
test('mapping permissions, required fields, unknown targets, missing headers and duplicate headers are enforced',t=>{
  const {u,work}=fixture(t),valid={kind:'products',name:'驗證範本',columns:{sku:'sku',name:'name'}};
  assert.throws(()=>work.save({...u,role:'sales'},valid),/權限/);assert.deepEqual(work.data({...u,role:'sales'}),{});
  assert.throws(()=>work.save(u,{...valid,columns:{name:'name'}}),/必要欄位/);
  assert.throws(()=>work.save(u,{...valid,columns:{...valid.columns,id:'id'}}),/未支援/);
  assert.throws(()=>work.save(u,{...valid,defaults:{sku:'固定品號'}}),/同欄/);
  const template=work.save(u,valid);
  assert.throws(()=>work.preview(u,{template_id:template.id,format:'csv',text:'sku,other\nP,x'}),/缺少欄位/);
  assert.throws(()=>work.preview(u,{template_id:template.id,format:'csv',text:'sku,sku\nP,x'}),/重複/);
  assert.throws(()=>work.preview({...u,role:'finance'},{template_id:template.id,format:'csv',text:'sku,name\nP,x'}),/權限/);
});
