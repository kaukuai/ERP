export function migrateV22(db) {
  if (
    Number(
      db.prepare("SELECT value FROM settings WHERE key='schema_version'").get()
        ?.value,
    ) >= 22
  )
    return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
  CREATE TABLE work_centers(id INTEGER PRIMARY KEY,code TEXT NOT NULL UNIQUE,name TEXT NOT NULL,daily_minutes INTEGER NOT NULL,hourly_cost INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,created_by INTEGER NOT NULL REFERENCES users(id));
  CREATE TABLE work_center_calendar(id INTEGER PRIMARY KEY,center_id INTEGER NOT NULL REFERENCES work_centers(id),date TEXT NOT NULL,minutes INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_by INTEGER NOT NULL REFERENCES users(id),UNIQUE(center_id,date));
  CREATE TABLE production_routes(id INTEGER PRIMARY KEY,product_id INTEGER NOT NULL REFERENCES products(id),name TEXT NOT NULL,definition TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,created_by INTEGER NOT NULL REFERENCES users(id));
  CREATE UNIQUE INDEX production_route_active ON production_routes(product_id) WHERE active=1;
  CREATE TABLE production_jobs(id INTEGER PRIMARY KEY,no TEXT NOT NULL UNIQUE,product_id INTEGER NOT NULL REFERENCES products(id),warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),qty INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'draft',version INTEGER NOT NULL DEFAULT 1,due_date TEXT NOT NULL,start_date TEXT NOT NULL,end_date TEXT NOT NULL,bom_snapshot TEXT NOT NULL,route_snapshot TEXT NOT NULL,cost INTEGER NOT NULL DEFAULT 0,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
  CREATE TABLE production_materials(id INTEGER PRIMARY KEY,job_id INTEGER NOT NULL REFERENCES production_jobs(id),product_id INTEGER NOT NULL REFERENCES products(id),required_qty INTEGER NOT NULL,issued_qty INTEGER NOT NULL DEFAULT 0,cost INTEGER NOT NULL DEFAULT 0,UNIQUE(job_id,product_id));
  CREATE TABLE production_operations(id INTEGER PRIMARY KEY,job_id INTEGER NOT NULL REFERENCES production_jobs(id),sequence INTEGER NOT NULL,name TEXT NOT NULL,center_id INTEGER REFERENCES work_centers(id),supplier_id INTEGER REFERENCES partners(id),service_product_id INTEGER REFERENCES products(id),planned_minutes INTEGER NOT NULL,actual_minutes INTEGER NOT NULL DEFAULT 0,hourly_cost INTEGER NOT NULL,unit_fee INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',sent_qty INTEGER NOT NULL DEFAULT 0,received_qty INTEGER NOT NULL DEFAULT 0,cost INTEGER NOT NULL DEFAULT 0,po_document_id INTEGER REFERENCES documents(id),UNIQUE(job_id,sequence));
  CREATE TABLE production_capacity_slots(id INTEGER PRIMARY KEY,operation_id INTEGER NOT NULL REFERENCES production_operations(id),center_id INTEGER NOT NULL REFERENCES work_centers(id),date TEXT NOT NULL,start_minute INTEGER NOT NULL,end_minute INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE subcontract_custody(id INTEGER PRIMARY KEY,operation_id INTEGER NOT NULL REFERENCES production_operations(id),kind TEXT NOT NULL CHECK(kind IN ('send','receive','recall')),qty INTEGER NOT NULL,reference TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
  CREATE TABLE mrp_plans(id INTEGER PRIMARY KEY,no TEXT NOT NULL UNIQUE,warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),definition TEXT NOT NULL,source_hash TEXT NOT NULL,result TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'preview',version INTEGER NOT NULL DEFAULT 1,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
  CREATE TABLE mrp_outputs(id INTEGER PRIMARY KEY,plan_id INTEGER NOT NULL REFERENCES mrp_plans(id),line_key TEXT NOT NULL,document_id INTEGER REFERENCES documents(id),job_id INTEGER REFERENCES production_jobs(id),UNIQUE(plan_id,line_key));
  INSERT OR IGNORE INTO accounts VALUES('1402','製造在製品','asset'),('5104','製造加工費用分攤','expense');
  CREATE INDEX production_capacity_lookup ON production_capacity_slots(center_id,date,active);
  CREATE INDEX production_due_lookup ON production_jobs(warehouse_id,product_id,status,end_date);
  CREATE TRIGGER production_return_lock BEFORE INSERT ON returns WHEN EXISTS(SELECT 1 FROM fulfilments f JOIN production_operations o ON o.po_document_id=f.document_id JOIN production_jobs j ON j.id=o.job_id WHERE f.id=NEW.fulfilment_id AND j.status<>'cancelled') BEGIN SELECT RAISE(ABORT,'ERP_PRODUCTION_COST_LOCKED'); END;
  CREATE TRIGGER production_allowance_lock BEFORE INSERT ON allowances WHEN EXISTS(SELECT 1 FROM fulfilments f JOIN production_operations o ON o.po_document_id=f.document_id JOIN production_jobs j ON j.id=o.job_id WHERE f.id=NEW.fulfilment_id AND j.status<>'cancelled') BEGIN SELECT RAISE(ABORT,'ERP_PRODUCTION_COST_LOCKED'); END;
`);
    for (const table of ["subcontract_custody", "mrp_outputs"])
      for (const action of ["UPDATE", "DELETE"])
        db.exec(
          `CREATE TRIGGER ${table}_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable production history'); END`,
        );
    db.prepare(
      "UPDATE settings SET value='22' WHERE key='schema_version'",
    ).run();
    for (const table of [
      "warehouse_wave_lines",
      "bin_balances",
      "foreign_accounts",
      "fx_settlements",
      "fx_valuations",
      "foreign_activity",
      "document_outbox",
      "payroll_runs",
      "payroll_lines",
      "payroll_payments",
      "payroll_remittances",
      "production_jobs",
      "production_materials",
      "production_operations",
      "production_capacity_slots",
      "mrp_plans",
    ])
      db.exec(
        `CREATE TRIGGER enterprise_${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable enterprise history'); END`,
      );
    for (const [table, columns] of [
      [
        "warehouse_wave_lines",
        "wave_id,document_id,document_version,document_line_id,product_id,qty,base_qty",
      ],
      ["bin_balances", "bin_id,product_id,lot_code,expiry"],
      [
        "payroll_runs",
        "no,period,policy_id,policy_snapshot,source_hash,notes,created_by,created_at",
      ],
      [
        "payroll_payments",
        "no,line_id,bank_account_id,amount,date,created_by,created_at",
      ],
      [
        "payroll_remittances",
        "no,run_id,kind,account,amount,date,bank_account_id,reference,created_by,created_at",
      ],
      [
        "production_jobs",
        "no,product_id,warehouse_id,qty,due_date,start_date,bom_snapshot,route_snapshot,created_by,created_at",
      ],
      ["production_materials", "job_id,product_id,required_qty"],
      [
        "production_operations",
        "job_id,sequence,name,center_id,supplier_id,service_product_id,hourly_cost,unit_fee",
      ],
      [
        "production_capacity_slots",
        "operation_id,center_id,date,start_minute,end_minute",
      ],
      [
        "mrp_plans",
        "no,warehouse_id,definition,source_hash,result,created_by,created_at",
      ],
    ])
      db.exec(
        `CREATE TRIGGER enterprise_${table}_snapshot BEFORE UPDATE OF ${columns} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable enterprise snapshot'); END`,
      );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
