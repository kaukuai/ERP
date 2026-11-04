export function migrateV11(db){
  if(Number(db.prepare("SELECT value FROM settings WHERE key='schema_version'").get()?.value)>=11)return;
  db.exec('BEGIN IMMEDIATE');try{
    db.exec(`CREATE TABLE company_catalog(slug TEXT PRIMARY KEY,name TEXT NOT NULL,filename TEXT NOT NULL UNIQUE);
      CREATE TABLE company_summary_grants(root_username TEXT PRIMARY KEY,include_cost INTEGER NOT NULL DEFAULT 0 CHECK(include_cost IN (0,1)));`);
    db.prepare("UPDATE settings SET value='11' WHERE key='schema_version'").run();db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
