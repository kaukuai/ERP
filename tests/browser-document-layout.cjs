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
  const context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      deviceScaleFactor: 1.5,
    }),
    page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.ERP_BROWSER_BASE_URL || "http://127.0.0.1:4366");
  await page.getByRole("button", { name: "進入示範工作空間" }).click();
  await page.locator(".sidebar").waitFor();
  const problems = [];
  let checked = 0;
  async function inspect(label) {
    const issues = await page.evaluate(() => {
      const issues = [];
      const rect = (el) => el.getBoundingClientRect();
      for (const cell of document.querySelectorAll("#doc-lines td")) {
        const c = rect(cell),
          controls = [
            ...cell.querySelectorAll("input,select,button,img"),
          ].filter(
            (el) =>
              el.getClientRects().length &&
              getComputedStyle(el).display !== "none",
          );
        for (const el of controls) {
          const r = rect(el);
          if (
            r.left < c.left - 1 ||
            r.right > c.right + 1 ||
            r.top < c.top - 1 ||
            r.bottom > c.bottom + 1
          )
            issues.push({
              problem: "outside-cell",
              name: el.name || el.tagName,
              cell: {
                left: c.left,
                right: c.right,
                top: c.top,
                bottom: c.bottom,
              },
              control: {
                left: r.left,
                right: r.right,
                top: r.top,
                bottom: r.bottom,
              },
            });
        }
        for (let i = 0; i < controls.length; i++)
          for (let j = i + 1; j < controls.length; j++) {
            const a = rect(controls[i]),
              b = rect(controls[j]);
            if (
              Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
              Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
            )
              issues.push({
                problem: "overlapping-controls",
                a: controls[i].name,
                b: controls[j].name,
              });
          }
      }
      const body = document.querySelector(".modal-body");
      if (body.scrollWidth > body.clientWidth + 2)
        issues.push({ problem: "modal-horizontal-overflow" });
      return issues;
    });
    if (issues.length) problems.push({ label, issues });
    checked++;
  }
  await page.evaluate(() => newDoc("quote"));
  await page.locator('#doc-lines input[name="qty"]').scrollIntoViewIfNeeded();
  await inspect("reported-size/new-quote/blank");
  const output = process.env.ERP_BROWSER_OUTPUT;
  if (output) {
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({
      path: output + "/quote-reported-size.png",
      fullPage: false,
    });
  }
  if (process.env.ERP_LAYOUT_REPRO_ONLY) {
    console.log(JSON.stringify(problems, null, 2));
    assert.ok(problems.length, "Expected to reproduce the reported bug");
    await browser.close();
    return;
  }
  await page.evaluate(() => closeModal());
  const orders = [
    "qty,price,discount_bp",
    "price,qty,discount_bp",
    "discount_bp,price,qty",
    "qty,discount_bp,price",
    "price,discount_bp,qty",
    "discount_bp,qty,price",
  ];
  for (const width of [1600, 1366, 1280, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 800 });
    for (const kind of ["quote", "order", "purchase"])
      for (const order of orders) {
        await page.evaluate(
          ({ kind, order }) => {
            closeModal();
            S.data.user_preferences.input_order = order;
            newDoc(kind);
          },
          { kind, order },
        );
        await inspect(width + "/" + kind + "/" + order + "/blank");
        await page.evaluate(() => {
          S.docDraft.lines = [0, 1, 2].map((i) => ({
            product_id: String(S.data.products[i].id),
            qty: "123.456",
            price: "987654.32",
            discount_bp: 9750,
            tax_mode: "inclusive",
            tax_bp: 500,
            notes: "長備註 / " + "說明".repeat(90),
          }));
          renderDocLines();
        });
        await inspect(width + "/" + kind + "/" + order + "/filled-3-lines");
        // Exercise the nested horizontal scroller at its far edge; controls must stay in their own cells.
        await page.locator("#doc-lines .table-wrap").evaluate((el) => {
          el.scrollLeft = el.scrollWidth;
        });
        await inspect(width + "/" + kind + "/" + order + "/scrolled");
      }
  }
  // Validate actual product/unit changes, row editing, calculation and save, not only static geometry.
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.evaluate(() => {
    closeModal();
    S.data.user_preferences.input_order = "qty,price,discount_bp";
    newDoc("quote");
  });
  await page.locator("#f-partner_id").selectOption("1");
  await page.locator('[name="product_id"]').selectOption("1");
  await page.waitForFunction(() => S.docDraft.lines[0].price !== "0");
  await page.locator('[name="qty"]').fill("2");
  await page.locator('[name="qty"]').dispatchEvent("change");
  await page
    .locator('[data-line-total="0"]')
    .filter({ hasText: /[0-9]/ })
    .waitFor();
  await inspect("working-quote-with-calculated-total");
  await page.getByRole("button", { name: "儲存草稿", exact: true }).click();
  await page.waitForFunction(
    () => S.docDetail?.kind === "quote" && S.docDetail.lines[0].qty === 2000,
  );
  assert.ok(await page.evaluate(() => S.docDetail.total > 0));
  assert.deepEqual(
    problems,
    [],
    "Document inputs overlap or escape their table cell",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS " +
      checked +
      " document layouts: own-cell bounds, control overlap, reordered columns, blank/long-filled/multiline, horizontal scrolling",
  );
  console.log(
    "PASS actual quotation selection, quantity calculation and saved draft",
  );
  await browser.close();
})().catch(async (error) => {
  await browser?.close();
  console.error(error);
  process.exitCode = 1;
});
