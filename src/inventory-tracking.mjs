import { permit,fail,integer,scaled,txt,dateValue,today,now } from './core.mjs';

export function withInventorySelection(e,options,fn){
  const previous=e.inventorySelection;e.inventorySelection=options||{};
  try{return fn();}finally{e.inventorySelection=previous;}
}
export function prepareLotMove(e,pid,wid,quantity,kind,reference,options){
  const product=e.product(pid);if(product.tracking_mode==='none'||!quantity)return [];
  const selection=options||e.inventorySelection||{},origin=selection.origin||'';
  if(selection.lots!==undefined&&!Array.isArray(selection.lots))fail('批號／序號明細格式錯誤');
  let choices=(selection.lots||[]).filter(l=>Number(l.product_id)===pid&&(!l.warehouse_id||Number(l.warehouse_id)===wid)).map(l=>({code:txt(l.code,100,true),expiry:l.expiry?dateValue(l.expiry):'',qty:scaled(l.qty,3,1)}));
  const outgoing=quantity<0,returning=Boolean(origin),restrictExpiry=!['transfer','adjustment','stock_count','purchase_return','loan_return_out'].includes(kind);
  let original=[];
  if(returning){
    original=e.all('SELECT lot.code,lot.expiry,sum(abs(m.qty)) qty FROM lot_moves m JOIN inventory_lots lot ON lot.id=m.lot_id WHERE m.reference=? AND lot.product_id=? AND m.qty*?>0 GROUP BY lot.code,lot.expiry',origin,pid,outgoing?1:-1).map(row=>{
      const returned=e.get('SELECT COALESCE(sum(abs(m.qty)),0) n FROM lot_moves m JOIN inventory_lots lot ON lot.id=m.lot_id WHERE m.origin_reference=? AND lot.product_id=? AND lot.code=?',origin,pid,row.code).n;
      return {...row,qty:row.qty-returned};
    });
    if(!choices.length){let left=Math.abs(quantity);choices=[];for(const lot of original){const available=outgoing?Math.min(lot.qty,e.get('SELECT qty FROM inventory_lots WHERE product_id=? AND warehouse_id=? AND code=?',pid,wid,lot.code)?.qty||0):lot.qty,take=Math.min(left,available);if(take)choices.push({...lot,qty:take});left-=take;}}
  }else if(kind==='transfer'&&!outgoing){
    choices=e.all('SELECT lot.code,lot.expiry,-m.qty qty FROM lot_moves m JOIN inventory_lots lot ON lot.id=m.lot_id WHERE m.reference=? AND lot.product_id=? AND m.qty<0 ORDER BY m.id',reference,pid);
  }else if(outgoing&&!choices.length){
    let left=-quantity;const lots=e.all("SELECT * FROM inventory_lots WHERE product_id=? AND warehouse_id=? AND qty>0 ORDER BY CASE WHEN expiry='' THEN '9999-12-31' ELSE expiry END,id",pid,wid);choices=[];
    for(const lot of lots){if(restrictExpiry&&lot.expiry&&lot.expiry<today())continue;const take=Math.min(left,lot.qty);if(take)choices.push({...lot,qty:take});left-=take;}
  }
  if(choices.reduce((sum,l)=>sum+l.qty,0)!==Math.abs(quantity))fail('批號／序號數量合計需等於本次基本庫存量；庫存不足或效期已過',409);
  const seen=new Set();return choices.map(choice=>{
    if(seen.has(choice.code))fail('同一筆庫存異動的批號／序號不可重複');seen.add(choice.code);
    const lot=e.get('SELECT * FROM inventory_lots WHERE product_id=? AND warehouse_id=? AND code=?',pid,wid,choice.code);
    if(lot&&choice.expiry&&choice.expiry!==lot.expiry)fail('同批號既有到期日不同，請核對');
    const expiry=lot?.expiry??choice.expiry;
    if(outgoing&&(!lot||choice.qty>lot.qty))fail('所選批號庫存不足',409);
    if(outgoing&&restrictExpiry&&!returning&&expiry&&expiry<today())fail('所選批號已過期，不能出貨',409);
    if(product.tracking_mode==='serial'){
      if(choice.qty!==1000)fail('每個序號數量必須為 1 個基本單位');
      if(!outgoing&&e.get('SELECT COALESCE(sum(qty),0) n FROM inventory_lots WHERE product_id=? AND code=?',pid,choice.code).n)fail('此序號已在其他庫存中',409);
    }
    if(returning){const source=original.find(l=>l.code===choice.code);if(!source||choice.qty>source.qty)fail('退貨批號／序號不屬於原始出入庫或超過可退量',409);}
    return {id:lot?.id,code:choice.code,expiry:expiry||'',qty:outgoing?-choice.qty:choice.qty,product_id:pid,warehouse_id:wid,origin};
  });
}
export function commitLotMove(e,u,stockMoveId,reference,rows){
  for(const row of rows){let id=row.id;
    if(!id)id=Number(e.run('INSERT INTO inventory_lots(product_id,warehouse_id,code,expiry) VALUES(?,?,?,?)',row.product_id,row.warehouse_id,row.code,row.expiry).lastInsertRowid);
    e.run('UPDATE inventory_lots SET qty=qty+? WHERE id=?',row.qty,id);
    e.run('INSERT INTO lot_moves(lot_id,stock_move_id,qty,reference,origin_reference,created_by,created_at) VALUES(?,?,?,?,?,?,?)',id,stockMoveId,row.qty,reference,row.origin,u.id,now());
  }
}
export class InventoryTracking {
  constructor(e){this.e=e;}
  configure(u,b){
    permit(u,'masters');return this.e.tx(()=>{
      const p=this.e.product(b.product_id),mode=b.tracking_mode;
      if(!['none','lot','serial'].includes(mode))fail('追蹤類型錯誤');if(p.version!==integer(b.version,1))fail('商品已更新',409);
      if(mode!==p.tracking_mode&&(this.e.get('SELECT COALESCE(sum(qty+reserved),0) n FROM stocks WHERE product_id=?',p.id).n||this.e.get('SELECT id FROM stock_moves WHERE product_id=? AND qty<>0 LIMIT 1',p.id)))fail('變更追蹤類型須無現有庫存、預留與批號歷史；有歷史請另建品號',409);
      if(mode!=='none'&&!p.track_stock)fail('非庫存商品不能啟用批號追蹤');
      this.e.run('UPDATE products SET tracking_mode=?,version=version+1 WHERE id=?',mode,p.id);this.e.log(u,'configure_tracking','product',p.id,{mode});return {product_id:p.id,tracking_mode:mode,version:p.version+1};
    });
  }
  trace(u,id){
    permit(u,'all');if(u.role==='sales')fail('無權存取批號完整流向',403);
    const lot=this.e.get('SELECT l.*,p.sku,p.name,w.name warehouse_name FROM inventory_lots l JOIN products p ON p.id=l.product_id JOIN warehouses w ON w.id=l.warehouse_id WHERE l.id=?',integer(id,1));if(!lot)fail('批號不存在',404);
    // Follow this lot/serial across warehouses, including original and return references.
    lot.moves=this.e.all('SELECT m.*,l.warehouse_id,w.name warehouse_name,s.kind FROM lot_moves m JOIN inventory_lots l ON l.id=m.lot_id JOIN warehouses w ON w.id=l.warehouse_id JOIN stock_moves s ON s.id=m.stock_move_id WHERE l.product_id=? AND l.code=? ORDER BY m.id',lot.product_id,lot.code);return lot;
  }
  data(u){if(u.role==='sales')return {};return {inventory_lots:this.e.all('SELECT l.*,p.sku,p.name,p.tracking_mode,w.name warehouse_name FROM inventory_lots l JOIN products p ON p.id=l.product_id JOIN warehouses w ON w.id=l.warehouse_id ORDER BY p.sku,CASE WHEN l.expiry=\'\' THEN \'9999-12-31\' ELSE l.expiry END,l.id')};}
}
