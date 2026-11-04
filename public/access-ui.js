const accessFieldNames = {
  contact: "聯絡人",
  phone: "電話",
  email: "電子郵件",
  address: "地址",
  tax_id: "統一編號",
  credit_limit: "信用額度",
  payment_days: "付款天數",
  notes: "備註",
  owner_id: "負責人",
  cost: "參考成本",
  supplier_id: "供應商",
  price: "標準／交易單價",
  retail_price: "零售價",
  wholesale_price: "批發價",
  online_price: "網路價",
  discount_bp: "折扣",
  shipping_address: "送貨地址",
};
function uiLegacySales(d = S.data) {
  return d?.user?.role === "sales" && !d?.access_effective?.configured;
}
let accessAdmin = null,
  accessEdit = null;
async function accessLoad() {
  accessAdmin = await api("/api/access/admin");
  return accessAdmin;
}
function accessChoices(rows, selected = []) {
  return rows
    .map(
      (r) =>
        `<label style="display:inline-block;margin:6px"><input type="checkbox" data-access-choice value="${r.id}" ${selected.includes(r.id) ? "checked" : ""}> ${E(r.name)}</label>`,
    )
    .join("");
}
function accessRuleEditor(type, id) {
  const d = accessAdmin,
    rules = d.rules.filter(
      (x) => x.principal_type === type && x.principal_id === id,
    );
  accessEdit = {
    type,
    id,
    rules: rules.map((r) => ({
      ...r,
      owners: JSON.parse(r.owners),
      warehouses: JSON.parse(r.warehouses),
      categories: JSON.parse(r.categories),
    })),
    fields: d.fields.filter(
      (x) => x.principal_type === type && x.principal_id === id,
    ),
  };
  return `<h3>逐項權限</h3><p class="hint">每個動作獨立設定。個人規則優先於角色；同一層級的拒絕優先。沒有規則時才使用基本角色。上階關係本身不會授權。</p><div id="access-rules"></div>${btn("加入規則", "access-add-rule", "", "small", "plus")}<h3>欄位限制</h3><div id="access-fields"></div>${btn("加入欄位限制", "access-add-field", "", "small", "plus")}`;
}
function accessRenderRules() {
  const d = accessAdmin;
  if (!document.querySelector("#access-rules")) return;
  document.querySelector("#access-rules").innerHTML =
    accessEdit.rules
      .map(
        (r, i) =>
          `<div class="info-card" data-access-rule="${i}"><div class="form-grid">${selectField("功能", "resource", d.catalog.map((c) => `<option value="${c.key}" ${r.resource === c.key ? "selected" : ""}>${E(c.label)}</option>`).join(""))}${selectField("動作", "action", d.catalog[0].actions.map((c) => `<option value="${c.key}" ${r.action === c.key ? "selected" : ""}>${E(c.label)}</option>`).join(""))}${selectField("效果", "effect", `<option value="allow" ${r.effect === "allow" ? "selected" : ""}>允許</option><option value="deny" ${r.effect === "deny" ? "selected" : ""}>拒絕</option>`)}${selectField(
            "資料範圍",
            "scope",
            Object.entries(d.scopes)
              .map(
                ([k, v]) =>
                  `<option value="${k}" ${r.scope === k ? "selected" : ""}>${E(v)}</option>`,
              )
              .join(""),
          )}${field("下階深度（0 = 全部）", "depth", r.depth || 0, "number", 'min="0" max="100" step="1"')}${field("授權到期 UTC（留白永久）", "expires_at", r.expires_at || "", "text", 'placeholder="2027-01-01T00:00:00Z"')}</div><details><summary>指定使用者、倉庫與商品分類</summary><p>指定使用者（範圍選「指定使用者」才套用）</p><div data-access-owners>${accessChoices(d.users, r.owners || [])}</div><p>限制倉庫（全不選 = 不另限）</p><div data-access-warehouses>${accessChoices(d.warehouses, r.warehouses || [])}</div><p>限制商品分類（全不選 = 不另限）</p><div data-access-categories>${d.categories.map((c) => `<label style="display:inline-block;margin:6px"><input type="checkbox" value="${E(c.category)}" ${(r.categories || []).includes(c.category) ? "checked" : ""}> ${E(c.category || "未分類")}</label>`).join("")}</div></details>${btn("移除此規則", "access-remove-rule", i, "small danger")}</div>`,
      )
      .join("") || "<p>尚無個人規則，依繼承設定決定。</p>";
  document.querySelector("#access-fields").innerHTML = accessEdit.fields
    .map(
      (f, i) =>
        `<div class="form-grid" data-access-field="${i}">${selectField("功能／欄位", "field_key", d.catalog.flatMap((c) => c.fields.map((k) => `<option value="${c.key}:${k}" ${f.resource === c.key && f.field === k ? "selected" : ""}>${E(c.label)} · ${E(accessFieldNames[k] || k)}</option>`)).join(""))}${selectField("欄位模式", "mode", `<option value="readonly" ${f.mode === "readonly" ? "selected" : ""}>可見但唯讀</option><option value="hidden" ${f.mode === "hidden" ? "selected" : ""}>隱藏且禁止修改</option><option value="edit" ${f.mode === "edit" ? "selected" : ""}>可修改（仍須有功能修改權）</option>`)}${btn("移除欄位限制", "access-remove-field", i, "small danger")}</div>`,
    )
    .join("");
}
function accessCollect() {
  if (!accessEdit) return;
  accessEdit.rules = [...document.querySelectorAll("[data-access-rule]")].map(
    (el) => {
      const val = (n) => el.querySelector(`[name="${n}"]`).value,
        checked = (k) =>
          [...el.querySelectorAll(`[data-access-${k}] input:checked`)].map(
            (x) => (k === "categories" ? x.value : Number(x.value)),
          );
      return {
        resource: val("resource"),
        action: val("action"),
        effect: val("effect"),
        scope: val("scope"),
        depth: Number(val("depth")),
        expires_at: val("expires_at"),
        owners: checked("owners"),
        warehouses: checked("warehouses"),
        categories: checked("categories"),
      };
    },
  );
  accessEdit.fields = [...document.querySelectorAll("[data-access-field]")].map(
    (el) => {
      const [resource, field] = el
        .querySelector('[name="field_key"]')
        .value.split(":");
      return { resource, field, mode: el.querySelector('[name="mode"]').value };
    },
  );
}
async function accessAction(a, id) {
  if (a === "access-open") {
    const d = await accessLoad();
    modal(
      "權限與組織管理",
      `<p>上下階、操作與資料範圍分開設定。授權僅在本帳套生效。儲存權限會使本帳套所有連線重新登入。</p>${table(
        ["使用者", "基本角色", "上階／部門", ""],
        d.users.map((u) => {
          const p = d.profiles.find((p) => p.user_id === u.id);
          return `<tr><td>${E(u.name)} (${E(u.username)})</td><td>${E(roleNames[u.role])}</td><td>${E(d.users.find((x) => x.id === p?.manager_id)?.name || "無")} / ${E(d.departments.find((x) => x.id === p?.department_id)?.name || "無")}</td><td>${btn("細部授權", "access-profile", u.id, "small")}</td></tr>`;
        }),
      )}<h3>自訂角色</h3>${table(
        ["角色", "說明", ""],
        d.roles.map(
          (r) =>
            `<tr><td>${E(r.name)} ${r.active ? "" : "（停用）"}</td><td>${E(r.description)}</td><td>${btn("編輯", "access-role", r.id, "small")}</td></tr>`,
        ),
      )}${btn("建立角色", "access-role", "", "", "plus")}${btn("有效權限試算", "access-simulate")}`,
      btn("關閉", "close"),
      true,
    );
    return;
  }
  if (a === "access-profile") {
    const d = accessAdmin || (await accessLoad()),
      uid = Number(id),
      u = d.users.find((x) => x.id === uid),
      p = d.profiles.find((x) => x.user_id === uid) || {
        version: 0,
        inherit_base: 1,
        superuser: u.role === "admin" ? 1 : 0,
      };
    modal(
      "細部授權 · " + u.name,
      `<form id="modal-form" data-form="access-profile"><input name="user_id" type="hidden" value="${uid}"><input name="version" type="hidden" value="${p.version}"><div class="form-grid">${selectField(
        "直屬上階",
        "manager_id",
        options(
          d.users.filter((x) => x.id !== uid),
          "name",
          "id",
          p.manager_id,
          "無上階",
        ),
      )}${selectField("部門", "department_id", options(d.departments, "name", "id", p.department_id, "未分部門"))}${selectField("基本角色授權", "inherit_base", `<option value="1" ${p.inherit_base ? "selected" : ""}>繼承基本角色</option><option value="0" ${!p.inherit_base ? "selected" : ""}>僅依自訂角色及個人規則</option>`)}${selectField("完整權限管理員", "superuser", `<option value="0" ${!p.superuser ? "selected" : ""}>套用細部規則</option><option value="1" ${p.superuser ? "selected" : ""}>完整權限（限管理員帳號）</option>`)}</div><h3>附加角色</h3><div id="access-role-choices">${accessChoices(
        d.roles.filter((x) => x.active),
        d.assignments.filter((x) => x.user_id === uid).map((x) => x.role_id),
      )}</div>${accessRuleEditor("user", uid)}</form>`,
      formFooter("儲存並重新登入"),
      true,
    );
    accessRenderRules();
    return;
  }
  if (a === "access-role") {
    const d = accessAdmin || (await accessLoad()),
      r = d.roles.find((x) => x.id === Number(id)) || {
        id: 0,
        version: 0,
        active: 1,
      };
    modal(
      r.id ? "編輯自訂角色" : "建立自訂角色",
      `<form id="modal-form" data-form="access-role"><input type="hidden" name="id" value="${r.id}"><input type="hidden" name="version" value="${r.version}"><div class="form-grid">${field("角色名稱", "name", r.name, "text", 'required maxlength="80"')}${field("說明", "description", r.description, "text", 'maxlength="500"')}${selectField("狀態", "active", `<option value="1" ${r.active ? "selected" : ""}>啟用</option><option value="0" ${!r.active ? "selected" : ""}>停用</option>`)}</div><h3>繼承角色（可複選）</h3><div id="access-parent-choices">${accessChoices(
        d.roles.filter((x) => x.id !== r.id && x.active),
        d.parents.filter((x) => x.role_id === r.id).map((x) => x.parent_id),
      )}</div>${accessRuleEditor("role", r.id)}</form>`,
      formFooter("儲存並重新登入"),
      true,
    );
    accessRenderRules();
    return;
  }
  if (a === "access-simulate") {
    const d = accessAdmin || (await accessLoad());
    modal(
      "有效權限試算",
      `<form id="modal-form" data-form="access-simulate"><div class="form-grid">${selectField("使用者", "user_id", options(d.users, "name", "id"))}${selectField("功能", "resource", d.catalog.map((c) => `<option value="${c.key}">${E(c.label)}</option>`).join(""))}${selectField("動作", "action", d.catalog[0].actions.map((c) => `<option value="${c.key}">${E(c.label)}</option>`).join(""))}</div><p>顯示此功能動作的有效規則。指定單筆資料的 API 試算另支援資料表與 ID。</p></form>`,
      formFooter("試算"),
    );
    return;
  }
  accessCollect();
  if (a === "access-add-rule")
    accessEdit.rules.push({
      resource: "orders",
      action: "read",
      effect: "allow",
      scope: "own",
      owners: [],
      warehouses: [],
      categories: [],
    });
  if (a === "access-remove-rule") accessEdit.rules.splice(Number(id), 1);
  if (a === "access-add-field")
    accessEdit.fields.push({
      resource: "partners",
      field: "phone",
      mode: "readonly",
    });
  if (a === "access-remove-field") accessEdit.fields.splice(Number(id), 1);
  accessRenderRules();
}
async function accessSubmit(kind, b) {
  if (kind === "access-simulate") {
    const r = await api("/api/access/simulate", b);
    modal(
      "有效權限結果",
      `<p>${r.allowed ? "允許" : "拒絕"}：${E(r.reason || "此功能已授權；實際操作另檢查單筆範圍、狀態及會計規則。")}</p><pre style="white-space:pre-wrap">${E(JSON.stringify(r.rules, null, 2))}</pre>`,
      btn("關閉", "close"),
    );
    return;
  }
  accessCollect();
  const checked = (id) =>
    [...document.querySelectorAll("#" + id + " input:checked")].map((x) =>
      Number(x.value),
    );
  const payload = { ...b, rules: accessEdit.rules, fields: accessEdit.fields };
  if (kind === "access-profile") {
    payload.inherit_base = b.inherit_base === "1";
    payload.superuser = b.superuser === "1";
    payload.role_ids = checked("access-role-choices");
  } else {
    if (!Number(b.id)) delete payload.id;
    payload.active = b.active === "1";
    payload.parent_ids = checked("access-parent-choices");
  }
  await api(
    kind === "access-profile" ? "/api/access/profiles" : "/api/access/roles",
    payload,
  );
  closeModal();
  S.data = null;
  S.csrf = "";
  await init();
  toast("權限已儲存，請重新登入");
}
function accessCan(resource, action) {
  const p = S.data?.access_effective;
  if (!p?.configured || p.superuser) return true;
  const rules =
    p.resources.find((r) => r.key === resource)?.grants[action] || [];
  return (
    rules.some((r) => r.effect === "allow" && r.scope !== "none") &&
    !rules.some((r) => r.effect === "deny" && r.scope === "all")
  );
}
function accessButtonAllowed(action, id) {
  if (action === "doc-action")
    return accessCan(
      { quote: "quotes", order: "orders", purchase: "purchases" }[
        S.docDetail?.kind
      ] || "orders",
      id === "convert" ? "post" : id,
    );
  if (action === "fulfil-form")
    return accessCan(
      S.docDetail?.kind === "purchase" ? "purchases" : "orders",
      "post",
    );
  if (action === "order-purchase-form")
    return accessCan("orders", "post") && accessCan("purchases", "create");
  if (action === "completion-stock-action")
    return accessCan(
      "inventory",
      id === "approve" ? "approve" : id === "cancel" ? "cancel" : "post",
    );
  if (action === "completion-form") {
    const forms = {
      "stock-document": ["inventory", "create"],
      category: ["products", "create"],
      "custom-field": ["products", "create"],
      "product-attributes": ["products", "update"],
      "opening-fund": ["payments", "create"],
      closing: ["system", "update"],
      "replenishment-policy": ["purchases", "create"],
      replenish: ["purchases", "create"],
      "count-file": ["counts", "import"],
      "count-preview": ["counts", "read"],
      "count-rebase": ["counts", "approve"],
      disassemble: ["work", "post"],
      "kit-sale": ["orders", "create"],
      "partial-release": ["orders", "post"],
      settlement: ["payments", "create"],
      "payment-reversal": ["payments", "reverse"],
      "invoice-link": ["invoices", "create"],
      assign: ["partners", "assign"],
      standards: ["costs", "create"],
      "cost-policy": ["system", "create"],
      "monthly-cost-preview": ["costs", "create"],
      "cost-batch": ["products", "import"],
      history: ["partners", "read"],
      "stock-history": ["inventory", "read"],
      aging: ["billing", "read"],
      matrix: ["reports", "read"],
    };
    if (id === "preferences") return true;
    return !forms[id] || accessCan(...forms[id]);
  }
  if (action === "v3-report-export") return accessCan("reports", "export");
  const explicit = {
    "product-form": ["products", id ? "update" : "create"],
    "partner-form": ["partners", id ? "update" : "create"],
    "activity-form": ["partners", "create"],
    "warehouse-form": ["warehouses", "create"],
    "new-order": ["orders", "create"],
    "new-quote": ["quotes", "create"],
    "new-purchase": ["purchases", "create"],
    "adjust-form": ["inventory", "create"],
    "transfer-form": ["inventory", "post"],
    "count-create": ["counts", "create"],
    "count-post": ["counts", "post"],
    "count-cancel": ["counts", "cancel"],
    "work-form": ["work", "create"],
    "work-complete": ["work", "post"],
    "loan-form": ["inventory", "create"],
    "loan-return": ["inventory", "reverse"],
    "pay-form": ["payments", "create"],
    "return-form": ["fulfilments", "reverse"],
  };
  let pair = explicit[action];
  if (
    [
      "edit-doc",
      "submit-doc",
      "approve-doc",
      "reject-doc",
      "cancel-doc",
      "fulfil-doc",
      "convert-doc",
      "purchase-doc",
    ].includes(action)
  ) {
    const doc =
      S.docDetail || S.data?.documents?.find((d) => d.id === Number(id));
    pair = [
      { quote: "quotes", purchase: "purchases", order: "orders" }[doc?.kind] ||
        "orders",
      {
        "edit-doc": "update",
        "submit-doc": "submit",
        "approve-doc": "approve",
        "reject-doc": "approve",
        "cancel-doc": "cancel",
        "fulfil-doc": "post",
        "convert-doc": "post",
        "purchase-doc": "post",
      }[action],
    ];
  }
  return !pair || accessCan(...pair);
}
function applyAccessForm() {
  const p = S.data?.access_effective;
  if (!p?.configured || p.superuser) return;
  const form = document.querySelector("#modal-root form");
  if (!form) return;
  const kind = form.dataset.form,
    resource =
      kind === "partner"
        ? "partners"
        : kind === "product"
          ? "products"
          : form.id === "doc-form"
            ? { quote: "quotes", purchase: "purchases", order: "orders" }[
                S.docDraft?.kind
              ]
            : null;
  if (!resource) return;
  const modes = p.resources.find((r) => r.key === resource)?.field_modes || {};
  for (const [key, mode] of Object.entries(modes)) {
    if (mode === "edit") continue;
    for (const input of form.querySelectorAll(
      `[name="${key === "discount_bp" ? "discount" : key}"], [data-key="${key}"]`,
    )) {
      if (mode === "hidden") {
        input.closest(".field")?.setAttribute("hidden", "");
        input.disabled = true;
      } else {
        input.readOnly = true;
        if (input.tagName === "SELECT") input.disabled = true;
        input.title = "此欄位由管理員設定為唯讀";
      }
    }
  }
}
