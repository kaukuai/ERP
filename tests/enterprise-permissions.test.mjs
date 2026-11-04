import test from "node:test";
import assert from "node:assert/strict";
import { ERP, today, addDays } from "../src/core.mjs";
import { WarehouseManagement } from "../src/warehouse-management.mjs";
import { HRPayroll, taiwanPolicyTemplate } from "../src/hr-payroll.mjs";
import { Finance } from "../src/finance.mjs";
import { Production } from "../src/production.mjs";
import { Enterprise } from "../src/enterprise.mjs";
import { publicSite } from "../scripts/local.mjs";
test("blocked bins cannot satisfy sales reservations or consume already reserved stock", (t) => {
  const e = new ERP();
  t.after(() => e.close());
  const a = e.setup({
      username: "admin",
      password: "permissions-fixture-2026",
    }),
    w = new WarehouseManagement(e),
    p = e.saveProduct(a, { sku: "P", name: "商品" }),
    customer = e.savePartner(a, { code: "C", name: "客戶" });
  e.adjust(a, {
    product_id: p.id,
    warehouse_id: 1,
    qty: "10",
    unit_cost: "1",
    reason: "期初",
  });
  w.enable(a, { warehouse_id: 1, version: 0 });
  const receiving = e.get("SELECT id FROM storage_bins WHERE kind='receiving'"),
    blocked = w.saveBin(a, {
      warehouse_id: 1,
      code: "HOLD",
      name: "凍結",
      kind: "blocked",
    });
  w.transfer(a, {
    from_bin_id: receiving.id,
    to_bin_id: blocked.id,
    product_id: p.id,
    qty: "8",
    reason: "凍結",
  });
  let d = e.saveDoc(a, {
    kind: "order",
    warehouse_id: 1,
    partner_id: customer.id,
    lines: [{ product_id: p.id, qty: "3", price: "1" }],
  });
  d = e.transition(a, d.id, "submit");
  assert.throws(() => e.transition(a, d.id, "approve"), /可用庫存/);
  assert.equal(e.stock(p.id, 1).reserved, 0);
  assert.equal(e.bootstrap(a).stocks[0].available_qty, 2000);
  w.transfer(a, {
    from_bin_id: blocked.id,
    to_bin_id: receiving.id,
    product_id: p.id,
    qty: "2",
    reason: "解凍",
  });
  d = e.transition(a, d.id, "approve");
  assert.throws(
    () =>
      w.transfer(a, {
        from_bin_id: receiving.id,
        to_bin_id: blocked.id,
        product_id: p.id,
        qty: "2",
        reason: "錯誤凍結",
      }),
    /預留/,
  );
  assert.equal(e.integrity(a).ok, true);
});
test("configured employee scope permits own attendance/payslip while salary updates outside that scope roll back", (t) => {
  const e = new ERP();
  t.after(() => e.close());
  const a = e.setup({
      username: "admin",
      password: "permissions-fixture-2026",
    }),
    f = new Finance(e),
    hr = new HRPayroll(e);
  e.saveUser(a, {
    username: "staff",
    name: "自己",
    role: "sales",
    password: "permissions-fixture-2026",
  });
  let u = e.user(e.get("SELECT id FROM users WHERE username='staff'").id);
  hr.configure(a, {
    effective_date: "2026-01-01",
    confirm_rules: true,
    definition: {
      ...taiwanPolicyTemplate,
      forbid_self_approval: false,
      source: "測試核定",
    },
  });
  const emps = [];
  for (const [code, name, user] of [
    ["E1", "自己", u.id],
    ["E2", "不可見同事", null],
  ]) {
    const emp = f.saveEmployee(a, {
      code,
      name,
      user_id: user,
      joined_date: "2026-01-01",
    });
    emps.push(emp);
    hr.terms(a, {
      employee_id: emp.id,
      effective_date: "2026-01-01",
      salary_kind: "monthly",
      amount: "45000",
      labor_base: "45000",
      health_base: "45000",
      pension_base: "45000",
    });
  }
  let r = hr.compute(a, {
    period: addDays(today().slice(0, 7) + "-01", -1).slice(0, 7),
    notes: "核對",
  });
  r = hr.action(a, {
    id: r.id,
    version: r.version,
    action: "approve",
    reason: "核准",
  });
  r = hr.action(a, {
    id: r.id,
    version: r.version,
    action: "post",
    reason: "過帳",
  });
  e.access.saveProfile(a, {
    user_id: u.id,
    version: 0,
    inherit_base: false,
    rules: [
      ...["read", "print", "update"].map((action) => ({
        resource: "payroll_runs",
        action,
        effect: "allow",
        scope: "own",
      })),
      { resource: "directory", action: "read", effect: "allow", scope: "own" },
      ...["read", "create", "cancel"].map((action) => ({
        resource: "hr_attendance",
        action,
        effect: "allow",
        scope: "own",
      })),
    ],
  });
  u = e.user(u.id);
  const own = hr.run(u, r.id);
  assert.equal(own.lines.length, 1);
  assert.equal(own.lines[0].employee_id, emps[0].id);
  assert.doesNotMatch(JSON.stringify(hr.data(u)), /不可見同事/);
  assert.match(hr.payslip(u, r.id, own.lines[0].id), /自己/);
  const before = e.get("SELECT count(*) n FROM employment_terms").n;
  assert.throws(
    () =>
      hr.terms(u, {
        employee_id: emps[1].id,
        effective_date: today(),
        salary_kind: "monthly",
        amount: "50000",
        labor_base: "50000",
        health_base: "50000",
        pension_base: "50000",
      }),
    /權限|範圍/,
  );
  assert.equal(e.get("SELECT count(*) n FROM employment_terms").n, before);
  const att = hr.attendance(u, {
    employee_id: emps[0].id,
    date: today(),
    start: "09:00",
    end: "18:00",
    break_minutes: 60,
  });
  assert.ok(att.id);
  assert.throws(
    () =>
      hr.attendance(u, {
        employee_id: emps[1].id,
        date: today(),
        start: "09:00",
        end: "18:00",
        break_minutes: 60,
      }),
    /範圍|權限/,
  );
});
test("warehouse production views hide costs even inside JSON snapshots and a shared-site setting requires a strict HTTPS origin", (t) => {
  const e = new ERP();
  t.after(() => e.close());
  const a = e.setup({
    username: "admin",
    password: "permissions-fixture-2026",
  });
  e.saveUser(a, {
    username: "warehouse",
    name: "倉管",
    role: "warehouse",
    password: "permissions-fixture-2026",
  });
  const u = e.user(e.get("SELECT id FROM users WHERE username='warehouse'").id),
    m = new Production(e),
    raw = e.saveProduct(a, { sku: "RAW", name: "材料" }),
    fg = e.saveProduct(a, { sku: "FG", name: "成品" });
  m.bom(a, {
    product_id: fg.id,
    name: "材料表",
    lines: [{ product_id: raw.id, qty: "1" }],
  });
  const c = m.center(a, {
    code: "C",
    name: "中心",
    daily_minutes: 480,
    hourly_cost: "999",
  });
  m.route(a, {
    product_id: fg.id,
    name: "路線",
    operations: [{ name: "工序", center_id: c.id, minutes_per_unit: "1" }],
  });
  const j = m.create(a, {
      product_id: fg.id,
      warehouse_id: 1,
      qty: "1",
      due_date: addDays(today(), 10),
    }),
    view = new Enterprise(e).get(u, "/api/enterprise/production/detail", {
      id: j.id,
    });
  assert.doesNotMatch(JSON.stringify(view), /hourly_cost|unit_fee|"cost"/);
  assert.equal(
    publicSite("https://erp.example.test/"),
    "https://erp.example.test",
  );
  for (const value of [
    "http://erp.example.test",
    "https://user:pass@erp.example.test",
    "https://erp.example.test/path",
    "https://erp.example.test/?x=1",
  ])
    assert.throws(() => publicSite(value));
  assert.equal(publicSite(""), "");
});
test("a person-scoped payroll post/print grant cannot operate on colleagues inside a readable company run, and out-of-scope center creation rolls back", (t) => {
  const e = new ERP();
  t.after(() => e.close());
  const a = e.setup({
      username: "admin",
      password: "permissions-fixture-2026",
    }),
    f = new Finance(e),
    hr = new HRPayroll(e),
    m = new Production(e);
  e.saveUser(a, {
    username: "clerk",
    name: "經辦",
    role: "finance",
    password: "permissions-fixture-2026",
  });
  let u = e.user(e.get("SELECT id FROM users WHERE username='clerk'").id);
  hr.configure(a, {
    effective_date: "2026-01-01",
    confirm_rules: true,
    definition: {
      ...taiwanPolicyTemplate,
      forbid_self_approval: false,
      source: "測試規則",
    },
  });
  const employees = [];
  for (const [code, user] of [
    ["OWN", u.id],
    ["OTHER", null],
  ]) {
    const emp = f.saveEmployee(a, {
      code,
      name: code,
      user_id: user,
      joined_date: "2026-01-01",
    });
    employees.push(emp);
    hr.terms(a, {
      employee_id: emp.id,
      effective_date: "2026-01-01",
      salary_kind: "monthly",
      amount: "45000",
      labor_base: "45000",
      health_base: "45000",
      pension_base: "45000",
    });
  }
  let r = hr.compute(a, {
    period: addDays(today().slice(0, 7) + "-01", -1).slice(0, 7),
    notes: "核對",
  });
  r = hr.action(a, {
    id: r.id,
    version: r.version,
    action: "approve",
    reason: "核准",
  });
  const bank = f.saveBank(a, {
    code: "B",
    name: "銀行",
    kind: "bank",
    opening_balance: "10000",
  });
  e.access.saveProfile(a, {
    user_id: u.id,
    version: 0,
    inherit_base: false,
    rules: [
      {
        resource: "payroll_runs",
        action: "read",
        effect: "allow",
        scope: "all",
      },
      ...["post", "print"].map((action) => ({
        resource: "payroll_runs",
        action,
        effect: "allow",
        scope: "own",
      })),
      { resource: "directory", action: "read", effect: "allow", scope: "all" },
      { resource: "journals", action: "read", effect: "allow", scope: "all" },
      ...["read", "post"].map((action) => ({
        resource: "banks",
        action,
        effect: "allow",
        scope: "all",
      })),
    ],
  });
  u = e.user(u.id);
  assert.throws(
    () =>
      hr.action(u, {
        id: r.id,
        version: r.version,
        action: "post",
        reason: "不可過帳其他人",
      }),
    /權限|範圍/,
  );
  assert.equal(e.get("SELECT status FROM payroll_runs").status, "approved");
  r = hr.action(a, {
    id: r.id,
    version: r.version,
    action: "post",
    reason: "管理員整批提列",
  });
  const own = r.lines.find((l) => l.employee_id === employees[0].id),
    other = r.lines.find((l) => l.employee_id === employees[1].id);
  assert.throws(
    () =>
      hr.pay(u, {
        id: r.id,
        version: r.version,
        line_id: other.id,
        bank_account_id: bank.id,
        amount: "100",
      }),
    /權限|範圍/,
  );
  assert.throws(() => hr.payslip(u, r.id, other.id), /權限|範圍/);
  r = hr.pay(u, {
    id: r.id,
    version: r.version,
    line_id: own.id,
    bank_account_id: bank.id,
    amount: "100",
  });
  assert.equal(r.lines.find((l) => l.id === own.id).paid, 10000);
  assert.equal(
    e.get("SELECT paid FROM payroll_lines WHERE id=?", other.id).paid,
    0,
  );
  e.access.saveProfile(a, {
    user_id: u.id,
    version: 1,
    inherit_base: false,
    rules: [
      {
        resource: "production_routes",
        action: "read",
        effect: "allow",
        scope: "all",
      },
      {
        resource: "production_routes",
        action: "create",
        effect: "allow",
        scope: "selected",
        owners: [a.id],
      },
    ],
  });
  u = e.user(u.id);
  assert.throws(
    () =>
      m.center(u, {
        code: "NO",
        name: "不在範圍",
        daily_minutes: 480,
        hourly_cost: "0",
      }),
    /權限|範圍/,
  );
  assert.equal(e.get("SELECT count(*) n FROM work_centers").n, 0);
  assert.equal(e.integrity(a).ok, true);
});
