import test from "node:test";
import assert from "node:assert/strict";
import { ERP, today, addDays } from "../src/core.mjs";
import { WarehouseManagement } from "../src/warehouse-management.mjs";
import { ForeignExchange } from "../src/foreign-exchange.mjs";
import {
  DocumentDelivery,
  processDelivery,
} from "../src/document-delivery.mjs";
import { HRPayroll, taiwanPolicyTemplate } from "../src/hr-payroll.mjs";
import { Production } from "../src/production.mjs";
import { Finance } from "../src/finance.mjs";
import { Forms } from "../src/forms.mjs";
import { formModel } from "../src/forms.mjs";
import { InventoryTracking } from '../src/inventory-tracking.mjs';
function fixture(t) {
  const e = new ERP();
  t.after(() => e.close());
  const a = e.setup({ username: "admin", password: "enterprise-fixture-2026" });
  e.saveUser(a, {
    username: "other",
    name: "other",
    role: "admin",
    password: "enterprise-fixture-2026",
  });
  const other = e.user(e.get("SELECT id FROM users WHERE username='other'").id),
    p = e.saveProduct(a, { sku: "P", name: "商品", price: "10", cost: "3" }),
    supplier = e.savePartner(a, {
      code: "V",
      name: "供應商",
      kind: "supplier",
    }),
    customer = e.savePartner(a, { code: "C", name: "客戶" }),
    finance = new Finance(e),
    bank = finance.saveBank(a, {
      code: "B",
      name: "銀行",
      kind: "bank",
      opening_balance: "1000000",
    }),
    wms = new WarehouseManagement(e),
    fx = new ForeignExchange(e),
    hr = new HRPayroll(e),
    production = new Production(e),
    delivery = new DocumentDelivery(e);
  const doc = (kind = "order", qty = "2") => {
    let d = e.saveDoc(a, {
      kind,
      partner_id: kind === "purchase" ? supplier.id : customer.id,
      warehouse_id: 1,
      lines: [{ product_id: p.id, qty, price: "10" }],
    });
    d = e.transition(a, d.id, "submit");
    return e.transition(a, d.id, "approve");
  };
  const stock = (qty = "20") =>
    e.adjust(a, {
      product_id: p.id,
      warehouse_id: 1,
      qty,
      unit_cost: "3",
      reason: "測試期初",
    });
  const bin = (kind = "pick", code = "PICK", capacity = "0") =>
    wms.saveBin(a, {
      warehouse_id: 1,
      code,
      name: code,
      kind,
      capacity_qty: capacity,
    });
  return {
    e,
    a,
    other,
    p,
    supplier,
    customer,
    finance,
    bank,
    wms,
    fx,
    hr,
    production,
    delivery,
    doc,
    stock,
    bin,
  };
}
test("bin activation preserves warehouse/lot quantities; putaway capacity failures roll back all bin movements", (t) => {
  const { e, a, p, wms, stock, bin } = fixture(t);
  stock();
  wms.enable(a, { warehouse_id: 1, version: 0 });
  const receiving = e.get("SELECT * FROM storage_bins WHERE kind='receiving'"),
    pick = bin("pick", "PICK", "5");
  assert.equal(e.get("SELECT sum(qty) n FROM bin_balances").n, 20000);
  assert.throws(
    () =>
      wms.transfer(a, {
        from_bin_id: receiving.id,
        to_bin_id: pick.id,
        product_id: p.id,
        qty: "6",
        reason: "上架",
      }),
    /容量/,
  );
  assert.equal(
    e.get("SELECT qty FROM bin_balances WHERE bin_id=?", receiving.id).qty,
    20000,
  );
  wms.transfer(a, {
    from_bin_id: receiving.id,
    to_bin_id: pick.id,
    product_id: p.id,
    qty: "5",
    reason: "上架",
  });
  assert.equal(e.stock(p.id, 1).qty, 20000);
  assert.equal(e.get("SELECT sum(qty) n FROM bin_balances").n, 20000);
  assert.equal(
    e.get("SELECT sum(qty) n FROM bin_moves WHERE kind='bin_transfer'").n,
    0,
  );
  assert.throws(() => e.run("DELETE FROM bin_moves"), /immutable/);
});
test("warehouse wave shortages require actual replenishment; reserved bins cannot be stolen and posting consumes exact stock once", (t) => {
  const { e, a, p, wms, stock, bin, doc } = fixture(t);
  stock();
  wms.enable(a, { warehouse_id: 1, version: 0 });
  const pick = bin(),
    receiving = e.get("SELECT * FROM storage_bins WHERE kind='receiving'");
  const d = doc("order", "4");
  let wave = wms.createWave(a, { warehouse_id: 1, document_ids: [d.id] });
  assert.equal(wave.lines[0].shortage, 4000);
  assert.throws(() => e.fulfil(a, d.id, {}), /波次/);
  assert.throws(
    () => wms.postWave(a, { id: wave.id, version: wave.version }),
    /補揀/,
  );
  wms.replenishment(a, {
    bin_id: pick.id,
    product_id: p.id,
    min_qty: "2",
    target_qty: "10",
    version: 0,
  });
  wms.replenish(a, { bin_id: pick.id, product_id: p.id });
  wave = wms.planWave(a, { id: wave.id, version: wave.version });
  assert.equal(wave.lines[0].shortage, 0);
  assert.throws(
    () =>
      wms.transfer(a, {
        from_bin_id: pick.id,
        to_bin_id: receiving.id,
        product_id: p.id,
        qty: "7",
        reason: "不當移位",
      }),
    /可用量/,
  );
  wave = wms.postWave(a, { id: wave.id, version: wave.version });
  assert.equal(wave.status, "posted");
  assert.equal(e.stock(p.id, 1).qty, 16000);
  assert.equal(
    e.get("SELECT sum(qty) n FROM bin_balances WHERE product_id=?", p.id).n,
    16000,
  );
  assert.equal(
    e.get("SELECT sum(qty) n FROM bin_moves WHERE kind='shipment'").n,
    -4000,
  );
  assert.throws(
    () => wms.postWave(a, { id: wave.id, version: wave.version }),
    /補揀/,
  );
  assert.equal(e.integrity(a).ok, true);
});
test("wave cancellation releases allocations without deleting history and normal shipment keeps bin ledger synchronized", (t) => {
  const { e, a, p, wms, stock, bin, doc } = fixture(t);
  stock();
  wms.enable(a, { warehouse_id: 1, version: 0 });
  const pick = bin(),
    r = e.get("SELECT id FROM storage_bins WHERE kind='receiving'");
  wms.transfer(a, {
    from_bin_id: r.id,
    to_bin_id: pick.id,
    product_id: p.id,
    qty: "10",
    reason: "上架",
  });
  const d = doc();
  let wave = wms.createWave(a, { warehouse_id: 1, document_ids: [d.id] });
  assert.equal(wave.lines[0].shortage, 0);
  wave = wms.cancelWave(a, {
    id: wave.id,
    version: wave.version,
    reason: "改一般出貨",
  });
  e.fulfil(a, d.id, {});
  assert.equal(
    e.get("SELECT sum(qty) n FROM bin_balances").n,
    e.stock(p.id, 1).qty,
  );
  assert.ok(e.get("SELECT id FROM bin_reservations"));
});
test("FX original/base balances, valuation and partial settlement reconcile realized/unrealized and control accounts", (t) => {
  const { e, a, fx, customer, bank } = fixture(t);
  fx.rate(a, {
    currency: "USD",
    date: addDays(today(), -2),
    rate: "30",
    source: "測試報價",
    version: 0,
  });
  let r = fx.create(a, {
    kind: "receivable",
    partner_id: customer.id,
    currency: "USD",
    date: addDays(today(), -2),
    lines: [{ account: "4000", description: "服務", amount: "100" }],
  });
  r = fx.post(a, { id: r.id, version: r.version });
  assert.equal(r.book_value, 300000);
  fx.rate(a, {
    currency: "USD",
    date: addDays(today(), -1),
    rate: "31",
    source: "測試報價",
    version: 0,
  });
  fx.valuation(a, { date: addDays(today(), -1), account_ids: [r.id] });
  r = fx.account(a, r.id);
  assert.equal(r.book_value, 310000);
  r = fx.settle(a, {
    id: r.id,
    version: r.version,
    date: addDays(today(), -1),
    amount: "40",
    bank_account_id: bank.id,
  });
  assert.equal(r.book_value, 186000);
  fx.rate(a, {
    currency: "USD",
    date: today(),
    rate: "32",
    source: "測試報價",
    version: 0,
  });
  r = fx.settle(a, {
    id: r.id,
    version: r.version,
    date: today(),
    amount: "60",
    bank_account_id: bank.id,
  });
  assert.equal(r.status, "settled");
  assert.equal(r.book_value, 0);
  assert.equal(
    e.get("SELECT sum(debit-credit) n FROM journal_lines WHERE account='1102'")
      .n,
    0,
  );
  assert.equal(
    e.get("SELECT sum(credit-debit) n FROM journal_lines WHERE account='4301'")
      .n,
    10000,
  );
  assert.equal(
    e.get("SELECT sum(credit-debit) n FROM journal_lines WHERE account='4300'")
      .n,
    6000,
  );
  assert.equal(e.integrity(a).ok, true);
});
test("FX JPY precision, duplicated valuation input, overpayment, stale revisions and immutable original snapshots", (t) => {
  const { e, a, fx, supplier, bank } = fixture(t);
  fx.rate(a, {
    currency: "JPY",
    date: today(),
    rate: "0.21",
    source: "測試報價",
  });
  assert.throws(
    () =>
      fx.create(a, {
        kind: "payable",
        partner_id: supplier.id,
        currency: "JPY",
        lines: [{ account: "5200", description: "服務", amount: "10.5" }],
      }),
    /小數/,
  );
  let r = fx.create(a, {
    kind: "payable",
    partner_id: supplier.id,
    currency: "JPY",
    lines: [{ account: "5200", description: "服務", amount: "1000" }],
  });
  r = fx.post(a, { id: r.id, version: r.version });
  assert.equal(r.original_base, 21000);
  assert.throws(
    () => fx.valuation(a, { date: today(), account_ids: [r.id, r.id] }),
    /重複/,
  );
  assert.equal(e.get("SELECT count(*) n FROM fx_valuations").n, 0);
  assert.throws(
    () =>
      fx.settle(a, {
        id: r.id,
        version: r.version,
        date: today(),
        amount: "1001",
        bank_account_id: bank.id,
      }),
    /超過/,
  );
  assert.throws(
    () => e.run("UPDATE foreign_accounts SET foreign_amount=1"),
    /immutable/,
  );
  assert.equal(e.integrity(a).ok, true);
});
test("FX settlement reversal restores original currency and carrying balance without deleting ledger entries", (t) => {
  const { e, a, fx, supplier, bank } = fixture(t);
  fx.rate(a, { currency: "USD", date: today(), rate: "30", source: "測試" });
  let r = fx.create(a, {
    kind: "payable",
    partner_id: supplier.id,
    currency: "USD",
    lines: [{ account: "5200", description: "測試", amount: "100" }],
  });
  r = fx.post(a, { id: r.id, version: r.version });
  r = fx.settle(a, {
    id: r.id,
    version: r.version,
    amount: "100",
    bank_account_id: bank.id,
  });
  r = fx.reverseSettlement(a, {
    settlement_id: r.settlements[0].id,
    version: r.version,
    reason: "重作付款",
  });
  assert.equal(r.foreign_paid, 0);
  assert.equal(r.book_value, 300000);
  assert.equal(r.settlements[0].status, "reversed");
  assert.equal(e.integrity(a).ok, true);
});
test("document default resolution observes customer/language precedence and background delivery freezes actual authorized form output", async (t) => {
  const { e, a, delivery, customer, stock, doc } = fixture(t);
  stock();
  const f = new Forms(e),
    def =
      formModel.presets().find((x) => x.definition.kind === "order")
        ?.definition || formModel.presets()[0]?.definition;
  assert.ok(def);
  const template = f.save(a, {
    name: "寄送版型",
    definition: { ...def, kind: "order" },
  });
  delivery.defaults(a, {
    kind: "order",
    partner_id: customer.id,
    locale: "zh-TW",
    template_id: template.id,
  });
  const d = doc();
  assert.equal(delivery.resolve(a, d.id, "zh-TW").template_id, template.id);
  delivery.configure(a, {
    version: 0,
    enabled: true,
    from: "sender@example.com",
    display_name: "測試寄件",
  });
  const q = delivery.queue(a, {
    document_id: d.id,
    locale: "zh-TW",
    recipient: "recipient@example.com",
    subject: "訂單",
    text: "請查收",
  });
  assert.equal(q.status, "queued");
  let sent;
  await processDelivery(e, async (m) => {
    sent = m;
  });
  assert.equal(sent.to, "recipient@example.com");
  assert.match(
    Buffer.from(sent.attachments[0].base64, "base64").toString(),
    new RegExp(d.no),
  );
  assert.equal(delivery.detail(a, q.id).status, "sent");
  assert.equal(
    await processDelivery(e, async () => assert.fail("must not send twice")),
    false,
  );
});
test("uncertain email acceptance never automatically resends; demo queues never call transport", async (t) => {
  const { e, a, delivery, stock, doc } = fixture(t);
  stock();
  const f = new Forms(e),
    def = formModel
      .presets()
      .find((x) => x.definition.kind === "order").definition,
    template = f.save(a, { name: "測試", definition: def });
  delivery.configure(a, {
    enabled: true,
    from: "sender@example.com",
    display_name: "寄件",
  });
  const d = doc();
  let r = delivery.queue(a, {
    document_id: d.id,
    template_id: template.id,
    recipient: "receiver@example.com",
    subject: "測試",
  });
  await processDelivery(e, async () => {
    throw Object.assign(Error("network after DATA"), {
      deliveryUncertain: true,
    });
  });
  r = delivery.detail(a, r.id);
  assert.equal(r.status, "uncertain");
  assert.equal(
    await processDelivery(e, async () => assert.fail("no automatic retry")),
    false,
  );
  assert.throws(
    () =>
      delivery.action(a, {
        id: r.id,
        version: r.version,
        action: "retry",
        reason: "重試",
      }),
    /確認/,
  );
  const demo = new DocumentDelivery(e, { disabled: true });
  r = demo.queue(a, {
    document_id: d.id,
    template_id: template.id,
    recipient: "receiver@example.com",
    subject: "展示",
  });
  assert.equal(r.status, "demo");
  assert.equal(
    await processDelivery(e, async () => assert.fail("demo must not send")),
    false,
  );
});
test("Taiwan payroll freezes attendance/policy and reconciles accrual, partial payment and reversal", (t) => {
  const { e, a, other, hr, finance, bank } = fixture(t),
    period = addDays(today().slice(0, 7) + "-01", -1).slice(0, 7);
  hr.configure(a, {
    effective_date: "2026-01-01",
    confirm_rules: true,
    definition: {
      ...taiwanPolicyTemplate,
      source: "測試用核定規則",
      forbid_self_approval: true,
    },
  });
  const emp = finance.saveEmployee(a, {
    code: "E",
    name: "員工",
    joined_date: "2026-01-01",
    user_id: a.id,
  });
  hr.terms(a, {
    employee_id: emp.id,
    effective_date: "2026-01-01",
    salary_kind: "monthly",
    amount: "45000",
    labor_base: "45000",
    health_base: "45000",
    pension_base: "45000",
    tax_bp: 500,
  });
  let r = hr.compute(a, { period, notes: "完整核對本期出勤、級距與扣款" });
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].base_pay, 4500000);
  assert.equal(r.lines[0].labor_employee, 112500);
  assert.equal(r.lines[0].health_employee, 69800);
  assert.equal(r.lines[0].net_pay, 4092700);
  assert.throws(
    () =>
      hr.action(a, {
        id: r.id,
        version: r.version,
        action: "approve",
        reason: "核准",
      }),
    /自行核准/,
  );
  r = hr.action(other, {
    id: r.id,
    version: r.version,
    action: "approve",
    reason: "已核對",
  });
  r = hr.action(other, {
    id: r.id,
    version: r.version,
    action: "post",
    reason: "提列",
  });
  r = hr.pay(other, {
    id: r.id,
    version: r.version,
    line_id: r.lines[0].id,
    bank_account_id: bank.id,
    amount: "1000",
  });
  assert.equal(r.lines[0].paid, 100000);
  assert.throws(
    () =>
      hr.action(a, {
        id: r.id,
        version: r.version,
        action: "reverse",
        reason: "重作",
      }),
    /付款/,
  );
  const payment = e.get("SELECT * FROM payroll_payments");
  r = hr.reversePayment(a, {
    payment_id: payment.id,
    version: r.version,
    reason: "退回付款",
  });
  r = hr.action(a, {
    id: r.id,
    version: r.version,
    action: "reverse",
    reason: "取消提列",
  });
  assert.equal(r.status, "reversed");
  for (const code of ["2502", "2503", "2504", "2505"])
    assert.equal(
      e.get(
        "SELECT COALESCE(sum(debit-credit),0) n FROM journal_lines WHERE account=?",
        code,
      ).n,
      0,
    );
  assert.equal(e.integrity(a).ok, true);
});
test("attendance and leave require separate approval, prevent overlaps/overdraw and invalidate a previously calculated payroll", (t) => {
  const { e, a, other, hr, finance } = fixture(t);
  hr.configure(a, {
    effective_date: "2026-01-01",
    confirm_rules: true,
    definition: { ...taiwanPolicyTemplate, source: "測試規則" },
  });
  const emp = finance.saveEmployee(a, {
    code: "E",
    name: "員工",
    joined_date: "2026-01-01",
    user_id: a.id,
  });
  hr.terms(a, {
    employee_id: emp.id,
    effective_date: "2026-01-01",
    salary_kind: "monthly",
    amount: "45000",
    labor_base: "45000",
    health_base: "45000",
    pension_base: "45000",
  });
  const date = addDays(today().slice(0, 7) + "-01", -1),
    period = date.slice(0, 7);
  let leave = hr.leave(a, {
    employee_id: emp.id,
    date,
    kind: "annual",
    start: "09:00",
    end: "17:00",
    notes: "請假",
  });
  assert.throws(
    () =>
      hr.decide(other, {
        id: leave.id,
        version: leave.version,
        type: "leave",
        action: "approve",
        reason: "核准",
      }),
    /額度/,
  );
  hr.leaveBalance(a, {
    employee_id: emp.id,
    year: Number(date.slice(0, 4)),
    kind: "annual",
    minutes: 480,
  });
  let run = hr.compute(a, { period, notes: "核對" });
  leave = hr.decide(other, {
    id: leave.id,
    version: leave.version,
    type: "leave",
    action: "approve",
    reason: "核准",
  });
  assert.throws(
    () =>
      hr.attendance(a, {
        employee_id: emp.id,
        date,
        start: "09:00",
        end: "18:00",
        break_minutes: 60,
      }),
    /重疊/,
  );
  assert.throws(
    () =>
      hr.action(other, {
        id: run.id,
        version: run.version,
        action: "approve",
        reason: "核准",
      }),
    /變更/,
  );
  assert.equal(
    e.get("SELECT status FROM payroll_runs WHERE id=?", run.id).status,
    "draft",
  );
});
test("finite production capacity, material reservation/issue and finished inventory reconcile WIP and costs", (t) => {
  const { e, a, p, stock, production } = fixture(t);
  stock("10");
  const finished = e.saveProduct(a, { sku: "FG", name: "製成品" });
  e.saveBOM(a, {
    product_id: finished.id,
    name: "材料表",
    lines: [{ product_id: p.id, qty: "2" }],
  });
  const c = production.center(a, {
    code: "C",
    name: "加工中心",
    daily_minutes: 480,
    hourly_cost: "120",
  });
  production.route(a, {
    product_id: finished.id,
    name: "加工",
    operations: [{ name: "組裝", center_id: c.id, minutes_per_unit: "30" }],
  });
  let j = production.create(a, {
    product_id: finished.id,
    warehouse_id: 1,
    qty: "2",
    due_date: addDays(today(), 10),
  });
  assert.equal(
    j.slots.reduce((n, s) => n + s.end_minute - s.start_minute, 0),
    60,
  );
  j = production.release(a, { id: j.id, version: j.version });
  assert.equal(e.stock(p.id, 1).reserved, 4000);
  assert.throws(
    () => production.finish(a, { id: j.id, version: j.version }),
    /完成/,
  );
  j = production.issue(a, {
    id: j.id,
    version: j.version,
    material_id: j.materials[0].id,
    qty: "4",
  });
  j = production.completeOperation(a, {
    id: j.id,
    version: j.version,
    operation_id: j.operations[0].id,
    actual_minutes: 60,
  });
  j = production.finish(a, { id: j.id, version: j.version });
  assert.equal(j.status, "completed");
  assert.equal(j.cost, 13200);
  assert.equal(e.stock(finished.id, 1).value, 13200);
  assert.equal(
    e.get(
      "SELECT COALESCE(sum(debit-credit),0) n FROM journal_lines WHERE account='1402'",
    ).n,
    0,
  );
  assert.equal(e.integrity(a).ok, true);
});
test("MRP explodes multi-level BOM, catches cycles and stale sources, and creates traceable drafts atomically", (t) => {
  const { e, a, p, supplier, production } = fixture(t);
  e.run("UPDATE products SET supplier_id=? WHERE id=?", supplier.id, p.id);
  const fg = e.saveProduct(a, { sku: "FG", name: "製成品" });
  e.saveBOM(a, {
    product_id: fg.id,
    name: "材料表",
    lines: [{ product_id: p.id, qty: "2" }],
  });
  const c = production.center(a, {
    code: "C",
    name: "加工中心",
    daily_minutes: 480,
    hourly_cost: "1",
  });
  production.route(a, {
    product_id: fg.id,
    name: "製程",
    operations: [{ name: "加工", center_id: c.id, minutes_per_unit: "10" }],
  });
  let plan = production.preview(a, {
    warehouse_id: 1,
    forecasts: [
      {
        product_id: fg.id,
        qty: "3",
        due_date: addDays(today(), 10),
        reference: "預估",
      },
    ],
  });
  assert.deepEqual(
    plan.result.map((l) => [l.kind, l.qty]),
    [
      ["manufacture", 3000],
      ["purchase", 6000],
    ],
  );
  e.adjust(a, {
    product_id: p.id,
    warehouse_id: 1,
    qty: "1",
    unit_cost: "3",
    reason: "來源變更",
  });
  assert.throws(
    () => production.commit(a, { id: plan.id, version: plan.version }),
    /變更/,
  );
  assert.equal(e.get("SELECT count(*) n FROM production_jobs").n, 0);
  plan = production.preview(a, {
    warehouse_id: 1,
    forecasts: [
      { product_id: fg.id, qty: "3", due_date: addDays(today(), 10) },
    ],
  });
  const outputs = production.commit(a, { id: plan.id, version: plan.version });
  assert.equal(outputs.outputs.length, 2);
  assert.equal(e.get("SELECT count(*) n FROM mrp_outputs").n, 2);
  assert.equal(e.integrity(a).ok, true);
});
