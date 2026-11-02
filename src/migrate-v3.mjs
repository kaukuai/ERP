export function migrateV3(db){
 const version=Number(db.prepare("SELECT value FROM settings WHERE key='schema_version'").get()?.value||1);if(version>=3)return;
 const add=(t,n,d)=>{if(!db.prepare(`PRAGMA table_info(${t})`).all().some(c=>c.name===n))db.exec(`ALTER TABLE ${t} ADD COLUMN ${n} ${d}`);};
 db.exec('BEGIN IMMEDIATE');try{
  add('products','track_stock','INTEGER NOT NULL DEFAULT 1 CHECK(track_stock IN (0,1))');add('products','invoice_name',"TEXT NOT NULL DEFAULT ''");
  add('documents','calc_version','INTEGER NOT NULL DEFAULT 1');add('documents','header_discount','INTEGER NOT NULL DEFAULT 0 CHECK(header_discount>=0)');add('documents','mixed_tax','INTEGER NOT NULL DEFAULT 0');add('documents','close_reason',"TEXT NOT NULL DEFAULT ''");
  add('documents','department_id','INTEGER REFERENCES departments(id)');add('document_lines','category',"TEXT NOT NULL DEFAULT ''");
  for(const name of ['net','tax','cost','base_qty'])add('return_lines',name,'INTEGER');
  for(const [name,def] of [['unit_id','INTEGER REFERENCES product_units(id)'],['unit_ratio','INTEGER NOT NULL DEFAULT 1000 CHECK(unit_ratio>0)'],['base_qty','INTEGER NOT NULL DEFAULT 0'],['track_stock','INTEGER NOT NULL DEFAULT 1'],['closed_qty','INTEGER NOT NULL DEFAULT 0'],['tax_mode',"TEXT NOT NULL DEFAULT 'exclusive'"],['tax_bp','INTEGER NOT NULL DEFAULT 500'],['net','INTEGER NOT NULL DEFAULT 0'],['tax','INTEGER NOT NULL DEFAULT 0'],['total','INTEGER NOT NULL DEFAULT 0'],['pre_discount_amount','INTEGER NOT NULL DEFAULT 0'],['header_discount_amount','INTEGER NOT NULL DEFAULT 0']])add('document_lines',name,def);
  add('fulfilments','calc_version','INTEGER NOT NULL DEFAULT 1');
  for(const [name,def] of [['base_qty','INTEGER NOT NULL DEFAULT 0'],['unit_ratio','INTEGER NOT NULL DEFAULT 1000'],['track_stock','INTEGER NOT NULL DEFAULT 1'],['net','INTEGER NOT NULL DEFAULT 0'],['tax','INTEGER NOT NULL DEFAULT 0'],['total','INTEGER NOT NULL DEFAULT 0']])add('fulfilment_lines',name,def);
  db.exec(`UPDATE document_lines SET base_qty=qty,pre_discount_amount=amount;UPDATE fulfilment_lines SET base_qty=qty;
   CREATE TABLE product_units(id INTEGER PRIMARY KEY,product_id INTEGER NOT NULL REFERENCES products(id),name TEXT NOT NULL,ratio INTEGER NOT NULL CHECK(ratio>0),barcode TEXT NOT NULL DEFAULT '',price INTEGER NOT NULL CHECK(price>=0),cost INTEGER NOT NULL CHECK(cost>=0),version INTEGER NOT NULL DEFAULT 1,active INTEGER NOT NULL DEFAULT 1,UNIQUE(product_id,name));
   CREATE UNIQUE INDEX unit_barcode ON product_units(barcode) WHERE barcode<>'';
   CREATE TABLE product_images(product_id INTEGER PRIMARY KEY REFERENCES products(id),mime TEXT NOT NULL,data BLOB NOT NULL,updated_at TEXT NOT NULL);
   CREATE TABLE order_closures(id INTEGER PRIMARY KEY,document_id INTEGER UNIQUE NOT NULL REFERENCES documents(id),reason TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
   CREATE TABLE cost_adjustments(id INTEGER PRIMARY KEY,no TEXT UNIQUE NOT NULL,product_id INTEGER NOT NULL REFERENCES products(id),warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),old_value INTEGER NOT NULL,new_value INTEGER NOT NULL CHECK(new_value>=0),reason TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
   CREATE TABLE pick_lists(id INTEGER PRIMARY KEY,no TEXT UNIQUE NOT NULL,warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),status TEXT NOT NULL DEFAULT 'draft',notes TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,posted_at TEXT NOT NULL DEFAULT '');
   CREATE TABLE pick_lines(id INTEGER PRIMARY KEY,pick_id INTEGER NOT NULL REFERENCES pick_lists(id),document_line_id INTEGER NOT NULL REFERENCES document_lines(id),qty INTEGER NOT NULL CHECK(qty>0),base_qty INTEGER NOT NULL CHECK(base_qty>0),picked_qty INTEGER NOT NULL DEFAULT 0 CHECK(picked_qty BETWEEN 0 AND base_qty),UNIQUE(pick_id,document_line_id));
   CREATE TABLE pick_scans(id INTEGER PRIMARY KEY,pick_id INTEGER NOT NULL REFERENCES pick_lists(id),barcode TEXT NOT NULL,base_qty INTEGER NOT NULL CHECK(base_qty>0),created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
   CREATE TABLE pick_fulfilments(pick_id INTEGER NOT NULL REFERENCES pick_lists(id),fulfilment_id INTEGER NOT NULL REFERENCES fulfilments(id),PRIMARY KEY(pick_id,fulfilment_id));
   CREATE TABLE checkbooks(id INTEGER PRIMARY KEY,bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),prefix TEXT NOT NULL,start_no INTEGER NOT NULL,end_no INTEGER NOT NULL,width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 12),created_by INTEGER NOT NULL REFERENCES users(id),CHECK(start_no>=0 AND end_no>=start_no));
   CREATE TABLE check_numbers(id INTEGER PRIMARY KEY,checkbook_id INTEGER NOT NULL REFERENCES checkbooks(id),number TEXT UNIQUE NOT NULL,status TEXT NOT NULL CHECK(status IN ('issued','void')),bill_id INTEGER UNIQUE REFERENCES bills(id),reason TEXT NOT NULL DEFAULT '',created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
   CREATE TABLE numbering_rules(prefix TEXT PRIMARY KEY,label_prefix TEXT NOT NULL,branch TEXT NOT NULL DEFAULT '',date_format TEXT NOT NULL CHECK(date_format IN ('day','month','year','none')),width INTEGER NOT NULL CHECK(width BETWEEN 3 AND 12));
  `);
  for(const table of ['order_closures','cost_adjustments','pick_scans','pick_fulfilments','check_numbers'])for(const action of ['UPDATE','DELETE'])db.exec(`CREATE TRIGGER protect_${table}_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable transaction history'); END;`);
  db.prepare("UPDATE settings SET value='3' WHERE key='schema_version'").run();db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
}
