import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { ERP } from "../src/core.mjs";
import { accessContext, accessPolicy } from "../src/access-control.mjs";
import { guardRequest } from "../src/access-routes.mjs";
import { createApplication } from "../src/application.mjs";
const rule = (resource, action, scope = "all", extra = {}) => ({
  resource,
  action,
  scope,
  effect: "allow",
  ...extra,
});
const password = "isolated-access-test-2026";
function fixture(t) {
  const e = new ERP();
  t.after(() => e.close());
  const a = e.setup({ username: "admin", password });
  for (const name of ["lead", "child", "peer", "grandchild"])
    e.saveUser(a, { username: name, name, role: "manager", password });
  return {
    e,
    a,
    ids: Object.fromEntries(
      e.all("SELECT id,username FROM users").map((x) => [x.username, x.id]),
    ),
  };
}
test("hierarchy, personal overrides, inherited roles, deny precedence, expiry and cycle prevention", (t) => {
  const { e, a, ids } = fixture(t),
    save = (name, b = {}) =>
      e.access.saveProfile(a, {
        user_id: ids[name],
        version:
          e.get(
            "SELECT version FROM access_profiles WHERE user_id=?",
            ids[name],
          )?.version || 0,
        ...b,
      });
  save("child", { manager_id: ids.lead, inherit_base: false });
  save("grandchild", { manager_id: ids.child, inherit_base: false });
  save("peer", { inherit_base: false });
  save("lead", {
    inherit_base: false,
    rules: [
      rule("orders", "read", "descendants", { depth: 1 }),
      rule("orders", "update", "own"),
    ],
  });
  let p = e.access.policy(e.user(ids.lead));
  assert.deepEqual(e.access.owners(p, e.access.rules(p, "orders", "read")[0]), [
    ids.lead,
    ids.child,
  ]);
  assert.throws(() => save("lead", { manager_id: ids.grandchild }), /循環/);
  const parent = e.access.saveRole(a, {
      name: "可讀訂單",
      rules: [rule("orders", "read")],
    }),
    child = e.access.saveRole(a, {
      name: "訂單編輯",
      parent_ids: [parent.id],
      rules: [rule("orders", "update", "own")],
    });
  assert.throws(
    () =>
      e.access.saveRole(a, {
        id: parent.id,
        version: 1,
        name: "循環",
        parent_ids: [child.id],
      }),
    /循環/,
  );
  save("peer", {
    inherit_base: false,
    role_ids: [child.id],
    rules: [rule("orders", "read", "selected", { owners: [ids.child] })],
  });
  p = e.access.policy(e.user(ids.peer));
  assert.equal(e.access.rules(p, "orders", "read")[0].scope, "selected");
  assert.equal(e.access.rules(p, "orders", "update")[0].scope, "own");
  save("peer", {
    inherit_base: false,
    role_ids: [child.id],
    rules: [
      rule("orders", "read"),
      rule("orders", "read", "selected", {
        effect: "deny",
        owners: [ids.child],
      }),
    ],
  });
  p = e.access.policy(e.user(ids.peer));
  assert.match(e.access.predicate(p, "documents"), /AND NOT/);
  e.run(
    "UPDATE access_rules SET expires_at='2000-01-01T00:00:00Z' WHERE principal_type='user' AND principal_id=?",
    ids.peer,
  );
  p = e.access.policy(e.user(ids.peer));
  assert.equal(e.access.rules(p, "orders", "read")[0].principal_type, "role");
  assert.throws(() => save("admin", { superuser: false }), /至少保留/);
  assert.throws(
    () => e.access.saveProfile(e.user(ids.lead), { user_id: ids.lead }),
    /完整權限管理員/,
  );
  assert.ok(
    e.all("SELECT * FROM audit WHERE action='access_changed'").length >= 7,
  );
});
test("scoped SQL filters source rows before aggregates and child joins, while posting calculations remain unfiltered", (t) => {
  const { e, a, ids } = fixture(t);
  const partner = e.savePartner(a, { code: "C1", name: "客戶" }),
    product = e.saveProduct(a, {
      sku: "P1",
      name: "商品",
      price: "100",
      cost: "50",
    });
  const docs = ["lead", "child", "peer"].map((name) =>
    e.saveDoc(e.user(ids[name]), {
      kind: "order",
      partner_id: partner.id,
      warehouse_id: 1,
      lines: [{ product_id: product.id, qty: "1", price: "100" }],
    }),
  );
  e.access.saveProfile(a, {
    user_id: ids.child,
    manager_id: ids.lead,
    inherit_base: true,
  });
  e.access.saveProfile(a, {
    user_id: ids.lead,
    inherit_base: true,
    rules: [
      rule("orders", "read", "direct"),
      rule("orders", "update", "own"),
      rule("orders", "cancel", "own"),
      rule("orders", "approve", "all", { effect: "deny" }),
    ],
  });
  const u = e.user(ids.lead),
    p = e.access.policy(u);
  accessContext.run({ policy: p, reading: true }, () => {
    assert.deepEqual(
      e.all("SELECT id FROM documents ORDER BY id").map((x) => x.id),
      docs.slice(0, 2).map((d) => d.id),
    );
    assert.equal(e.get("SELECT sum(total) total FROM documents").total, 21000);
    assert.equal(e.get("SELECT count(*) n FROM document_lines").n, 2);
    assert.equal(
      e.all(
        "SELECT d.id,l.price FROM documents d JOIN document_lines l ON l.document_id=d.id",
      ).length,
      2,
    );
    assert.equal(
      e.get("SELECT 'FROM documents' text, count(*) n FROM documents").n,
      2,
    );
  });
  assert.equal(
    e.all("SELECT * FROM documents").length,
    3,
    "mutation context retains complete stock/credit basis",
  );
  assert.doesNotThrow(() =>
    guardRequest(e, u, "/api/documents/" + docs[0].id, "GET"),
  );
  assert.throws(
    () => guardRequest(e, u, "/api/documents/" + docs[2].id, "GET"),
    /權限|範圍/,
  );
  assert.throws(
    () =>
      guardRequest(e, u, "/api/documents/" + docs[1].id + "/cancel", "POST"),
    /權限|範圍/,
  );
  assert.throws(
    () =>
      guardRequest(e, u, "/api/documents/" + docs[0].id + "/approve", "POST"),
    /權限|範圍/,
  );
});
test("field readonly cannot be bypassed by omitting values, and restricted users cannot expose backups or raw formatted fields", (t) => {
  const { e, a, ids } = fixture(t),
    partner = e.savePartner(a, {
      code: "C1",
      name: "客戶",
      phone: "0912345678",
      credit_limit: "1000",
    });
  e.access.saveProfile(a, {
    user_id: ids.lead,
    inherit_base: true,
    fields: [
      { resource: "partners", field: "phone", mode: "readonly" },
      { resource: "partners", field: "credit_limit", mode: "readonly" },
    ],
  });
  let u = e.user(ids.lead),
    b = {
      id: partner.id,
      version: partner.version,
      code: partner.code,
      name: partner.name,
    };
  guardRequest(e, u, "/api/partners", "POST", b);
  assert.equal(b.phone, "0912345678");
  assert.equal(b.credit_limit, "1000");
  e.savePartner(u, b);
  assert.equal(
    e.get("SELECT phone FROM partners WHERE id=?", partner.id).phone,
    partner.phone,
  );
  assert.throws(
    () => guardRequest(e, u, "/api/partners", "POST", { ...b, phone: "other" }),
    /唯讀/,
  );
  assert.throws(() => guardRequest(e, u, "/api/backup", "GET"), /完整權限/);
  e.access.saveProfile(a, {
    user_id: ids.lead,
    version: 1,
    inherit_base: true,
    fields: [{ resource: "partners", field: "phone", mode: "hidden" }],
  });
  u = e.user(ids.lead);
  assert.equal(e.access.sanitize(e.access.policy(u), partner).phone, undefined);
  assert.throws(
    () => guardRequest(e, u, "/api/export", "GET", {}, { kind: "partners" }),
    /隱藏欄位/,
  );
  assert.throws(
    () =>
      e.access.simulate(a, {
        user_id: ids.lead,
        resource: "orders",
        action: "read",
        table: "users",
        record_id: 1,
      }),
    /不允許/,
  );
});
test("HTTP enforces hierarchy scopes for bootstrap, direct id, CSV, reports, session invalidation and concurrent company isolation", async (t) => {
  const app = createApplication(),
    server = createServer(app.handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((r) => server.close(r));
    app.close();
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const call = async (path, b, s) => {
    const res = await fetch(base + path, {
      method: b === undefined ? "GET" : "POST",
      headers: {
        ...(s ? { Cookie: s.cookie, "X-CSRF-Token": s.csrf } : {}),
        "Content-Type": "application/json",
        "X-ERP-Request": "1",
        "Idempotency-Key": crypto.randomUUID(),
        Origin: base,
      },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    const text = await res.text();
    return {
      status: res.status,
      data: res.headers.get("content-type")?.includes("json")
        ? JSON.parse(text)
        : text,
      cookie: res.headers.get("set-cookie")?.split(";")[0],
    };
  };
  const login = async (username) => {
    const r = await call("/api/login", { username, password });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return { ...r.data, cookie: r.cookie };
  };
  assert.equal(
    (await call("/api/setup", { username: "admin", password })).status,
    200,
  );
  let root = await login("admin");
  for (const username of ["lead", "child", "peer"])
    assert.equal(
      (
        await call(
          "/api/users",
          { username, name: username, role: "manager", password },
          root,
        )
      ).status,
      200,
    );
  const initial = (await call("/api/bootstrap", undefined, root)).data,
    users = initial.users,
    ids = Object.fromEntries(users.map((u) => [u.username, u.id]));
  const customer = (
      await call("/api/partners", { code: "C1", name: "共同客戶" }, root)
    ).data,
    product = (
      await call(
        "/api/products",
        { sku: "P1", name: "商品", price: "100", cost: "50" },
        root,
      )
    ).data;
  const docs = {};
  for (const username of ["lead", "child", "peer"]) {
    const s = await login(username),
      d = await call(
        "/api/documents",
        {
          kind: "order",
          partner_id: customer.id,
          warehouse_id: 1,
          lines: [{ product_id: product.id, qty: "1", price: "100" }],
        },
        s,
      );
    assert.equal(d.status, 200, JSON.stringify(d.data));
    docs[username] = d.data;
  }
  let r = await call(
    "/api/access/profiles",
    { user_id: ids.child, manager_id: ids.lead, inherit_base: true },
    root,
  );
  assert.equal(r.status, 200, JSON.stringify(r.data));
  root = await login("admin");
  r = await call(
    "/api/access/profiles",
    {
      user_id: ids.lead,
      inherit_base: true,
      rules: [
        rule("orders", "read", "direct"),
        rule("orders", "update", "own"),
        rule("orders", "cancel", "own"),
        rule("orders", "export", "direct"),
        rule("orders", "print", "direct"),
      ],
    },
    root,
  );
  assert.equal(r.status, 200);
  let lead = await login("lead");
  r = await call("/api/bootstrap", undefined, lead);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.documents.map((d) => d.owner_id).sort(), [
    ids.lead,
    ids.child,
  ]);
  assert.equal(
    (await call("/api/documents/" + docs.peer.id, undefined, lead)).status,
    403,
  );
  assert.equal(
    (await call("/api/documents/" + docs.child.id + "/cancel", {}, lead))
      .status,
    403,
  );
  const csv = await call("/api/export?kind=documents", undefined, lead);
  assert.equal(csv.status, 200);
  assert.ok(csv.data.includes(docs.child.no));
  assert.ok(!csv.data.includes(docs.peer.no));
  const html = await call("/print/" + docs.child.id, undefined, lead);
  assert.equal(html.status, 200);
  assert.ok(html.data.includes(docs.child.no));
  assert.equal(
    (await call("/print/" + docs.peer.id, undefined, lead)).status,
    403,
  );
  root = await login("admin");
  r = await call(
    "/api/access/profiles",
    {
      user_id: ids.lead,
      version: 1,
      inherit_base: false,
      rules: [rule("orders", "read", "own")],
    },
    root,
  );
  assert.equal(r.status, 200);
  assert.equal((await call("/api/bootstrap", undefined, lead)).status, 401);
  lead = await login("lead");
  assert.equal(
    (
      await call(
        "/api/users",
        { id: ids.lead, name: "升權", role: "admin" },
        lead,
      )
    ).status,
    403,
  );
  assert.equal((await call("/api/backup", undefined, lead)).status, 403);
});
test("ownerless billing children inherit document ownership and warehouse/category filters cannot be ignored", (t) => {
  const { e, a, ids } = fixture(t),
    partner = e.savePartner(a, { code: "C1", name: "共同客戶" }),
    product = e.saveProduct(a, {
      sku: "P1",
      name: "商品",
      price: "100",
      cost: "50",
      category: "A",
    }),
    wh = e.saveWarehouse(a, { code: "WH2", name: "第二倉" });
  for (const warehouse_id of [1, wh.id])
    e.adjust(a, {
      product_id: product.id,
      warehouse_id,
      qty: "10",
      unit_cost: "50",
      reason: "期初",
    });
  const records = [];
  for (const [owner, warehouse_id] of [
    ["lead", 1],
    ["peer", 1],
    ["lead", wh.id],
  ]) {
    const u = e.user(ids[owner]),
      d = e.saveDoc(u, {
        kind: "order",
        partner_id: partner.id,
        warehouse_id,
        lines: [{ product_id: product.id, qty: "1", price: "100" }],
      });
    e.transition(a, d.id, "submit");
    e.transition(a, d.id, "approve");
    const f = e.fulfil(a, d.id, {});
    records.push({ d, f });
  }
  e.access.saveProfile(a, {
    user_id: ids.lead,
    inherit_base: true,
    rules: [
      rule("billing", "read", "own", { warehouses: [1] }),
      rule("orders", "read", "all", { warehouses: [1], categories: ["A"] }),
    ],
  });
  const p = e.access.policy(e.user(ids.lead));
  accessContext.run({ policy: p, reading: true }, () => {
    assert.equal(e.get("SELECT count(*) n FROM open_items").n, 1);
    assert.equal(e.get("SELECT sum(amount) n FROM open_items").n, 10500);
    assert.deepEqual(
      e.all("SELECT id FROM documents ORDER BY id").map((x) => x.id),
      records.slice(0, 2).map((x) => x.d.id),
    );
  });
  e.access.saveProfile(a, {
    user_id: ids.lead,
    version: 1,
    inherit_base: true,
    rules: [rule("orders", "read", "all", { categories: ["B"] })],
  });
  const next = e.access.policy(e.user(ids.lead));
  accessContext.run({ policy: next, reading: true }, () =>
    assert.equal(e.get("SELECT count(*) n FROM documents").n, 0),
  );
});
test("read access to a peer source never grants posting, cash application or batch source operations", (t) => {
  const { e, a, ids } = fixture(t),
    partner = e.savePartner(a, { code: "C1", name: "共同客戶" }),
    product = e.saveProduct(a, {
      sku: "P1",
      name: "商品",
      price: "100",
      cost: "50",
    });
  e.adjust(a, {
    product_id: product.id,
    warehouse_id: 1,
    qty: "10",
    unit_cost: "50",
    reason: "期初",
  });
  const peer = e.user(ids.peer),
    doc = e.saveDoc(peer, {
      kind: "order",
      partner_id: partner.id,
      warehouse_id: 1,
      lines: [{ product_id: product.id, qty: "1", price: "100" }],
    });
  e.transition(a, doc.id, "submit");
  e.transition(a, doc.id, "approve");
  e.access.saveProfile(a, {
    user_id: ids.lead,
    inherit_base: true,
    rules: [
      rule("orders", "read", "all"),
      rule("fulfilments", "create", "own"),
      rule("payments", "create", "own"),
    ],
  });
  const u = e.user(ids.lead),
    p = e.access.policy(u);
  accessContext.run({ policy: p, reading: false }, () => {
    guardRequest(e, u, "/api/fulfilment-batches", "POST", {
      documents: [{ document_id: doc.id }],
    });
    assert.throws(() => e.fulfil(u, doc.id, {}), /來源資料.*授權範圍/);
  });
  assert.equal(e.get("SELECT count(*) n FROM fulfilments").n, 0);
  assert.equal(e.stock(product.id, 1).reserved, 1000);
});
