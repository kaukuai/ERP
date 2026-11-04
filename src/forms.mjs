import "../public/form-model.js";
import { assertFormat, formatAllowed } from "./governance.mjs";
import { fail, integer, txt, now, permit, has } from "./core.mjs";
import { accessContext } from "./access-control.mjs";
const M = globalThis.ERPFormModel;
export const formModel = M;
const validated = (fn) => {
  try {
    return fn();
  } catch (error) {
    fail(error.message);
  }
};
const asMoney = (v) =>
  v === undefined
    ? ""
    : (v / 100).toLocaleString("zh-TW", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
export class Forms {
  constructor(e) {
    this.e = e;
  }
  permission(u, resource, action, id) {
    permit(u, "all");
    if (id) {
      if (resource === "form_templates")
        assertFormat(this.e, u, "form", id, action);
      if (resource === "form_entries") {
        const row = this.e.access.one(
          "SELECT template_id FROM form_entries WHERE id=?",
          integer(id, 1),
        );
        if (row)
          assertFormat(this.e, u, "form", row.template_id, "entry_" + action);
      }
    }
    const p = this.e.access.policy(u);
    if (p.configured) {
      this.e.access.assert(p, resource, action, resource, id);
      return;
    }
    if (
      resource === "form_templates" &&
      !["read", "print", "export"].includes(action)
    )
      permit(u, "admin");
    if (resource === "form_entries") {
      if (u.role === "viewer" && !["read", "print"].includes(action))
        fail("此帳號僅能檢視", 403);
      if (id && !["admin", "manager"].includes(u.role)) {
        const row = this.e.get(
          "SELECT created_by FROM form_entries WHERE id=?",
          integer(id, 1),
        );
        if (!row || row.created_by !== u.id)
          fail("只能操作本人填寫的表單", 403);
      }
    }
  }
  template(u, id, action = "read") {
    this.permission(u, "form_templates", action, id);
    const row = this.e.get(
      "SELECT * FROM form_templates WHERE id=?",
      integer(id, 1),
    );
    if (!row) fail("表單範本不存在", 404);
    return { ...row, definition: JSON.parse(row.definition) };
  }
  data(u) {
    const p = this.e.access.policy(u),
      can = (resource, action) =>
        p.superuser ||
        (!p.configured
          ? resource === "form_templates"
            ? ["read", "print", "export"].includes(action) || u.role === "admin"
            : ["read", "print"].includes(action) || u.role !== "viewer"
          : this.e.access
              .rules(p, resource, action)
              .some((r) => r.effect === "allow" && r.scope !== "none") &&
            !this.e.access
              .rules(p, resource, action)
              .some((r) => r.effect === "deny" && r.scope === "all"));
    // Explicitly filtered even outside HTTP; never include template images or entry contents in bootstrap.
    const templates = can("form_templates", "read")
      ? this.e.access.raw(
          `SELECT id,name,kind,active,version,updated_at FROM form_templates WHERE ${this.e.access.predicate(p, "form_templates")} ORDER BY name`,
        )
      : [];
    const own =
      !p.configured && !["admin", "manager"].includes(u.role)
        ? " AND created_by=" + u.id
        : "";
    const entries = can("form_entries", "read")
      ? this.e.access.raw(
          `SELECT id,no,title,status,template_id,template_version,version,created_by,updated_at FROM form_entries WHERE (${this.e.access.predicate(p, "form_entries")})${own} ORDER BY id DESC LIMIT 500`,
        )
      : [];
    return {
      form_templates: templates
        .filter((t) => formatAllowed(this.e, u, "form", t.id, "read"))
        .map((t) => ({
          ...t,
          allowed: Object.fromEntries(
            ["update", "print", "export", "fill"].map((a) => [
              a,
              formatAllowed(this.e, u, "form", t.id, a),
            ]),
          ),
        })),
      form_entries: entries
        .filter((r) => {
          const row = this.e.access.one(
            "SELECT template_id FROM form_entries WHERE id=?",
            r.id,
          );
          return formatAllowed(
            this.e,
            u,
            "form",
            row.template_id,
            "entry_read",
          );
        })
        .map((r) => ({
          ...r,
          allowed: {
            print: formatAllowed(
              this.e,
              u,
              "form",
              r.template_id,
              "entry_print",
            ),
          },
        })),
      form_permissions: {
        design: can("form_templates", "create"),
        edit: can("form_templates", "update"),
        print: can("form_templates", "print"),
        export: can("form_templates", "export"),
        fill: can("form_entries", "create"),
        entry_print: can("form_entries", "print"),
      },
    };
  }
  save(u, b) {
    this.permission(u, "form_templates", b.id ? "update" : "create", b.id);
    return this.e.tx(() => {
      const old = b.id ? this.template(u, b.id) : null;
      if (old && old.version !== integer(b.version, 1))
        fail("表單版型已由其他人更新，請重新開啟", 409);
      const name = txt(b.name, 100, true),
        definition = validated(() => M.validate(b.definition)),
        active = b.active === false || b.active === 0 ? 0 : 1;
      if (old && old.kind !== definition.kind)
        fail("既有範本不能改變資料類型，請另存新範本", 409);
      const version = (old?.version || 0) + 1,
        stamp = now();
      let id = old?.id;
      if (id)
        this.e.run(
          "UPDATE form_templates SET name=?,definition=?,active=?,version=?,updated_at=? WHERE id=?",
          name,
          JSON.stringify(definition),
          active,
          version,
          stamp,
          id,
        );
      else
        id = Number(
          this.e.run(
            "INSERT INTO form_templates(name,kind,definition,active,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
            name,
            definition.kind,
            JSON.stringify(definition),
            active,
            u.id,
            stamp,
            stamp,
          ).lastInsertRowid,
        );
      this.e.run(
        "INSERT INTO form_template_versions(template_id,version,name,definition,created_by,created_at) VALUES(?,?,?,?,?,?)",
        id,
        version,
        name,
        JSON.stringify(definition),
        u.id,
        stamp,
      );
      this.e.log(u, "save_form_template", "form_template", id, {
        name,
        version,
        active,
      });
      return this.template(u, id);
    });
  }
  entry(u, id, action = "read") {
    this.permission(u, "form_entries", action, id);
    const row = this.e.get(
      "SELECT * FROM form_entries WHERE id=?",
      integer(id, 1),
    );
    if (!row) fail("填寫表單不存在", 404);
    return {
      ...row,
      definition: JSON.parse(row.definition),
      values: JSON.parse(row.values_json),
      company_snapshot: JSON.parse(row.company_snapshot),
      values_json: undefined,
      allowed: Object.fromEntries(
        ["update", "submit", "cancel", "print"].map((action) => {
          try {
            this.permission(u, "form_entries", action, id);
            return [action, true];
          } catch (error) {
            if (error.status !== 403) throw error;
            return [action, false];
          }
        }),
      ),
    };
  }
  saveEntry(u, b) {
    this.permission(u, "form_entries", b.id ? "update" : "create", b.id);
    return this.e.tx(() => {
      const old = b.id ? this.entry(u, b.id) : null;
      if (
        old &&
        (old.version !== integer(b.version, 1) || old.status !== "draft")
      )
        fail("表單已變更或已完成送出，請重新開啟", 409);
      const template = old ? null : this.template(u, integer(b.template_id, 1));
      if (template) assertFormat(this.e, u, "form", template.id, "fill");
      if (
        template &&
        (!template.active ||
          template.version !== integer(b.template_version, 1))
      )
        fail("範本已更新或停用，請重新選取", 409);
      const definition = old?.definition || template.definition;
      if (definition.kind !== "free") fail("交易表單請由來源單據選擇版型列印");
      const values = validated(() => M.validateValues(definition, b.values)),
        title = txt(b.title, 120, true),
        stamp = now(),
        version = (old?.version || 0) + 1;
      let id = old?.id;
      if (id)
        this.e.run(
          "UPDATE form_entries SET title=?,values_json=?,version=?,updated_at=? WHERE id=?",
          title,
          JSON.stringify(values),
          version,
          stamp,
          id,
        );
      else {
        const no = this.e.number("FORM");
        id = Number(
          this.e.run(
            "INSERT INTO form_entries(no,template_id,template_version,title,definition,company_snapshot,values_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            no,
            template.id,
            template.version,
            title,
            JSON.stringify(definition),
            JSON.stringify(this.company()),
            JSON.stringify(values),
            u.id,
            stamp,
            stamp,
          ).lastInsertRowid,
        );
      }
      this.event(u, id, version, "save", { title, values });
      return this.entry(u, id);
    });
  }
  event(u, id, version, action, detail) {
    this.e.run(
      "INSERT INTO form_entry_events(entry_id,version,action,detail,created_by,created_at) VALUES(?,?,?,?,?,?)",
      id,
      version,
      action,
      JSON.stringify(detail),
      u.id,
      now(),
    );
    this.e.log(u, "form_" + action, "form_entry", id, { version });
  }
  transition(u, id, b, action) {
    this.permission(u, "form_entries", action, id);
    return this.e.tx(() => {
      const row = this.entry(u, id);
      if (row.version !== integer(b.version, 1))
        fail("表單已變更，請重新開啟", 409);
      if (action === "submit") {
        if (row.status !== "draft") fail("只有草稿可以送出", 409);
        validated(() => M.validateValues(row.definition, row.values, true));
      } else if (action === "cancel") {
        if (row.status === "cancelled") fail("表單已取消", 409);
        txt(b.reason, 1000, true);
      } else fail("不支援此動作");
      const version = row.version + 1;
      this.e.run(
        "UPDATE form_entries SET status=?,version=?,updated_at=? WHERE id=?",
        action === "submit" ? "submitted" : "cancelled",
        version,
        now(),
        row.id,
      );
      this.event(u, id, version, action, { reason: b.reason || "" });
      return this.entry(u, id);
    });
  }
  company() {
    const s = this.e.settings();
    return {
      "company.name": s.company,
      "company.address": s.address,
      "company.phone": s.phone,
      "company.tax_id": s.tax_id,
    };
  }
  document(u, id, kind) {
    const p = this.e.access.policy(u),
      raw = this.e.access.one(
        "SELECT kind FROM documents WHERE id=?",
        integer(id, 1),
      );
    if (!raw) fail("來源單據不存在", 404);
    const resource = {
      quote: "quotes",
      order: "orders",
      purchase: "purchases",
    }[raw.kind];
    this.e.access.assert(p, resource, "read", "documents", id);
    this.e.access.assert(p, resource, "print", "documents", id);
    if (
      p.configured &&
      !p.superuser &&
      p.fields.some(
        (f) => this.e.access.fieldMode(p, f.resource, f.field) === "hidden",
      )
    )
      fail("隱藏欄位帳號不可輸出原始單據，請另授予唯讀欄位", 403);
    const doc = this.e.doc(u, id);
    if (doc.kind !== kind) fail("範本類型與來源單據不符");
    if (doc.kind === "purchase" && !has(u, "cost"))
      fail("沒有檢視採購金額的權限", 403);
    const partner = JSON.parse(doc.partner_snapshot),
      context = this.company();
    for (const key of Object.keys(M.bindings)) {
      const [scope, field] = key.split(".");
      if (scope === "document")
        context[key] = ["net", "tax", "total", "header_discount"].includes(
          field,
        )
          ? asMoney(doc[field])
          : doc[field] || "";
      if (scope === "partner") context[key] = partner[field] || "";
    }
    context.lines = doc.lines.map((l, i) => ({
      ...Object.fromEntries(
        Object.keys(M.lineBindings).map((k) => [k, l[k] ?? ""]),
      ),
      index: i + 1,
      qty: String(l.qty / 1000),
      price: asMoney(l.price),
      discount_bp: String(l.discount_bp / 100),
      amount: asMoney(l.amount),
      // Earlier documents only stored the line amount and header tax totals.
      // Migration defaults are not saved per-line tax allocations.
      net: doc.calc_version >= 2 ? asMoney(l.net) : "",
      tax: doc.calc_version >= 2 ? asMoney(l.tax) : "",
      total: doc.calc_version >= 2 ? asMoney(l.total) : "",
    }));
    return { doc, context };
  }
  printTemplate(u, id, q = {}) {
    const t = this.template(u, id, "print");
    let context = this.company(),
      mark = "空白表單",
      footer = `範本：${t.name} · 修訂 ${t.version}`;
    if (q.document_id) {
      const linked = this.document(u, q.document_id, t.kind);
      context = linked.context;
      const status = {
        draft: "草稿／尚未核准",
        pending: "待審核",
        rejected: "已退回",
        cancelled: "已取消",
      }[linked.doc.status];
      mark = status || "";
      footer += ` · ${linked.doc.no} · 非統一發票`;
      if (linked.doc.calc_version < 2)
        footer +=
          " · 舊版單據未保存逐列未稅、稅額與含稅分配，請依金額欄及單頭合計核對";
    } else if (t.kind !== "free")
      mark = "空白交易表單 · 尚未帶入單據，非統一發票";
    this.e.log(u, "print_form_template", "form_template", t.id, {
      version: t.version,
      document_id: q.document_id || null,
    });
    return M.render(t.definition, {}, context, { title: t.name, mark, footer });
  }
  printEntry(u, id) {
    const row = this.entry(u, id, "print");
    this.e.log(u, "print_form_entry", "form_entry", row.id, {
      version: row.version,
    });
    return M.render(row.definition, row.values, row.company_snapshot, {
      title: row.title,
      mark:
        row.status === "draft"
          ? "草稿／尚未送出"
          : row.status === "cancelled"
            ? "已取消"
            : "",
      footer: `${row.no} · 範本修訂 ${row.template_version} · 紀錄修訂 ${row.version} · 表單紀錄不會自動過帳`,
    });
  }
  preview(u, b) {
    this.permission(u, "form_templates", b.id ? "update" : "create", b.id);
    const def = validated(() => M.validate(b.definition));
    const values = validated(() => M.validateValues(def, b.values || {}));
    let context = this.company();
    if (b.document_id) {
      // POST preview must use the same read-scoped SQL and print permissions as GET output.
      context = accessContext.run(
        {
          ...accessContext.getStore(),
          policy: this.e.access.policy(u),
          reading: true,
        },
        () => this.document(u, b.document_id, def.kind).context,
      );
    }
    return {
      html: M.render(def, values, context, {
        title: txt(b.name || "版型預覽", 100, true),
        mark: "版型預覽 · 尚未儲存",
        script: false,
        toolbar: false,
      }),
    };
  }
  get(u, path) {
    if (path === "/api/forms") return this.data(u);
    if (/^\/api\/form-templates\/\d+\/export$/.test(path)) {
      const t = this.template(u, path.split("/")[3], "export");
      this.e.log(u, "export_form_template", "form_template", t.id, {
        version: t.version,
      });
      return {
        format: "erp-form-template",
        version: 1,
        name: t.name,
        definition: t.definition,
      };
    }
    if (/^\/api\/form-entries\/\d+\/history$/.test(path)) {
      this.entry(u, path.split("/")[3]);
      return {
        events: this.e
          .all(
            "SELECT version,action,created_by,created_at,detail FROM form_entry_events WHERE entry_id=? ORDER BY id",
            integer(path.split("/")[3], 1),
          )
          .map((r) => ({ ...r, detail: JSON.parse(r.detail) })),
      };
    }
    if (/^\/api\/form-templates\/\d+$/.test(path))
      return this.template(u, path.split("/")[3]);
    if (/^\/api\/form-entries\/\d+$/.test(path))
      return this.entry(u, path.split("/")[3]);
  }
  post(u, path, b) {
    if (path === "/api/form-templates") return this.save(u, b);
    if (path === "/api/form-preview") return this.preview(u, b);
    if (path === "/api/form-entries") return this.saveEntry(u, b);
    if (/^\/api\/form-entries\/\d+\/(submit|cancel)$/.test(path))
      return this.transition(u, path.split("/")[3], b, path.split("/")[4]);
  }
  print(u, path, q) {
    if (/^\/print\/form-templates\/\d+$/.test(path))
      return this.printTemplate(u, path.split("/")[3], q);
    if (/^\/print\/form-entries\/\d+$/.test(path))
      return this.printEntry(u, path.split("/")[3]);
  }
}
