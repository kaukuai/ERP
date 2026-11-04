export function migrateV4(db) {
  if (Number(db.prepare("SELECT value FROM settings WHERE key='schema_version'").get()?.value) >= 4) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      ALTER TABLE partners ADD COLUMN billing_policy TEXT NOT NULL DEFAULT 'individual' CHECK(billing_policy IN ('individual','batch'));
      ALTER TABLE open_items ADD COLUMN billing_state TEXT NOT NULL DEFAULT 'posted' CHECK(billing_state IN ('pending','posted'));
      ALTER TABLE open_items ADD COLUMN closing_date TEXT NOT NULL DEFAULT '';
      ALTER TABLE open_items ADD COLUMN billing_batch_id INTEGER REFERENCES billing_batches(id);
      CREATE TABLE fulfilment_batches(
        id INTEGER PRIMARY KEY,no TEXT NOT NULL UNIQUE,kind TEXT NOT NULL CHECK(kind IN ('shipment','receipt')),
        partner_id INTEGER NOT NULL REFERENCES partners(id),warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
        partner_snapshot TEXT NOT NULL,shipping_address TEXT NOT NULL,notes TEXT NOT NULL,
        created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
      CREATE TABLE fulfilment_batch_sources(
        batch_id INTEGER NOT NULL REFERENCES fulfilment_batches(id),
        fulfilment_id INTEGER NOT NULL UNIQUE REFERENCES fulfilments(id),PRIMARY KEY(batch_id,fulfilment_id));
      CREATE TABLE billing_batches(
        id INTEGER PRIMARY KEY,no TEXT NOT NULL UNIQUE,kind TEXT NOT NULL CHECK(kind IN ('receivable','payable')),
        partner_id INTEGER NOT NULL REFERENCES partners(id),partner_snapshot TEXT NOT NULL,account_period TEXT NOT NULL,
        date TEXT NOT NULL,due_date TEXT NOT NULL,amount_snapshot INTEGER NOT NULL CHECK(amount_snapshot>=0),
        created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
      CREATE TABLE billing_batch_lines(
        batch_id INTEGER NOT NULL REFERENCES billing_batches(id),open_item_id INTEGER NOT NULL UNIQUE REFERENCES open_items(id),
        amount_snapshot INTEGER NOT NULL CHECK(amount_snapshot>=0),PRIMARY KEY(batch_id,open_item_id));
      CREATE INDEX pending_billing ON open_items(billing_state,partner_id,kind,account_period);
      INSERT OR IGNORE INTO accounts VALUES('1110','待立帳應收','asset'),('2005','待立帳應付','liability');
    `);
    for (const table of ['fulfilment_batches','fulfilment_batch_sources','billing_batches','billing_batch_lines']) {
      for (const action of ['UPDATE','DELETE']) db.exec(`CREATE TRIGGER no_${table}_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable workflow source'); END`);
    }
    db.prepare("UPDATE settings SET value='4' WHERE key='schema_version'").run();
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
