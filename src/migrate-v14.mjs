export function migrateV14(db) {
  if (
    Number(
      db.prepare("SELECT value FROM settings WHERE key='schema_version'").get()
        ?.value,
    ) >= 14
  )
    return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
 CREATE TABLE product_categories(id INTEGER PRIMARY KEY,code TEXT NOT NULL UNIQUE,name TEXT NOT NULL,parent_id INTEGER REFERENCES product_categories(id),version INTEGER NOT NULL DEFAULT 1);
 ALTER TABLE products ADD COLUMN category_id INTEGER REFERENCES product_categories(id);
 CREATE TABLE custom_field_definitions(id INTEGER PRIMARY KEY,code TEXT NOT NULL UNIQUE,label TEXT NOT NULL,type TEXT NOT NULL CHECK(type IN ('text','number','date','choice','boolean')),required INTEGER NOT NULL DEFAULT 0,options TEXT NOT NULL DEFAULT '[]',active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE product_custom_values(product_id INTEGER NOT NULL REFERENCES products(id),field_id INTEGER NOT NULL REFERENCES custom_field_definitions(id),value TEXT NOT NULL,PRIMARY KEY(product_id,field_id));
 CREATE TABLE user_preferences(user_id INTEGER PRIMARY KEY REFERENCES users(id),quantity_digits INTEGER NOT NULL DEFAULT 3,money_digits INTEGER NOT NULL DEFAULT 2,input_order TEXT NOT NULL DEFAULT 'qty,price,discount_bp');
 CREATE TABLE module_closings(module TEXT PRIMARY KEY,closed_until TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE closing_events(id INTEGER PRIMARY KEY,module TEXT NOT NULL,previous_date TEXT NOT NULL,new_date TEXT NOT NULL,reason TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
 CREATE TABLE stock_documents(id INTEGER PRIMARY KEY,no TEXT NOT NULL UNIQUE,kind TEXT NOT NULL CHECK(kind IN ('receipt','issue','transfer')),status TEXT NOT NULL DEFAULT 'draft',from_id INTEGER REFERENCES warehouses(id),to_id INTEGER REFERENCES warehouses(id),transit_id INTEGER REFERENCES warehouses(id),date TEXT NOT NULL,notes TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
 CREATE TABLE stock_document_lines(id INTEGER PRIMARY KEY,document_id INTEGER NOT NULL REFERENCES stock_documents(id),product_id INTEGER NOT NULL REFERENCES products(id),qty INTEGER NOT NULL,unit_cost INTEGER NOT NULL DEFAULT 0,value INTEGER NOT NULL DEFAULT 0,received_qty INTEGER NOT NULL DEFAULT 0,received_value INTEGER NOT NULL DEFAULT 0,lots TEXT NOT NULL DEFAULT '[]');
 CREATE TABLE invoice_fulfilments(invoice_id INTEGER NOT NULL REFERENCES invoice_records(id),fulfilment_id INTEGER NOT NULL REFERENCES fulfilments(id),amount INTEGER NOT NULL CHECK(amount>0),created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,PRIMARY KEY(invoice_id,fulfilment_id));
 CREATE TABLE opening_funds(fund_id INTEGER PRIMARY KEY REFERENCES funds(id),reference TEXT NOT NULL);
 CREATE TABLE replenishment_policies(product_id INTEGER PRIMARY KEY REFERENCES products(id),target_qty INTEGER NOT NULL,min_order_qty INTEGER NOT NULL DEFAULT 0,multiple_qty INTEGER NOT NULL DEFAULT 1000,lead_days INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE count_rebases(id INTEGER PRIMARY KEY,count_id INTEGER NOT NULL REFERENCES inventory_counts(id),previous_snapshot INTEGER NOT NULL,new_snapshot INTEGER NOT NULL,detail TEXT NOT NULL,reason TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
 CREATE TABLE count_zones(count_id INTEGER NOT NULL REFERENCES inventory_counts(id),product_id INTEGER NOT NULL REFERENCES products(id),zone TEXT NOT NULL,PRIMARY KEY(count_id,product_id));
 CREATE TABLE kit_sales(document_id INTEGER NOT NULL REFERENCES documents(id),kit_id INTEGER NOT NULL REFERENCES boms(id),qty INTEGER NOT NULL,snapshot TEXT NOT NULL,PRIMARY KEY(document_id,kit_id));
 CREATE TABLE disassemblies(id INTEGER PRIMARY KEY,no TEXT NOT NULL UNIQUE,product_id INTEGER NOT NULL REFERENCES products(id),warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),qty INTEGER NOT NULL,cost INTEGER NOT NULL,snapshot TEXT NOT NULL,reason TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
 ALTER TABLE funds ADD COLUMN canceled INTEGER NOT NULL DEFAULT 0;
 CREATE TABLE allowance_funds(allowance_id INTEGER NOT NULL REFERENCES allowances(id),fund_id INTEGER PRIMARY KEY REFERENCES funds(id));
 CREATE TABLE payment_reversal_adjustments(id INTEGER PRIMARY KEY,reversal_id INTEGER NOT NULL REFERENCES payment_reversals(id),fund_id INTEGER NOT NULL REFERENCES funds(id),credit_amount INTEGER NOT NULL,refund_offset INTEGER NOT NULL,canceled INTEGER NOT NULL);
 CREATE TABLE settlements(id INTEGER PRIMARY KEY,no TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,partner_id INTEGER NOT NULL REFERENCES partners(id),date TEXT NOT NULL,detail TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
 CREATE TABLE settlement_fees(id INTEGER PRIMARY KEY,settlement_id INTEGER NOT NULL REFERENCES settlements(id),open_item_id INTEGER NOT NULL REFERENCES open_items(id),amount INTEGER NOT NULL,date TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id));
 CREATE TABLE allowance_lines(id INTEGER PRIMARY KEY,allowance_id INTEGER NOT NULL REFERENCES allowances(id),fulfilment_line_id INTEGER NOT NULL REFERENCES fulfilment_lines(id),net INTEGER NOT NULL,tax INTEGER NOT NULL,start_returned_qty INTEGER NOT NULL,qty_basis INTEGER NOT NULL,cost_policy TEXT NOT NULL DEFAULT 'variance',UNIQUE(allowance_id,fulfilment_line_id));
 CREATE TABLE return_allowance_consumptions(return_id INTEGER NOT NULL REFERENCES returns(id),allowance_line_id INTEGER NOT NULL REFERENCES allowance_lines(id),net INTEGER NOT NULL,tax INTEGER NOT NULL,PRIMARY KEY(return_id,allowance_line_id));
 CREATE TABLE cost_policies(id INTEGER PRIMARY KEY,method TEXT NOT NULL CHECK(method IN ('moving','standard','monthly')),effective_date TEXT NOT NULL,reason TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
 CREATE TABLE standard_costs(product_id INTEGER PRIMARY KEY REFERENCES products(id),cost INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE costing_runs(id INTEGER PRIMARY KEY,no TEXT NOT NULL UNIQUE,method TEXT NOT NULL,date TEXT NOT NULL,details TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
 `);
    for (const table of [
      "invoice_fulfilments",
      "settlements",
      "settlement_fees",
      "payment_reversal_adjustments",
      "allowance_funds",
      "allowance_lines",
      "return_allowance_consumptions",
      "closing_events",
      "opening_funds",
      "count_rebases",
      "kit_sales",
      "disassemblies",
      "cost_policies",
      "costing_runs",
    ])
      for (const verb of ["UPDATE", "DELETE"])
        db.exec(
          `CREATE TRIGGER ${table}_no_${verb.toLowerCase()} BEFORE ${verb} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable workflow event'); END;`,
        );
    db.prepare(
      "UPDATE settings SET value='14' WHERE key='schema_version'",
    ).run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
