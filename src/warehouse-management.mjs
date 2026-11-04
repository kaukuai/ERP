import { fail, permit, integer, scaled, txt, today, now } from "./core.mjs";
import {
  enterprisePermission as permission,
  enterpriseRows as rows,
  revision,
  event,
} from "./enterprise-common.mjs";
import { sourcePermission } from "./control-access.mjs";

const resource = "warehouse_waves";
const enabled = (e, w) =>
  Boolean(
    e.get("SELECT enabled FROM warehouse_controls WHERE warehouse_id=?", w)
      ?.enabled,
  );
export function usableQuantity(e, p, w, quantity) {
  if (
    !e.access.one(
      "SELECT enabled FROM warehouse_controls WHERE warehouse_id=?",
      w,
    )?.enabled
  )
    return quantity;
  return (
    quantity -
    e.access.one(
      "SELECT COALESCE(sum(bb.qty),0) n FROM bin_balances bb JOIN storage_bins b ON b.id=bb.bin_id WHERE bb.product_id=? AND b.warehouse_id=? AND b.kind IN ('blocked','shipping')",
      p,
      w,
    ).n
  );
}
function reserved(e, balance, except = 0) {
  return e.get(
    "SELECT COALESCE(sum(r.qty),0) n FROM bin_reservations r JOIN warehouse_wave_lines l ON l.id=r.wave_line_id JOIN warehouse_waves w ON w.id=l.wave_id WHERE r.balance_id=? AND w.status='draft' AND w.id<>?",
    balance,
    except,
  ).n;
}
function balance(e, bin, p, code, expiry = "") {
  e.run(
    "INSERT OR IGNORE INTO bin_balances(bin_id,product_id,lot_code,expiry) VALUES(?,?,?,?)",
    bin,
    p,
    code,
    expiry,
  );
  const r = e.get(
    "SELECT * FROM bin_balances WHERE bin_id=? AND product_id=? AND lot_code=?",
    bin,
    p,
    code,
  );
  if (r.expiry !== expiry) fail("同一批號在儲位的效期不符", 409);
  return r;
}
function capacity(e, bin, q) {
  if (
    bin.capacity_qty &&
    e.get(
      "SELECT COALESCE(sum(qty),0) n FROM bin_balances WHERE bin_id=?",
      bin.id,
    ).n +
      q >
      bin.capacity_qty
  )
    fail("超過儲位容量：" + bin.code, 409);
}
function move(e, u, b, p, code, expiry, q, kind, ref, stockId = null) {
  const r = balance(e, b.id, p, code, expiry);
  if (r.qty + q < 0) fail("儲位庫存不足", 409);
  if (q > 0) capacity(e, b, q);
  e.run("UPDATE bin_balances SET qty=qty+? WHERE id=?", q, r.id);
  e.run(
    "INSERT INTO bin_moves(bin_id,product_id,lot_code,expiry,qty,stock_move_id,kind,reference,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    b.id,
    p,
    code,
    expiry,
    q,
    stockId,
    kind,
    ref,
    u.id,
    now(),
  );
}
export function assertNoWarehouseWave(e, documentId) {
  const r = e.get(
    "SELECT w.id,w.no FROM warehouse_wave_lines l JOIN warehouse_waves w ON w.id=l.wave_id WHERE l.document_id=? AND w.status='draft' LIMIT 1",
    documentId,
  );
  if (r && e.wmsWave !== r.id)
    fail("來源已在儲位波次 " + r.no + "，請由波次出貨或先取消波次", 409);
}
export function prepareBinMove(e, p, w, q, kind, lots, options) {
  if (!q || !enabled(e, w)) return [];
  const choices = options?.bins ?? e.inventorySelection?.bins,
    explicit =
      choices === undefined
        ? null
        : Array.isArray(choices)
          ? choices
          : fail("儲位明細格式錯誤");
  const split = lots.length
      ? lots.map((l) => ({
          code: l.code,
          expiry: l.expiry,
          qty: Math.abs(l.qty),
        }))
      : [{ code: "", expiry: "", qty: Math.abs(q) }],
    out = q < 0,
    plans = [];
  for (const lot of split) {
    let left = lot.qty;
    if (explicit) {
      const seen = new Set();
      for (const r of explicit.filter(
        (x) =>
          Number(x.product_id) === p &&
          (!x.warehouse_id || Number(x.warehouse_id) === w) &&
          String(x.lot_code || "") === lot.code,
      )) {
        const id = integer(r.bin_id, 1);
        if (seen.has(id)) fail("同商品／批號儲位重複");
        seen.add(id);
        const b = e.get(
          "SELECT * FROM storage_bins WHERE id=? AND warehouse_id=? AND active=1",
          id,
          w,
        );
        if (!b) fail("所選儲位不屬於此倉庫");
        if (out && ["blocked", "shipping"].includes(b.kind))
          fail("此儲位不可供出庫，請先移位", 409);
        const amount = scaled(r.qty, 3, 1),
          s = balance(e, id, p, lot.code, lot.expiry);
        if (out && amount > s.qty - reserved(e, s.id, e.wmsWave || 0))
          fail("儲位可用量不足或已分配給其他波次", 409);
        if (!out) capacity(e, b, amount);
        left -= amount;
        plans.push({
          bin: b,
          p,
          code: lot.code,
          expiry: lot.expiry,
          qty: out ? -amount : amount,
        });
      }
    } else if (!out) {
      const b = e.get(
        "SELECT * FROM storage_bins WHERE warehouse_id=? AND kind='receiving' AND active=1 ORDER BY priority,id LIMIT 1",
        w,
      );
      if (!b) fail("倉庫缺少啟用的收貨儲位", 409);
      capacity(e, b, left);
      plans.push({ bin: b, p, code: lot.code, expiry: lot.expiry, qty: left });
      left = 0;
    } else {
      const available = e.all(
        "SELECT bb.*,b.kind,b.priority FROM bin_balances bb JOIN storage_bins b ON b.id=bb.bin_id WHERE b.warehouse_id=? AND b.active=1 AND b.kind IN ('pick','storage','receiving') AND bb.product_id=? AND bb.lot_code=? AND bb.qty>0 ORDER BY CASE b.kind WHEN 'pick' THEN 0 WHEN 'storage' THEN 1 ELSE 2 END,b.priority,b.id",
        w,
        p,
        lot.code,
      );
      for (const r of available) {
        const take = Math.min(left, r.qty - reserved(e, r.id, e.wmsWave || 0));
        if (take > 0) {
          plans.push({
            bin: e.get("SELECT * FROM storage_bins WHERE id=?", r.bin_id),
            p,
            code: lot.code,
            expiry: lot.expiry,
            qty: -take,
          });
          left -= take;
        }
        if (!left) break;
      }
    }
    if (left !== 0)
      fail("儲位數量需等於庫存異動量；請核對可用量與波次預留", 409);
  }
  return plans;
}
export function commitBinMove(e, u, plans, stockId, kind, ref) {
  for (const r of plans)
    move(e, u, r.bin, r.p, r.code, r.expiry, r.qty, kind, ref, stockId);
}
export class WarehouseManagement {
  constructor(e) {
    this.e = e;
  }
  bin(u, id, action = "read") {
    permission(this.e, u, "storage_bins", action, id);
    const b = this.e.get(
      "SELECT * FROM storage_bins WHERE id=?",
      integer(id, 1),
    );
    if (!b) fail("儲位不存在", 404);
    this.e.warehouse(b.warehouse_id);
    return b;
  }
  saveBin(u, b) {
    permission(this.e, u, "storage_bins", b.id ? "update" : "create", b.id);
    return this.e.tx(() => {
      const old = b.id ? this.bin(u, b.id, "update") : null;
      if (old) revision(old, b);
      const w = this.e.warehouse(b.warehouse_id),
        kind = b.kind;
      if (
        !["receiving", "storage", "pick", "shipping", "blocked"].includes(kind)
      )
        fail("儲位類型錯誤");
      const code = txt(b.code, 40, true).toUpperCase(),
        name = txt(b.name, 80, true),
        cap = scaled(b.capacity_qty || "0", 3),
        priority = integer(b.priority ?? 100, 0, 10000),
        active = b.active !== false ? 1 : 0;
      if (old && old.warehouse_id !== w.id)
        fail("既有儲位不能改變所屬倉庫，請另建儲位", 409);
      if (
        this.e.get(
          "SELECT id FROM storage_bins WHERE warehouse_id=? AND code=? AND id<>?",
          w.id,
          code,
          old?.id || 0,
        )
      )
        fail("儲位代號重複", 409);
      if (
        old &&
        (old.warehouse_id !== w.id || old.kind !== kind || !active) &&
        this.e.get(
          "SELECT id FROM bin_balances WHERE bin_id=? AND qty>0",
          old.id,
        )
      )
        fail("有庫存的儲位不能變更倉庫、類型或停用", 409);
      if (
        old &&
        old.warehouse_id !== w.id &&
        this.e.get("SELECT id FROM bin_moves WHERE bin_id=?", old.id)
      )
        fail("有流水的儲位不能改倉庫", 409);
      if (
        old &&
        cap &&
        this.e.get(
          "SELECT COALESCE(sum(qty),0) n FROM bin_balances WHERE bin_id=?",
          old.id,
        ).n > cap
      )
        fail("容量小於目前庫存", 409);
      let id = old?.id;
      if (id)
        this.e.run(
          "UPDATE storage_bins SET code=?,name=?,kind=?,capacity_qty=?,priority=?,active=?,version=version+1 WHERE id=?",
          code,
          name,
          kind,
          cap,
          priority,
          active,
          id,
        );
      else
        id = Number(
          this.e.run(
            "INSERT INTO storage_bins(warehouse_id,code,name,kind,capacity_qty,priority,active,created_by) VALUES(?,?,?,?,?,?,?,?)",
            w.id,
            code,
            name,
            kind,
            cap,
            priority,
            active,
            u.id,
          ).lastInsertRowid,
        );
      permission(this.e, u, "storage_bins", old ? "update" : "create", id);
      event(this.e, u, "storage_bins", id, "save", { code, kind, cap });
      return this.bin(u, id);
    });
  }
  enable(u, b) {
    this.e.access.requireAdmin(u);
    return this.e.tx(() => {
      const w = this.e.warehouse(b.warehouse_id),
        old = this.e.get(
          "SELECT * FROM warehouse_controls WHERE warehouse_id=?",
          w.id,
        );
      if ((old?.version || 0) !== integer(b.version ?? 0))
        fail("倉庫設定已變更", 409);
      if (old?.enabled) fail("此倉庫已啟用儲位管理", 409);
      let bin = this.e.get(
        "SELECT * FROM storage_bins WHERE warehouse_id=? AND kind='receiving' AND active=1 ORDER BY priority,id LIMIT 1",
        w.id,
      );
      if (!bin) {
        const r = this.saveBin(u, {
          warehouse_id: w.id,
          code: "RECEIVING",
          name: "待上架收貨區",
          kind: "receiving",
          priority: 0,
        });
        bin = r;
      }
      for (const s of this.e.all(
        "SELECT s.*,p.tracking_mode FROM stocks s JOIN products p ON p.id=s.product_id WHERE warehouse_id=? AND s.qty>0",
        w.id,
      )) {
        const lots =
          s.tracking_mode === "none"
            ? [{ code: "", expiry: "", qty: s.qty }]
            : this.e.all(
                "SELECT code,expiry,qty FROM inventory_lots WHERE product_id=? AND warehouse_id=? AND qty>0",
                s.product_id,
                w.id,
              );
        if (lots.reduce((n, r) => n + r.qty, 0) !== s.qty)
          fail("批號與倉庫庫存不符，不能啟用儲位", 409);
        for (const l of lots)
          move(
            this.e,
            u,
            bin,
            s.product_id,
            l.code,
            l.expiry,
            l.qty,
            "bin_opening",
            "WMS-" + w.id,
          );
      }
      this.e.run(
        "INSERT INTO warehouse_controls(warehouse_id,enabled,version) VALUES(?,1,1) ON CONFLICT(warehouse_id) DO UPDATE SET enabled=1,version=version+1",
        w.id,
      );
      event(this.e, u, "warehouse_controls", w.id, "enable");
      return { ok: true };
    });
  }
  rule(u, b) {
    permission(this.e, u, "storage_bins", b.id ? "update" : "create");
    return this.e.tx(() => {
      const bin = this.bin(u, b.bin_id, "update");
      if (!["pick", "storage"].includes(bin.kind))
        fail("上架目標須為存放或揀貨儲位");
      const p = b.product_id ? this.e.product(b.product_id) : null,
        old = b.id
          ? this.e.get(
              "SELECT * FROM putaway_rules WHERE id=?",
              integer(b.id, 1),
            )
          : null;
      if (old) {
        revision(old, b);
        this.bin(u, old.bin_id, "update");
      }
      const vals = [
        bin.warehouse_id,
        p?.id || null,
        txt(b.category, 80),
        bin.id,
        integer(b.priority ?? 100, 0, 10000),
        b.active === false ? 0 : 1,
      ];
      let id = old?.id;
      if (id)
        this.e.run(
          "UPDATE putaway_rules SET warehouse_id=?,product_id=?,category=?,bin_id=?,priority=?,active=?,version=version+1 WHERE id=?",
          ...vals,
          id,
        );
      else
        id = Number(
          this.e.run(
            "INSERT INTO putaway_rules(warehouse_id,product_id,category,bin_id,priority,active,created_by) VALUES(?,?,?,?,?,?,?)",
            ...vals,
            u.id,
          ).lastInsertRowid,
        );
      event(this.e, u, "putaway_rules", id, "save");
      return { id };
    });
  }
  transfer(u, b) {
    permission(this.e, u, "storage_bins", "post");
    return this.e.tx(() => {
      this.e.checkPeriod(today(), "inventory");
      const from = this.bin(u, b.from_bin_id, "post"),
        p = this.e.product(b.product_id),
        qty = scaled(b.qty, 3, 1),
        code = txt(b.lot_code, 100),
        s = this.e.get(
          "SELECT * FROM bin_balances WHERE bin_id=? AND product_id=? AND lot_code=?",
          from.id,
          p.id,
          code,
        );
      if (!enabled(this.e, from.warehouse_id)) fail("請先啟用倉庫儲位管理");
      if (!s || qty > s.qty - reserved(this.e, s.id))
        fail("來源儲位可用量不足", 409);
      let choices;
      if (b.to_bin_id) choices = [this.bin(u, b.to_bin_id, "post")];
      else {
        const rules = this.e.all(
          "SELECT r.*,b.* FROM putaway_rules r JOIN storage_bins b ON b.id=r.bin_id WHERE r.warehouse_id=? AND r.active=1 AND b.active=1 AND (r.product_id IS NULL OR r.product_id=?) AND (r.category='' OR r.category=?) ORDER BY CASE WHEN r.product_id IS NOT NULL THEN 0 ELSE 1 END,r.priority,r.id",
          from.warehouse_id,
          p.id,
          p.category,
        );
        choices = [
          ...rules,
          ...this.e.all(
            "SELECT * FROM storage_bins WHERE warehouse_id=? AND active=1 AND kind IN ('storage','pick') ORDER BY priority,id",
            from.warehouse_id,
          ),
        ];
      }
      const ref = this.e.number("BM"),
        seen = new Set();
      let left = qty;
      for (const to of choices) {
        if (seen.has(to.id) || to.id === from.id) continue;
        seen.add(to.id);
        this.bin(u, to.id, "post");
        if (to.warehouse_id !== from.warehouse_id)
          fail("跨倉移動請使用倉庫調撥");
        if (!to.active) fail("目的儲位停用");
        const free = to.capacity_qty
            ? to.capacity_qty -
              this.e.get(
                "SELECT COALESCE(sum(qty),0) n FROM bin_balances WHERE bin_id=?",
                to.id,
              ).n
            : left,
          take = Math.min(left, free);
        if (take <= 0) continue;
        if (
          ["blocked", "shipping"].includes(to.kind) &&
          !["blocked", "shipping"].includes(from.kind)
        ) {
          const stock = this.e.stock(p.id, from.warehouse_id);
          if (take > stock.usable_qty - stock.reserved)
            fail("不能凍結或暫存已預留給訂單／製造的庫存", 409);
        }
        move(this.e, u, from, p.id, code, s.expiry, -take, "bin_transfer", ref);
        move(this.e, u, to, p.id, code, s.expiry, take, "bin_transfer", ref);
        left -= take;
        if (!left) break;
      }
      if (left) fail("目標容量不足，移位已整批取消", 409);
      event(this.e, u, "storage_bins", from.id, "transfer", {
        ref,
        product_id: p.id,
        qty,
        reason: txt(b.reason, 500, true),
      });
      return { no: ref };
    });
  }
  replenishment(u, b) {
    permission(this.e, u, "storage_bins", "update");
    return this.e.tx(() => {
      const bin = this.bin(u, b.bin_id, "update"),
        p = this.e.product(b.product_id);
      if (bin.kind !== "pick") fail("補揀目標須為揀貨儲位");
      const min = scaled(b.min_qty, 3),
        target = scaled(b.target_qty, 3, 1);
      if (target < min || (bin.capacity_qty && target > bin.capacity_qty))
        fail("補揀目標需大於最低量且不超容量");
      const old = this.e.get(
        "SELECT * FROM bin_replenishment WHERE bin_id=? AND product_id=?",
        bin.id,
        p.id,
      );
      if ((old?.version || 0) !== integer(b.version ?? 0))
        fail("補揀設定已變更", 409);
      this.e.run(
        "INSERT INTO bin_replenishment(bin_id,product_id,min_qty,target_qty,created_by) VALUES(?,?,?,?,?) ON CONFLICT(bin_id,product_id) DO UPDATE SET min_qty=excluded.min_qty,target_qty=excluded.target_qty,version=version+1",
        bin.id,
        p.id,
        min,
        target,
        u.id,
      );
      event(this.e, u, "storage_bins", bin.id, "replenishment", {
        product_id: p.id,
        min,
        target,
      });
      return { ok: true };
    });
  }
  replenish(u, b) {
    permission(this.e, u, "storage_bins", "post");
    return this.e.tx(() => {
      const to = this.bin(u, b.bin_id, "post"),
        p = this.e.product(b.product_id),
        r = this.e.get(
          "SELECT * FROM bin_replenishment WHERE bin_id=? AND product_id=?",
          to.id,
          p.id,
        );
      if (!r) fail("請先設定補揀規則");
      const current = this.e.get(
        "SELECT COALESCE(sum(qty),0) n FROM bin_balances WHERE bin_id=? AND product_id=?",
        to.id,
        p.id,
      ).n;
      let left = Math.max(0, r.target_qty - current);
      if (!left) fail("已達補揀目標", 409);
      const sources = this.e.all(
        "SELECT bb.* FROM bin_balances bb JOIN storage_bins b ON b.id=bb.bin_id WHERE b.warehouse_id=? AND b.kind IN ('storage','receiving') AND b.active=1 AND bb.product_id=? AND bb.qty>0 AND (bb.expiry='' OR bb.expiry>=?) ORDER BY CASE WHEN bb.expiry='' THEN '9999' ELSE bb.expiry END,bb.id",
        to.warehouse_id,
        p.id,
        today(),
      );
      for (const s of sources) {
        const take = Math.min(left, s.qty - reserved(this.e, s.id));
        if (take <= 0) continue;
        this.transfer(u, {
          from_bin_id: s.bin_id,
          to_bin_id: to.id,
          product_id: p.id,
          lot_code: s.lot_code,
          qty: String(take / 1000),
          reason: txt(b.reason || "補揀作業", 500, true),
        });
        left -= take;
        if (!left) break;
      }
      if (left) fail("存放區可補量不足，未執行部分補揀", 409);
      return { ok: true };
    });
  }
  wave(u, id, action = "read") {
    permission(this.e, u, resource, action, id);
    const w = this.e.get(
      "SELECT * FROM warehouse_waves WHERE id=?",
      integer(id, 1),
    );
    if (!w) fail("波次不存在", 404);
    w.lines = this.e.all(
      "SELECT l.*,d.no document_no,p.sku,p.name FROM warehouse_wave_lines l JOIN documents d ON d.id=l.document_id JOIN products p ON p.id=l.product_id WHERE l.wave_id=?",
      w.id,
    );
    for (const l of w.lines) {
      sourcePermission(this.e, u, l.document_id);
      l.allocations = this.e.all(
        "SELECT r.*,bb.bin_id,bb.lot_code,bb.expiry,b.code bin_code FROM bin_reservations r JOIN bin_balances bb ON bb.id=r.balance_id JOIN storage_bins b ON b.id=bb.bin_id WHERE r.wave_line_id=? AND r.qty>0",
        l.id,
      );
      l.shortage = l.base_qty - l.allocations.reduce((n, r) => n + r.qty, 0);
    }
    return w;
  }
  createWave(u, b) {
    permission(this.e, u, resource, "create");
    return this.e.tx(() => {
      const w = this.e.warehouse(b.warehouse_id);
      if (!enabled(this.e, w.id)) fail("倉庫尚未啟用儲位");
      if (
        !Array.isArray(b.document_ids) ||
        !b.document_ids.length ||
        b.document_ids.length > 100
      )
        fail("請選擇 1–100 張訂單");
      const ids = new Set(),
        sources = [];
      for (const id of b.document_ids) {
        sourcePermission(this.e, u, id);
        const d = this.e.doc(u, id);
        if (ids.has(d.id)) fail("訂單重複");
        ids.add(d.id);
        assertNoWarehouseWave(this.e, d.id);
        if (
          d.kind !== "order" ||
          d.calc_version < 2 ||
          d.warehouse_id !== w.id ||
          !["approved", "partial"].includes(d.status)
        )
          fail("僅可選同倉新版已核准未交訂單");
        if (
          this.e.get(
            "SELECT pk.id FROM pick_lists pk JOIN pick_lines pl ON pl.pick_id=pk.id JOIN document_lines dl ON dl.id=pl.document_line_id WHERE dl.document_id=? AND pk.status='draft'",
            d.id,
          )
        )
          fail("來源有進行中的一般揀貨單", 409);
        sources.push(d);
      }
      const no = this.e.number("WAVE"),
        id = Number(
          this.e.run(
            "INSERT INTO warehouse_waves(no,warehouse_id,notes,created_by,created_at) VALUES(?,?,?,?,?)",
            no,
            w.id,
            txt(b.notes, 1000),
            u.id,
            now(),
          ).lastInsertRowid,
        );
      for (const d of sources)
        for (const l of d.lines) {
          const qty = l.qty - l.done_qty - l.closed_qty;
          if (!qty) continue;
          const base = Number((BigInt(qty) * BigInt(l.unit_ratio)) / 1000n);
          if ((BigInt(qty) * BigInt(l.unit_ratio)) % 1000n)
            fail("基本數量小於精度");
          this.e.run(
            "INSERT INTO warehouse_wave_lines(wave_id,document_id,document_version,document_line_id,product_id,qty,base_qty) VALUES(?,?,?,?,?,?,?)",
            id,
            d.id,
            d.version,
            l.id,
            l.product_id,
            qty,
            l.track_stock ? base : 0,
          );
        }
      permission(this.e, u, resource, "create", id);
      this.planWave(u, { id, version: 1 });
      event(this.e, u, resource, id, "create", { no, sources: [...ids] });
      return this.wave(u, id);
    });
  }
  planWave(u, b) {
    return this.e.tx(() => {
      const w = this.wave(u, b.id, "update");
      revision(w, b);
      if (w.status !== "draft") fail("只有待揀波次可分配", 409);
      for (const l of w.lines) {
        let left = l.shortage;
        if (!left) continue;
        const balances = this.e.all(
          "SELECT bb.* FROM bin_balances bb JOIN storage_bins b ON b.id=bb.bin_id WHERE b.warehouse_id=? AND b.active=1 AND b.kind='pick' AND bb.product_id=? AND bb.qty>0 AND (bb.expiry='' OR bb.expiry>=?) ORDER BY CASE WHEN bb.expiry='' THEN '9999' ELSE bb.expiry END,b.priority,bb.id",
          w.warehouse_id,
          l.product_id,
          today(),
        );
        for (const s of balances) {
          const take = Math.min(left, s.qty - reserved(this.e, s.id));
          if (take <= 0) continue;
          this.e.run(
            "INSERT INTO bin_reservations(wave_line_id,balance_id,qty) VALUES(?,?,?) ON CONFLICT(wave_line_id,balance_id) DO UPDATE SET qty=qty+excluded.qty",
            l.id,
            s.id,
            take,
          );
          left -= take;
          if (!left) break;
        }
      }
      this.e.run(
        "UPDATE warehouse_waves SET version=version+1 WHERE id=?",
        w.id,
      );
      event(this.e, u, resource, w.id, "plan");
      return this.wave(u, w.id);
    });
  }
  postWave(u, b) {
    return this.e.tx(() => {
      const w = this.wave(u, b.id, "post");
      revision(w, b);
      if (w.status !== "draft" || w.lines.some((l) => l.shortage))
        fail("請完成補揀及分配後再出貨", 409);
      const previous = this.e.wmsWave;
      this.e.wmsWave = w.id;
      try {
        const result = [];
        for (const did of new Set(w.lines.map((l) => l.document_id))) {
          sourcePermission(this.e, u, did, "post");
          const ls = w.lines.filter((l) => l.document_id === did),
            d = this.e.doc(u, did);
          if (d.version !== ls[0].document_version)
            fail("來源已變更，請取消後重建波次", 409);
          const bins = ls.flatMap((l) =>
              l.allocations.map((r) => ({
                product_id: l.product_id,
                warehouse_id: w.warehouse_id,
                bin_id: r.bin_id,
                lot_code: r.lot_code,
                qty: String(r.qty / 1000),
              })),
            ),
            lotMap = new Map();
          for (const r of bins)
            if (r.lot_code) {
              const k = r.product_id + ":" + r.lot_code;
              const v = lotMap.get(k) || {
                product_id: r.product_id,
                code: r.lot_code,
                qty: 0,
              };
              v.qty += scaled(r.qty, 3);
              lotMap.set(k, v);
            }
          const lots = [...lotMap.values()].map((r) => ({
            ...r,
            qty: String(r.qty / 1000),
          }));
          result.push(
            this.e.fulfil(u, did, {
              lines: ls.map((l) => ({
                line_id: l.document_line_id,
                qty: String(l.qty / 1000),
              })),
              bins,
              lots: lots.length ? lots : undefined,
              quality_inspection_id: (b.quality_inspections || []).find(
                (r) => Number(r.document_id) === did,
              )?.inspection_id,
            }),
          );
        }
        this.e.run(
          "UPDATE warehouse_waves SET status='posted',version=version+1 WHERE id=?",
          w.id,
        );
        event(this.e, u, resource, w.id, "post", {
          fulfilments: result.map((r) => r.id),
        });
        return this.wave(u, w.id);
      } finally {
        this.e.wmsWave = previous;
      }
    });
  }
  cancelWave(u, b) {
    return this.e.tx(() => {
      const w = this.wave(u, b.id, "cancel");
      revision(w, b);
      if (w.status !== "draft") fail("已出貨波次不可取消，請用退貨流程", 409);
      const reason = txt(b.reason, 500, true);
      this.e.run(
        "UPDATE warehouse_waves SET status='cancelled',version=version+1 WHERE id=?",
        w.id,
      );
      event(this.e, u, resource, w.id, "cancel", { reason });
      return this.wave(u, w.id);
    });
  }
  data(u) {
    permission(this.e, u, resource);
    return {
      bins: rows(this.e, u, "storage_bins"),
      balances: rows(this.e, u, "bin_balances").map((r) => ({
        ...r,
        reserved: reserved(this.e, r.id),
      })),
      rules: rows(this.e, u, "putaway_rules"),
      replenishment: rows(this.e, u, "bin_replenishment"),
      waves: rows(this.e, u, "warehouse_waves"),
      controls: this.e.all("SELECT * FROM warehouse_controls"),
      permissions: { configure: this.e.access.policy(u).superuser },
    };
  }
}
