import test from "node:test";
import assert from "node:assert/strict";
import { ERP, today } from "../src/core.mjs";
import { Quality } from "../src/quality.mjs";
import { VendorBills } from "../src/vendor-bills.mjs";
import { Finance } from "../src/finance.mjs";
import { MonthlyBilling } from "../src/billing.mjs";
import { FulfilmentBatches } from "../src/fulfilment-batches.mjs";
function fixture(t) {
  const e = new ERP();
  t.after(() => e.close());
  const a = e.setup({ username: "admin", password: "controls-fixtures-2026" }),
    q = new Quality(e),
    v = new VendorBills(e),
    f = new Finance(e),
    users = { admin: a };
  for (const [name, role] of [
    ["inspector", "warehouse"],
    ["reviewer", "manager"],
    ["accountant", "finance"],
  ]) {
    e.saveUser(a, {
      username: name,
      name,
      role,
      password: "controls-fixtures-2026",
    });
    users[name] = e.user(
      e.get("SELECT id FROM users WHERE username=?", name).id,
    );
  }
  const product = e.saveProduct(a, {
      sku: "QC1",
      name: "檢驗品",
      price: "10",
      cost: "10",
    }),
    supplier = e.savePartner(a, {
      code: "V",
      name: "測試供應商",
      kind: "supplier",
    }),
    customer = e.savePartner(a, { code: "C", name: "測試客戶" }),
    bank = f.saveBank(a, {
      code: "B",
      name: "測試銀行",
      kind: "bank",
      opening_balance: "10000",
    });
  const doc = (kind = "purchase", qty = "10") => {
    let d = e.saveDoc(a, {
      kind,
      partner_id: kind === "purchase" ? supplier.id : customer.id,
      warehouse_id: 1,
      lines: [{ product_id: product.id, qty, price: "10" }],
    });
    d = e.transition(a, d.id, "submit");
    return e.transition(a, d.id, "approve");
  };
  const spec = (extra = {}) =>
    q.spec(a, {
      product_id: product.id,
      direction: "receipt",
      name: "重量及外觀",
      sampling_bp: 2000,
      min_sample_qty: "1",
      forbid_self_release: true,
      parameters: [
        {
          key: "weight",
          label: "重量",
          type: "number",
          lower: "9",
          upper: "11",
          unit: "g",
        },
        {
          key: "appearance",
          label: "外觀",
          type: "text",
          expected_text: "合格",
        },
      ],
      ...extra,
    });
  const inspect = (d, extra = {}) =>
    q.create(users.inspector, {
      document_id: d.id,
      document_version: d.version,
      ...extra,
    });
  const readings = (r, extra = {}) =>
    q.save(users.inspector, r.id, {
      version: r.version,
      notes: "實際檢驗",
      lines: r.lines
        .filter((l) => l.spec_id)
        .map((l) => ({
          id: l.id,
          sampled_qty: String(l.required_sample_qty / 1000),
          readings: { weight: "10", appearance: "合格" },
          ...extra,
        })),
    });
  const release = (r) => {
    r = q.action(users.inspector, r.id, {
      action: "submit",
      version: r.version,
    });
    return q.action(users.reviewer, r.id, {
      action: "approve",
      version: r.version,
    });
  };
  const bill = (receipt, extra = {}) => {
    const sources = e
      .all("SELECT id FROM fulfilment_lines WHERE fulfilment_id=?", receipt.id)
      .map((l) => v.source(a, l.id));
    return v.save(users.accountant, {
      supplier_id: supplier.id,
      invoice_ref: "INV-" + receipt.id,
      date: today(),
      lines: sources.map((s) => ({
        receipt_line_id: s.id,
        qty: String(s.expected_qty / 1000),
        net: String(s.expected_net / 100),
        tax: String(s.expected_tax / 100),
      })),
      ...extra,
    });
  };
  const approve = (b) =>
    v.action(users.reviewer, b.id, {
      action: "approve",
      version: b.version,
      token: b.match.token,
      reason: "已核對供應商憑證",
      accept_variance: true,
    });
  const policy = (extra = {}) =>
    v.configure(a, {
      ...v.policy(),
      tax_tolerance: String(v.policy().tax_tolerance_cents / 100),
      require_matching: true,
      ...extra,
    });
  return {
    e,
    a,
    q,
    v,
    f,
    users,
    product,
    supplier,
    customer,
    bank,
    doc,
    spec,
    inspect,
    readings,
    release,
    bill,
    approve,
    policy,
  };
}
test("quality hold keeps receipts outside stock/AP until measured, passed, independently released and consumed once", (t) => {
  const { e, a, q, users, doc, spec, inspect, readings, release } = fixture(t);
  spec();
  const d = doc();
  let r = inspect(d);
  assert.equal(r.lines[0].required_sample_qty, 2000);
  assert.equal(e.stock(1, 1).qty, 0);
  assert.equal(e.get("SELECT count(*) n FROM open_items").n, 0);
  assert.throws(() => e.fulfil(a, d.id, {}), /尚未品檢放行/);
  r = readings(r);
  r = q.action(users.inspector, r.id, { action: "submit", version: r.version });
  assert.equal(r.status, "passed");
  assert.throws(
    () =>
      q.action(users.inspector, r.id, {
        action: "approve",
        version: r.version,
      }),
    /權限|自行放行/,
  );
  r = q.action(users.reviewer, r.id, { action: "approve", version: r.version });
  const post = e.fulfil(a, d.id, { quality_inspection_id: r.id });
  assert.equal(e.stock(1, 1).qty, 10000);
  assert.equal(e.get("SELECT count(*) n FROM open_items").n, 1);
  assert.equal(q.detail(a, r.id).status, "consumed");
  assert.equal(
    e.get(
      "SELECT fulfilment_id FROM quality_releases WHERE inspection_id=?",
      r.id,
    ).fulfilment_id,
    post.id,
  );
  assert.throws(
    () =>
      q.action(a, r.id, {
        action: "cancel",
        version: q.detail(a, r.id).version,
        reason: "不能刪除",
      }),
    /不能取消/,
  );
  assert.equal(e.integrity(a).ok, true);
});
test("quality validation, failure/retest, frozen specs and immutable samples are enforced", (t) => {
  const { e, a, q, users, doc, spec, inspect, readings } = fixture(t);
  const s = spec(),
    d = doc();
  let r = inspect(d);
  assert.throws(
    () =>
      readings(r, { sampled_qty: "0.001" }) &&
      q.action(users.inspector, r.id, {
        action: "submit",
        version: r.version + 1,
      }),
    /抽樣量/,
  );
  r = q.detail(users.inspector, r.id);
  r = readings(r, { readings: { weight: "12", appearance: "合格" } });
  r = q.action(users.inspector, r.id, { action: "submit", version: r.version });
  assert.equal(r.status, "failed");
  assert.throws(
    () =>
      q.action(users.reviewer, r.id, { action: "approve", version: r.version }),
    /合格/,
  );
  assert.throws(
    () =>
      e.run(
        "UPDATE quality_inspection_lines SET readings='{}' WHERE inspection_id=?",
        r.id,
      ),
    /locked/,
  );
  assert.throws(() => e.run("DELETE FROM quality_events"), /immutable/);
  assert.throws(
    () => e.run("UPDATE quality_inspection_lines SET definition='{}'"),
    /immutable/,
  );
  spec({
    id: s.id,
    version: 1,
    parameters: [
      { key: "new", label: "新規格", type: "text", expected_text: "OK" },
    ],
  });
  const copy = inspect(d);
  assert.equal(copy.lines[0].spec_version, 2);
  assert.equal(
    q.detail(a, r.id).lines[0].definition.parameters[0].key,
    "weight",
  );
});
test("released inspections bind exact partial quantities/version and stock failure rolls back consumption", (t) => {
  const { e, a, q, doc, spec, inspect, readings, release } = fixture(t);
  spec();
  const d = doc();
  let r = release(
    readings(inspect(d, { lines: [{ line_id: d.lines[0].id, qty: "4" }] })),
  );
  assert.throws(
    () =>
      e.fulfil(a, d.id, {
        quality_inspection_id: r.id,
        lines: [{ line_id: d.lines[0].id, qty: "5" }],
      }),
    /來源／數量/,
  );
  const journal = e.journal;
  e.journal = () => {
    throw Error("simulated final posting failure");
  };
  assert.throws(
    () =>
      e.fulfil(a, d.id, {
        quality_inspection_id: r.id,
        lines: [{ line_id: d.lines[0].id, qty: "4" }],
      }),
    /simulated/,
  );
  e.journal = journal;
  assert.equal(e.stock(1, 1).qty, 0);
  assert.equal(q.detail(a, r.id).status, "released");
  assert.equal(e.get("SELECT count(*) n FROM quality_releases").n, 0);
  e.fulfil(a, d.id, {
    quality_inspection_id: r.id,
    lines: [{ line_id: d.lines[0].id, qty: "4" }],
  });
  assert.equal(e.stock(1, 1).qty, 4000);
  assert.throws(() => e.fulfil(a, d.id, {}), /尚未品檢放行/);
  assert.equal(e.integrity(a).ok, true);
});
test("combined receipts cannot bypass quality and a later missing release rolls earlier postings back", (t) => {
  const { e, a, doc, spec, inspect, readings, release, q } = fixture(t);
  spec();
  const d1 = doc(),
    d2 = doc(),
    r1 = release(readings(inspect(d1))),
    r2 = release(readings(inspect(d2))),
    combined = new FulfilmentBatches(e);
  assert.throws(
    () =>
      combined.create(a, {
        documents: [
          {
            document_id: d1.id,
            version: d1.version,
            quality_inspection_id: r1.id,
          },
          { document_id: d2.id, version: d2.version },
        ],
      }),
    /品檢/,
  );
  assert.equal(e.stock(1, 1).qty, 0);
  assert.equal(q.detail(a, r1.id).status, "released");
  const result = combined.create(a, {
    documents: [
      { document_id: d1.id, version: d1.version, quality_inspection_id: r1.id },
      { document_id: d2.id, version: d2.version, quality_inspection_id: r2.id },
    ],
  });
  assert.equal(result.sources.length, 2);
  assert.equal(e.stock(1, 1).qty, 20000);
  assert.equal(e.get("SELECT count(*) n FROM quality_releases").n, 2);
});
test("three-way approval is independent of AP and blocks cash, advance application, cheque and raw paid increases until matched", (t) => {
  const { e, a, v, f, users, doc, bank, bill, approve, policy, supplier } =
    fixture(t);
  const receipt = e.fulfil(a, doc().id, {}),
    o = e.get("SELECT * FROM open_items WHERE fulfilment_id=?", receipt.id);
  policy();
  const initial = e.get("SELECT count(*) n FROM journals").n;
  assert.throws(
    () =>
      e.pay(a, {
        open_item_id: o.id,
        amount: "10",
        bank_account_id: bank.id,
        date: today(),
        method: "bank",
      }),
    /三方核對/,
  );
  const fund = f.advance(a, {
    kind: "supplier_advance",
    partner_id: supplier.id,
    bank_account_id: bank.id,
    amount: "10",
    date: today(),
  });
  assert.throws(
    () =>
      f.apply(a, {
        fund_id: fund.id,
        open_item_id: o.id,
        amount: "10",
        date: today(),
      }),
    /三方核對/,
  );
  assert.equal(
    e.get("SELECT applied FROM funds WHERE id=?", fund.id).applied,
    0,
  );
  assert.throws(
    () =>
      f.registerBill(a, {
        kind: "payable",
        partner_id: supplier.id,
        bank_account_id: bank.id,
        amount: "10",
        bill_number: "CONTROL-CHECK",
        date: today(),
        due_date: today(),
        lines: [{ open_item_id: o.id, amount: "10" }],
      }),
    /三方核對/,
  );
  assert.equal(e.get("SELECT count(*) n FROM bills").n, 0);
  assert.throws(
    () =>
      e.db.prepare("UPDATE open_items SET paid=paid+1 WHERE id=?").run(o.id),
    /ERP_VENDOR_MATCH_REQUIRED/,
  );
  let b = bill(receipt);
  assert.equal(b.match.within_tolerance, true);
  const before = e.get("SELECT count(*) n FROM journals").n;
  b = approve(b);
  assert.equal(e.get("SELECT count(*) n FROM journals").n, before);
  assert.equal(b.payment_valid, true);
  e.pay(a, {
    open_item_id: o.id,
    amount: "10",
    bank_account_id: bank.id,
    date: today(),
    method: "bank",
  });
  assert.equal(
    e.get("SELECT paid FROM open_items WHERE id=?", o.id).paid,
    1000,
  );
  assert.equal(e.integrity(a).ok, true);
  assert.throws(() => e.run("DELETE FROM vendor_bill_links"), /immutable/);
  assert.throws(
    () => e.run("UPDATE vendor_bill_lines SET claimed_net=1"),
    /locked/,
  );
  assert.throws(
    () => e.run("UPDATE vendor_bills SET invoice_ref='FAKE'"),
    /locked/,
  );
});
test("vendor duplicate refs, source scope, out-of-tolerance and stale matching reject without granting payment", (t) => {
  const { e, a, v, doc, bill, approve, policy, supplier } = fixture(t);
  const receipt = e.fulfil(a, doc().id, {});
  policy();
  let b = bill(receipt);
  assert.throws(
    () => bill(receipt, { invoice_ref: b.invoice_ref.toLowerCase() }),
    /UNIQUE/,
  );
  b = v.save(a, {
    ...b,
    total: "106",
    lines: [
      {
        receipt_line_id: b.match.lines[0].receipt_line_id,
        qty: "10",
        net: "101",
        tax: "5",
      },
    ],
  });
  assert.equal(b.match.within_tolerance, false);
  assert.throws(() => approve(b), /仍有差異/);
  const old = b;
  policy({ net_tolerance_bp: 200 });
  assert.throws(() => approve(old), /已變更/);
  b = v.detail(a, b.id);
  assert.equal(b.match.within_tolerance, true);
  assert.throws(
    () =>
      v.action(a, b.id, {
        action: "approve",
        version: b.version,
        token: b.match.token,
        reason: "自行核准",
        accept_variance: true,
      }),
    /自行核准/,
  );
  const approved = approve(b);
  assert.equal(approved.payment_valid, true);
  assert.equal(
    e.get("SELECT amount FROM open_items WHERE fulfilment_id=?", receipt.id)
      .amount,
    10500,
  );
});
test("source returns invalidate approval, cancellation keeps payments and corrected reapproval uses current book balance", (t) => {
  const { e, a, v, f, doc, bill, approve, policy, bank } = fixture(t);
  const receipt = e.fulfil(a, doc().id, {});
  policy();
  let b = approve(bill(receipt));
  const o = e.get("SELECT * FROM open_items WHERE fulfilment_id=?", receipt.id);
  e.pay(a, {
    open_item_id: o.id,
    amount: "20",
    bank_account_id: bank.id,
    date: today(),
    method: "bank",
  });
  const line = e.get(
    "SELECT * FROM fulfilment_lines WHERE fulfilment_id=?",
    receipt.id,
  );
  e.returnGoods(a, {
    fulfilment_id: receipt.id,
    reason: "退回瑕疵",
    lines: [{ line_id: line.id, qty: "2" }],
  });
  assert.equal(v.detail(a, b.id).payment_valid, false);
  assert.throws(
    () =>
      e.pay(a, {
        open_item_id: o.id,
        amount: "1",
        bank_account_id: bank.id,
        date: today(),
        method: "bank",
      }),
    /三方核對/,
  );
  v.action(a, b.id, {
    action: "cancel",
    version: b.version,
    reason: "依退貨後重新核對",
  });
  assert.equal(
    e.get("SELECT paid FROM open_items WHERE id=?", o.id).paid,
    2000,
  );
  b = approve(bill(receipt));
  assert.equal(b.match.sources[0].payable_amount, 8400);
  e.pay(a, {
    open_item_id: o.id,
    amount: "64",
    bank_account_id: bank.id,
    date: today(),
    method: "bank",
  });
  assert.equal(
    e.get("SELECT paid FROM open_items WHERE id=?", o.id).paid,
    8400,
  );
  assert.equal(e.integrity(a).ok, true);
});
test("quality and vendor metadata cannot expose restricted sources or costs", (t) => {
  const { e, a, q, v, users, doc, spec, inspect, bill } = fixture(t);
  spec();
  const d = doc(),
    r = inspect(d);
  assert.deepEqual(v.data(users.inspector), {});
  e.access.saveProfile(a, {
    user_id: users.inspector.id,
    version: 0,
    inherit_base: false,
    rules: [
      {
        resource: "quality_inspections",
        action: "read",
        effect: "allow",
        scope: "all",
      },
      { resource: "purchases", action: "read", effect: "allow", scope: "own" },
    ],
  });
  const u = e.user(users.inspector.id);
  assert.deepEqual(q.data(u).quality_inspections, []);
  assert.throws(() => q.detail(u, r.id), /權限|範圍/);
  assert.deepEqual(v.data(u), {});
});

test("a mixed monthly payout rolls an earlier matched payment back when the next receipt is unmatched", (t) => {
  const { e, a, f, v, users, doc, supplier, bank, bill, approve, policy } =
    fixture(t);
  e.savePartner(a, {
    ...e.partner(a, supplier.id),
    billing_policy: "batch",
    payment_mode: "cutoff",
    closing_day: Number(today().slice(8)),
  });
  const r1 = e.fulfil(a, doc().id, {}),
    r2 = e.fulfil(a, doc().id, {});
  policy();
  approve(bill(r1));
  const m = new MonthlyBilling(e),
    p = m.pending(a, {
      kind: "payable",
      partner_id: supplier.id,
      account_period: today().slice(0, 7),
    });
  const batch = m.close(a, {
    kind: "payable",
    partner_id: supplier.id,
    account_period: p.period,
    date: today(),
    items: p.rows.map((r) => ({ id: r.id, amount: r.amount })),
  });
  const before = e.get("SELECT count(*) n FROM journals").n;
  assert.throws(
    () =>
      m.pay(a, batch.id, {
        bank_account_id: bank.id,
        amount: "210",
        date: today(),
      }),
    /三方核對/,
  );
  assert.equal(e.get("SELECT count(*) n FROM payments").n, 0);
  assert.equal(e.get("SELECT count(*) n FROM journals").n, before);
  approve(bill(r2));
  m.pay(a, batch.id, {
    bank_account_id: bank.id,
    amount: "210",
    date: today(),
  });
  assert.equal(m.get(a, batch.id).paid, 21000);
  assert.equal(e.integrity(a).ok, true);
});
test("outbound quality holds reservations and a released inspection cannot survive another partial posting", (t) => {
  const { e, a, q, doc, spec, inspect, readings, release } = fixture(t);
  e.fulfil(a, doc().id, {});
  spec({ direction: "shipment" });
  const d = doc("order", "6");
  const first = release(
    readings(inspect(d, { lines: [{ line_id: d.lines[0].id, qty: "2" }] })),
  );
  const second = release(
    readings(inspect(d, { lines: [{ line_id: d.lines[0].id, qty: "4" }] })),
  );
  assert.throws(() => e.fulfil(a, d.id, {}), /品檢/);
  assert.equal(e.stock(1, 1).reserved, 6000);
  e.fulfil(a, d.id, {
    quality_inspection_id: first.id,
    lines: [{ line_id: d.lines[0].id, qty: "2" }],
  });
  assert.throws(
    () =>
      e.fulfil(a, d.id, {
        quality_inspection_id: second.id,
        lines: [{ line_id: d.lines[0].id, qty: "4" }],
      }),
    /來源／數量/,
  );
  assert.equal(e.stock(1, 1).reserved, 4000);
  assert.equal(q.detail(a, second.id).status, "released");
  assert.equal(e.integrity(a).ok, true);
});
test("bill matching requires every remaining receipt line and does not hide unit-price variance behind quantity variance", (t) => {
  const { e, a, v, doc, supplier, bill, policy } = fixture(t);
  const receipt = e.fulfil(a, doc().id, {});
  policy({ quantity_tolerance_bp: 1000, net_tolerance_bp: 100 });
  let b = bill(receipt),
    line = b.match.lines[0];
  b = v.save(a, {
    ...b,
    total: "105",
    lines: [
      {
        receipt_line_id: line.receipt_line_id,
        qty: "11",
        net: "100",
        tax: "5",
      },
    ],
  });
  assert.equal(b.match.within_tolerance, false);
  assert.ok(b.match.issues.some((s) => s.includes("單價")));
  const p2 = e.saveProduct(a, { sku: "P2", name: "第二品項" });
  let d = e.saveDoc(a, {
    kind: "purchase",
    partner_id: supplier.id,
    warehouse_id: 1,
    lines: [
      { product_id: 1, qty: "2", price: "10" },
      { product_id: p2.id, qty: "1", price: "20" },
    ],
  });
  d = e.transition(a, d.id, "submit");
  d = e.transition(a, d.id, "approve");
  const r = e.fulfil(a, d.id, {}),
    s = v.source(
      a,
      e.get(
        "SELECT id FROM fulfilment_lines WHERE fulfilment_id=? ORDER BY id",
        r.id,
      ).id,
    );
  b = v.save(a, {
    supplier_id: supplier.id,
    invoice_ref: "INCOMPLETE",
    date: today(),
    lines: [
      {
        receipt_line_id: s.id,
        qty: String(s.expected_qty / 1000),
        net: String(s.expected_net / 100),
        tax: String(s.expected_tax / 100),
      },
    ],
  });
  assert.equal(b.match.within_tolerance, false);
  assert.ok(b.match.issues.some((s) => s.includes("全部未退明細")));
});

test("configured create scopes are checked against the new record, not just the presence of an allow rule", (t) => {
  const { e, a, q, v, users, doc, spec } = fixture(t);
  const receipt = e.fulfil(a, doc().id, {});
  spec();
  const d = doc();
  const common = [
    "products",
    "warehouses",
    "partners",
    "purchases",
    "fulfilments",
    "billing",
    "costs",
    "quality_specs",
    "quality_inspections",
    "vendor_bills",
  ].map((resource) => ({
    resource,
    action: "read",
    effect: "allow",
    scope: "all",
  }));
  const creates = (scope) =>
    ["quality_inspections", "vendor_bills"].map((resource) => ({
      resource,
      action: "create",
      effect: "allow",
      scope,
      ...(scope === "selected" ? { owners: [users.reviewer.id] } : {}),
    }));
  e.access.saveProfile(a, {
    user_id: users.inspector.id,
    version: 0,
    inherit_base: false,
    rules: [...common, ...creates("selected")],
  });
  let u = e.user(users.inspector.id);
  assert.throws(
    () => q.create(u, { document_id: d.id, document_version: d.version }),
    /範圍|權限/,
  );
  assert.equal(e.get("SELECT count(*) n FROM quality_inspections").n, 0);
  const source = v.source(
      a,
      e.get("SELECT id FROM fulfilment_lines WHERE fulfilment_id=?", receipt.id)
        .id,
    ),
    body = {
      supplier_id: source.partner_id,
      invoice_ref: "SCOPE",
      date: today(),
      lines: [{ receipt_line_id: source.id, qty: "10", net: "100", tax: "5" }],
    };
  assert.throws(() => v.save(u, body), /範圍|權限/);
  assert.equal(e.get("SELECT count(*) n FROM vendor_bills").n, 0);
  e.access.saveProfile(a, {
    user_id: u.id,
    version: 1,
    inherit_base: false,
    rules: [...common, ...creates("own")],
  });
  u = e.user(u.id);
  assert.ok(q.create(u, { document_id: d.id, document_version: d.version }).id);
  assert.ok(v.save(u, body).id);
});

test("a later failed or cancelled inspection does not resurrect an earlier release for the same batch", (t) => {
  const { e, a, q, users, doc, spec, inspect, readings, release } = fixture(t);
  spec();
  const d = doc();
  const old = release(readings(inspect(d)));
  let failed = readings(inspect(d), {
    readings: { weight: "12", appearance: "合格" },
  });
  failed = q.action(users.inspector, failed.id, {
    action: "submit",
    version: failed.version,
  });
  assert.equal(q.detail(a, old.id).postable, false);
  assert.throws(
    () => e.fulfil(a, d.id, { quality_inspection_id: old.id }),
    /更新的品檢/,
  );
  q.action(users.reviewer, failed.id, {
    action: "cancel",
    version: failed.version,
    reason: "另建重新抽驗",
  });
  assert.throws(
    () => e.fulfil(a, d.id, { quality_inspection_id: old.id }),
    /更新的品檢/,
  );
  const latest = release(readings(inspect(d)));
  assert.equal(latest.postable, true);
  e.fulfil(a, d.id, { quality_inspection_id: latest.id });
  assert.equal(e.integrity(a).ok, true);
});
test("warehouse-scoped vendor creation and edits cannot move bills outside the permitted warehouses", (t) => {
  const { e, a, v, users, doc, supplier } = fixture(t);
  const first = e.fulfil(a, doc().id, {});
  const wh = e.saveWarehouse(a, { code: "W2", name: "第二倉" });
  let d = e.saveDoc(a, {
    kind: "purchase",
    partner_id: supplier.id,
    warehouse_id: wh.id,
    lines: [{ product_id: 1, qty: "1", price: "10" }],
  });
  d = e.transition(a, d.id, "submit");
  d = e.transition(a, d.id, "approve");
  const second = e.fulfil(a, d.id, {});
  const read = [
    "products",
    "partners",
    "warehouses",
    "purchases",
    "fulfilments",
    "billing",
    "costs",
    "vendor_bills",
  ].map((resource) => ({
    resource,
    action: "read",
    scope: "all",
    effect: "allow",
  }));
  e.access.saveProfile(a, {
    user_id: users.accountant.id,
    version: 0,
    inherit_base: false,
    rules: [
      ...read,
      ...["create", "update"].map((action) => ({
        resource: "vendor_bills",
        action,
        scope: "all",
        warehouses: [1],
        effect: "allow",
      })),
    ],
  });
  const u = e.user(users.accountant.id);
  const body = (receipt, ref) => {
    const s = v.source(
      a,
      e.get("SELECT id FROM fulfilment_lines WHERE fulfilment_id=?", receipt.id)
        .id,
    );
    return {
      supplier_id: supplier.id,
      invoice_ref: ref,
      date: today(),
      lines: [
        {
          receipt_line_id: s.id,
          qty: String(s.expected_qty / 1000),
          net: String(s.expected_net / 100),
          tax: String(s.expected_tax / 100),
        },
      ],
    };
  };
  assert.throws(() => v.save(u, body(second, "DENY")), /範圍|權限/);
  const saved = v.save(u, body(first, "OK"));
  assert.throws(
    () =>
      v.save(u, {
        ...body(second, "MOVED"),
        id: saved.id,
        version: saved.version,
      }),
    /範圍|權限/,
  );
  assert.equal(v.detail(u, saved.id).invoice_ref, "OK");
});

test("an active quality hold cannot disappear by disabling or moving its specification", (t) => {
  const { e, a, q, users, doc, spec, inspect } = fixture(t);
  const s = spec(),
    d = doc(),
    r = inspect(d);
  assert.throws(
    () => spec({ id: s.id, version: 1, active: false }),
    /未結品檢/,
  );
  assert.throws(
    () => spec({ id: s.id, version: 1, direction: "shipment" }),
    /未結品檢/,
  );
  q.action(users.reviewer, r.id, {
    action: "cancel",
    version: r.version,
    reason: "此批取消檢驗，另行處理",
  });
  spec({ id: s.id, version: 1, active: false });
  assert.equal(
    e.get("SELECT active FROM quality_specs WHERE id=?", s.id).active,
    0,
  );
});

test("legacy receipts can use quality gates but unsupported unpaid legacy AP cannot accidentally enable matching", (t) => {
  const { e, a, q, doc, spec, inspect, readings, release, policy, v } =
    fixture(t);
  spec();
  let d = doc();
  e.run("UPDATE documents SET calc_version=1 WHERE id=?", d.id);
  d = e.doc(a, d.id);
  const r = release(readings(inspect(d)));
  assert.throws(() => e.fulfil(a, d.id, {}), /品檢/);
  const receipt = e.fulfil(a, d.id, { quality_inspection_id: r.id });
  assert.equal(q.detail(a, r.id).status, "consumed");
  assert.equal(
    e.get("SELECT calc_version FROM fulfilments WHERE id=?", receipt.id)
      .calc_version,
    1,
  );
  assert.throws(() => policy(), /未結舊來源/);
  assert.equal(v.policy().require_matching, false);
  assert.equal(e.integrity(a).ok, true);
});

test("tolerance comparisons do not round a half-quantum into an extra permitted quantity", (t) => {
  const { e, a, v, doc, policy, supplier } = fixture(t);
  const receipt = e.fulfil(a, doc("purchase", "0.005").id, {});
  policy({ quantity_tolerance_bp: 1000, net_tolerance_bp: 1000 });
  const source = v.source(
    a,
    e.get("SELECT id FROM fulfilment_lines WHERE fulfilment_id=?", receipt.id)
      .id,
  );
  const bill = v.save(a, {
    supplier_id: supplier.id,
    invoice_ref: "FRACTION",
    date: today(),
    lines: [
      { receipt_line_id: source.id, qty: "0.006", net: "0.05", tax: "0" },
    ],
  });
  assert.equal(bill.match.within_tolerance, false);
  assert.ok(bill.match.issues.some((s) => s.includes("數量差異")));
});

test("receipt posting reloads cumulative allocations after an earlier posting commits before its transaction starts", (t) => {
  const { e, a, supplier } = fixture(t);
  let d = e.saveDoc(a, {
    kind: "purchase",
    partner_id: supplier.id,
    warehouse_id: 1,
    tax_mode: "none",
    lines: [{ product_id: 1, qty: "1.5", price: "0.01" }],
  });
  d = e.transition(a, d.id, "submit");
  d = e.transition(a, d.id, "approve");
  const tx = e.tx.bind(e);
  let pending = true;
  e.tx = (fn) => {
    if (pending) {
      pending = false;
      e.fulfil(a, d.id, { lines: [{ line_id: d.lines[0].id, qty: "0.5" }] });
    }
    return tx(fn);
  };
  const second = e.fulfil(a, d.id, {
    lines: [{ line_id: d.lines[0].id, qty: "0.5" }],
  });
  e.tx = tx;
  assert.equal(
    e.get("SELECT net FROM fulfilments WHERE id=?", second.id).net,
    0,
  );
  e.fulfil(a, d.id, {});
  assert.equal(
    e.get("SELECT sum(net) net FROM fulfilments WHERE document_id=?", d.id).net,
    d.net,
  );
  assert.equal(e.integrity(a).ok, true);
});
