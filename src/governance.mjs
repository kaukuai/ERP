import {
  fail,
  integer,
  scaled,
  txt,
  now,
  today,
  dateValue,
  addDays,
  permit,
} from "./core.mjs";
const resources = { quote: "quotes", order: "orders", purchase: "purchases" };
export const formatActions = {
  form: {
    read: "查看版型",
    update: "修改版型",
    print: "空白／交易列印",
    export: "匯出版型",
    fill: "新增填寫紀錄",
    entry_read: "查看填寫紀錄",
    entry_update: "修改填寫紀錄",
    entry_submit: "送出紀錄",
    entry_cancel: "取消紀錄",
    entry_print: "列印填寫紀錄",
  },
  report: { read: "查看報表", update: "修改報表", print: "列印報表" },
};
export function formatAllowed(e, u, kind, id, action) {
  if (e.access.policy(u).superuser) return true;
  const rows = e.access.raw(
    "SELECT action,effect FROM format_grants WHERE kind=? AND format_id=? AND user_id=?",
    kind,
    integer(id, 1),
    u.id,
  );
  return !rows.some(
    (r) =>
      r.effect === "deny" &&
      (r.action === action ||
        r.action === (action.startsWith("entry_") ? "entry_read" : "read")),
  );
}
export function assertFormat(e, u, kind, id, action) {
  if (!formatAllowed(e, u, kind, id, action))
    fail("此帳號未獲授權使用這個指定版型／紀錄動作", 403);
}
function assertDoc(e, u, d, action = "read") {
  e.access.assert(
    e.access.policy(u),
    resources[d.kind],
    action,
    "documents",
    d.id,
  );
  // Legacy ownership checks apply equally outside HTTP.
  e.doc(u, d.id);
}
function requestFor(e, id) {
  return e.access.one(
    "SELECT * FROM approval_requests WHERE document_id=? AND status='pending'",
    id,
  );
}
// Match required approval seats to distinct people before accepting an unfinishable route.
function canFinish(stages, blocked = new Set()) {
  const seats = stages.flatMap((s) =>
    s.mode === "all" ? s.user_ids.map((id) => [id]) : [s.user_ids],
  );
  const assigned = new Map();
  function take(index, seen) {
    for (const id of seats[index]) {
      if (blocked.has(id) || seen.has(id)) continue;
      seen.add(id);
      if (!assigned.has(id) || take(assigned.get(id), seen)) {
        assigned.set(id, index);
        return true;
      }
    }
    return false;
  }
  return seats.every((_, i) => take(i, new Set()));
}
function eligible(e, doc, rule) {
  const definition = JSON.parse(rule.definition);
  const stages = definition.stages.map((s) => {
    let ids =
      s.source === "manager"
        ? [
            e.access.one(
              "SELECT manager_id FROM access_profiles WHERE user_id=?",
              doc.owner_id,
            )?.manager_id,
          ]
        : s.user_ids;
    ids = [...new Set(ids.filter(Boolean))];
    if (definition.forbid_owner) ids = ids.filter((id) => id !== doc.owner_id);
    ids = ids.filter((id) => {
      const user = e.user(id);
      if (!user?.active) return false;
      try {
        permit(user, "approve");
        assertDoc(e, user, doc, "approve");
        return true;
      } catch (error) {
        if (error.status === 403) return false;
        throw error;
      }
    });
    if (!ids.length)
      fail(
        "簽核階段沒有可用且具備來源單據核准權的簽核人，請管理員修正規則",
        409,
      );
    return { ...s, user_ids: ids };
  });
  if (definition.distinct_actors && !canFinish(stages))
    fail("簽核階段無法分配不同核准人，請修正規則", 409);
  return { ...definition, stages };
}
export function startApproval(e, u, doc) {
  const matches = e.access.raw(
    "SELECT * FROM approval_rules WHERE active=1 AND kind=? AND min_amount<=? AND (max_amount IS NULL OR max_amount>=?)",
    doc.kind,
    doc.total,
    doc.total,
  );
  if (!matches.length) return;
  if (matches.length !== 1) fail("簽核規則區間重疊，無法送審", 409);
  const rule = matches[0],
    definition = eligible(e, doc, rule);
  e.run(
    "INSERT INTO approval_requests(document_id,document_version,rule_id,definition,created_by,created_at) VALUES(?,?,?,?,?,?)",
    doc.id,
    doc.version + 1,
    rule.id,
    JSON.stringify({
      ...definition,
      name: rule.name,
      rule_version: rule.version,
    }),
    u.id,
    now(),
  );
}
export function advanceApproval(e, u, doc, action, b) {
  const row = requestFor(e, doc.id);
  if (!row) return true;
  if (b.version === undefined) fail("簽核操作必須提供單據修訂", 409);
  if (row.document_version !== doc.version)
    fail("簽核來源修訂已變更，請退回後重新送審", 409);
  const definition = JSON.parse(row.definition),
    stage = definition.stages[row.stage];
  const principal = integer(b.principal_id ?? u.id, 1);
  if (!stage.user_ids.includes(principal)) fail("目前階段未指定此簽核人", 403);
  if (
    principal !== u.id &&
    !e.access.one(
      "SELECT id FROM approval_delegations WHERE active=1 AND principal_id=? AND delegate_id=? AND starts<=? AND ends>=? AND kind IN (?,'all')",
      principal,
      u.id,
      today(),
      today(),
      doc.kind,
    )
  )
    fail("代理授權不存在或已到期", 403);
  const original = e.user(principal);
  if (!original?.active) fail("原簽核人已停用", 403);
  permit(original, "approve");
  assertDoc(e, original, doc, "approve");
  if (
    definition.forbid_owner &&
    (u.id === doc.owner_id || principal === doc.owner_id)
  )
    fail("此規則禁止經辦人自行核准或代理", 403);
  if (
    e.access.one(
      "SELECT id FROM approval_votes WHERE request_id=? AND stage=? AND principal_id=?",
      row.id,
      row.stage,
      principal,
    )
  )
    fail("此簽核人已完成本階段，請重新整理", 409);
  if (
    definition.distinct_actors &&
    e.access.one(
      "SELECT id FROM approval_votes WHERE request_id=? AND stage<>? AND (actor_id IN (?,?) OR principal_id IN (?,?))",
      row.id,
      row.stage,
      u.id,
      principal,
      u.id,
      principal,
    )
  )
    fail("此規則禁止同一人或其代理跨階重複核准", 403);
  if (
    e.access.one(
      "SELECT id FROM approval_votes WHERE request_id=? AND stage=? AND actor_id=?",
      row.id,
      row.stage,
      u.id,
    )
  )
    fail("同一實際簽核人不能代替多人會簽", 403);
  if (action === "approve" && definition.distinct_actors) {
    const past = e.access.raw(
      "SELECT principal_id,actor_id FROM approval_votes WHERE request_id=?",
      row.id,
    );
    const blocked = new Set([
      ...past.flatMap((v) => [v.principal_id, v.actor_id]),
      u.id,
      principal,
    ]);
    const currentVotes = new Set(
      e.access
        .raw(
          "SELECT principal_id FROM approval_votes WHERE request_id=? AND stage=?",
          row.id,
          row.stage,
        )
        .map((v) => v.principal_id),
    );
    currentVotes.add(principal);
    const rest = [
      ...(stage.mode === "all"
        ? [
            {
              ...stage,
              user_ids: stage.user_ids.filter((id) => !currentVotes.has(id)),
            },
          ]
        : []),
      ...definition.stages.slice(row.stage + 1),
    ];
    if (!canFinish(rest, blocked))
      fail(
        "此決定會使後續階段無法由不同人完成，請選擇其他核准人或退回調整規則",
        409,
      );
  }
  const reason = txt(b.reason, 1000, action === "reject");
  e.run(
    "INSERT INTO approval_votes(request_id,stage,principal_id,actor_id,decision,reason,created_at) VALUES(?,?,?,?,?,?,?)",
    row.id,
    row.stage,
    principal,
    u.id,
    action,
    reason,
    now(),
  );
  const count = e.access.one(
    "SELECT count(*) n FROM approval_votes WHERE request_id=? AND stage=? AND decision='approve'",
    row.id,
    row.stage,
  ).n;
  const finished =
    action === "reject" ||
    stage.mode === "any" ||
    count === stage.user_ids.length;
  const final =
    finished &&
    (action === "reject" || row.stage === definition.stages.length - 1);
  e.run(
    "UPDATE approval_requests SET stage=?,status=?,version=version+1,document_version=? WHERE id=?",
    finished && !final ? row.stage + 1 : row.stage,
    final ? (action === "reject" ? "rejected" : "approved") : "pending",
    doc.version + 1,
    row.id,
  );
  e.log(u, "approval_" + action, "document", doc.id, {
    request_id: row.id,
    stage: row.stage,
    principal_id: principal,
    final,
    reason,
  });
  return final;
}
export function cancelApproval(e, documentId) {
  e.run(
    "UPDATE approval_requests SET status='cancelled',version=version+1 WHERE document_id=? AND status='pending'",
    documentId,
  );
}
export function checkEntryWindow(e, date, module) {
  const p = JSON.parse(e.settings().entry_window_policy || "{}");
  const modules =
    module === "all" ? ["trade", "inventory", "finance"] : [module];
  for (const key of modules) {
    const days = p[key];
    if (Number.isInteger(days) && date < addDays(today(), -days))
      fail(`已超過允許補打單期限（${days} 天），請管理員核對政策`, 409);
  }
}
export class Governance {
  constructor(e) {
    this.e = e;
  }
  rule(u, b) {
    const e = this.e;
    e.access.requireAdmin(u);
    return e.tx(() => {
      const old = b.id
        ? e.access.one(
            "SELECT * FROM approval_rules WHERE id=?",
            integer(b.id, 1),
          )
        : null;
      if (b.id && (!old || old.version !== integer(b.version, 1)))
        fail("簽核規則已更新或不存在", 409);
      const kind = b.kind;
      if (!Object.hasOwn(resources, kind)) fail("不支援的單據種類");
      const min = scaled(b.min_amount ?? 0),
        max =
          b.max_amount === "" || b.max_amount == null
            ? null
            : scaled(b.max_amount);
      if (max !== null && max < min) fail("上限不可小於下限");
      const active =
        b.active === false || b.active === "0" || b.active === 0 ? 0 : 1;
      if (
        active &&
        e.access.one(
          "SELECT id FROM approval_rules WHERE active=1 AND kind=? AND id<>? AND (max_amount IS NULL OR max_amount>=?) AND (? IS NULL OR min_amount<=?)",
          kind,
          old?.id || 0,
          min,
          max,
          max,
        )
      )
        fail("同種類啟用規則的金額區間不能重疊", 409);
      if (!Array.isArray(b.stages) || !b.stages.length || b.stages.length > 10)
        fail("請設定 1–10 個簽核階段");
      const stages = b.stages.map((s) => {
        if (
          !["any", "all"].includes(s.mode) ||
          !["users", "manager"].includes(s.source)
        )
          fail("簽核方式錯誤");
        if (s.source === "users" && !Array.isArray(s.user_ids))
          fail("簽核人清單格式錯誤");
        const ids =
          s.source === "users"
            ? [...new Set((s.user_ids || []).map((id) => integer(id, 1)))]
            : [];
        if (s.source === "users" && (!ids.length || ids.length > 20))
          fail("每階段請選 1–20 位簽核人");
        for (const id of ids) {
          const user = e.user(id);
          if (!user?.active) fail("簽核人未啟用");
          permit(user, "approve");
        }
        return {
          name: txt(s.name, 80, true),
          source: s.source,
          mode: s.mode,
          user_ids: ids,
        };
      });
      const definition = {
        stages,
        forbid_owner: b.forbid_owner !== false,
        distinct_actors: b.distinct_actors !== false,
      };
      const name = txt(b.name, 100, true),
        version = (old?.version || 0) + 1;
      let id = old?.id;
      if (id)
        e.run(
          "UPDATE approval_rules SET name=?,kind=?,min_amount=?,max_amount=?,definition=?,active=?,version=? WHERE id=?",
          name,
          kind,
          min,
          max,
          JSON.stringify(definition),
          active,
          version,
          id,
        );
      else
        id = Number(
          e.run(
            "INSERT INTO approval_rules(name,kind,min_amount,max_amount,definition,active,created_by) VALUES(?,?,?,?,?,?,?)",
            name,
            kind,
            min,
            max,
            JSON.stringify(definition),
            active,
            u.id,
          ).lastInsertRowid,
        );
      e.run(
        "INSERT INTO approval_rule_versions VALUES(?,?,?,?,?)",
        id,
        version,
        JSON.stringify({
          name,
          kind,
          min_amount: min,
          max_amount: max,
          active,
          ...definition,
        }),
        u.id,
        now(),
      );
      e.log(u, "approval_rule", "approval_rule", id, { version });
      return { id, version };
    });
  }
  delegation(u, b) {
    const e = this.e;
    e.access.requireAdmin(u);
    return e.tx(() => {
      const old = b.id
        ? e.access.one(
            "SELECT * FROM approval_delegations WHERE id=?",
            integer(b.id, 1),
          )
        : null;
      if (b.id && (!old || old.version !== integer(b.version, 1)))
        fail("代理設定已更新", 409);
      const principal = integer(b.principal_id, 1),
        delegate = integer(b.delegate_id, 1),
        starts = dateValue(b.starts),
        ends = dateValue(b.ends);
      if (
        principal === delegate ||
        starts > ends ||
        !["all", ...Object.keys(resources)].includes(b.kind)
      )
        fail("代理人、日期或種類錯誤");
      for (const id of [principal, delegate]) {
        const user = e.user(id);
        if (!user?.active) fail("簽核人未啟用");
        permit(user, "approve");
      }
      const active =
        b.active === false || b.active === "0" || b.active === 0 ? 0 : 1;
      const args = [principal, delegate, starts, ends, b.kind, active];
      let id = old?.id;
      if (id)
        e.run(
          "UPDATE approval_delegations SET principal_id=?,delegate_id=?,starts=?,ends=?,kind=?,active=?,version=version+1 WHERE id=?",
          ...args,
          id,
        );
      else
        id = Number(
          e.run(
            "INSERT INTO approval_delegations(principal_id,delegate_id,starts,ends,kind,active,created_by) VALUES(?,?,?,?,?,?,?)",
            ...args,
            u.id,
          ).lastInsertRowid,
        );
      e.log(u, "approval_delegation", "approval_delegation", id, { ...b });
      return { id };
    });
  }
  periods(u, b) {
    const e = this.e;
    e.access.requireAdmin(u);
    return e.tx(() => {
      const old = JSON.parse(e.settings().entry_window_policy);
      if (integer(b.version) !== old.version) fail("補打單政策已更新", 409);
      const p = { version: old.version + 1 };
      for (const key of ["trade", "inventory", "finance"])
        p[key] =
          b[key] === "" || b[key] == null ? null : integer(b[key], 0, 3650);
      e.run(
        "UPDATE settings SET value=? WHERE key='entry_window_policy'",
        JSON.stringify(p),
      );
      e.log(u, "entry_window_policy", "settings", 1, {
        previous: old,
        current: p,
      });
      return p;
    });
  }
  grants(u, b) {
    const e = this.e;
    e.access.requireAdmin(u);
    return e.tx(() => {
      const kind = b.kind,
        id = integer(b.format_id, 1);
      if (!Object.hasOwn(formatActions, kind)) fail("版型種類錯誤");
      if (
        !e.access.one(
          `SELECT id FROM ${kind === "form" ? "form_templates" : "report_designs"} WHERE id=?`,
          id,
        )
      )
        fail("版型不存在", 404);
      const old =
        e.access.one(
          "SELECT version FROM format_grant_versions WHERE kind=? AND format_id=?",
          kind,
          id,
        )?.version || 0;
      if (integer(b.version) !== old) fail("版型授權已更新", 409);
      if (!Array.isArray(b.grants) || b.grants.length > 2000)
        fail("授權筆數錯誤");
      const seen = new Set();
      const grants = b.grants.map((r) => {
        const user = integer(r.user_id, 1),
          key = user + ":" + r.action;
        if (
          !e.user(user) ||
          !Object.hasOwn(formatActions[kind], r.action) ||
          !["allow", "deny"].includes(r.effect) ||
          seen.has(key)
        )
          fail("授權帳號、動作、效果或重複資料錯誤");
        seen.add(key);
        return { ...r, user_id: user };
      });
      e.run("DELETE FROM format_grants WHERE kind=? AND format_id=?", kind, id);
      for (const r of grants)
        e.run(
          "INSERT INTO format_grants VALUES(?,?,?,?,?)",
          kind,
          id,
          r.user_id,
          r.action,
          r.effect,
        );
      e.run(
        "INSERT INTO format_grant_versions VALUES(?,?,?) ON CONFLICT(kind,format_id) DO UPDATE SET version=excluded.version",
        kind,
        id,
        old + 1,
      );
      e.access.changed(u, "format_grants", kind + ":" + id, {
        grants,
        version: old + 1,
      });
      return { version: old + 1 };
    });
  }
  detail(u, id) {
    const e = this.e,
      row = e.access.one(
        "SELECT * FROM approval_requests WHERE id=?",
        integer(id, 1),
      );
    if (!row) fail("簽核請求不存在", 404);
    const doc = e.access.one(
      "SELECT * FROM documents WHERE id=?",
      row.document_id,
    );
    assertDoc(e, u, doc);
    const policy = JSON.parse(row.definition),
      stage = policy.stages[row.stage];
    const available = stage.user_ids.filter(
      (id) =>
        id === u.id ||
        e.access.one(
          "SELECT id FROM approval_delegations WHERE active=1 AND principal_id=? AND delegate_id=? AND starts<=? AND ends>=? AND kind IN (?,'all')",
          id,
          u.id,
          today(),
          today(),
          doc.kind,
        ),
    );
    return {
      ...row,
      available_principals: available.map((id) => ({
        id,
        name: e.user(id)?.name || String(id),
      })),
      definition: policy,
      document: {
        id: doc.id,
        no: doc.no,
        kind: doc.kind,
        version: doc.version,
        status: doc.status,
      },
      votes: e.access.raw(
        "SELECT v.*,u.name actor_name,p.name principal_name FROM approval_votes v JOIN users u ON u.id=v.actor_id JOIN users p ON p.id=v.principal_id WHERE request_id=? ORDER BY v.id",
        row.id,
      ),
    };
  }
  data(u) {
    const e = this.e,
      admin = e.access.policy(u).superuser;
    const visible = e.access.raw(
      `SELECT a.id,d.no,d.kind,d.status document_status,a.stage,a.status,a.document_id,a.version FROM approval_requests a JOIN documents d ON d.id=a.document_id WHERE d.id IN (SELECT id FROM documents WHERE ${e.access.predicate(e.access.policy(u), "documents")}) ORDER BY a.id DESC LIMIT 500`,
    );
    return {
      approval_requests: visible,
      governance: admin
        ? {
            rules: e.access
              .raw("SELECT * FROM approval_rules")
              .map((r) => ({ ...r, ...JSON.parse(r.definition) })),
            delegations: e.access.raw("SELECT * FROM approval_delegations"),
            periods: JSON.parse(e.settings().entry_window_policy),
            format_actions: formatActions,
            grants: e.access.raw("SELECT * FROM format_grants"),
            grant_versions: e.access.raw("SELECT * FROM format_grant_versions"),
            formats: [
              ...e.access.raw("SELECT id,name,'form' kind FROM form_templates"),
              ...e.access.raw(
                "SELECT id,name,'report' kind FROM report_designs",
              ),
            ],
            users: e.access.raw(
              "SELECT id,name,username,role,active FROM users ORDER BY id",
            ),
          }
        : undefined,
    };
  }
  get(u, path) {
    if (/^\/api\/governance\/requests\/\d+$/.test(path))
      return this.detail(u, path.split("/").at(-1));
  }
  post(u, path, b) {
    const methods = {
      rules: "rule",
      delegations: "delegation",
      periods: "periods",
      grants: "grants",
    };
    const key = path.split("/").at(-1);
    if (path === "/api/governance/" + key && Object.hasOwn(methods, key))
      return this[methods[key]](u, b);
  }
}
