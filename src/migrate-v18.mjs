export function migrateV18(db) {
  if (
    Number(
      db.prepare("SELECT value FROM settings WHERE key='schema_version'").get()
        ?.value,
    ) >= 18
  )
    return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE warehouse_controls(warehouse_id INTEGER PRIMARY KEY REFERENCES warehouses(id),enabled INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE storage_bins(id INTEGER PRIMARY KEY,warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),code TEXT NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('receiving','storage','pick','shipping','blocked')),priority INTEGER NOT NULL DEFAULT 100,capacity_qty INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,created_by INTEGER NOT NULL REFERENCES users(id),UNIQUE(warehouse_id,code));
      CREATE TABLE bin_balances(id INTEGER PRIMARY KEY,bin_id INTEGER NOT NULL REFERENCES storage_bins(id),product_id INTEGER NOT NULL REFERENCES products(id),lot_code TEXT NOT NULL DEFAULT '',expiry TEXT NOT NULL DEFAULT '',qty INTEGER NOT NULL DEFAULT 0 CHECK(qty>=0),UNIQUE(bin_id,product_id,lot_code));
      CREATE TABLE bin_moves(id INTEGER PRIMARY KEY,bin_id INTEGER NOT NULL REFERENCES storage_bins(id),product_id INTEGER NOT NULL REFERENCES products(id),lot_code TEXT NOT NULL,expiry TEXT NOT NULL,qty INTEGER NOT NULL,stock_move_id INTEGER REFERENCES stock_moves(id),kind TEXT NOT NULL,reference TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
      CREATE TABLE putaway_rules(id INTEGER PRIMARY KEY,warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),product_id INTEGER REFERENCES products(id),category TEXT NOT NULL DEFAULT '',bin_id INTEGER NOT NULL REFERENCES storage_bins(id),priority INTEGER NOT NULL DEFAULT 100,active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,created_by INTEGER NOT NULL REFERENCES users(id));
      CREATE TABLE bin_replenishment(id INTEGER PRIMARY KEY,bin_id INTEGER NOT NULL REFERENCES storage_bins(id),product_id INTEGER NOT NULL REFERENCES products(id),min_qty INTEGER NOT NULL,target_qty INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_by INTEGER NOT NULL REFERENCES users(id),UNIQUE(bin_id,product_id));
      CREATE TABLE warehouse_waves(id INTEGER PRIMARY KEY,no TEXT NOT NULL UNIQUE,warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),status TEXT NOT NULL DEFAULT 'draft',version INTEGER NOT NULL DEFAULT 1,notes TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
      CREATE TABLE warehouse_wave_lines(id INTEGER PRIMARY KEY,wave_id INTEGER NOT NULL REFERENCES warehouse_waves(id),document_id INTEGER NOT NULL REFERENCES documents(id),document_version INTEGER NOT NULL,document_line_id INTEGER NOT NULL REFERENCES document_lines(id),product_id INTEGER NOT NULL REFERENCES products(id),qty INTEGER NOT NULL,base_qty INTEGER NOT NULL,UNIQUE(wave_id,document_line_id));
      CREATE TABLE bin_reservations(id INTEGER PRIMARY KEY,wave_line_id INTEGER NOT NULL REFERENCES warehouse_wave_lines(id),balance_id INTEGER NOT NULL REFERENCES bin_balances(id),qty INTEGER NOT NULL CHECK(qty>=0),UNIQUE(wave_line_id,balance_id));
      CREATE TABLE enterprise_events(id INTEGER PRIMARY KEY,resource TEXT NOT NULL,entity_id INTEGER NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
      CREATE INDEX bin_product_lookup ON bin_balances(product_id,bin_id);
      CREATE INDEX wave_source_lookup ON warehouse_wave_lines(document_id,wave_id);
      CREATE INDEX bin_reservation_lookup ON bin_reservations(balance_id,qty);
      CREATE INDEX enterprise_event_lookup ON enterprise_events(resource,entity_id,id);
    `);
    for (const table of ["bin_moves", "enterprise_events"])
      for (const action of ["UPDATE", "DELETE"])
        db.exec(
          `CREATE TRIGGER ${table}_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable enterprise history'); END`,
        );
    db.prepare(
      "UPDATE settings SET value='18' WHERE key='schema_version'",
    ).run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
