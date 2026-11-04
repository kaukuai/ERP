import { WarehouseManagement } from "./warehouse-management.mjs";
import { ForeignExchange } from "./foreign-exchange.mjs";
import { DocumentDelivery } from "./document-delivery.mjs";
import { HRPayroll } from "./hr-payroll.mjs";
import { Production } from "./production.mjs";
import { enterpriseCan, enterprisePermission } from "./enterprise-common.mjs";
import { integer, fail } from "./core.mjs";
import { has } from "./core.mjs";
const project = (u, value) => {
  if (has(u, "cost") || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => project(u, v));
  if (typeof value === "string" && /^[{[]/.test(value)) {
    try {
      return JSON.stringify(project(u, JSON.parse(value)));
    } catch {}
  }
  if (typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([k]) => !["cost", "hourly_cost", "unit_fee", "labor_cost"].includes(k),
      )
      .map(([k, v]) => [k, project(u, v)]),
  );
};
function validateBody(b) {
  for (const k of [
    "lines",
    "operations",
    "forecasts",
    "adjustments",
    "quality_inspections",
    "attachments",
  ])
    if (
      b[k] !== undefined &&
      (!Array.isArray(b[k]) ||
        b[k].length > 200 ||
        b[k].some((r) => !r || typeof r !== "object" || Array.isArray(r)))
    )
      fail("明細陣列格式錯誤");
  for (const k of ["document_ids", "account_ids"])
    if (b[k] !== undefined && (!Array.isArray(b[k]) || b[k].length > 200))
      fail("來源清單格式錯誤");
  if (
    b.definition !== undefined &&
    (!b.definition ||
      typeof b.definition !== "object" ||
      Array.isArray(b.definition))
  )
    fail("規則格式錯誤");
  for (const k of ["leave_types", "overtime", "rest_overtime"])
    if (
      b.definition?.[k] !== undefined &&
      (!Array.isArray(b.definition[k]) ||
        b.definition[k].some(
          (r) => !r || typeof r !== "object" || Array.isArray(r),
        ))
    )
      fail("規則明細格式錯誤");
}
const methods = {
  wms: {
    bin: "saveBin",
    enable: "enable",
    rule: "rule",
    transfer: "transfer",
    replenishment: "replenishment",
    replenish: "replenish",
    wave: "createWave",
    plan: "planWave",
    post: "postWave",
    cancel: "cancelWave",
  },
  fx: {
    rate: "rate",
    currency: "currency",
    create: "create",
    post: "post",
    settle: "settle",
    reverse: "reverseSettlement",
    valuation: "valuation",
    "reverse-valuation": "reverseValuation",
    cancel: "cancel",
  },
  delivery: {
    configure: "configure",
    defaults: "defaults",
    queue: "queue",
    action: "action",
  },
  hr: {
    configure: "configure",
    terms: "terms",
    profile: "profile",
    remittance: "remittance",
    "reverse-remittance": "reverseRemittance",
    calendar: "calendar",
    attendance: "attendance",
    leave: "leave",
    "leave-balance": "leaveBalance",
    decide: "decide",
    compute: "compute",
    action: "action",
    pay: "pay",
    "reverse-payment": "reversePayment",
  },
  production: {
    bom: "bom",
    center: "center",
    calendar: "calendar",
    route: "route",
    create: "create",
    release: "release",
    issue: "issue",
    complete: "completeOperation",
    extend: "extend",
    send: "send",
    receive: "receive",
    recall: "recall",
    finish: "finish",
    cancel: "cancel",
    preview: "preview",
    commit: "commit",
  },
};
const resource = {
  wms: "warehouse_waves",
  fx: "foreign_accounts",
  delivery: "document_outbox",
  hr: "payroll_runs",
  production: "production_jobs",
};
export class Enterprise {
  constructor(e) {
    this.e = e;
    this.wms = new WarehouseManagement(e);
    this.fx = new ForeignExchange(e);
    this.delivery = new DocumentDelivery(e);
    this.hr = new HRPayroll(e);
    this.production = new Production(e);
  }
  data(u) {
    return {
      enterprise_admin: this.e.access.policy(u).superuser,
      enterprise_access: Object.fromEntries(
        [
          "storage_bins",
          "warehouse_waves",
          "foreign_accounts",
          "document_outbox",
          "payroll_runs",
          "hr_attendance",
          "production_routes",
          "production_jobs",
          "mrp_plans",
        ].map((r) => [
          r,
          Object.fromEntries(
            [
              "read",
              "create",
              "update",
              "approve",
              "post",
              "cancel",
              "reverse",
            ].map((a) => [a, enterpriseCan(this.e, u, r, a)]),
          ),
        ]),
      ),
      enterprise_permissions: Object.fromEntries(
        Object.entries(resource).map(([k, r]) => [
          k,
          k === "hr" || enterpriseCan(this.e, u, r),
        ]),
      ),
    };
  }
  get(u, path, q) {
    const m =
      /^\/api\/enterprise\/(wms|fx|delivery|hr|production)(?:\/(detail|resolve|export))?$/.exec(
        path,
      );
    if (!m) return;
    const [_, domain, op] = m;
    if (op === "export" && domain === "hr") return this.hr.export(u, q.id);
    if (op === "resolve" && domain === "delivery")
      return this.delivery.resolve(u, q.document_id, q.locale);
    if (op === "detail") {
      const row =
        domain === "wms"
          ? this.wms.wave(u, q.id)
          : domain === "fx"
            ? this.fx.account(u, q.id)
            : domain === "delivery"
              ? this.delivery.detail(u, q.id)
              : domain === "hr"
                ? this.hr.run(u, q.id)
                : project(u, this.production.job(u, q.id));
      row.allowed = Object.fromEntries(
        [
          "read",
          "update",
          "post",
          "approve",
          "cancel",
          "reverse",
          "print",
          "export",
        ].map((a) => {
          try {
            if (domain === "hr") this.hr.permission(u, a, row.id);
            else enterprisePermission(this.e, u, resource[domain], a, row.id);
            return [a, true];
          } catch (error) {
            if (error.status === 403) return [a, false];
            throw error;
          }
        }),
      );
      return row;
    }
    return this[domain].data(u);
  }
  post(u, path, b) {
    const m =
      /^\/api\/enterprise\/(wms|fx|delivery|hr|production)\/([a-z-]+)$/.exec(
        path,
      );
    if (!m) return;
    validateBody(b);
    const method = methods[m[1]][m[2]];
    if (!method) fail("進階營運入口不存在", 404);
    const result = this[m[1]][method](u, b);
    const output = m[1] === "production" ? project(u, result) : result;
    return output && typeof output === "object"
      ? Object.fromEntries(
          Object.entries(output).filter(([k]) =>
            ["id", "no", "status", "version", "ok", "outputs"].includes(k),
          ),
        )
      : output;
  }
}
export function guardEnterprise(e, u, path, method, b = {}) {
  if (/^\/print\/payroll\/\d+$/.test(path)) {
    new HRPayroll(e).run(u, path.split("/")[3], "print");
    return true;
  }
  const m =
    /^\/api\/enterprise\/(wms|fx|delivery|hr|production)(?:\/([a-z-]+))?$/.exec(
      path,
    );
  if (!m) return false;
  const domain = m[1],
    op = m[2],
    x = new Enterprise(e);
  if (method === "POST") validateBody(b);
  if (method === "GET") {
    if (domain !== "hr" && !(domain === "delivery" && op === "resolve"))
      enterprisePermission(e, u, resource[domain], "read");
    return true;
  }
  if (!methods[domain][op]) fail("進階營運入口不存在", 404);
  if (
    (domain === "wms" && op === "enable") ||
    (domain === "fx" && ["rate", "currency"].includes(op)) ||
    (domain === "delivery" && ["configure", "defaults"].includes(op)) ||
    (domain === "hr" && ["configure", "calendar", "leave-balance"].includes(op))
  ) {
    e.access.requireAdmin(u);
    return true;
  }
  if (domain === "hr" && ["attendance", "leave", "decide"].includes(op)) {
    if (op === "decide") {
      const table = b.type === "leave" ? "hr_leave_requests" : "hr_attendance",
        r = e.access.one(
          "SELECT * FROM " + table + " WHERE id=?",
          integer(b.id, 1),
        );
      if (!r) fail("紀錄不存在", 404);
      x.hr.employee(
        u,
        r.employee_id,
        b.action === "cancel" ? "cancel" : "approve",
      );
    } else x.hr.employee(u, b.employee_id, "create");
    return true;
  }
  let action = [
    "post",
    "settle",
    "valuation",
    "pay",
    "issue",
    "complete",
    "send",
    "receive",
    "recall",
    "remittance",
    "finish",
    "commit",
    "replenish",
    "transfer",
  ].includes(op)
    ? "post"
    : [
          "reverse",
          "reverse-valuation",
          "reverse-payment",
          "reverse-remittance",
        ].includes(op)
      ? "reverse"
      : op === "release"
        ? "approve"
        : op === "cancel"
          ? "cancel"
          : op === "action"
            ? b.action === "retry"
              ? "post"
              : b.action
            : b.id
              ? "update"
              : "create";
  if (
    (domain === "hr" && ["terms", "profile"].includes(op)) ||
    (domain === "production" && op === "bom")
  )
    action = "update";
  if (domain === "wms") {
    if (
      ["bin", "rule", "transfer", "replenishment", "replenish"].includes(op)
    ) {
      enterprisePermission(
        e,
        u,
        "storage_bins",
        action,
        op === "bin" ? b.id : null,
      );
      for (const id of [b.from_bin_id, b.to_bin_id, b.bin_id].filter(Boolean))
        x.wms.bin(u, id, action === "create" ? "read" : action);
    } else if (b.id) x.wms.wave(u, b.id, action);
    else enterprisePermission(e, u, "warehouse_waves", action);
  }
  if (domain === "fx") {
    if (op === "reverse") {
      const s = e.access.one(
        "SELECT account_id FROM fx_settlements WHERE id=?",
        integer(b.settlement_id, 1),
      );
      if (!s) fail("收付不存在", 404);
      x.fx.account(u, s.account_id, "reverse");
    } else if (b.id) x.fx.account(u, b.id, action);
    else x.fx.permission(u, action);
    if (op === "valuation")
      for (const id of b.account_ids || []) x.fx.account(u, id, "post");
  }
  if (domain === "delivery") {
    enterprisePermission(e, u, "document_outbox", action, b.id);
    if (b.id) {
      const r = e.access.one(
        "SELECT * FROM document_outbox WHERE id=?",
        integer(b.id, 1),
      );
      if (!r) fail("寄送不存在", 404);
      x.delivery.authorize(u, r, action);
    } else if (b.document_id) {
      const d = e.doc(u, b.document_id);
      x.delivery.forms.document(u, d.id, d.kind);
      if (b.template_id) x.delivery.forms.template(u, b.template_id, "print");
    } else if (b.entry_id) x.delivery.forms.entry(u, b.entry_id, "print");
  }
  if (domain === "hr" && !["attendance", "leave", "decide"].includes(op)) {
    if (op === "reverse-payment" || op === "reverse-remittance") {
      const p = e.access.one(
        op === "reverse-remittance"
          ? "SELECT run_id FROM payroll_remittances WHERE id=?"
          : "SELECT l.run_id FROM payroll_payments p JOIN payroll_lines l ON l.id=p.line_id WHERE p.id=?",
        integer(
          op === "reverse-remittance" ? b.remittance_id : b.payment_id,
          1,
        ),
      );
      if (!p) fail("薪資付款不存在", 404);
      x.hr.run(u, p.run_id, "reverse");
    } else if (b.id) {
      const r = x.hr.run(u, b.id, action);
      if (op === "pay" && !r.lines.some((l) => l.id === Number(b.line_id)))
        fail("此員工薪資不在授權範圍", 403);
    } else x.hr.permission(u, action);
  }
  if (domain === "production") {
    if (["center", "calendar", "route", "bom"].includes(op))
      enterprisePermission(
        e,
        u,
        "production_routes",
        action,
        op === "route" ? b.id : null,
      );
    else if (["preview", "commit"].includes(op))
      enterprisePermission(e, u, "mrp_plans", action, b.id);
    else if (b.id) x.production.job(u, b.id, action);
    else enterprisePermission(e, u, "production_jobs", action);
  }
  return true;
}
