import { fail, integer, ratio } from "./core.mjs";
export function allowancePlan(e, f, total, b) {
  if (f.calc_version < 2) fail("舊計算版本需先由財務逐筆核對並轉換折讓明細");
  const lines = e
    .all(
      "SELECT * FROM fulfilment_lines WHERE fulfilment_id=? ORDER BY id",
      f.id,
    )
    .map((l) => {
      const returns = e.get(
          "SELECT COALESCE(sum(net),0) net,COALESCE(sum(tax),0) tax FROM return_lines WHERE fulfilment_line_id=?",
          l.id,
        ),
        prior = e.get(
          "SELECT COALESCE(sum(net),0) net,COALESCE(sum(tax),0) tax FROM allowance_lines WHERE fulfilment_line_id=?",
          l.id,
        );
      return {
        ...l,
        available_net: l.net - returns.net - prior.net,
        available_tax: l.tax - returns.tax - prior.tax,
      };
    });
  // Older flat allowances have no reliable line allocation. Keep their existing safe block until explicitly reconciled.
  if (
    e.get(
      "SELECT a.id FROM allowances a WHERE a.fulfilment_id=? AND NOT EXISTS (SELECT 1 FROM allowance_lines l WHERE l.allowance_id=a.id)",
      f.id,
    )
  )
    fail("此單含舊版整筆折讓，請先由財務核對明細");
  const available = lines.reduce(
    (s, l) => s + l.available_net + l.available_tax,
    0,
  );
  if (total > available) fail("折讓超過剩餘可折讓金額", 409);
  let cumulative = 0,
    done = 0;
  return lines
    .filter((l) => l.qty > l.returned_qty)
    .map((l) => {
      const capacity = l.available_net + l.available_tax;
      cumulative += capacity;
      const target = available ? ratio(total, cumulative, available) : 0,
        amount = target - done;
      done = target;
      const net = capacity ? ratio(l.available_net, amount, capacity) : 0;
      return {
        ...l,
        allowance_net: net,
        allowance_tax: amount - net,
        cost_policy:
          f.kind === "receipt" ? b.cost_policy || "variance" : "variance",
      };
    })
    .filter((l) => l.allowance_net + l.allowance_tax > 0);
}
export function recordAllowanceLines(e, u, f, allowanceId, no, plan) {
  let inventory = 0;
  for (const l of plan) {
    if (!["variance", "inventory"].includes(l.cost_policy))
      fail("採購折讓成本政策錯誤");
    e.run(
      "INSERT INTO allowance_lines(allowance_id,fulfilment_line_id,net,tax,start_returned_qty,qty_basis,cost_policy) VALUES(?,?,?,?,?,?,?)",
      allowanceId,
      l.id,
      l.allowance_net,
      l.allowance_tax,
      l.returned_qty,
      l.qty - l.returned_qty,
      l.cost_policy,
    );
    if (l.cost_policy === "inventory" && l.track_stock) {
      const d = e.get(
          "SELECT warehouse_id FROM documents WHERE id=?",
          f.document_id,
        ),
        s = e.stock(l.product_id, d.warehouse_id);
      if (s.value < l.allowance_net)
        fail("目前庫存金額不足以承擔此折讓，請採損益政策或拆分折讓", 409);
      e.stockMove(
        u,
        l.product_id,
        d.warehouse_id,
        0,
        -l.allowance_net,
        "purchase_allowance",
        no,
        "採購折讓減少存貨價值",
      );
      inventory += l.allowance_net;
    }
  }
  if (inventory)
    e.journal(
      u,
      "採購折讓成本重分類",
      no,
      [
        ["5100", inventory, 0],
        ["1200", 0, inventory],
      ],
      e.get("SELECT date FROM allowances WHERE id=?", allowanceId).date,
    );
}
export function returnAllowancePlan(e, l, q) {
  return e
    .all(
      "SELECT * FROM allowance_lines WHERE fulfilment_line_id=? ORDER BY id",
      l.id,
    )
    .map((a) => {
      const done = l.returned_qty - a.start_returned_qty;
      if (done < 0 || done + q > a.qty_basis)
        fail("折讓與退貨數量基礎不一致", 409);
      return {
        id: a.id,
        net:
          ratio(a.net, done + q, a.qty_basis) - ratio(a.net, done, a.qty_basis),
        tax:
          ratio(a.tax, done + q, a.qty_basis) - ratio(a.tax, done, a.qty_basis),
      };
    });
}
