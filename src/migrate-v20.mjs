export function migrateV20(db) {
  if (
    Number(
      db.prepare("SELECT value FROM settings WHERE key='schema_version'").get()
        ?.value,
    ) >= 20
  )
    return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE document_defaults(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,partner_id INTEGER REFERENCES partners(id),locale TEXT NOT NULL DEFAULT '',template_id INTEGER NOT NULL REFERENCES form_templates(id),version INTEGER NOT NULL DEFAULT 1,created_by INTEGER NOT NULL REFERENCES users(id));
      CREATE TABLE partner_document_preferences(partner_id INTEGER PRIMARY KEY REFERENCES partners(id),locale TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1);
      CREATE UNIQUE INDEX document_default_key ON document_defaults(kind,COALESCE(partner_id,0),locale);
      CREATE TABLE document_outbox(id INTEGER PRIMARY KEY,message_id TEXT NOT NULL UNIQUE,document_id INTEGER REFERENCES documents(id),entry_id INTEGER REFERENCES form_entries(id),template_id INTEGER REFERENCES form_templates(id),source_version INTEGER NOT NULL,template_version INTEGER NOT NULL,locale TEXT NOT NULL,recipient TEXT NOT NULL,subject TEXT NOT NULL,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',version INTEGER NOT NULL DEFAULT 1,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,lease TEXT NOT NULL DEFAULT '',claimed_at INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,sent_at TEXT NOT NULL DEFAULT '');
      CREATE INDEX outbox_ready ON document_outbox(status,next_attempt,id);
      CREATE TRIGGER outbox_snapshot BEFORE UPDATE OF message_id,document_id,entry_id,template_id,source_version,template_version,locale,recipient,subject,payload,payload_hash,created_by,created_at ON document_outbox BEGIN SELECT RAISE(ABORT,'immutable delivery snapshot'); END;
    `);
    db.prepare(
      "UPDATE settings SET value='20' WHERE key='schema_version'",
    ).run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
