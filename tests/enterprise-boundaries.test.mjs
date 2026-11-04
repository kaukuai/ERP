import test from "node:test";
import assert from "node:assert/strict";
import { ERP, today, addDays } from "../src/core.mjs";
import { WarehouseManagement } from "../src/warehouse-management.mjs";
import { InventoryTracking } from "../src/inventory-tracking.mjs";
import { ForeignExchange } from "../src/foreign-exchange.mjs";
import { Production } from "../src/production.mjs";
import { HRPayroll, taiwanPolicyTemplate } from "../src/hr-payroll.mjs";
import { Finance } from "../src/finance.mjs";
function fixture(t) {
  const e = new ERP();
  t.after(() => e.close());
  const a = e.setup({ username: "admin", password: "boundary-fixture-2026" }),
    f = new Finance(e),
    supplier = e.savePartner(a, {
      code: "V",
      name: "供應商",
      kind: "supplier",
    }),
    customer = e.savePartner(a, { code: "C", name: "客戶" }),
    p = e.saveProduct(a, {
      sku: "RAW",
      name: "材料",
      cost: "3",
      supplier_id: supplier.id,
    }),
    bank = f.saveBank(a, {
      code: "B",
      name: "銀行",
      kind: "bank",
      opening_balance: "1000000",
    });
  return {
    e,
    a,
    f,
    p,
    bank,
    supplier,
    customer,
    wms: new WarehouseManagement(e),
    fx: new ForeignExchange(e),
    m: new Production(e),
    hr: new HRPayroll(e),
  };
}
test("FEFO wave shipments preserve exact per-lot bin and warehouse balances", (t) => {
  const { e, a, p, wms, customer } = fixture(t);
  new InventoryTracking(e).configure(a, {
    product_id: p.id,
    version: p.version,
    tracking_mode: "lot",
  });
  for (const [code, expiry, qty] of [
    ["LATE", "2099-01-01", "5"],
    ["FIRST", "2098-01-01", "4"],
  ])
    e.adjust(a, {
      product_id: p.id,
      warehouse_id: 1,
      qty,
      unit_cost: "3",
      reason: "批號期初",
      lots: [{ product_id: p.id, code, expiry, qty }],
    });
  wms.enable(a, { warehouse_id: 1, version: 0 });
  const receiving = e.get("SELECT * FROM storage_bins WHERE kind='receiving'"),
    pick = wms.saveBin(a, {
      warehouse_id: 1,
      code: "PICK",
      name: "揀貨",
      kind: "pick",
    });
  for (const [code, qty] of [
    ["LATE", "5"],
    ["FIRST", "4"],
  ])
    wms.transfer(a, {
      from_bin_id: receiving.id,
      to_bin_id: pick.id,
      product_id: p.id,
      lot_code: code,
      qty,
      reason: "上架",
    });
  let d = e.saveDoc(a, {
    kind: "order",
    partner_id: customer.id,
    warehouse_id: 1,
    lines: [{ product_id: p.id, qty: "6", price: "10" }],
  });
  d = e.transition(a, d.id, "submit");
  d = e.transition(a, d.id, "approve");
  let w = wms.createWave(a, { warehouse_id: 1, document_ids: [d.id] });
  assert.deepEqual(
    w.lines[0].allocations
      .map((r) => [r.lot_code, r.qty])
      .sort((a, b) => a[0].localeCompare(b[0])),
    [
      ["FIRST", 4000],
      ["LATE", 2000],
    ],
  );
  w = wms.postWave(a, { id: w.id, version: w.version });
  assert.equal(w.status, "posted");
  assert.deepEqual(
    e
      .all("SELECT code,qty FROM inventory_lots ORDER BY code")
      .map((r) => [r.code, r.qty]),
    [
      ["FIRST", 0],
      ["LATE", 3000],
    ],
  );
  assert.equal(e.get("SELECT sum(qty) n FROM bin_balances").n, 3000);
  assert.equal(e.integrity(a).ok, true);
});
test("all FX activities can be reversed in true reverse order, then the original voucher can be reversed", (t) => {
  const { e, a, fx, customer, bank } = fixture(t);
  const day = addDays(today(), -2);
  fx.rate(a, { currency: "USD", date: day, rate: "30", source: "測試" });
  let r = fx.create(a, {
    kind: "receivable",
    partner_id: customer.id,
    currency: "USD",
    date: day,
    lines: [{ account: "4000", description: "服務", amount: "10" }],
  });
  r = fx.post(a, { id: r.id, version: r.version });
  fx.rate(a, {
    currency: "USD",
    date: addDays(today(), -1),
    rate: "31",
    source: "測試",
  });
  const v = fx.valuation(a, {
    date: addDays(today(), -1),
    account_ids: [r.id],
  });
  r = fx.account(a, r.id);
  r = fx.settle(a, {
    id: r.id,
    version: r.version,
    date: today(),
    amount: "4",
    bank_account_id: bank.id,
  });
  r = fx.settle(a, {
    id: r.id,
    version: r.version,
    date: today(),
    amount: "6",
    bank_account_id: bank.id,
  });
  assert.throws(
    () =>
      fx.reverseValuation(a, {
        valuation_id: v.id,
        date: today(),
        reason: "錯序",
      }),
    /後續/,
  );
  for (const s of [...r.settlements].reverse())
    r = fx.reverseSettlement(a, {
      settlement_id: s.id,
      version: r.version,
      date: today(),
      reason: "逐筆沖回",
    });
  fx.reverseValuation(a, {
    valuation_id: v.id,
    date: today(),
    reason: "最後沖回評價",
  });
  r = fx.account(a, r.id);
  r = fx.cancel(a, {
    id: r.id,
    version: r.version,
    date: today(),
    reason: "原始憑證更正",
  });
  assert.equal(r.status, "cancelled");
  for (const code of ["1102", "4300", "4301"])
    assert.equal(
      e.get(
        "SELECT COALESCE(sum(debit-credit),0) n FROM journal_lines WHERE account=?",
        code,
      ).n,
      0,
    );
  assert.equal(e.integrity(a).ok, true);
});
test("payroll other deductions remain taxable, statutory remittances reconcile, own payslips exclude colleagues and exports preserve bank leading zeros", (t) => {
  const { e, a, f, hr, bank } = fixture(t),
    period = addDays(today().slice(0, 7) + "-01", -1).slice(0, 7);
  hr.configure(a, {
    effective_date: "2026-01-01",
    confirm_rules: true,
    definition: {
      ...taiwanPolicyTemplate,
      forbid_self_approval: false,
      source: "核定測試政策",
    },
  });
  e.saveUser(a, {
    username: "staff",
    name: "員工甲",
    role: "sales",
    password: "boundary-fixture-2026",
  });
  const staff = e.user(e.get("SELECT id FROM users WHERE username='staff'").id),
    emps = [];
  for (const [code, name, user] of [
    ["E1", "員工甲", staff.id],
    ["E2", "保密同事乙", null],
  ]) {
    const emp = f.saveEmployee(a, {
      code,
      name,
      user_id: user,
      joined_date: "2026-01-01",
    });
    emps.push(emp);
    hr.terms(a, {
      employee_id: emp.id,
      effective_date: "2026-01-01",
      salary_kind: "monthly",
      amount: "45000",
      labor_base: "45000",
      health_base: "45000",
      pension_base: "45000",
    });
    hr.profile(a, {
      employee_id: emp.id,
      tax_identifier: code === "E1" ? "A123456789" : "B123456789",
      address: "測試地址",
      bank_name: "測試分行",
      bank_account: "0012345678",
    });
  }
  let r = hr.compute(a, {
    period,
    notes: "本期核對",
    adjustments: [{ employee_id: emps[0].id, deduction: "1000" }],
  });
  assert.equal(r.lines.find((l) => l.employee_id === emps[0].id).tax, 225000);
  assert.equal(
    r.lines.find((l) => l.employee_id === emps[0].id).net_pay,
    3992700,
  );
  r = hr.action(a, {
    id: r.id,
    version: r.version,
    action: "approve",
    reason: "核定",
  });
  r = hr.action(a, {
    id: r.id,
    version: r.version,
    action: "post",
    reason: "提列",
  });
  assert.equal(
    e.get("SELECT sum(credit-debit) n FROM journal_lines WHERE account='2506'")
      .n,
    100000,
  );
  r = hr.remittance(a, {
    id: r.id,
    version: r.version,
    kind: "tax",
    amount: "1000",
    bank_account_id: bank.id,
    reference: "稅單參考",
  });
  assert.equal(e.integrity(a).ok, true);
  assert.throws(
    () =>
      hr.action(a, {
        id: r.id,
        version: r.version,
        action: "reverse",
        reason: "重作",
      }),
    /繳納/,
  );
  const own = hr.run(staff, r.id);
  assert.equal(own.lines.length, 1);
  assert.equal(own.lines[0].employee_id, emps[0].id);
  const print = hr.payslip(staff, r.id, own.lines[0].id);
  assert.match(print, /員工甲/);
  assert.doesNotMatch(print, /保密同事乙/);
  assert.throws(
    () =>
      hr.payslip(
        staff,
        r.id,
        r.lines.find((l) => l.employee_id === emps[1].id).id,
      ),
    /無權/,
  );
  const csv = hr.export(a, r.id);
  assert.match(csv.csv, /"0012345678"/);
  assert.match(csv.csv, /"45000"/);
  assert.equal(e.integrity(a).ok, true);
});
test("subcontract receipts cannot bypass custody/WIP, partial returns reconcile and direct service credit is blocked", (t) => {
  const { e, a, p, supplier, m } = fixture(t);
  e.adjust(a, {
    product_id: p.id,
    warehouse_id: 1,
    qty: "10",
    unit_cost: "3",
    reason: "材料",
  });
  const fg = e.saveProduct(a, { sku: "FG", name: "製成品" }),
    service = e.saveProduct(a, {
      sku: "SUB-FEE",
      name: "委外加工",
      track_stock: false,
    });
  m.bom(a, {
    product_id: fg.id,
    name: "材料表",
    lines: [{ product_id: p.id, qty: "1" }],
  });
  m.route(a, {
    product_id: fg.id,
    name: "委外",
    operations: [
      {
        name: "委外加工",
        supplier_id: supplier.id,
        service_product_id: service.id,
        unit_fee: "10",
        lead_days: 1,
      },
    ],
  });
  let j = m.create(a, {
    product_id: fg.id,
    warehouse_id: 1,
    qty: "2",
    due_date: addDays(today(), 10),
  });
  j = m.release(a, { id: j.id, version: j.version });
  assert.equal(e.integrity(a).ok, true);
  j = m.issue(a, {
    id: j.id,
    version: j.version,
    material_id: j.materials[0].id,
    qty: "2",
  });
  j = m.send(a, {
    id: j.id,
    version: j.version,
    operation_id: j.operations[0].id,
    reference: "送出單",
  });
  let po = e.doc(a, j.operations[0].po_document_id);
  po = e.transition(a, po.id, "submit");
  po = e.transition(a, po.id, "approve");
  assert.throws(() => e.fulfil(a, po.id, {}), /工序回貨/);
  j = m.receive(a, {
    id: j.id,
    version: j.version,
    operation_id: j.operations[0].id,
    qty: "1",
    reference: "回貨1",
  });
  const f = e.get("SELECT * FROM fulfilments WHERE document_id=?", po.id),
    line = e.get("SELECT * FROM fulfilment_lines WHERE fulfilment_id=?", f.id);
  assert.throws(
    () =>
      e.returnGoods(a, {
        fulfilment_id: f.id,
        lines: [{ line_id: line.id, qty: "1" }],
        reason: "直接退費",
      }),
    /製造更正/,
  );
  assert.equal(e.get("SELECT count(*) n FROM returns").n, 0);
  j = m.receive(a, {
    id: j.id,
    version: j.version,
    operation_id: j.operations[0].id,
    qty: "1",
    reference: "回貨2",
  });
  assert.equal(j.operations[0].cost, 2000);
  j = m.finish(a, { id: j.id, version: j.version });
  assert.equal(j.cost, 2600);
  assert.equal(
    e.get("SELECT sum(qty) n FROM subcontract_custody WHERE kind='receive'").n,
    2000,
  );
  assert.equal(e.integrity(a).ok, true);
});
test("multi-level MRP prevents cycles, creates children before parents and does not duplicate its existing planned supply", (t) => {
  const { e, a, p, m, supplier } = fixture(t);
  e.run("UPDATE products SET supplier_id=? WHERE id=?", supplier.id, p.id);
  const semi = e.saveProduct(a, { sku: "SEMI", name: "半成品" }),
    fg = e.saveProduct(a, { sku: "FG", name: "製成品" }),
    c = m.center(a, {
      code: "C",
      name: "中心",
      daily_minutes: 480,
      hourly_cost: "1",
    });
  let sb = m.bom(a, {
    product_id: semi.id,
    name: "半成品材料",
    lines: [{ product_id: p.id, qty: "2" }],
  });
  m.bom(a, {
    product_id: fg.id,
    name: "製成品材料",
    lines: [{ product_id: semi.id, qty: "3" }],
  });
  assert.throws(
    () =>
      m.bom(a, {
        product_id: semi.id,
        version: sb.version,
        name: "循環",
        lines: [{ product_id: fg.id, qty: "1" }],
      }),
    /循環/,
  );
  for (const pr of [semi, fg])
    m.route(a, {
      product_id: pr.id,
      name: "路線",
      operations: [{ name: "加工", center_id: c.id, minutes_per_unit: "1" }],
    });
  const forecasts = [
      { product_id: fg.id, qty: "2", due_date: addDays(today(), 14) },
    ],
    plan = m.preview(a, { warehouse_id: 1, forecasts });
  assert.deepEqual(
    plan.result.map((l) => l.qty),
    [2000, 6000, 12000],
  );
  const committed = m.commit(a, { id: plan.id, version: plan.version });
  assert.ok(committed.outputs[0].document_id);
  const jobs = e.all("SELECT * FROM production_jobs ORDER BY id");
  assert.equal(jobs[0].product_id, semi.id);
  assert.equal(jobs[1].product_id, fg.id);
  const again = m.preview(a, { warehouse_id: 1, forecasts });
  assert.deepEqual(again.result, []);
  assert.equal(e.integrity(a).ok, true);
});
