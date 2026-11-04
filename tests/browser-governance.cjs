const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
let browser;
(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.ERP_CHROMIUM_PATH
      ? { executablePath: process.env.ERP_CHROMIUM_PATH }
      : {}),
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.ERP_BROWSER_BASE_URL || "http://127.0.0.1:4366");
  await page.getByRole("button", { name: "進入示範工作空間" }).click();
  await page.locator('[data-page="governance"]').waitFor();
  const users = await page.evaluate(async () => {
    for (const name of ["first-reviewer", "last-reviewer"])
      await api("/api/users", {
        username: name,
        name,
        role: "manager",
        password: "browser-governance-2026",
      });
    await refresh();
    return S.data.governance.users;
  });
  const lead = users.find((u) => u.username === "first-reviewer"),
    finance = users.find((u) => u.username === "last-reviewer");
  await page.locator('[data-page="governance"]').click();
  await page.locator('[data-tab="rules"]').click();
  await page.locator('[data-action="gov-rule"][data-id=""]').click();
  await page.locator('#modal-form [name="name"]').fill("瀏覽器兩階簽核");
  await page.locator('[name="min_amount"]').fill("0");
  await page.locator(`[data-gov-stage="0"] input[value="${lead.id}"]`).check();
  await page.locator('[data-action="gov-stage-add"]').click();
  await page
    .locator('[data-gov-stage="1"] [name="stage_name"]')
    .fill("財務確認");
  await page
    .locator(`[data-gov-stage="1"] input[value="${finance.id}"]`)
    .check();
  await page.getByRole("button", { name: "儲存", exact: true }).click();
  await page.waitForFunction(
    () =>
      S.data.governance.rules.length === 1 &&
      !document.querySelector("#modal-form"),
  );
  console.log("PASS multi-stage rule created through actual UI controls");
  const source = await page.evaluate(async () => {
    const baseline = S.data.stocks.find(
      (s) => s.product_id === 1 && s.warehouse_id === 1,
    ).reserved;
    let d = await api("/api/documents", {
      kind: "order",
      partner_id: 1,
      warehouse_id: 1,
      lines: [{ product_id: 1, qty: "1", price: "100" }],
    });
    d = await api("/api/documents/" + d.id + "/submit", { version: d.version });
    await refresh();
    return {
      id: d.id,
      baseline,
      request: S.data.approval_requests.find((r) => r.document_id === d.id).id,
    };
  });
  for (const [username, expected] of [
    ["first-reviewer", "pending"],
    ["last-reviewer", "approved"],
  ]) {
    await page.evaluate(async (username) => {
      const login = await api("/api/login", {
        username,
        password: "browser-governance-2026",
      });
      S.csrf = login.csrf;
      await refresh();
      navigate("governance");
    }, username);
    await page
      .locator(`[data-action="gov-request"][data-id="${source.request}"]`)
      .click();
    await page.getByRole("button", { name: "確認決定", exact: true }).click();
    await page.waitForFunction(
      ({ id, expected }) =>
        S.data.documents.find((d) => d.id === id)?.status === expected &&
        !!document.querySelector("#modal-title"),
      { id: source.id, expected },
    );
    await page.waitForFunction(
      (expected) =>
        GV.request?.document.status === expected &&
        GV.request.votes.length === (expected === "pending" ? 1 : 2),
      expected,
    );
    const status = await page.evaluate(
      (id) => S.data.documents.find((d) => d.id === id).status,
      source.id,
    );
    assert.equal(status, expected);
    const reserved = await page.evaluate(
      () =>
        S.data.stocks.find((s) => s.product_id === 1 && s.warehouse_id === 1)
          .reserved,
    );
    assert.equal(
      reserved,
      source.baseline + (expected === "approved" ? 1000 : 0),
    );
    await page.evaluate(() => closeModal());
  }
  console.log(
    "PASS first stage leaves stock unchanged; final UI approval reserves exactly once",
  );
  await page.evaluate(async () => {
    const login = await api("/api/demo", {});
    S.csrf = login.csrf;
    await refresh();
    navigate("governance", "periods");
  });
  await page.locator('[data-form="gov-periods"] [name="trade"]').fill("0");
  await page.getByRole("button", { name: "儲存政策", exact: true }).click();
  await page.waitForFunction(() => S.data.governance.periods.trade === 0);
  const denied = await page.evaluate(async () => {
    try {
      await api("/api/documents", {
        kind: "quote",
        partner_id: 1,
        warehouse_id: 1,
        date: datePlus(S.data.today, -1),
        lines: [{ product_id: 1, qty: "1", price: "100" }],
      });
      return "";
    } catch (e) {
      return e.message;
    }
  });
  assert.match(denied, /補打單期限/);
  console.log(
    "PASS saved entry-window setting blocks a real backdated transaction",
  );
  const tpl = await page.evaluate(async () => {
    const r = await api("/api/form-templates", {
      name: "逐人授權測試",
      definition: ERPFormModel.validate(ERPFormModel.starter()),
    });
    await refresh();
    navigate("governance", "formats");
    return r;
  });
  await page
    .locator(`[data-action="gov-grants"][data-id="form:${tpl.id}"]`)
    .click();
  await page
    .locator('#modal-form [name="user_id"]')
    .selectOption(String(lead.id));
  await page.locator('[name="grant_read"]').selectOption("deny");
  await page
    .getByRole("button", { name: "儲存並重新登入", exact: true })
    .click();
  await page.getByRole("button", { name: "進入示範工作空間" }).waitFor();
  await page.getByRole("button", { name: "進入示範工作空間" }).click();
  await page.evaluate(async () => {
    const login = await api("/api/login", {
      username: "first-reviewer",
      password: "browser-governance-2026",
    });
    S.csrf = login.csrf;
    await refresh();
    navigate("forms");
  });
  assert.equal(
    await page
      .locator(`[data-action="form-edit"][data-id="${tpl.id}"]`)
      .count(),
    0,
  );
  assert.equal(
    await page.evaluate(async (id) => {
      try {
        await api("/api/form-templates/" + id);
        return false;
      } catch (e) {
        return e.message.includes("指定版型");
      }
    }, tpl.id),
    true,
  );
  console.log(
    "PASS per-person format denial revokes sessions, hides template and blocks direct API",
  );
  await page.evaluate(async () => {
    const login = await api("/api/demo", {});
    S.csrf = login.csrf;
    await refresh();
    navigate("governance");
  });
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 950 });
    for (const tab of [
      "requests",
      "rules",
      "delegations",
      "periods",
      "formats",
    ]) {
      await page.evaluate((tab) => navigate("governance", tab), tab);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 2,
        ),
        tab + " width " + width,
      );
    }
  }
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 950 });
    for (const [action, id] of [
      ["gov-rule", "1"],
      ["gov-delegation", ""],
      ["gov-grants", "form:" + tpl.id],
    ]) {
      await page.evaluate(
        async ({ action, id }) => governanceAction(action, id),
        { action, id },
      );
      assert.ok(
        await page
          .locator(".modal-body")
          .evaluate((el) => el.scrollWidth <= el.clientWidth + 2),
        action + " modal width " + width,
      );
      await page.evaluate(() => closeModal());
    }
  }
  if (process.env.ERP_BROWSER_OUTPUT) {
    fs.mkdirSync(process.env.ERP_BROWSER_OUTPUT, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => navigate("governance", "rules"));
    await page.screenshot({
      path: process.env.ERP_BROWSER_OUTPUT + "/governance.png",
      fullPage: true,
    });
  }
  assert.deepEqual(errors, []);
  console.log("PASS all policy tabs at four widths and no JavaScript errors");
  await browser.close();
})().catch(async (error) => {
  await browser?.close();
  console.error(error);
  process.exitCode = 1;
});
