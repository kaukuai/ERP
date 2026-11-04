export function migrateV21(db) {
  if (
    Number(
      db.prepare("SELECT value FROM settings WHERE key='schema_version'").get()
        ?.value,
    ) >= 21
  )
    return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
    CREATE TABLE hr_policy_versions(id INTEGER PRIMARY KEY,effective_date TEXT NOT NULL,definition TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
    CREATE TABLE employment_terms(id INTEGER PRIMARY KEY,employee_id INTEGER NOT NULL REFERENCES employees(id),effective_date TEXT NOT NULL,salary_kind TEXT NOT NULL,amount INTEGER NOT NULL,labor_base INTEGER NOT NULL,health_base INTEGER NOT NULL,pension_base INTEGER NOT NULL,dependents INTEGER NOT NULL DEFAULT 0,voluntary_pension_bp INTEGER NOT NULL DEFAULT 0,tax_resident INTEGER NOT NULL DEFAULT 1,tax_bp INTEGER NOT NULL DEFAULT 500,tax_exempt INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,created_by INTEGER NOT NULL REFERENCES users(id),UNIQUE(employee_id,effective_date));
    CREATE TABLE hr_calendar(id INTEGER PRIMARY KEY,date TEXT NOT NULL UNIQUE,kind TEXT NOT NULL CHECK(kind IN ('work','rest','holiday')),name TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_by INTEGER NOT NULL REFERENCES users(id));
    CREATE TABLE hr_attendance(id INTEGER PRIMARY KEY,employee_id INTEGER NOT NULL REFERENCES employees(id),date TEXT NOT NULL,start_minute INTEGER NOT NULL,end_minute INTEGER NOT NULL,break_minutes INTEGER NOT NULL,normal_minutes INTEGER NOT NULL,overtime_minutes INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',version INTEGER NOT NULL DEFAULT 1,notes TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),approved_by INTEGER REFERENCES users(id));
    CREATE UNIQUE INDEX attendance_active_date ON hr_attendance(employee_id,date) WHERE status IN ('pending','approved');
    CREATE TABLE hr_leave_balances(id INTEGER PRIMARY KEY,employee_id INTEGER NOT NULL REFERENCES employees(id),year INTEGER NOT NULL,kind TEXT NOT NULL,minutes INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_by INTEGER NOT NULL REFERENCES users(id),UNIQUE(employee_id,year,kind));
    CREATE TABLE hr_leave_requests(id INTEGER PRIMARY KEY,employee_id INTEGER NOT NULL REFERENCES employees(id),date TEXT NOT NULL,kind TEXT NOT NULL,start_minute INTEGER NOT NULL,end_minute INTEGER NOT NULL,paid_bp INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',version INTEGER NOT NULL DEFAULT 1,notes TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),approved_by INTEGER REFERENCES users(id));
    CREATE TABLE payroll_runs(id INTEGER PRIMARY KEY,no TEXT NOT NULL UNIQUE,period TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',version INTEGER NOT NULL DEFAULT 1,policy_id INTEGER NOT NULL REFERENCES hr_policy_versions(id),policy_snapshot TEXT NOT NULL,source_hash TEXT NOT NULL,notes TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,approved_by INTEGER REFERENCES users(id));
    CREATE UNIQUE INDEX payroll_period_active ON payroll_runs(period) WHERE status NOT IN ('cancelled','reversed');
    CREATE TABLE payroll_lines(id INTEGER PRIMARY KEY,run_id INTEGER NOT NULL REFERENCES payroll_runs(id),employee_id INTEGER NOT NULL REFERENCES employees(id),base_pay INTEGER NOT NULL,overtime_pay INTEGER NOT NULL,extra_pay INTEGER NOT NULL,leave_deduction INTEGER NOT NULL,other_deduction INTEGER NOT NULL,tax INTEGER NOT NULL,labor_employee INTEGER NOT NULL,health_employee INTEGER NOT NULL,pension_employee INTEGER NOT NULL,labor_employer INTEGER NOT NULL,health_employer INTEGER NOT NULL,pension_employer INTEGER NOT NULL,net_pay INTEGER NOT NULL,paid INTEGER NOT NULL DEFAULT 0,snapshot TEXT NOT NULL,UNIQUE(run_id,employee_id));
    CREATE TABLE payroll_payments(id INTEGER PRIMARY KEY,no TEXT NOT NULL UNIQUE,line_id INTEGER NOT NULL REFERENCES payroll_lines(id),bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),amount INTEGER NOT NULL,date TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'posted',created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
    CREATE TABLE payroll_employee_profiles(id INTEGER PRIMARY KEY,employee_id INTEGER NOT NULL UNIQUE REFERENCES employees(id),tax_identifier TEXT NOT NULL,address TEXT NOT NULL,bank_name TEXT NOT NULL,bank_account TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_by INTEGER NOT NULL REFERENCES users(id));
    CREATE TABLE payroll_remittances(id INTEGER PRIMARY KEY,no TEXT NOT NULL UNIQUE,run_id INTEGER NOT NULL REFERENCES payroll_runs(id),kind TEXT NOT NULL,account TEXT NOT NULL REFERENCES accounts(code),amount INTEGER NOT NULL,date TEXT NOT NULL,bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),status TEXT NOT NULL DEFAULT 'posted',reference TEXT NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
    INSERT OR IGNORE INTO accounts VALUES('5102','薪資費用','expense'),('5103','雇主保險與退休金費用','expense'),('2502','應付薪資','liability'),('2503','應付薪資扣繳','liability'),('2504','應付勞健保費','liability'),('2505','應付退休金','liability'),('2506','應付其他薪資扣款','liability');
    CREATE INDEX attendance_employee_period ON hr_attendance(employee_id,date,status);
    CREATE INDEX leave_employee_period ON hr_leave_requests(employee_id,date,status);
    CREATE TRIGGER payroll_snapshot BEFORE UPDATE OF run_id,employee_id,base_pay,overtime_pay,extra_pay,leave_deduction,other_deduction,tax,labor_employee,health_employee,pension_employee,labor_employer,health_employer,pension_employer,net_pay,snapshot ON payroll_lines BEGIN SELECT RAISE(ABORT,'immutable payroll snapshot'); END;
  `);
    for (const table of ["hr_policy_versions"])
      for (const action of ["UPDATE", "DELETE"])
        db.exec(
          `CREATE TRIGGER ${table}_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable statutory policy'); END`,
        );
    db.prepare(
      "UPDATE settings SET value='21' WHERE key='schema_version'",
    ).run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
