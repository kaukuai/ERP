import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "../src/application.mjs";
import { today } from "../src/core.mjs";
test("quality/matching HTTP checks CSRF, idempotency, release permissions, payment failure status, read-only users and company isolation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "erp-controls-")),
    app = createApplication({ dbPath: join(dir, "root.sqlite") }),
    server = http.createServer(app.handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function call(path, body, auth, extra = {}) {
    const r = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(auth ? { Cookie: auth.cookie } : {}),
        ...(body === undefined
          ? {}
          : {
              "Content-Type": "application/json",
              "X-ERP-Request": "1",
              "X-CSRF-Token": auth?.csrf || "",
              "Idempotency-Key": crypto.randomUUID(),
              Origin: base,
            }),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return {
      status: r.status,
      data: r.headers.get("Content-Type")?.includes("json")
        ? JSON.parse(text)
        : text,
      cookie: r.headers.get("Set-Cookie")?.split(";")[0],
    };
  }
  async function ok(path, body, auth, extra) {
    const r = await call(path, body, auth, extra);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  }
  const setup = await call("/api/setup", {
      username: "admin",
      password: "controls-http-fixture-2026",
    }),
    admin = { cookie: setup.cookie, csrf: setup.data.csrf };
  for (const [username, role] of [
    ["warehouse", "warehouse"],
    ["reviewer", "manager"],
    ["viewer", "viewer"],
  ])
    await ok(
      "/api/users",
      {
        username,
        name: username,
        role,
        password: "controls-http-fixture-2026",
      },
      admin,
    );
  const logins = {};
  for (const username of ["warehouse", "reviewer", "viewer"]) {
    const r = await call("/api/login", {
      username,
      password: "controls-http-fixture-2026",
    });
    logins[username] = { cookie: r.cookie, csrf: r.data.csrf };
  }
  const product = await ok(
      "/api/products",
      { sku: "QA", name: "檢驗品", cost: "10", price: "10" },
      admin,
    ),
    supplier = await ok(
      "/api/partners",
      { code: "V", name: "供應商", kind: "supplier" },
      admin,
    ),
    bank = await ok(
      "/api/finance/accounts",
      { code: "B", name: "銀行", kind: "bank", opening_balance: "1000" },
      admin,
    );
  assert.equal(
    (await call("/api/controls/quality-specs", {}, logins.warehouse)).status,
    403,
  );
  await ok(
    "/api/controls/quality-specs",
    {
      product_id: product.id,
      direction: "receipt",
      name: "測量",
      parameters: [
        {
          key: "cost",
          label: "獨立檢驗讀值",
          type: "number",
          lower: "9",
          upper: "11",
        },
      ],
      sampling_bp: 10000,
      min_sample_qty: "1",
    },
    admin,
  );
  let d = await ok(
    "/api/documents",
    {
      kind: "purchase",
      partner_id: supplier.id,
      warehouse_id: 1,
      lines: [{ product_id: product.id, qty: "2", price: "10" }],
    },
    admin,
  );
  d = await ok(
    "/api/documents/" + d.id + "/submit",
    { version: d.version },
    admin,
  );
  d = await ok(
    "/api/documents/" + d.id + "/approve",
    { version: d.version },
    admin,
  );
  const create = { document_id: d.id, document_version: d.version },
    key = crypto.randomUUID();
  assert.equal(
    (
      await call(
        "/api/controls/quality-inspections",
        create,
        logins.warehouse,
        { "X-CSRF-Token": "wrong" },
      )
    ).status,
    403,
  );
  let q = await ok(
    "/api/controls/quality-inspections",
    create,
    logins.warehouse,
    { "Idempotency-Key": key },
  );
  assert.equal(
    (
      await ok("/api/controls/quality-inspections", create, logins.warehouse, {
        "Idempotency-Key": key,
      })
    ).id,
    q.id,
  );
  assert.equal(
    (await call("/api/documents/" + d.id + "/fulfil", {}, admin)).status,
    409,
  );
  const visibleToViewer = await ok(
    "/api/controls/quality-inspections/" + q.id,
    undefined,
    logins.viewer,
  );
  assert.equal(visibleToViewer.id, q.id);
  assert.equal("price" in visibleToViewer.lines[0], false);
  assert.equal(
    (
      await call(
        "/api/controls/quality-inspections/" + q.id + "/save",
        { version: q.version, lines: [] },
        logins.viewer,
      )
    ).status,
    403,
  );
  q = await ok(
    "/api/controls/quality-inspections/" + q.id + "/save",
    {
      version: q.version,
      notes: "實測",
      lines: [
        { id: q.lines[0].id, sampled_qty: "2", readings: { cost: "10" } },
      ],
    },
    logins.warehouse,
  );
  assert.equal(
    q.lines[0].readings.cost,
    "10",
    "standalone quality reading must not be stripped as transaction cost",
  );
  q = await ok(
    "/api/controls/quality-inspections/" + q.id + "/action",
    { action: "submit", version: q.version },
    logins.warehouse,
  );
  assert.equal(
    (
      await call(
        "/api/controls/quality-inspections/" + q.id + "/action",
        { action: "approve", version: q.version },
        logins.warehouse,
      )
    ).status,
    403,
  );
  q = await ok(
    "/api/controls/quality-inspections/" + q.id + "/action",
    { action: "approve", version: q.version },
    logins.reviewer,
  );
  const receipt = await ok(
    "/api/documents/" + d.id + "/fulfil",
    { quality_inspection_id: q.id },
    admin,
  );
  const data = await ok("/api/bootstrap", undefined, admin),
    source = (
      await ok(
        "/api/controls/vendor-sources?supplier_id=" + supplier.id,
        undefined,
        admin,
      )
    ).find((s) => s.fulfilment_id === receipt.id),
    policy = data.procurement_control_policy;
  await ok(
    "/api/controls/procurement-policy",
    { version: policy.version, require_matching: true },
    admin,
  );
  const pay = {
    open_item_id: source.open_item_id,
    amount: "1",
    date: today(),
    method: "bank",
    bank_account_id: bank.id,
  };
  const blocked = await call("/api/payments", pay, admin);
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /三方核對/);
  assert.equal(
    (
      await call(
        "/api/controls/vendor-bills",
        { supplier_id: supplier.id },
        logins.warehouse,
      )
    ).status,
    403,
  );
  let b = await ok(
    "/api/controls/vendor-bills",
    {
      supplier_id: supplier.id,
      invoice_ref: "HTTP-001",
      date: today(),
      total: "21",
      lines: [{ receipt_line_id: source.id, qty: "2", net: "20", tax: "1" }],
    },
    admin,
  );
  assert.equal(
    (
      await call(
        "/api/controls/vendor-bills/" + b.id,
        undefined,
        logins.warehouse,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/api/controls/vendor-bills/" + b.id + "/action",
        {
          action: "approve",
          version: b.version,
          token: b.match.token,
          reason: "自行核准",
        },
        admin,
      )
    ).status,
    403,
  );
  const approve = {
      action: "approve",
      version: b.version,
      token: b.match.token,
      reason: "已核對",
      accept_variance: true,
    },
    approvalKey = crypto.randomUUID();
  b = await ok(
    "/api/controls/vendor-bills/" + b.id + "/action",
    approve,
    logins.reviewer,
    { "Idempotency-Key": approvalKey },
  );
  assert.equal(b.payment_valid, true);
  assert.equal(
    (
      await ok(
        "/api/controls/vendor-bills/" + b.id + "/action",
        approve,
        logins.reviewer,
        { "Idempotency-Key": approvalKey },
      )
    ).version,
    b.version,
  );
  await ok("/api/payments", pay, admin);
  const branch = await ok(
      "/api/companies",
      {
        slug: "controls-isolation",
        name: "獨立測試帳套",
        username: "admin",
        password: "controls-company-fixture-2026",
      },
      admin,
    ),
    login = await call(
      "/api/login",
      { username: "admin", password: "controls-company-fixture-2026" },
      undefined,
      { "X-ERP-Company": "controls-isolation" },
    ),
    branchAuth = { cookie: login.cookie, csrf: login.data.csrf };
  const separate = await ok("/api/bootstrap", undefined, branchAuth, {
    "X-ERP-Company": "controls-isolation",
  });
  assert.deepEqual(separate.quality_inspections, []);
  assert.deepEqual(separate.vendor_bills, []);
  assert.equal(separate.procurement_control_policy.require_matching, false);
  assert.equal(
    (
      await call(
        "/api/controls/quality-inspections/" + q.id,
        undefined,
        branchAuth,
        { "X-ERP-Company": "controls-isolation" },
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await call("/api/controls/vendor-bills/" + b.id, undefined, branchAuth, {
        "X-ERP-Company": "controls-isolation",
      })
    ).status,
    404,
  );
  assert.equal((await ok("/api/integrity", undefined, admin)).ok, true);
});
