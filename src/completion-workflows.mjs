import { createHash } from "node:crypto";
import {
  permit,
  has,
  fail,
  integer,
  scaled,
  ratio,
  txt,
  dateValue,
  today,
  now,
} from "./core.mjs";
import { Costing } from "./costing.mjs";
import { legacySales } from "./access-control.mjs";
import { readCSV, readXLSX } from "./tabular.mjs";
import { Finance } from "./finance.mjs";
import { Operations, printPage } from "./operations.mjs";
import { tradingReport } from "./reports.mjs";
import { FUND_ACCOUNTS } from "./rules.mjs";
const hash = (b) =>
  createHash("sha256").update(JSON.stringify(b)).digest("hex");
const E = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const immutable = (e, u, action, id, detail) =>
  e.log(u, action, "completion", id, detail);
export class CompletionWorkflows {
  constructor(e) {
    this.e = e;
    this.costing = new Costing(e);
  }
  standards(u, b) {
    return this.costing.standards(u, b);
  }
  costPolicy(u, b) {
    return this.costing.policy(u, b);
  }
  monthlyCostPreview(u, b) {
    return this.costing.monthlyPreview(u, b);
  }
  monthlyCost(u, b) {
    return this.costing.monthly(u, b);
  }
  data(u) {
    const e = this.e;
    return {
      product_categories: e.all(
        "SELECT * FROM product_categories ORDER BY code",
      ),
      custom_field_definitions: e
        .all("SELECT * FROM custom_field_definitions ORDER BY code")
        .map((x) => ({ ...x, options: JSON.parse(x.options) })),
      product_custom_values: e.all("SELECT * FROM product_custom_values"),
      user_preferences: e.get(
        "SELECT * FROM user_preferences WHERE user_id=?",
        u.id,
      ) || {
        quantity_digits: 3,
        money_digits: 2,
        input_order: "qty,price,discount_bp",
      },
      module_closings: has(u, "admin")
        ? e.all("SELECT * FROM module_closings")
        : [],
      stock_documents: e.all(
        "SELECT s.*,a.name from_name,b.name to_name FROM stock_documents s LEFT JOIN warehouses a ON a.id=s.from_id LEFT JOIN warehouses b ON b.id=s.to_id ORDER BY s.id DESC LIMIT 500",
      ),
      replenishment_policies: e.all("SELECT * FROM replenishment_policies"),
      disassemblies: e.all(
        "SELECT * FROM disassemblies ORDER BY id DESC LIMIT 500",
      ),
      cost_policies: has(u, "cost")
        ? e.all("SELECT * FROM cost_policies ORDER BY id DESC")
        : [],
      standard_costs: has(u, "cost")
        ? e.all("SELECT * FROM standard_costs")
        : [],
      costing_runs: has(u, "cost")
        ? e.all("SELECT * FROM costing_runs ORDER BY id DESC LIMIT 120")
        : [],
    };
  }
  preferences(u, b) {
    const order = txt(b.input_order, 100).split(",");
    if (
      order.length !== 3 ||
      new Set(order).size !== 3 ||
      !["qty", "price", "discount_bp"].every((x) => order.includes(x))
    )
      fail("輸入順序必須包含數量、單價與折扣");
    this.e.run(
      "INSERT INTO user_preferences VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET quantity_digits=excluded.quantity_digits,money_digits=excluded.money_digits,input_order=excluded.input_order",
      u.id,
      integer(b.quantity_digits, 0, 3),
      integer(b.money_digits, 0, 2),
      order.join(","),
    );
    return { ok: true };
  }
  category(u, b) {
    permit(u, "masters");
    const e = this.e,
      id = b.id ? integer(b.id, 1) : 0,
      parent = b.parent_id ? integer(b.parent_id, 1) : null;
    let n = parent,
      seen = new Set(id ? [id] : []);
    while (n) {
      if (seen.has(n)) fail("分類不可形成循環");
      seen.add(n);
      const p = e.get("SELECT * FROM product_categories WHERE id=?", n);
      if (!p) fail("上層分類不存在");
      n = p.parent_id;
    }
    if (id) {
      const old = e.get("SELECT * FROM product_categories WHERE id=?", id);
      if (!old || old.version !== integer(b.version, 1))
        fail("分類已被修改", 409);
      e.run(
        "UPDATE product_categories SET code=?,name=?,parent_id=?,version=version+1 WHERE id=?",
        txt(b.code, 50, true),
        txt(b.name, 100, true),
        parent,
        id,
      );
    } else
      e.run(
        "INSERT INTO product_categories(code,name,parent_id) VALUES(?,?,?)",
        txt(b.code, 50, true),
        txt(b.name, 100, true),
        parent,
      );
    immutable(e, u, "category", id, b);
    return { ok: true };
  }
  customDefinition(u, b) {
    permit(u, "masters");
    const e = this.e,
      id = b.id ? integer(b.id, 1) : 0,
      type = b.type;
    if (
      !["text", "number", "date", "choice", "boolean"].includes(type) ||
      !/^[a-z][a-z0-9_]{0,39}$/.test(b.code)
    )
      fail("自訂欄位代碼或型別錯誤");
    const options =
      type === "choice" ? (b.options || []).map((x) => txt(x, 100, true)) : [];
    if (
      options.length > 100 ||
      (type === "choice" && !options.length) ||
      new Set(options).size !== options.length
    )
      fail("選項需為 1–100 個不重複文字");
    const vals = [
      txt(b.code, 40, true),
      txt(b.label, 100, true),
      type,
      b.required === true ? 1 : 0,
      JSON.stringify(options),
      b.active === false ? 0 : 1,
    ];
    if (id) {
      const old = e.get(
        "SELECT * FROM custom_field_definitions WHERE id=?",
        id,
      );
      if (!old || old.version !== integer(b.version, 1))
        fail("欄位已更新", 409);
      if (
        old.type !== type &&
        e.get(
          "SELECT product_id FROM product_custom_values WHERE field_id=? LIMIT 1",
          id,
        )
      )
        fail("已有資料的欄位不可變更型別");
      e.run(
        "UPDATE custom_field_definitions SET code=?,label=?,type=?,required=?,options=?,active=?,version=version+1 WHERE id=?",
        ...vals,
        id,
      );
    } else
      e.run(
        "INSERT INTO custom_field_definitions(code,label,type,required,options,active) VALUES(?,?,?,?,?,?)",
        ...vals,
      );
    immutable(e, u, "custom_field", id, b);
    return { ok: true };
  }
  productAttributes(u, b) {
    permit(u, "masters");
    const e = this.e,
      p = e.product(b.product_id);
    if (p.version !== integer(b.version, 1)) fail("商品已更新", 409);
    const cat = b.category_id
      ? e.get(
          "SELECT * FROM product_categories WHERE id=?",
          integer(b.category_id, 1),
        )
      : null;
    if (b.category_id && !cat) fail("分類不存在");
    const fields = e.all(
        "SELECT * FROM custom_field_definitions WHERE active=1",
      ),
      values = b.values || {};
    for (const k of Object.keys(values))
      if (!fields.some((f) => f.code === k)) fail("含未知自訂欄位");
    for (const f of fields) {
      const value = txt(String(values[f.code] ?? ""), 1000);
      if (f.required && !value) fail(f.label + "為必填");
      if (value) {
        if (f.type === "number" && !/^-?\d{1,12}(\.\d{1,6})?$/.test(value))
          fail(f.label + "需為數字");
        if (f.type === "date") dateValue(value);
        if (f.type === "boolean" && !["0", "1"].includes(value))
          fail(f.label + "需為 0 或 1");
        if (f.type === "choice" && !JSON.parse(f.options).includes(value))
          fail(f.label + "選項錯誤");
      }
      e.run(
        "INSERT INTO product_custom_values VALUES(?,?,?) ON CONFLICT(product_id,field_id) DO UPDATE SET value=excluded.value",
        p.id,
        f.id,
        value,
      );
    }
    let path = [],
      cursor = cat;
    while (cursor) {
      path.unshift(cursor.name);
      cursor = cursor.parent_id
        ? e.get("SELECT * FROM product_categories WHERE id=?", cursor.parent_id)
        : null;
    }
    e.run(
      "UPDATE products SET category_id=?,category=?,version=version+1 WHERE id=?",
      cat?.id || null,
      path.join(" / "),
      p.id,
    );
    immutable(e, u, "product_attributes", p.id, {
      category_id: cat?.id,
      values,
    });
    return { ok: true };
  }
  openingFund(u, b) {
    permit(u, "finance");
    const e = this.e;
    if (!["customer_advance", "supplier_advance"].includes(b.kind))
      fail("期初預收付類型錯誤");
    const p = e.partner(
        u,
        b.partner_id,
        b.kind === "customer_advance" ? "customer" : "supplier",
      ),
      amount = scaled(b.amount, 2, 1),
      date = dateValue(b.date),
      reference = txt(b.reference, 300, true);
    e.checkPeriod(date);
    const no = e.number("OF"),
      id = Number(
        e.run(
          "INSERT INTO funds(no,kind,partner_id,amount,date,notes,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
          no,
          b.kind,
          p.id,
          amount,
          date,
          "期初預收付 " + reference,
          u.id,
          now(),
        ).lastInsertRowid,
      );
    e.run("INSERT INTO opening_funds VALUES(?,?)", id, reference);
    e.journal(
      u,
      "歷史期初預收付",
      no,
      b.kind === "customer_advance"
        ? [
            ["3000", amount, 0],
            [FUND_ACCOUNTS[b.kind], 0, amount],
          ]
        : [
            [FUND_ACCOUNTS[b.kind], amount, 0],
            ["3000", 0, amount],
          ],
      date,
    );
    immutable(e, u, "opening_fund", id, { reference, amount });
    return { id, no };
  }
  closingPreview(u, b) {
    permit(u, "admin");
    const e = this.e,
      date = b.closed_until ? dateValue(b.closed_until) : today();
    if (date > today()) fail("不可結帳至未來");
    const integrity = e.integrity(u),
      rows = e.all(
        "SELECT l.account,a.name,sum(l.debit) debit,sum(l.credit) credit,sum(l.debit-l.credit) balance FROM journal_lines l JOIN journals j ON j.id=l.journal_id JOIN accounts a ON a.code=l.account WHERE j.date<=? GROUP BY l.account ORDER BY l.account",
        date,
      ),
      state = {
        module: b.module,
        closed_until: b.closed_until || "",
        version: integer(b.version || 0),
        moves: e.get("SELECT COALESCE(max(id),0) n FROM stock_moves").n,
        journals: e.get("SELECT COALESCE(max(id),0) n FROM journals").n,
        rows,
        problems: integrity.problems,
      };
    return {
      ...state,
      valid: !b.closed_until || integrity.ok,
      token: hash(state),
      note: "結帳前核對總帳借貸、庫存與帳款控制科目；重開不刪除歷史事件。",
    };
  }
  closing(u, b) {
    permit(u, "admin");
    const e = this.e,
      module = b.module;
    if (!["trade", "inventory", "finance"].includes(module))
      fail("結帳模組錯誤");
    const preview = this.closingPreview(u, b);
    if (b.token && b.token !== preview.token)
      fail("試算後資料已異動，請重新預覽", 409);
    if (b.closed_until && !preview.valid)
      fail("帳務或庫存一致性檢查未通過，不能結帳", 409);
    const old = e.get("SELECT * FROM module_closings WHERE module=?", module),
      date = b.closed_until ? dateValue(b.closed_until) : "",
      reason = txt(b.reason, 1000, true);
    if (integer(b.version || 0) !== (old?.version || 0))
      fail("結帳設定已更新", 409);
    if (date > today()) fail("不可結帳至未來");
    e.run(
      "INSERT INTO module_closings(module,closed_until) VALUES(?,?) ON CONFLICT(module) DO UPDATE SET closed_until=excluded.closed_until,version=version+1",
      module,
      date,
    );
    e.run(
      "INSERT INTO closing_events(module,previous_date,new_date,reason,created_by,created_at) VALUES(?,?,?,?,?,?)",
      module,
      old?.closed_until || "",
      date,
      reason,
      u.id,
      now(),
    );
    immutable(e, u, "module_closing", module, {
      previous: old?.closed_until || "",
      date,
      reason,
    });
    return { ok: true };
  }
  stockDocument(u, b) {
    permit(u, "stock");
    const e = this.e,
      kind = b.kind;
    if (!["receipt", "issue", "transfer"].includes(kind))
      fail("庫存單類型錯誤");
    const from = kind !== "receipt" ? e.warehouse(b.from_id).id : null,
      to = kind !== "issue" ? e.warehouse(b.to_id).id : null;
    if (kind === "transfer" && from === to) fail("來源與目的倉不可相同");
    if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 200)
      fail("需 1–200 筆明細");
    const date = dateValue(b.date);
    e.checkPeriod(date, "inventory");
    const seen = new Set(),
      lines = b.lines.map((l) => {
        const p = e.product(l.product_id);
        if (!p.track_stock || seen.has(p.id)) fail("商品重複或不是庫存商品");
        seen.add(p.id);
        return {
          product_id: p.id,
          qty: scaled(l.qty, 3, 1),
          unit_cost: scaled(l.unit_cost ?? p.cost / 100),
          lots: l.lots || [],
        };
      });
    const no = e.number("SD"),
      id = Number(
        e.run(
          "INSERT INTO stock_documents(no,kind,from_id,to_id,date,notes,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
          no,
          kind,
          from,
          to,
          date,
          txt(b.notes, 1000, true),
          u.id,
          now(),
        ).lastInsertRowid,
      );
    for (const l of lines)
      e.run(
        "INSERT INTO stock_document_lines(document_id,product_id,qty,unit_cost,lots) VALUES(?,?,?,?,?)",
        id,
        l.product_id,
        l.qty,
        l.unit_cost,
        JSON.stringify(l.lots),
      );
    immutable(e, u, "stock_document", id, { kind });
    return this.stockDetail(u, id);
  }
  stockDetail(u, id) {
    permit(u, "all");
    const d = this.e.get(
      "SELECT * FROM stock_documents WHERE id=?",
      integer(id, 1),
    );
    if (!d) fail("庫存單不存在", 404);
    return {
      ...d,
      lines: this.e.all(
        "SELECT l.*,p.sku,p.name,p.unit FROM stock_document_lines l JOIN products p ON p.id=l.product_id WHERE l.document_id=?",
        d.id,
      ),
    };
  }
  stockAction(u, b) {
    const e = this.e,
      d = this.stockDetail(u, b.id);
    if (d.version !== integer(b.version, 1)) fail("庫存單已更新", 409);
    const action = b.action;
    e.checkPeriod(d.date, "inventory");
    if (action === "approve") {
      permit(u, "approve");
      if (d.status !== "draft") fail("只可核准草稿", 409);
      e.run(
        "UPDATE stock_documents SET status='approved',version=version+1 WHERE id=?",
        d.id,
      );
    } else if (action === "cancel") {
      permit(u, "approve");
      if (!["draft", "approved"].includes(d.status))
        fail("已異動庫存不可直接取消", 409);
      txt(b.reason, 500, true);
      e.run(
        "UPDATE stock_documents SET status='cancelled',version=version+1 WHERE id=?",
        d.id,
      );
    } else if (action === "post") {
      permit(u, "stock");
      if (d.status !== "approved") fail("需先核准", 409);
      let transit = null;
      if (d.kind === "transfer") {
        let wh = e.get("SELECT id FROM warehouses WHERE code='SYS-TRANSIT'");
        if (!wh) {
          const r = e.run(
            "INSERT INTO warehouses(code,name) VALUES(?,?)",
            "SYS-TRANSIT",
            "在途保管倉",
          );
          wh = { id: Number(r.lastInsertRowid) };
        }
        transit = wh.id;
        if ([d.from_id, d.to_id].includes(transit))
          fail("在途保管倉不能作為來源或目的倉");
      }
      let total = 0;
      for (const l of d.lines) {
        const value =
          d.kind === "receipt"
            ? ratio(l.qty, l.unit_cost, 1000)
            : e.costOut(l.product_id, d.from_id, l.qty);
        total += value;
        if (d.kind === "receipt")
          e.stockMove(
            u,
            l.product_id,
            d.to_id,
            l.qty,
            value,
            "nontrade_receipt",
            d.no,
            d.notes,
            { lots: JSON.parse(l.lots) },
          );
        else {
          e.stockMove(
            u,
            l.product_id,
            d.from_id,
            -l.qty,
            -value,
            d.kind === "transfer" ? "transfer" : "nontrade_issue",
            d.no,
            d.notes,
            { lots: JSON.parse(l.lots) },
          );
          if (transit)
            e.stockMove(
              u,
              l.product_id,
              transit,
              l.qty,
              value,
              "transfer",
              d.no,
              d.notes,
            );
        }
        e.run(
          "UPDATE stock_document_lines SET value=? WHERE id=?",
          value,
          l.id,
        );
      }
      if (d.kind !== "transfer")
        e.journal(
          u,
          "非交易庫存單",
          d.no,
          d.kind === "receipt"
            ? [
                ["1200", total, 0],
                ["5100", 0, total],
              ]
            : [
                ["5100", total, 0],
                ["1200", 0, total],
              ],
          d.date,
        );
      e.run(
        "UPDATE stock_documents SET status=?,transit_id=?,version=version+1 WHERE id=?",
        transit ? "dispatched" : "posted",
        transit,
        d.id,
      );
    } else if (action === "receive") {
      permit(u, "stock");
      if (d.kind !== "transfer" || d.status !== "dispatched")
        fail("只能驗收已發出的調撥", 409);
      if (!Array.isArray(b.lines) || !b.lines.length) fail("請提供驗收量");
      const seen = new Set();
      for (const x of b.lines) {
        const l = d.lines.find((l) => l.id === integer(x.line_id, 1));
        if (!l || seen.has(l.id)) fail("驗收明細錯誤");
        seen.add(l.id);
        const qty = scaled(x.qty, 3, 0, l.qty - l.received_qty);
        if (!qty) continue;
        const value =
          ratio(l.value, l.received_qty + qty, l.qty) - l.received_value;
        e.stockMove(
          u,
          l.product_id,
          d.transit_id,
          -qty,
          -value,
          "transfer",
          d.no,
          d.notes,
          { lots: x.lots },
        );
        e.stockMove(
          u,
          l.product_id,
          d.to_id,
          qty,
          value,
          "transfer",
          d.no,
          d.notes,
        );
        e.run(
          "UPDATE stock_document_lines SET received_qty=received_qty+?,received_value=received_value+? WHERE id=?",
          qty,
          value,
          l.id,
        );
      }
      const remaining = e.get(
        "SELECT sum(qty-received_qty) n FROM stock_document_lines WHERE document_id=?",
        d.id,
      ).n;
      e.run(
        "UPDATE stock_documents SET status=?,version=version+1 WHERE id=?",
        remaining ? "dispatched" : "received",
        d.id,
      );
    } else fail("庫存單操作錯誤");
    immutable(e, u, "stock_document_" + action, d.id, {
      version: d.version,
      reason: b.reason || "",
    });
    return this.stockDetail(u, d.id);
  }
  stockPrint(u, id) {
    const d = this.stockDetail(u, id);
    return printPage(
      "庫存／調撥單 " + d.no,
      `<p>${E(d.kind)} · ${E(d.status)} · ${E(d.date)} · 來源倉 ${E(d.from_id || "—")} → 目的倉 ${E(d.to_id || "—")}</p><table><tr><th>品號</th><th>品名</th><th>數量</th><th>驗收量</th></tr>${d.lines.map((l) => `<tr><td>${E(l.sku)}</td><td>${E(l.name)}</td><td>${l.qty / 1000} ${E(l.unit)}</td><td>${l.received_qty / 1000}</td></tr>`).join("")}</table><p>${E(d.notes)}</p>`,
    );
  }
  policy(u, b) {
    permit(u, "buy");
    const e = this.e,
      p = e.product(b.product_id),
      old = e.get(
        "SELECT * FROM replenishment_policies WHERE product_id=?",
        p.id,
      );
    if (integer(b.version || 0) !== (old?.version || 0))
      fail("補貨政策已更新", 409);
    const target = scaled(b.target_qty, 3),
      min = scaled(b.min_order_qty || 0, 3),
      multiple = scaled(b.multiple_qty || 1, 3, 1),
      lead = integer(b.lead_days || 0, 0, 365);
    if (target < p.safety_qty) fail("目標量不可低於安全存量");
    e.run(
      "INSERT INTO replenishment_policies(product_id,target_qty,min_order_qty,multiple_qty,lead_days) VALUES(?,?,?,?,?) ON CONFLICT(product_id) DO UPDATE SET target_qty=excluded.target_qty,min_order_qty=excluded.min_order_qty,multiple_qty=excluded.multiple_qty,lead_days=excluded.lead_days,version=version+1",
      p.id,
      target,
      min,
      multiple,
      lead,
    );
    immutable(e, u, "replenishment_policy", p.id, b);
    return { ok: true };
  }
  replenish(u, b) {
    permit(u, "buy");
    const e = this.e,
      w = e.warehouse(b.warehouse_id),
      suggestions = e.replenishment(u),
      selected = b.product_ids;
    if (
      !Array.isArray(selected) ||
      !selected.length ||
      selected.length > 200 ||
      new Set(selected.map(Number)).size !== selected.length
    )
      fail("請選 1–200 個不重複商品");
    const groups = new Map();
    for (const id of selected) {
      const s = suggestions.find((s) => s.product_id === integer(id, 1));
      if (!s || !s.supplier_id || s.suggested_qty <= 0)
        fail("商品沒有補貨建議或未指定供應商");
      const p = e.product(id);
      e.partner(u, s.supplier_id, "supplier");
      if (!groups.has(s.supplier_id)) groups.set(s.supplier_id, []);
      groups.get(s.supplier_id).push({
        product_id: p.id,
        qty: String(s.suggested_qty / 1000),
        price: String(p.cost / 100),
      });
    }
    const documents = [];
    for (const [partner_id, lines] of groups)
      documents.push(
        e.saveDoc(u, {
          kind: "purchase",
          partner_id,
          warehouse_id: w.id,
          date: b.date || today(),
          notes: "安全存量批次補貨",
          lines,
        }),
      );
    return { documents };
  }
  countRebase(u, b) {
    permit(u, "approve");
    const e = this.e,
      c = e.count(u, b.count_id);
    if (c.status !== "draft" || c.version !== integer(b.version, 1))
      fail("盤點單已結束或更新", 409);
    const reason = txt(b.reason, 1000, true),
      latest = e.get(
        "SELECT COALESCE(max(id),0) n FROM stock_moves WHERE warehouse_id=?",
        c.warehouse_id,
      ).n,
      rows = c.lines.map((l) => {
        const moves = e.get(
          "SELECT COALESCE(sum(qty),0) n FROM stock_moves WHERE warehouse_id=? AND product_id=? AND id>? AND id<=?",
          c.warehouse_id,
          l.product_id,
          c.snapshot_move_id,
          latest,
        ).n;
        return {
          ...l,
          movement: moves,
          new_expected: l.expected_qty + moves,
          new_actual: l.actual_qty + moves,
        };
      });
    if (rows.some((r) => r.new_actual < 0))
      fail("重基後實盤量為負，請重新實盤");
    const token = hash({ version: c.version, latest, rows });
    if (b.preview !== false) return { rows, token, version: c.version };
    if (b.token !== token) fail("盤點異動已改變，請重新預覽", 409);
    for (const r of rows)
      e.run(
        "UPDATE inventory_count_lines SET expected_qty=?,actual_qty=? WHERE id=?",
        r.new_expected,
        r.new_actual,
        r.id,
      );
    e.run(
      "INSERT INTO count_rebases(count_id,previous_snapshot,new_snapshot,detail,reason,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
      c.id,
      c.snapshot_move_id,
      latest,
      JSON.stringify(rows),
      reason,
      u.id,
      now(),
    );
    e.run(
      "UPDATE inventory_counts SET snapshot_move_id=?,version=version+1 WHERE id=?",
      latest,
      c.id,
    );
    immutable(e, u, "count_rebase", c.id, { reason, latest });
    return e.count(u, c.id);
  }
  countPreview(u, b) {
    permit(u, "stock");
    const e = this.e,
      c = e.count(u, b.count_id),
      latest = e.get(
        "SELECT COALESCE(max(id),0) n FROM stock_moves WHERE warehouse_id=?",
        c.warehouse_id,
      ).n;
    return {
      id: c.id,
      version: c.version,
      stale: latest !== c.snapshot_move_id,
      rows: c.lines.map((l) => {
        const diff = l.actual_qty - l.expected_qty,
          s = e.get(
            "SELECT * FROM stocks WHERE product_id=? AND warehouse_id=?",
            l.product_id,
            c.warehouse_id,
          ) || { qty: 0, value: 0 },
          p = e.product(l.product_id);
        return {
          ...l,
          difference: diff,
          estimated_value:
            diff < 0
              ? -(s.qty ? ratio(s.value, -diff, s.qty) : 0)
              : s.qty
                ? ratio(s.value, diff, s.qty)
                : ratio(p.cost, diff, 1000),
        };
      }),
    };
  }
  history(u, b) {
    permit(u, "all");
    const e = this.e,
      partner = b.partner_id ? e.partner(u, b.partner_id) : null,
      id = b.document_id ? integer(b.document_id, 1) : null,
      documents = id
        ? [e.doc(u, id)]
        : e.all(
            "SELECT * FROM documents WHERE partner_id=?" +
              (legacySales(u) ? " AND owner_id=? AND kind<>'purchase'" : "") +
              " ORDER BY date,id",
            partner?.id || 0,
            ...(legacySales(u) ? [u.id] : []),
          ),
      ids = documents.map((d) => d.id);
    for (let depth = 0; depth < 30 && ids.length < 2000; depth++) {
      const prior = ids.length;
      if (!prior) break;
      const marks = ids.map(() => "?").join(","),
        relations = e.all(
          `SELECT d.* FROM documents d WHERE (d.id IN (SELECT source_id FROM document_links WHERE target_id IN (${marks})) OR d.id IN (SELECT target_id FROM document_links WHERE source_id IN (${marks})) OR d.source_id IN (${marks}) OR d.id IN (SELECT source_id FROM documents WHERE id IN (${marks})))` +
            (legacySales(u) ? " AND d.owner_id=? AND d.kind<>'purchase'" : ""),
          ...ids,
          ...ids,
          ...ids,
          ...ids,
          ...(legacySales(u) ? [u.id] : []),
        );
      for (const doc of relations)
        if (!ids.includes(doc.id)) {
          ids.push(doc.id);
          documents.push(doc);
        }
      if (ids.length === prior) break;
    }
    const placeholders = ids.map(() => "?").join(",") || "NULL",
      fulfilments = e.all(
        `SELECT * FROM fulfilments WHERE document_id IN (${placeholders})`,
        ...ids,
      ),
      fids = fulfilments.map((f) => f.id),
      fs = fids.map(() => "?").join(",") || "NULL",
      open = e.all(
        `SELECT * FROM open_items WHERE fulfilment_id IN (${fs})`,
        ...fids,
      ),
      oids = open.map((o) => o.id),
      os = oids.map(() => "?").join(",") || "NULL",
      nodes = [],
      edges = [],
      add = (type, rows, parent, parentType) => {
        for (const row of rows) {
          nodes.push({ key: type + ":" + row.id, type, ...row });
          if (parent && row[parent])
            edges.push({
              from: parentType + ":" + row[parent],
              to: type + ":" + row.id,
            });
        }
      };
    add("document", documents);
    add("fulfilment", fulfilments, "document_id", "document");
    add("open_item", open, "fulfilment_id", "fulfilment");
    add(
      "return",
      e.all(`SELECT * FROM returns WHERE fulfilment_id IN (${fs})`, ...fids),
      "fulfilment_id",
      "fulfilment",
    );
    add(
      "allowance",
      e.all(`SELECT * FROM allowances WHERE fulfilment_id IN (${fs})`, ...fids),
      "fulfilment_id",
      "fulfilment",
    );
    add(
      "payment",
      e.all(`SELECT * FROM payments WHERE open_item_id IN (${os})`, ...oids),
      "open_item_id",
      "open_item",
    );
    add(
      "advance",
      e.all(
        `SELECT * FROM funds WHERE source_document_id IN (${placeholders}) OR source_return_id IN (SELECT id FROM returns WHERE fulfilment_id IN (${fs}))`,
        ...ids,
        ...fids,
      ),
      "source_document_id",
      "document",
    );
    for (const link of e.all(
      `SELECT * FROM document_links WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
      ...ids,
      ...ids,
    ))
      edges.push({
        from: "document:" + link.source_id,
        to: "document:" + link.target_id,
        kind: link.kind,
      });
    for (const o of open) {
      if (o.billing_batch_id)
        edges.push({
          from: "open_item:" + o.id,
          to: "monthly_bill:" + o.billing_batch_id,
        });
    }
    for (const d of documents)
      if (d.source_id && ids.includes(d.source_id))
        edges.push({
          from: "document:" + d.source_id,
          to: "document:" + d.id,
          kind: "source",
        });
    if (has(u, "finance")) {
      const batches = e.all(
        `SELECT DISTINCT b.* FROM billing_batches b JOIN open_items o ON o.billing_batch_id=b.id WHERE o.id IN (${os})`,
        ...oids,
      );
      add("monthly_bill", batches);
      if (partner) {
        add(
          "opening",
          e.all("SELECT * FROM opening_items WHERE partner_id=?", partner.id),
        );
        const openingIds = nodes
          .filter((n) => n.type === "opening")
          .map((n) => n.id);
        add(
          "opening_payment",
          e.all(
            `SELECT * FROM opening_payments WHERE opening_item_id IN (${openingIds.map(() => "?").join(",") || "NULL"})`,
            ...openingIds,
          ),
          "opening_item_id",
          "opening",
        );
        add(
          "expense",
          e.all("SELECT * FROM expenses WHERE partner_id=?", partner.id),
        );
      }
      const paymentIds = nodes
        .filter((n) => n.type === "payment")
        .map((n) => n.id);
      add(
        "payment_reversal",
        e.all(
          `SELECT * FROM payment_reversals WHERE payment_id IN (${paymentIds.map(() => "?").join(",") || "NULL"})`,
          ...paymentIds,
        ),
        "payment_id",
        "payment",
      );
      const funds = e.all(
          `SELECT f.* FROM funds f WHERE ${partner ? "f.partner_id=? OR " : ""}f.source_document_id IN (${placeholders}) OR f.source_return_id IN (SELECT id FROM returns WHERE fulfilment_id IN (${fs})) OR f.id IN (SELECT fund_id FROM fund_applications WHERE open_item_id IN (${os})) OR f.id IN (SELECT af.fund_id FROM allowance_funds af JOIN allowances a ON a.id=af.allowance_id WHERE a.fulfilment_id IN (${fs}))`,
          ...(partner ? [partner.id] : []),
          ...ids,
          ...fids,
          ...oids,
          ...fids,
        ),
        fundIds = funds.map((f) => f.id),
        marks = fundIds.map(() => "?").join(",") || "NULL";
      for (const fund of funds)
        if (!nodes.some((n) => n.type === "advance" && n.id === fund.id))
          add("advance", [fund], "source_document_id", "document");
      add(
        "application",
        e.all(
          `SELECT * FROM fund_applications WHERE fund_id IN (${marks})`,
          ...fundIds,
        ),
        "fund_id",
        "advance",
      );
      add(
        "refund",
        e.all(
          `SELECT * FROM fund_refunds WHERE fund_id IN (${marks})`,
          ...fundIds,
        ),
        "fund_id",
        "advance",
      );
      add(
        "bill",
        e.all(
          `SELECT DISTINCT b.* FROM bills b JOIN bill_allocations a ON a.bill_id=b.id WHERE a.open_item_id IN (${os})`,
          ...oids,
        ),
      );
      for (const link of e.all(
        `SELECT * FROM bill_allocations WHERE open_item_id IN (${os})`,
        ...oids,
      ))
        edges.push({
          from: "open_item:" + link.open_item_id,
          to: "bill:" + link.bill_id,
        });
      const links = e.all(
        `SELECT l.*,i.invoice_no,i.date,i.net,i.tax,i.total FROM invoice_fulfilments l JOIN invoice_records i ON i.id=l.invoice_id WHERE l.fulfilment_id IN (${fs})`,
        ...fids,
      );
      for (const link of links) {
        if (!nodes.some((n) => n.key === "invoice:" + link.invoice_id))
          nodes.push({
            key: "invoice:" + link.invoice_id,
            id: link.invoice_id,
            type: "invoice",
            no: link.invoice_no,
            date: link.date,
            net: link.net,
            tax: link.tax,
            total: link.total,
          });
        edges.push({
          from: "fulfilment:" + link.fulfilment_id,
          to: "invoice:" + link.invoice_id,
        });
      }
    } else {
      for (let i = nodes.length - 1; i >= 0; i--)
        if (
          ["open_item", "payment", "advance", "allowance"].includes(
            nodes[i].type,
          )
        )
          nodes.splice(i, 1);
    }
    if (partner) {
      add(
        "repair",
        e.all("SELECT * FROM repair_tickets WHERE partner_id=?", partner.id),
        "fulfilment_id",
        "fulfilment",
      );
      add(
        "service_contract",
        e.all("SELECT * FROM service_contracts WHERE partner_id=?", partner.id),
      );
      const contracts = nodes
        .filter((n) => n.type === "service_contract")
        .map((n) => n.id);
      add(
        "rental_period",
        e.all(
          `SELECT * FROM rental_periods WHERE contract_id IN (${contracts.map(() => "?").join(",") || "NULL"})`,
          ...contracts,
        ),
        "contract_id",
        "service_contract",
      );
    }
    for (const node of nodes) {
      if (node.type === "application")
        edges.push({ from: node.key, to: "open_item:" + node.open_item_id });
      if (node.type === "advance" && node.source_return_id)
        edges.push({ from: "return:" + node.source_return_id, to: node.key });
    }
    const purchaseIds = new Set(
      fulfilments.filter((f) => f.kind === "receipt").map((f) => f.id),
    );
    for (const n of nodes)
      if (n.fulfilment_id && purchaseIds.has(n.fulfilment_id))
        n.cost_sensitive = true;
    const visibleKeys = new Set(nodes.map((n) => n.key));
    for (let i = edges.length - 1; i >= 0; i--)
      if (!visibleKeys.has(edges[i].from) || !visibleKeys.has(edges[i].to))
        edges.splice(i, 1);
    const refs = [...documents, ...fulfilments, ...nodes]
      .map((x) => x.no)
      .filter(Boolean);
    if (refs.length && has(u, "finance")) {
      const unique = [...new Set(refs)];
      add(
        "journal",
        e.all(
          `SELECT * FROM journals WHERE reference IN (${unique.map(() => "?").join(",")})`,
          ...unique,
        ),
      );
    }
    for (const journal of nodes.filter((n) => n.type === "journal"))
      for (const source of nodes.filter(
        (n) => n.no && n.no === journal.reference && n.key !== journal.key,
      ))
        edges.push({ from: source.key, to: journal.key });
    return {
      documents,
      nodes,
      edges,
      note: "關聯按目前授權可見資料建立；不代表外部平台已開票。",
    };
  }
  stockHistory(u, b) {
    permit(u, "stock");
    const e = this.e,
      date = dateValue(b.date),
      slow = integer(b.slow_days || 90, 1, 3650),
      rows = e.all(
        `SELECT m.*,COALESCE(f.date,j.date,date(m.created_at,'+8 hours')) effective_date,p.sku,p.name,p.unit,w.name warehouse_name FROM stock_moves m JOIN products p ON p.id=m.product_id JOIN warehouses w ON w.id=m.warehouse_id LEFT JOIN fulfilments f ON f.no=m.reference LEFT JOIN (SELECT reference,min(date) date FROM journals GROUP BY reference) j ON j.reference=m.reference WHERE COALESCE(f.date,j.date,date(m.created_at,'+8 hours'))<=? ORDER BY effective_date,m.id`,
        date,
      ),
      groups = new Map();
    for (const m of rows) {
      const key = m.product_id + ":" + m.warehouse_id;
      let g = groups.get(key);
      if (!g) {
        g = {
          product_id: m.product_id,
          warehouse_id: m.warehouse_id,
          sku: m.sku,
          name: m.name,
          unit: m.unit,
          warehouse_name: m.warehouse_name,
          qty: 0,
          value: 0,
          last_issue: null,
          layers: [],
        };
        groups.set(key, g);
      }
      g.qty += m.qty;
      g.value += m.value;
      if (m.qty > 0) g.layers.push({ date: m.effective_date, qty: m.qty });
      else if (m.qty < 0) {
        g.last_issue = m.effective_date;
        let left = -m.qty;
        while (left && g.layers.length) {
          const l = g.layers[0],
            take = Math.min(left, l.qty);
          l.qty -= take;
          left -= take;
          if (!l.qty) g.layers.shift();
        }
      }
    }
    return {
      date,
      rows: [...groups.values()].map((g) => {
        const buckets = { "0-30": 0, "31-90": 0, "91-180": 0, "181+": 0 };
        for (const l of g.layers) {
          const days = Math.floor(
            (Date.parse(date) - Date.parse(l.date)) / 86400000,
          );
          buckets[
            days <= 30
              ? "0-30"
              : days <= 90
                ? "31-90"
                : days <= 180
                  ? "91-180"
                  : "181+"
          ] += l.qty;
        }
        const days = g.last_issue
          ? Math.floor((Date.parse(date) - Date.parse(g.last_issue)) / 86400000)
          : null;
        return {
          ...g,
          slow: days === null || days >= slow,
          days_since_issue: days,
          age_buckets: buckets,
          layers: undefined,
        };
      }),
      note: "庫齡以本倉入庫日期與先進先出數量推估；金額為歷史流水帳面金額。調入倉庫重新起算，不表示原製造日期或批號效期。",
    };
  }
  matrix(u, b) {
    permit(u, "finance");
    const e = this.e,
      r = tradingReport(e, u, {
        from: b.from,
        to: b.to,
        kind: b.kind || "sales",
        group: "product",
      }),
      dims = ["partner", "product", "category", "owner", "department", "month"],
      row = b.row || "partner",
      column = b.column || "month";
    if (!dims.includes(row) || !dims.includes(column) || row === column)
      fail("矩陣維度錯誤");
    const key = (r, d) =>
        d === "partner"
          ? [r.partner_id, r.partner_name]
          : d === "product"
            ? [r.product_id, r.sku + " · " + r.product_name]
            : d === "category"
              ? [r.category, r.category]
              : d === "owner"
                ? [r.owner_id, r.owner_name]
                : d === "department"
                  ? [r.department_id || 0, r.department_name || "未分類"]
                  : [r.date.slice(0, 7), r.date.slice(0, 7)],
      cells = new Map(),
      columns = new Map();
    for (const x of r.rows) {
      const [rid, rname] = key(x, row),
        [cid, cname] = key(x, column),
        k = JSON.stringify([rid, cid]);
      columns.set(cid, cname);
      let c = cells.get(k);
      if (!c) {
        c = {
          row_id: rid,
          row_name: rname,
          column_id: cid,
          column_name: cname,
          net: 0,
          tax: 0,
          cost: 0,
          selling_expense: 0,
        };
        cells.set(k, c);
      }
      c.net += x.net;
      c.tax += x.tax;
      c.cost += x.cost;
      c.selling_expense += x.selling_expense || 0;
    }
    return {
      row,
      column,
      columns: [...columns].map(([id, name]) => ({ id, name })),
      cells: [...cells.values()].map((c) => ({
        ...c,
        margin: c.net - c.cost,
        contribution: c.net - c.cost - c.selling_expense,
      })),
      totals: r.totals,
      from: r.from,
      to: r.to,
    };
  }
  disassemble(u, b) {
    permit(u, "stock");
    const e = this.e,
      p = e.product(b.product_id),
      w = e.warehouse(b.warehouse_id),
      bom = e.get("SELECT * FROM boms WHERE product_id=?", p.id);
    if (!bom) fail("成品沒有 BOM");
    const qty = scaled(b.qty, 3, 1),
      cost = e.costOut(p.id, w.id, qty),
      reason = txt(b.reason, 1000, true),
      components = e
        .all(
          "SELECT l.*,p.cost FROM bom_lines l JOIN products p ON p.id=l.product_id WHERE bom_id=?",
          bom.id,
        )
        .map((l) => ({ ...l, quantity: ratio(l.qty, qty, 1000) }));
    if (components.some((l) => !l.quantity)) fail("材料量小於最小精度");
    const weight = components.reduce(
        (n, l) => n + BigInt(l.quantity) * BigInt(l.cost),
        0n,
      ),
      no = e.number("DA");
    e.stockMove(u, p.id, w.id, -qty, -cost, "disassembly", no, reason, {
      lots: b.lots,
    });
    let cumulative = 0n,
      allocated = 0;
    for (let i = 0; i < components.length; i++) {
      const l = components[i];
      cumulative += weight
        ? BigInt(l.quantity) * BigInt(l.cost)
        : BigInt(l.quantity);
      const denominator =
          weight || components.reduce((n, l) => n + BigInt(l.quantity), 0n),
        target =
          i === components.length - 1
            ? cost
            : ratio(cost, cumulative, denominator),
        value = target - allocated;
      allocated = target;
      l.allocated_cost = value;
      e.stockMove(
        u,
        l.product_id,
        w.id,
        l.quantity,
        value,
        "disassembly_material",
        no,
        reason,
        { lots: (b.component_lots || {})[l.product_id] },
      );
    }
    const id = Number(
      e.run(
        "INSERT INTO disassemblies(no,product_id,warehouse_id,qty,cost,snapshot,reason,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        no,
        p.id,
        w.id,
        qty,
        cost,
        JSON.stringify(components),
        reason,
        u.id,
        now(),
      ).lastInsertRowid,
    );
    immutable(e, u, "disassemble", id, { cost, components });
    return { id, no, cost };
  }
  kitSale(u, b) {
    permit(u, "sell");
    const e = this.e,
      bom = e.get("SELECT * FROM boms WHERE id=?", integer(b.kit_id, 1));
    if (!bom) fail("組合品不存在");
    const kit = e.product(bom.product_id),
      qty = scaled(b.qty, 3, 1),
      target = ratio(scaled(b.price ?? kit.price / 100), qty, 1000),
      source = e.all(
        "SELECT l.*,p.price FROM bom_lines l JOIN products p ON p.id=l.product_id WHERE bom_id=?",
        bom.id,
      ),
      lines = source.map((l) => ({
        product_id: l.product_id,
        quantity: ratio(l.qty, qty, 1000),
        unit_price: l.price,
      }));
    if (lines.some((l) => !l.quantity)) fail("組合明細小於數量精度");
    let gross = lines.reduce(
      (n, l) => n + ratio(l.quantity, l.unit_price, 1000),
      0,
    );
    if (gross < target) {
      const totalQty = lines.reduce((n, l) => n + l.quantity, 0),
        unitPrice = Math.ceil((target * 1000) / totalQty) + 1;
      for (const l of lines) l.unit_price = unitPrice;
      gross = lines.reduce(
        (n, l) => n + ratio(l.quantity, l.unit_price, 1000),
        0,
      );
    }
    const d = e.saveDoc(u, {
      kind: "order",
      partner_id: b.partner_id,
      warehouse_id: b.warehouse_id,
      date: b.date || today(),
      tax_mode: b.tax_mode || "exclusive",
      notes: "組合銷售 " + kit.sku + " × " + qty / 1000,
      header_discount: String((gross - target) / 100),
      lines: lines.map((l) => ({
        product_id: l.product_id,
        qty: String(l.quantity / 1000),
        price: String(l.unit_price / 100),
      })),
    });
    e.run(
      "INSERT INTO kit_sales VALUES(?,?,?,?)",
      d.id,
      bom.id,
      qty,
      JSON.stringify({ bom, source, target }),
    );
    immutable(e, u, "kit_sale", d.id, { kit_id: bom.id, qty });
    return d;
  }
  partialRelease(u, b) {
    permit(u, "approve");
    const e = this.e,
      d = e.doc(u, b.document_id);
    if (
      d.kind !== "order" ||
      d.status !== "pending" ||
      d.version !== integer(b.version, 1)
    )
      fail("只能配置待審訂單且版本須相符", 409);
    const strategy = b.strategy || "proportional";
    if (!["proportional", "available"].includes(strategy)) fail("配置策略錯誤");
    let fractionN = 1n,
      fractionD = 1n;
    for (const l of d.lines) {
      if (!l.track_stock) continue;
      const s = e.stock(l.product_id, d.warehouse_id),
        base = ((l.qty - l.closed_qty) * l.unit_ratio) / 1000;
      if (base) {
        const available = BigInt(Math.max(0, s.qty - s.reserved)),
          required = BigInt(base);
        if (available * fractionD < fractionN * required) {
          fractionN = available;
          fractionD = required;
        }
      }
    }
    const lines = d.lines
      .map((l) => {
        const pending = l.qty - l.closed_qty,
          s = e.stock(l.product_id, d.warehouse_id),
          available = l.track_stock
            ? Math.floor(
                (Math.max(0, s.qty - s.reserved) * 1000) / l.unit_ratio,
              )
            : pending,
          quantity = Math.min(
            pending,
            strategy === "proportional"
              ? Number((BigInt(pending) * fractionN) / fractionD)
              : available,
          );
        return { ...l, quantity };
      })
      .filter((l) => l.quantity > 0);
    if (!lines.length) fail("目前沒有可配置庫存", 409);
    const total = d.lines.reduce((n, l) => n + l.amount, 0),
      selected = lines.reduce(
        (n, l) => n + ratio(l.amount, l.quantity, l.qty),
        0,
      ),
      discount = total ? ratio(d.header_discount, selected, total) : 0,
      child = e.saveDoc(u, {
        kind: "order",
        partner_id: d.partner_id,
        warehouse_id: d.warehouse_id,
        date: d.date,
        tax_mode: d.tax_mode,
        tax_bp: d.tax_bp,
        header_discount: String(discount / 100),
        notes: "缺貨分配來源 " + d.no,
        lines: lines.map((l) => ({
          product_id: l.product_id,
          unit_id: l.unit_id,
          qty: String(l.quantity / 1000),
          price: String(l.price / 100),
          discount_bp: l.discount_bp,
          tax_mode: l.tax_mode,
          tax_bp: l.tax_bp,
        })),
      });
    e.transition(u, child.id, "submit");
    e.transition(u, child.id, "approve");
    for (const l of lines)
      e.run(
        "UPDATE document_lines SET closed_qty=closed_qty+? WHERE id=?",
        l.quantity,
        l.id,
      );
    e.run(
      "UPDATE documents SET version=version+1,updated_at=? WHERE id=?",
      now(),
      d.id,
    );
    e.run(
      "INSERT INTO document_links VALUES(?,?,?)",
      d.id,
      child.id,
      "shortage_release",
    );
    immutable(e, u, "shortage_release", d.id, {
      child_id: child.id,
      strategy,
      lines: lines.map((l) => ({ id: l.id, qty: l.quantity })),
    });
    return { source: e.doc(u, d.id), released: e.doc(u, child.id) };
  }
  settlement(u, b) {
    permit(u, "finance");
    const e = this.e,
      finance = new Finance(e),
      items = finance.allocations(b),
      date = dateValue(b.date),
      total = items.reduce((n, l) => n + l.allocation, 0),
      tenders = b.tenders;
    if (!Array.isArray(tenders) || !tenders.length || tenders.length > 20)
      fail("需 1–20 筆收付方式");
    const amounts = tenders.map((t) => scaled(t.amount, 2, 1)),
      received = tenders.reduce(
        (n, t, i) => n + (t.kind === "bank_fee" ? 0 : amounts[i]),
        0,
      );
    if (received < total || (received > total && b.excess_to_advance !== true))
      fail("混合收付合計須等於沖抵合計；超收付需明確確認轉預收付");
    const no = e.number("MX"),
      id = Number(
        e.run(
          "INSERT INTO settlements(no,kind,partner_id,date,detail,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
          no,
          b.kind,
          integer(b.partner_id, 1),
          date,
          JSON.stringify({
            lines: b.lines,
            tenders,
            excess_to_advance: b.excess_to_advance === true,
          }),
          u.id,
          now(),
        ).lastInsertRowid,
      );
    let cursor = 0,
      remaining = items[0].allocation;
    const result = [];
    for (let i = 0; i < tenders.length; i++) {
      const tender = tenders[i],
        rows = [];
      if (tender.kind === "bank_fee") {
        const bank = finance.bank(tender.bank_account_id);
        let category = e.get(
          "SELECT id FROM expense_categories WHERE code='SETTLEMENT-FEE'",
        );
        if (!category)
          category = finance.saveCategory(u, {
            code: "SETTLEMENT-FEE",
            name: "收付銀行手續費",
          });
        const expense = finance.expense(u, {
          category_id: category.id,
          partner_id: b.partner_id,
          net: String(amounts[i] / 100),
          date,
          purpose: "混合收付銀行手續費 " + no,
        });
        result.push(
          finance.payExpense(u, {
            expense_id: expense.id,
            bank_account_id: bank.id,
            amount: String(amounts[i] / 100),
            date,
          }),
        );
        continue;
      }
      let left = amounts[i];
      while (left && cursor < items.length) {
        const item = items[cursor],
          take = Math.min(left, remaining);
        rows.push({ open_item_id: item.id, amount: String(take / 100) });
        left -= take;
        remaining -= take;
        if (!remaining) {
          cursor++;
          remaining = items[cursor]?.allocation || 0;
        }
      }
      if (left && !["cash", "bank"].includes(tender.kind))
        fail("超收付僅能來自現金或銀行；票據、既有預收及費用不可轉成新預收付");
      if (["cash", "bank"].includes(tender.kind)) {
        const bank = finance.bank(tender.bank_account_id);
        if (bank.kind !== tender.kind) fail("收付方式與實際帳戶類型不符");
        for (const row of rows)
          result.push(
            e.pay(u, {
              ...row,
              method: tender.kind,
              bank_account_id: bank.id,
              date,
              reference: no,
            }),
          );
        if (left)
          result.push(
            finance.advance(u, {
              kind:
                b.kind === "receivable"
                  ? "customer_advance"
                  : "supplier_advance",
              partner_id: b.partner_id,
              bank_account_id: bank.id,
              amount: String(left / 100),
              date,
              notes: "混合收付超額轉預收付 " + no,
            }),
          );
      } else if (tender.kind === "fund") {
        for (const row of rows)
          result.push(
            finance.apply(u, { ...row, fund_id: tender.fund_id, date }),
          );
      } else if (tender.kind === "cheque")
        result.push(
          finance.registerBill(u, {
            kind: b.kind,
            partner_id: b.partner_id,
            date,
            due_date: tender.due_date,
            bank_account_id: tender.bank_account_id,
            bill_number: tender.bill_number,
            amount: String(amounts[i] / 100),
            lines: rows,
          }),
        );
      else if (tender.kind === "fee") {
        if (b.kind !== "receivable")
          fail("付款手續費請選額外銀行手續費，不可抵減供應商應付");
        for (const row of rows) {
          const item = finance.item(row.open_item_id),
            amount = scaled(row.amount, 2, 1);
          if (amount > item.amount - item.paid) fail("手續費超過未收帳款");
          e.run(
            "UPDATE open_items SET paid=paid+? WHERE id=?",
            amount,
            item.id,
          );
          e.run(
            "INSERT INTO settlement_fees(settlement_id,open_item_id,amount,date,created_by) VALUES(?,?,?,?,?)",
            id,
            item.id,
            amount,
            date,
            u.id,
          );
          e.journal(
            u,
            "混合收款手續費",
            no,
            [
              ["5200", amount, 0],
              ["1100", 0, amount],
            ],
            date,
          );
        }
      } else fail("收付方式錯誤");
    }
    immutable(e, u, "mixed_settlement", id, { total, received, tenders });
    return { id, no, result, advance_amount: received - total };
  }
  countFile(u, b) {
    permit(u, "stock");
    const e = this.e,
      c = e.count(u, b.count_id);
    if (c.status !== "draft" || c.version !== integer(b.version, 1))
      fail("盤點單已更新或結束", 409);
    const bytes = Buffer.from(txt(b.base64, 1500000, true), "base64");
    if (bytes.length > 1024 * 1024) fail("檔案請小於 1 MB");
    const source =
        b.format === "xlsx"
          ? readXLSX(bytes)
          : b.format === "csv"
            ? readCSV(bytes.toString("utf8"))
            : fail("只接受 CSV／XLSX"),
      mapping = b.columns || {
        sku: "sku",
        actual_qty: "actual_qty",
        zone: "zone",
      },
      rows = source.map((r) => ({
        sku: r[mapping.sku],
        actual_qty: r[mapping.actual_qty],
        zone: txt(String(r[mapping.zone] || ""), 100),
      }));
    if (!rows.length) fail("檔案沒有資料");
    const seen = new Set();
    for (const r of rows) {
      if (seen.has(r.sku) || !c.lines.some((l) => l.sku === r.sku))
        fail("品號重複或不在盤點範圍");
      seen.add(r.sku);
      scaled(r.actual_qty, 3);
    }
    const token = hash({ version: c.version, rows });
    if (b.preview !== false)
      return {
        token,
        rows: rows.map((r) => {
          const l = c.lines.find((l) => l.sku === r.sku);
          return {
            ...r,
            expected_qty: l.expected_qty,
            actual_qty: scaled(r.actual_qty, 3),
            difference: scaled(r.actual_qty, 3) - l.expected_qty,
          };
        }),
      };
    if (b.token !== token) fail("檔案或版本已改變，請重新預覽", 409);
    const result = new Operations(e).countImport(
      u,
      c.id,
      { version: c.version, rows },
      true,
    );
    for (const r of rows)
      e.run(
        "INSERT INTO count_zones VALUES(?,?,?) ON CONFLICT(count_id,product_id) DO UPDATE SET zone=excluded.zone",
        c.id,
        c.lines.find((l) => l.sku === r.sku).product_id,
        r.zone,
      );
    immutable(e, u, "count_file_import", c.id, {
      format: b.format,
      columns: mapping,
      token,
      rows: rows.length,
    });
    return result;
  }
  historicalAging(u, b) {
    permit(u, "finance");
    const e = this.e,
      date = dateValue(b.date),
      partner = b.partner_id ? integer(b.partner_id, 1) : null,
      kind = b.kind || "receivable";
    if (!["receivable", "payable"].includes(kind)) fail("帳款類型錯誤");
    const items = e.all(
        "SELECT o.*,f.no source_no,f.date,p.name partner_name,bb.date billing_date FROM open_items o JOIN fulfilments f ON f.id=o.fulfilment_id JOIN partners p ON p.id=o.partner_id LEFT JOIN billing_batches bb ON bb.id=o.billing_batch_id WHERE o.kind=? AND f.date<=?" +
          (partner ? " AND o.partner_id=?" : ""),
        kind,
        date,
        ...(partner ? [partner] : []),
      ),
      rows = [];
    for (const o of items) {
      if (
        o.billing_state === "pending" ||
        (o.billing_date && o.billing_date > date)
      )
        continue;
      const original = e.get(
          "SELECT total FROM fulfilments WHERE id=?",
          o.fulfilment_id,
        ).total,
        returns = e.get(
          "SELECT COALESCE(sum(total),0) n FROM returns WHERE fulfilment_id=? AND date(created_at,'+8 hours')<=?",
          o.fulfilment_id,
          date,
        ).n,
        allowances = e.get(
          "SELECT COALESCE(sum(total),0) n FROM allowances WHERE fulfilment_id=? AND date<=?",
          o.fulfilment_id,
          date,
        ).n,
        payments = e.get(
          "SELECT COALESCE(sum(p.amount),0) n FROM payments p WHERE p.open_item_id=? AND p.date<=? AND NOT EXISTS(SELECT 1 FROM payment_reversals r WHERE r.payment_id=p.id AND r.date<=?)",
          o.id,
          date,
          date,
        ).n,
        applied = e.get(
          "SELECT COALESCE(sum(amount),0) n FROM fund_applications WHERE open_item_id=? AND date<=?",
          o.id,
          date,
        ).n,
        fees = e.get(
          "SELECT COALESCE(sum(amount),0) n FROM settlement_fees WHERE open_item_id=? AND date<=?",
          o.id,
          date,
        ).n,
        bad = e.get(
          "SELECT COALESCE(sum(CASE ev.action WHEN 'approve' THEN ev.amount WHEN 'reverse' THEN -ev.amount ELSE 0 END),0) n FROM bad_debt_events ev JOIN bad_debts d ON d.id=ev.bad_debt_id WHERE d.open_item_id=? AND ev.date<=?",
          o.id,
          date,
        ).n;
      let bills = 0;
      for (const x of e.all(
        "SELECT a.amount,b.id FROM bill_allocations a JOIN bills b ON b.id=a.bill_id WHERE a.open_item_id=? AND b.date<=?",
        o.id,
        date,
      )) {
        const state = e.get(
          "SELECT action FROM bill_events WHERE bill_id=? AND date<=? AND action IN ('register','cancel','bounce','endorsement_bounce') ORDER BY date DESC,id DESC LIMIT 1",
          x.id,
          date,
        );
        if (
          state &&
          !["bounce", "cancel", "endorsement_bounce"].includes(state.action)
        )
          bills += x.amount;
      }
      let endorsed = 0;
      for (const en of e.all(
        "SELECT en.*,a.amount FROM endorsement_allocations a JOIN endorsements en ON en.id=a.endorsement_id WHERE a.open_item_id=? AND en.date<=?",
        o.id,
        date,
      )) {
        const revoked = e.get(
          "SELECT 1 FROM bill_events WHERE bill_id=? AND action IN ('endorsement_return','endorsement_bounce') AND date<=? AND json_extract(CASE WHEN json_valid(notes) THEN notes ELSE '{}' END,'$.endorsement_id')=?",
          en.bill_id,
          date,
          en.id,
        );
        if (!revoked) endorsed += en.amount;
      }
      const outstanding = Math.max(
        0,
        original -
          returns -
          allowances -
          payments -
          applied -
          fees -
          bills -
          bad -
          endorsed,
      );
      rows.push({
        ...o,
        original,
        returns,
        allowances,
        settled: payments + applied + fees + bills + bad + endorsed,
        amount: original - returns - allowances,
        paid: Math.min(
          original - returns - allowances,
          payments + applied + fees + bills + bad + endorsed,
        ),
        outstanding,
      });
    }
    for (const o of e.all(
      "SELECT o.*,p.name partner_name FROM opening_items o JOIN partners p ON p.id=o.partner_id WHERE o.kind=? AND o.date<=?" +
        (partner ? " AND o.partner_id=?" : ""),
      kind,
      date,
      ...(partner ? [partner] : []),
    )) {
      const settled = e.get(
        "SELECT COALESCE(sum(amount),0) n FROM opening_payments WHERE opening_item_id=? AND date<=?",
        o.id,
        date,
      ).n;
      rows.push({
        ...o,
        origin: "opening",
        source_no: o.no,
        original: o.amount,
        paid: settled,
        settled,
        outstanding: o.amount - settled,
      });
    }
    const totals = { current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "91+": 0 };
    for (const r of rows) {
      const days = Math.floor(
          (Date.parse(date) - Date.parse(r.due_date)) / 86400000,
        ),
        bucket =
          days <= 0
            ? "current"
            : days <= 30
              ? "1-30"
              : days <= 60
                ? "31-60"
                : days <= 90
                  ? "61-90"
                  : "91+";
      r.days_overdue = Math.max(0, days);
      r.bucket = bucket;
      totals[bucket] += r.outstanding;
    }
    return {
      date,
      kind,
      rows,
      totals,
      total: rows.reduce((n, r) => n + r.outstanding, 0),
      note: "依指定日之前出入庫、折讓、退貨、收付、票據與核銷事件重建；待月結資料不先列入已立帳帳齡。",
    };
  }
  costBatch(u, b) {
    permit(u, "masters");
    if (!has(u, "cost")) fail("沒有修改成本的權限", 403);
    const e = this.e;
    if (!Array.isArray(b.rows) || !b.rows.length || b.rows.length > 2000)
      fail("需 1–2,000 列成本");
    const inventory = b.target === "inventory",
      seen = new Set(),
      rows = b.rows.map((r) => {
        const p = e.get(
          "SELECT * FROM products WHERE sku=?",
          txt(r.sku, 60, true),
        );
        if (!p) fail("品號不存在");
        if (inventory) {
          permit(u, "approve");
          const w = e.get(
            "SELECT * FROM warehouses WHERE code=? AND active=1",
            txt(r.warehouse_code, 40, true),
          );
          if (!w || seen.has(p.id + ":" + w.id))
            fail("倉庫不存在或品號倉庫重複");
          seen.add(p.id + ":" + w.id);
          const stock = e.stock(p.id, w.id);
          if (!stock.qty) fail("零庫存商品不能重估");
          const value =
            r.new_value !== undefined && r.new_value !== ""
              ? scaled(r.new_value)
              : ratio(stock.qty, scaled(r.cost), 1000);
          return {
            id: p.id,
            sku: p.sku,
            warehouse_id: w.id,
            warehouse_code: w.code,
            qty: stock.qty,
            old_value: stock.value,
            new_value: value,
            old_cost: p.cost,
            new_cost: ratio(value, 1000, stock.qty),
          };
        }
        if (seen.has(p.id)) fail("品號重複");
        seen.add(p.id);
        return {
          id: p.id,
          sku: p.sku,
          version: p.version,
          old_cost: p.cost,
          new_cost: scaled(r.cost),
        };
      }),
      token = hash({ inventory, rows });
    if (b.preview !== false) return { rows, token };
    if (token !== b.token) fail("商品成本、庫存或版本已更新，請重新預覽", 409);
    const reason = txt(b.reason, 1000, true);
    if (inventory)
      for (const r of rows) {
        if (r.new_value === r.old_value) continue;
        new Operations(e).cost(u, {
          product_id: r.id,
          warehouse_id: r.warehouse_id,
          expected_qty: String(r.qty / 1000),
          expected_value: String(r.old_value / 100),
          mode: "value",
          new_value: String(r.new_value / 100),
          reason,
        });
      }
    else
      for (const r of rows)
        e.run(
          "UPDATE products SET cost=?,version=version+1 WHERE id=?",
          r.new_cost,
          r.id,
        );
    immutable(e, u, "cost_batch", token, {
      target: inventory ? "inventory" : "reference",
      rows,
      reason,
    });
    return { updated: rows.length };
  }
  statement(u, b) {
    const e = this.e,
      partner = e.partner(
        u,
        b.partner_id,
        b.kind === "payable" ? "supplier" : "customer",
      ),
      report = this.historicalAging(u, b),
      money = (v) => (v / 100).toFixed(2);
    return printPage(
      "往來對帳單",
      `<p>${E(e.settings().company)} · ${E(partner.code)} ${E(partner.name)}<br>截止日 ${E(report.date)} · ${report.kind === "receivable" ? "應收" : "應付"}</p><table><tr><th>來源單號</th><th>日期</th><th>到期日</th><th>原額</th><th>已沖抵</th><th>未結</th></tr>${report.rows.map((r) => `<tr><td>${E(r.source_no)}</td><td>${E(r.date)}</td><td>${E(r.due_date)}</td><td>${money(r.original)}</td><td>${money(r.settled)}</td><td>${money(r.outstanding)}</td></tr>`).join("")}</table><p>未結合計：${money(report.total)} TWD</p><p>${E(report.note)} 未指定沖抵的預收付及待退款不直接互抵。</p>`,
    );
  }
  assign(u, b) {
    const e = this.e,
      table =
        b.resource === "partners"
          ? "partners"
          : ["quotes", "orders", "purchases"].includes(b.resource)
            ? "documents"
            : fail("不支援指派此資料"),
      id = integer(b.id, 1),
      p = e.access.policy(u);
    if (!p.configured) permit(u, "masters");
    else e.access.assert(p, b.resource, "assign", table, id);
    const row = e.get(`SELECT * FROM ${table} WHERE id=?`, id);
    if (!row || e.access.resource(table, row) !== b.resource)
      fail("資料類型不符");
    if (row.version !== integer(b.version, 1)) fail("資料已被修改", 409);
    const owner = integer(b.owner_id, 1);
    if (!e.get("SELECT id FROM users WHERE id=? AND active=1", owner))
      fail("目標使用者不存在或停用");
    const reason = txt(b.reason, 1000, true);
    e.run(
      `UPDATE ${table} SET owner_id=?,version=version+1 WHERE id=?`,
      owner,
      id,
    );
    e.log(u, "assign", table, id, {
      previous_owner_id: row.owner_id,
      owner_id: owner,
      reason,
    });
    return { ok: true };
  }

  invoiceLink(u, b) {
    permit(u, "finance");
    const e = this.e,
      invoice = e.get(
        "SELECT * FROM invoice_records WHERE id=?",
        integer(b.invoice_id, 1),
      ),
      fulfilment = e.get(
        "SELECT * FROM fulfilments WHERE id=?",
        integer(b.fulfilment_id, 1),
      );
    if (!invoice || !fulfilment || fulfilment.kind !== "shipment")
      fail("請選擇本地發票紀錄及銷貨出庫單");
    const amount = scaled(b.amount, 2, 1),
      usedInvoice = e.get(
        "SELECT COALESCE(sum(amount),0) n FROM invoice_fulfilments WHERE invoice_id=?",
        invoice.id,
      ).n,
      usedSource = e.get(
        "SELECT COALESCE(sum(amount),0) n FROM invoice_fulfilments WHERE fulfilment_id=?",
        fulfilment.id,
      ).n;
    if (
      amount > invoice.total - usedInvoice ||
      amount > fulfilment.total - usedSource
    )
      fail("關聯金額超過發票或來源剩餘金額", 409);
    e.run(
      "INSERT INTO invoice_fulfilments VALUES(?,?,?,?,?)",
      invoice.id,
      fulfilment.id,
      amount,
      u.id,
      now(),
    );
    e.log(u, "invoice_source_link", "invoice", invoice.id, {
      fulfilment_id: fulfilment.id,
      amount,
    });
    return {
      ok: true,
      note: "此為本地來源追溯關聯，不會連線開立或驗證正式發票",
    };
  }
}
