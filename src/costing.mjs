import {
  permit,
  has,
  fail,
  scaled,
  integer,
  ratio,
  txt,
  dateValue,
  today,
  now,
} from "./core.mjs";
import { createHash } from "node:crypto";
export function enforceStandardCost(e, u, product, warehouse, reference) {
  if (e.standardRevaluation) return;
  const policy = e.get(
    "SELECT method FROM cost_policies WHERE effective_date<=? ORDER BY effective_date DESC,id DESC LIMIT 1",
    today(),
  );
  if (policy?.method !== "standard") return;
  const standard = e.get(
    "SELECT cost FROM standard_costs WHERE product_id=?",
    product,
  );
  if (!standard) fail("標準成本政策下，商品需先設定標準成本", 409);
  const s = e.stock(product, warehouse),
    target = ratio(s.qty, standard.cost, 1000),
    difference = target - s.value;
  if (!difference) return;
  e.standardRevaluation = true;
  try {
    e.stockMove(
      u,
      product,
      warehouse,
      0,
      difference,
      "standard_variance",
      reference,
      "標準成本差異",
    );
    e.journal(
      u,
      "標準成本差異",
      reference,
      difference > 0
        ? [
            ["1200", difference, 0],
            ["5100", 0, difference],
          ]
        : [
            ["5100", -difference, 0],
            ["1200", 0, -difference],
          ],
    );
  } finally {
    e.standardRevaluation = false;
  }
}
const digest = (v) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export class Costing {
  constructor(e) {
    this.e = e;
  }
  standards(u, b) {
    permit(u, "finance");
    if (!has(u, "cost")) fail("沒有修改標準成本的權限", 403);
    const e = this.e;
    if (!Array.isArray(b.rows) || !b.rows.length || b.rows.length > 2000)
      fail("需 1–2,000 筆標準成本");
    const seen = new Set();
    for (const row of b.rows) {
      const p = e.product(row.product_id);
      if (seen.has(p.id)) fail("商品重複");
      seen.add(p.id);
      const old = e.get(
        "SELECT * FROM standard_costs WHERE product_id=?",
        p.id,
      );
      if ((old?.version || 0) !== integer(row.version || 0))
        fail("標準成本已更新", 409);
      e.run(
        "INSERT INTO standard_costs(product_id,cost) VALUES(?,?) ON CONFLICT(product_id) DO UPDATE SET cost=excluded.cost,version=version+1",
        p.id,
        scaled(row.cost),
      );
    }
    for (const s of e.all("SELECT * FROM stocks"))
      enforceStandardCost(
        e,
        u,
        s.product_id,
        s.warehouse_id,
        "STANDARD-" + today(),
      );
    e.log(u, "standard_costs", "cost_policy", 1, {
      rows: b.rows,
      reason: txt(b.reason, 1000, true),
    });
    return { ok: true };
  }
  policy(u, b) {
    permit(u, "admin");
    const e = this.e,
      method = b.method;
    if (!["moving", "standard", "monthly"].includes(method))
      fail("成本政策錯誤");
    const date = dateValue(b.effective_date);
    if (date !== today())
      fail("成本政策切換以今天生效，不能回改歷史或預設未來政策");
    e.checkPeriod(date, "inventory");
    const reason = txt(b.reason, 1000, true);
    if (
      method === "standard" &&
      e.get(
        "SELECT p.id FROM products p LEFT JOIN standard_costs s ON s.product_id=p.id WHERE p.active=1 AND p.track_stock=1 AND s.product_id IS NULL LIMIT 1",
      )
    )
      fail("需先完成全部庫存商品的標準成本");
    const id = Number(
      e.run(
        "INSERT INTO cost_policies(method,effective_date,reason,created_by,created_at) VALUES(?,?,?,?,?)",
        method,
        date,
        reason,
        u.id,
        now(),
      ).lastInsertRowid,
    );
    if (method === "standard")
      for (const s of e.all("SELECT * FROM stocks"))
        enforceStandardCost(
          e,
          u,
          s.product_id,
          s.warehouse_id,
          "COST-POLICY-" + id,
        );
    e.log(u, "cost_policy", "cost_policy", id, { method, date, reason });
    return { id };
  }
  monthlyPreview(u, b) {
    permit(u, "finance");
    const e = this.e,
      date = dateValue(b.date),
      start = date.slice(0, 7) + "-01";
    if (date > today()) fail("不可結算未來成本");
    const policy = e.get(
      "SELECT * FROM cost_policies WHERE effective_date<=? ORDER BY effective_date DESC,id DESC LIMIT 1",
      date,
    );
    if (policy?.method !== "monthly") fail("此期間未啟用月加權政策");
    if (policy.effective_date > start)
      fail("月加權需從月初啟用；首次不足整月請於下月結算");
    if (
      e.get(
        "SELECT id FROM costing_runs WHERE method='monthly' AND substr(date,1,7)=?",
        date.slice(0, 7),
      )
    )
      fail("本月已完成成本結算，不能重複計算", 409);
    const moves = e.all(
        "SELECT m.*,COALESCE(f.date,j.date,date(m.created_at,'+8 hours')) effective_date FROM stock_moves m LEFT JOIN fulfilments f ON f.no=m.reference LEFT JOIN (SELECT reference,min(date) date FROM journals GROUP BY reference) j ON j.reference=m.reference ORDER BY m.id",
      ),
      unsupported = moves.find(
        (m) =>
          m.effective_date >= start &&
          m.effective_date <= date &&
          ![
            "receipt",
            "shipment",
            "transfer",
            "adjustment",
            "opening",
            "nontrade_receipt",
            "sales_return",
            "purchase_return",
            "purchase_allowance",
            "expense_allocation",
          ].includes(m.kind),
      );
    if (unsupported)
      fail(
        "本月含組拆裝、借用或其他需另行核對的成本來源，請先由財務核對：" +
          unsupported.kind,
        409,
      );
    if (moves.some((m) => m.effective_date > date))
      fail("截止日之後已有庫存異動，不能回溯覆寫後續成本", 409);
    if (
      moves.some(
        (m) =>
          m.effective_date >= start &&
          m.effective_date <= date &&
          m.kind === "adjustment" &&
          m.qty < 0,
      )
    )
      fail("含非銷貨出庫的月份需先人工核對損益分派", 409);
    const products = new Map();
    for (const m of moves) {
      if (m.effective_date > date) continue;
      let p = products.get(m.product_id);
      if (!p) {
        p = {
          product_id: m.product_id,
          opening_qty: 0,
          opening_value: 0,
          in_qty: 0,
          in_value: 0,
        };
        products.set(m.product_id, p);
      }
      if (m.effective_date < start) {
        p.opening_qty += m.qty;
        p.opening_value += m.value;
      } else if (m.kind !== "transfer" && m.qty > 0) {
        p.in_qty += m.qty;
        p.in_value += m.value;
      } else if (m.kind === "purchase_return") {
        const value = e.get(
            "SELECT COALESCE(sum(CAST((fl.cost*rl.qty+fl.qty/2)/fl.qty AS INTEGER)),0) n FROM return_lines rl JOIN returns r ON r.id=rl.return_id JOIN fulfilment_lines fl ON fl.id=rl.fulfilment_line_id WHERE r.no=? AND fl.product_id=?",
            m.reference,
            m.product_id,
          ).n,
          discount = e.get(
            "SELECT COALESCE(sum(c.net),0) n FROM return_allowance_consumptions c JOIN returns r ON r.id=c.return_id JOIN allowance_lines a ON a.id=c.allowance_line_id JOIN fulfilment_lines fl ON fl.id=a.fulfilment_line_id WHERE r.no=? AND fl.product_id=? AND a.cost_policy='inventory'",
            m.reference,
            m.product_id,
          ).n;
        p.in_qty += m.qty;
        p.in_value -= value - discount;
      } else if (["purchase_allowance", "expense_allocation"].includes(m.kind))
        p.in_value += m.value;
    }
    const rows = [];
    for (const p of products.values()) {
      const quantity = p.opening_qty + p.in_qty,
        value = p.opening_value + p.in_value;
      if (value < 0) fail("月成本基礎為負，需人工核對");
      const warehouses = e.all(
        "SELECT s.*,p.sku,p.name FROM stocks s JOIN products p ON p.id=s.product_id WHERE s.product_id=? ORDER BY s.warehouse_id",
        p.product_id,
      );
      for (const s of warehouses) {
        const target = quantity ? ratio(value, s.qty, quantity) : 0;
        rows.push({
          ...p,
          sku: s.sku,
          name: s.name,
          warehouse_id: s.warehouse_id,
          qty: s.qty,
          old_value: s.value,
          new_value: target,
          difference: target - s.value,
        });
      }
    }
    const token = digest({
      policy,
      rows,
      date,
      moves: moves.map((m) => [m.id, m.qty, m.value]),
    });
    return {
      date,
      start,
      rows,
      token,
      policy_id: policy.id,
      note: "月內採暫時計價，月末結算將存貨差額轉入銷貨成本。含組拆裝、借用等複合成本來源須另行核對，系統會阻擋自動結算。",
    };
  }
  monthly(u, b) {
    permit(u, "admin");
    const e = this.e,
      p = this.monthlyPreview(u, b),
      date = p.date,
      last = new Date(
        Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0),
      )
        .toISOString()
        .slice(0, 10);
    if (date !== last) fail("正式月加權結算需選月末日期");
    if (b.token !== p.token) fail("庫存或政策已更新，請重新預覽", 409);
    e.checkPeriod(date, "inventory");
    const no = e.number("MC"),
      reason = txt(b.reason, 1000, true);
    for (const r of p.rows) {
      if (!r.difference) continue;
      e.stockMove(
        u,
        r.product_id,
        r.warehouse_id,
        0,
        r.difference,
        "monthly_cost",
        no,
        reason,
      );
      e.journal(
        u,
        "月加權結算差異",
        no,
        r.difference > 0
          ? [
              ["1200", r.difference, 0],
              ["5000", 0, r.difference],
            ]
          : [
              ["5000", -r.difference, 0],
              ["1200", 0, -r.difference],
            ],
        date,
      );
    }
    const id = Number(
      e.run(
        "INSERT INTO costing_runs(no,method,date,details,created_by,created_at) VALUES(?,?,?,?,?,?)",
        no,
        "monthly",
        date,
        JSON.stringify(p.rows),
        u.id,
        now(),
      ).lastInsertRowid,
    );
    const old = e.get(
      "SELECT closed_until FROM module_closings WHERE module='inventory'",
    );
    if (!old || old.closed_until < date)
      e.run(
        "INSERT INTO module_closings(module,closed_until) VALUES('inventory',?) ON CONFLICT(module) DO UPDATE SET closed_until=excluded.closed_until,version=version+1",
        date,
      );
    e.run(
      "INSERT INTO closing_events(module,previous_date,new_date,reason,created_by,created_at) VALUES(?,?,?,?,?,?)",
      "inventory",
      old?.closed_until || "",
      date,
      "月加權結算：" + reason,
      u.id,
      now(),
    );
    e.log(u, "monthly_cost", "costing_run", id, { no, date, reason });
    return { id, no };
  }
}
