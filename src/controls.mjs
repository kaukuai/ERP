import { integer, fail } from "./core.mjs";
import { Quality } from "./quality.mjs";
import { VendorBills } from "./vendor-bills.mjs";
import {
  controlPermission,
  sourcePermission,
  moneyPermission,
} from "./control-access.mjs";
export function guardControls(e, u, path, method, b = {}) {
  if (!path.startsWith("/api/controls/")) return false;
  const parts = path.split("/"),
    group = parts[3],
    id = /^\d+$/.test(parts[4] || "")
      ? integer(parts[4], 1)
      : b.id
        ? integer(b.id, 1)
        : null,
    tail = parts.at(-1);
  if (group === "procurement-policy" || group === "quality-specs") {
    e.access.requireAdmin(u);
    return true;
  }
  const resource = ["vendor-bills", "vendor-sources"].includes(group)
    ? "vendor_bills"
    : group === "quality-inspections"
      ? "quality_inspections"
      : null;
  if (!resource) fail("控管入口不存在", 404);
  let action = method === "GET" ? "read" : id ? "update" : "create";
  if (tail === "action") {
    action = b.action;
    if (!["submit", "approve", "cancel"].includes(action))
      fail("不支援的控管動作");
  }
  if (tail === "match") action = "read";
  controlPermission(e, u, resource, action, id);
  if (resource === "vendor_bills") {
    const v = new VendorBills(e);
    moneyPermission(e, u);
    if (id) v.authorize(u, id, action);
    else if (Array.isArray(b.lines))
      for (const l of b.lines) v.source(u, l.receipt_line_id);
  } else {
    const row = id
      ? e.access.one(
          "SELECT document_id FROM quality_inspections WHERE id=?",
          id,
        )
      : null;
    if (row) sourcePermission(e, u, row.document_id);
    else if (b.document_id) sourcePermission(e, u, b.document_id);
  }
  return true;
}
export class Controls {
  constructor(e) {
    this.e = e;
    this.quality = new Quality(e);
    this.vendor = new VendorBills(e);
  }
  data(u) {
    return { ...this.quality.data(u), ...this.vendor.data(u) };
  }
  get(u, path, query = {}) {
    if (path === "/api/controls/vendor-sources")
      return this.vendor.sources(u, query);
    const parts = path.split("/"),
      id = parts[4];
    if (/^\/api\/controls\/quality-inspections\/\d+$/.test(path))
      return this.quality.detail(u, id);
    if (/^\/api\/controls\/vendor-bills\/\d+\/match$/.test(path))
      return this.vendor.match(u, id);
    if (/^\/api\/controls\/vendor-bills\/\d+$/.test(path))
      return this.vendor.detail(u, id);
  }
  post(u, path, b) {
    const parts = path.split("/"),
      id = parts[4];
    if (path === "/api/controls/procurement-policy")
      return this.vendor.configure(u, b);
    if (path === "/api/controls/quality-specs") return this.quality.spec(u, b);
    if (path === "/api/controls/quality-inspections")
      return this.quality.create(u, b);
    if (/^\/api\/controls\/quality-inspections\/\d+\/save$/.test(path))
      return this.quality.save(u, id, b);
    if (/^\/api\/controls\/quality-inspections\/\d+\/action$/.test(path))
      return this.quality.action(u, id, b);
    if (path === "/api/controls/vendor-bills") return this.vendor.save(u, b);
    if (/^\/api\/controls\/vendor-bills\/\d+\/action$/.test(path))
      return this.vendor.action(u, id, b);
  }
}
