import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { ERP, today, addDays } from "../src/core.mjs";
import { Finance } from "../src/finance.mjs";
import { CompletionWorkflows } from "../src/completion-workflows.mjs";
import { tradingReport } from "../src/reports.mjs";
function fixture(t) {
  const e = new ERP();
  t.after(() => e.close());
  const u = e.setup({ username: "admin", password: "completion-testing-2026" }),
    f = new Finance(e),
    w = new CompletionWorkflows(e),
    customer = e.savePartner(u, { code: "C", name: "客戶" }),
    supplier = e.savePartner(u, { code: "V", name: "廠商", kind: "supplier" }),
    p = e.saveProduct(u, {
      sku: "P1",
      name: "商品",
      price: "100",
      cost: "40",
      supplier_id: supplier.id,
      safety_qty: "5",
    }),
    bank = f.saveBank(u, {
      code: "BANK",
      name: "銀行",
      kind: "bank",
      opening_balance: "10000",
    }),
    cash = f.saveBank(u, {
      code: "CASH",
      name: "現金",
      kind: "cash",
      opening_balance: "10000",
    });
  const post = (kind = "order", qty = "2") => {
    const d = e.saveDoc(u, {
      kind,
      partner_id: kind === "purchase" ? supplier.id : customer.id,
      warehouse_id: 1,
      lines: [
        { product_id: p.id, qty, price: kind === "purchase" ? "40" : "100" },
      ],
    });
    e.transition(u, d.id, "submit");
    e.transition(u, d.id, "approve");
    const f = e.fulfil(u, d.id, {});
    return {
      d,
      f,
      o: e.get("SELECT * FROM open_items WHERE fulfilment_id=?", f.id),
      line: e.get("SELECT * FROM fulfilment_lines WHERE fulfilment_id=?", f.id),
    };
  };
  const stock = (qty = "10") =>
      e.adjust(u, {
        product_id: p.id,
        warehouse_id: 1,
        qty,
        unit_cost: "40",
        reason: "測試期初",
      }),
    check = () => assert.deepEqual(e.integrity(u).problems, []);
  return { e, u, f, w, customer, supplier, p, bank, cash, post, stock, check };
}
test("hierarchical product categories and typed fields validate cycles, choices, versions and preserve snapshots", (t) => {
  const { e, u, w, p } = fixture(t);
  e.tx(() => w.category(u, { code: "ROOT", name: "根分類" }));
  const root = e.get("SELECT * FROM product_categories");
  e.tx(() =>
    w.category(u, { code: "CHILD", name: "子分類", parent_id: root.id }),
  );
  const child = e.get("SELECT * FROM product_categories WHERE code='CHILD'");
  assert.throws(
    () => e.tx(() => w.category(u, { ...root, parent_id: child.id })),
    /循環/,
  );
  w.customDefinition(u, {
    code: "color",
    label: "色彩",
    type: "choice",
    required: true,
    options: ["紅", "藍"],
  });
  assert.throws(
    () =>
      e.tx(() =>
        w.productAttributes(u, {
          product_id: p.id,
          version: p.version,
          category_id: child.id,
          values: { color: "綠" },
        }),
      ),
    /選項/,
  );
  e.tx(() =>
    w.productAttributes(u, {
      product_id: p.id,
      version: p.version,
      category_id: child.id,
      values: { color: "紅" },
    }),
  );
  assert.equal(e.product(p.id).category, "根分類 / 子分類");
  assert.equal(e.get("SELECT value FROM product_custom_values").value, "紅");
  assert.throws(
    () => w.productAttributes(u, { product_id: p.id, version: p.version }),
    /更新/,
  );
  w.preferences(u, {
    quantity_digits: 1,
    money_digits: 0,
    input_order: "price,qty,discount_bp",
  });
  assert.equal(
    e.get("SELECT money_digits FROM user_preferences").money_digits,
    0,
  );
});
test("opening advances use equity and reconcile without a fabricated bank movement", (t) => {
  const { e, u, w, f, customer, supplier, bank, check } = fixture(t),
    before = f.balance(f.bank(bank.id).gl_code);
  e.tx(() =>
    w.openingFund(u, {
      kind: "customer_advance",
      partner_id: customer.id,
      amount: "120",
      reference: "歷史餘額",
    }),
  );
  e.tx(() =>
    w.openingFund(u, {
      kind: "supplier_advance",
      partner_id: supplier.id,
      amount: "80",
      reference: "歷史餘額",
    }),
  );
  assert.equal(f.balance(f.bank(bank.id).gl_code), before);
  assert.equal(f.balance("2400"), -12000);
  assert.equal(f.balance("1400"), 8000);
  assert.equal(e.get("SELECT count(*) n FROM opening_funds").n, 2);
  check();
});
test("nontrade stock documents approve separately, post once, and transfer through partial in-transit receipts", (t) => {
  const { e, u, w, p, check } = fixture(t);
  const to = e.saveWarehouse(u, { code: "WH2", name: "第二倉" });
  let doc = e.tx(() =>
    w.stockDocument(u, {
      kind: "receipt",
      to_id: 1,
      notes: "非交易入庫",
      lines: [{ product_id: p.id, qty: "5", unit_cost: "40" }],
    }),
  );
  assert.equal(e.stock(p.id, 1).qty, 0);
  assert.throws(
    () =>
      e.tx(() =>
        w.stockAction(u, { id: doc.id, version: doc.version, action: "post" }),
      ),
    /核准/,
  );
  doc = e.tx(() =>
    w.stockAction(u, { id: doc.id, version: doc.version, action: "approve" }),
  );
  doc = e.tx(() =>
    w.stockAction(u, { id: doc.id, version: doc.version, action: "post" }),
  );
  assert.equal(e.stock(p.id, 1).qty, 5000);
  assert.throws(
    () =>
      e.tx(() =>
        w.stockAction(u, { id: doc.id, version: doc.version, action: "post" }),
      ),
    /核准/,
  );
  let tr = e.tx(() =>
    w.stockDocument(u, {
      kind: "transfer",
      from_id: 1,
      to_id: to.id,
      notes: "跨倉運輸",
      lines: [{ product_id: p.id, qty: "3" }],
    }),
  );
  tr = e.tx(() =>
    w.stockAction(u, { id: tr.id, version: tr.version, action: "approve" }),
  );
  tr = e.tx(() =>
    w.stockAction(u, { id: tr.id, version: tr.version, action: "post" }),
  );
  assert.equal(e.stock(p.id, 1).qty, 2000);
  assert.equal(e.stock(p.id, tr.transit_id).qty, 3000);
  assert.equal(e.stock(p.id, to.id).qty, 0);
  tr = e.tx(() =>
    w.stockAction(u, {
      id: tr.id,
      version: tr.version,
      action: "receive",
      lines: [{ line_id: tr.lines[0].id, qty: "1" }],
    }),
  );
  assert.equal(tr.status, "dispatched");
  assert.equal(e.stock(p.id, to.id).qty, 1000);
  tr = e.tx(() =>
    w.stockAction(u, {
      id: tr.id,
      version: tr.version,
      action: "receive",
      lines: [{ line_id: tr.lines[0].id, qty: "2" }],
    }),
  );
  assert.equal(tr.status, "received");
  assert.equal(e.stock(p.id, tr.transit_id).qty, 0);
  assert.equal(e.stock(p.id, to.id).value, 12000);
  assert.match(w.stockPrint(u, tr.id), /跨倉運輸/);
  check();
});
test("replenishment policies round min and multiple quantities and atomically group purchase drafts", (t) => {
  const { e, u, w, p, supplier, check } = fixture(t);
  w.policy(u, {
    product_id: p.id,
    target_qty: "10",
    min_order_qty: "12",
    multiple_qty: "5",
    lead_days: 7,
  });
  assert.equal(e.replenishment(u)[0].suggested_qty, 15000);
  const r = e.tx(() =>
    w.replenish(u, { warehouse_id: 1, product_ids: [p.id] }),
  );
  assert.equal(r.documents.length, 1);
  assert.equal(r.documents[0].partner_id, supplier.id);
  assert.equal(r.documents[0].lines[0].qty, 15000);
  assert.equal(r.documents[0].status, "draft");
  assert.throws(
    () =>
      e.tx(() =>
        w.replenish(u, { warehouse_id: 1, product_ids: [p.id, p.id] }),
      ),
    /不重複/,
  );
  check();
});
test("count rebase preserves the counted difference, rejects stale preview and posts controlled adjustment", (t) => {
  const { e, u, w, p, stock, check } = fixture(t);
  stock();
  let c = e.createCount(u, { warehouse_id: 1 });
  c = e.saveCount(u, c.id, {
    version: c.version,
    lines: c.lines.map((l) => ({ line_id: l.id, actual_qty: "9" })),
  });
  e.adjust(u, {
    product_id: p.id,
    warehouse_id: 1,
    qty: "2",
    unit_cost: "40",
    reason: "盤點後入庫",
  });
  assert.equal(w.countPreview(u, { count_id: c.id }).stale, true);
  const preview = w.countRebase(u, {
    count_id: c.id,
    version: c.version,
    reason: "同步已確認異動",
  });
  assert.equal(preview.rows[0].new_expected, 12000);
  assert.equal(preview.rows[0].new_actual, 11000);
  assert.throws(
    () =>
      e.tx(() =>
        w.countRebase(u, {
          count_id: c.id,
          version: c.version,
          reason: "確認",
          preview: false,
          token: "stale",
        }),
      ),
    /重新預覽/,
  );
  c = e.tx(() =>
    w.countRebase(u, {
      count_id: c.id,
      version: c.version,
      reason: "確認",
      preview: false,
      token: preview.token,
    }),
  );
  e.postCount(u, c.id, { version: c.version });
  assert.equal(e.stock(p.id, 1).qty, 11000);
  check();
});
test("CSV count field mapping and zones retain unlisted items and batch cost import checks versions", (t) => {
  const { e, u, w, p, stock } = fixture(t);
  stock();
  let c = e.createCount(u, { warehouse_id: 1 });
  const b = {
    count_id: c.id,
    version: c.version,
    format: "csv",
    base64: Buffer.from("品號,盤量,區\nP1,8.5,A1").toString("base64"),
    columns: { sku: "品號", actual_qty: "盤量", zone: "區" },
  };
  const preview = w.countFile(u, b);
  assert.equal(preview.rows[0].difference, -1500);
  c = e.tx(() =>
    w.countFile(u, { ...b, preview: false, token: preview.token }),
  );
  assert.equal(c.lines[0].actual_qty, 8500);
  assert.equal(e.get("SELECT zone FROM count_zones").zone, "A1");
  const cost = { rows: [{ sku: "P1", cost: "45.25" }], reason: "採購成本更新" },
    cp = w.costBatch(u, cost);
  e.tx(() => w.costBatch(u, { ...cost, preview: false, token: cp.token }));
  assert.equal(e.product(p.id).cost, 4525);
  assert.equal(e.stock(p.id, 1).value, 40000);
  assert.throws(
    () => w.costBatch(u, { ...cost, preview: false, token: cp.token }),
    /重新預覽/,
  );
});
test("sales allowance then multiple physical returns reverse only remaining net and exact tax tails", (t) => {
  const { e, u, w, f, post, stock, check } = fixture(t);
  stock();
  const x = post();
  f.allowance(u, { open_item_id: x.o.id, amount: "21", reason: "議價" });
  let r = e.returnGoods(u, {
    fulfilment_id: x.f.id,
    reason: "部分退貨",
    lines: [{ line_id: x.line.id, qty: "1" }],
  });
  assert.equal(e.get("SELECT total FROM returns WHERE id=?", r.id).total, 9450);
  r = e.returnGoods(u, {
    fulfilment_id: x.f.id,
    reason: "其餘退貨",
    lines: [{ line_id: x.line.id, qty: "1" }],
  });
  assert.equal(e.get("SELECT total FROM returns WHERE id=?", r.id).total, 9450);
  assert.equal(f.item(x.o.id).amount, 0);
  const report = tradingReport(e, u, {
    from: today(),
    to: today(),
    kind: "sales",
    group: "product",
  });
  assert.equal(report.totals.net, 0);
  assert.equal(report.totals.tax, 0);
  check();
});
test("purchase allowance can reduce inventory before later physical return without duplicate variance", (t) => {
  const { e, u, f, post, check } = fixture(t),
    x = post("purchase");
  f.allowance(u, {
    open_item_id: x.o.id,
    amount: "8.40",
    reason: "廠商議價",
    cost_policy: "inventory",
  });
  assert.equal(e.stock(1, 1).value, 7200);
  e.returnGoods(u, {
    fulfilment_id: x.f.id,
    reason: "全部退廠",
    lines: [{ line_id: x.line.id, qty: "2" }],
  });
  assert.equal(e.stock(1, 1).value, 0);
  assert.equal(f.item(x.o.id).amount, 0);
  check();
});
test("payment reversal nets verified prior refunds, retains original events and reconciles AR and credits", (t) => {
  const { e, u, f, post, stock, bank, check } = fixture(t);
  stock();
  const x = post(),
    before = f.balance(f.bank(bank.id).gl_code);
  e.pay(u, {
    open_item_id: x.o.id,
    amount: "210",
    method: "bank",
    bank_account_id: bank.id,
  });
  const payment = e.get("SELECT * FROM payments");
  e.returnGoods(u, {
    fulfilment_id: x.f.id,
    reason: "退一件",
    allow_credit: true,
    lines: [{ line_id: x.line.id, qty: "1" }],
  });
  const fund = e.get("SELECT * FROM funds WHERE kind='customer_credit'");
  f.refund(u, {
    fund_id: fund.id,
    bank_account_id: bank.id,
    amount: "40",
    notes: "已退部分",
  });
  assert.throws(
    () => f.reversePayment(u, { payment_id: payment.id, reason: "原收款取消" }),
    /已退款/,
  );
  const reversal = f.reversePayment(u, {
    payment_id: payment.id,
    reason: "核對後取消",
    offset_refunds: true,
  });
  assert.equal(reversal.cash, 17000);
  assert.equal(f.balance(f.bank(bank.id).gl_code), before);
  assert.equal(f.item(x.o.id).amount, 10500);
  assert.equal(f.item(x.o.id).paid, 0);
  assert.equal(f.balance("2300"), 0);
  assert.equal(f.fund(fund.id).canceled, 6500);
  assert.equal(e.get("SELECT count(*) n FROM fund_refunds").n, 1);
  assert.equal(e.get("SELECT count(*) n FROM payments").n, 1);
  check();
});
test("mixed bank, cash, advances, cheques and receipt fees balance one settlement and rollback on failure", (t) => {
  const { e, u, w, f, post, stock, customer, bank, cash, check } = fixture(t);
  stock();
  const x = post(),
    advance = f.advance(u, {
      kind: "customer_advance",
      partner_id: customer.id,
      bank_account_id: bank.id,
      amount: "50",
    }),
    b = {
      kind: "receivable",
      partner_id: customer.id,
      lines: [{ open_item_id: x.o.id, amount: "210" }],
      tenders: [
        { kind: "bank", amount: "80", bank_account_id: bank.id },
        { kind: "cash", amount: "30", bank_account_id: cash.id },
        { kind: "fund", amount: "50", fund_id: advance.id },
        {
          kind: "cheque",
          amount: "40",
          bank_account_id: bank.id,
          bill_number: "MIX-001",
          due_date: today(),
        },
        { kind: "fee", amount: "10" },
      ],
    };
  const r = e.tx(() => w.settlement(u, b));
  assert.ok(r.no);
  assert.equal(f.item(x.o.id).paid, 21000);
  assert.equal(f.balance("1105"), 4000);
  assert.equal(e.get("SELECT amount FROM settlement_fees").amount, 1000);
  const y = post();
  assert.throws(
    () =>
      e.tx(() =>
        w.settlement(u, {
          ...b,
          lines: [{ open_item_id: y.o.id, amount: "210" }],
          tenders: [
            { kind: "bank", amount: "100", bank_account_id: bank.id },
            { kind: "fund", amount: "110", fund_id: advance.id },
          ],
        }),
      ),
    /超過/,
  );
  assert.equal(f.item(y.o.id).paid, 0);
  assert.equal(e.get("SELECT count(*) n FROM settlements").n, 1);
  check();
});
test("disassembly conserves exact inventory value and kit sale freezes BOM while reserving components", (t) => {
  const { e, u, w, p, customer, stock, check } = fixture(t);
  stock();
  const material = e.saveProduct(u, {
      sku: "M1",
      name: "材料",
      cost: "10",
      price: "20",
    }),
    bom = e.saveBOM(u, {
      product_id: p.id,
      name: "一組兩材料",
      lines: [{ product_id: material.id, qty: "2" }],
    });
  e.tx(() =>
    w.disassemble(u, {
      product_id: p.id,
      warehouse_id: 1,
      qty: "1",
      reason: "拆解",
    }),
  );
  assert.equal(e.stock(p.id, 1).qty, 9000);
  assert.equal(e.stock(material.id, 1).qty, 2000);
  assert.equal(e.stock(material.id, 1).value, 4000);
  const id = e.get("SELECT id FROM boms WHERE product_id=?", p.id).id,
    doc = e.tx(() =>
      w.kitSale(u, {
        kit_id: id,
        partner_id: customer.id,
        warehouse_id: 1,
        qty: "1",
        price: "75",
      }),
    );
  assert.equal(doc.net, 7500);
  assert.equal(doc.lines[0].product_id, material.id);
  assert.equal(doc.lines[0].qty, 2000);
  assert.equal(e.get("SELECT count(*) n FROM kit_sales").n, 1);
  check();
});
test("shortage release reserves only available units and preserves source remainder with a relation", (t) => {
  const { e, u, w, p, customer, stock, check } = fixture(t);
  stock("2");
  const d = e.saveDoc(u, {
    kind: "order",
    partner_id: customer.id,
    warehouse_id: 1,
    lines: [{ product_id: p.id, qty: "5", price: "100" }],
  });
  e.transition(u, d.id, "submit");
  assert.throws(() => e.transition(u, d.id, "approve"), /不足/);
  const result = e.tx(() =>
    w.partialRelease(u, {
      document_id: d.id,
      version: e.doc(u, d.id).version,
      strategy: "available",
    }),
  );
  assert.equal(result.released.lines[0].qty, 2000);
  assert.equal(result.source.lines[0].closed_qty, 2000);
  assert.equal(e.stock(p.id, 1).reserved, 2000);
  assert.equal(
    e.get("SELECT kind FROM document_links WHERE source_id=?", d.id).kind,
    "shortage_release",
  );
  check();
});
test("module closing and reopening require versions and reason without erasing immutable events", (t) => {
  const { e, u, w, p, check } = fixture(t);
  e.tx(() =>
    w.closing(u, {
      module: "inventory",
      closed_until: today(),
      reason: "月底結帳",
    }),
  );
  assert.throws(
    () =>
      e.adjust(u, {
        product_id: p.id,
        warehouse_id: 1,
        qty: "1",
        unit_cost: "40",
        reason: "結帳後",
      }),
    /結帳/,
  );
  assert.throws(
    () =>
      w.closing(u, {
        module: "inventory",
        version: 1,
        closed_until: "",
        reason: "",
      }),
    /不得為空/,
  );
  e.tx(() =>
    w.closing(u, {
      module: "inventory",
      version: 1,
      closed_until: "",
      reason: "主管核准重開",
    }),
  );
  e.adjust(u, {
    product_id: p.id,
    warehouse_id: 1,
    qty: "1",
    unit_cost: "40",
    reason: "修正入庫",
  });
  assert.equal(e.get("SELECT count(*) n FROM closing_events").n, 2);
  assert.throws(() => e.run("DELETE FROM closing_events"), /immutable/);
  check();
});
test("historical stock, aging, relationship graph and matrix totals reconcile with immutable sources", (t) => {
  const { e, u, w, f, p, post, stock, bank, check } = fixture(t);
  stock();
  const x = post();
  e.pay(u, {
    open_item_id: x.o.id,
    amount: "50",
    method: "bank",
    bank_account_id: bank.id,
  });
  const aging = w.historicalAging(u, { date: today() });
  assert.equal(aging.total, 16000);
  const matrix = w.matrix(u, {
    from: today(),
    to: today(),
    row: "product",
    column: "month",
  });
  assert.equal(
    matrix.cells.reduce((n, c) => n + c.net, 0),
    20000,
  );
  const history = w.history(u, { document_id: x.d.id });
  assert.ok(history.nodes.some((x) => x.type === "payment"));
  assert.ok(
    history.edges.some((x) => x.from === "document:" + x.d?.id) ||
      history.edges.length > 0,
  );
  const report = w.stockHistory(u, { date: today() });
  assert.equal(report.rows.find((x) => x.product_id === p.id).qty, 8000);
  assert.equal(
    Object.values(
      report.rows.find((x) => x.product_id === p.id).age_buckets,
    ).reduce((n, v) => n + v, 0),
    8000,
  );
  check();
});
test("standard costing revalues existing and new receipts, posts variances and issues at the standard value", (t) => {
  const { e, u, w, f, p, post, stock, check } = fixture(t);
  stock();
  e.tx(() =>
    w.standards(u, {
      rows: [{ product_id: p.id, cost: "25" }],
      reason: "核定標準",
    }),
  );
  e.tx(() =>
    w.costPolicy(u, {
      method: "standard",
      effective_date: today(),
      reason: "啟用標準成本",
    }),
  );
  assert.equal(e.stock(p.id, 1).value, 25000);
  const purchase = post("purchase", "2");
  assert.equal(e.stock(p.id, 1).value, 30000);
  assert.equal(
    e.get("SELECT sum(value) n FROM stock_moves WHERE kind='standard_variance'")
      .n,
    -18000,
  );
  const sale = post("order", "2");
  assert.equal(
    e.get("SELECT cost FROM fulfilments WHERE id=?", sale.f.id).cost,
    5000,
  );
  assert.equal(e.stock(p.id, 1).value, 25000);
  check();
});
test("monthly weighted settlement preserves original ledgers, adjusts exact COGS, closes inventory and cannot run twice", (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-10-01T04:00:00Z"),
  });
  const { e, u, w, p, customer, check } = fixture(t);
  e.tx(() =>
    w.costPolicy(u, {
      method: "monthly",
      effective_date: today(),
      reason: "月初採月加權",
    }),
  );
  const receive = (qty, cost) => {
    let d = e.tx(() =>
      w.stockDocument(u, {
        kind: "receipt",
        to_id: 1,
        date: today(),
        notes: "計價測試",
        lines: [{ product_id: p.id, qty, unit_cost: cost }],
      }),
    );
    d = e.tx(() =>
      w.stockAction(u, { id: d.id, version: d.version, action: "approve" }),
    );
    e.tx(() =>
      w.stockAction(u, { id: d.id, version: d.version, action: "post" }),
    );
  };
  receive("10", "10");
  t.mock.timers.setTime(Date.parse("2026-10-10T04:00:00Z"));
  const d = e.saveDoc(u, {
    kind: "order",
    partner_id: customer.id,
    warehouse_id: 1,
    lines: [{ product_id: p.id, qty: "5", price: "100" }],
  });
  e.transition(u, d.id, "submit");
  e.transition(u, d.id, "approve");
  const sale = e.fulfil(u, d.id, {});
  t.mock.timers.setTime(Date.parse("2026-10-20T04:00:00Z"));
  receive("10", "30");
  assert.equal(e.stock(p.id, 1).value, 35000);
  t.mock.timers.setTime(Date.parse("2026-10-31T04:00:00Z"));
  const preview = w.monthlyCostPreview(u, { date: today() });
  assert.equal(preview.rows[0].new_value, 30000);
  e.tx(() =>
    w.monthlyCost(u, {
      date: today(),
      token: preview.token,
      reason: "月底核對",
    }),
  );
  assert.equal(e.stock(p.id, 1).value, 30000);
  assert.equal(
    e.get("SELECT cost FROM fulfilments WHERE id=?", sale.id).cost,
    5000,
    "original source remains immutable",
  );
  const report = tradingReport(e, u, {
    from: "2026-10-01",
    to: "2026-10-31",
    kind: "sales",
    group: "product",
  });
  assert.equal(report.totals.cost, 10000);
  assert.throws(() => w.monthlyCostPreview(u, { date: today() }), /已完成/);
  check();
});
test("profit dimensions include saved selling allocations and historical aging ignores future cash and returns", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-10-01T04:00:00Z"),
  });
  const { e, u, w, f, p, post, stock, bank, check } = fixture(t);
  stock();
  const x = post();
  const { FinanceWorkflows } = await import("../src/finance-workflows.mjs"),
    fw = new FinanceWorkflows(e),
    category = f.saveCategory(u, { code: "SHIP", name: "運費" }),
    expense = f.expense(u, {
      category_id: category.id,
      net: "20",
      purpose: "銷售運費",
    }),
    b = {
      expense_id: expense.id,
      basis: "amount",
      lines: [{ fulfilment_line_id: x.line.id, target: "selling" }],
    },
    preview = fw.allocationPreview(u, b);
  fw.allocate(u, { ...b, token: preview.token, reason: "按銷售分攤" });
  t.mock.timers.setTime(Date.parse("2026-10-03T04:00:00Z"));
  e.pay(u, {
    open_item_id: x.o.id,
    amount: "50",
    method: "bank",
    bank_account_id: bank.id,
  });
  t.mock.timers.setTime(Date.parse("2026-10-04T04:00:00Z"));
  e.returnGoods(u, {
    fulfilment_id: x.f.id,
    reason: "退一件",
    lines: [{ line_id: x.line.id, qty: "1" }],
  });
  assert.equal(w.historicalAging(u, { date: "2026-10-02" }).total, 21000);
  assert.equal(w.historicalAging(u, { date: "2026-10-03" }).total, 16000);
  assert.equal(w.historicalAging(u, { date: "2026-10-04" }).total, 5500);
  const report = tradingReport(e, u, {
    from: "2026-10-01",
    to: "2026-10-04",
    kind: "sales",
    group: "product",
  });
  assert.equal(report.totals.selling_expense, 2000);
  assert.equal(report.totals.contribution, 4000);
  assert.equal(
    report.summary.find((g) => g.key === p.id).selling_expense,
    2000,
  );
  check();
});
test("mixed overpayment creates only the verified excess advance and extra bank fees leave exact balances", (t) => {
  const { e, u, w, f, customer, bank, post, stock, check } = fixture(t);
  stock();
  const x = post(),
    before = f.balance(f.bank(bank.id).gl_code),
    body = {
      kind: "receivable",
      partner_id: customer.id,
      lines: [{ open_item_id: x.o.id, amount: "210" }],
      tenders: [
        { kind: "bank", bank_account_id: bank.id, amount: "250" },
        { kind: "bank_fee", bank_account_id: bank.id, amount: "5" },
      ],
    };
  assert.throws(() => e.tx(() => w.settlement(u, body)), /超收付/);
  const r = e.tx(() => w.settlement(u, { ...body, excess_to_advance: true }));
  assert.equal(r.advance_amount, 4000);
  assert.equal(f.item(x.o.id).paid, 21000);
  assert.equal(
    e.get("SELECT amount FROM funds WHERE kind='customer_advance'").amount,
    4000,
  );
  assert.equal(f.balance(f.bank(bank.id).gl_code), before + 24500);
  assert.equal(e.get("SELECT total-paid n FROM expenses").n, 0);
  check();
});
test("batch inventory valuation freezes quantity/value, changes no physical units and journals exact differences", (t) => {
  const { e, u, w, p, stock, check } = fixture(t);
  stock();
  const b = {
      target: "inventory",
      rows: [{ sku: p.sku, warehouse_code: "WH01", cost: "45" }],
      reason: "盤後成本核對",
    },
    preview = w.costBatch(u, b);
  assert.equal(preview.rows[0].new_value, 45000);
  e.tx(() => w.costBatch(u, { ...b, preview: false, token: preview.token }));
  assert.equal(e.stock(p.id, 1).qty, 10000);
  assert.equal(e.stock(p.id, 1).value, 45000);
  assert.throws(
    () =>
      e.tx(() =>
        w.costBatch(u, { ...b, preview: false, token: preview.token }),
      ),
    /重新預覽/,
  );
  check();
});
test("history includes opening balances and unapplied advances when a partner has no trade documents", (t) => {
  const { e, u, w, f, customer, bank } = fixture(t);
  const opening = f.opening(u, {
      kind: "receivable",
      partner_id: customer.id,
      amount: "100",
      reference: "歷史帳款",
      due_date: today(),
    }),
    fund = f.advance(u, {
      kind: "customer_advance",
      partner_id: customer.id,
      bank_account_id: bank.id,
      amount: "30",
    });
  const history = w.history(u, { partner_id: customer.id });
  assert.ok(
    history.nodes.some((n) => n.type === "opening" && n.id === opening.id),
  );
  assert.ok(
    history.nodes.some((n) => n.type === "advance" && n.id === fund.id),
  );
  const html = w.statement(u, {
    partner_id: customer.id,
    date: today(),
    kind: "receivable",
  });
  assert.match(html, /往來對帳單/);
  assert.match(html, /100.00 TWD/);
});
test("closing preview detects ledger changes and refuses a close with inconsistent stock", (t) => {
  const { e, u, w, p, stock } = fixture(t);
  stock();
  const b = { module: "inventory", closed_until: today(), reason: "核對結帳" },
    preview = w.closingPreview(u, b);
  assert.equal(preview.valid, true);
  e.adjust(u, {
    product_id: p.id,
    warehouse_id: 1,
    qty: "1",
    unit_cost: "40",
    reason: "預覽後新增",
  });
  assert.throws(
    () => e.tx(() => w.closing(u, { ...b, token: preview.token })),
    /重新預覽/,
  );
  e.run("UPDATE stocks SET value=value+1 WHERE product_id=?", p.id);
  assert.equal(w.closingPreview(u, b).valid, false);
  assert.throws(() => e.tx(() => w.closing(u, b)), /一致性/);
});

test("XLSX count mapping reads actual workbook numeric cells and preserves the zone", (t) => {
  const { e, u, w, stock } = fixture(t);
  stock();
  const count = e.createCount(u, { warehouse_id: 1 }),
    b = {
      count_id: count.id,
      version: count.version,
      format: "xlsx",
      base64: readFileSync(
        new URL("./fixtures/inventory-count.xlsx", import.meta.url),
      ).toString("base64"),
      columns: { sku: "品號", actual_qty: "盤量", zone: "區" },
    },
    preview = w.countFile(u, b);
  assert.equal(preview.rows[0].actual_qty, 7250);
  e.tx(() => w.countFile(u, { ...b, preview: false, token: preview.token }));
  assert.equal(e.get("SELECT zone FROM count_zones").zone, "A2");
});
