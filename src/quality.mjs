import { createHash } from "node:crypto";
import { fail, integer, scaled, txt, now, permit } from "./core.mjs";
import { baseQuantity } from "./trade.mjs";
import {
  controlPermission,
  sourcePermission,
  canControl,
} from "./control-access.mjs";
const fingerprint = (v) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function qualitySelection(e, u, id, b = {}) {
  const d = e.doc(u, id);
  sourcePermission(e, u, id);
  if (
    !["purchase", "order"].includes(d.kind) ||
    !["approved", "partial"].includes(d.status)
  )
    fail("品檢來源須為已核准且未交完的訂單或採購", 409);
  const requested = new Map();
  if (b.lines !== undefined) {
    if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 200)
      fail("請選擇本次 1–200 筆進出貨明細");
    for (const l of b.lines) {
      const key = integer(l.line_id, 1);
      if (requested.has(key) || !d.lines.some((x) => x.id === key))
        fail("品檢明細重複或不屬於來源單據");
      requested.set(key, scaled(l.qty, 3));
    }
  }
  const rows = d.lines
    .map((l) => ({
      ...l,
      selected_qty:
        b.lines === undefined
          ? l.qty - l.done_qty - l.closed_qty
          : requested.get(l.id) || 0,
    }))
    .filter((l) => l.selected_qty);
  if (!rows.length) fail("請輸入本次進出貨數量");
  for (const l of rows) {
    if (l.selected_qty > l.qty - l.done_qty - l.closed_qty)
      fail("品檢數量超過目前未交量", 409);
    l.selected_base_qty = baseQuantity(l.selected_qty, l.unit_ratio);
  }
  rows.sort((a, b) => a.id - b.id);
  return {
    doc: d,
    rows,
    direction: d.kind === "purchase" ? "receipt" : "shipment",
    hash: fingerprint({
      id: d.id,
      version: d.version,
      lines: rows.map((l) => [l.id, l.selected_qty]),
    }),
  };
}
export function qualityGate(e, u, id, b) {
  // With no configured specifications this is a no-op for existing workflows.
  if (
    !b.quality_inspection_id &&
    !e.access.one("SELECT id FROM quality_specs WHERE active=1 LIMIT 1")
  )
    return null;
  const selected = qualitySelection(e, u, id, b),
    required = selected.rows.filter((l) =>
      e.access.one(
        "SELECT id FROM quality_specs WHERE active=1 AND product_id=? AND direction=?",
        l.product_id,
        selected.direction,
      ),
    );
  if (!required.length && !b.quality_inspection_id) return null;
  const inspection = b.quality_inspection_id
    ? e.access.one(
        "SELECT * FROM quality_inspections WHERE id=?",
        integer(b.quality_inspection_id, 1),
      )
    : null;
  if (
    !inspection ||
    inspection.status !== "released" ||
    inspection.document_id !== selected.doc.id ||
    inspection.selection_hash !== selected.hash ||
    e.access.one(
      "SELECT inspection_id FROM quality_releases WHERE inspection_id=?",
      inspection.id,
    )
  )
    fail("本批進出貨尚未品檢放行，或來源／數量已變更，請重新核對品檢單", 409);
  if (
    e.access.one(
      "SELECT max(id) id FROM quality_inspections WHERE document_id=? AND selection_hash=?",
      inspection.document_id,
      inspection.selection_hash,
    ).id !== inspection.id
  )
    fail("本批已有更新的品檢紀錄，不能沿用舊放行單", 409);
  for (const line of required)
    if (
      !e.access.one(
        "SELECT id FROM quality_inspection_lines WHERE inspection_id=? AND document_line_id=? AND spec_id IS NOT NULL",
        inspection.id,
        line.id,
      )
    )
      fail("有新增須檢驗項目，請重新建立品檢單", 409);
  // Execution authority is still checked by the stock posting path; inspectors need not also be warehouse clerks.
  return inspection.id;
}
export function consumeInspection(e, u, id, fulfilment) {
  if (!id) return;
  e.run(
    "INSERT INTO quality_releases VALUES(?,?,?,?)",
    id,
    fulfilment,
    u.id,
    now(),
  );
  e.run(
    "UPDATE quality_inspections SET status='consumed',version=version+1 WHERE id=?",
    id,
  );
  e.run(
    "INSERT INTO quality_events(inspection_id,action,detail,created_by,created_at) VALUES(?,?,?,?,?)",
    id,
    "consume",
    JSON.stringify({ fulfilment_id: fulfilment }),
    u.id,
    now(),
  );
}
function definition(b) {
  if (
    b.forbid_self_release !== undefined &&
    typeof b.forbid_self_release !== "boolean"
  )
    fail("自行放行選項須為布林值");
  if (
    !Array.isArray(b.parameters) ||
    !b.parameters.length ||
    b.parameters.length > 30
  )
    fail("請設定 1–30 個檢驗參數");
  const seen = new Set();
  const parameters = b.parameters.map((p) => {
    const key = txt(p.key, 40, true);
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key) || seen.has(key))
      fail("檢驗參數代碼重複或格式錯誤");
    seen.add(key);
    if (!["number", "text"].includes(p.type)) fail("檢驗參數類型錯誤");
    const result = {
      key,
      label: txt(p.label, 80, true),
      type: p.type,
      unit: txt(p.unit, 30),
    };
    if (p.type === "number") {
      result.lower = scaled(p.lower, 4, -1e12);
      result.upper = scaled(p.upper, 4, -1e12);
      if (result.lower > result.upper) fail("檢驗下限不可大於上限");
    } else result.expected_text = txt(p.expected_text, 100, true);
    return result;
  });
  return {
    parameters,
    sampling_bp: integer(b.sampling_bp ?? 10000, 1, 10000),
    min_sample_qty: scaled(b.min_sample_qty ?? "1", 3, 1),
    forbid_self_release: b.forbid_self_release !== false,
  };
}
function evaluated(line, input, complete) {
  const def = JSON.parse(line.definition),
    readings = {};
  if (!def.parameters) return { sampled_qty: 0, readings, passed: true };
  const sampled = scaled(input.sampled_qty ?? "0", 3);
  if (sampled > line.base_qty) fail("抽樣量不可超過待驗基本量");
  if (complete && sampled < line.required_sample_qty)
    fail("尚未達到規格要求的抽樣量");
  if (
    !input.readings ||
    typeof input.readings !== "object" ||
    Array.isArray(input.readings)
  )
    fail("檢驗讀值格式錯誤");
  for (const key of Object.keys(input.readings))
    if (!def.parameters.some((p) => p.key === key))
      fail("包含未定義的檢驗參數");
  let passed = true;
  for (const p of def.parameters) {
    const raw = input.readings[p.key];
    if (raw === undefined || raw === "") {
      if (complete) fail("請填妥所有檢驗參數");
      continue;
    }
    if (p.type === "number") {
      const n = scaled(raw, 4, -1e12);
      readings[p.key] = String(raw);
      passed = passed && n >= p.lower && n <= p.upper;
    } else {
      const value = txt(raw, 100, true);
      readings[p.key] = value;
      passed = passed && value === p.expected_text;
    }
  }
  return { sampled_qty: sampled, readings, passed };
}
export class Quality {
  constructor(e) {
    this.e = e;
  }
  spec(u, b) {
    const e = this.e;
    e.access.requireAdmin(u);
    return e.tx(() => {
      const old = b.id
        ? e.access.one(
            "SELECT * FROM quality_specs WHERE id=?",
            integer(b.id, 1),
          )
        : null;
      if (b.id && (!old || old.version !== integer(b.version, 1)))
        fail("品檢規格已更新或不存在", 409);
      const product = e.product(b.product_id),
        direction = b.direction;
      if (!["receipt", "shipment"].includes(direction)) fail("品檢方向錯誤");
      const def = definition(b),
        name = txt(b.name, 100, true),
        active =
          b.active === false || b.active === "0" || b.active === 0 ? 0 : 1;
      if (
        old &&
        (!active ||
          old.product_id !== product.id ||
          old.direction !== direction) &&
        e.access.one(
          "SELECT l.id FROM quality_inspection_lines l JOIN quality_inspections q ON q.id=l.inspection_id WHERE l.spec_id=? AND q.status IN ('draft','passed','failed','released') LIMIT 1",
          old.id,
        )
      )
        fail(
          "此規格尚有未結品檢，請先完成或記錄原因取消，再停用或更換商品／方向",
          409,
        );
      const args = [product.id, direction, name, JSON.stringify(def), active];
      let id = old?.id;
      if (id)
        e.run(
          "UPDATE quality_specs SET product_id=?,direction=?,name=?,definition=?,active=?,version=version+1 WHERE id=?",
          ...args,
          id,
        );
      else
        id = Number(
          e.run(
            "INSERT INTO quality_specs(product_id,direction,name,definition,active,created_by) VALUES(?,?,?,?,?,?)",
            ...args,
            u.id,
          ).lastInsertRowid,
        );
      e.log(u, "quality_spec", "quality_spec", id, {
        previous: old,
        current: { ...b, definition: def },
      });
      return { id };
    });
  }
  detail(u, id, action = "read") {
    const e = this.e;
    controlPermission(e, u, "quality_inspections", action, id);
    const r = e.access.one(
      "SELECT * FROM quality_inspections WHERE id=?",
      integer(id, 1),
    );
    if (!r) fail("品檢單不存在", 404);
    const d = sourcePermission(e, u, r.document_id);
    let canPost = false;
    try {
      permit(u, "stock");
      if (e.access.policy(u).configured)
        sourcePermission(e, u, r.document_id, "post");
      canPost = true;
    } catch (error) {
      if (error.status !== 403) throw error;
    }
    const lines = e.access
      .raw(
        "SELECT q.*,d.sku,d.name,d.unit,p.unit base_unit FROM quality_inspection_lines q JOIN document_lines d ON d.id=q.document_line_id JOIN products p ON p.id=q.product_id WHERE inspection_id=? ORDER BY q.id",
        r.id,
      )
      .map((l) => ({
        ...l,
        definition: JSON.parse(l.definition),
        readings: JSON.parse(l.readings),
      }));
    return {
      ...r,
      source_no: d.no,
      source_version: d.version,
      postable:
        r.status === "released" &&
        d.version === r.document_version &&
        ["approved", "partial"].includes(d.status) &&
        e.access.one(
          "SELECT max(id) id FROM quality_inspections WHERE document_id=? AND selection_hash=?",
          r.document_id,
          r.selection_hash,
        ).id === r.id,
      lines,
      events: e.access.raw(
        "SELECT v.*,u.name actor_name FROM quality_events v JOIN users u ON u.id=v.created_by WHERE inspection_id=? ORDER BY v.id",
        r.id,
      ),
      allowed: {
        post: canPost,
        ...Object.fromEntries(
          ["update", "submit", "approve", "cancel"].map((a) => [
            a,
            canControl(e, u, "quality_inspections", a, r.id),
          ]),
        ),
      },
    };
  }
  create(u, b) {
    const e = this.e;
    controlPermission(e, u, "quality_inspections", "create");
    return e.tx(() => {
      const p = qualitySelection(e, u, b.document_id, b);
      if (integer(b.document_version, 1) !== p.doc.version)
        fail("來源單據已更新", 409);
      const no = e.number("QI"),
        id = Number(
          e.run(
            "INSERT INTO quality_inspections(no,document_id,document_version,selection_hash,direction,notes,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
            no,
            p.doc.id,
            p.doc.version,
            p.hash,
            p.direction,
            txt(b.notes, 1000),
            u.id,
            now(),
          ).lastInsertRowid,
        );
      let required = 0;
      for (const l of p.rows) {
        const spec = e.access.one(
            "SELECT * FROM quality_specs WHERE active=1 AND product_id=? AND direction=?",
            l.product_id,
            p.direction,
          ),
          def = spec ? JSON.parse(spec.definition) : {};
        if (spec) required++;
        const sample = spec
          ? Math.min(
              l.selected_base_qty,
              Math.max(
                def.min_sample_qty,
                Number(
                  (BigInt(l.selected_base_qty) * BigInt(def.sampling_bp) +
                    9999n) /
                    10000n,
                ),
              ),
            )
          : 0;
        e.run(
          "INSERT INTO quality_inspection_lines(inspection_id,document_line_id,product_id,qty,base_qty,spec_id,spec_version,definition,required_sample_qty) VALUES(?,?,?,?,?,?,?,?,?)",
          id,
          l.id,
          l.product_id,
          l.selected_qty,
          l.selected_base_qty,
          spec?.id ?? null,
          spec?.version ?? null,
          JSON.stringify(def),
          sample,
        );
      }
      if (!required) fail("選取的商品尚未設定須檢驗規格");
      controlPermission(e, u, "quality_inspections", "create", id);
      this.event(u, id, "create", { document_version: p.doc.version });
      return this.detail(u, id);
    });
  }
  event(u, id, action, detail) {
    this.e.run(
      "INSERT INTO quality_events(inspection_id,action,detail,created_by,created_at) VALUES(?,?,?,?,?)",
      id,
      action,
      JSON.stringify(detail),
      u.id,
      now(),
    );
    this.e.log(u, "quality_" + action, "quality_inspection", id, detail);
  }
  save(u, id, b) {
    const e = this.e;
    return e.tx(() => {
      const r = this.detail(u, id, "update");
      if (r.status !== "draft" || r.version !== integer(b.version, 1))
        fail("品檢單已變更或不是草稿", 409);
      if (
        !Array.isArray(b.lines) ||
        b.lines.length !== r.lines.filter((l) => l.spec_id).length
      )
        fail("請提供全部須檢驗的明細");
      const seen = new Set();
      for (const input of b.lines) {
        const line = r.lines.find((l) => l.id === integer(input.id, 1));
        if (!line || !line.spec_id || seen.has(line.id))
          fail("品檢明細錯誤或重複");
        seen.add(line.id);
        const v = evaluated(
          { ...line, definition: JSON.stringify(line.definition) },
          input,
          false,
        );
        e.run(
          "UPDATE quality_inspection_lines SET sampled_qty=?,readings=? WHERE id=?",
          v.sampled_qty,
          JSON.stringify(v.readings),
          line.id,
        );
      }
      e.run(
        "UPDATE quality_inspections SET notes=?,version=version+1 WHERE id=?",
        txt(b.notes, 1000),
        r.id,
      );
      this.event(u, r.id, "save", { lines: b.lines });
      return this.detail(u, r.id);
    });
  }
  action(u, id, b) {
    const e = this.e;
    return e.tx(() => {
      if (!["submit", "approve", "cancel"].includes(b.action))
        fail("品檢動作錯誤");
      const r = this.detail(u, id, b.action);
      if (r.version !== integer(b.version, 1)) fail("品檢單已更新", 409);
      let status;
      if (b.action === "submit") {
        if (r.status !== "draft") fail("只有草稿可判定", 409);
        let passed = true;
        for (const l of r.lines.filter((l) => l.spec_id)) {
          const result = evaluated(
            { ...l, definition: JSON.stringify(l.definition) },
            { sampled_qty: String(l.sampled_qty / 1000), readings: l.readings },
            true,
          );
          passed = passed && result.passed;
        }
        status = passed ? "passed" : "failed";
      } else if (b.action === "approve") {
        if (r.status !== "passed") fail("只有檢驗合格的品檢單可以放行", 409);
        if (
          r.lines.some((l) => l.definition.forbid_self_release) &&
          (r.created_by === u.id ||
            r.events.some(
              (ev) => ev.action === "save" && ev.created_by === u.id,
            ))
        )
          fail("此規格禁止建單或登錄讀值者自行放行", 403);
        const p = qualitySelection(e, u, r.document_id, {
          lines: r.lines.map((l) => ({
            line_id: l.document_line_id,
            qty: String(l.qty / 1000),
          })),
        });
        if (p.hash !== r.selection_hash)
          fail("來源或未交量已變更，請重新建立品檢單", 409);
        if (
          e.access.one(
            "SELECT max(id) id FROM quality_inspections WHERE document_id=? AND selection_hash=?",
            r.document_id,
            r.selection_hash,
          ).id !== r.id
        )
          fail("本批已有更新品檢單，請使用最新紀錄", 409);
        status = "released";
      } else {
        if (["cancelled", "consumed"].includes(r.status))
          fail("已取消或已進出貨的品檢單不能取消", 409);
        txt(b.reason, 1000, true);
        status = "cancelled";
      }
      e.run(
        "UPDATE quality_inspections SET status=?,version=version+1,released_by=CASE WHEN ?='released' THEN ? ELSE released_by END WHERE id=?",
        status,
        status,
        u.id,
        r.id,
      );
      this.event(u, r.id, b.action, { status, reason: txt(b.reason, 1000) });
      return this.detail(u, r.id);
    });
  }
  data(u) {
    const e = this.e,
      p = e.access.policy(u);
    if (!canControl(e, u, "quality_inspections", "read")) return {};
    const list = e.access
      .raw(
        `SELECT id FROM quality_inspections WHERE ${e.access.predicate(p, "quality_inspections")} ORDER BY id DESC LIMIT 500`,
      )
      .flatMap((row) => {
        try {
          const r = this.detail(u, row.id);
          return [
            {
              id: r.id,
              no: r.no,
              document_id: r.document_id,
              source_no: r.source_no,
              direction: r.direction,
              status: r.status,
              version: r.version,
              postable: r.postable,
            },
          ];
        } catch (error) {
          if (error.status === 403) return [];
          throw error;
        }
      });
    return {
      quality_inspections: list,
      quality_specs: e.access
        .raw(
          `SELECT * FROM quality_specs WHERE ${e.access.predicate(p, "quality_specs")}`,
        )
        .map((r) => ({ ...r, definition: JSON.parse(r.definition) })),
      quality_permissions: {
        create: canControl(e, u, "quality_inspections", "create"),
        configure: p.superuser,
      },
    };
  }
}
