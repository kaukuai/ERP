import { AsyncLocalStorage } from "node:async_hooks";
import { Finance } from "./finance.mjs";
import { fail, integer, txt, now } from "./core.mjs";
export const accessContext = new AsyncLocalStorage();
export const accessPolicy = Symbol("server access policy");
const actions = {
  read: "檢視",
  create: "新增",
  update: "修改",
  submit: "送審",
  approve: "核准／駁回",
  post: "過帳／執行",
  cancel: "取消／結案",
  reverse: "沖回／退貨",
  assign: "指派負責人",
  import: "匯入",
  export: "匯出",
  print: "列印",
};
const defs = [
  ["vendor_bills","供應商請款與三方核對","finance","vendor_bills vendor_bill_lines vendor_bill_links vendor_bill_events"],
  ["quality_specs","品質檢驗規格","admin","quality_specs"],
  ["quality_inspections","品質檢驗與放行","stock","quality_inspections quality_inspection_lines quality_events quality_releases"],
  ["form_templates", "表單版型設計", "admin", "form_templates form_template_versions"],
  ["form_entries", "表單填寫紀錄", "forms", "form_entries form_entry_events"],
  [
    "partners",
    "往來對象",
    "partners",
    "partners partner_contacts partner_addresses prices activities",
  ],
  [
    "products",
    "商品與分類",
    "masters",
    "products product_units product_images boms bom_lines product_categories custom_field_definitions product_custom_values replenishment_policies standard_costs",
  ],
  ["warehouses", "倉庫", "masters", "warehouses"],
  ["quotes", "報價", "sell", ""],
  ["orders", "銷售訂單", "sell", ""],
  ["purchases", "採購訂單", "buy", ""],
  [
    "fulfilments",
    "進出貨與退貨",
    "stock",
    "fulfilments fulfilment_lines returns return_lines fulfilment_batches fulfilment_batch_sources",
  ],
  [
    "inventory",
    "庫存與調撥",
    "stock",
    "stocks stock_moves cost_adjustments inventory_lots lot_moves loans stock_documents stock_document_lines",
  ],
  [
    "counts",
    "盤點",
    "stock",
    "inventory_counts inventory_count_lines count_rebases count_zones",
  ],
  [
    "picks",
    "揀貨",
    "stock",
    "pick_lists pick_lines pick_scans pick_fulfilments",
  ],
  ["work", "組拆裝", "stock", "work_orders disassemblies"],
  [
    "billing",
    "帳款與月結",
    "finance",
    "open_items opening_items billing_batches billing_batch_lines statements statement_lines",
  ],
  [
    "payments",
    "收付款與預收付",
    "finance",
    "payments payment_reversals funds fund_applications fund_refunds opening_payments cash_transfers opening_funds allowance_funds payment_reversal_adjustments settlements settlement_fees",
  ],
  [
    "bills",
    "票據",
    "finance",
    "bills bill_allocations bill_events checkbooks check_numbers endorsements endorsement_allocations nontrade_bills nontrade_bill_events",
  ],
  [
    "expenses",
    "費用與分攤",
    "finance",
    "expenses expense_payments expense_categories expense_allocations expense_allocation_lines allowances allowance_lines return_allowance_consumptions bad_debts bad_debt_events",
  ],
  [
    "banks",
    "銀行帳戶與對帳",
    "finance",
    "banks bank_accounts reconcile_jobs reconciled_entries reconciliation_payments",
  ],
  ["journals", "會計傳票", "finance", "journals journal_lines accounts"],
  [
    "subscriptions",
    "分期排程",
    "sell",
    "subscription_plans subscription_periods subscription_events",
  ],
  [
    "imports",
    "匯入與對應",
    "masters",
    "imports master_import_templates master_import_sources sku_mappings order_import_templates order_import_jobs order_import_sources",
  ],
  [
    "reports",
    "分析與自訂報表",
    "cost",
    "report_designs cost_policies costing_runs",
  ],
  [
    "invoices",
    "發票作業",
    "finance",
    "invoice_ranges invoice_numbers invoice_number_events invoice_print_profiles invoice_exchange_profiles invoice_exchange_jobs invoice_records invoice_fulfilments",
  ],
  [
    "services",
    "維修寄售租賃",
    "sell",
    "repair_tickets repair_parts service_contracts rental_periods consignment_sales service_events",
  ],
  [
    "pos",
    "門市與會員",
    "sell",
    "pos_stores pos_store_users loyalty_members loyalty_events pos_promotions pos_shifts pos_sales pos_tenders pos_refunds",
  ],
  ["directory", "部門與人員", "masters", "departments employees"],
  ["costs", "成本與毛利", "finance", ""],
  [
    "system",
    "系統管理",
    "admin",
    "audit company_catalog company_summary_grants numbering_rules module_closings closing_events",
  ],
];
const tableResource = new Map(
  defs.flatMap(([r, , , tables]) =>
    tables
      .split(" ")
      .filter(Boolean)
      .map((t) => [t, r]),
  ),
);
const baseAccess = {
  forms: ["admin", "manager", "sales", "warehouse", "finance"],
  masters: ["admin", "manager"],
  partners: ["admin", "manager", "sales"],
  sell: ["admin", "manager", "sales"],
  buy: ["admin", "manager"],
  approve: ["admin", "manager"],
  stock: ["admin", "manager", "warehouse"],
  finance: ["admin", "manager", "finance"],
  admin: ["admin"],
  cost: ["admin", "manager", "finance"],
  all: ["admin", "manager", "sales", "warehouse", "finance", "viewer"],
};
const privacyFields = {
  partners: [
    "contact",
    "phone",
    "email",
    "address",
    "tax_id",
    "credit_limit",
    "payment_days",
    "notes",
    "owner_id",
  ],
  products: [
    "cost",
    "supplier_id",
    "price",
    "retail_price",
    "wholesale_price",
    "online_price",
    "notes",
  ],
  quotes: ["price", "discount_bp", "notes", "shipping_address", "owner_id"],
  orders: ["price", "discount_bp", "notes", "shipping_address", "owner_id"],
  purchases: ["price", "discount_bp", "notes", "shipping_address", "owner_id"],
};
export const accessCatalog = defs.map(([key, label, legacy]) => ({
  key,
  label,
  legacy,
  actions: Object.entries(actions).map(([key, label]) => ({ key, label })),
  fields: privacyFields[key] || [],
}));
export const scopeCatalog = {
  all: "本公司全部",
  own: "本人",
  direct: "本人與直屬下階",
  descendants: "本人與下階（可限深度）",
  department: "同部門",
  selected: "指定使用者",
  none: "無資料",
};
const excluded = new Set([
  "users",
  "sessions",
  "settings",
  "sequences",
  "requests",
  "sqlite_sequence",
  "user_preferences",
]);
const sqlTokens =
  /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\[[^\]]*\]|[A-Za-z_][\w]*|\S/g;
const reserved = new Set(
  "WHERE JOIN LEFT RIGHT INNER OUTER CROSS ON GROUP ORDER LIMIT OFFSET UNION EXCEPT INTERSECT HAVING SET RETURNING USING INDEXED NOT AS".split(
    " ",
  ),
);
const hasCost = (p) =>
  p.superuser ||
  (p.configured
    ? detailedHas(p.user, "cost")
    : baseAccess.cost.includes(p.user.role));
const q = (s) => '"' + s.replaceAll('"', '""') + '"';
const list = (a) => (a.length ? a.join(",") : "NULL");
export function legacySales(u) {
  return u?.role === "sales" && !u[accessPolicy]?.configured;
}
export function detailedHas(u, a) {
  const p = u?.[accessPolicy];
  if (!p?.configured) return null;
  if (p.superuser) return true;
  if (a === "admin") return false;
  if (a === "all") return true;
  if (a === "cost")
    return (
      p.engine.fieldMode(p, "products", "cost") !== "hidden" &&
      p.engine
        .rules(p, "costs", "read")
        .some((x) => x.effect === "allow" && x.scope !== "none") &&
      !p.engine
        .rules(p, "costs", "read")
        .some((x) => x.effect === "deny" && x.scope === "all")
    );
  if (a === "approve")
    return defs.some(([r]) =>
      p.engine
        .rules(p, r, "approve")
        .some((x) => x.effect === "allow" && x.scope !== "none"),
    );
  return defs.some(
    ([r, , legacy]) =>
      legacy === a &&
      ["read", "create", "update", "post", "approve"].some(
        (action) => p.engine.rules(p, r, action).length,
      ),
  );
}
export class AccessControl {
  constructor(e) {
    this.e = e;
    this.tables = new Map(
      e.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all()
        .map(({ name }) => [
          name,
          {
            columns: e.db
              .prepare(`PRAGMA table_info(${q(name)})`)
              .all()
              .map((x) => x.name),
            fks: e.db.prepare(`PRAGMA foreign_key_list(${q(name)})`).all(),
          },
        ]),
    );
  }
  raw(sql, ...a) {
    return this.e.db.prepare(sql).all(...a);
  }
  one(sql, ...a) {
    return this.e.db.prepare(sql).get(...a);
  }
  hydrate(u) {
    if (!u) return u;
    const profile = this.one(
      "SELECT * FROM access_profiles WHERE user_id=?",
      u.id,
    );
    const p = {
      engine: this,
      user: u,
      profile,
      configured: !!profile,
      superuser: profile ? !!profile.superuser : u.role === "admin",
      revision: Number(
        this.one("SELECT value FROM settings WHERE key='access_revision'")
          .value,
      ),
      roles: [],
      cache: new Map(),
    };
    const roleSet = new Set();
    const visit = (id) => {
      if (roleSet.has(id)) return;
      const r = this.one(
        "SELECT * FROM access_roles WHERE id=? AND active=1",
        id,
      );
      if (!r) return;
      roleSet.add(id);
      for (const parent of this.raw(
        "SELECT parent_id FROM access_role_parents WHERE role_id=?",
        id,
      ))
        visit(parent.parent_id);
    };
    for (const r of this.raw(
      "SELECT role_id FROM access_user_roles WHERE user_id=?",
      u.id,
    ))
      visit(r.role_id);
    p.roles = [...roleSet];
    p.entries = this.raw(
      "SELECT * FROM access_rules WHERE (principal_type='user' AND principal_id=?) OR (principal_type='role' AND principal_id IN (" +
        list(p.roles) +
        "))",
      u.id,
    ).filter((r) => !r.expires_at || Date.parse(r.expires_at) > Date.now());
    p.fields = this.raw(
      "SELECT * FROM access_fields WHERE (principal_type='user' AND principal_id=?) OR (principal_type='role' AND principal_id IN (" +
        list(p.roles) +
        "))",
      u.id,
    );
    Object.defineProperty(u, accessPolicy, { value: p, configurable: true });
    return u;
  }
  policy(u) {
    return u?.[accessPolicy] || this.hydrate(u)?.[accessPolicy];
  }
  rules(p, r, a) {
    if (p.superuser)
      return [
        {
          effect: "allow",
          scope: "all",
          owners: "[]",
          warehouses: "[]",
          categories: "[]",
        },
      ];
    const k = r + ":" + a;
    if (p.cache.has(k)) return p.cache.get(k);
    let rules = p.entries.filter((x) => x.resource === r && x.action === a),
      personal = rules.filter((x) => x.principal_type === "user");
    if (personal.length) rules = personal;
    if (!rules.length && (!p.configured || p.profile.inherit_base)) {
      const d = defs.find((x) => x[0] === r),
        legacy = d?.[2];
      let allowed =
        a === "read"
          ? r !== "system" &&
            (r !== "costs" || baseAccess.cost.includes(p.user.role)) &&
            ((r !== "journals" &&
              r !== "banks" &&
              r !== "expenses" &&
              r !== "bills" &&
              r !== "payments" &&
              r !== "billing" &&
              r !== "invoices") ||
              baseAccess.finance.includes(p.user.role))
          : baseAccess[legacy]?.includes(p.user.role);
      if (a === "approve")
        allowed = allowed && baseAccess.approve.includes(p.user.role);
      if (a === "assign") allowed = baseAccess.masters.includes(p.user.role);
      if (allowed)
        rules = [
          {
            effect: "allow",
            scope:
              (r === "form_entries" && !["admin", "manager"].includes(p.user.role)) || p.user.role === "sales" &&
              [
                "quotes",
                "orders",
                "purchases",
                "partners",
                "subscriptions",
                "services",
              ].includes(r)
                ? "own"
                : "all",
            owners: "[]",
            warehouses: "[]",
            categories: "[]",
          },
        ];
    }
    p.cache.set(k, rules);
    return rules;
  }
  owners(p, r) {
    const id = p.user.id;
    if (r.scope === "own") return [id];
    if (r.scope === "selected") return JSON.parse(r.owners);
    if (r.scope === "department") {
      const dep = p.profile?.department_id;
      return dep
        ? this.raw(
            "SELECT user_id FROM access_profiles WHERE department_id=?",
            dep,
          ).map((x) => x.user_id)
        : [id];
    }
    if (["direct", "descendants"].includes(r.scope)) {
      let ids = [id],
        front = [id],
        depth = 0;
      while (
        front.length &&
        depth++ < (r.scope === "direct" ? 1 : r.depth || 100)
      ) {
        front = this.raw(
          "SELECT user_id FROM access_profiles WHERE manager_id IN (" +
            list(front) +
            ")",
        )
          .map((x) => x.user_id)
          .filter((x) => !ids.includes(x));
        ids.push(...front);
      }
      return ids;
    }
    return [];
  }
  resource(table, row) {
    return table === "documents"
      ? { quote: "quotes", order: "orders", purchase: "purchases" }[
          row?.kind
        ] || "orders"
      : tableResource.get(table);
  }
  relation(table, kind, values, trail = []) {
    if (!table || trail.includes(table) || !this.tables.has(table)) return null;
    const meta = this.tables.get(table),
      col = (name) => q(table) + "." + q(name),
      quoted =
        values
          .map((x) =>
            typeof x === "number"
              ? String(x)
              : "'" + x.replaceAll("'", "''") + "'",
          )
          .join(",") || "NULL";
    if(table==='vendor_bills'&&['warehouse','category'].includes(kind)) {
      const field=kind==='warehouse'?'d.warehouse_id':"COALESCE(dl.category,'')";
      const source=`FROM main.vendor_bill_lines vb JOIN main.fulfilment_lines fl ON fl.id=vb.receipt_line_id JOIN main.fulfilments f ON f.id=fl.fulfilment_id JOIN main.documents d ON d.id=f.document_id JOIN main.document_lines dl ON dl.id=fl.document_line_id WHERE vb.bill_id=${col('id')}`;
      return `EXISTS(SELECT 1 ${source}) AND NOT EXISTS(SELECT 1 ${source} AND ${field} NOT IN (${quoted}))`;
    }
    if (kind === "owner") {
      if (
        [
          "products",
          "product_units",
          "product_images",
          "product_categories",
          "custom_field_definitions",
          "warehouses",
          "banks",
          "bank_accounts",
          "accounts",
          "departments",
          "numbering_rules",
          "report_designs",
        ].includes(table)
      )
        return null;
      const owner =
        meta.columns.find((x) => x === "owner_id") ||
        (!["fulfilments", "returns", "fulfilment_batches"].includes(table) &&
          ["created_by", "user_id", "actor_id"].find((x) =>
            meta.columns.includes(x),
          ));
      if (owner) return `${col(owner)} IN (${quoted})`;
    }
    if (kind === "warehouse") {
      if (table === "warehouses") return `${col("id")} IN (${quoted})`;
      const warehouseFields = meta.fks
        .filter((f) => f.table === "warehouses")
        .map((f) => f.from);
      if (warehouseFields.length)
        return warehouseFields
          .map((f) => `(${col(f)} IS NULL OR ${col(f)} IN (${quoted}))`)
          .join(" AND ");
      if (table === "products")
        return `${col("id")} IN (SELECT product_id FROM main.stocks WHERE warehouse_id IN (${quoted}))`;
    }
    if (kind === "category") {
      if (meta.columns.includes("category"))
        return `${col("category")} IN (${quoted})`;
      if (table === "documents")
        return `EXISTS(SELECT 1 FROM main.document_lines acl_line WHERE acl_line.document_id=${col("id")}) AND NOT EXISTS(SELECT 1 FROM main.document_lines acl_line WHERE acl_line.document_id=${col("id")} AND acl_line.category NOT IN (${quoted}))`;
    }
    const priority = [
      "documents",
      "fulfilments",
      "document_lines",
      "open_items",
      "inventory_counts",
      "pick_lists",
      "funds",
      "bills",
      "expenses",
      "stock_documents",
      "pos_sales",
      "repair_tickets",
      "service_contracts",
      "subscription_plans",
      "returns",
      "allowances",
      "products",
      "partners",
    ];
    const fks = [...meta.fks]
      .filter((f) => !excluded.has(f.table) && !f.table.startsWith("access_"))
      .sort(
        (a, b) =>
          (priority.indexOf(a.table) < 0 ? 100 : priority.indexOf(a.table)) -
          (priority.indexOf(b.table) < 0 ? 100 : priority.indexOf(b.table)),
      );
    for (const fk of fks) {
      const parent = this.relation(fk.table, kind, values, [...trail, table]);
      if (parent)
        return `${col(fk.from)} IN (SELECT ${q(fk.to || "id")} FROM main.${q(fk.table)} WHERE ${parent})`;
    }
    return null;
  }
  rulePredicate(p, r, columns, table) {
    if (r.scope === "none") return "0";
    const parts = [];
    if (r.scope !== "all") {
      const owner = ["owner_id", "created_by", "user_id", "actor_id"].find(
        (x) => columns.includes(x),
      );
      parts.push(
        table
          ? this.relation(table, "owner", this.owners(p, r)) || "0"
          : owner
            ? `${q(owner)} IN (${list(this.owners(p, r))})`
            : "0",
      );
    }
    const warehouses = JSON.parse(r.warehouses);
    if (warehouses.length)
      parts.push(
        table
          ? this.relation(table, "warehouse", warehouses) || "0"
          : columns.includes("warehouse_id")
            ? `warehouse_id IN (${list(warehouses)})`
            : "0",
      );
    const categories = JSON.parse(r.categories);
    if (categories.length)
      parts.push(
        table
          ? this.relation(table, "category", categories) || "0"
          : columns.includes("category")
            ? `category IN (${categories.map((x) => "'" + x.replaceAll("'", "''") + "'").join(",")})`
            : "0",
      );
    return parts.length ? "(" + parts.join(" AND ") + ")" : "1";
  }
  predicate(p, table, action = "read", trail = []) {
    if (p.superuser || !p.configured) return "1";
    if (trail.includes(table)) return "1";
    const meta = this.tables.get(table);
    if (!meta) return "0";
    const { columns, fks } = meta;
    const rulesPredicate = (r) => {
      const rs = this.rules(p, r, action),
        allow = rs
          .filter((x) => x.effect === "allow")
          .map((x) => this.rulePredicate(p, x, columns, table)),
        deny = rs
          .filter((x) => x.effect === "deny")
          .map((x) => this.rulePredicate(p, x, columns, table));
      return (
        "(" +
        (allow.length ? allow.join(" OR ") : "0") +
        ")" +
        (deny.length ? " AND NOT (" + deny.join(" OR ") + ")" : "")
      );
    };
    let own;
    if (table === "documents")
      own = ["quote", "order", "purchase"]
        .map(
          (kind, i) =>
            `(kind='${kind}' AND ${rulesPredicate(["quotes", "orders", "purchases"][i])})`,
        )
        .join(" OR ");
    else if (excluded.has(table) || table.startsWith("access_")) return "1";
    else {
      const r = tableResource.get(table);
      own = r
        ? rulesPredicate(r)
        : [
              "document_lines",
              "document_links",
              "order_closures",
              "order_metadata",
              "kit_sales",
            ].includes(table)
          ? "1"
          : "0";
    }
    const constraints = [];
    if (table === "documents") {
      const productPredicate = this.predicate(p, "products", "read", [
        ...trail,
        table,
      ]);
      if (productPredicate !== "1")
        constraints.push(
          `NOT EXISTS(SELECT 1 FROM main.document_lines acl_line WHERE acl_line.document_id="documents".id AND acl_line.product_id NOT IN (SELECT id FROM main.products WHERE ${productPredicate}))`,
        );
    }
    for (const fk of fks) {
      if (
        excluded.has(fk.table) ||
        fk.table.startsWith("access_") ||
        !this.tables.has(fk.table)
      )
        continue;
      const parent = this.predicate(p, fk.table, "read", [...trail, table]);
      if (parent !== "1")
        constraints.push(
          `(${q(fk.from)} IS NULL OR ${q(fk.from)} IN (SELECT ${q(fk.to || "id")} FROM main.${q(fk.table)} WHERE ${parent}))`,
        );
    }
    return (
      "(" +
      own +
      ")" +
      (constraints.length ? " AND " + constraints.join(" AND ") : "")
    );
  }
  assertSource(p, descriptor, table, id) {
    if (!p?.configured || p.superuser || !descriptor || !id) return;
    const rules = this.rules(p, descriptor.resource, descriptor.action),
      columns = this.tables.get(table)?.columns || [],
      allow = rules
        .filter((x) => x.effect === "allow")
        .map((x) => this.rulePredicate(p, x, columns, table)),
      deny = rules
        .filter((x) => x.effect === "deny")
        .map((x) => this.rulePredicate(p, x, columns, table)),
      condition =
        "(" +
        (allow.join(" OR ") || "0") +
        ")" +
        (deny.length ? " AND NOT (" + deny.join(" OR ") + ")" : "");
    if (
      !this.one(
        `SELECT 1 FROM main.${q(table)} WHERE id=? AND (${condition}) AND (${this.predicate(p, table, "read")})`,
        integer(id, 1),
      )
    )
      fail("來源資料不在本次操作授權範圍，檢視權不代表操作權", 403);
  }
  sourceRows(sql, rows, context) {
    if (
      !context?.descriptor ||
      context.reading ||
      !context.policy?.configured ||
      context.policy.superuser
    )
      return rows;
    const protectedTables = new Set([
      "documents",
      "fulfilments",
      "open_items",
      "payments",
      "funds",
      "bills",
      "expenses",
      "repair_tickets",
      "service_contracts",
      "subscription_plans",
      "pos_sales",
      "inventory_counts",
      "pick_lists",
      "work_orders",
      "stock_documents",
      "order_import_jobs",
      "reconcile_jobs",
    ]);
    const tokens = [...sql.matchAll(sqlTokens)];
    const at = tokens.findIndex((t) => /^FROM$/i.test(t[0]));
    if (at < 0) return rows;
    const table = tokens[at + 1]?.[0].replace(/^["`\[]|["`\]]$/g, "");
    if (!protectedTables.has(table)) return rows;
    for (const row of Array.isArray(rows) ? rows : rows ? [rows] : [])
      if (Number.isSafeInteger(row.id)) {
        this.assertSource(context.policy, context.descriptor, table, row.id);
        for (const dependency of context.dependencies || [])
          if (dependency.table === table) {
            const source = this.one(
              `SELECT * FROM main.${q(table)} WHERE id=?`,
              row.id,
            );
            if (source && this.resource(table, source) === dependency.resource)
              this.assertSource(context.policy, dependency, table, row.id);
          }
      }
    return rows;
  }
  rewrite(sql, p) {
    if (!p?.configured || p.superuser || !/^\s*(SELECT|WITH)\b/i.test(sql))
      return sql;
    const tokens = [...sql.matchAll(sqlTokens)],
      edits = [];
    for (let i = 0; i < tokens.length - 1; i++) {
      if (!/^(FROM|JOIN)$/i.test(tokens[i][0])) continue;
      const t = tokens[i + 1],
        table = t[0].replace(/^["`\[]|["`\]]$/g, "");
      if (
        !this.tables.has(table) ||
        excluded.has(table) ||
        table.startsWith("access_")
      )
        continue;
      const pred = this.predicate(p, table);
      if (pred === "1") continue;
      const next = tokens[i + 2]?.[0],
        hasAlias =
          next &&
          (/^AS$/i.test(next) ||
            (/^[A-Za-z_]\w*$/.test(next) && !reserved.has(next.toUpperCase())));
      edits.push([
        t.index,
        t.index + t[0].length,
        `(SELECT * FROM main.${q(table)} WHERE ${pred})${hasAlias ? "" : " AS " + q(table)}`,
      ]);
    }
    for (const [a, b, v] of edits.reverse())
      sql = sql.slice(0, a) + v + sql.slice(b);
    return sql;
  }
  assert(p, r, a, table, id) {
    if (p.superuser || !p.configured) return;
    let allowed = this.rules(p, r, a).some(
      (x) => x.effect === "allow" && x.scope !== "none",
    );
    if (table && id) {
      const row = this.one(
        `SELECT * FROM ${q(table)} WHERE id=?`,
        integer(id, 1),
      );
      if (!row) fail("找不到資料", 404);
      const condition = this.predicate(p, table, a);
      allowed = !!this.one(
        `SELECT 1 FROM main.${q(table)} WHERE id=? AND (${condition})`,
        Number(id),
      );
      if (a !== "read")
        allowed =
          allowed &&
          !!this.one(
            `SELECT 1 FROM main.${q(table)} WHERE id=? AND (${this.predicate(p, table)})`,
            Number(id),
          );
    } else if (
      this.rules(p, r, a).some((x) => x.effect === "deny" && x.scope === "all")
    )
      allowed = false;
    if (!allowed)
      fail(
        `沒有${defs.find((x) => x[0] === r)?.[1] || r}的「${actions[a] || a}」權限或資料不在授權範圍`,
        403,
      );
  }
  fieldMode(p, r, f) {
    if (p.superuser) return "edit";
    if (
      ((r === "products" && ["cost", "supplier_id"].includes(f)) ||
        (r === "purchases" && f === "price")) &&
      (!this.rules(p, "costs", "read").some(
        (x) => x.effect === "allow" && x.scope !== "none",
      ) ||
        this.rules(p, "costs", "read").some(
          (x) => x.effect === "deny" && x.scope === "all",
        ))
    )
      return "hidden";
    let fs = p.fields.filter((x) => x.resource === r && x.field === f),
      personal = fs.filter((x) => x.principal_type === "user");
    if (personal.length) fs = personal;
    return fs.some((x) => x.mode === "hidden")
      ? "hidden"
      : fs.some((x) => x.mode === "readonly")
        ? "readonly"
        : "edit";
  }
  sanitize(p, value, purchase = false) {
    if (!p || p.superuser || value == null) return value;
    if (Array.isArray(value))
      return value.map((x) => this.sanitize(p, x, purchase));
    if (typeof value === "string" && /^[{[]/.test(value.trim())) {
      try {
        return JSON.stringify(this.sanitize(p, JSON.parse(value), purchase));
      } catch {}
    }
    if (typeof value !== "object" || Buffer.isBuffer(value)) return value;
    const out = {};
    const hidden = new Set(
      p.fields
        .filter((x) => this.fieldMode(p, x.resource, x.field) === "hidden")
        .map((x) => x.field),
    );
    purchase =
      purchase ||
      (!hasCost(p) &&
        (["purchase", "receipt"].includes(value.kind) ||
          value.cost_sensitive === true));
    if (purchase)
      for (const key of [
        "net",
        "tax",
        "total",
        "amount",
        "price",
        "header_discount",
        "pre_discount_amount",
        "header_discount_amount",
      ])
        hidden.add(key);
    hidden.add("cost_sensitive");
    if (!hasCost(p))
      for (const key of [
        "cost",
        "unit_cost",
        "value",
        "received_value",
        "old_value",
        "new_value",
        "old_cost",
        "new_cost",
        "allocated_cost",
        "actualCost",
        "margin",
        "profit",
        "contribution",
        "selling_expense",
      ])
        hidden.add(key);
    if (hidden.has("price"))
      for (const k of [
        "net",
        "tax",
        "total",
        "amount",
        "pre_discount_amount",
        "header_discount_amount",
        "header_discount",
      ])
        hidden.add(k);
    for (const [k, v] of Object.entries(value)) {
      if (hidden.has(k)) continue;
      out[k] = k === "access_effective" ? v : this.sanitize(p, v, purchase);
    }
    return out;
  }
  checkFields(p, r, b, table, id) {
    if (p.superuser || !p.configured) return;
    const old =
      id && table
        ? this.one(`SELECT * FROM ${q(table)} WHERE id=?`, Number(id))
        : null;
    if (
      ["quotes", "orders", "purchases"].includes(r) &&
      this.fieldMode(p, r, "discount_bp") !== "edit"
    ) {
      if (
        Object.hasOwn(b, "header_discount") &&
        Number(b.header_discount) * 100 !== (old?.header_discount || 0)
      )
        fail("整單折扣為唯讀", 403);
      if (old && !Object.hasOwn(b, "header_discount"))
        b.header_discount = String(old.header_discount / 100);
    }
    for (const f of privacyFields[r] || []) {
      if (this.fieldMode(p, r, f) === "edit") continue;
      if (old && !(f in b))
        b[f] = [
          "cost",
          "price",
          "retail_price",
          "wholesale_price",
          "online_price",
          "credit_limit",
        ].includes(f)
          ? String(old[f] / 100)
          : old[f];
      const test = (obj, prior) => {
        if (!(f in obj)) return;
        if (
          prior &&
          ([
            "cost",
            "price",
            "retail_price",
            "wholesale_price",
            "online_price",
            "credit_limit",
          ].includes(f)
            ? Number(obj[f]) * 100 === prior[f]
            : String(obj[f] ?? "") === String(prior[f] ?? ""))
        )
          return;
        fail(`欄位 ${f} 為唯讀或隱藏，無法修改`, 403);
      };
      test(b, old);
      if (["price", "discount_bp"].includes(f) && Array.isArray(b.lines)) {
        for (const line of b.lines) {
          const prior = line.id
            ? this.one(
                "SELECT * FROM document_lines WHERE id=? AND document_id=?",
                Number(line.id),
                Number(id || 0),
              )
            : id
              ? this.one(
                  "SELECT * FROM document_lines WHERE product_id=? AND document_id=?",
                  Number(line.product_id),
                  Number(id),
                )
              : null;
          if (prior && !(f in line))
            line[f] =
              f === "price" ? String(prior.price / 100) : prior.discount_bp;
          if (!prior) {
            if (f === "price") {
              const product = this.one(
                "SELECT * FROM products WHERE id=?",
                integer(line.product_id, 1),
              );
              const value =
                b.kind === "purchase"
                  ? line.unit_id
                    ? this.one(
                        "SELECT cost FROM product_units WHERE id=? AND product_id=?",
                        integer(line.unit_id, 1),
                        product.id,
                      )?.cost
                    : product.cost
                  : new Finance(this.e).price(
                      p.user,
                      b.partner_id,
                      line.product_id,
                      line.unit_id,
                    ).price;
              if (value === undefined) fail("無法取得此商品單位的授權價格");
              if (f in line && Number(line[f]) * 100 !== value)
                fail("明細單價為唯讀，不能偏離核定價格", 403);
              line[f] = String(value / 100);
              continue;
            }
            if (f === "discount_bp") {
              if (f in line && Number(line[f]) !== 10000)
                fail("明細折扣為唯讀", 403);
              line[f] = 10000;
              continue;
            }
          }
          const sent = Number(line[f]);
          const saved = f === "price" ? prior?.price / 100 : prior?.discount_bp;
          if (prior && sent === saved) continue;
          if (f in line) fail(`明細欄位 ${f} 為唯讀或隱藏，無法修改`, 403);
        }
      }
    }
  }
  revision(p) {
    if (
      Number(
        this.one("SELECT value FROM settings WHERE key='access_revision'")
          .value,
      ) !== p.revision
    )
      fail("權限已變更，請重新登入後再試", 409);
  }
  changed(u, entity, id, detail) {
    this.e.run(
      "UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='access_revision'",
    );
    this.e.run("DELETE FROM sessions");
    this.e.log(u, "access_changed", entity, id, detail);
  }
  requireAdmin(u) {
    if (!this.policy(u).superuser) fail("只有完整權限管理員可以調整授權", 403);
  }
  data(u) {
    const p = this.policy(u);
    return {
      access_effective: {
        configured: p.configured,
        superuser: p.superuser,
        revision: p.revision,
        resources: accessCatalog.map((r) => ({
          ...r,
          grants: Object.fromEntries(
            Object.keys(actions).map((a) => [a, this.rules(p, r.key, a)]),
          ),
          field_modes: Object.fromEntries(
            r.fields.map((f) => [f, this.fieldMode(p, r.key, f)]),
          ),
        })),
      },
    };
  }
  administration(u) {
    this.requireAdmin(u);
    return {
      catalog: accessCatalog,
      scopes: scopeCatalog,
      profiles: this.raw("SELECT * FROM access_profiles"),
      roles: this.raw("SELECT * FROM access_roles"),
      parents: this.raw("SELECT * FROM access_role_parents"),
      assignments: this.raw("SELECT * FROM access_user_roles"),
      rules: this.raw("SELECT * FROM access_rules"),
      fields: this.raw("SELECT * FROM access_fields"),
      users: this.raw("SELECT id,name,username,role,active FROM users"),
      departments: this.raw("SELECT id,name FROM departments"),
      warehouses: this.raw("SELECT id,name FROM warehouses"),
      categories: this.raw(
        "SELECT DISTINCT category FROM products ORDER BY category",
      ),
      revision: Number(
        this.one("SELECT value FROM settings WHERE key='access_revision'")
          .value,
      ),
    };
  }
  validateRules(rules) {
    if (!Array.isArray(rules) || rules.length > 600)
      fail("權限規則最多 600 筆");
    return rules.map((r) => {
      if (
        !defs.some((d) => d[0] === r.resource) ||
        !Object.hasOwn(actions, r.action) ||
        !["allow", "deny"].includes(r.effect) ||
        !Object.hasOwn(scopeCatalog, r.scope)
      )
        fail("權限規則格式不正確");
      if (
        r.resource === "costs" &&
        (!["all", "none"].includes(r.scope) ||
          (r.warehouses || []).length ||
          (r.categories || []).length ||
          (r.owners || []).length)
      )
        fail("成本金額可見性請選全部或無資料；人員範圍請於各單據功能設定");
      const ids = (v, table) => {
        if (!Array.isArray(v ?? []) || (v || []).length > 500)
          fail("範圍格式錯誤");
        return [
          ...new Set(
            (v || []).map((x) => {
              const id = integer(x, 1);
              if (!this.one(`SELECT id FROM ${table} WHERE id=?`, id))
                fail("範圍含不存在的資料");
              return id;
            }),
          ),
        ];
      };
      let expiry = null;
      if (r.expires_at) {
        const d = new Date(r.expires_at);
        if (!Number.isFinite(d.getTime()) || d.getTime() <= Date.now())
          fail("期限必須在未來");
        expiry = d.toISOString();
      }
      const categories = r.categories || [];
      if (!Array.isArray(categories) || categories.length > 100)
        fail("分類格式錯誤");
      return {
        ...r,
        depth: integer(r.depth || 0, 0, 100),
        owners: JSON.stringify(ids(r.owners, "users")),
        warehouses: JSON.stringify(ids(r.warehouses, "warehouses")),
        categories: JSON.stringify(categories.map((x) => txt(x, 100, true))),
        expires_at: expiry,
      };
    });
  }
  saveRules(type, id, b) {
    const rules = this.validateRules(b.rules || []),
      fields = b.fields || [];
    if (!Array.isArray(fields) || fields.length > 200) fail("欄位規則過多");
    for (const f of fields)
      if (
        !privacyFields[f.resource]?.includes(f.field) ||
        !["hidden", "readonly", "edit"].includes(f.mode)
      )
        fail("欄位權限格式錯誤");
    this.e.run(
      "DELETE FROM access_rules WHERE principal_type=? AND principal_id=?",
      type,
      id,
    );
    this.e.run(
      "DELETE FROM access_fields WHERE principal_type=? AND principal_id=?",
      type,
      id,
    );
    for (const r of rules)
      this.e.run(
        "INSERT INTO access_rules(principal_type,principal_id,resource,action,effect,scope,depth,owners,warehouses,categories,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        type,
        id,
        r.resource,
        r.action,
        r.effect,
        r.scope,
        r.depth,
        r.owners,
        r.warehouses,
        r.categories,
        r.expires_at,
      );
    for (const f of fields)
      this.e.run(
        "INSERT INTO access_fields VALUES(?,?,?,?,?)",
        type,
        id,
        f.resource,
        f.field,
        f.mode,
      );
  }
  saveProfile(u, b) {
    this.requireAdmin(u);
    return this.e.tx(() => {
      const id = integer(b.user_id, 1),
        target = this.one("SELECT * FROM users WHERE id=?", id);
      if (!target) fail("找不到使用者");
      const old = this.one("SELECT * FROM access_profiles WHERE user_id=?", id);
      if ((old?.version || 0) !== integer(b.version || 0))
        fail("權限已被修改，請重新載入", 409);
      const manager = b.manager_id ? integer(b.manager_id, 1) : null,
        dep = b.department_id ? integer(b.department_id, 1) : null;
      if (manager && !this.one("SELECT id FROM users WHERE id=?", manager))
        fail("上階不存在");
      if (dep && !this.one("SELECT id FROM departments WHERE id=?", dep))
        fail("部門不存在");
      let cursor = manager,
        seen = new Set([id]);
      while (cursor) {
        if (seen.has(cursor)) fail("上下階不可形成循環");
        seen.add(cursor);
        cursor = this.one(
          "SELECT manager_id FROM access_profiles WHERE user_id=?",
          cursor,
        )?.manager_id;
      }
      const superuser = b.superuser === true ? 1 : 0;
      if (superuser && target.role !== "admin")
        fail("完整權限管理員必須使用管理員帳號");
      if (
        !superuser &&
        !this.one(
          "SELECT u.id FROM users u LEFT JOIN access_profiles p ON p.user_id=u.id WHERE u.active=1 AND u.role='admin' AND (p.superuser=1 OR p.user_id IS NULL) AND u.id<>?",
          id,
        )
      )
        fail("至少保留一位啟用的完整權限管理員");
      const roles = [...new Set((b.role_ids || []).map((x) => integer(x, 1)))];
      if (roles.length > 50) fail("角色過多");
      for (const r of roles)
        if (!this.one("SELECT id FROM access_roles WHERE id=? AND active=1", r))
          fail("角色不存在或已停用");
      this.e.run(
        "INSERT INTO access_profiles(user_id,manager_id,department_id,inherit_base,superuser) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET manager_id=excluded.manager_id,department_id=excluded.department_id,inherit_base=excluded.inherit_base,superuser=excluded.superuser,version=version+1",
        id,
        manager,
        dep,
        b.inherit_base === false ? 0 : 1,
        superuser,
      );
      this.e.run("DELETE FROM access_user_roles WHERE user_id=?", id);
      for (const r of roles)
        this.e.run("INSERT INTO access_user_roles VALUES(?,?)", id, r);
      this.saveRules("user", id, b);
      this.changed(u, "access_profile", id, {
        manager_id: manager,
        department_id: dep,
        role_ids: roles,
        rules: b.rules || [],
        fields: b.fields || [],
        superuser,
      });
      return { ok: true };
    });
  }
  saveRole(u, b) {
    this.requireAdmin(u);
    return this.e.tx(() => {
      let id = b.id ? integer(b.id, 1) : 0;
      const old = id
        ? this.one("SELECT * FROM access_roles WHERE id=?", id)
        : null;
      if (id && (!old || old.version !== integer(b.version, 1)))
        fail("角色已被修改，請重新載入", 409);
      const name = txt(b.name, 80, true),
        description = txt(b.description, 500),
        active = b.active === false ? 0 : 1;
      if (id)
        this.e.run(
          "UPDATE access_roles SET name=?,description=?,active=?,version=version+1 WHERE id=?",
          name,
          description,
          active,
          id,
        );
      else
        id = Number(
          this.e.run(
            "INSERT INTO access_roles(name,description,active) VALUES(?,?,?)",
            name,
            description,
            active,
          ).lastInsertRowid,
        );
      const parents = [
        ...new Set((b.parent_ids || []).map((x) => integer(x, 1))),
      ];
      if (parents.length > 30) fail("繼承角色過多");
      this.e.run("DELETE FROM access_role_parents WHERE role_id=?", id);
      for (const parent of parents) {
        if (!this.one("SELECT id FROM access_roles WHERE id=?", parent))
          fail("繼承角色不存在");
        const visit = (n, seen = new Set()) => {
          if (n === id) fail("角色繼承不可形成循環");
          if (seen.has(n)) return;
          seen.add(n);
          for (const p of this.raw(
            "SELECT parent_id FROM access_role_parents WHERE role_id=?",
            n,
          ))
            visit(p.parent_id, seen);
        };
        visit(parent);
        this.e.run("INSERT INTO access_role_parents VALUES(?,?)", id, parent);
      }
      this.saveRules("role", id, b);
      this.changed(u, "access_role", id, {
        name,
        parent_ids: parents,
        rules: b.rules || [],
        fields: b.fields || [],
      });
      return { id };
    });
  }
  simulate(u, b) {
    this.requireAdmin(u);
    if (
      !defs.some((d) => d[0] === b.resource) ||
      !Object.hasOwn(actions, b.action)
    )
      fail("試算功能或動作錯誤");
    const target = this.hydrate(
      this.one(
        "SELECT id,username,name,role,active FROM users WHERE id=?",
        integer(b.user_id, 1),
      ),
    );
    if (!target) fail("找不到使用者");
    const p = this.policy(target);
    if (
      b.table &&
      (!this.tables.has(b.table) ||
        excluded.has(b.table) ||
        b.table.startsWith("access_"))
    )
      fail("不允許模擬此資料表");
    if (
      b.table &&
      b.table !== "documents" &&
      this.resource(b.table) !== b.resource
    )
      fail("資料表與權限項目不一致");
    if (b.table === "documents" && b.record_id) {
      const row = this.one(
        "SELECT kind FROM documents WHERE id=?",
        integer(b.record_id, 1),
      );
      if (this.resource("documents", row) !== b.resource)
        fail("單據與權限項目不一致");
    }
    let result;
    try {
      this.assert(p, b.resource, b.action, b.table, b.record_id);
      result = { allowed: true };
    } catch (e) {
      result = { allowed: false, reason: e.message };
    }
    return {
      ...result,
      rules: this.rules(p, b.resource, b.action),
      effective: this.data(target).access_effective,
    };
  }
}
