export function migrateV5(db) {
  if(Number(db.prepare("SELECT value FROM settings WHERE key='schema_version'").get()?.value)>=5)return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE order_metadata(document_id INTEGER PRIMARY KEY REFERENCES documents(id),platform TEXT NOT NULL DEFAULT '',external_ref TEXT NOT NULL DEFAULT '',buyer_tax_id TEXT NOT NULL DEFAULT '',carrier_type TEXT NOT NULL DEFAULT '',carrier_id TEXT NOT NULL DEFAULT '',donation_code TEXT NOT NULL DEFAULT '',logistics_provider TEXT NOT NULL DEFAULT '',tracking_no TEXT NOT NULL DEFAULT '');
      CREATE UNIQUE INDEX external_order_ref ON order_metadata(platform,external_ref) WHERE platform<>'' AND external_ref<>'';
      CREATE TABLE subscription_plans(id INTEGER PRIMARY KEY,no TEXT UNIQUE NOT NULL,document_id INTEGER UNIQUE NOT NULL REFERENCES documents(id),status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','closed')),version INTEGER NOT NULL DEFAULT 1,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
      CREATE TABLE subscription_periods(id INTEGER PRIMARY KEY,plan_id INTEGER NOT NULL REFERENCES subscription_plans(id),due_date TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','skipped','completed')),version INTEGER NOT NULL DEFAULT 1,lines TEXT NOT NULL,fulfilment_id INTEGER UNIQUE REFERENCES fulfilments(id));
      CREATE TABLE subscription_events(id INTEGER PRIMARY KEY,plan_id INTEGER NOT NULL REFERENCES subscription_plans(id),period_id INTEGER REFERENCES subscription_periods(id),action TEXT NOT NULL,detail TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
      CREATE TABLE sku_mappings(id INTEGER PRIMARY KEY,platform TEXT NOT NULL,external_sku TEXT NOT NULL,product_id INTEGER NOT NULL REFERENCES products(id),unit_id INTEGER REFERENCES product_units(id),version INTEGER NOT NULL DEFAULT 1,UNIQUE(platform,external_sku));
      CREATE UNIQUE INDEX one_sku_per_platform_unit ON sku_mappings(platform,product_id,COALESCE(unit_id,0));
      CREATE TABLE order_import_templates(id INTEGER PRIMARY KEY,name TEXT UNIQUE NOT NULL,namespace TEXT NOT NULL,columns TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_by INTEGER NOT NULL REFERENCES users(id));
      CREATE TABLE order_import_jobs(id INTEGER PRIMARY KEY,template_id INTEGER NOT NULL REFERENCES order_import_templates(id),namespace TEXT NOT NULL,rows TEXT NOT NULL,errors TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'preview' CHECK(status IN ('preview','committed')),created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
      CREATE TABLE order_import_sources(namespace TEXT NOT NULL,reference TEXT NOT NULL,document_id INTEGER UNIQUE NOT NULL REFERENCES documents(id),job_id INTEGER NOT NULL REFERENCES order_import_jobs(id),PRIMARY KEY(namespace,reference));
      CREATE TABLE report_designs(id INTEGER PRIMARY KEY,name TEXT UNIQUE NOT NULL,dataset TEXT NOT NULL,columns TEXT NOT NULL,view_roles TEXT NOT NULL,print_roles TEXT NOT NULL,paper TEXT NOT NULL,orientation TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_by INTEGER NOT NULL REFERENCES users(id));
    `);
    for(const table of ['subscription_events','order_import_sources'])for(const action of ['UPDATE','DELETE'])db.exec(`CREATE TRIGGER no_${table}_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable workflow source'); END`);
    db.prepare("UPDATE settings SET value='5' WHERE key='schema_version'").run();db.exec('COMMIT');
  } catch(error){db.exec('ROLLBACK');throw error;}
}
