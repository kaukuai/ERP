import { createHash } from "node:crypto";
import { fail, integer, scaled, txt, now, today, dateValue } from "./core.mjs";
import {
  controlPermission,
  sourcePermission,
  moneyPermission,
  canControl,
} from "./control-access.mjs";
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class VendorBills {
  constructor(e) {
    this.e = e;
  }
  policy() {
    return JSON.parse(this.e.settings().procurement_control_policy);
  }
  configure(u, b) {
    const e = this.e;
    e.access.requireAdmin(u);
    return e.tx(() => {
      const old = this.policy();
      if (
        typeof b.require_matching !== "boolean" ||
        (b.forbid_self_approval !== undefined &&
          typeof b.forbid_self_approval !== "boolean")
      )
        fail("核對政策的啟用及自行核准選項須為布林值");
      if (integer(b.version) !== old.version) fail("三方核對政策已更新", 409);
      if (
        b.require_matching &&
        !old.require_matching &&
        e.access.one(
          "SELECT o.id FROM open_items o JOIN fulfilments f ON f.id=o.fulfilment_id WHERE o.kind='payable' AND o.amount>o.paid AND (f.calc_version<2 OR EXISTS(SELECT 1 FROM allowances a WHERE a.fulfilment_id=f.id AND NOT EXISTS(SELECT 1 FROM allowance_lines al WHERE al.allowance_id=a.id))) LIMIT 1",
        )
      )
        fail(
          "尚有不能逐列核對的未結舊來源，請先用原流程由財務核對處理，再啟用強制付款管制",
          409,
        );
      const p = {
        version: old.version + 1,
        require_matching: b.require_matching === true,
        quantity_tolerance_bp: integer(b.quantity_tolerance_bp ?? 0, 0, 1000),
        net_tolerance_bp: integer(b.net_tolerance_bp ?? 0, 0, 1000),
        tax_tolerance_cents: scaled(b.tax_tolerance ?? "0", 2, 0, 10000),
        forbid_self_approval: b.forbid_self_approval !== false,
      };
      e.run(
        "UPDATE settings SET value=? WHERE key='procurement_control_policy'",
        JSON.stringify(p),
      );
      e.log(u, "procurement_policy", "settings", 1, {
        previous: old,
        current: p,
      });
      return p;
    });
  }
  source(u, id) {
    const e = this.e;
    moneyPermission(e, u);
    const row = e.access.one(
      "SELECT l.*,f.document_id,f.no receipt_no,f.calc_version,d.no document_no,d.partner_id,d.warehouse_id,d.kind document_kind,dl.sku,dl.name,dl.unit,dl.price order_price,dl.qty ordered_qty,o.id open_item_id,o.amount payable_amount,o.paid,o.billing_state FROM fulfilment_lines l JOIN fulfilments f ON f.id=l.fulfilment_id JOIN documents d ON d.id=f.document_id JOIN document_lines dl ON dl.id=l.document_line_id JOIN open_items o ON o.fulfilment_id=f.id WHERE l.id=? AND f.kind='receipt' AND o.kind='payable'",
      integer(id, 1),
    );
    if (!row) fail("進貨明細不存在", 404);
    sourcePermission(e, u, row.document_id);
    e.access.assert(
      e.access.policy(u),
      "billing",
      "read",
      "open_items",
      row.open_item_id,
    );
    if (row.calc_version < 2)
      fail("此舊版進貨未保存逐列稅額，請先由財務核對，不能自動三方核對", 409);
    if (
      e.access.one(
        "SELECT a.id FROM allowances a WHERE a.fulfilment_id=? AND NOT EXISTS(SELECT 1 FROM allowance_lines al WHERE al.allowance_id=a.id)",
        row.fulfilment_id,
      )
    )
      fail("來源含舊版整筆折讓，不能推估逐列核對金額", 409);
    const ret = e.access.one(
        "SELECT COALESCE(sum(net),0) net,COALESCE(sum(tax),0) tax FROM return_lines WHERE fulfilment_line_id=?",
        row.id,
      ),
      allowance = e.access.one(
        "SELECT COALESCE(sum(net),0) net,COALESCE(sum(tax),0) tax FROM allowance_lines WHERE fulfilment_line_id=?",
        row.id,
      );
    return {
      ...row,
      expected_qty: row.qty - row.returned_qty,
      expected_net: row.net - ret.net - allowance.net,
      expected_tax: row.tax - ret.tax - allowance.tax,
      return_max: e.access.one(
        "SELECT COALESCE(max(id),0) n FROM returns WHERE fulfilment_id=?",
        row.fulfilment_id,
      ).n,
      allowance_max: e.access.one(
        "SELECT COALESCE(max(id),0) n FROM allowances WHERE fulfilment_id=?",
        row.fulfilment_id,
      ).n,
    };
  }
  authorize(u, id, action = "read") {
    const e = this.e;
    controlPermission(e, u, "vendor_bills", action, id);
    moneyPermission(e, u);
    const b = e.access.one(
      "SELECT * FROM vendor_bills WHERE id=?",
      integer(id, 1),
    );
    if (!b) fail("供應商請款單不存在", 404);
    for (const line of e.access.raw(
      "SELECT receipt_line_id FROM vendor_bill_lines WHERE bill_id=?",
      b.id,
    ))
      this.source(u, line.receipt_line_id);
    return b;
  }
  save(u, b) {
    const e = this.e;
    controlPermission(e, u, "vendor_bills", b.id ? "update" : "create", b.id);
    moneyPermission(e, u);
    return e.tx(() => {
      const old = b.id ? this.authorize(u, b.id, "update") : null;
      if (
        old &&
        (old.status !== "draft" || old.version !== integer(b.version, 1))
      )
        fail("請款單已更新或不是草稿", 409);
      const supplier = e.partner(u, b.supplier_id, "supplier"),
        ref = txt(b.invoice_ref, 100, true).toUpperCase(),
        date = dateValue(b.date);
      if (date > today()) fail("請款憑證日期不可晚於今天");
      if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 200)
        fail("請選擇 1–200 筆進貨明細");
      const seen = new Set();
      const lines = b.lines.map((l) => {
        const source = this.source(u, l.receipt_line_id);
        if (source.partner_id !== supplier.id || seen.has(source.id))
          fail("進貨明細重複或不屬於此供應商");
        seen.add(source.id);
        return {
          source,
          qty: scaled(l.qty, 3, 1),
          net: scaled(l.net),
          tax: scaled(l.tax),
        };
      });
      const total = integer(lines.reduce((s, l) => s + l.net + l.tax, 0));
      if (!total) fail("請款總額不可為零");
      if (b.total !== undefined && scaled(b.total) !== total)
        fail("憑證總額與請款明細合計不符");
      const vals = [supplier.id, ref, date, txt(b.notes, 2000), total];
      let id = old?.id;
      if (id) {
        e.run(
          "UPDATE vendor_bills SET supplier_id=?,invoice_ref=?,date=?,notes=?,total=?,version=version+1 WHERE id=?",
          ...vals,
          id,
        );
        e.run("DELETE FROM vendor_bill_lines WHERE bill_id=?", id);
      } else
        id = Number(
          e.run(
            "INSERT INTO vendor_bills(supplier_id,invoice_ref,date,notes,total,no,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
            ...vals,
            e.number("VB"),
            u.id,
            now(),
          ).lastInsertRowid,
        );
      for (const l of lines)
        e.run(
          "INSERT INTO vendor_bill_lines(bill_id,receipt_line_id,qty,claimed_net,claimed_tax) VALUES(?,?,?,?,?)",
          id,
          l.source.id,
          l.qty,
          l.net,
          l.tax,
        );
      controlPermission(e, u, "vendor_bills", old ? "update" : "create", id);
      this.event(u, id, "save", { total, invoice_ref: ref });
      return this.detail(u, id);
    });
  }
  match(u, id) {
    const e = this.e,
      b = this.authorize(u, id),
      policy = this.policy(),
      issues = [],
      lines = e.access
        .raw(
          "SELECT * FROM vendor_bill_lines WHERE bill_id=? ORDER BY id",
          b.id,
        )
        .map((l) => ({ ...l, source: this.source(u, l.receipt_line_id) }));
    const receipts = new Set(lines.map((l) => l.source.fulfilment_id));
    for (const fid of receipts) {
      const required = e.access
        .raw("SELECT id FROM fulfilment_lines WHERE fulfilment_id=?", fid)
        .map((r) => this.source(u, r.id))
        .filter((l) => l.expected_qty || l.expected_net || l.expected_tax);
      if (required.some((l) => !lines.some((x) => x.receipt_line_id === l.id)))
        issues.push("必須核對同一張進貨單的全部未退明細；分批請款請先分批進貨");
    }
    let variance = false;
    for (const l of lines) {
      const s = l.source;
      if (
        s.partner_id !== b.supplier_id ||
        !s.expected_qty ||
        s.expected_net < 0 ||
        s.expected_tax < 0
      )
        issues.push("來源對象或退貨／折讓後明細不符");
      l.qty_difference = l.qty - s.expected_qty;
      l.net_difference = l.claimed_net - s.expected_net;
      l.tax_difference = l.claimed_tax - s.expected_tax;
      if (
        BigInt(Math.abs(l.qty_difference)) * 10000n >
        BigInt(s.expected_qty) * BigInt(policy.quantity_tolerance_bp)
      )
        issues.push(s.receipt_no + " 數量差異超出容忍範圍");
      if (
        BigInt(Math.abs(l.net_difference)) * 10000n >
        BigInt(s.expected_net) * BigInt(policy.net_tolerance_bp)
      )
        issues.push(s.receipt_no + " 未稅金額／單價差異超出容忍範圍");
      if (s.expected_qty > 0) {
        const difference =
          BigInt(l.claimed_net) * BigInt(s.expected_qty) -
          BigInt(s.expected_net) * BigInt(l.qty);
        const absolute = difference < 0n ? -difference : difference;
        if (
          absolute * 10000n >
          BigInt(s.expected_net) *
            BigInt(l.qty) *
            BigInt(policy.net_tolerance_bp)
        )
          issues.push(s.receipt_no + " 單價差異超出容忍範圍");
      }
      if (Math.abs(l.tax_difference) > policy.tax_tolerance_cents)
        issues.push(s.receipt_no + " 稅額差異超出容忍範圍");
      if (l.qty_difference || l.net_difference || l.tax_difference)
        variance = true;
      if (
        e.access.one(
          "SELECT b.id FROM vendor_bill_links l JOIN vendor_bills b ON b.id=l.bill_id WHERE l.open_item_id=? AND b.status='approved' AND b.id<>?",
          s.open_item_id,
          b.id,
        )
      )
        issues.push(s.receipt_no + " 已由其他有效請款單核准");
    }
    const sources = [
      ...new Map(lines.map((l) => [l.source.open_item_id, l.source])).values(),
    ];
    // Conserves book amounts even after partial returns and row-based allowances.
    for (const s of sources) {
      const sum = lines
        .filter((l) => l.source.open_item_id === s.open_item_id)
        .reduce((n, l) => n + l.source.expected_net + l.source.expected_tax, 0);
      if (sum !== s.payable_amount)
        issues.push(s.receipt_no + " 逐列餘額與帳款不一致，請先由財務核對");
    }
    const result = {
      bill: b,
      policy,
      lines,
      sources,
      issues: [...new Set(issues)],
      within_tolerance: issues.length === 0,
      has_variance: variance,
    };
    return { ...result, token: hash(result) };
  }
  action(u, id, b) {
    const e = this.e;
    if (!["approve", "cancel"].includes(b.action)) fail("請款處理動作錯誤");
    return e.tx(() => {
      const bill = this.authorize(u, id, b.action);
      if (bill.version !== integer(b.version, 1)) fail("請款單已更新", 409);
      const reason = txt(b.reason, 1000, true);
      if (b.action === "approve") {
        if (bill.status !== "draft") fail("只有草稿請款單可核准", 409);
        const match = this.match(u, bill.id);
        if (match.token !== b.token)
          fail("核對來源、政策或請款內容已變更，請重新預覽", 409);
        if (!match.within_tolerance)
          fail("三方核對仍有差異：" + match.issues.join("；"), 409);
        if (
          match.policy.forbid_self_approval &&
          (bill.created_by === u.id ||
            e.access.one(
              "SELECT id FROM vendor_bill_events WHERE bill_id=? AND action='save' AND created_by=?",
              bill.id,
              u.id,
            ))
        )
          fail("政策禁止請款建單或修改者自行核准", 403);
        if (match.has_variance && b.accept_variance !== true)
          fail("請明確確認容忍範圍內的差額；不會自動調整庫存或帳款", 409);
        e.checkPeriod(today(), "finance");
        for (const s of match.sources)
          e.run(
            "INSERT INTO vendor_bill_links VALUES(?,?,?,?,?,?)",
            bill.id,
            s.open_item_id,
            s.payable_amount,
            s.return_max,
            s.allowance_max,
            JSON.stringify({
              policy: match.policy,
              receipt_no: s.receipt_no,
              document_no: s.document_no,
              lines: match.lines.filter(
                (l) => l.source.open_item_id === s.open_item_id,
              ),
            }),
          );
        e.run(
          "UPDATE vendor_bills SET status='approved',version=version+1,approved_by=? WHERE id=?",
          u.id,
          bill.id,
        );
        this.event(u, bill.id, "approve", {
          reason,
          policy: match.policy,
          has_variance: match.has_variance,
        });
      } else {
        if (bill.status === "cancelled") fail("請款單已取消", 409);
        e.run(
          "UPDATE vendor_bills SET status='cancelled',version=version+1 WHERE id=?",
          bill.id,
        );
        this.event(u, bill.id, "cancel", { reason });
      }
      return this.detail(u, bill.id);
    });
  }
  event(u, id, action, detail) {
    this.e.run(
      "INSERT INTO vendor_bill_events(bill_id,action,detail,created_by,created_at) VALUES(?,?,?,?,?)",
      id,
      action,
      JSON.stringify(detail),
      u.id,
      now(),
    );
    this.e.log(u, "vendor_bill_" + action, "vendor_bill", id, detail);
  }
  detail(u, id) {
    const e = this.e,
      b = this.authorize(u, id),
      match = this.match(u, id),
      links = e.access
        .raw("SELECT * FROM vendor_bill_links WHERE bill_id=?", b.id)
        .map((l) => ({ ...l, snapshot: JSON.parse(l.snapshot) }));
    const valid =
      b.status === "approved" &&
      links.length > 0 &&
      links.every((l) => {
        const s = match.sources.find((s) => s.open_item_id === l.open_item_id);
        return (
          s &&
          s.payable_amount === l.source_amount &&
          s.return_max === l.return_max &&
          s.allowance_max === l.allowance_max
        );
      });
    return {
      ...b,
      match,
      links,
      payment_valid: valid,
      events: e.access.raw(
        "SELECT ev.*,u.name actor_name FROM vendor_bill_events ev JOIN users u ON u.id=ev.created_by WHERE bill_id=? ORDER BY ev.id",
        b.id,
      ),
      allowed: {
        update: canControl(e, u, "vendor_bills", "update", b.id),
        approve: canControl(e, u, "vendor_bills", "approve", b.id),
        cancel: canControl(e, u, "vendor_bills", "cancel", b.id),
      },
    };
  }
  sources(u, query = {}) {
    const e = this.e;
    controlPermission(e, u, "vendor_bills", "read");
    moneyPermission(e, u);
    const supplier = integer(query.supplier_id, 1);
    e.partner(u, supplier, "supplier");
    const no = txt(query.source_no, 100);
    const ids = e.access.raw(
      `SELECT l.id FROM fulfilment_lines l JOIN fulfilments f ON f.id=l.fulfilment_id JOIN documents d ON d.id=f.document_id JOIN open_items o ON o.fulfilment_id=f.id WHERE f.kind='receipt' AND f.calc_version>=2 AND o.amount>0 AND d.partner_id=? AND (?='' OR f.no=? OR d.no=?) AND d.id IN (SELECT id FROM documents WHERE ${e.access.predicate(e.access.policy(u), "documents")}) ORDER BY l.id DESC LIMIT 500`,
      supplier,
      no,
      no,
      no,
    );
    return ids.flatMap((r) => {
      try {
        return [this.source(u, r.id)];
      } catch (error) {
        if ([403, 409].includes(error.status)) return [];
        throw error;
      }
    });
  }
  data(u) {
    const e = this.e;
    if (!canControl(e, u, "vendor_bills", "read")) return {};
    const p = e.access.policy(u),
      documents = e.access.predicate(p, "documents"),
      items = e.access.predicate(p, "open_items");
    const bills = e.access
      .raw(
        `SELECT b.id,b.no,b.supplier_id,b.invoice_ref,b.date,b.status,b.total,b.version,
      (b.status='approved' AND EXISTS(SELECT 1 FROM vendor_bill_links vl WHERE vl.bill_id=b.id) AND NOT EXISTS(
        SELECT 1 FROM vendor_bill_links vl JOIN open_items o ON o.id=vl.open_item_id WHERE vl.bill_id=b.id AND (vl.source_amount<>o.amount OR vl.return_max<>COALESCE((SELECT max(id) FROM returns WHERE fulfilment_id=o.fulfilment_id),0) OR vl.allowance_max<>COALESCE((SELECT max(id) FROM allowances WHERE fulfilment_id=o.fulfilment_id),0)))) payment_valid
      FROM vendor_bills b WHERE b.id IN (SELECT id FROM vendor_bills WHERE ${e.access.predicate(p, "vendor_bills")}) AND NOT EXISTS(
        SELECT 1 FROM vendor_bill_lines bl JOIN fulfilment_lines fl ON fl.id=bl.receipt_line_id JOIN fulfilments f ON f.id=fl.fulfilment_id JOIN open_items o ON o.fulfilment_id=f.id WHERE bl.bill_id=b.id AND (f.document_id NOT IN (SELECT id FROM documents WHERE ${documents}) OR o.id NOT IN (SELECT id FROM open_items WHERE ${items})))
      ORDER BY b.id DESC LIMIT 500`,
      )
      .map((b) => ({ ...b, payment_valid: !!b.payment_valid }));
    return {
      vendor_bills: bills,
      procurement_control_policy: this.policy(),
      vendor_bill_permissions: {
        create: canControl(e, u, "vendor_bills", "create"),
        configure: p.superuser,
      },
    };
  }
}
