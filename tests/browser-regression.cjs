const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { readFileSync, writeFileSync } = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
let browser;
(async () => {
  const base = process.env.ERP_BROWSER_BASE_URL || "http://127.0.0.1:4366";
  assert.equal((await (await fetch(base + "/api/status")).json()).demo, true);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.ERP_CHROMIUM_PATH
      ? { executablePath: process.env.ERP_CHROMIUM_PATH }
      : {}),
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1440, height: 1000 },
    }),
    page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.getByRole("button", { name: "進入示範工作空間" }).click();
  await page.locator(".sidebar").waitFor();
  const modals = [
    "quote",
    "purchase",
    "product",
    "partner",
    "loan",
    "journal",
    "user",
    "activity",
    "bom",
    "stock",
    "category",
    "custom-field",
    "preferences",
    "history",
    "matrix",
    "settlement",
  ];
  let checked = 0;
  const bad = [];
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 950 });
    for (const key of modals) {
      await page.evaluate(async (key) => {
        closeModal();
        if (["quote", "purchase"].includes(key)) newDoc(key);
        else if (key === "product") productForm("");
        else if (key === "partner") partnerForm("");
        else if (key === "loan") loanForm();
        else if (key === "journal") journalForm();
        else if (key === "user") userForm("");
        else if (key === "activity") activityForm(1);
        else if (key === "bom") bomForm("");
        else if (key === "stock") await completionForm("stock-document");
        else await completionForm(key);
      }, key);
      await page.locator(".modal").waitFor();
      // Empty controls and long filled values. Horizontally scrollable line tables are intentional.
      for (const state of ["blank", "filled"]) {
        if (state === "filled")
          await page
            .locator('.modal input[type="text"],.modal textarea')
            .evaluateAll((els) =>
              els.forEach((el) => {
                el.value = "長文字輸入驗證 / UTF-8 / " + "內容".repeat(25);
                el.dispatchEvent(new Event("input", { bubbles: true }));
              }),
            );
        const issues = await page.evaluate(() => {
          const modal = document.querySelector(".modal"),
            body = document.querySelector(".modal-body");
          const grid = [
            ...document.querySelectorAll(".modal .form-grid>.field"),
          ].filter((el) => {
            const a = el.getBoundingClientRect(),
              p = el.parentElement.getBoundingClientRect();
            return a.right > p.right + 2 || a.left < p.left - 2;
          }).length;
          return {
            modal: modal.scrollWidth > modal.clientWidth + 2,
            body: body.scrollWidth > body.clientWidth + 2,
            grid,
          };
        });
        if (issues.modal || issues.body || issues.grid)
          bad.push({ width, key, state, ...issues });
        checked++;
      }
    }
  }
  await page.evaluate(() => closeModal());
  if (process.env.ERP_BROWSER_OUTPUT)
    writeFileSync(
      process.env.ERP_BROWSER_OUTPUT + "/modal-layout.json",
      JSON.stringify(bad, null, 2),
    );
  assert.deepEqual(bad, []);
  console.log(
    "PASS " + checked + " empty/filled modal layouts, including narrow screens",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  const slug = "regression-" + Date.now(),
    password = "isolated-browser-test-2026";
  await page.evaluate(
    async ({ slug, password }) => {
      await api("/api/companies", {
        slug,
        name: "隔離回歸帳套",
        username: "admin",
        password,
      });
      S.companies = await api("/api/companies");
      await workflowSwitchCompany(slug);
      const login = await api("/api/login", { username: "admin", password });
      S.csrf = login.csrf;
      await refresh();
      await api("/api/partners", { code: "BRANCH-ONLY", name: "只在目前帳套" });
      const product = await api("/api/products", {
        sku: "BRANCH-ONLY",
        name: "隔離商品",
      });
      await api("/api/product-images", {
        product_id: product.id,
        base64:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGvsAAAAASUVORK5CYII=",
      });
      await refresh();
      navigate("operations", "images");
    },
    { slug, password },
  );
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".info-card img")].some(
      (i) => i.complete && i.naturalWidth,
    ),
  );
  const img = await page
    .locator(".info-card img")
    .first()
    .evaluate((i) => i.dataset.demoImage || i.getAttribute("src"));
  assert.equal(new URL(img, base).searchParams.get("company"), slug);
  console.log(
    "PASS selected-company product image URL and authenticated image loading",
  );
  await page.evaluate(() => navigate("products"));
  let pending = page.waitForEvent("download");
  await page.locator('[data-action="export"][data-id="products"]').click();
  let download = await pending;
  const csv = readFileSync(await download.path(), "utf8");
  assert.match(csv, /BRANCH-ONLY/);
  assert.doesNotMatch(csv, /PD-001/);
  console.log(
    "PASS CSV download stays in selected company while root session also exists",
  );
  await page.evaluate(() => navigate("system"));
  pending = page.waitForEvent("download");
  await page.locator('[data-action="backup"]').click();
  download = await pending;
  const db = new DatabaseSync(await download.path(), { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) n FROM products").get().n, 1);
    assert.equal(
      db.prepare("SELECT sku FROM products").get().sku,
      "BRANCH-ONLY",
    );
  } finally {
    db.close();
  }
  console.log("PASS downloaded backup belongs to selected company");
  await page.evaluate(async () => {
    await workflowSwitchCompany("default");
  });
  await page.locator(".sidebar").waitFor();
  assert.ok(
    await page.evaluate(() => S.data.products.some((p) => p.sku === "PD-001")),
  );
  assert.equal(
    await page.evaluate(() =>
      S.data.products.some((p) => p.sku === "BRANCH-ONLY"),
    ),
    false,
  );
  assert.deepEqual(errors, []);
  console.log("PASS root company unchanged; no JavaScript errors");
  await browser.close();
})().catch(async (e) => {
  await browser?.close();
  console.error(e);
  process.exitCode = 1;
});
