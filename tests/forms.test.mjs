import test from "node:test";
import assert from "node:assert/strict";
import { ERP } from "../src/core.mjs";
import { Forms, formModel as M } from "../src/forms.mjs";
import { accessContext } from "../src/access-control.mjs";
import { guardRequest } from "../src/access-routes.mjs";
function fixture(t) {
  const e = new ERP();
  t.after(() => e.close());
  const a = e.setup({ username: "admin", password: "form-fixtures-only-2026" }),
    f = new Forms(e);
  return { e, a, f };
}
const rule = (resource, action, scope = "all") => ({
  resource,
  action,
  scope,
  effect: "allow",
});
test("all neutral presets validate; typed fields reject HTML execution, invalid dates, unknown keys and hostile layouts", () => {
  assert.equal(M.presets().length, 11);
  for (const p of M.presets()) {
    assert.deepEqual(M.validate(p.definition), p.definition);
    const html = M.render(p.definition);
    assert.match(html, /thead|ff-table/);
  }
  const d = M.validate(M.starter());
  assert.throws(() =>
    M.validate({ ...d, blocks: [{ ...d.blocks[0], span: 13 }] }),
  );
  assert.throws(() =>
    M.validate({ ...d, blocks: [{ ...d.blocks[0], id: "__proto__" }] }),
  );
  assert.throws(() =>
    M.validate({
      ...d,
      blocks: [
        { id: "image", type: "image", src: "https://example.test/track.png" },
      ],
    }),
  );
  assert.throws(() =>
    M.validate({
      ...d,
      blocks: [{ id: "field", type: "field", binding: "users.password" }],
    }),
  );
  assert.throws(() => M.validateValues(d, { date: "2026-02-31" }), /日期/);
  assert.throws(() => M.validateValues(d, { unknown: "secret" }), /未定義/);
  assert.throws(() => M.validateValues(d, {}, true), /必填/);
  const vals = M.validateValues(
    d,
    {
      date: "2026-11-03",
      name: "<script>alert(1)</script>",
      items: [
        {
          item: "<img onerror=alert(1)>",
          description: "長說明\n第二行\n+保留正號",
        },
      ],
    },
    true,
  );
  const html = M.render(d, vals);
  assert.doesNotMatch(html, /<script>alert|<img onerror/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /第二行/);
  assert.match(html, /\n\+保留正號/);
});
test("form entries preserve layout and company snapshots, immutable history, submission locks, cancellation reasons and version conflicts", (t) => {
  const { e, a, f } = fixture(t),
    d = M.presets().find((x) => x.key === "daily_work").definition;
  let tpl = f.save(a, { name: "工作報告", definition: d });
  let r = f.saveEntry(a, {
    template_id: tpl.id,
    template_version: tpl.version,
    title: "我的工作報告",
    values: { date: "2026-11-03", name: "測試人員" },
  });
  const original = r.definition;
  tpl = f.save(a, {
    ...tpl,
    definition: {
      ...d,
      blocks: d.blocks.map((b) =>
        b.id === "title" ? { ...b, text: "改版標題" } : b,
      ),
    },
  });
  assert.throws(
    () =>
      f.saveEntry(a, {
        template_id: tpl.id,
        template_version: 1,
        title: "舊預覽",
        values: {},
      }),
    /更新/,
  );
  assert.deepEqual(f.entry(a, r.id).definition, original);
  e.run("UPDATE settings SET value='改名後' WHERE key='company'");
  assert.doesNotMatch(f.printEntry(a, r.id), /改名後|改版標題/);
  assert.throws(() => f.save(a, { ...tpl, version: 1 }), /更新/);
  r = f.transition(a, r.id, { version: r.version }, "submit");
  assert.equal(r.status, "submitted");
  assert.throws(
    () => f.saveEntry(a, { ...r, title: "不能改", values: {} }),
    /已完成/,
  );
  assert.throws(
    () => f.transition(a, r.id, { version: r.version }, "cancel"),
    /不得為空/,
  );
  r = f.transition(
    a,
    r.id,
    { version: r.version, reason: "作廢並另填" },
    "cancel",
  );
  assert.match(f.printEntry(a, r.id), /已取消/);
  assert.throws(() => e.run("DELETE FROM form_entry_events"), /immutable/);
  assert.throws(
    () => e.run("UPDATE form_template_versions SET name=?", "rewrite"),
    /immutable/,
  );
  assert.deepEqual(e.integrity(a).problems, []);
});
test("bound quote print uses original partner snapshot and exact money, never changes accounting or imports user amounts", (t) => {
  const { e, a, f } = fixture(t),
    p = e.savePartner(a, { code: "TEST", name: "原始名稱" }),
    product = e.saveProduct(a, { sku: "P", name: "品名", price: "10.01" });
  const doc = e.saveDoc(a, {
    kind: "quote",
    partner_id: p.id,
    warehouse_id: 1,
    lines: [{ product_id: product.id, qty: "1.250", price: "10.01" }],
  });
  const tpl = f.save(a, {
    name: "報價",
    definition: M.validate(M.starter("quote")),
  });
  e.run("UPDATE partners SET name=? WHERE id=?", "新名字", p.id);
  const journals = e.get("SELECT count(*) n FROM journals").n,
    html = f.printTemplate(a, tpl.id, { document_id: doc.id });
  assert.match(html, /原始名稱/);
  assert.doesNotMatch(html, /新名字/);
  assert.match(html, /1.25/);
  assert.match(html, /10.01/);
  assert.match(html, /非統一發票/);
  assert.match(html, /草稿/);
  assert.throws(
    () =>
      f.saveEntry(a, {
        template_id: tpl.id,
        template_version: tpl.version,
        title: "不能偽造交易",
        values: {},
      }),
    /來源單據/,
  );
  assert.equal(e.get("SELECT count(*) n FROM journals").n, journals);
});
test("legacy inclusive-tax documents print original amounts without inventing per-line tax allocations", (t) => {
  const { e, a, f } = fixture(t);
  const p = e.savePartner(a, { code: "OLD", name: "舊版測試" });
  const product = e.saveProduct(a, { sku: "OLD", name: "舊品項" });
  const doc = e.saveDoc(a, {
    kind: "quote",
    partner_id: p.id,
    warehouse_id: 1,
    tax_mode: "inclusive",
    lines: [
      { product_id: product.id, qty: "1", price: "105", discount_bp: 9000 },
    ],
  });
  // Reproduce the exact additive-migration defaults in an isolated fixture.
  e.run("UPDATE documents SET calc_version=1 WHERE id=?", doc.id);
  e.run(
    "UPDATE document_lines SET net=0,tax=0,total=0 WHERE document_id=?",
    doc.id,
  );
  const snapshot = e.doc(a, doc.id);
  const tpl = f.save(a, {
    name: "舊版單據",
    definition: M.validate(M.starter("quote")),
  });
  const { context } = f.document(a, doc.id, "quote");
  assert.equal(context.lines[0].discount_bp, "90");
  assert.equal(context.lines[0].amount, "94.50");
  for (const key of ["net", "tax", "total"])
    assert.equal(context.lines[0][key], "");
  assert.equal(context["document.net"], "90.00");
  assert.equal(context["document.tax"], "4.50");
  const html = f.printTemplate(a, tpl.id, { document_id: doc.id });
  assert.match(html, /94\.50/);
  assert.match(html, /舊版單據未保存逐列/);
  assert.deepEqual(e.doc(a, doc.id), snapshot);
});
test("legacy users only see own entries; configured directional scopes independently control read, modify and print", (t) => {
  const { e, a, f } = fixture(t);
  for (const name of ["lead", "child", "peer"])
    e.saveUser(a, {
      username: name,
      name,
      role: "sales",
      password: "form-fixtures-only-2026",
    });
  const users = Object.fromEntries(
    e
      .all("SELECT id,username FROM users")
      .map((u) => [u.username, e.user(u.id)]),
  );
  const tpl = f.save(a, { name: "日報", definition: M.validate(M.starter()) });
  const entries = {};
  for (const name of ["lead", "child", "peer"])
    entries[name] = f.saveEntry(users[name], {
      template_id: tpl.id,
      template_version: 1,
      title: name,
      values: {},
    });
  assert.equal(f.data(users.child).form_entries.length, 1);
  assert.throws(() => f.entry(users.child, entries.peer.id), /本人/);
  assert.throws(
    () => f.save(users.child, { name: "禁止", definition: tpl.definition }),
    /權限/,
  );
  e.access.saveProfile(a, {
    user_id: users.child.id,
    manager_id: users.lead.id,
    inherit_base: true,
    version: 0,
  });
  e.access.saveProfile(a, {
    user_id: users.lead.id,
    version: 0,
    inherit_base: false,
    rules: [
      rule("form_templates", "read"),
      rule("form_entries", "read", "descendants"),
      rule("form_entries", "update", "own"),
      rule("form_entries", "print", "own"),
    ],
  });
  const lead = e.user(users.lead.id);
  accessContext.run({ policy: e.access.policy(lead), reading: true }, () => {
    assert.equal(f.data(lead).form_entries.length, 2);
    assert.equal(f.entry(lead, entries.child.id).title, "child");
    assert.throws(() => f.entry(lead, entries.peer.id), /權限/);
    assert.throws(() => f.printEntry(lead, entries.child.id), /權限/);
  });
  assert.throws(
    () => f.saveEntry(lead, { ...entries.child, title: "cannot", values: {} }),
    /權限/,
  );
  assert.throws(
    () =>
      guardRequest(e, lead, "/api/form-templates", "POST", {
        name: "no",
        definition: tpl.definition,
      }),
    /權限/,
  );
});
test("print scope and hidden field policies cannot be bypassed with a template or POST preview", (t) => {
  const { e, a, f } = fixture(t),
    p = e.savePartner(a, { code: "C", name: "來源客戶" }),
    product = e.saveProduct(a, { sku: "P", name: "來源商品", price: "50" });
  const doc = e.saveDoc(a, {
    kind: "quote",
    partner_id: p.id,
    warehouse_id: 1,
    lines: [{ product_id: product.id, qty: "1" }],
  });
  e.saveUser(a, {
    username: "restricted",
    name: "受限",
    role: "manager",
    password: "form-fixtures-only-2026",
  });
  const id = e.get("SELECT id FROM users WHERE username=?", "restricted").id;
  const tpl = f.save(a, {
    name: "報價版型",
    definition: M.validate(M.starter("quote")),
  });
  const rules = [
    rule("quotes", "read"),
    rule("partners", "read"),
    rule("products", "read"),
    rule("warehouses", "read"),
    rule("form_templates", "read"),
    rule("form_templates", "print"),
    rule("form_templates", "create"),
  ];
  e.access.saveProfile(a, {
    user_id: id,
    version: 0,
    inherit_base: false,
    rules,
  });
  let u = e.user(id);
  assert.throws(
    () => f.printTemplate(u, tpl.id, { document_id: doc.id }),
    /權限/,
  );
  assert.throws(
    () => f.preview(u, { definition: tpl.definition, document_id: doc.id }),
    /權限/,
  );
  e.access.saveProfile(a, {
    user_id: id,
    version: 1,
    inherit_base: false,
    rules: [...rules, rule("quotes", "print")],
    fields: [{ resource: "partners", field: "phone", mode: "hidden" }],
  });
  u = e.user(id);
  assert.throws(
    () => f.preview(u, { definition: tpl.definition, document_id: doc.id }),
    /隱藏/,
  );
});

test("delegated viewer can submit a visible draft without update and template editor can preview without create", (t) => {
  const { e, a, f } = fixture(t),
    tpl = f.save(a, { name: "分開授權", definition: M.validate(M.starter()) });
  const r = f.saveEntry(a, {
    template_id: tpl.id,
    template_version: 1,
    title: "可送出不可修改",
    values: { date: "2026-11-03", name: "測試人員" },
  });
  e.saveUser(a, {
    username: "delegated",
    name: "代理人",
    role: "viewer",
    password: "forms-permissions-test-2026",
  });
  const id = e.get("SELECT id FROM users WHERE username=?", "delegated").id;
  e.access.saveProfile(a, {
    user_id: id,
    version: 0,
    inherit_base: false,
    rules: [
      rule("form_templates", "read"),
      rule("form_templates", "update"),
      rule("form_entries", "read"),
      rule("form_entries", "submit"),
    ],
  });
  const u = e.user(id),
    entry = f.entry(u, r.id);
  assert.equal(entry.allowed.update, false);
  assert.equal(entry.allowed.submit, true);
  assert.equal(entry.allowed.print, false);
  assert.equal(f.data(u).form_permissions.edit, true);
  assert.equal(f.data(u).form_permissions.design, false);
  assert.throws(() => f.saveEntry(u, { ...entry, title: "不能改" }), /權限/);
  guardRequest(e, u, "/api/form-preview", "POST", {
    id: tpl.id,
    definition: tpl.definition,
  });
  assert.ok(f.preview(u, { id: tpl.id, definition: tpl.definition }).html);
  assert.throws(() => f.preview(u, { definition: tpl.definition }), /權限/);
  assert.equal(
    f.transition(u, entry.id, { version: entry.version }, "submit").status,
    "submitted",
  );
});
