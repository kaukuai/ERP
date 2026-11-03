export function migrateV13(db) {
  if (
    Number(
      db.prepare("SELECT value FROM settings WHERE key='schema_version'").get()
        ?.value,
    ) >= 13
  )
    return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE access_profiles(user_id INTEGER PRIMARY KEY REFERENCES users(id),manager_id INTEGER REFERENCES users(id),department_id INTEGER REFERENCES departments(id),inherit_base INTEGER NOT NULL DEFAULT 1 CHECK(inherit_base IN (0,1)),superuser INTEGER NOT NULL DEFAULT 0 CHECK(superuser IN (0,1)),version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE access_roles(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,description TEXT NOT NULL DEFAULT '',active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE access_role_parents(role_id INTEGER NOT NULL REFERENCES access_roles(id),parent_id INTEGER NOT NULL REFERENCES access_roles(id),PRIMARY KEY(role_id,parent_id),CHECK(role_id<>parent_id));
      CREATE TABLE access_user_roles(user_id INTEGER NOT NULL REFERENCES users(id),role_id INTEGER NOT NULL REFERENCES access_roles(id),PRIMARY KEY(user_id,role_id));
      CREATE TABLE access_rules(id INTEGER PRIMARY KEY,principal_type TEXT NOT NULL CHECK(principal_type IN ('user','role')),principal_id INTEGER NOT NULL,resource TEXT NOT NULL,action TEXT NOT NULL,effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),scope TEXT NOT NULL,depth INTEGER NOT NULL DEFAULT 0,owners TEXT NOT NULL DEFAULT '[]',warehouses TEXT NOT NULL DEFAULT '[]',categories TEXT NOT NULL DEFAULT '[]',expires_at TEXT);
      CREATE INDEX access_rules_principal ON access_rules(principal_type,principal_id);
      CREATE TABLE access_fields(principal_type TEXT NOT NULL CHECK(principal_type IN ('user','role')),principal_id INTEGER NOT NULL,resource TEXT NOT NULL,field TEXT NOT NULL,mode TEXT NOT NULL CHECK(mode IN ('hidden','readonly','edit')),PRIMARY KEY(principal_type,principal_id,resource,field));
      INSERT INTO settings(key,value) VALUES('access_revision','1');`);
    db.prepare(
      "UPDATE settings SET value='13' WHERE key='schema_version'",
    ).run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
