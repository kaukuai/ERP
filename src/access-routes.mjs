import { guardControls } from "./controls.mjs";
import { guardEnterprise } from "./enterprise.mjs";
import { accessPolicy, accessContext } from "./access-control.mjs";
import { fail, integer } from "./core.mjs";
const routes = {
  "forms": ["form_templates", null],
  "form-templates": ["form_templates", "form_templates"],
  "form-entries": ["form_entries", "form_entries"],
  "form-preview": ["form_templates", "form_templates"],
  partners: ["partners", "partners"],
  contacts: ["partners", "partner_contacts"],
  addresses: ["partners", "partner_addresses"],
  activities: ["partners", "activities"],
  prices: ["partners", "prices"],
  products: ["products", "products"],
  "product-units": ["products", "product_units"],
  "product-images": ["products", null],
  boms: ["products", "boms"],
  warehouses: ["warehouses", "warehouses"],
  fulfilments: ["fulfilments", "fulfilments"],
  "fulfilment-batches": ["fulfilments", "fulfilment_batches"],
  returns: ["fulfilments", "returns"],
  "direct-trades": ["orders", null],
  adjustments: ["inventory", null],
  transfers: ["inventory", null],
  loans: ["inventory", "loans"],
  "cost-adjustments": ["inventory", "cost_adjustments"],
  "inventory-lots": ["inventory", "inventory_lots"],
  "inventory-tracking": ["products", null],
  "inventory-counts": ["counts", "inventory_counts"],
  counts: ["counts", "inventory_counts"],
  picks: ["picks", "pick_lists"],
  "work-orders": ["work", "work_orders"],
  "monthly-bills": ["billing", "billing_batches"],
  payments: ["payments", "payments"],
  journals: ["journals", "journals"],
  banks: ["banks", "banks"],
  checkbooks: ["bills", "checkbooks"],
  departments: ["directory", "departments"],
  employees: ["directory", "employees"],
  subscriptions: ["subscriptions", "subscription_plans"],
  "subscription-periods": ["subscriptions", "subscription_periods"],
  "sku-mappings": ["imports", "sku_mappings"],
  "order-import-templates": ["imports", "order_import_templates"],
  "order-imports": ["imports", "order_import_jobs"],
  imports: ["imports", "imports"],
  "master-import-templates": ["imports", "master_import_templates"],
  "master-imports": ["imports", null],
  "custom-reports": ["reports", "report_designs"],
  reports: ["reports", null],
  "bad-debts": ["expenses", "bad_debts"],
  "expense-allocations": ["expenses", "expense_allocations"],
  reconciliations: ["banks", "reconcile_jobs"],
  "bill-restrictions": ["bills", "bills"],
  endorsements: ["bills", "endorsements"],
  "nontrade-bills": ["bills", "nontrade_bills"],
  "invoice-ranges": ["invoices", "invoice_ranges"],
  "invoice-numbers": ["invoices", "invoice_numbers"],
  "invoice-profiles": ["invoices", "invoice_print_profiles"],
  "invoice-print-profiles": ["invoices", "invoice_print_profiles"],
  "invoice-exchange-profiles": ["invoices", "invoice_exchange_profiles"],
  "invoice-exchanges": ["invoices", "invoice_exchange_jobs"],
  "service-policy": ["services", null],
  repairs: ["services", "repair_tickets"],
  "service-contracts": ["services", "service_contracts"],
  "rental-periods": ["services", "rental_periods"],
  "pos-stores": ["pos", "pos_stores"],
  "pos-members": ["pos", "loyalty_members"],
  "pos-promotions": ["pos", "pos_promotions"],
  "loyalty-policy": ["pos", null],
  "pos-shifts": ["pos", "pos_shifts"],
  "pos-sales": ["pos", "pos_sales"],
  pos: ["pos", null],
  settings: ["system", null],
  users: ["system", "users"],
  "numbering-rules": ["system", null],
  companies: ["system", null],
  "company-summary-grants": ["system", null],
  "company-summary": ["system", null],
  backup: ["system", null],
  integrity: ["system", null],
  rebuilds: ["system", null],
  "sales-price": ["partners", null],
  "completion-stock": ["inventory", "stock_documents"],
  "completion-statement": ["billing", null],
  labels: ["products", null],
  "label-preview": ["products", null],
};
const completionRoutes = {
  "invoice-link": ["invoices", null],
  assign: ["partners", "partners"],
  standards: ["costs", null],
  "cost-policy": ["system", null],
  "monthly-cost-preview": ["costs", null],
  "monthly-cost": ["system", null],
  preferences: ["partners", null],
  category: ["products", "product_categories"],
  "custom-field": ["products", "custom_field_definitions"],
  "product-attributes": ["products", "products"],
  "opening-fund": ["payments", null],
  closing: ["system", null],
  "closing-preview": ["system", null],
  "stock-document": ["inventory", "stock_documents"],
  "stock-action": ["inventory", "stock_documents"],
  "stock-detail": ["inventory", "stock_documents"],
  "stock-print": ["inventory", "stock_documents"],
  "replenishment-policy": ["purchases", null],
  replenish: ["purchases", null],
  "count-rebase": ["counts", "inventory_counts"],
  "count-preview": ["counts", "inventory_counts"],
  "count-file": ["counts", "inventory_counts"],
  history: ["partners", null],
  "stock-history": ["inventory", null],
  matrix: ["reports", null],
  disassemble: ["work", null],
  "kit-sale": ["orders", null],
  "partial-release": ["orders", "documents"],
  settlement: ["payments", null],
  aging: ["billing", null],
  "cost-batch": ["products", null],
};
const bodyIdRoutes = new Set([
  "form-preview",
  "form-templates",
  "form-entries",
  "partners",
  "products",
  "product-units",
  "banks",
  "departments",
  "employees",
  "pos-stores",
  "pos-members",
  "pos-promotions",
  "custom-reports",
  "invoice-print-profiles",
  "invoice-exchange-profiles",
  "order-import-templates",
  "sku-mappings",
  "master-import-templates",
  "documents",
]);
const financeRoutes = {
  accounts: ["banks", "bank_accounts"],
  transfers: ["payments", "cash_transfers"],
  "batch-payments": ["payments", null],
  "payment-reversals": ["payments", "payment_reversals"],
  advances: ["payments", "funds"],
  applications: ["payments", "fund_applications"],
  refunds: ["payments", "fund_refunds"],
  "opening-items": ["billing", "opening_items"],
  "opening-payments": ["payments", "opening_payments"],
  bills: ["bills", "bills"],
  "bill-events": ["bills", "bill_events"],
  "expense-categories": ["expenses", "expense_categories"],
  expenses: ["expenses", "expenses"],
  "expense-payments": ["expenses", "expense_payments"],
  allowances: ["expenses", "allowances"],
};
const references = {
  invoice_id: "invoice_records",
  partner_id: "partners",
  customer_id: "partners",
  product_id: "products",
  warehouse_id: "warehouses",
  source_warehouse_id: "warehouses",
  holding_warehouse_id: "warehouses",
  document_id: "documents",
  source_document_id: "documents",
  document_line_id: "document_lines",
  fulfilment_id: "fulfilments",
  fulfilment_line_id: "fulfilment_lines",
  open_item_id: "open_items",
  opening_item_id: "opening_items",
  payment_id: "payments",
  fund_id: "funds",
  bank_account_id: "bank_accounts",
  cash_account_id: "bank_accounts",
  expense_id: "expenses",
  bill_id: "bills",
  store_id: "pos_stores",
  shift_id: "pos_shifts",
  member_id: "loyalty_members",
  unit_id: "product_units",
};
function documentResource(e, id, kind) {
  const d = id
    ? e.access.one("SELECT kind FROM documents WHERE id=?", integer(id, 1))
    : null;
  return (
    { quote: "quotes", order: "orders", purchase: "purchases" }[
      d?.kind || kind
    ] || "orders"
  );
}
export function routeDescriptor(e, path, method, b = {}, query = {}) {
  const parts = path.split("/").filter(Boolean),
    isPrint = parts[0] === "print";
  let group = parts[1],
    id = /^\d+$/.test(parts[2] || "") ? Number(parts[2]) : null,
    tail = parts.at(-1),
    pair;
  if (isPrint && /^\d+$/.test(group || "")) {
    id = Number(group);
    group = "documents";
  }
  if (group === "completion") {
    pair =
      parts[2] === "assign"
        ? [b.resource, b.resource === "partners" ? "partners" : "documents"]
        : completionRoutes[parts[2]];
    id =
      b.id || (b.product_id && parts[2] === "product-attributes")
        ? Number(b.id || b.product_id)
        : b.count_id
          ? Number(b.count_id)
          : b.document_id && parts[2] === "partial-release"
            ? Number(b.document_id)
            : query.id
              ? Number(query.id)
              : null;
  } else if (["documents", "document-preview"].includes(group)) {
    pair = [documentResource(e, id || b.id, b.kind), "documents"];
  } else if (group === "finance") pair = financeRoutes[parts[2]];
  else if (group === "export") {
    const k = query.kind;
    pair =
      routes[k] ||
      {
        stocks: ["inventory", "stocks"],
        moves: ["inventory", "stock_moves"],
        open_items: ["billing", "open_items"],
        documents: ["orders", "documents"],
      }[k];
  } else pair = routes[group];
  if (!pair) return null;
  if (!id && group !== "completion" && bodyIdRoutes.has(group))
    id = b.id ? integer(b.id, 1) : null;
  let action = method === "GET" ? "read" : id ? "update" : "create";
  if (group === "completion" && method === "POST") {
    if (parts[2] === "assign") action = "assign";
    if (["partial-release", "disassemble"].includes(parts[2])) action = "post";
    if (parts[2] === "stock-action")
      action =
        b.action === "approve"
          ? "approve"
          : b.action === "cancel"
            ? "cancel"
            : "post";
    if (parts[2] === "count-rebase") action = "approve";
    if (["count-file", "cost-batch"].includes(parts[2])) action = "import";
  }
  if (query.format === "csv") action = "export";
  if (isPrint || (group === "completion" && parts[2] === "stock-print"))
    action = "print";
  else if (group === "export" || tail === "export") action = "export";
  else if (/import/.test(group) || /import-(preview|commit)/.test(tail))
    action = method === "POST" ? "import" : action;
  else if (
    ["approve", "reject"].includes(tail) ||
    b.action === "approve" ||
    b.action === "reject"
  )
    action = "approve";
  else if (
    tail === "action" ||
    (group === "finance" && parts[2] === "bill-events")
  )
    action = ["cancel", "close"].includes(b.action)
      ? "cancel"
      : ["reverse", "refund", "return", "bounce"].includes(b.action)
        ? "reverse"
        : "post";
  else if (["submit"].includes(tail)) action = "submit";
  else if (["cancel", "close"].includes(tail) || b.action === "cancel")
    action = "cancel";
  else if (
    ["refund", "return", "payment-reversals", "refunds", "returns"].includes(
      tail,
    ) ||
    ["reverse", "refund", "return", "bounce"].includes(b.action)
  )
    action = "reverse";
  else if (
    [
      "post",
      "fulfil",
      "purchase",
      "execute",
      "complete",
      "commit",
      "charge",
      "pay",
      "checkout",
      "sell",
    ].includes(tail)
  )
    action = "post";
  return { resource: pair[0], table: pair[1], id: id || null, action };
}
export function guardRequest(e, u, path, method, b = {}, query = {}) {
  if(guardEnterprise(e,u,path,method,b))return;
  if(guardControls(e,u,path,method,b))return;
  const p = e.access.policy(u);
  if (!p.configured || p.superuser) return;
  if (
    [
      "/api/completion/preferences",
      "/api/session",
      "/api/bootstrap",
      "/api/logout",
      "/api/password",
      "/api/capabilities",
    ].includes(path)
  )
    return;
  if (path.startsWith("/api/governance/")) {
    if (!/^\/api\/governance\/requests\/\d+$/.test(path) || method!=="GET") e.access.requireAdmin(u);
    return;
  }
  if (path.startsWith("/api/access/")) {
    e.access.requireAdmin(u);
    return;
  }
  const d = routeDescriptor(e, path, method, b, query);
  if (!d) fail("此入口尚未授予細部權限", 403);
  if (d.resource === "system") fail("此入口需要完整權限管理員", 403);
  e.access.assert(p, d.resource, d.action, d.table, d.id);
  if (
    method === "POST" &&
    d.resource === "products" &&
    [
      "/api/product-units",
      "/api/completion/product-attributes",
      "/api/completion/cost-batch",
    ].includes(path) &&
    p.fields.some(
      (f) =>
        f.resource === "products" &&
        e.access.fieldMode(p, "products", f.field) !== "edit",
    )
  )
    fail("此批次／屬性入口可能改動受限商品欄位，請由完整權限管理員處理", 403);
  if (method === "GET") {
    if (["print", "export"].includes(d.action) || d.resource === "reports") {
      // Formatted output can contain aliased or positional values: fail closed until all included fields are visible.
      if (
        p.fields.some(
          (f) => e.access.fieldMode(p, f.resource, f.field) === "hidden",
        )
      )
        fail(
          "隱藏欄位的帳號不可使用包含原始欄位的列印、匯出或分析；請另授予唯讀欄位",
          403,
        );
    }
    return;
  }
  if (!d.id && ["create", "post", "import"].includes(d.action)) {
    const rs = e.access.rules(p, d.resource, d.action),
      columns = [
        "owner_id",
        "created_by",
        "user_id",
        "warehouse_id",
        "category",
      ],
      predicate = (r) => e.access.rulePredicate(p, r, columns),
      allow = rs.filter((x) => x.effect === "allow").map(predicate),
      deny = rs.filter((x) => x.effect === "deny").map(predicate);
    const condition =
      "(" +
      (allow.join(" OR ") || "0") +
      ")" +
      (deny.length ? " AND NOT (" + deny.join(" OR ") + ")" : "");
    if (
      !e.access.one(
        `SELECT 1 FROM (SELECT ? owner_id,? created_by,? user_id,? warehouse_id,? category) WHERE ${condition}`,
        Number(b.owner_id || u.id),
        u.id,
        u.id,
        b.warehouse_id ? integer(b.warehouse_id, 1) : null,
        String(b.category || ""),
      )
    )
      fail("新增資料不在授權範圍", 403);
  }
  e.access.checkFields(p, d.resource, b, d.table, d.id);
  if (/^\/api\/(form-templates|form-entries|form-preview)(?:\/|$)/.test(path)) return;
  // Form definitions and values have independently validated keys; linked document preview checks its source explicitly.
  // Foreign ids are checked without filtering the stock/credit calculations used by posting.
  const walk = (v, depth = 0) => {
    if (depth > 12) fail("資料層級過深");
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (["document_ids", "owner_ids"].includes(k) && Array.isArray(x)) {
        for (const id of x) {
          const row = e.access.one(
            "SELECT * FROM documents WHERE id=?",
            integer(id, 1),
          );
          if (!row) fail("來源單據不存在");
          e.access.assert(
            p,
            e.access.resource("documents", row),
            "read",
            "documents",
            id,
          );
        }
      }
      if (references[k] && x) {
        const table = references[k],
          id = integer(x, 1),
          row = e.access.one(
            `SELECT * FROM "${table}" WHERE ${table === "stocks" ? "product_id" : "id"}=?`,
            id,
          );
        if (!row) fail("關聯資料不存在");
        const resource = e.access.resource(table, row);
        if (resource) e.access.assert(p, resource, "read", table, id);
        else if (
          !e.access.one(
            `SELECT 1 FROM "${table}" WHERE id=? AND (${e.access.predicate(p, table)})`,
            id,
          )
        )
          fail("關聯資料不在授權範圍", 403);
      }
      if (x && typeof x === "object") walk(x, depth + 1);
    }
  };
  walk(b);
  const context = accessContext.getStore();
  if (context) {
    context.descriptor = d;
    context.dependencies = [];
    const dependency = (resource, action) => {
      e.access.assert(p, resource, action);
      context.dependencies.push({ resource, action, table: "documents" });
    };
    if (/^\/api\/documents\/\d+\/purchase$/.test(path))
      dependency("purchases", "create");
    if (path === "/api/direct-trades") {
      const resource = b.kind === "purchase" ? "purchases" : "orders";
      for (const action of ["create", "approve", "post"])
        dependency(resource, action);
    }
    if (path === "/api/completion/partial-release") {
      dependency("orders", "create");
      dependency("orders", "approve");
    }
  }
  if (
    Object.hasOwn(b, "owner_id") &&
    (d.id
      ? Number(b.owner_id || 0) !==
        Number(
          e.access.one(
            `SELECT owner_id FROM "${d.table}" WHERE id=?`,
            Number(d.id),
          )?.owner_id || 0,
        )
      : Number(b.owner_id || 0) !== p.user.id)
  )
    e.access.assert(p, d.resource, "assign", d.table, d.id);
}
