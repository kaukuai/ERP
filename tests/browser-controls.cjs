const assert = require("node:assert/strict");
const { chromium } = require("playwright");
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
  await page.locator('[data-page="controls"]').waitFor();
  await page.evaluate(async () => {
    for (const [username, role] of [
      ["qc-inspector", "warehouse"],
      ["qc-reviewer", "manager"],
    ])
      await api("/api/users", {
        username,
        name: username,
        role,
        password: "browser-controls-2026",
      });
    await refresh();
  });
  await page.locator('[data-page="controls"]').click();
  await page.locator('[data-tab="specs"]').click();
  await page.locator('[data-action="ctl-spec"][data-id=""]').click();
  await page.locator('#modal-form [name="name"]').fill("外觀重量進貨檢驗");
  await page.locator('[name="product_id"]').selectOption("1");
  await page.locator('[name="sampling_bp"]').fill("2000");
  await page.locator('[data-action="ctl-param-add"]').click();
  await page.locator('[data-ctl-parameter="1"] [name="p_key"]').fill("weight");
  await page.locator('[data-ctl-parameter="1"] [name="p_label"]').fill("重量");
  await page.locator('[data-ctl-parameter="1"] [name="p_lower"]').fill("9");
  await page.locator('[data-ctl-parameter="1"] [name="p_upper"]').fill("11");
  assert.deepEqual(
    await page
      .locator("#modal-form [id]")
      .evaluateAll((els) =>
        els.map((e) => e.id).filter((id, i, all) => all.indexOf(id) !== i),
      ),
    [],
  );
  await page.getByRole("button", { name: "儲存", exact: true }).click();
  await page.waitForFunction(
    () =>
      S.data.quality_specs.length === 1 &&
      !document.querySelector("#modal-form"),
  );
  console.log(
    "PASS quality specification, typed parameters, sampling and unique field labels saved through UI",
  );
  const source = await page.evaluate(async () => {
    const supplier = S.data.partners.find((p) => p.kind === "supplier");
    let d = await api("/api/documents", {
      kind: "purchase",
      partner_id: supplier.id,
      warehouse_id: 1,
      lines: [{ product_id: 1, qty: "2", price: "10" }],
    });
    d = await api("/api/documents/" + d.id + "/submit", { version: d.version });
    d = await api("/api/documents/" + d.id + "/approve", {
      version: d.version,
    });
    await refresh();
    const stock = S.data.stocks.find(
      (s) => s.product_id === 1 && s.warehouse_id === 1,
    ).qty;
    await fulfilForm(d.id);
    return { id: d.id, supplier: supplier.id, baseline: stock };
  });
  await page.getByRole("button", { name: "確認入庫", exact: true }).click();
  await page.locator("#form-error").filter({ hasText: /品檢/ }).waitFor();
  assert.equal(
    await page.evaluate(
      () =>
        S.data.stocks.find((s) => s.product_id === 1 && s.warehouse_id === 1)
          .qty,
    ),
    source.baseline,
  );
  await page.evaluate(() => closeModal());
  console.log("PASS normal receipt UI cannot bypass required quality hold");
  async function login(username) {
    await page.evaluate(async (username) => {
      closeModal();
      const r = await api(
        username === "demo" ? "/api/demo" : "/api/login",
        username === "demo"
          ? {}
          : { username, password: "browser-controls-2026" },
      );
      S.csrf = r.csrf;
      await refresh();
      navigate("controls");
    }, username);
  }
  await login("qc-inspector");
  await page.locator('[data-action="ctl-qi-new"]').click();
  await page.locator('[name="document_id"]').selectOption(String(source.id));
  await page.getByRole("button", { name: "設定本批數量", exact: true }).click();
  await page.getByRole("button", { name: "建立品檢單", exact: true }).click();
  await page.waitForFunction(() => CT.inspection?.status === "draft");
  const inspection = await page.evaluate(() => ({
    id: CT.inspection.id,
    line: CT.inspection.lines[0].id,
  }));
  await page.locator(`[name="sample_${inspection.line}"]`).fill("1");
  await page
    .locator(`[name="reading_${inspection.line}_appearance"]`)
    .fill("合格");
  await page.locator(`[name="reading_${inspection.line}_weight"]`).fill("10");
  await page.locator('[data-action="ctl-qi-submit"]').click();
  await page.waitForFunction(() => CT.inspection?.status === "passed");
  assert.equal(await page.locator('[data-action="ctl-qi-approve"]').count(), 0);
  await login("qc-reviewer");
  await page
    .locator(`[data-action="ctl-qi-open"][data-id="${inspection.id}"]`)
    .click();
  await page.locator('[data-action="ctl-qi-approve"]').click();
  await page.waitForFunction(() => CT.inspection?.status === "released");
  await page.locator('[data-action="ctl-qi-post"]').click();
  await page.getByRole("button", { name: "確認入庫", exact: true }).click();
  await page.waitForFunction(
    ({ id, qty }) =>
      S.data.documents.find((d) => d.id === id)?.status === "completed" &&
      S.data.stocks.find((s) => s.product_id === 1 && s.warehouse_id === 1)
        .qty === qty,
    { id: source.id, qty: source.baseline + 2000 },
  );
  await page.evaluate(() => closeModal());
  console.log(
    "PASS separate inspector/reviewer, pass, release and actual stock/AP posting through UI",
  );
  const receipt = await page.evaluate(
    (id) => S.data.fulfilments.find((f) => f.document_id === id).id,
    source.id,
  );
  await login("demo");
  await page.locator('[data-tab="policy"]').click();
  await page.locator('[name="require_matching"]').selectOption("1");
  await page.getByRole("button", { name: "儲存核對政策", exact: true }).click();
  await page.waitForFunction(
    () => S.data.procurement_control_policy.require_matching === true,
  );
  const payment = await page.evaluate(
    async ({ supplier, receipt }) => {
      const rows = await api(
          "/api/controls/vendor-sources?" +
            new URLSearchParams({ supplier_id: String(supplier) }),
        ),
        source = rows.find((s) => s.fulfilment_id === receipt),
        bank = S.data.bank_accounts.find((b) => b.kind === "bank");
      const pay = {
        open_item_id: source.open_item_id,
        amount: "21",
        bank_account_id: bank.id,
        method: "bank",
        date: S.data.today,
      };
      try {
        await api("/api/payments", pay);
        throw Error("payment bypassed matching");
      } catch (error) {
        if (!error.message.includes("三方核對")) throw error;
      }
      return { source_id: source.id, pay };
    },
    { supplier: source.supplier, receipt },
  );
  await page.locator('[data-tab="vendor"]').click();
  await page.locator('[data-action="ctl-vendor-new"]').click();
  await page
    .locator('[name="supplier_id"]')
    .selectOption(String(source.supplier));
  await page.getByRole("button", { name: "選進貨明細", exact: true }).click();
  await page.locator('[name="invoice_ref"]').fill("BROWSER-MATCH-001");
  await page.locator('[name="total"]').fill("21");
  const rowIndex = await page.evaluate(
    (id) => CT.vendorRows.findIndex((r) => r.source.id === id),
    payment.source_id,
  );
  await page.locator(`[data-ctl-bill-select="${rowIndex}"]`).check();
  // Searching older source numbers must retain selected rows and independently entered invoice headers.
  await page.locator('[name="source_no"]').fill("NO-SUCH-SOURCE");
  await page.locator('[data-action="ctl-vendor-search"]').click();
  await page.waitForFunction(
    () =>
      CT.vendorRows.length === 1 &&
      document.querySelector('[name="invoice_ref"]').value ===
        "BROWSER-MATCH-001",
  );
  assert.equal(
    await page.locator('[data-ctl-bill-select="0"]').isChecked(),
    true,
  );
  await page.getByRole("button", { name: "儲存並核對", exact: true }).click();
  await page.waitForFunction(
    () =>
      CT.bill?.invoice_ref === "BROWSER-MATCH-001" &&
      CT.bill.match?.within_tolerance,
  );
  const bill = await page.evaluate(() => CT.bill.id);
  await login("qc-reviewer");
  await page.locator('[data-tab="vendor"]').click();
  await page
    .locator(`[data-action="ctl-vendor-open"][data-id="${bill}"]`)
    .click();
  await page.locator('[name="reason"]').fill("已核對憑證、採購及進貨");
  await page.getByRole("button", { name: "核准請款", exact: true }).click();
  await page.waitForFunction(() => CT.bill?.status === "approved");
  assert.equal(await page.evaluate(() => CT.bill.payment_valid), true);
  await page.evaluate(async (pay) => {
    await api("/api/payments", pay);
    await refresh();
    closeModal();
  }, payment.pay);
  console.log(
    "PASS payment blocked until independent invoice matching approval; source search retains edits",
  );
  await login("demo");
  const large = await page.evaluate(async () => {
    const supplier = S.data.partners.find((p) => p.kind === "supplier");
    let d = await api("/api/documents", {
      kind: "purchase",
      partner_id: supplier.id,
      warehouse_id: 1,
      lines: [{ product_id: 1, qty: "10000", price: "1" }],
    });
    d = await api("/api/documents/" + d.id + "/submit", { version: d.version });
    d = await api("/api/documents/" + d.id + "/approve", {
      version: d.version,
    });
    let q = await api("/api/controls/quality-inspections", {
      document_id: d.id,
      document_version: d.version,
    });
    q = await api("/api/controls/quality-inspections/" + q.id + "/save", {
      version: q.version,
      notes: "大抽樣量",
      lines: [
        {
          id: q.lines[0].id,
          sampled_qty: "2000",
          readings: { appearance: "合格", weight: "10" },
        },
      ],
    });
    await refresh();
    return q;
  });
  await page
    .locator(`[data-action="ctl-qi-open"][data-id="${large.id}"]`)
    .click();
  assert.equal(
    await page.locator(`[name="sample_${large.lines[0].id}"]`).inputValue(),
    "2000",
  );
  await page.evaluate(() => closeModal());
  console.log(
    "PASS numeric sample input preserves values above 999 without locale separators",
  );
  const output = process.env.ERP_BROWSER_OUTPUT;
  if (output) fs.mkdirSync(output, { recursive: true });
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 950 });
    for (const tab of ["quality", "specs", "vendor", "policy"]) {
      await page.evaluate((tab) => navigate("controls", tab), tab);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 2,
        ),
        tab + " width " + width,
      );
    }
    for (const [action, id] of [
      ["ctl-spec", "1"],
      ["ctl-qi-open", String(inspection.id)],
      ["ctl-vendor-open", String(bill)],
    ]) {
      await page.evaluate(
        async ({ action, id }) => controlsAction(action, id),
        { action, id },
      );
      assert.ok(
        await page
          .locator(".modal-body")
          .evaluate((el) => el.scrollWidth <= el.clientWidth + 2),
        action + " width " + width,
      );
      await page.evaluate(() => closeModal());
    }
  }
  if (output) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(
      async (id) => controlsAction("ctl-vendor-open", String(id)),
      bill,
    );
    await page.screenshot({ path: output + "/vendor-matching.png" });
    await page.evaluate(() => closeModal());
  }
  assert.deepEqual(errors, []);
  assert.equal(
    await page.evaluate(async () => (await api("/api/integrity")).ok),
    true,
  );
  console.log(
    "PASS quality and vendor screens/modals at four widths, integrity and no JavaScript errors",
  );
  await browser.close();
})().catch(async (error) => {
  await browser?.close();
  console.error(error);
  process.exitCode = 1;
});
