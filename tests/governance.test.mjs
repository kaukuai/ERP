import test from "node:test";
import assert from "node:assert/strict";
import { ERP, today, addDays } from "../src/core.mjs";
import { Governance } from "../src/governance.mjs";
import { Forms, formModel as M } from "../src/forms.mjs";
import { CustomReports } from "../src/custom-reports.mjs";
function fixture(t) {
  const e = new ERP();
  t.after(() => e.close());
  const a = e.setup({ username: "admin", password: "governance-fixture-2026" }),
    g = new Governance(e);
  const users = { admin: a };
  for (const name of ["lead", "finance", "proxy", "other"]) {
    e.saveUser(a, {
      username: name,
      name,
      role: "manager",
      password: "governance-fixture-2026",
    });
    users[name] = e.user(
      e.get("SELECT id FROM users WHERE username=?", name).id,
    );
  }
  const p = e.savePartner(a, { code: "C", name: "測試客戶" }),
    product = e.saveProduct(a, {
      sku: "P",
      name: "測試品",
      price: "100",
      cost: "40",
    });
  e.adjust(a, {
    product_id: product.id,
    warehouse_id: 1,
    qty: "20",
    unit_cost: "40",
    reason: "測試庫存",
  });
  const doc = (kind = "order", date = today()) =>
    e.saveDoc(a, {
      kind,
      date,
      partner_id: p.id,
      warehouse_id: 1,
      lines: [{ product_id: product.id, qty: "2", price: "100" }],
    });
  const rule = (extra = {}) =>
    g.rule(a, {
      name: "兩階簽核",
      kind: "order",
      min_amount: "100",
      max_amount: "",
      forbid_owner: true,
      distinct_actors: true,
      stages: [
        {
          name: "主管",
          source: "users",
          mode: "any",
          user_ids: [users.lead.id],
        },
        {
          name: "財務",
          source: "users",
          mode: "all",
          user_ids: [users.finance.id],
        },
      ],
      ...extra,
    });
  const act = (user, d, action = "approve", body = {}) =>
    e.transition(user, d.id, action, { version: d.version, ...body });
  return { e, a, g, users, doc, rule, act };
}
test("conditional sequential approvals only reserve stock after the final stage; stale, unauthorized and repeated requests fail", (t) => {
  const { e, a, g, users, doc, rule, act } = fixture(t);
  rule();
  let d = doc();
  d = act(a, d, "submit");
  assert.equal(e.stock(1, 1).reserved, 0);
  assert.throws(() => act(users.finance, d), /目前階段/);
  assert.throws(() => act(a, d), /目前階段/);
  d = act(users.lead, d);
  assert.equal(d.status, "pending");
  assert.equal(e.stock(1, 1).reserved, 0);
  assert.throws(
    () => act(users.finance, { ...d, version: d.version - 1 }),
    /更新/,
  );
  d = act(users.finance, d);
  assert.equal(d.status, "approved");
  assert.equal(e.stock(1, 1).reserved, 2000);
  assert.throws(() => act(users.finance, d), /待審核/);
  const detail = g.detail(users.lead, 1);
  assert.equal(detail.votes.length, 2);
  assert.equal(detail.status, "approved");
  assert.equal(e.integrity(a).ok, true);
});
test("any/all stages, expiring proxies and distinct actors cannot be bypassed", (t) => {
  const { e, a, g, users, doc, rule, act } = fixture(t);
  rule({
    stages: [
      {
        name: "會簽",
        source: "users",
        mode: "all",
        user_ids: [users.lead.id, users.finance.id],
      },
    ],
  });
  let d = act(a, doc(), "submit");
  g.delegation(a, {
    principal_id: users.lead.id,
    delegate_id: users.proxy.id,
    starts: addDays(today(), -2),
    ends: addDays(today(), -1),
    kind: "order",
  });
  assert.throws(
    () => act(users.proxy, d, "approve", { principal_id: users.lead.id }),
    /代理授權/,
  );
  g.delegation(a, {
    principal_id: users.lead.id,
    delegate_id: users.proxy.id,
    starts: today(),
    ends: today(),
    kind: "order",
  });
  d = act(users.proxy, d, "approve", { principal_id: users.lead.id });
  assert.equal(d.status, "pending");
  assert.throws(
    () => act(users.proxy, d, "approve", { principal_id: users.lead.id }),
    /已完成/,
  );
  d = act(users.finance, d);
  assert.equal(d.status, "approved");
  assert.equal(g.detail(a, 1).votes[0].actor_id, users.proxy.id);
});
test("snapshot survives rule edits; rejection and resubmission produce a new round and immutable history", (t) => {
  const { e, a, g, users, doc, rule, act } = fixture(t);
  const r = rule();
  let d = act(a, doc(), "submit");
  rule({
    ...r,
    stages: [
      {
        name: "改為其他人",
        source: "users",
        mode: "any",
        user_ids: [users.other.id],
      },
    ],
  });
  d = act(users.lead, d);
  d = act(users.finance, d, "reject", { reason: "請補充" });
  assert.equal(d.status, "rejected");
  assert.equal(e.stock(1, 1).reserved, 0);
  assert.throws(
    () => e.run("UPDATE approval_requests SET definition='{}'"),
    /immutable/,
  );
  assert.throws(() => e.run("DELETE FROM approval_votes"), /immutable/);
  d = e.saveDoc(a, {
    ...d,
    lines: [{ product_id: 1, qty: "2", price: "100" }],
  });
  d = act(a, d, "submit");
  assert.equal(e.get("SELECT count(*) n FROM approval_requests").n, 2);
  d = act(users.other, d);
  assert.equal(d.status, "approved");
});
test("final stock failure rolls back the vote; cancelled requests and distinct actor constraints remain enforced", (t) => {
  const { e, a, g, users, doc, rule, act } = fixture(t);
  rule({
    stages: [
      { name: "一", source: "users", mode: "any", user_ids: [users.lead.id] },
      {
        name: "二",
        source: "users",
        mode: "any",
        user_ids: [users.lead.id, users.finance.id],
      },
    ],
  });
  let d = act(a, doc(), "submit");
  d = act(users.lead, d);
  assert.throws(() => act(users.lead, d), /跨階/);
  e.adjust(a, { product_id: 1, warehouse_id: 1, qty: "-20", reason: "耗用" });
  assert.throws(() => act(users.finance, d), /不足/);
  assert.equal(e.get("SELECT count(*) n FROM approval_votes").n, 1);
  assert.equal(g.detail(a, 1).status, "pending");
  d = act(a, d, "cancel", { reason: "重建" });
  assert.equal(g.detail(a, 1).status, "cancelled");
});
test("rule overlap, missing eligible approvers and revoked source approval rights reject safely", (t) => {
  const { e, a, g, users, doc, rule, act } = fixture(t);
  rule();
  assert.throws(() => rule({ name: "重疊" }), /重疊/);
  e.saveUser(a, { ...users.lead, active: false });
  assert.throws(() => act(a, doc(), "submit"), /沒有可用/);
  assert.equal(e.get("SELECT count(*) n FROM approval_requests").n, 0);
});
test("entry windows use Taipei day boundaries, apply to existing edits and never bypass closing dates", (t) => {
  const { e, a, g, doc } = fixture(t);
  const old = doc("quote", addDays(today(), -10));
  g.periods(a, { version: 0, trade: 5, inventory: "", finance: 0 });
  assert.throws(() => doc("quote", addDays(today(), -6)), /補打單/);
  assert.throws(() => e.transition(a, old.id, "submit"), /補打單/);
  assert.ok(doc("quote", addDays(today(), -5)));
  e.checkPeriod(addDays(today(), -500), "inventory");
  assert.throws(() => e.checkPeriod(addDays(today(), -1), "finance"), /補打單/);
  assert.throws(() => g.periods(a, { version: 0, trade: 0 }), /更新/);
  g.periods(a, { version: 1, trade: "", inventory: "", finance: "" });
  e.run(
    "UPDATE settings SET value=? WHERE key='closed_until'",
    addDays(today(), -2),
  );
  assert.throws(() => doc("quote", addDays(today(), -3)), /結帳/);
});
test("per-user format denials apply independently to form definitions, exports, fill, entries and custom reports", (t) => {
  const { e, a, g, users } = fixture(t);
  const f = new Forms(e),
    tpl = f.save(a, { name: "通用日報", definition: M.validate(M.starter()) });
  const entry = f.saveEntry(users.lead, {
    template_id: tpl.id,
    template_version: 1,
    title: "原始日報",
    values: { date: today(), name: "主管" },
  });
  g.grants(a, {
    kind: "form",
    format_id: tpl.id,
    version: 0,
    grants: [
      { user_id: users.lead.id, action: "fill", effect: "deny" },
      { user_id: users.lead.id, action: "entry_print", effect: "deny" },
    ],
  });
  const u = e.user(users.lead.id);
  assert.equal(f.entry(u, entry.id).allowed.update, true);
  assert.throws(() => f.printEntry(u, entry.id), /指定版型/);
  assert.throws(
    () =>
      f.saveEntry(u, {
        template_id: tpl.id,
        template_version: 1,
        title: "禁止新增",
        values: {},
      }),
    /指定版型/,
  );
  assert.ok(f.printTemplate(u, tpl.id));
  g.grants(a, {
    kind: "form",
    format_id: tpl.id,
    version: 1,
    grants: [
      { user_id: u.id, action: "read", effect: "deny" },
      { user_id: u.id, action: "entry_read", effect: "deny" },
    ],
  });
  assert.throws(() => f.template(e.user(u.id), tpl.id), /指定版型/);
  assert.equal(f.data(e.user(u.id)).form_entries.length, 0);
  assert.equal(f.data(e.user(u.id)).form_templates.length, 0);
  assert.throws(
    () =>
      g.grants(a, { kind: "form", format_id: tpl.id, version: 0, grants: [] }),
    /更新/,
  );
  const reports = new CustomReports(e),
    report = reports.save(a, {
      name: "單據報表",
      dataset: "documents",
      columns: [{ key: "no" }],
      view_roles: ["admin", "manager"],
      print_roles: ["admin", "manager"],
      paper: "a4",
      orientation: "portrait",
    });
  g.grants(a, {
    kind: "report",
    format_id: report.id,
    version: 0,
    grants: [{ user_id: u.id, action: "print", effect: "deny" }],
  });
  assert.ok(reports.run(e.user(u.id), report.id));
  assert.throws(() => reports.print(e.user(u.id), report.id), /指定版型/);
});

test("manager routing snapshots the submit-time manager and revoked approvers cannot act", (t) => {
  const { e, a, g, users, doc, rule, act } = fixture(t);
  e.access.saveProfile(a, {
    user_id: a.id,
    version: 0,
    superuser: true,
    inherit_base: true,
    manager_id: users.lead.id,
  });
  rule({
    stages: [
      { name: "上階主管", source: "manager", mode: "any", user_ids: [] },
    ],
  });
  let d = act(e.user(a.id), doc(), "submit");
  assert.deepEqual(g.detail(e.user(a.id), 1).definition.stages[0].user_ids, [
    users.lead.id,
  ]);
  e.access.saveProfile(e.user(a.id), {
    user_id: users.lead.id,
    version: 0,
    inherit_base: false,
    rules: [
      { resource: "orders", action: "read", effect: "allow", scope: "all" },
    ],
  });
  assert.throws(() => act(e.user(users.lead.id), d), /權限/);
  assert.equal(g.detail(e.user(a.id), 1).votes.length, 0);
});
test("unfinishable distinct-person routes fail at submission and a decision cannot consume the only future approver", (t) => {
  const { e, a, g, users, doc, rule, act } = fixture(t);
  const original = rule({
    stages: [
      { name: "前階", source: "users", mode: "any", user_ids: [users.lead.id] },
      { name: "後階", source: "users", mode: "any", user_ids: [users.lead.id] },
    ],
  });
  assert.throws(() => act(a, doc(), "submit"), /無法分配不同/);
  rule({
    ...original,
    stages: [
      {
        name: "前階",
        source: "users",
        mode: "any",
        user_ids: [users.lead.id, users.finance.id],
      },
      { name: "後階", source: "users", mode: "any", user_ids: [users.lead.id] },
    ],
  });
  const d = act(a, doc(), "submit");
  assert.throws(() => act(users.lead, d), /後續階段/);
  const pending = act(users.finance, d);
  assert.equal(act(users.lead, pending).status, "approved");
});
