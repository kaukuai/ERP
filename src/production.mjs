import { createHash } from "node:crypto";
import {
  fail,
  permit,
  integer,
  scaled,
  ratio,
  txt,
  dateValue,
  today,
  now,
  addDays,
  has,
} from "./core.mjs";
import { Trade } from "./trade.mjs";
import { sourcePermission } from "./control-access.mjs";
import {
  enterprisePermission as permission,
  enterpriseRows as rows,
  revision,
  event,
} from "./enterprise-common.mjs";
const resource = "production_jobs";
export class Production {
  constructor(e) {
    this.e = e;
  }
  bom(u, b) {
    permission(this.e, u, "production_routes", "update");
    return this.e.tx(() => {
      const product = this.e.product(b.product_id);
      if (!product.track_stock) fail("BOM 成品須為庫存商品");
      this.e.access.assert(
        this.e.access.policy(u),
        "products",
        "update",
        "products",
        product.id,
      );
      if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 100)
        fail("BOM 需有 1–100 個材料");
      const seen = new Set(),
        ls = b.lines.map((l) => {
          const p = this.e.product(l.product_id);
          if (!p.track_stock || p.id === product.id || seen.has(p.id))
            fail("材料須為不同的庫存商品");
          seen.add(p.id);
          return { product_id: p.id, qty: scaled(l.qty, 3, 1) };
        });
      const visit = (pid, path) => {
        if (path.includes(pid) || path.length >= 32)
          fail("BOM 有循環或超過 32 層");
        const children =
          pid === product.id
            ? ls
            : this.e.all(
                "SELECT l.* FROM bom_lines l JOIN boms b ON b.id=l.bom_id WHERE b.product_id=?",
                pid,
              );
        for (const l of children) visit(l.product_id, [...path, pid]);
      };
      visit(product.id, []);
      const old = this.e.get(
        "SELECT * FROM boms WHERE product_id=?",
        product.id,
      );
      if (old && old.version !== integer(b.version, 1))
        fail("BOM 已更新，請重新載入", 409);
      let id = old?.id;
      if (id) {
        this.e.run(
          "UPDATE boms SET name=?,version=version+1 WHERE id=?",
          txt(b.name, 100, true),
          id,
        );
        this.e.run("DELETE FROM bom_lines WHERE bom_id=?", id);
      } else
        id = Number(
          this.e.run(
            "INSERT INTO boms(product_id,name) VALUES(?,?)",
            product.id,
            txt(b.name, 100, true),
          ).lastInsertRowid,
        );
      for (const l of ls)
        this.e.run(
          "INSERT INTO bom_lines(bom_id,product_id,qty) VALUES(?,?,?)",
          id,
          l.product_id,
          l.qty,
        );
      event(this.e, u, "boms", id, "save", {
        product_id: product.id,
        lines: ls,
        version: (old?.version || 0) + 1,
      });
      return { id, version: (old?.version || 0) + 1 };
    });
  }
  center(u, b) {
    permission(
      this.e,
      u,
      "production_routes",
      b.id ? "update" : "create",
      b.id,
      "work_centers",
    );
    return this.e.tx(() => {
      const old = b.id
        ? this.e.get("SELECT * FROM work_centers WHERE id=?", integer(b.id, 1))
        : null;
      if (old) revision(old, b);
      const code = txt(b.code, 40, true),
        name = txt(b.name, 100, true),
        minutes = integer(b.daily_minutes, 1, 1440),
        cost = scaled(b.hourly_cost || "0");
      if (
        this.e.get(
          "SELECT id FROM work_centers WHERE code=? AND id<>?",
          code,
          old?.id || 0,
        )
      )
        fail("工作中心代號重複", 409);
      if (
        old &&
        this.e.get(
          "SELECT id FROM production_capacity_slots WHERE center_id=? AND active=1 AND date>=? LIMIT 1",
          old.id,
          today(),
        )
      ) {
        if (minutes !== old.daily_minutes || b.active === false)
          fail("工作中心已有排程，請先重排或取消工單", 409);
      }
      let id = old?.id;
      if (id)
        this.e.run(
          "UPDATE work_centers SET code=?,name=?,daily_minutes=?,hourly_cost=?,active=?,version=version+1 WHERE id=?",
          code,
          name,
          minutes,
          cost,
          b.active === false ? 0 : 1,
          id,
        );
      else
        id = Number(
          this.e.run(
            "INSERT INTO work_centers(code,name,daily_minutes,hourly_cost,created_by) VALUES(?,?,?,?,?)",
            code,
            name,
            minutes,
            cost,
            u.id,
          ).lastInsertRowid,
        );
      event(this.e, u, "work_centers", id, "save");
      permission(
        this.e,
        u,
        "production_routes",
        old ? "update" : "create",
        id,
        "work_centers",
      );
      return { id };
    });
  }
  calendar(u, b) {
    permission(this.e, u, "production_routes", "update");
    return this.e.tx(() => {
      const c = this.e.get(
        "SELECT * FROM work_centers WHERE id=?",
        integer(b.center_id, 1),
      );
      if (!c) fail("工作中心不存在");
      const date = dateValue(b.date),
        minutes = integer(b.minutes, 0, 1440),
        old = this.e.get(
          "SELECT * FROM work_center_calendar WHERE center_id=? AND date=?",
          c.id,
          date,
        );
      if ((old?.version || 0) !== integer(b.version ?? 0))
        fail("產能日曆已變更", 409);
      if (
        this.e.get(
          "SELECT max(end_minute) n FROM production_capacity_slots WHERE center_id=? AND date=? AND active=1",
          c.id,
          date,
        )?.n > minutes
      )
        fail("設定容量少於已排程作業", 409);
      this.e.run(
        "INSERT INTO work_center_calendar(center_id,date,minutes,created_by) VALUES(?,?,?,?) ON CONFLICT(center_id,date) DO UPDATE SET minutes=excluded.minutes,version=version+1",
        c.id,
        date,
        minutes,
        u.id,
      );
      event(this.e, u, "work_center_calendar", 0, "save", {
        center_id: c.id,
        date,
        minutes,
      });
      return { ok: true };
    });
  }
  route(u, b) {
    permission(
      this.e,
      u,
      "production_routes",
      b.id ? "update" : "create",
      b.id,
    );
    return this.e.tx(() => {
      const p = this.e.product(b.product_id),
        old = b.id
          ? this.e.get(
              "SELECT * FROM production_routes WHERE id=?",
              integer(b.id, 1),
            )
          : null;
      if (old) revision(old, b);
      if (!p.track_stock) fail("製成品須為庫存商品");
      if (
        !Array.isArray(b.operations) ||
        !b.operations.length ||
        b.operations.length > 30
      )
        fail("工藝路線需有 1–30 個工序");
      const ops = b.operations.map((o, i) => {
        const r = {
          sequence: i + 1,
          name: txt(o.name, 100, true),
          setup_minutes: integer(o.setup_minutes ?? 0, 0, 100000),
          minutes_per_unit: scaled(o.minutes_per_unit || "0", 3),
          lead_days: integer(o.lead_days ?? 0, 0, 365),
        };
        if (o.supplier_id) {
          r.supplier_id = this.e.partner(u, o.supplier_id, "supplier").id;
          const service = this.e.product(o.service_product_id);
          if (service.track_stock) fail("委外加工費請選非庫存服務品");
          r.service_product_id = service.id;
          r.unit_fee = scaled(o.unit_fee);
          r.center_id = null;
        } else {
          const c = this.e.get(
            "SELECT * FROM work_centers WHERE id=? AND active=1",
            integer(o.center_id, 1),
          );
          if (!c) fail("工作中心不存在或停用");
          r.center_id = c.id;
          r.hourly_cost = c.hourly_cost;
          if (!r.setup_minutes && !r.minutes_per_unit)
            fail("內製工序需設定工時");
        }
        return r;
      });
      if (
        this.e.get(
          "SELECT id FROM production_routes WHERE product_id=? AND active=1 AND id<>?",
          p.id,
          old?.id || 0,
        )
      )
        fail("商品已有啟用路線，請編輯原路線或先停用", 409);
      let id = old?.id;
      if (id)
        this.e.run(
          "UPDATE production_routes SET product_id=?,name=?,definition=?,active=?,version=version+1 WHERE id=?",
          p.id,
          txt(b.name, 100, true),
          JSON.stringify(ops),
          b.active === false ? 0 : 1,
          id,
        );
      else
        id = Number(
          this.e.run(
            "INSERT INTO production_routes(product_id,name,definition,created_by) VALUES(?,?,?,?)",
            p.id,
            txt(b.name, 100, true),
            JSON.stringify(ops),
            u.id,
          ).lastInsertRowid,
        );
      permission(this.e, u, "production_routes", old ? "update" : "create", id);
      event(this.e, u, "production_routes", id, "save", { operations: ops });
      return { id };
    });
  }
  capacity(c, date) {
    const override = this.e.get(
      "SELECT minutes FROM work_center_calendar WHERE center_id=? AND date=?",
      c.id,
      date,
    );
    return override
      ? override.minutes
      : [0, 6].includes(new Date(date + "T00:00Z").getUTCDay())
        ? 0
        : c.daily_minutes;
  }
  schedule(opId, center, minutes, start, dateMinute = 0) {
    let left = minutes,
      date = start,
      first = null,
      last = null,
      offset = dateMinute;
    for (
      let day = 0;
      day < 730 && left;
      day++, date = addDays(date, 1), offset = 0
    ) {
      const cap = this.capacity(center, date);
      if (!cap) continue;
      const occupied = this.e.all(
        "SELECT start_minute,end_minute FROM production_capacity_slots WHERE center_id=? AND date=? AND active=1 ORDER BY start_minute,end_minute",
        center.id,
        date,
      );
      let cursor = offset;
      for (const block of [
        ...occupied,
        { start_minute: cap, end_minute: cap },
      ]) {
        const free = Math.max(0, Math.min(cap, block.start_minute) - cursor),
          take = Math.min(left, free);
        if (take) {
          this.e.run(
            "INSERT INTO production_capacity_slots(operation_id,center_id,date,start_minute,end_minute) VALUES(?,?,?,?,?)",
            opId,
            center.id,
            date,
            cursor,
            cursor + take,
          );
          first ??= { date, minute: cursor };
          last = { date, minute: cursor + take };
          left -= take;
          cursor += take;
        }
        cursor = Math.max(cursor, block.end_minute);
        if (!left || cursor >= cap) break;
      }
    }
    if (left) fail("未來兩年可用產能不足，未建立部分排程", 409);
    return { first, last };
  }
  job(u, id, action = "read") {
    permission(this.e, u, resource, action, id);
    const j = this.e.get(
      "SELECT * FROM production_jobs WHERE id=?",
      integer(id, 1),
    );
    if (!j) fail("製造工單不存在", 404);
    this.e.product(j.product_id);
    this.e.warehouse(j.warehouse_id);
    j.materials = this.e.all(
      "SELECT m.*,p.sku,p.name FROM production_materials m JOIN products p ON p.id=m.product_id WHERE job_id=?",
      j.id,
    );
    j.operations = this.e.all(
      "SELECT * FROM production_operations WHERE job_id=? ORDER BY sequence",
      j.id,
    );
    for (const op of j.operations)
      if (op.po_document_id)
        op.purchase_no =
          this.e.access.one(
            "SELECT no FROM main.documents WHERE id=? AND (" +
              this.e.access.predicate(this.e.access.policy(u), "documents") +
              ")",
            op.po_document_id,
          )?.no || "";
    j.slots = this.e.all(
      "SELECT s.* FROM production_capacity_slots s JOIN production_operations o ON o.id=s.operation_id WHERE o.job_id=? ORDER BY date,start_minute",
      j.id,
    );
    return j;
  }
  create(u, b) {
    permission(this.e, u, resource, "create");
    return this.e.tx(() => {
      const p = this.e.product(b.product_id),
        w = this.e.warehouse(b.warehouse_id),
        qty = scaled(b.qty, 3, 1),
        due = dateValue(b.due_date),
        start = dateValue(b.start_date || today());
      if (start < today() || (due < start && b.accept_late !== true))
        fail("工單開始日不可早於今天，到期日不可早於開始日");
      const bom = this.e.get("SELECT * FROM boms WHERE product_id=?", p.id),
        route = this.e.get(
          "SELECT * FROM production_routes WHERE product_id=? AND active=1",
          p.id,
        );
      if (!bom || !route) fail("請先建立 BOM 與啟用工藝路線");
      const components = this.e.all(
        "SELECT * FROM bom_lines WHERE bom_id=?",
        bom.id,
      );
      if (!components.length || components.some((c) => c.product_id === p.id))
        fail("BOM 為空或包含自身");
      const routeDef = JSON.parse(route.definition),
        id = Number(
          this.e.run(
            "INSERT INTO production_jobs(no,product_id,warehouse_id,qty,due_date,start_date,end_date,bom_snapshot,route_snapshot,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            this.e.number("MFG"),
            p.id,
            w.id,
            qty,
            due,
            start,
            start,
            JSON.stringify({ id: bom.id, version: bom.version, components }),
            JSON.stringify({
              id: route.id,
              version: route.version,
              operations: routeDef,
            }),
            u.id,
            now(),
          ).lastInsertRowid,
        );
      for (const c of components) {
        const amount = ratio(c.qty, qty, 1000);
        if (!amount) fail("材料需求小於最小精度");
        this.e.run(
          "INSERT INTO production_materials(job_id,product_id,required_qty) VALUES(?,?,?)",
          id,
          c.product_id,
          amount,
        );
      }
      let cursor = { date: start, minute: 0 };
      for (const o of routeDef) {
        const minutes =
            o.setup_minutes + ratio(o.minutes_per_unit, qty, 1000000),
          oid = Number(
            this.e.run(
              "INSERT INTO production_operations(job_id,sequence,name,center_id,supplier_id,service_product_id,planned_minutes,hourly_cost,unit_fee) VALUES(?,?,?,?,?,?,?,?,?)",
              id,
              o.sequence,
              o.name,
              o.center_id,
              o.supplier_id || null,
              o.service_product_id || null,
              minutes,
              o.hourly_cost || 0,
              o.unit_fee || 0,
            ).lastInsertRowid,
          );
        if (o.center_id) {
          const c = this.e.get(
            "SELECT * FROM work_centers WHERE id=? AND active=1",
            o.center_id,
          );
          if (!c) fail("路線的工作中心已停用");
          cursor = this.schedule(
            oid,
            c,
            Math.max(minutes, 1),
            cursor.date,
            cursor.minute,
          ).last;
        } else
          cursor = {
            date: addDays(cursor.date, o.lead_days),
            minute: cursor.minute,
          };
      }
      this.e.run(
        "UPDATE production_jobs SET end_date=? WHERE id=?",
        cursor.date,
        id,
      );
      if (cursor.date > due && b.accept_late !== true)
        fail("現有產能無法在交期前完成；確認允許逾期或調整產能後再建立", 409);
      permission(this.e, u, resource, "create", id);
      for (const material of this.e.all(
        "SELECT id FROM production_materials WHERE job_id=?",
        id,
      ))
        this.e.access.assert(
          this.e.access.policy(u),
          resource,
          "create",
          "production_materials",
          material.id,
        );
      event(this.e, u, resource, id, "create", {
        qty,
        due,
        end_date: cursor.date,
        bom_version: bom.version,
        route_version: route.version,
      });
      return this.job(u, id);
    });
  }
  release(u, b) {
    return this.e.tx(() => {
      const j = this.job(u, b.id, "approve");
      revision(j, b);
      if (j.status !== "draft") fail("只有草稿可發放", 409);
      for (const m of j.materials) {
        this.e.access.assert(
          this.e.access.policy(u),
          resource,
          "approve",
          "production_materials",
          m.id,
        );
        const s = this.e.stock(m.product_id, j.warehouse_id);
        if (s.usable_qty - s.reserved < m.required_qty)
          fail("材料 " + m.sku + " 可用庫存不足", 409);
        this.e.run(
          "UPDATE stocks SET reserved=reserved+? WHERE product_id=? AND warehouse_id=?",
          m.required_qty,
          m.product_id,
          j.warehouse_id,
        );
      }
      this.e.run(
        "UPDATE production_jobs SET status='released',version=version+1 WHERE id=?",
        j.id,
      );
      event(this.e, u, resource, j.id, "release");
      return this.job(u, j.id);
    });
  }
  issue(u, b) {
    return this.e.tx(() => {
      const j = this.job(u, b.id, "post");
      revision(j, b);
      if (j.status !== "released") fail("請先發放工單", 409);
      const m = j.materials.find((m) => m.id === integer(b.material_id, 1));
      if (!m) fail("材料不在工單");
      this.e.access.assert(
        this.e.access.policy(u),
        resource,
        "post",
        "production_materials",
        m.id,
      );
      const qty = scaled(b.qty, 3, 1);
      if (qty > m.required_qty - m.issued_qty) fail("領料超過未領需求");
      this.e.run(
        "UPDATE stocks SET reserved=reserved-? WHERE product_id=? AND warehouse_id=?",
        qty,
        m.product_id,
        j.warehouse_id,
      );
      const cost = this.e.costOut(m.product_id, j.warehouse_id, qty);
      this.e.stockMove(
        u,
        m.product_id,
        j.warehouse_id,
        -qty,
        -cost,
        "production_issue",
        j.no,
        "",
        { lots: b.lots, bins: b.bins },
      );
      this.e.journal(u, "製造領料轉在製", j.no, [
        ["1402", cost, 0],
        ["1200", 0, cost],
      ]);
      this.e.run(
        "UPDATE production_materials SET issued_qty=issued_qty+?,cost=cost+? WHERE id=?",
        qty,
        cost,
        m.id,
      );
      this.e.run(
        "UPDATE production_jobs SET cost=cost+?,version=version+1 WHERE id=?",
        cost,
        j.id,
      );
      event(this.e, u, resource, j.id, "issue", {
        material_id: m.id,
        qty,
        cost,
      });
      return this.job(u, j.id);
    });
  }
  operation(j, id) {
    const o = j.operations.find((o) => o.id === integer(id, 1));
    if (!o) fail("工序不存在");
    if (
      j.operations.some(
        (p) => p.sequence < o.sequence && p.status !== "completed",
      )
    )
      fail("前一工序尚未完成", 409);
    if (j.materials.some((m) => m.issued_qty < m.required_qty))
      fail("材料尚未領齊", 409);
    if (j.status !== "released" || o.status === "completed")
      fail("工單或工序狀態不允許", 409);
    return o;
  }
  completeOperation(u, b) {
    return this.e.tx(() => {
      const j = this.job(u, b.id, "post");
      revision(j, b);
      const o = this.operation(j, b.operation_id);
      if (o.supplier_id) fail("委外工序請由委外送回流程完成");
      const actual = integer(b.actual_minutes, 0, 10000000),
        planned = j.slots
          .filter((s) => s.operation_id === o.id && s.active)
          .reduce((n, s) => n + s.end_minute - s.start_minute, 0);
      if (actual > planned) fail("實際工時超過已配置產能，請先追加排程", 409);
      const cost = ratio(o.hourly_cost, actual, 60);
      this.e.journal(u, "製造加工費用分攤", j.no, [
        ["1402", cost, 0],
        ["5104", 0, cost],
      ]);
      this.e.run(
        "UPDATE production_operations SET status='completed',actual_minutes=?,cost=? WHERE id=?",
        actual,
        cost,
        o.id,
      );
      this.e.run(
        "UPDATE production_jobs SET cost=cost+?,version=version+1 WHERE id=?",
        cost,
        j.id,
      );
      event(this.e, u, resource, j.id, "operation_complete", {
        operation_id: o.id,
        actual,
        cost,
      });
      return this.job(u, j.id);
    });
  }
  extend(u, b) {
    return this.e.tx(() => {
      const j = this.job(u, b.id, "update");
      revision(j, b);
      if (!["draft", "released"].includes(j.status))
        fail("此狀態不能追加或重排產能", 409);
      const o = j.operations.find((x) => x.id === integer(b.operation_id, 1));
      if (!o?.center_id || o.status === "completed") fail("工序不能追加產能");
      const c = this.e.get(
        "SELECT * FROM work_centers WHERE id=? AND active=1",
        o.center_id,
      );
      const last = j.slots
        .filter((s) => s.active && s.operation_id === o.id)
        .sort(
          (a, b) => a.date.localeCompare(b.date) || a.end_minute - b.end_minute,
        )
        .at(-1);
      if (!c) fail("工作中心已停用", 409);
      const requested = dateValue(b.start_date || j.end_date),
        start = last && last.date > requested ? last.date : requested;
      if (start < today()) fail("不可排入過去日期");
      const following = j.operations.filter((x) => x.sequence > o.sequence);
      if (following.some((x) => x.status !== "pending"))
        fail("後續工序已開始，不能直接重排", 409);
      for (const n of following)
        this.e.run(
          "UPDATE production_capacity_slots SET active=0 WHERE operation_id=?",
          n.id,
        );
      const minutes = integer(b.minutes, 1, 100000),
        s = this.schedule(
          o.id,
          c,
          minutes,
          start,
          start === last?.date ? last.end_minute : 0,
        );
      let cursor = s.last;
      const route = JSON.parse(j.route_snapshot).operations;
      for (const n of following) {
        if (n.center_id) {
          const center = this.e.get(
            "SELECT * FROM work_centers WHERE id=? AND active=1",
            n.center_id,
          );
          if (!center) fail("後續工作中心已停用");
          cursor = this.schedule(
            n.id,
            center,
            Math.max(1, n.planned_minutes),
            cursor.date,
            cursor.minute,
          ).last;
        } else
          cursor = {
            date: addDays(
              cursor.date,
              route.find((x) => x.sequence === n.sequence)?.lead_days || 0,
            ),
            minute: cursor.minute,
          };
      }
      if (cursor.date > j.due_date && b.accept_late !== true)
        fail("追加產能使後續工序逾期，請確認接受逾期", 409);
      this.e.run(
        "UPDATE production_operations SET planned_minutes=planned_minutes+? WHERE id=?",
        minutes,
        o.id,
      );
      this.e.run(
        "UPDATE production_jobs SET end_date=?,version=version+1 WHERE id=?",
        cursor.date,
        j.id,
      );
      event(this.e, u, resource, j.id, "extend", {
        operation_id: o.id,
        minutes: b.minutes,
        reason: txt(b.reason, 500, true),
      });
      return this.job(u, j.id);
    });
  }
  send(u, b) {
    return this.e.tx(() => {
      const j = this.job(u, b.id, "post");
      revision(j, b);
      const o = this.operation(j, b.operation_id);
      if (!o.supplier_id || o.sent_qty) fail("此工序非委外或已送出", 409);
      permit(u, "buy");
      const po = new Trade(this.e).saveDoc(u, {
        kind: "purchase",
        partner_id: o.supplier_id,
        warehouse_id: j.warehouse_id,
        due_date: j.due_date < today() ? today() : j.due_date,
        lines: [
          {
            product_id: o.service_product_id,
            qty: String(j.qty / 1000),
            price: String(o.unit_fee / 100),
          },
        ],
        notes: "委外加工 " + j.no + " 工序 " + o.sequence,
      });
      this.e.run(
        "UPDATE production_operations SET status='outside',sent_qty=?,po_document_id=? WHERE id=?",
        j.qty,
        po.id,
        o.id,
      );
      this.e.access.assert(
        this.e.access.policy(u),
        "purchases",
        "create",
        "documents",
        po.id,
      );
      this.e.run(
        "INSERT INTO subcontract_custody(operation_id,kind,qty,reference,created_by,created_at) VALUES(?,?,?,?,?,?)",
        o.id,
        "send",
        j.qty,
        txt(b.reference, 100, true),
        u.id,
        now(),
      );
      this.e.run(
        "UPDATE production_jobs SET version=version+1 WHERE id=?",
        j.id,
      );
      event(this.e, u, resource, j.id, "subcontract_send", {
        operation_id: o.id,
        purchase_id: po.id,
      });
      return this.job(u, j.id);
    });
  }
  receive(u, b) {
    return this.e.tx(() => {
      const j = this.job(u, b.id, "post");
      revision(j, b);
      const o = this.operation(j, b.operation_id);
      if (!o.supplier_id || o.status !== "outside") fail("工序尚未委外送出");
      const qty = scaled(b.qty, 3, 1);
      if (qty > o.sent_qty - o.received_qty) fail("回貨超過委外保管量");
      sourcePermission(this.e, u, o.po_document_id, "post");
      const po = this.e.doc(u, o.po_document_id);
      if (
        po.kind !== "purchase" ||
        po.calc_version < 2 ||
        po.partner_id !== o.supplier_id ||
        po.warehouse_id !== j.warehouse_id ||
        po.lines.length !== 1 ||
        po.lines[0].product_id !== o.service_product_id ||
        po.lines[0].track_stock ||
        po.lines[0].qty !== j.qty ||
        po.lines[0].unit_ratio !== 1000 ||
        po.lines[0].price !== o.unit_fee ||
        po.lines[0].discount_bp !== 10000 ||
        po.header_discount
      )
        fail(
          "委外採購的供應商、服務品、數量或費用已被修改，請先還原並核對",
          409,
        );
      if (!["approved", "partial"].includes(po.status))
        fail("請先在採購管理核准委外加工採購", 409);
      let r;
      const previous = this.e.productionReceiving;
      this.e.productionReceiving = o.id;
      try {
        r = this.e.fulfil(u, po.id, {
          lines: [{ line_id: po.lines[0].id, qty: String(qty / 1000) }],
          quality_inspection_id: b.quality_inspection_id,
        });
      } finally {
        this.e.productionReceiving = previous;
      }
      const receipt = this.e.get(
        "SELECT net FROM fulfilments WHERE id=?",
        r.id,
      );
      this.e.journal(u, "委外加工費轉在製", j.no, [
        ["1402", receipt.net, 0],
        ["5200", 0, receipt.net],
      ]);
      this.e.run(
        "INSERT INTO subcontract_custody(operation_id,kind,qty,reference,created_by,created_at) VALUES(?,?,?,?,?,?)",
        o.id,
        "receive",
        qty,
        txt(b.reference, 100, true),
        u.id,
        now(),
      );
      this.e.run(
        "UPDATE production_operations SET received_qty=received_qty+?,cost=cost+?,status=? WHERE id=?",
        qty,
        receipt.net,
        o.received_qty + qty === o.sent_qty ? "completed" : "outside",
        o.id,
      );
      this.e.run(
        "UPDATE production_jobs SET cost=cost+?,version=version+1 WHERE id=?",
        receipt.net,
        j.id,
      );
      event(this.e, u, resource, j.id, "subcontract_receive", {
        operation_id: o.id,
        qty,
        fulfilment_id: r.id,
        cost: receipt.net,
      });
      return this.job(u, j.id);
    });
  }
  finish(u, b) {
    return this.e.tx(() => {
      const j = this.job(u, b.id, "post");
      revision(j, b);
      if (
        j.status !== "released" ||
        j.materials.some((m) => m.issued_qty !== m.required_qty) ||
        j.operations.some((o) => o.status !== "completed")
      )
        fail("請完成領料及全部工序再入庫", 409);
      this.e.stockMove(
        u,
        j.product_id,
        j.warehouse_id,
        j.qty,
        j.cost,
        "production_finished",
        j.no,
        "",
        { lots: b.lots, bins: b.bins },
      );
      this.e.journal(u, "製造成品入庫", j.no, [
        ["1200", j.cost, 0],
        ["1402", 0, j.cost],
      ]);
      this.e.run(
        "UPDATE production_jobs SET status='completed',version=version+1 WHERE id=?",
        j.id,
      );
      event(this.e, u, resource, j.id, "finish", { qty: j.qty, cost: j.cost });
      return this.job(u, j.id);
    });
  }
  recall(u, b) {
    return this.e.tx(() => {
      const j = this.job(u, b.id, "post");
      revision(j, b);
      const o = j.operations.find((o) => o.id === integer(b.operation_id, 1));
      if (!o || o.status !== "outside" || o.sent_qty <= o.received_qty)
        fail("沒有可收回的委外保管量");
      const reason = txt(b.reason, 500, true),
        ref = txt(b.reference, 100, true),
        po = this.e.doc(u, o.po_document_id);
      sourcePermission(
        this.e,
        u,
        po.id,
        po.status === "partial" ? "post" : "cancel",
      );
      if (["draft", "pending", "approved", "rejected"].includes(po.status))
        this.e.transition(u, po.id, "cancel", { reason });
      else if (po.status === "partial")
        new Trade(this.e).close(u, po.id, { version: po.version, reason });
      else if (!["closed", "cancelled"].includes(po.status))
        fail("加工採購已有不符的後續狀態，請先核對");
      const qty = o.sent_qty - o.received_qty;
      this.e.run(
        "INSERT INTO subcontract_custody(operation_id,kind,qty,reference,created_by,created_at) VALUES(?,?,?,?,?,?)",
        o.id,
        "recall",
        qty,
        ref,
        u.id,
        now(),
      );
      this.e.run(
        "UPDATE production_operations SET received_qty=sent_qty,status='recalled' WHERE id=?",
        o.id,
      );
      this.e.run(
        "UPDATE production_jobs SET version=version+1 WHERE id=?",
        j.id,
      );
      event(this.e, u, resource, j.id, "subcontract_recall", {
        operation_id: o.id,
        qty,
        reason,
        ref,
      });
      return this.job(u, j.id);
    });
  }
  cancel(u, b) {
    return this.e.tx(() => {
      const j = this.job(u, b.id, "cancel");
      revision(j, b);
      if (!["draft", "released"].includes(j.status))
        fail("已完成製造不能直接取消");
      if (j.operations.some((o) => o.sent_qty !== o.received_qty))
        fail("請先收回委外保管中的在製品");
      if (
        j.materials.some((m) => m.issued_qty) &&
        b.confirm_materials_returned !== true &&
        b.material_disposition !== "scrap"
      )
        fail("請確認實際材料已完整退回");
      let returned = 0;
      for (const m of j.materials) {
        this.e.access.assert(
          this.e.access.policy(u),
          resource,
          "cancel",
          "production_materials",
          m.id,
        );
        if (j.status === "released")
          this.e.run(
            "UPDATE stocks SET reserved=reserved-? WHERE product_id=? AND warehouse_id=?",
            m.required_qty - m.issued_qty,
            m.product_id,
            j.warehouse_id,
          );
        if (m.issued_qty && b.material_disposition !== "scrap") {
          this.e.stockMove(
            u,
            m.product_id,
            j.warehouse_id,
            m.issued_qty,
            m.cost,
            "production_material_return",
            j.no,
            "取消工單退料",
            { origin: j.no },
          );
          returned += m.cost;
        }
      }
      const sunk = j.cost - returned;
      this.e.journal(u, "取消製造退料與已發生加工費", this.e.number("MFGC"), [
        ["1200", returned, 0],
        ["5104", sunk, 0],
        ["1402", 0, j.cost],
      ]);
      this.e.run(
        "UPDATE production_capacity_slots SET active=0 WHERE operation_id IN (SELECT id FROM production_operations WHERE job_id=?)",
        j.id,
      );
      this.e.run(
        "UPDATE production_jobs SET status='cancelled',version=version+1 WHERE id=?",
        j.id,
      );
      event(this.e, u, resource, j.id, "cancel", {
        reason: txt(b.reason, 500, true),
        returned,
        sunk,
      });
      return this.job(u, j.id);
    });
  }
  fingerprint(w) {
    return createHash("sha256")
      .update(
        JSON.stringify({
          stocks: this.e.all(
            "SELECT * FROM stocks WHERE warehouse_id=? ORDER BY product_id",
            w,
          ),
          orders: this.e.all(
            "SELECT d.*,l.id line_id,l.product_id,l.qty,l.done_qty,l.closed_qty,l.unit_ratio FROM documents d JOIN document_lines l ON l.document_id=d.id WHERE d.warehouse_id=? AND d.status IN ('draft','pending','approved','partial') ORDER BY d.id,l.id",
            w,
          ),
          boms: this.e.all("SELECT * FROM boms ORDER BY id"),
          components: this.e.all("SELECT * FROM bom_lines ORDER BY id"),
          routes: this.e.all("SELECT * FROM production_routes ORDER BY id"),
          centers: this.e.all("SELECT * FROM work_centers ORDER BY id"),
          capacity: this.e.all(
            "SELECT * FROM production_capacity_slots WHERE active=1 ORDER BY id",
          ),
          calendar: this.e.all(
            "SELECT * FROM work_center_calendar ORDER BY id",
          ),
          jobs: this.e.all(
            "SELECT * FROM production_jobs WHERE warehouse_id=? AND status IN ('draft','released') ORDER BY id",
            w,
          ),
        }),
      )
      .digest("hex");
  }
  preview(u, b) {
    permission(this.e, u, "mrp_plans", "create");
    return this.e.tx(() => {
      const w = this.e.warehouse(b.warehouse_id),
        demand = [],
        seen = new Set();
      for (const id of b.document_ids || []) {
        sourcePermission(this.e, u, id);
        const d = this.e.doc(u, id);
        if (
          seen.has(d.id) ||
          d.kind !== "order" ||
          d.warehouse_id !== w.id ||
          !["pending", "approved", "partial"].includes(d.status)
        )
          fail("MRP 來源需為同倉待審／已核准未交訂單");
        seen.add(d.id);
        for (const l of d.lines.filter((l) => l.track_stock)) {
          const qty = ratio(
            l.qty - l.done_qty - l.closed_qty,
            l.unit_ratio,
            1000,
          );
          if (qty)
            demand.push({
              product_id: l.product_id,
              qty,
              due_date: d.due_date,
              source: d.no,
              reserved: d.status === "pending" ? 0 : qty,
            });
        }
      }
      if ((b.forecasts || []).length > 200) fail("獨立需求最多 200 筆");
      for (const f of b.forecasts || [])
        demand.push({
          product_id: this.e.product(f.product_id).id,
          qty: scaled(f.qty, 3, 1),
          due_date: dateValue(f.due_date),
          source: txt(f.reference || "獨立需求", 100),
          reserved: 0,
        });
      for (const r of this.e.access.raw(
        "SELECT m.*,j.no,j.start_date FROM production_materials m JOIN production_jobs j ON j.id=m.job_id WHERE j.warehouse_id=? AND j.status='draft' AND m.required_qty>m.issued_qty AND j.id IN (SELECT id FROM main.production_jobs WHERE " +
          this.e.access.predicate(this.e.access.policy(u), "production_jobs") +
          ")",
        w.id,
      ))
        demand.push({
          product_id: r.product_id,
          qty: r.required_qty - r.issued_qty,
          due_date: r.start_date < today() ? today() : r.start_date,
          source: r.no,
          reserved: 0,
        });
      if (!demand.length) fail("請選訂單或輸入獨立需求");
      demand.sort(
        (a, b) =>
          a.due_date.localeCompare(b.due_date) || a.product_id - b.product_id,
      );
      const pool = new Map(),
        extra = new Map(),
        result = [];
      for (const d of demand)
        extra.set(d.product_id, (extra.get(d.product_id) || 0) + d.reserved);
      const available = (pid, due) => {
        if (!pool.has(pid)) {
          const s = this.e.stock(pid, w.id);
          pool.set(pid, {
            quantity: s.usable_qty - s.reserved + (extra.get(pid) || 0),
            incoming: this.e
              .all(
                "SELECT l.qty-l.done_qty-l.closed_qty qty,l.unit_ratio,d.due_date date FROM documents d JOIN document_lines l ON l.document_id=d.id WHERE d.warehouse_id=? AND l.product_id=? AND d.kind='purchase' AND (d.status IN ('approved','partial') OR d.status IN ('draft','pending') AND EXISTS(SELECT 1 FROM mrp_outputs mo WHERE mo.document_id=d.id)) ORDER BY d.due_date",
                w.id,
                pid,
              )
              .map((r) => ({
                qty: ratio(r.qty, r.unit_ratio, 1000),
                date: r.date,
              }))
              .concat(
                this.e.all(
                  "SELECT qty,end_date date FROM production_jobs WHERE warehouse_id=? AND product_id=? AND status IN ('draft','released')",
                  w.id,
                  pid,
                ),
              )
              .sort((a, b) => a.date.localeCompare(b.date)),
          });
        }
        const p = pool.get(pid);
        p.entries ??= [{ date: "0000-00-00", qty: p.quantity }, ...p.incoming];
        return p.entries;
      };
      const explode = (pid, qty, due, path, source, parentKey = null) => {
        if (path.includes(pid) || path.length >= 32)
          fail("BOM 有循環或層級過深，停止展開");
        if (result.length >= 2000) fail("需求展開超過 2,000 筆");
        const p = this.e.product(pid);
        this.e.access.assert(
          this.e.access.policy(u),
          "products",
          "read",
          "products",
          p.id,
        );
        if (!p.track_stock) fail("MRP 僅處理庫存品");
        const supplies = available(pid, due);
        let net = qty;
        for (const supply of supplies) {
          if (supply.date > due) continue;
          const take = Math.min(Math.max(0, supply.qty), net);
          supply.qty -= take;
          net -= take;
          if (!net) break;
        }
        if (!net) return;
        const bom = this.e.get("SELECT * FROM boms WHERE product_id=?", pid),
          route = this.e.get(
            "SELECT * FROM production_routes WHERE product_id=? AND active=1",
            pid,
          ),
          key = String(result.length + 1);
        const lead = route
          ? JSON.parse(route.definition).reduce(
              (n, o) =>
                n +
                (o.supplier_id
                  ? o.lead_days
                  : Math.ceil(
                      (o.setup_minutes +
                        ratio(o.minutes_per_unit, net, 1000000)) /
                        (this.e.get(
                          "SELECT daily_minutes FROM work_centers WHERE id=?",
                          o.center_id,
                        )?.daily_minutes || 480),
                    )),
              0,
            )
          : 0;
        const plannedStart = bom ? addDays(due, -Math.max(lead, 1)) : due;
        if (bom && !route) fail("製造商品 " + p.sku + " 缺少工藝路線");
        result.push({
          key,
          product_id: pid,
          sku: p.sku,
          name: p.name,
          qty: net,
          due_date: due,
          kind: bom ? "manufacture" : "purchase",
          supplier_id: p.supplier_id || null,
          source,
          parent_key: parentKey,
          depth: path.length,
          planned_start: plannedStart,
        });
        if (bom) {
          const ls = this.e.all(
            "SELECT * FROM bom_lines WHERE bom_id=?",
            bom.id,
          );
          if (!ls.length) fail("BOM 為空");
          for (const l of ls)
            explode(
              l.product_id,
              ratio(l.qty, net, 1000),
              plannedStart,
              [...path, pid],
              source,
              key,
            );
        }
      };
      for (const d of demand)
        explode(d.product_id, d.qty, d.due_date, [], d.source);
      const definition = {
          warehouse_id: w.id,
          document_ids: [...seen],
          forecasts: b.forecasts || [],
        },
        no = this.e.number("MRP"),
        id = Number(
          this.e.run(
            "INSERT INTO mrp_plans(no,warehouse_id,definition,source_hash,result,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
            no,
            w.id,
            JSON.stringify(definition),
            this.fingerprint(w.id),
            JSON.stringify(result),
            u.id,
            now(),
          ).lastInsertRowid,
        );
      permission(this.e, u, "mrp_plans", "create", id);
      event(this.e, u, "mrp_plans", id, "preview", {
        demands: demand.length,
        suggestions: result.length,
      });
      return { id, no, version: 1, result };
    });
  }
  commit(u, b) {
    permission(this.e, u, "mrp_plans", "post", b.id);
    return this.e.tx(() => {
      const plan = this.e.get(
        "SELECT * FROM mrp_plans WHERE id=?",
        integer(b.id, 1),
      );
      revision(plan, b);
      if (
        plan.status !== "preview" ||
        plan.source_hash !== this.fingerprint(plan.warehouse_id)
      )
        fail("來源已變更，請重新計算 MRP", 409);
      const ls = JSON.parse(plan.result),
        outputs = [];
      const ready = new Map();
      for (const l of [...ls].sort(
        (a, b) =>
          b.depth - a.depth ||
          a.due_date.localeCompare(b.due_date) ||
          Number(a.key) - Number(b.key),
      )) {
        if (l.kind === "manufacture") {
          const job = this.create(u, {
            product_id: l.product_id,
            warehouse_id: plan.warehouse_id,
            qty: String(l.qty / 1000),
            due_date: l.due_date,
            start_date: [
              today(),
              ...ls
                .filter((c) => c.parent_key === l.key)
                .map((c) =>
                  ready.get(c.key)
                    ? c.kind === "manufacture"
                      ? addDays(ready.get(c.key), 1)
                      : ready.get(c.key)
                    : today(),
                ),
            ]
              .sort()
              .at(-1),
            accept_late: b.accept_late === true,
          });
          outputs.push({ key: l.key, job_id: job.id });
          ready.set(l.key, job.end_date);
        } else {
          permit(u, "buy");
          if (!l.supplier_id) fail("商品 " + l.sku + " 缺少主要供應商");
          const p = this.e.product(l.product_id),
            po = new Trade(this.e).saveDoc(u, {
              kind: "purchase",
              warehouse_id: plan.warehouse_id,
              partner_id: l.supplier_id,
              due_date: l.due_date < today() ? today() : l.due_date,
              lines: [
                {
                  product_id: l.product_id,
                  qty: String(l.qty / 1000),
                  price: String(p.cost / 100),
                },
              ],
              notes: "MRP " + plan.no + " " + l.source,
            });
          outputs.push({ key: l.key, document_id: po.id });
          this.e.access.assert(
            this.e.access.policy(u),
            "purchases",
            "create",
            "documents",
            po.id,
          );
          ready.set(l.key, po.due_date);
        }
      }
      for (const o of outputs)
        this.e.run(
          "INSERT INTO mrp_outputs(plan_id,line_key,document_id,job_id) VALUES(?,?,?,?)",
          plan.id,
          o.key,
          o.document_id || null,
          o.job_id || null,
        );
      this.e.run(
        "UPDATE mrp_plans SET status='committed',version=version+1 WHERE id=?",
        plan.id,
      );
      event(this.e, u, "mrp_plans", plan.id, "commit", { outputs });
      return { outputs };
    });
  }
  data(u) {
    permission(this.e, u, resource);
    const d = {
      jobs: rows(this.e, u, resource),
      boms: this.e.all("SELECT * FROM boms").map((b) => ({
        ...b,
        lines: this.e.all("SELECT * FROM bom_lines WHERE bom_id=?", b.id),
      })),
      routes: rows(this.e, u, "production_routes"),
      centers: rows(this.e, u, "work_centers"),
      calendar: rows(this.e, u, "work_center_calendar"),
      plans: rows(this.e, u, "mrp_plans"),
    };
    if (!has(u, "cost")) {
      for (const j of d.jobs) delete j.cost;
      for (const c of d.centers) delete c.hourly_cost;
      for (const r of d.routes) {
        const ops = JSON.parse(r.definition);
        for (const o of ops) {
          delete o.hourly_cost;
          delete o.unit_fee;
        }
        r.definition = JSON.stringify(ops);
      }
    }
    return d;
  }
}
