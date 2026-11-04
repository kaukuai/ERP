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
  const base = process.env.ERP_BROWSER_BASE_URL || "http://127.0.0.1:4366",
    status = await (await fetch(base + "/api/status")).json();
  assert.equal(status.demo, true);
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.getByRole("button", { name: "進入示範工作空間" }).click();
  await page.locator('[data-page="forms"]').click();
  await page.locator('[data-action="form-new"]').click();
  await page
    .locator('[data-action="form-preset"][data-id="daily_work"]')
    .click();
  await page.locator("#fd-preview").waitFor();
  await page
    .locator('.fd-settings [data-fd-prop="name"]')
    .fill("瀏覽器工作報告 " + Date.now());
  await page.locator('[data-action="form-add"][data-id="text"]').click();
  await page
    .locator('[data-fd-block] [data-fd-prop="text"]')
    .fill("長文字欄位排版測試 <b>不可執行</b>");
  await page.locator('[data-action="form-up"]').click();
  await page.locator('[data-action="form-save"]').click();
  await page.waitForFunction(() => FD.template.id && !FD.dirty);
  const templateId = await page.evaluate(() => FD.template.id);
  assert.ok(templateId);
  console.log(
    "PASS visual editor creates, reorders, previews and saves a template",
  );
  await page.locator('[data-action="form-list"]').click();
  await page
    .locator(`[data-action="form-fill"][data-id="${templateId}"]`)
    .click();
  await page.locator('[data-form-value="date"]').fill("2026-11-03");
  await page.locator('[data-form-value="name"]').fill("測試填寫人");
  await page.locator('[data-action="form-entry-row-add"]').click();
  await page
    .locator('[data-form-value="items:0:content"]')
    .fill("多行紀錄\n中文與長網址 https://example.test/" + "a".repeat(100));
  await page.locator('[data-action="form-entry-save"]').click();
  await page.waitForFunction(() => FD.entry.id && !FD.dirty);
  const entryId = await page.evaluate(() => FD.entry.id);
  await page.locator('[data-action="form-entry-submit"]').click();
  await page.waitForFunction(() => FD.entry.status === "submitted");
  await page
    .locator('[data-action="form-entry-save"]')
    .waitFor({ state: "hidden" });
  console.log("PASS entry fields, table rows, saved state and submission lock");
  const opened = page.waitForEvent("popup");
  await page
    .locator(`a[href*="/print/form-entries/${entryId}"]`)
    .first()
    .click();
  const printPage = await opened;
  await printPage.locator(".ff-sheet").waitFor();
  assert.ok(
    (await printPage.locator(".ff-sheet").innerText()).includes("測試填寫人"),
  );
  // Long row content must wrap within the paper. Print from actual server output, not a screenshot-only mock.
  let overflow = await printPage.evaluate(() =>
    [...document.querySelectorAll(".ff-block,.ff-table td")]
      .filter((el) => el.scrollWidth > el.clientWidth + 2)
      .map((el) => el.className),
  );
  assert.deepEqual(overflow, []);
  const output = process.env.ERP_BROWSER_OUTPUT;
  if (output) {
    fs.mkdirSync(output, { recursive: true });
    await printPage.pdf({
      path: output + "/filled-form.pdf",
      preferCSSPageSize: true,
      printBackground: true,
    });
    await printPage.screenshot({
      path: output + "/filled-form.png",
      fullPage: true,
    });
  }
  await printPage.close();
  console.log("PASS saved form print wraps long values and generates PDF");
  // Every original navigation screen at desktop, notebook, tablet and phone widths.
  const nav = await page
    .locator("[data-page]")
    .evaluateAll((els) => [...new Set(els.map((el) => el.dataset.page))]);
  const layout = [];
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 950 });
    for (const key of nav) {
      await page.evaluate((key) => navigate(key), key);
      await page.waitForTimeout(20);
      const r = await page.evaluate(() => ({
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
        invalid: [
          ...document.querySelectorAll(
            "input:not([type=hidden]),select,textarea",
          ),
        ].filter(
          (el) =>
            el.getBoundingClientRect().width < 20 && el.getClientRects().length,
        ).length,
      }));
      if (r.scroll > width + 2) layout.push({ width, key, ...r });
    }
  }
  if (output)
    fs.writeFileSync(
      output + "/screen-layout.json",
      JSON.stringify(layout, null, 2),
    );
  assert.deepEqual(layout, [], "Unexpected page-level horizontal overflow");
  console.log(
    "PASS all navigation pages at four viewport sizes without page overflow",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(async () => {
    navigate("forms");
    await formsAction("form-list");
  });
  await page
    .locator(`[data-action="form-edit"][data-id="${templateId}"]`)
    .click();
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 2,
      ),
    );
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  if (output)
    await page.screenshot({ path: output + "/designer.png", fullPage: true });
  console.log("PASS responsive form designer and controls");
  const multi = await page.evaluate(async (templateId) => {
    const tpl = await api("/api/form-templates/" + templateId);
    return api("/api/form-entries", {
      template_id: tpl.id,
      template_version: tpl.version,
      title: "多頁表格驗收",
      values: {
        date: "2026-11-03",
        name: "多頁測試",
        items: Array.from({ length: 80 }, (_, i) => ({
          period: "上午",
          content: "跨頁驗收 " + String(i + 1).padStart(3, "0"),
          conclusion: i === 79 ? "最後一列確認" : "核對完成",
        })),
      },
    });
  }, templateId);
  await page.evaluate(
    async (id) => formsAction("form-entry", String(id)),
    multi.id,
  );
  const pagesOpened = page.waitForEvent("popup");
  await page
    .locator(`a[href*="/print/form-entries/${multi.id}"]`)
    .first()
    .click();
  const multipage = await pagesOpened;
  await multipage.locator(".ff-sheet").waitFor();
  assert.ok(
    (await multipage.locator(".ff-sheet").innerText()).includes("最後一列確認"),
  );
  if (output)
    await multipage.pdf({
      path: output + "/multipage-form.pdf",
      preferCSSPageSize: true,
      printBackground: true,
    });
  await multipage.close();
  console.log("PASS 80-row saved form renders through its actual print link");

  await page.locator('[data-action="form-list"]').click();
  await page.locator('[data-action="form-new"]').click();
  await page.locator('[data-action="form-preset"][data-id="quote"]').click();
  await page.locator('[data-action="form-save"]').click();
  await page.waitForFunction(
    () => FD.template.id && FD.template.kind === "quote" && !FD.dirty,
  );
  const linked = await page.evaluate(async () => {
    const doc = S.data.documents.find((d) => d.kind === "quote");
    const templateId = FD.template.id;
    await showDoc(doc.id);
    return { templateId, id: doc.id, no: doc.no };
  });
  await page.locator('[data-action="form-doc-print"]').click();
  const boundPopup = page.waitForEvent("popup");
  await page
    .locator(`a[href*="/print/form-templates/${linked.templateId}?"]`)
    .click();
  const boundPrint = await boundPopup;
  await boundPrint.locator(".ff-sheet").waitFor();
  assert.ok(
    (await boundPrint.locator(".ff-sheet").innerText()).includes(linked.no),
  );
  assert.ok(
    (await boundPrint.locator(".ff-sheet").innerText()).includes("非統一發票"),
  );
  await boundPrint.close();
  await page.evaluate(() => closeModal());
  console.log(
    "PASS quote template saves and prints linked source through document UI",
  );

  await page.evaluate(async () => {
    const username = "forms-delegated-" + Date.now();
    const password = "forms-browser-fixture-2026";
    await api("/api/users", {
      username,
      password,
      name: "代理填表人",
      role: "viewer",
    });
    const admin = await api("/api/access/admin");
    const user = admin.users.find((u) => u.username === username);
    await api("/api/access/profiles", {
      user_id: user.id,
      version: 0,
      inherit_base: false,
      rules: [
        ["form_templates", "read"],
        ["form_templates", "update"],
        ["form_entries", "read"],
        ["form_entries", "submit"],
      ].map(([resource, action]) => ({
        resource,
        action,
        effect: "allow",
        scope: "all",
      })),
    });
    const login = await api("/api/login", { username, password });
    S.csrf = login.csrf;
    await refresh();
    navigate("forms");
  });
  assert.equal(await page.locator('[data-action="form-new"]').count(), 0);
  await page
    .locator(`[data-action="form-edit"][data-id="${templateId}"]`)
    .click();
  await page.locator("#fd-preview").waitFor();
  await page.locator('[data-action="form-save"]').click();
  await page
    .waitForFunction(() => FD.template.version > 1 && !FD.dirty)
    .catch(async (error) => {
      console.log(
        await page.evaluate(() => ({
          version: FD.template?.version,
          dirty: FD.dirty,
          mode: FD.mode,
          errors: [...document.querySelectorAll(".toast,.form-error")].map(
            (e) => e.textContent,
          ),
        })),
      );
      throw error;
    });
  await page.locator('[data-action="form-list"]').click();
  await page
    .locator(`[data-action="form-entry"][data-id="${multi.id}"]`)
    .click();
  await page.waitForFunction(
    (id) => FD.mode === "entry" && FD.entry.id === id,
    multi.id,
  );
  assert.equal(
    await page.locator('[data-action="form-entry-save"]').count(),
    0,
  );
  assert.equal(
    await page.locator(`a[href*="/print/form-entries/${multi.id}"]`).count(),
    0,
  );
  await page.locator('[data-action="form-entry-submit"]').click();
  await page.waitForFunction(() => FD.entry.status === "submitted");
  console.log(
    "PASS update-only designer and submit-only entry actions for delegated viewer",
  );

  await browser.close();
  assert.deepEqual(errors, []);
  console.log("PASS no browser JavaScript errors");
})().catch(async (e) => {
  await browser?.close();
  console.error(e);
  process.exitCode = 1;
});
