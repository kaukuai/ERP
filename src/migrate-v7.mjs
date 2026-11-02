export function migrateV7(db){
  if(Number(db.prepare("SELECT value FROM settings WHERE key='schema_version'").get()?.value)>=7)return;
  db.exec('BEGIN IMMEDIATE');try{
    db.exec(`
      ALTER TABLE products ADD COLUMN tracking_mode TEXT NOT NULL DEFAULT 'none' CHECK(tracking_mode IN ('none','lot','serial'));
      CREATE TABLE inventory_lots(id INTEGER PRIMARY KEY,product_id INTEGER NOT NULL REFERENCES products(id),warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),code TEXT NOT NULL,expiry TEXT NOT NULL DEFAULT '',qty INTEGER NOT NULL DEFAULT 0 CHECK(qty>=0),UNIQUE(product_id,warehouse_id,code));
      CREATE TABLE lot_moves(id INTEGER PRIMARY KEY,lot_id INTEGER NOT NULL REFERENCES inventory_lots(id),stock_move_id INTEGER NOT NULL REFERENCES stock_moves(id),qty INTEGER NOT NULL CHECK(qty<>0),reference TEXT NOT NULL,origin_reference TEXT NOT NULL DEFAULT '',created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
      CREATE INDEX lot_fefo ON inventory_lots(product_id,warehouse_id,expiry,id);
      CREATE INDEX lot_source ON lot_moves(reference,origin_reference,lot_id);
    `);
    for(const action of ['UPDATE','DELETE'])db.exec(`CREATE TRIGGER no_lot_move_${action.toLowerCase()} BEFORE ${action} ON lot_moves BEGIN SELECT RAISE(ABORT,'immutable lot ledger'); END`);
    db.prepare("UPDATE settings SET value='7' WHERE key='schema_version'").run();db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
