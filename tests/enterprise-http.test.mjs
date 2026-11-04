import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "../src/application.mjs";
import { today } from "../src/core.mjs";
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "erp-enterprise-http-")),
    dbPath = join(dir, "root.sqlite");
  let app, server, base;
  async function start() {
    app = createApplication({ dbPath, port: 4399 });
    server = http.createServer(app.handler);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = "http://127.0.0.1:" + server.address().port;
  }
  async function stop() {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    app.close();
  }
  await start();
  t.after(async () => {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  });
  async function call(path, body, auth = {}, extra = {}) {
    const r = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Cookie: auth.cookie || "",
        ...(auth.company ? { "X-ERP-Company": auth.company } : {}),
        ...(body === undefined
          ? {}
          : {
              "Content-Type": "application/json",
              "X-ERP-Request": "1",
              "X-CSRF-Token": auth.csrf || "",
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
  async function ok(...args) {
    const r = await call(...args);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  }
  const setup = await call("/api/setup", {
      username: "admin",
      password: "enterprise-http-fixture-2026",
    }),
    admin = { cookie: setup.cookie, csrf: setup.data.csrf };
  return {
    call,
    ok,
    admin,
    restart: async () => {
      await stop();
      await start();
    },
  };
}
test("twenty independent users share one persistent company, simultaneous writes have unique numbers and stale edits never overwrite the winner", async (t) => {
  const { call, ok, admin, restart } = await fixture(t);
  const password = "enterprise-http-fixture-2026";
  for (let i = 0; i < 20; i++)
    await ok(
      "/api/users",
      {
        username: "worker" + i,
        name: "同時作業 " + i,
        role: "manager",
        password,
      },
      admin,
    );
  const auth = await Promise.all(
    Array.from({ length: 20 }, async (_, i) => {
      const r = await call("/api/login", { username: "worker" + i, password });
      assert.equal(r.status, 200);
      return { cookie: r.cookie, csrf: r.data.csrf };
    }),
  );
  assert.equal(new Set(auth.map((a) => a.cookie)).size, 20);
  const customer = await ok(
      "/api/partners",
      { code: "C", name: "共享客戶" },
      admin,
    ),
    product = await ok(
      "/api/products",
      { sku: "P", name: "共享商品", price: "10" },
      admin,
    ),
    body = {
      kind: "quote",
      partner_id: customer.id,
      warehouse_id: 1,
      lines: [{ product_id: product.id, qty: "1", price: "10" }],
    },
    created = await Promise.all(
      auth.map((a, i) =>
        ok("/api/documents", { ...body, notes: "使用者 " + i }, a),
      ),
    );
  assert.equal(new Set(created.map((d) => d.no)).size, 20);
  assert.equal(
    (await ok("/api/bootstrap", undefined, admin)).documents.length,
    20,
  );
  const shared = created[0],
    edits = await Promise.all(
      auth.map((a, i) =>
        call(
          "/api/documents",
          {
            ...body,
            id: shared.id,
            version: shared.version,
            notes: "同時修改 " + i,
          },
          a,
        ),
      ),
    );
  assert.equal(edits.filter((r) => r.status === 200).length, 1);
  assert.equal(edits.filter((r) => r.status === 409).length, 19);
  const winner = edits.find((r) => r.status === 200).data;
  await restart();
  const reopened = await ok("/api/documents/" + shared.id, undefined, auth[10]);
  assert.equal(reopened.notes, winner.notes);
  assert.equal(reopened.version, winner.version);
  assert.equal(
    (await ok("/api/bootstrap", undefined, admin)).documents.length,
    20,
  );
  assert.equal((await ok("/api/integrity", undefined, admin)).ok, true);
});
test("enterprise HTTP enforces CSRF, current permission checks before replay, malformed input and per-company data isolation", async (t) => {
  const { call, ok, admin } = await fixture(t);
  const password = "enterprise-http-fixture-2026";
  for (const [username, role] of [
    ["warehouse", "warehouse"],
    ["viewer", "viewer"],
  ])
    await ok("/api/users", { username, name: username, role, password }, admin);
  const logins = {};
  for (const name of ["warehouse", "viewer"]) {
    const r = await call("/api/login", { username: name, password });
    logins[name] = { cookie: r.cookie, csrf: r.data.csrf };
  }
  assert.equal(
    (
      await call(
        "/api/enterprise/wms/bin",
        { warehouse_id: 1, code: "A", name: "A", kind: "pick" },
        admin,
        { "X-CSRF-Token": "bad" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/api/enterprise/fx/rate",
        { currency: "USD", date: today(), rate: "30", source: "測試" },
        logins.warehouse,
      )
    ).status,
    403,
  );
  assert.equal(
    (await call("/api/enterprise/hr/configure", {}, logins.viewer)).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/api/enterprise/production/route",
        { operations: [null] },
        admin,
      )
    ).status,
    400,
  );
  assert.equal(
    (await call("/api/enterprise/hr/compute", { adjustments: "bad" }, admin))
      .status,
    400,
  );
  const key = crypto.randomUUID(),
    b = { warehouse_id: 1, code: "PICK", name: "揀貨位", kind: "pick" },
    first = await ok("/api/enterprise/wms/bin", b, admin, {
      "Idempotency-Key": key,
    }),
    again = await ok("/api/enterprise/wms/bin", b, admin, {
      "Idempotency-Key": key,
    });
  assert.equal(first.id, again.id);
  assert.equal(
    (await ok("/api/enterprise/wms", undefined, admin)).bins.length,
    1,
  );
  assert.equal(
    (await call("/api/enterprise/wms", undefined, logins.viewer)).status,
    403,
  );
  await ok(
    "/api/companies",
    { slug: "other-company", name: "另一帳套", username: "admin", password },
    admin,
  );
  assert.equal(
    (
      await call("/api/enterprise/wms", undefined, {
        ...admin,
        company: "other-company",
      })
    ).status,
    401,
  );
  const login = await call(
      "/api/login",
      { username: "admin", password },
      { company: "other-company" },
    ),
    other = {
      cookie: login.cookie,
      csrf: login.data.csrf,
      company: "other-company",
    };
  assert.equal(
    (await ok("/api/enterprise/wms", undefined, other)).bins.length,
    0,
  );
  assert.equal(
    (await ok("/api/enterprise/fx", undefined, other)).rates.length,
    0,
  );
  assert.equal(
    (await ok("/api/enterprise/wms", undefined, admin)).bins.length,
    1,
  );
  assert.equal((await ok("/api/integrity", undefined, other)).ok, true);
});
