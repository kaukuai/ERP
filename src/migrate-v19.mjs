export function migrateV19(db) {
  if (
    Number(
      db.prepare("SELECT value FROM settings WHERE key='schema_version'").get()
        ?.value,
    ) >= 19
  )
    return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE fx_currencies(code TEXT PRIMARY KEY,name TEXT NOT NULL,precision INTEGER NOT NULL CHECK(precision BETWEEN 0 AND 3),active INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1);
      INSERT INTO fx_currencies VALUES('USD','美元',2,1,1),('EUR','歐元',2,1,1),('JPY','日圓',0,1,1);
      CREATE TABLE fx_rates(id INTEGER PRIMARY KEY,currency TEXT NOT NULL REFERENCES fx_currencies(code),date TEXT NOT NULL,rate INTEGER NOT NULL CHECK(rate>0),source TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_by INTEGER NOT NULL REFERENCES users(id),UNIQUE(currency,date));
      CREATE TABLE foreign_accounts(id INTEGER PRIMARY KEY,no TEXT NOT NULL UNIQUE,kind TEXT NOT NULL CHECK(kind IN ('receivable','payable')),partner_id INTEGER NOT NULL REFERENCES partners(id),currency TEXT NOT NULL REFERENCES fx_currencies(code),precision INTEGER NOT NULL,foreign_amount INTEGER NOT NULL,foreign_paid INTEGER NOT NULL DEFAULT 0,original_base INTEGER NOT NULL,book_value INTEGER NOT NULL DEFAULT 0,rate INTEGER NOT NULL,date TEXT NOT NULL,due_date TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',version INTEGER NOT NULL DEFAULT 1,notes TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
      CREATE TABLE foreign_account_lines(id INTEGER PRIMARY KEY,account_id INTEGER NOT NULL REFERENCES foreign_accounts(id),account TEXT NOT NULL REFERENCES accounts(code),description TEXT NOT NULL,foreign_amount INTEGER NOT NULL,base_amount INTEGER NOT NULL);
      CREATE TABLE fx_settlements(id INTEGER PRIMARY KEY,no TEXT NOT NULL UNIQUE,account_id INTEGER NOT NULL REFERENCES foreign_accounts(id),date TEXT NOT NULL,foreign_amount INTEGER NOT NULL,rate INTEGER NOT NULL,cash_amount INTEGER NOT NULL,book_released INTEGER NOT NULL,realized INTEGER NOT NULL,bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),account_version INTEGER NOT NULL,journal_snapshot TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'posted',created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
      CREATE TABLE fx_valuations(id INTEGER PRIMARY KEY,no TEXT NOT NULL UNIQUE,date TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'posted',created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
      CREATE TABLE fx_valuation_lines(id INTEGER PRIMARY KEY,valuation_id INTEGER NOT NULL REFERENCES fx_valuations(id),account_id INTEGER NOT NULL REFERENCES foreign_accounts(id),foreign_outstanding INTEGER NOT NULL,old_book INTEGER NOT NULL,new_book INTEGER NOT NULL,rate INTEGER NOT NULL,account_version INTEGER NOT NULL,journal_snapshot TEXT NOT NULL,UNIQUE(valuation_id,account_id));
      CREATE TABLE foreign_activity(id INTEGER PRIMARY KEY,account_id INTEGER NOT NULL REFERENCES foreign_accounts(id),kind TEXT NOT NULL,entity_id INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1,UNIQUE(account_id,kind,entity_id));
      INSERT OR IGNORE INTO accounts VALUES('1102','外幣應收帳款','asset'),('2002','外幣應付帳款','liability'),('4300','已實現匯兌收益','revenue'),('4301','未實現匯兌收益','revenue'),('5300','已實現匯兌損失','expense'),('5301','未實現匯兌損失','expense');
      CREATE INDEX foreign_due_lookup ON foreign_accounts(status,currency,date);
    `);
    for (const table of ["foreign_account_lines", "fx_valuation_lines"])
      for (const action of ["UPDATE", "DELETE"])
        db.exec(
          `CREATE TRIGGER ${table}_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable foreign snapshot'); END`,
        );
    db.exec(
      "CREATE TRIGGER foreign_header_lock BEFORE UPDATE OF kind,partner_id,currency,precision,foreign_amount,original_base,rate,date,due_date,created_by,created_at ON foreign_accounts BEGIN SELECT RAISE(ABORT,'immutable foreign document'); END",
    );
    db.exec(
      "CREATE TRIGGER fx_settlement_lock BEFORE UPDATE OF account_id,date,foreign_amount,rate,cash_amount,book_released,realized,bank_account_id,account_version,journal_snapshot,created_by,created_at ON fx_settlements BEGIN SELECT RAISE(ABORT,'immutable foreign settlement'); END",
    );
    db.prepare(
      "UPDATE settings SET value='19' WHERE key='schema_version'",
    ).run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
