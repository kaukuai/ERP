import { fail, permit, integer } from "./core.mjs";
export function controlPermission(e, u, resource, action, id) {
  permit(u, "all");
  const p = e.access.policy(u);
  if (p.configured) e.access.assert(p, resource, action, resource, id);
  else
    permit(
      u,
      resource === "vendor_bills"
        ? action === "approve" || action === "cancel"
          ? "approve"
          : "finance"
        : action === "read"
          ? "all"
          : action === "approve" || action === "cancel"
            ? "approve"
            : "stock",
    );
}
export function sourcePermission(e, u, id, action = "read") {
  const row = e.access.one(
    "SELECT * FROM documents WHERE id=?",
    integer(id, 1),
  );
  if (!row) fail("來源單據不存在", 404);
  e.access.assert(
    e.access.policy(u),
    { order: "orders", purchase: "purchases", quote: "quotes" }[row.kind],
    action,
    "documents",
    row.id,
  );
  e.doc(u, row.id);
  return row;
}
export function moneyPermission(e, u) {
  permit(u, "cost");
  const p = e.access.policy(u);
  if (
    p.configured &&
    !p.superuser &&
    p.fields.some(
      (f) => e.access.fieldMode(p, f.resource, f.field) === "hidden",
    )
  )
    fail("來源含隱藏欄位，此帳號不能檢視三方核對的原始金額", 403);
}
export function canControl(e, u, resource, action, id) {
  try {
    controlPermission(e, u, resource, action, id);
    if (resource === "vendor_bills") moneyPermission(e, u);
    return true;
  } catch (error) {
    if (error.status === 403) return false;
    throw error;
  }
}
