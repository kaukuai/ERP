import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "../src/application.mjs";
import { formModel as M } from "../src/forms.mjs";
import { today } from "../src/core.mjs";
test("policy HTTP routes preserve authentication, CSRF, idempotency, per-company configuration and grant revocation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "erp-policy-http-"));
  const app = createApplication({
      demo: true,
      dbPath: join(dir, "root.sqlite"),
    }),
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
    const response = await fetch(base + path, {
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
    const text = await response.text();
    return {
      status: response.status,
      data: response.headers.get("Content-Type")?.includes("json")
        ? JSON.parse(text)
        : text,
      cookie: response.headers.get("Set-Cookie")?.split(";")[0],
    };
  }
  const login = await call("/api/demo", {});
  let admin = { cookie: login.cookie, csrf: login.data.csrf };
  assert.equal((await call("/governance-ui.js")).status, 200);
  const periods = { version: 0, trade: 30, inventory: "", finance: "" },
    key = crypto.randomUUID();
  assert.equal(
    (
      await call("/api/governance/periods", periods, admin, {
        "X-CSRF-Token": "wrong",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/api/governance/periods", periods, admin, {
        "Idempotency-Key": key,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call("/api/governance/periods", periods, admin, {
        "Idempotency-Key": key,
      })
    ).data.version,
    1,
  );
  await call(
    "/api/users",
    {
      username: "restricted-gov",
      name: "受限帳號",
      role: "viewer",
      password: "governance-http-fixture-2026",
    },
    admin,
  );
  const uid = (
    await call("/api/access/admin", undefined, admin)
  ).data.users.find((u) => u.username === "restricted-gov").id;
  const limitedLogin = await call("/api/login", {
      username: "restricted-gov",
      password: "governance-http-fixture-2026",
    }),
    limited = { cookie: limitedLogin.cookie, csrf: limitedLogin.data.csrf };
  assert.equal(
    (await call("/api/governance/rules", { name: "拒絕設定" }, limited)).status,
    403,
  );
  assert.equal(
    (await call("/api/bootstrap", undefined, limited)).data.governance,
    undefined,
  );
  const tpl = (
    await call(
      "/api/form-templates",
      { name: "版型授權", definition: M.validate(M.starter()) },
      admin,
    )
  ).data;
  assert.equal(
    (await call("/api/form-templates/" + tpl.id, undefined, limited)).status,
    200,
  );
  const grant = await call(
    "/api/governance/grants",
    {
      kind: "form",
      format_id: tpl.id,
      version: 0,
      grants: [{ user_id: uid, action: "read", effect: "deny" }],
    },
    admin,
  );
  assert.equal(grant.status, 200, JSON.stringify(grant.data));
  assert.equal((await call("/api/bootstrap", undefined, limited)).status, 401);
  const again = await call("/api/login", {
    username: "restricted-gov",
    password: "governance-http-fixture-2026",
  });
  const limited2 = { cookie: again.cookie, csrf: again.data.csrf };
  assert.equal(
    (await call("/api/form-templates/" + tpl.id, undefined, limited2)).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/api/form-templates/" + tpl.id + "/export",
        undefined,
        limited2,
      )
    ).status,
    403,
  );
  assert.equal(
    (await call("/api/bootstrap", undefined, limited2)).data.form_templates
      .length,
    0,
  );
  const relogin = await call("/api/demo", {});
  admin = { cookie: relogin.cookie, csrf: relogin.data.csrf };
  const bill = await call(
    "/api/documents",
    {
      kind: "quote",
      partner_id: 1,
      warehouse_id: 1,
      lines: [{ product_id: 1, qty: "1", price: "100" }],
    },
    admin,
  );
  const rule = await call(
    "/api/governance/rules",
    {
      name: "指定完整管理員",
      kind: "quote",
      min_amount: 0,
      forbid_owner: false,
      distinct_actors: true,
      stages: [{ name: "核准", source: "users", mode: "any", user_ids: [1] }],
    },
    admin,
  );
  assert.equal(rule.status, 200, JSON.stringify(rule.data));
  const pending = await call(
    "/api/documents/" + bill.data.id + "/submit",
    { version: bill.data.version },
    admin,
  );
  assert.equal(pending.status, 200);
  const bootstrap = await call("/api/bootstrap", undefined, admin),
    request = bootstrap.data.approval_requests.find(
      (r) => r.document_id === bill.data.id,
    );
  const hidden = await call(
    "/api/governance/requests/" + request.id,
    undefined,
    limited2,
  );
  assert.equal(hidden.status, 200); // legacy viewer may read quotes, but cannot approve
  assert.equal(
    (
      await call(
        "/api/documents/" + bill.data.id + "/approve",
        { version: pending.data.version },
        limited2,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/api/documents/" + bill.data.id + "/approve",
        { version: pending.data.version },
        admin,
      )
    ).data.status,
    "approved",
  );
  const company = await call(
    "/api/companies",
    {
      slug: "policy-isolation",
      name: "政策隔離",
      username: "admin",
      password: "policy-isolation-test-2026",
    },
    admin,
  );
  assert.equal(company.status, 200, JSON.stringify(company.data));
  const branchLogin = await call(
    "/api/login",
    { username: "admin", password: "policy-isolation-test-2026" },
    undefined,
    { "X-ERP-Company": "policy-isolation" },
  );
  const branch = { cookie: branchLogin.cookie, csrf: branchLogin.data.csrf };
  const branchData = await call("/api/bootstrap", undefined, branch, {
    "X-ERP-Company": "policy-isolation",
  });
  assert.equal(branchData.status, 200);
  assert.deepEqual(branchData.data.governance.rules, []);
  assert.deepEqual(branchData.data.governance.grants, []);
  assert.equal(branchData.data.governance.periods.trade, null);
  assert.equal(
    (
      await call("/api/governance/requests/" + request.id, undefined, branch, {
        "X-ERP-Company": "policy-isolation",
      })
    ).status,
    404,
  );
});
