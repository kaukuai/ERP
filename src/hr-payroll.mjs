import { createHash } from "node:crypto";
import { escapeHTML as E } from "./print.mjs";
import {
  fail,
  permit,
  integer,
  scaled,
  ratio,
  txt,
  dateValue,
  today,
  now,
  addDays,
} from "./core.mjs";
import {
  enterprisePermission as permission,
  enterpriseRows as rows,
  revision,
  event,
} from "./enterprise-common.mjs";
const resource = "payroll_runs";
const minute = (v) => {
  if (typeof v !== "string" || !/^\d{2}:\d{2}$/.test(v)) fail("時間請用 HH:mm");
  const [h, m] = v.split(":").map(Number);
  return integer(h, 0, 23) * 60 + integer(m, 0, 59);
};
const whole = (n) => ratio(n, 1, 100) * 100;
export function ntdPremium(base, factors, denominator) {
  const n = factors.reduce((v, f) => v * BigInt(f), BigInt(base)),
    d = BigInt(denominator) * 100n;
  return integer(Number((n + d / 2n) / d) * 100);
}

function month(period) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) fail("月份格式錯誤");
  const start = dateValue(period + "-01"),
    end = addDays(
      new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5)), 1))
        .toISOString()
        .slice(0, 10),
      -1,
    );
  return {
    start,
    end,
    days: Number(end.slice(-2)),
    year: Number(period.slice(0, 4)),
  };
}
export const taiwanPolicyTemplate = {
  country: "TW",
  effective_date: "2026-01-01",
  min_monthly: "29500",
  min_hourly: "196",
  labor_bp: 1250,
  labor_employee_bp: 2000,
  labor_employer_bp: 7000,
  health_bp: 517,
  health_employee_bp: 3000,
  health_employer_bp: 6000,
  health_average_dependents_bp: 5600,
  employer_pension_bp: 600,
  occupational_bp: 0,
  monthly_hours: 240,
  normal_minutes: 480,
  max_daily_overtime: 240,
  monthly_overtime_limit: 2760,
  forbid_self_approval: true,
  tax_nonresident_low_bp: 600,
  tax_nonresident_high_bp: 1800,
  overtime: [
    { minutes: 120, multiplier_bp: 13334, numerator: 4, denominator: 3 },
    { minutes: 120, multiplier_bp: 16667, numerator: 5, denominator: 3 },
  ],
  rest_overtime: [
    { minutes: 120, multiplier_bp: 13334, numerator: 4, denominator: 3 },
    { minutes: 360, multiplier_bp: 16667, numerator: 5, denominator: 3 },
    { minutes: 240, multiplier_bp: 26667, numerator: 8, denominator: 3 },
  ],
  holiday_multiplier_bp: 20000,
  leave_types: [
    { key: "annual", label: "特別休假", paid_bp: 10000, quota: true },
    { key: "personal", label: "事假", paid_bp: 0, quota: true },
    { key: "sick", label: "普通傷病假", paid_bp: 5000, quota: true },
  ],
  source:
    "請填入公司核對的官方費率／投保級距及扣繳規則來源；範本須確認後才能生效",
};
export class HRPayroll {
  constructor(e) {
    this.e = e;
  }
  permission(u, action = "read", id = null) {
    if (
      !this.e.access.policy(u).configured &&
      ["read", "print"].includes(action) &&
      id &&
      u.role !== "admin" &&
      this.e.get(
        "SELECT r.id FROM payroll_runs r JOIN payroll_lines l ON l.run_id=r.id JOIN employees e ON e.id=l.employee_id WHERE r.id=? AND e.user_id=? AND r.status='posted'",
        id,
        u.id,
      )
    )
      return;
    permission(this.e, u, resource, action, id);
  }
  profile(u, b) {
    this.permission(u, "update");
    return this.e.tx(() => {
      const emp = this.e.get(
        "SELECT * FROM employees WHERE id=?",
        integer(b.employee_id, 1),
      );
      if (!emp) fail("員工不存在");
      const old = this.e.get(
        "SELECT * FROM payroll_employee_profiles WHERE employee_id=?",
        emp.id,
      );
      if ((old?.version || 0) !== integer(b.version ?? 0))
        fail("薪資個人資料已更新", 409);
      const identifier = txt(b.tax_identifier, 20, true).toUpperCase();
      if (!/^[A-Z0-9]{8,20}$/.test(identifier))
        fail("請填核對過的身分／居留或稅籍識別碼");
      const account = txt(b.bank_account, 40, true);
      if (!/^[0-9 -]{4,40}$/.test(account)) fail("匯款帳號格式錯誤");
      this.e.run(
        "INSERT INTO payroll_employee_profiles(employee_id,tax_identifier,address,bank_name,bank_account,created_by) VALUES(?,?,?,?,?,?) ON CONFLICT(employee_id) DO UPDATE SET tax_identifier=excluded.tax_identifier,address=excluded.address,bank_name=excluded.bank_name,bank_account=excluded.bank_account,version=version+1",
        emp.id,
        identifier,
        txt(b.address, 300, true),
        txt(b.bank_name, 100, true),
        account,
        u.id,
      );
      const r = this.e.get(
        "SELECT * FROM payroll_employee_profiles WHERE employee_id=?",
        emp.id,
      );
      this.e.access.assert(
        this.e.access.policy(u),
        "payroll_runs",
        "update",
        "payroll_employee_profiles",
        r.id,
      );
      event(this.e, u, "payroll_employee_profiles", r.id, "save", {
        employee_id: emp.id,
        version: r.version,
      });
      return { id: r.id };
    });
  }
  remittance(u, b) {
    return this.e.tx(() => {
      const r = this.run(u, b.id, "post");
      revision(r, b);
      if (r.status !== "posted") fail("請先過帳薪資");
      const account = {
        tax: "2503",
        insurance: "2504",
        pension: "2505",
        other: "2506",
      }[b.kind];
      if (!account) fail("繳納種類錯誤");
      const full = this.e.get(
        "SELECT count(*) n FROM payroll_lines WHERE run_id=?",
        r.id,
      ).n;
      if (r.lines.length !== full) fail("需具備整份薪資權限", 403);
      for (const line of r.lines)
        this.e.access.assert(
          this.e.access.policy(u),
          resource,
          "post",
          "payroll_lines",
          line.id,
        );
      const expected = this.journalLines(r).find((l) => l[0] === account)[2],
        paid = this.e.get(
          "SELECT COALESCE(sum(amount),0) n FROM payroll_remittances WHERE run_id=? AND account=? AND status='posted'",
          r.id,
          account,
        ).n,
        amount = scaled(b.amount, 2, 1);
      if (amount > expected - paid) fail("繳納超過本期未繳餘額");
      const bank = this.e.get(
        "SELECT * FROM bank_accounts WHERE id=?",
        integer(b.bank_account_id, 1),
      );
      if (!bank) fail("付款帳戶不存在");
      this.e.access.assert(
        this.e.access.policy(u),
        "banks",
        "post",
        "bank_accounts",
        bank.id,
      );
      if (
        this.e.get(
          "SELECT COALESCE(sum(debit-credit),0) n FROM journal_lines WHERE account=?",
          bank.gl_code,
        ).n < amount
      )
        fail("付款帳戶餘額不足");
      const date = dateValue(b.date);
      if (date > today() || date < month(r.period).end) fail("繳納日期錯誤");
      const no = this.e.number("PAYREM"),
        reference = txt(b.reference, 200, true);
      this.e.journal(
        u,
        "薪資法定款繳納登錄",
        no,
        [
          [account, amount, 0],
          [bank.gl_code, 0, amount],
        ],
        date,
      );
      const id = Number(
        this.e.run(
          "INSERT INTO payroll_remittances(no,run_id,kind,account,amount,date,bank_account_id,reference,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
          no,
          r.id,
          b.kind,
          account,
          amount,
          date,
          bank.id,
          reference,
          u.id,
          now(),
        ).lastInsertRowid,
      );
      this.e.run("UPDATE payroll_runs SET version=version+1 WHERE id=?", r.id);
      event(this.e, u, resource, r.id, "remittance", {
        id,
        no,
        kind: b.kind,
        amount,
        reference,
      });
      return this.run(u, r.id);
    });
  }
  reverseRemittance(u, b) {
    return this.e.tx(() => {
      const p = this.e.get(
        "SELECT * FROM payroll_remittances WHERE id=?",
        integer(b.remittance_id, 1),
      );
      if (!p || p.status !== "posted") fail("繳納紀錄不存在或已沖回");
      const r = this.run(u, p.run_id, "reverse");
      if (
        r.lines.length !==
        this.e.get("SELECT count(*) n FROM payroll_lines WHERE run_id=?", r.id)
          .n
      )
        fail("沖回整批繳納需具備全部員工權限", 403);
      for (const line of r.lines)
        this.e.access.assert(
          this.e.access.policy(u),
          resource,
          "reverse",
          "payroll_lines",
          line.id,
        );
      revision(r, b);
      const bank = this.e.get(
          "SELECT * FROM bank_accounts WHERE id=?",
          p.bank_account_id,
        ),
        reason = txt(b.reason, 500, true),
        no = this.e.number("REMREV");
      this.e.access.assert(
        this.e.access.policy(u),
        "banks",
        "post",
        "bank_accounts",
        bank.id,
      );
      this.e.journal(u, "法定款繳納沖回 " + reason, no, [
        [bank.gl_code, p.amount, 0],
        [p.account, 0, p.amount],
      ]);
      this.e.run(
        "UPDATE payroll_remittances SET status='reversed' WHERE id=?",
        p.id,
      );
      this.e.run("UPDATE payroll_runs SET version=version+1 WHERE id=?", r.id);
      event(this.e, u, resource, r.id, "reverse_remittance", {
        remittance_id: p.id,
        reason,
        no,
      });
      return this.run(u, r.id);
    });
  }
  export(u, id) {
    const r = this.run(u, id, "export"),
      header = [
        "月份",
        "員工代號",
        "姓名",
        "稅籍識別碼",
        "地址",
        "銀行",
        "匯款帳號",
        "所得金額TWD",
        "扣繳TWD",
        "員工勞健保TWD",
        "員工自提TWD",
        "淨薪TWD",
        "已付TWD",
      ],
      records = r.lines.map((l) => {
        this.e.access.assert(
          this.e.access.policy(u),
          resource,
          "export",
          "payroll_lines",
          l.id,
        );
        const s = JSON.parse(l.snapshot),
          p = this.e.get(
            "SELECT * FROM payroll_employee_profiles WHERE employee_id=?",
            l.employee_id,
          );
        if (!p) fail("員工 " + s.employee.code + " 缺少核對過的扣繳／匯款資料");
        this.e.access.assert(
          this.e.access.policy(u),
          "payroll_runs",
          "export",
          "payroll_employee_profiles",
          p.id,
        );
        return [
          r.period,
          s.employee.code,
          s.employee.name,
          p.tax_identifier,
          p.address,
          p.bank_name,
          p.bank_account,
          (l.base_pay + l.overtime_pay + l.extra_pay - l.leave_deduction) / 100,
          l.tax / 100,
          (l.labor_employee + l.health_employee) / 100,
          l.pension_employee / 100,
          l.net_pay / 100,
          l.paid / 100,
        ];
      }),
      cell = (v) =>
        '"' +
        String(
          typeof v === "string" && /^[=+@\-\t\r\n]/.test(v) ? "'" + v : v,
        ).replaceAll('"', '""') +
        '"';
    event(this.e, u, resource, r.id, "export", { rows: records.length });
    return {
      filename: r.no + "-核對資料.csv",
      csv:
        "\uFEFF" +
        [header, ...records].map((row) => row.map(cell).join(",")).join("\r\n"),
      note: "核對用資料，不是稅務申報上傳檔或銀行匯款指令",
    };
  }
  payslip(u, id, lineId) {
    const r = this.run(u, id, "print"),
      l = r.lines.find((l) => l.id === integer(lineId, 1));
    if (!l) fail("無權檢視此員工薪資", 403);
    this.e.access.assert(
      this.e.access.policy(u),
      resource,
      "print",
      "payroll_lines",
      l.id,
    );
    const emp = JSON.parse(l.snapshot).employee,
      m = (v) => (v / 100).toFixed(2),
      items = [
        ["本薪", l.base_pay],
        ["加班費", l.overtime_pay],
        ["其他加給", l.extra_pay],
        ["請假扣款", l.leave_deduction],
        ["其他扣款", l.other_deduction],
        ["扣繳所得稅", l.tax],
        ["員工勞就保", l.labor_employee],
        ["員工健保", l.health_employee],
        ["員工退休金自提", l.pension_employee],
        ["淨薪", l.net_pay],
        ["已付", l.paid],
      ];
    event(this.e, u, resource, r.id, "print_payslip", { line_id: l.id });
    return `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>薪資明細</title><style>body{font-family:system-ui;margin:20mm;color:#243c31}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccd3ca;padding:8px;overflow-wrap:anywhere}button{margin:16px 0}@media print{button{display:none}}</style><h1>${E(this.e.settings().company)} · 薪資明細</h1><p>${E(r.period)} · ${E(emp.code)} ${E(emp.name)} · ${E(r.status)}</p><table><tr><th>項目</th><th>TWD</th></tr>${items.map(([k, v]) => `<tr><td>${E(k)}</td><td>${m(v)}</td></tr>`).join("")}</table><p>單號 ${E(r.no)}，修訂 ${r.version}。以公司核定的出勤及法定規則計算。</p><button id="print">列印／另存 PDF</button><script src="/print.js"></script></html>`;
  }
  employee(u, id, action = "read") {
    const emp = this.e.get(
      "SELECT * FROM employees WHERE id=?",
      integer(id, 1),
    );
    if (!emp) fail("員工不存在", 404);
    const p = this.e.access.policy(u);
    if (p.configured) {
      const check = (a) => {
        const rules = this.e.access.rules(p, "hr_attendance", a),
          columns = this.e.access.tables.get("employees").columns,
          allows = rules
            .filter((r) => r.effect === "allow")
            .map((r) =>
              this.e.access.rulePredicate(p, r, columns, "employees"),
            ),
          denies = rules
            .filter((r) => r.effect === "deny")
            .map((r) =>
              this.e.access.rulePredicate(p, r, columns, "employees"),
            );
        return this.e.access.one(
          "SELECT 1 FROM main.employees WHERE id=? AND (" +
            (allows.join(" OR ") || "0") +
            ")" +
            (denies.length ? " AND NOT (" + denies.join(" OR ") + ")" : ""),
          emp.id,
        );
      };
      if (
        !p.superuser &&
        (!check(action) || (action !== "read" && !check("read")))
      )
        fail("此員工不在出勤授權範圍", 403);
      this.e.access.assert(p, "directory", "read", "employees", emp.id);
    } else if (!["admin", "manager"].includes(u.role) && emp.user_id !== u.id)
      fail("只能操作本人的出勤與請假", 403);
    return emp;
  }
  policy(date) {
    const p = this.e.get(
      "SELECT * FROM hr_policy_versions WHERE effective_date<=? ORDER BY effective_date DESC,id DESC LIMIT 1",
      date,
    );
    if (!p) fail("請先核定適用日期的臺灣薪資規則", 409);
    return { ...p, definition: JSON.parse(p.definition) };
  }
  configure(u, b) {
    this.e.access.requireAdmin(u);
    return this.e.tx(() => {
      if (b.confirm_rules !== true)
        fail("請確認已核對適用的法定費率、級距與公司規則");
      const d = b.definition;
      if (!d || d.country !== "TW") fail("本版法定規則支援臺灣");
      const p = {
        ...taiwanPolicyTemplate,
        country: "TW",
        effective_date: dateValue(b.effective_date),
        source: txt(d.source, 1000, true),
      };
      for (const k of [
        "labor_bp",
        "labor_employee_bp",
        "labor_employer_bp",
        "health_bp",
        "health_employee_bp",
        "health_employer_bp",
        "health_average_dependents_bp",
        "employer_pension_bp",
        "occupational_bp",
        "tax_nonresident_low_bp",
        "tax_nonresident_high_bp",
      ])
        p[k] = integer(d[k] ?? p[k], 0, 10000);
      if (
        p.labor_employee_bp + p.labor_employer_bp > 10000 ||
        p.health_employee_bp + p.health_employer_bp > 10000
      )
        fail("保費分擔比例合計不能超過 100%");
      if (p.employer_pension_bp < 600) fail("臺灣雇主提繳不得低於 6%");
      p.min_monthly = scaled(d.min_monthly ?? p.min_monthly);
      p.min_hourly = scaled(d.min_hourly ?? p.min_hourly);
      p.monthly_hours = integer(d.monthly_hours ?? 240, 1, 744);
      p.normal_minutes = integer(d.normal_minutes ?? 480, 1, 720);
      p.max_daily_overtime = integer(d.max_daily_overtime ?? 240, 0, 720);
      p.monthly_overtime_limit = integer(
        d.monthly_overtime_limit ?? 2760,
        0,
        3240,
      );
      p.forbid_self_approval = d.forbid_self_approval !== false;
      p.holiday_multiplier_bp = integer(
        d.holiday_multiplier_bp ?? 20000,
        10000,
        100000,
      );
      for (const key of ["overtime", "rest_overtime"]) {
        const a = d[key] || taiwanPolicyTemplate[key];
        if (!Array.isArray(a) || !a.length || a.length > 8)
          fail("加班級距格式錯誤");
        p[key] = a.map((r) => ({
          minutes: integer(r.minutes, 1, 1440),
          multiplier_bp: integer(r.multiplier_bp, 10000, 100000),
          numerator: integer(r.numerator ?? r.multiplier_bp, 1, 100000),
          denominator: integer(r.denominator ?? 10000, 1, 10000),
        }));
      }
      const types = d.leave_types || taiwanPolicyTemplate.leave_types,
        seen = new Set();
      if (!Array.isArray(types) || !types.length || types.length > 30)
        fail("假別格式錯誤");
      p.leave_types = types.map((l) => {
        const key = txt(l.key, 30, true);
        if (!/^[a-z][a-z0-9_]*$/.test(key) || seen.has(key))
          fail("假別代號重複或不合法");
        seen.add(key);
        return {
          key,
          label: txt(l.label, 60, true),
          paid_bp: integer(l.paid_bp, 0, 10000),
          quota: l.quota !== false,
        };
      });
      const id = Number(
        this.e.run(
          "INSERT INTO hr_policy_versions(effective_date,definition,created_by,created_at) VALUES(?,?,?,?)",
          p.effective_date,
          JSON.stringify(p),
          u.id,
          now(),
        ).lastInsertRowid,
      );
      event(this.e, u, "hr_policy_versions", id, "approve", {
        effective_date: p.effective_date,
        source: p.source,
      });
      return { id, ...p };
    });
  }
  terms(u, b) {
    this.permission(u, "update");
    return this.e.tx(() => {
      const emp = this.e.get(
        "SELECT * FROM employees WHERE id=?",
        integer(b.employee_id, 1),
      );
      if (!emp) fail("員工不存在");
      const date = dateValue(b.effective_date),
        old = this.e.get(
          "SELECT * FROM employment_terms WHERE employee_id=? AND effective_date=?",
          emp.id,
          date,
        );
      if (old) fail("薪資條件已保存，請以新的生效日建立修訂", 409);
      if (!["monthly", "hourly"].includes(b.salary_kind)) fail("薪資類型錯誤");
      const policy = this.policy(date).definition,
        amount = scaled(b.amount, 2, 1);
      if (
        amount <
        (b.salary_kind === "monthly" ? policy.min_monthly : policy.min_hourly)
      )
        fail("薪資低於此規則的最低工資；部分工時請使用時薪");
      const vals = [
        emp.id,
        date,
        b.salary_kind,
        amount,
        scaled(b.labor_base),
        scaled(b.health_base),
        scaled(b.pension_base),
        integer(b.dependents ?? 0, 0, 3),
        integer(b.voluntary_pension_bp ?? 0, 0, 600),
        b.tax_resident === false ? 0 : 1,
        integer(b.tax_bp ?? 500, 0, 10000),
        scaled(b.tax_exempt || "0"),
        u.id,
      ];
      if (!vals[4] || !vals[5] || !vals[6])
        fail("請填核對過的勞保、健保與退休金投保金額");
      const id = Number(
        this.e.run(
          "INSERT INTO employment_terms(employee_id,effective_date,salary_kind,amount,labor_base,health_base,pension_base,dependents,voluntary_pension_bp,tax_resident,tax_bp,tax_exempt,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
          ...vals,
        ).lastInsertRowid,
      );
      this.e.access.assert(
        this.e.access.policy(u),
        "payroll_runs",
        "update",
        "employment_terms",
        id,
      );
      permission(this.e, u, resource, "update");
      event(this.e, u, "employment_terms", id, "save", {
        employee_id: emp.id,
        effective_date: date,
      });
      return { id };
    });
  }
  calendar(u, b) {
    this.e.access.requireAdmin(u);
    return this.e.tx(() => {
      const date = dateValue(b.date),
        kind = b.kind;
      if (!["work", "rest", "holiday"].includes(kind)) fail("日別錯誤");
      const old = this.e.get("SELECT * FROM hr_calendar WHERE date=?", date);
      if ((old?.version || 0) !== integer(b.version ?? 0))
        fail("行事曆已更新", 409);
      this.e.run(
        "INSERT INTO hr_calendar(date,kind,name,created_by) VALUES(?,?,?,?) ON CONFLICT(date) DO UPDATE SET kind=excluded.kind,name=excluded.name,version=version+1",
        date,
        kind,
        txt(b.name, 100, true),
        u.id,
      );
      event(this.e, u, "hr_calendar", 0, "save", { date, kind });
      return { ok: true };
    });
  }
  locked(employee, date) {
    if (
      this.e.get(
        "SELECT r.id FROM payroll_runs r JOIN payroll_lines l ON l.run_id=r.id WHERE l.employee_id=? AND r.period=? AND r.status IN ('approved','posted','paid')",
        employee,
        date.slice(0, 7),
      )
    )
      fail("此期間已核定薪資，請先沖回薪資再修改出勤", 409);
  }
  attendance(u, b) {
    return this.e.tx(() => {
      const emp = this.employee(u, b.employee_id, "create"),
        date = dateValue(b.date);
      if (date > today()) fail("出勤不可在未來");
      this.locked(emp.id, date);
      const p = this.policy(date).definition,
        start = minute(b.start),
        end = minute(b.end) + (b.overnight === true ? 1440 : 0),
        rest = integer(b.break_minutes ?? 0, 0, 1440),
        duration = end - start - rest;
      if (duration <= 0 || duration > 1440) fail("出勤時段或休息時間錯誤");
      const calendar =
          this.e.get("SELECT kind FROM hr_calendar WHERE date=?", date)?.kind ||
          ([0, 6].includes(new Date(date + "T00:00Z").getUTCDay())
            ? "rest"
            : "work"),
        normal = calendar === "work" ? Math.min(duration, p.normal_minutes) : 0,
        overtime = duration - normal;
      if (calendar === "work" && overtime > p.max_daily_overtime)
        fail("超過此規則的每日加班上限");
      if (
        this.e.get(
          "SELECT id FROM hr_leave_requests WHERE employee_id=? AND date=? AND status IN ('pending','approved') AND start_minute<? AND end_minute>?",
          emp.id,
          date,
          end,
          start,
        )
      )
        fail("出勤時段與請假重疊", 409);
      const old = this.e.get(
        "SELECT * FROM hr_attendance WHERE employee_id=? AND date=?",
        emp.id,
        date,
      );
      if (old && old.status !== "rejected" && old.status !== "cancelled")
        fail("此日已登錄出勤，請先取消原紀錄", 409);
      const id = Number(
        this.e.run(
          "INSERT INTO hr_attendance(employee_id,date,start_minute,end_minute,break_minutes,normal_minutes,overtime_minutes,notes,created_by) VALUES(?,?,?,?,?,?,?,?,?)",
          emp.id,
          date,
          start,
          end,
          rest,
          normal,
          overtime,
          txt(b.notes, 500),
          u.id,
        ).lastInsertRowid,
      );
      event(this.e, u, "hr_attendance", id, "submit", {
        employee_id: emp.id,
        date,
        start,
        end,
        rest,
        calendar,
      });
      return { id, status: "pending", version: 1 };
    });
  }
  leaveBalance(u, b) {
    this.e.access.requireAdmin(u);
    return this.e.tx(() => {
      const emp = this.employee(u, b.employee_id, "update"),
        year = integer(b.year, 2000, 2200),
        kind = txt(b.kind, 30, true),
        minutes = integer(b.minutes, 0, 525600),
        old = this.e.get(
          "SELECT * FROM hr_leave_balances WHERE employee_id=? AND year=? AND kind=?",
          emp.id,
          year,
          kind,
        ),
        used = this.e.get(
          "SELECT COALESCE(sum(end_minute-start_minute),0) n FROM hr_leave_requests WHERE employee_id=? AND substr(date,1,4)=? AND kind=? AND status='approved'",
          emp.id,
          String(year),
          kind,
        ).n;
      if (minutes < used) fail("額度不可少於已核准請假");
      if ((old?.version || 0) !== integer(b.version ?? 0))
        fail("額度已更新", 409);
      this.e.run(
        "INSERT INTO hr_leave_balances(employee_id,year,kind,minutes,created_by) VALUES(?,?,?,?,?) ON CONFLICT(employee_id,year,kind) DO UPDATE SET minutes=excluded.minutes,version=version+1",
        emp.id,
        year,
        kind,
        minutes,
        u.id,
      );
      event(this.e, u, "hr_leave_balances", old?.id || 0, "save", {
        employee_id: emp.id,
        year,
        kind,
        minutes,
      });
      return { ok: true };
    });
  }
  leave(u, b) {
    return this.e.tx(() => {
      const emp = this.employee(u, b.employee_id, "create"),
        date = dateValue(b.date);
      this.locked(emp.id, date);
      const p = this.policy(date).definition,
        l = p.leave_types.find((x) => x.key === b.kind);
      if (!l) fail("假別不存在");
      const start = minute(b.start),
        end = minute(b.end);
      if (end <= start) fail("請假結束時間需晚於開始");
      if (
        this.e.get(
          "SELECT id FROM hr_leave_requests WHERE employee_id=? AND date=? AND status IN ('pending','approved') AND start_minute<? AND end_minute>?",
          emp.id,
          date,
          end,
          start,
        ) ||
        this.e.get(
          "SELECT id FROM hr_attendance WHERE employee_id=? AND date=? AND status IN ('pending','approved') AND start_minute<? AND end_minute>?",
          emp.id,
          date,
          end,
          start,
        )
      )
        fail("請假與既有請假／出勤時段重疊", 409);
      const id = Number(
        this.e.run(
          "INSERT INTO hr_leave_requests(employee_id,date,kind,start_minute,end_minute,paid_bp,notes,created_by) VALUES(?,?,?,?,?,?,?,?)",
          emp.id,
          date,
          l.key,
          start,
          end,
          l.paid_bp,
          txt(b.notes, 500, true),
          u.id,
        ).lastInsertRowid,
      );
      event(this.e, u, "hr_leave_requests", id, "submit");
      return { id, status: "pending", version: 1 };
    });
  }
  decide(u, b) {
    return this.e.tx(() => {
      const table = b.type === "leave" ? "hr_leave_requests" : "hr_attendance",
        r = this.e.get(
          "SELECT * FROM " + table + " WHERE id=?",
          integer(b.id, 1),
        );
      revision(r, b);
      this.employee(
        u,
        r.employee_id,
        b.action === "cancel" ? "cancel" : "approve",
      );
      if (
        !["admin", "manager"].includes(u.role) &&
        !this.e.access.policy(u).configured &&
        b.action !== "cancel"
      )
        fail("沒有核准權限", 403);
      this.locked(r.employee_id, r.date);
      const p = this.policy(r.date).definition;
      if (["approve", "reject"].includes(b.action)) {
        if (r.status !== "pending") fail("此紀錄不是待核准", 409);
        if (r.created_by === u.id && p.forbid_self_approval)
          fail("不能核准本人登錄的出勤／請假", 403);
        if (b.action === "approve" && table === "hr_leave_requests") {
          const kind = p.leave_types.find((l) => l.key === r.kind);
          if (kind?.quota) {
            const balance =
                this.e.get(
                  "SELECT minutes FROM hr_leave_balances WHERE employee_id=? AND year=? AND kind=?",
                  r.employee_id,
                  Number(r.date.slice(0, 4)),
                  r.kind,
                )?.minutes || 0,
              used = this.e.get(
                "SELECT COALESCE(sum(end_minute-start_minute),0) n FROM hr_leave_requests WHERE employee_id=? AND substr(date,1,4)=? AND kind=? AND status='approved'",
                r.employee_id,
                r.date.slice(0, 4),
                r.kind,
              ).n;
            if (used + r.end_minute - r.start_minute > balance)
              fail("請假額度不足", 409);
          }
        }
        if (b.action === "approve" && table === "hr_attendance") {
          const used = this.e.get(
            "SELECT COALESCE(sum(overtime_minutes),0) n FROM hr_attendance WHERE employee_id=? AND substr(date,1,7)=? AND status='approved'",
            r.employee_id,
            r.date.slice(0, 7),
          ).n;
          if (used + r.overtime_minutes > p.monthly_overtime_limit)
            fail("超過每月加班上限", 409);
        }
      } else if (
        b.action !== "cancel" ||
        !["pending", "approved"].includes(r.status)
      )
        fail("不支援此狀態的操作", 409);
      const reason = txt(b.reason, 500, true),
        status = {
          approve: "approved",
          reject: "rejected",
          cancel: "cancelled",
        }[b.action];
      this.e.run(
        "UPDATE " +
          table +
          " SET status=?,version=version+1,approved_by=? WHERE id=?",
        status,
        u.id,
        r.id,
      );
      event(this.e, u, table, r.id, b.action, { reason, before: r });
      return { id: r.id, status, version: r.version + 1 };
    });
  }
  sources(period) {
    const { start, end } = month(period);
    return {
      employees: this.e.all(
        "SELECT * FROM employees WHERE (joined_date='' OR joined_date<=?) AND (left_date='' OR left_date>=?) ORDER BY id",
        end,
        start,
      ),
      terms: this.e.all(
        "SELECT * FROM employment_terms WHERE effective_date<=? ORDER BY employee_id,effective_date,id",
        end,
      ),
      attendance: this.e.all(
        "SELECT * FROM hr_attendance WHERE date BETWEEN ? AND ? AND status='approved' ORDER BY id",
        start,
        end,
      ),
      leave: this.e.all(
        "SELECT * FROM hr_leave_requests WHERE date BETWEEN ? AND ? AND status='approved' ORDER BY id",
        start,
        end,
      ),
      calendar: this.e.all(
        "SELECT * FROM hr_calendar WHERE date BETWEEN ? AND ? ORDER BY date",
        start,
        end,
      ),
    };
  }
  hash(s) {
    return createHash("sha256").update(JSON.stringify(s)).digest("hex");
  }
  compute(u, b) {
    this.permission(u, "create");
    return this.e.tx(() => {
      const period = txt(b.period, 7, true),
        m = month(period);
      if (m.end > today())
        fail("薪資月份尚未結束，請先使用試算資料核對，結束後再建正式薪資");
      const policy = this.policy(m.end),
        p = policy.definition,
        s = this.sources(period);
      if (!s.employees.length) fail("此期間沒有在職員工");
      if (
        this.e.get(
          "SELECT id FROM payroll_runs WHERE period=? AND status NOT IN ('cancelled','reversed')",
          period,
        )
      )
        fail("月份已有薪資，請先處理原單", 409);
      const computed = [];
      const adjustments = b.adjustments || [];
      if (!Array.isArray(adjustments)) fail("薪資調整格式錯誤");
      if (
        new Set(adjustments.map((a) => Number(a.employee_id))).size !==
        adjustments.length
      )
        fail("薪資調整員工重複");
      for (const emp of s.employees) {
        const adjustment =
          adjustments.find((a) => Number(a.employee_id) === emp.id) || {};
        const terms = s.terms.filter((t) => t.employee_id === emp.id),
          t = terms.at(-1);
        if (!t) fail("員工 " + emp.code + " 缺少薪資條件");
        this.e.access.assert(
          this.e.access.policy(u),
          "payroll_runs",
          "read",
          "employment_terms",
          t.id,
        );
        if (
          terms.some(
            (x) => x.effective_date > m.start && x.effective_date <= m.end,
          ) &&
          (adjustment.base_pay === undefined || adjustment.base_pay === "")
        )
          fail(
            "月中調薪須填入已核對的本薪覆核金額及計算依據，不能默用月底薪資",
          );
        const attendance = s.attendance.filter((r) => r.employee_id === emp.id),
          leave = s.leave.filter((r) => r.employee_id === emp.id),
          joined =
            emp.joined_date && emp.joined_date > m.start
              ? emp.joined_date
              : m.start,
          left = emp.left_date && emp.left_date < m.end ? emp.left_date : m.end,
          days = Math.max(
            0,
            Math.round((Date.parse(left) - Date.parse(joined)) / 86400000) + 1,
          );
        if (!days) continue;
        const hourly =
            t.salary_kind === "hourly"
              ? t.amount
              : ratio(t.amount, 1, p.monthly_hours),
          normalMinutes = attendance.reduce((n, r) => n + r.normal_minutes, 0),
          base =
            t.salary_kind === "hourly"
              ? ratio(t.amount, normalMinutes, 60) +
                leave.reduce(
                  (sum, l) =>
                    sum +
                    ratio(
                      t.amount,
                      (l.end_minute - l.start_minute) * l.paid_bp,
                      600000,
                    ),
                  0,
                )
              : ratio(t.amount, days, m.days);
        let overtime = 0;
        for (const a of attendance) {
          const kind =
            s.calendar.find((c) => c.date === a.date)?.kind ||
            ([0, 6].includes(new Date(a.date + "T00:00Z").getUTCDay())
              ? "rest"
              : "work");
          let remain = a.overtime_minutes;
          if (kind === "holiday") {
            const regular = Math.min(remain, p.normal_minutes);
            overtime +=
              t.salary_kind === "monthly"
                ? ratio(
                    t.amount,
                    p.normal_minutes *
                      Math.max(0, p.holiday_multiplier_bp - 10000),
                    60 * p.monthly_hours * 10000,
                  )
                : ratio(t.amount, regular * p.holiday_multiplier_bp, 600000);
            remain -= regular;
            if (!remain) continue;
          }
          for (const band of p[
            kind === "rest" ? "rest_overtime" : "overtime"
          ]) {
            const take = Math.min(remain, band.minutes);
            overtime += ratio(
              t.amount,
              take * (band.numerator ?? band.multiplier_bp),
              60 *
                (t.salary_kind === "hourly" ? 1 : p.monthly_hours) *
                (band.denominator ?? 10000),
            );
            remain -= take;
            if (!remain) break;
          }
          if (remain) fail("出勤加班超過政策級距，請核對");
        }
        const leaveDeduction =
            t.salary_kind === "monthly"
              ? leave.reduce(
                  (n, l) =>
                    n +
                    ratio(
                      ratio(hourly, l.end_minute - l.start_minute, 60),
                      10000 - l.paid_bp,
                      10000,
                    ),
                  0,
                )
              : 0,
          adjust =
            (b.adjustments || []).find(
              (x) => Number(x.employee_id) === emp.id,
            ) || {},
          extra = scaled(adjust.extra || "0"),
          other = scaled(adjust.deduction || "0"),
          gross = Math.max(0, base + overtime + extra - leaveDeduction),
          li = ntdPremium(t.labor_base, [p.labor_bp, p.labor_employee_bp], 1e8),
          le =
            ntdPremium(t.labor_base, [p.labor_bp, p.labor_employer_bp], 1e8) +
            ntdPremium(t.labor_base, [p.occupational_bp], 10000),
          hi = ntdPremium(
            t.health_base,
            [p.health_bp, p.health_employee_bp, 1 + t.dependents],
            1e8,
          ),
          he = ntdPremium(
            t.health_base,
            [
              p.health_bp,
              p.health_employer_bp,
              10000 + p.health_average_dependents_bp,
            ],
            1e12,
          ),
          pe = ntdPremium(t.pension_base, [p.employer_pension_bp], 10000),
          pi = ntdPremium(t.pension_base, [t.voluntary_pension_bp], 10000),
          tax = t.tax_resident
            ? gross > t.tax_exempt
              ? ntdPremium(gross, [t.tax_bp], 10000)
              : 0
            : ntdPremium(
                gross,
                [
                  gross <= ratio(p.min_monthly, 3, 2)
                    ? p.tax_nonresident_low_bp
                    : p.tax_nonresident_high_bp,
                ],
                10000,
              ),
          net = gross - other - li - hi - pi - tax;
        const c = {
          emp,
          t,
          base,
          overtime,
          extra,
          leaveDeduction,
          other,
          tax,
          li,
          hi,
          pi,
          le,
          he,
          pe,
          net,
          attendance,
          leave,
          adjustment,
        };
        for (const [field, key] of Object.entries({
          base_pay: "base",
          tax: "tax",
          labor_employee: "li",
          health_employee: "hi",
          pension_employee: "pi",
          labor_employer: "le",
          health_employer: "he",
          pension_employer: "pe",
          overtime_pay: "overtime",
        })) {
          if (adjustment[field] !== undefined && adjustment[field] !== "") {
            txt(adjustment.statutory_reason, 1000, true);
            txt(adjustment.source_reference, 300, true);
            c[key] = scaled(adjustment[field]);
          }
        }
        c.net =
          c.base +
          c.overtime +
          c.extra -
          c.leaveDeduction -
          c.other -
          c.li -
          c.hi -
          c.pi -
          c.tax;
        if (c.net < 0) fail("員工 " + emp.code + " 淨薪為負，請核對扣款");
        computed.push(c);
      }
      const no = this.e.number("PAYROLL"),
        id = Number(
          this.e.run(
            "INSERT INTO payroll_runs(no,period,policy_id,policy_snapshot,source_hash,notes,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
            no,
            period,
            policy.id,
            JSON.stringify(p),
            this.hash(s),
            txt(b.notes, 2000, true),
            u.id,
            now(),
          ).lastInsertRowid,
        );
      for (const c of computed)
        this.e.run(
          "INSERT INTO payroll_lines(run_id,employee_id,base_pay,overtime_pay,extra_pay,leave_deduction,other_deduction,tax,labor_employee,health_employee,pension_employee,labor_employer,health_employer,pension_employer,net_pay,snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          id,
          c.emp.id,
          c.base,
          c.overtime,
          c.extra,
          c.leaveDeduction,
          c.other,
          c.tax,
          c.li,
          c.hi,
          c.pi,
          c.le,
          c.he,
          c.pe,
          c.net,
          JSON.stringify({
            employee: c.emp,
            terms: c.t,
            attendance: c.attendance,
            leave: c.leave,
            adjustment: c.adjustment,
          }),
        );
      this.permission(u, "create", id);
      for (const line of this.e.all(
        "SELECT id FROM payroll_lines WHERE run_id=?",
        id,
      ))
        this.e.access.assert(
          this.e.access.policy(u),
          resource,
          "create",
          "payroll_lines",
          line.id,
        );
      event(this.e, u, resource, id, "compute", {
        period,
        employees: computed.length,
        policy_id: policy.id,
      });
      return this.run(u, id);
    });
  }
  run(u, id, action = "read") {
    this.permission(u, action, id);
    const r = this.e.get(
      "SELECT * FROM payroll_runs WHERE id=?",
      integer(id, 1),
    );
    if (!r) fail("薪資單不存在", 404);
    r.lines = rows(this.e, u, "payroll_lines", "run_id=" + r.id, 2000);
    if (!this.e.access.policy(u).configured && u.role !== "admin")
      r.lines = r.lines.filter(
        (l) =>
          this.e.get("SELECT user_id FROM employees WHERE id=?", l.employee_id)
            ?.user_id === u.id,
      );
    r.payments = this.e
      .all(
        "SELECT p.* FROM payroll_payments p JOIN payroll_lines l ON l.id=p.line_id WHERE l.run_id=?",
        r.id,
      )
      .filter((p) => r.lines.some((l) => l.id === p.line_id));
    r.remittances = this.e.access.policy(u).superuser
      ? this.e.all("SELECT * FROM payroll_remittances WHERE run_id=?", r.id)
      : [];
    return r;
  }
  journalLines(r) {
    let gross = 0,
      employer = 0,
      net = 0,
      tax = 0,
      insurance = 0,
      pension = 0,
      other = 0;
    for (const l of r.lines) {
      gross += l.base_pay + l.overtime_pay + l.extra_pay - l.leave_deduction;
      employer += l.labor_employer + l.health_employer + l.pension_employer;
      net += l.net_pay;
      tax += l.tax;
      insurance +=
        l.labor_employee +
        l.health_employee +
        l.labor_employer +
        l.health_employer;
      pension += l.pension_employee + l.pension_employer;
      other += l.other_deduction;
    }
    return [
      ["5102", gross, 0],
      ["5103", employer, 0],
      ["2502", 0, net],
      ["2503", 0, tax],
      ["2504", 0, insurance],
      ["2505", 0, pension],
      ["2506", 0, other],
    ];
  }
  action(u, b) {
    return this.e.tx(() => {
      const action = b.action,
        r = this.run(
          u,
          b.id,
          {
            approve: "approve",
            post: "post",
            cancel: "cancel",
            reverse: "reverse",
          }[action] || "read",
        );
      revision(r, b);
      const full = this.e.get(
        "SELECT count(*) n FROM payroll_lines WHERE run_id=?",
        r.id,
      ).n;
      if (r.lines.length !== full)
        fail("執行整批薪資需具備全部員工資料權限", 403);
      for (const line of r.lines)
        this.e.access.assert(
          this.e.access.policy(u),
          resource,
          {
            approve: "approve",
            post: "post",
            cancel: "cancel",
            reverse: "reverse",
          }[action] || "read",
          "payroll_lines",
          line.id,
        );
      const reason = txt(b.reason, 500, true);
      if (action === "approve") {
        if (r.status !== "draft") fail("只有草稿可核准", 409);
        if (
          JSON.parse(r.policy_snapshot).forbid_self_approval &&
          r.created_by === u.id
        )
          fail("薪資建單人不可自行核准", 403);
        if (r.source_hash !== this.hash(this.sources(r.period)))
          fail("出勤、請假或員工條件已變更，請取消並重新試算", 409);
        this.e.run(
          "UPDATE payroll_runs SET status='approved',approved_by=?,version=version+1 WHERE id=?",
          u.id,
          r.id,
        );
      } else if (action === "post") {
        if (r.status !== "approved") fail("請先核准薪資", 409);
        if (r.source_hash !== this.hash(this.sources(r.period)))
          fail("來源已變更，請重新建單", 409);
        this.e.journal(
          u,
          "薪資及雇主負擔提列",
          r.no,
          this.journalLines(r),
          month(r.period).end,
        );
        this.e.run(
          "UPDATE payroll_runs SET status='posted',version=version+1 WHERE id=?",
          r.id,
        );
      } else if (action === "cancel") {
        if (!["draft", "approved"].includes(r.status))
          fail("已過帳薪資請沖回", 409);
        this.e.run(
          "UPDATE payroll_runs SET status='cancelled',version=version+1 WHERE id=?",
          r.id,
        );
      } else if (action === "reverse") {
        if (
          this.e.get(
            "SELECT id FROM payroll_remittances WHERE run_id=? AND status='posted'",
            r.id,
          )
        )
          fail("本期已有法定款繳納，請先核對並沖回繳納紀錄", 409);
        if (r.status !== "posted" || r.lines.some((l) => l.paid))
          fail("請先沖回所有薪資付款，再沖回提列", 409);
        this.e.journal(
          u,
          "薪資提列沖回 " + reason,
          this.e.number("PAYREV"),
          this.journalLines(r).map(([a, d, c]) => [a, c, d]),
        );
        this.e.run(
          "UPDATE payroll_runs SET status='reversed',version=version+1 WHERE id=?",
          r.id,
        );
      } else fail("薪資動作錯誤");
      event(this.e, u, resource, r.id, action, { reason });
      return this.run(u, r.id);
    });
  }
  pay(u, b) {
    return this.e.tx(() => {
      const r = this.run(u, b.id, "post");
      revision(r, b);
      if (r.status !== "posted") fail("請先過帳薪資", 409);
      const line = r.lines.find((l) => l.id === integer(b.line_id, 1));
      if (!line) fail("員工薪資不在本單或沒有權限", 403);
      this.e.access.assert(
        this.e.access.policy(u),
        resource,
        "post",
        "payroll_lines",
        line.id,
      );
      const amount = scaled(b.amount, 2, 1);
      if (amount > line.net_pay - line.paid) fail("付款超過未付淨薪");
      const bank = this.e.get(
        "SELECT * FROM bank_accounts WHERE id=? AND active=1",
        integer(b.bank_account_id, 1),
      );
      if (!bank) fail("付款帳戶不存在");
      this.e.access.assert(
        this.e.access.policy(u),
        "banks",
        "post",
        "bank_accounts",
        bank.id,
      );
      if (
        this.e.get(
          "SELECT COALESCE(sum(debit-credit),0) n FROM journal_lines WHERE account=?",
          bank.gl_code,
        ).n < amount
      )
        fail("付款帳戶餘額不足", 409);
      const date = dateValue(b.date);
      if (date < month(r.period).end || date > today()) fail("付款日期錯誤");
      const no = this.e.number("SALPAY");
      this.e.journal(
        u,
        "薪資付款",
        no,
        [
          ["2502", amount, 0],
          [bank.gl_code, 0, amount],
        ],
        date,
      );
      const id = Number(
        this.e.run(
          "INSERT INTO payroll_payments(no,line_id,bank_account_id,amount,date,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
          no,
          line.id,
          bank.id,
          amount,
          date,
          u.id,
          now(),
        ).lastInsertRowid,
      );
      this.e.run(
        "UPDATE payroll_lines SET paid=paid+? WHERE id=?",
        amount,
        line.id,
      );
      this.e.run("UPDATE payroll_runs SET version=version+1 WHERE id=?", r.id);
      event(this.e, u, resource, r.id, "pay", {
        id,
        line_id: line.id,
        amount,
        no,
      });
      return this.run(u, r.id);
    });
  }
  reversePayment(u, b) {
    return this.e.tx(() => {
      const pay = this.e.get(
        "SELECT * FROM payroll_payments WHERE id=?",
        integer(b.payment_id, 1),
      );
      if (!pay || pay.status !== "posted") fail("付款不存在或已沖回", 409);
      const line = this.e.get(
          "SELECT * FROM payroll_lines WHERE id=?",
          pay.line_id,
        ),
        r = this.run(u, line.run_id, "reverse");
      revision(r, b);
      if (!r.lines.some((l) => l.id === line.id))
        fail("無權沖回此員工付款", 403);
      this.e.access.assert(
        this.e.access.policy(u),
        resource,
        "reverse",
        "payroll_lines",
        line.id,
      );
      const bank = this.e.get(
          "SELECT * FROM bank_accounts WHERE id=?",
          pay.bank_account_id,
        ),
        reason = txt(b.reason, 500, true),
        no = this.e.number("SALREV");
      if (!bank) fail("原付款帳戶不存在", 409);
      this.e.access.assert(
        this.e.access.policy(u),
        "banks",
        "post",
        "bank_accounts",
        bank.id,
      );
      this.e.journal(u, "薪資付款沖回 " + reason, no, [
        [bank.gl_code, pay.amount, 0],
        ["2502", 0, pay.amount],
      ]);
      this.e.run(
        "UPDATE payroll_payments SET status='reversed' WHERE id=?",
        pay.id,
      );
      this.e.run(
        "UPDATE payroll_lines SET paid=paid-? WHERE id=?",
        pay.amount,
        line.id,
      );
      this.e.run("UPDATE payroll_runs SET version=version+1 WHERE id=?", r.id);
      event(this.e, u, resource, r.id, "reverse_payment", {
        payment_id: pay.id,
        reason,
        no,
      });
      return this.run(u, r.id);
    });
  }
  data(u) {
    const p = this.e.access.policy(u),
      admin = p.superuser || (!p.configured && u.role === "admin"),
      self = this.e.get("SELECT id FROM employees WHERE user_id=?", u.id),
      canAll = p.configured || ["admin", "manager"].includes(u.role),
      filter = canAll ? "1" : "employee_id=" + (self?.id || 0),
      data = {
        attendance: rows(this.e, u, "hr_attendance", filter),
        leave: rows(this.e, u, "hr_leave_requests", filter),
        leave_balances: rows(this.e, u, "hr_leave_balances", filter),
        calendar: this.e.all(
          "SELECT * FROM hr_calendar ORDER BY date DESC LIMIT 400",
        ),
        employee_id: self?.id || null,
        employees: this.e
          .all("SELECT id,code,name FROM employees")
          .filter((e) => canAll || e.id === self?.id),
        template: admin ? taiwanPolicyTemplate : undefined,
      };
    try {
      this.permission(u);
      data.runs = rows(this.e, u, resource);
      data.terms = rows(this.e, u, "employment_terms");
      data.profiles = rows(this.e, u, "payroll_employee_profiles").map((p) => ({
        id: p.id,
        employee_id: p.employee_id,
        version: p.version,
      }));
      data.policies = admin
        ? this.e.all(
            "SELECT * FROM hr_policy_versions ORDER BY effective_date DESC,id DESC",
          )
        : [];
      data.employees = rows(this.e, u, "employees").map(
        ({ id, code, name }) => ({ id, code, name }),
      );
    } catch (error) {
      if (error.status !== 403) throw error;
      if (self)
        data.runs = this.e.all(
          "SELECT r.* FROM payroll_runs r WHERE r.status='posted' AND EXISTS(SELECT 1 FROM payroll_lines l WHERE l.run_id=r.id AND l.employee_id=?)",
          self.id,
        );
    }
    return data;
  }
}
