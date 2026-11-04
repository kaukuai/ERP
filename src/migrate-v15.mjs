export function migrateV15(db) {
  if (
    Number(
      db.prepare("SELECT value FROM settings WHERE key='schema_version'").get()
        ?.value,
    ) >= 15
  )
    return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE form_templates (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
        definition TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1, created_by INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE form_template_versions (
        template_id INTEGER NOT NULL REFERENCES form_templates(id), version INTEGER NOT NULL,
        name TEXT NOT NULL, definition TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL, PRIMARY KEY(template_id,version)
      );
      CREATE TABLE form_entries (
        id INTEGER PRIMARY KEY, no TEXT NOT NULL UNIQUE, template_id INTEGER NOT NULL REFERENCES form_templates(id),
        template_version INTEGER NOT NULL, title TEXT NOT NULL, definition TEXT NOT NULL,
        company_snapshot TEXT NOT NULL, values_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
        version INTEGER NOT NULL DEFAULT 1, created_by INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE form_entry_events (
        id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES form_entries(id),
        version INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL,
        created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
      );
    `);
    for (const table of ["form_template_versions", "form_entry_events"])
      for (const verb of ["UPDATE", "DELETE"])
        db.exec(
          `CREATE TRIGGER ${table}_no_${verb.toLowerCase()} BEFORE ${verb} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable form history'); END;`,
        );
    db.prepare(
      "UPDATE settings SET value='15' WHERE key='schema_version'",
    ).run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
