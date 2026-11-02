export function migrateV8(db){
  if(Number(db.prepare("SELECT value FROM settings WHERE key='schema_version'").get()?.value)>=8)return;
  db.exec('BEGIN IMMEDIATE');try{
    db.exec(`
      CREATE TABLE invoice_ranges(id INTEGER PRIMARY KEY,year INTEGER NOT NULL,start_month INTEGER NOT NULL,letters TEXT NOT NULL,start_no INTEGER NOT NULL,end_no INTEGER NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),CHECK(start_month IN (1,3,5,7,9,11)),CHECK(start_no>=0 AND end_no>=start_no AND end_no<=99999999));
      CREATE TABLE invoice_numbers(id INTEGER PRIMARY KEY,range_id INTEGER NOT NULL REFERENCES invoice_ranges(id),number INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('reserved','used','void')),reason TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),UNIQUE(range_id,number));
      CREATE TABLE invoice_number_events(id INTEGER PRIMARY KEY,number_id INTEGER NOT NULL REFERENCES invoice_numbers(id),action TEXT NOT NULL,reason TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
      CREATE TABLE invoice_print_profiles(id INTEGER PRIMARY KEY,name TEXT UNIQUE NOT NULL,paper TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,device_name TEXT NOT NULL,logo TEXT NOT NULL DEFAULT '',donation_code TEXT NOT NULL DEFAULT '',footer TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE invoice_exchange_profiles(id INTEGER PRIMARY KEY,name TEXT UNIQUE NOT NULL,spec_version TEXT NOT NULL,columns TEXT NOT NULL,delimiter TEXT NOT NULL DEFAULT ',',version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE invoice_exchange_jobs(id INTEGER PRIMARY KEY,profile_id INTEGER NOT NULL REFERENCES invoice_exchange_profiles(id),profile_version INTEGER NOT NULL,rows TEXT NOT NULL,errors TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'preview',source_hash TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
      CREATE TABLE invoice_records(id INTEGER PRIMARY KEY,number_id INTEGER UNIQUE NOT NULL REFERENCES invoice_numbers(id),invoice_no TEXT NOT NULL,date TEXT NOT NULL,buyer_tax_id TEXT NOT NULL,net INTEGER NOT NULL,tax INTEGER NOT NULL,total INTEGER NOT NULL,provider_ref TEXT NOT NULL,job_id INTEGER NOT NULL REFERENCES invoice_exchange_jobs(id),created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,CHECK(net>=0 AND tax>=0 AND net+tax=total));
    `);
    for(const table of ['invoice_ranges','invoice_number_events','invoice_records'])for(const action of ['UPDATE','DELETE'])db.exec(`CREATE TRIGGER no_${table}_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable invoice source'); END`);
    db.prepare("UPDATE settings SET value='8' WHERE key='schema_version'").run();db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
