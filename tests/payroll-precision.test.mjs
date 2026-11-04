import test from "node:test";
import assert from "node:assert/strict";
import { ERP, today, addDays } from "../src/core.mjs";
import { Finance } from "../src/finance.mjs";
import {
  HRPayroll,
  taiwanPolicyTemplate,
  ntdPremium,
} from "../src/hr-payroll.mjs";
test("Taiwan default overtime uses exact 4/3 and 5/3, monthly holiday work adds one paid day and premiums round once", (t) => {
  const e = new ERP();
  t.after(() => e.close());
  const a = e.setup({
      username: "admin",
      password: "payroll-precision-fixture",
    }),
    f = new Finance(e),
    hr = new HRPayroll(e),
    period = addDays(today().slice(0, 7) + "-01", -1).slice(0, 7);
  hr.configure(a, {
    effective_date: "2026-01-01",
    confirm_rules: true,
    definition: {
      ...taiwanPolicyTemplate,
      forbid_self_approval: false,
      source: "公式驗證",
    },
  });
  const emp = f.saveEmployee(a, {
    code: "E",
    name: "員工",
    joined_date: "2026-01-01",
  });
  hr.terms(a, {
    employee_id: emp.id,
    effective_date: "2026-01-01",
    salary_kind: "monthly",
    amount: "45000",
    labor_base: "45000",
    health_base: "45000",
    pension_base: "45000",
  });
  for (const [day, kind, start, end] of [
    [period + "-05", "work", "09:00", "22:00"],
    [period + "-10", "holiday", "09:00", "13:00"],
  ]) {
    hr.calendar(a, { date: day, kind, name: "公式驗證日" });
    let att = hr.attendance(a, {
      employee_id: emp.id,
      date: day,
      start,
      end,
      break_minutes: 60,
    });
    hr.decide(a, {
      id: att.id,
      version: att.version,
      type: "attendance",
      action: "approve",
      reason: "已核對",
    });
  }
  const r = hr.compute(a, { period, notes: "公式驗證" });
  assert.equal(r.lines[0].overtime_pay, 262500);
  assert.equal(ntdPremium(4500000, [517, 3000], 100000000), 69800);
  assert.equal(e.integrity(a).ok, true);
});
