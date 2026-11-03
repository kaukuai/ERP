export function migrateV12(db){
  if(Number(db.prepare("SELECT value FROM settings WHERE key='schema_version'").get()?.value)>=12)return;
  db.exec('BEGIN IMMEDIATE');try{
    db.exec(`CREATE TABLE master_import_templates(
      id INTEGER PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('products','partners','opening_stock')),
      name TEXT NOT NULL,columns TEXT NOT NULL,defaults TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,
      UNIQUE(kind,name));
      CREATE TABLE master_import_sources(
      import_id INTEGER PRIMARY KEY REFERENCES imports(id),template_id INTEGER NOT NULL REFERENCES master_import_templates(id),
      template_version INTEGER NOT NULL,source_hash TEXT NOT NULL,input_format TEXT NOT NULL CHECK(input_format IN ('csv','xlsx')),
      template_snapshot TEXT NOT NULL);
      CREATE TRIGGER master_import_sources_no_update BEFORE UPDATE ON master_import_sources BEGIN SELECT RAISE(ABORT,'immutable import source'); END;
      CREATE TRIGGER master_import_sources_no_delete BEFORE DELETE ON master_import_sources BEGIN SELECT RAISE(ABORT,'immutable import source'); END;`);
    db.prepare("UPDATE settings SET value='12' WHERE key='schema_version'").run();db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
