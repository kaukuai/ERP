import { fail, permit, integer, now } from "./core.mjs";
export function enterprisePermission(
  e,
  u,
  resource,
  action = "read",
  id = null,
  table = resource,
) {
  permit(u, "all");
  const p = e.access.policy(u);
  if (p.configured) e.access.assert(p, resource, action, table, id);
  else
    permit(
      u,
      resource === "document_outbox"
        ? "sell"
        : resource === "payroll_runs"
          ? "admin"
          : resource === "foreign_accounts"
            ? "finance"
            : resource === "production_routes" && action !== "read"
              ? "masters"
              : "stock",
    );
}
export function enterpriseCan(e, u, resource, action = "read", id = null) {
  try {
    enterprisePermission(e, u, resource, action, id);
    return true;
  } catch (error) {
    if (error.status === 403) return false;
    throw error;
  }
}
export function enterpriseRows(e, u, table, extra = "1", limit = 500) {
  return e.access.raw(
    `SELECT * FROM ${table} WHERE (${e.access.predicate(e.access.policy(u), table)}) AND (${extra}) ORDER BY id DESC LIMIT ${integer(limit, 1, 2000)}`,
  );
}
export function event(e, u, resource, id, action, detail = {}) {
  e.run(
    "INSERT INTO enterprise_events(resource,entity_id,action,detail,created_by,created_at) VALUES(?,?,?,?,?,?)",
    resource,
    id,
    action,
    JSON.stringify(detail),
    u.id,
    now(),
  );
  e.log(u, resource + "_" + action, resource, id, detail);
}
export function revision(row, b) {
  if (!row) fail("資料不存在", 404);
  if (row.version !== integer(b.version, 1))
    fail("資料已由其他人更新，請重新開啟", 409);
}
export const exact = (n, places = 2) => String(n / 10 ** places);
export function signedRatio(a, b, c) {
  const x = BigInt(a) * BigInt(b),
    d = BigInt(c);
  if (d <= 0n) fail("比例分母須大於零");
  return integer(
    Number(((x < 0n ? -1n : 1n) * ((x < 0n ? -x : x) + d / 2n)) / d),
    -1e12,
    1e12,
  );
}
