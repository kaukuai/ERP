export function migrateV16(db) {
  if (
    Number(
      db.prepare("SELECT value FROM settings WHERE key='schema_version'").get()
        ?.value,
    ) >= 16
  )
    return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE approval_rules(id INTEGER PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,min_amount INTEGER NOT NULL,max_amount INTEGER,definition TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,created_by INTEGER NOT NULL REFERENCES users(id));
      CREATE TABLE approval_rule_versions(rule_id INTEGER NOT NULL REFERENCES approval_rules(id),version INTEGER NOT NULL,definition TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,PRIMARY KEY(rule_id,version));
      CREATE TABLE approval_requests(id INTEGER PRIMARY KEY,document_id INTEGER NOT NULL REFERENCES documents(id),document_version INTEGER NOT NULL,rule_id INTEGER NOT NULL,definition TEXT NOT NULL,stage INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending',version INTEGER NOT NULL DEFAULT 1,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
      CREATE UNIQUE INDEX approval_active_request ON approval_requests(document_id) WHERE status='pending';
      CREATE TABLE approval_votes(id INTEGER PRIMARY KEY,request_id INTEGER NOT NULL REFERENCES approval_requests(id),stage INTEGER NOT NULL,principal_id INTEGER NOT NULL REFERENCES users(id),actor_id INTEGER NOT NULL REFERENCES users(id),decision TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(request_id,stage,principal_id));
      CREATE TABLE approval_delegations(id INTEGER PRIMARY KEY,principal_id INTEGER NOT NULL REFERENCES users(id),delegate_id INTEGER NOT NULL REFERENCES users(id),starts TEXT NOT NULL,ends TEXT NOT NULL,kind TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,created_by INTEGER NOT NULL REFERENCES users(id));
      CREATE TABLE format_grants(kind TEXT NOT NULL,format_id INTEGER NOT NULL,user_id INTEGER NOT NULL REFERENCES users(id),action TEXT NOT NULL,effect TEXT NOT NULL,PRIMARY KEY(kind,format_id,user_id,action));
      CREATE TABLE format_grant_versions(kind TEXT NOT NULL,format_id INTEGER NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(kind,format_id));
      CREATE TRIGGER approval_request_snapshot BEFORE UPDATE OF document_id,rule_id,definition,created_by,created_at ON approval_requests BEGIN SELECT RAISE(ABORT,'immutable approval snapshot'); END;
      INSERT OR IGNORE INTO settings VALUES('entry_window_policy','{"version":0,"trade":null,"inventory":null,"finance":null}');
    `);
    for (const table of ["approval_rule_versions", "approval_votes"])
      for (const verb of ["UPDATE", "DELETE"])
        db.exec(
          `CREATE TRIGGER ${table}_${verb.toLowerCase()} BEFORE ${verb} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable approval history'); END;`,
        );
    db.prepare(
      "UPDATE settings SET value='16' WHERE key='schema_version'",
    ).run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
