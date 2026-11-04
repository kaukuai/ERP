const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
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
  page.setDefaultTimeout(20000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.ERP_BROWSER_BASE_URL || "http://127.0.0.1:4366");
  await page.getByRole("button", { name: "進入示範工作空間" }).click();
  await page.locator('[data-page="enterprise"]').waitFor();
  async function tab(name) {
    if (await page.evaluate(() => S.page !== "enterprise"))
      await page.locator('[data-page="enterprise"]').click();
    await page.locator('[data-tab="' + name + '"]').click();
    await page.waitForFunction(
      (name) => EN.cache[name] && !EN.pending[name],
      name,
    );
    assert.equal(
      await page.evaluate((name) => EN.cache[name].error || "", name),
      "",
    );
  }
  async function command(domain, op, id = "") {
    await page
      .locator(
        '[data-action="ent-command"][data-id="' +
          domain +
          "|" +
          op +
          "|" +
          id +
          '"]',
      )
      .click();
    await page
      .locator("#modal-form")
      .waitFor()
      .catch(async (e) => {
        console.error(
          "COMMAND FAILED",
          domain,
          op,
          await page.locator("#toast").textContent(),
        );
        throw e;
      });
  }
  async function fill(values) {
    for (const [key, v] of Object.entries(values)) {
      const loc = page.locator('#modal-form [name="' + key + '"]');
      if (await loc.evaluate((e) => e.tagName === "SELECT"))
        await loc.selectOption(String(v));
      else await loc.fill(String(v));
    }
  }
  async function save() {
    await page.getByRole("button", { name: "儲存／執行", exact: true }).click();
    await page.waitForFunction(
      () =>
        !document.querySelector("#modal-form") ||
        document.querySelector("#form-error")?.textContent,
    );
    const err = (await page.locator("#form-error").count())
      ? await page.locator("#form-error").textContent()
      : "";
    assert.equal(err, "");
    await page.waitForFunction(() => !Object.values(EN.pending).some(Boolean));
  }
  await tab("wms");
  console.log("STEP wms loaded");
  await command("wms", "enable");
  await fill({ warehouse_id: 1 });
  await save();
  await command("wms", "bin");
  await fill({
    warehouse_id: 1,
    code: "WEB-PICK",
    name: "瀏覽器揀貨位",
    kind: "pick",
  });
  await save();
  const positions = await page.evaluate(() => ({
    from: EN.cache.wms.bins.find((b) => b.kind === "receiving").id,
    to: EN.cache.wms.bins.find((b) => b.code === "WEB-PICK").id,
  }));
  await command("wms", "transfer");
  await fill({
    from_bin_id: positions.from,
    to_bin_id: positions.to,
    product_id: 1,
    qty: "10",
    reason: "瀏覽器上架",
  });
  await save();
  const order = await page.evaluate(async () => {
    let d = await api("/api/documents", {
      kind: "order",
      partner_id: S.data.partners.find((p) => p.kind === "customer").id,
      warehouse_id: 1,
      lines: [{ product_id: 1, qty: "2", price: "10" }],
    });
    d = await api("/api/documents/" + d.id + "/submit", { version: d.version });
    d = await api("/api/documents/" + d.id + "/approve", {
      version: d.version,
    });
    await refresh();
    return d.id;
  });
  await command("wms", "wave");
  await fill({ warehouse_id: 1, notes: "瀏覽器波次" });
  await page.locator('[data-ent-selected][value="' + order + '"]').check();
  await save();
  const wave = await page.evaluate(() => EN.cache.wms.waves[0].id);
  await page
    .locator('[data-action="ent-open"][data-id="wms|' + wave + '"]')
    .click();
  await command("wms", "post", wave);
  await save();
  assert.equal(
    await page.evaluate(() => EN.cache.wms.waves[0].status),
    "posted",
  );
  console.log(
    "PASS actual bin setup, putaway, wave allocation and shipment UI",
  );
  await tab("fx");
  await command("fx", "rate");
  await fill({ currency: "USD", rate: "30", source: "瀏覽器測試報價" });
  await save();
  await command("fx", "create");
  const customer = await page.evaluate(
    () => S.data.partners.find((p) => p.kind === "customer").id,
  );
  await fill({
    partner_id: customer,
    currency: "USD",
    r_0_account: "4000",
    r_0_description: "瀏覽器服務",
    r_0_amount: "100",
  });
  await save();
  let fx = await page.evaluate(() => EN.cache.fx.accounts[0].id);
  await page
    .locator('[data-action="ent-open"][data-id="fx|' + fx + '"]')
    .click();
  await command("fx", "post", fx);
  await save();
  await page
    .locator('[data-action="ent-open"][data-id="fx|' + fx + '"]')
    .click();
  await command("fx", "settle", fx);
  const bank = await page.evaluate(() => EN.cache.fx.banks[0].id);
  await fill({ amount: "100", bank_account_id: bank });
  await save();
  assert.equal(
    await page.evaluate(() => EN.cache.fx.accounts[0].status),
    "settled",
  );
  console.log("PASS original/base currency invoice and real settlement UI");
  await tab("delivery");
  const setup = await page.evaluate(async () => {
    const preset = ERPFormModel.presets().find(
      (p) => p.definition.kind === "order",
    );
    const t = await api("/api/form-templates", {
      name: "展示寄送版型",
      definition: preset.definition,
    });
    await refresh();
    return {
      template: t.id,
      customer: S.data.partners.find((p) => p.kind === "customer").id,
    };
  });
  await command("delivery", "defaults");
  await fill({
    kind: "order",
    partner_id: setup.customer,
    locale: "zh-TW",
    template_id: setup.template,
  });
  await save();
  await command("delivery", "queue");
  await fill({
    document_id: order,
    recipient: "viewer@example.com",
    subject: "訂單展示寄送",
    text: "請查收",
  });
  await save();
  assert.equal(
    await page.evaluate(() => EN.cache.delivery.outbox[0].status),
    "demo",
  );
  console.log("PASS customer/language default and safe demo email queue UI");
  await tab("hr");
  await command("hr", "configure");
  await fill({
    effective_date: "2026-01-01",
    source: "瀏覽器虛構規則，正式使用需另核定",
    forbid_self_approval: "false",
    confirm_rules: "true",
  });
  await save();
  await page.evaluate(async () => {
    await api("/api/employees", {
      code: "WEB-HR",
      name: "薪資測試員工",
      joined_date: "2026-01-01",
      user_id: S.data.user.id,
    });
    delete EN.cache.hr;
    await enLoad("hr");
  });
  await command("hr", "terms");
  const emp = await page.evaluate(
    () => EN.cache.hr.employees.find((e) => e.code === "WEB-HR").id,
  );
  await fill({
    employee_id: emp,
    effective_date: "2026-01-01",
    amount: "45000",
    labor_base: "45000",
    health_base: "45000",
    pension_base: "45000",
    tax_exempt: "0",
  });
  await save();
  await command("hr", "compute");
  await fill({ notes: "瀏覽器核對薪資試算" });
  await save();
  const payroll = await page.evaluate(() => EN.cache.hr.runs[0].id);
  await page
    .locator('[data-action="ent-open"][data-id="hr|' + payroll + '"]')
    .click();
  await command("hr", "approve", payroll);
  await fill({ reason: "瀏覽器核對" });
  await save();
  await page
    .locator('[data-action="ent-open"][data-id="hr|' + payroll + '"]')
    .click();
  await command("hr", "post", payroll);
  await fill({ reason: "瀏覽器提列" });
  await save();
  assert.equal(await page.evaluate(() => EN.cache.hr.runs[0].status), "posted");
  console.log(
    "PASS Taiwan rule confirmation, employment terms, payroll approval and GL posting UI",
  );
  await page
    .locator('[data-action="ent-open"][data-id="hr|' + payroll + '"]')
    .click();
  const printEvent = page.waitForEvent("popup");
  await page.locator('a[href*="/print/payroll/"]').first().click();
  const printPage = await printEvent;
  await printPage.getByRole("heading", { name: /薪資明細/ }).waitFor();
  assert.match(await printPage.locator("body").innerText(), /薪資測試員工/);
  if (process.env.ERP_BROWSER_OUTPUT) {
    fs.mkdirSync(process.env.ERP_BROWSER_OUTPUT, { recursive: true });
    await printPage.pdf({
      path: path.join(process.env.ERP_BROWSER_OUTPUT, "payroll-payslip.pdf"),
      format: "A4",
    });
  }
  await printPage.close();
  await page.locator('[data-action="close"]').first().click();
  console.log("PASS actual saved payroll print link and PDF");

  await tab("production");
  const fg = await page.evaluate(async () => {
    const p = await api("/api/products", {
      sku: "WEB-MFG",
      name: "瀏覽器製成品",
      unit: "個",
    });
    await refresh();
    return p.id;
  });
  await command("production", "bom");
  await fill({
    product_id: fg,
    name: "瀏覽器材料表",
    r_0_product_id: 1,
    r_0_qty: "1",
  });
  await save();
  await command("production", "center");
  await fill({
    code: "WEB-CENTER",
    name: "瀏覽器工作中心",
    daily_minutes: "480",
    hourly_cost: "60",
  });
  await save();
  const center = await page.evaluate(() => EN.cache.production.centers[0].id);
  await command("production", "route");
  await fill({
    product_id: fg,
    name: "瀏覽器路線",
    r_0_name: "加工",
    r_0_center_id: center,
    r_0_setup_minutes: "0",
    r_0_minutes_per_unit: "10",
  });
  await save();
  await command("production", "create");
  const due = await page.evaluate(() =>
    new Date(Date.parse(S.data.today + "T00:00Z") + 14 * 86400000)
      .toISOString()
      .slice(0, 10),
  );
  await fill({ product_id: fg, warehouse_id: 1, qty: "1", due_date: due });
  await save();
  let job = await page.evaluate(() => EN.cache.production.jobs[0].id);
  await page
    .locator('[data-action="ent-open"][data-id="production|' + job + '"]')
    .click();
  await command("production", "release", job);
  await save();
  await page
    .locator('[data-action="ent-open"][data-id="production|' + job + '"]')
    .click();
  await command("production", "issue", job);
  let ids = await page.evaluate(() => ({
    material: EN.entity.materials[0].id,
    operation: EN.entity.operations[0].id,
  }));
  await fill({ material_id: ids.material, qty: "1" });
  await save();
  await page
    .locator('[data-action="ent-open"][data-id="production|' + job + '"]')
    .click();
  await command("production", "complete", job);
  await fill({ operation_id: ids.operation, actual_minutes: "10" });
  await save();
  await page
    .locator('[data-action="ent-open"][data-id="production|' + job + '"]')
    .click();
  await command("production", "finish", job);
  await save();
  assert.equal(
    await page.evaluate(() => EN.cache.production.jobs[0].status),
    "completed",
  );
  console.log(
    "PASS BOM, finite capacity, material issue, operation and finished stock UI",
  );
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const name of ["wms", "fx", "delivery", "hr", "production"]) {
      await tab(name);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth + 1,
        ),
        false,
        name + " page overflow at " + width,
      );
    }
    await command("production", "route");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      ),
      false,
      "route form overflow",
    );
    const crossed = await page
      .locator("#ent-rows input,#ent-rows select,#ent-rows textarea")
      .evaluateAll((els) =>
        els.filter((el) => {
          const a = el.getBoundingClientRect(),
            b = el.closest("td").getBoundingClientRect();
          return a.left < b.left - 1 || a.right > b.right + 1;
        }),
      );
    assert.equal(crossed.length, 0, "row control crossed its cell at " + width);
    if (width === 1440 && process.env.ERP_BROWSER_OUTPUT)
      await page.screenshot({
        path: path.join(
          process.env.ERP_BROWSER_OUTPUT,
          "production-route-editor.png",
        ),
        fullPage: true,
      });
    assert.deepEqual(
      await page
        .locator("#modal-root [id]")
        .evaluateAll((els) =>
          els.map((e) => e.id).filter((v, i, a) => a.indexOf(v) !== i),
        ),
      [],
    );
    await page.locator('[data-action="close"]').first().click();
  }
  assert.equal(
    await page.evaluate(async () => (await api("/api/integrity")).ok),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS all five module tabs and row editors at four widths, ledger integrity and zero JS errors",
  );
  await browser.close();
})().catch(async (e) => {
  console.error(e);
  if (browser) await browser.close();
  process.exitCode = 1;
});
