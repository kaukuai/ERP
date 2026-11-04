import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../src/application.mjs";
import { formModel as M } from "../src/forms.mjs";

test("forms HTTP: CSRF, idempotency, versioning, safe preview, history, export, print and company isolation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "erp-forms-http-")),
    app = createApplication({ dbPath: join(dir, "demo.sqlite"), demo: true }),
    server = http.createServer(app.handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function call(path, b, auth, company = "default", extra = {}) {
    const r = await fetch(base + path, {
      method: b === undefined ? "GET" : "POST",
      headers: {
        "X-ERP-Company": company,
        ...(b === undefined
          ? {}
          : {
              "Content-Type": "application/json",
              "X-ERP-Request": "1",
              "X-CSRF-Token": auth?.csrf || "",
              "Idempotency-Key": crypto.randomUUID(),
              Origin: base,
            }),
        ...(auth ? { Cookie: auth.cookie } : {}),
        ...extra,
      },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    const text = await r.text();
    return {
      status: r.status,
      data: r.headers.get("Content-Type")?.includes("application/json")
        ? JSON.parse(text)
        : text,
      cookie: r.headers.get("Set-Cookie")?.split(";")[0],
    };
  }
  const login = await call("/api/demo", {}),
    a = { cookie: login.cookie, csrf: login.data.csrf };
  const body = { name: "HTTP 日報", definition: M.validate(M.starter()) },
    key = crypto.randomUUID();
  assert.equal(
    (
      await call("/api/form-templates", body, a, "default", {
        "X-CSRF-Token": "invalid",
      })
    ).status,
    403,
  );
  const first = await call("/api/form-templates", body, a, "default", {
    "Idempotency-Key": key,
  });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual(
    (
      await call("/api/form-templates", body, a, "default", {
        "Idempotency-Key": key,
      })
    ).data,
    first.data,
  );
  const tid = first.data.id;
  assert.equal(
    (await call("/api/form-templates", { ...body, id: tid, version: 5 }, a))
      .status,
    409,
  );
  assert.equal(
    (
      await call(
        "/api/form-preview",
        {
          ...body,
          definition: {
            ...body.definition,
            blocks: [
              {
                type: "image",
                id: "unsafe",
                src: "data:image/svg+xml;base64,abc=",
              },
            ],
          },
        },
        a,
      )
    ).status,
    400,
  );
  const preview = await call("/api/form-preview", body, a);
  assert.equal(preview.status, 200);
  assert.match(preview.data.html, /版型預覽/);
  const entry = await call(
    "/api/form-entries",
    {
      template_id: tid,
      template_version: 1,
      title: "範例",
      values: { date: "2026-11-03", name: "測試填表者" },
    },
    a,
  );
  assert.equal(entry.status, 200, JSON.stringify(entry.data));
  const eid = entry.data.id;
  assert.equal(
    (await call("/api/form-entries/" + eid + "/submit", { version: 1 }, a))
      .status,
    200,
  );
  assert.equal(
    (
      await call(
        "/api/form-entries",
        { id: eid, version: 2, title: "不可覆寫", values: {} },
        a,
      )
    ).status,
    409,
  );
  const history = await call(
    "/api/form-entries/" + eid + "/history",
    undefined,
    a,
  );
  assert.deepEqual(
    history.data.events.map((e) => e.action),
    ["save", "submit"],
  );
  const exp = await call(
    "/api/form-templates/" + tid + "/export",
    undefined,
    a,
  );
  assert.equal(exp.data.format, "erp-form-template");
  assert.equal("created_by" in exp.data, false);
  const print = await call("/print/form-entries/" + eid, undefined, a);
  assert.equal(print.status, 200);
  assert.match(print.data, /測試填表者/);
  assert.equal((await call("/print/form-entries/" + eid)).status, 401);
  assert.equal(
    (
      await call(
        "/api/companies",
        {
          slug: "separate",
          name: "隔離測試帳套",
          username: "admin",
          password: "forms-http-isolation-2026",
        },
        a,
      )
    ).status,
    200,
  );
  const branchLogin = await call(
      "/api/login",
      { username: "admin", password: "forms-http-isolation-2026" },
      null,
      "separate",
    ),
    branch = { cookie: branchLogin.cookie, csrf: branchLogin.data.csrf };
  const isolated = await call("/api/forms", undefined, branch, "separate");
  assert.deepEqual(isolated.data.form_templates, []);
  assert.deepEqual(isolated.data.form_entries, []);
  assert.equal(
    (await call("/api/form-entries/" + eid, undefined, branch, "separate"))
      .status,
    404,
  );
  assert.equal(
    (
      await call(
        "/print/form-entries/" + eid + "?company=separate",
        undefined,
        a,
        "separate",
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await call("/api/form-templates", body, branch, "separate", {
        "X-CSRF-Token": a.csrf,
      })
    ).status,
    403,
  );
  assert.equal((await call("/api/integrity", undefined, a)).data.ok, true);
  // A transaction-type template is layout metadata, not a transaction with the same id.
  const bound = await call(
    "/api/form-templates",
    {
      name: "報價版型非單據",
      definition: M.validate(M.starter("quote")),
    },
    a,
  );
  assert.equal(bound.status, 200);
  assert.equal(bound.data.name, "報價版型非單據");
  assert.equal(bound.data.definition.kind, "quote");
  assert.equal(bound.data.definition.page.margin, 12);
  await call(
    "/api/users",
    {
      username: "form-editor",
      name: "受限編輯",
      role: "viewer",
      password: "http-form-editor-test-2026",
    },
    a,
  );
  const user = (await call("/api/access/admin", undefined, a)).data.users.find(
    (u) => u.username === "form-editor",
  );
  await call(
    "/api/access/profiles",
    {
      user_id: user.id,
      version: 0,
      inherit_base: false,
      rules: [
        ["form_templates", "read"],
        ["form_templates", "update"],
        ["form_entries", "read"],
      ].map(([resource, action]) => ({
        resource,
        action,
        effect: "allow",
        scope: "all",
      })),
    },
    a,
  );
  const editorLogin = await call("/api/login", {
    username: "form-editor",
    password: "http-form-editor-test-2026",
  });
  const editor = { cookie: editorLogin.cookie, csrf: editorLogin.data.csrf };
  const opened = await call(
    "/api/form-templates/" + bound.data.id,
    undefined,
    editor,
  );
  assert.equal(opened.status, 200);
  assert.equal(
    opened.data.definition.page.margin,
    12,
    "page margin must not be removed as financial margin",
  );
  const revised = await call(
    "/api/form-templates",
    { ...opened.data, name: "已修改版型" },
    editor,
  );
  assert.equal(revised.status, 200, JSON.stringify(revised.data));
  assert.equal(revised.data.version, 2);
  assert.equal(revised.data.definition.page.margin, 12);
  assert.equal((await call("/api/form-templates", body, editor)).status, 403);
  assert.equal(
    (await call("/api/form-entries/" + eid, undefined, editor)).data.definition
      .page.margin,
    12,
  );
});
