let EN = { cache: {}, pending: {}, key: "", form: null, entity: null };
const enNames = {
  wms: "儲位、上架與波次",
  fx: "外幣帳款與評價",
  delivery: "預設版型與寄送",
  hr: "出勤、請假與薪資",
  production: "物料與製造排程",
};
const enStates = {
  draft: "草稿",
  preview: "待確認",
  released: "已發放",
  posted: "已過帳",
  completed: "已完成",
  cancelled: "已取消",
  settled: "已結清",
  queued: "待寄送",
  retry: "等待重試",
  sending: "寄送中",
  sent: "已寄出",
  failed: "失敗",
  uncertain: "結果待核對",
  demo: "展示預覽",
  approved: "已核准",
  pending: "待核准",
  rejected: "已駁回",
  outside: "委外保管中",
  committed: "已建立單據",
  reversed: "已沖回",
};
function enKey() {
  return (S.company || "default") + ":" + S.data?.user.id;
}
async function enApi(path, body) {
  const key = enKey(),
    r = await api("/api/enterprise/" + path, body);
  if (key !== enKey()) throw Error("帳套或帳號已切換，請重新開啟作業");
  return r;
}
async function enLoad(domain) {
  const key = enKey();
  if (EN.pending[domain]) return EN.pending[domain];
  const task = (async () => {
    try {
      const r = await enApi(domain);
      if (key !== enKey()) return;
      EN.cache[domain] = r;
    } catch (e) {
      if (key === enKey()) EN.cache[domain] = { error: e.message };
    } finally {
      if (key === enKey()) {
        EN.pending[domain] = null;
        if (S.page === "enterprise") render();
      }
    }
  })();
  EN.pending[domain] = task;
  return task;
}
function enAllowed(r, a = "read") {
  return !!S.data.enterprise_access?.[r]?.[a];
}
function enBtn(label, domain, op, id = "", cls = "small") {
  return btn(label, "ent-command", [domain, op, id].join("|"), cls);
}
function enOpenButton(domain, id) {
  return btn("開啟", "ent-open", domain + "|" + id, "small");
}
function enStatus(s) {
  return E(enStates[s] || s);
}
function enterprisePage() {
  if (EN.key !== enKey())
    EN = { cache: {}, pending: {}, key: enKey(), form: null, entity: null };
  const available = Object.keys(enNames).filter(
      (k) => S.data.enterprise_permissions?.[k],
    ),
    domain = available.includes(S.tab) ? S.tab : available[0];
  if (!domain) return head("倉儲與企業作業", "此帳號沒有可檢視的作業。");
  const d = EN.cache[domain];
  if (!d) {
    enLoad(domain);
    return (
      head("倉儲與企業作業", "正在取得目前帳套資料…") +
      tabBar(
        available.map((k) => [k, enNames[k]]),
        domain,
      )
    );
  }
  const body = d.error
    ? `<p role="alert">${E(d.error)}</p>`
    : domain === "wms"
      ? enWms(d)
      : domain === "fx"
        ? enFx(d)
        : domain === "delivery"
          ? enDelivery(d)
          : domain === "hr"
            ? enHr(d)
            : enProduction(d);
  return (
    head(
      "倉儲與企業作業",
      "各項作業使用目前公司的帳套與權限。",
      btn("重新整理", "ent-refresh", domain),
      "ENTERPRISE OPERATIONS",
    ) +
    tabBar(
      available.map((k) => [k, enNames[k]]),
      domain,
    ) +
    `<div class="enterprise-workspace">${body}</div>`
  );
}
function enWms(d) {
  return (
    `<div class="fd-actions">${S.data.enterprise_admin ? enBtn("啟用倉庫儲位", "wms", "enable", "", "primary") : ""}${enAllowed("storage_bins", "create") ? enBtn("新增儲位", "wms", "bin") + enBtn("設定上架規則", "wms", "rule") + enBtn("設定補揀", "wms", "replenishment") : ""}${enAllowed("storage_bins", "post") ? enBtn("移位／規則上架", "wms", "transfer") + enBtn("執行補揀", "wms", "replenish") : ""}${enAllowed("warehouse_waves", "create") ? enBtn("建立波次", "wms", "wave") : ""}</div><p>啟用後既有庫存移入收貨區，後續庫存異動同步保存儲位流水。波次只從揀貨區配置；不足時先補揀，再重新分配。</p>` +
    panel(
      "儲位與庫存",
      table(
        ["倉庫／儲位", "類型", "商品／批號", "現有量", "波次預留"],
        (d.balances || [])
          .filter((b) => b.qty || b.reserved)
          .map((b) => {
            const bin = d.bins.find((x) => x.id === b.bin_id),
              p = S.data.products.find((x) => x.id === b.product_id);
            return `<tr><td>${E(S.data.warehouses.find((w) => w.id === bin?.warehouse_id)?.name)} / ${E(bin?.code)}</td><td>${E({ receiving: "收貨", pick: "揀貨", storage: "存放", shipping: "出貨", blocked: "凍結" }[bin?.kind])}</td><td>${E(p?.sku)} ${E(p?.name)}<small>${E(b.lot_code)}</small></td><td>${Q(b.qty)}</td><td>${Q(b.reserved)}</td></tr>`;
          }),
      ),
    ) +
    panel(
      "儲位設定",
      table(
        ["代號", "名稱", "容量（基本量合計）", "修訂", ""],
        d.bins.map(
          (b) =>
            `<tr><td>${E(b.code)}</td><td>${E(b.name)}</td><td>${b.capacity_qty ? Q(b.capacity_qty) : "不限"}</td><td>${b.version}</td><td>${enAllowed("storage_bins", "update") ? enBtn("編輯", "wms", "bin", b.id) : ""}</td></tr>`,
        ),
      ),
    ) +
    panel(
      "波次",
      table(
        ["單號", "狀態", "修訂", ""],
        d.waves.map(
          (w) =>
            `<tr><td>${E(w.no)}</td><td>${enStatus(w.status)}</td><td>${w.version}</td><td>${enOpenButton("wms", w.id)}</td></tr>`,
        ),
      ),
    )
  );
}
function enFx(d) {
  return (
    `<div class="fd-actions">${S.data.enterprise_admin ? enBtn("登錄匯率", "fx", "rate") + enBtn("新增幣別", "fx", "currency") : ""}${enAllowed("foreign_accounts", "create") ? enBtn("建立外幣憑證", "fx", "create", "", "primary") : ""}${enAllowed("foreign_accounts", "post") ? enBtn("期末評價", "fx", "valuation") : ""}</div><p>本位幣為 TWD。外幣收入／費用憑證獨立立帳、收付及評價；存貨交易及既有應收付請沿用原流程，避免重複立帳。</p>` +
    panel(
      "外幣帳款",
      table(
        ["單號", "幣別", "原幣金額", "原幣未結", "帳面餘額 TWD", "狀態", ""],
        d.accounts.map(
          (a) =>
            `<tr><td>${E(a.no)}</td><td>${E(a.currency)}</td><td>${E((a.foreign_amount / 10 ** a.precision).toFixed(a.precision))}</td><td>${E(((a.foreign_amount - a.foreign_paid) / 10 ** a.precision).toFixed(a.precision))}</td><td>${money(a.book_value, true)}</td><td>${enStatus(a.status)}</td><td>${enOpenButton("fx", a.id)}</td></tr>`,
        ),
      ),
    ) +
    panel(
      "匯率來源",
      table(
        ["幣別", "報價日", "TWD／原幣", "來源"],
        d.rates.map(
          (r) =>
            `<tr><td>${E(r.currency)}</td><td>${E(r.date)}</td><td>${E(String(r.rate / 1e6))}</td><td>${E(r.source)}</td></tr>`,
        ),
      ),
    ) +
    panel(
      "評價紀錄",
      table(
        ["單號", "日期", "狀態", ""],
        d.valuations.map(
          (v) =>
            `<tr><td>${E(v.no)}</td><td>${E(v.date)}</td><td>${enStatus(v.status)}</td><td>${v.status === "posted" && enAllowed("foreign_accounts", "reverse") ? enBtn("沖回", "fx", "reverse-valuation", v.id) : ""}</td></tr>`,
        ),
      ),
    )
  );
}
function enDelivery(d) {
  return (
    `<div class="fd-actions">${S.data.enterprise_admin ? enBtn("寄件設定", "delivery", "configure") + enBtn("客戶／語系預設版型", "delivery", "defaults") : ""}${enAllowed("document_outbox", "create") ? enBtn("建立寄送工作", "delivery", "queue", "", "primary") : ""}</div><p>${d.demo ? "展示模式只保存可操作的排程與預覽，不會寄出郵件。" : "使用已核准單據或已送出表單建立寄送工作；背景服務會在寄送前重新驗證授權及來源。"}表單以 HTML 附件寄送，可另附 PDF、圖片或文字，合計最多 1 MB。</p>` +
    panel(
      "預設版型",
      table(
        ["來源", "往來對象", "語系", "版型"],
        d.defaults.map(
          (r) =>
            `<tr><td>${E(kindNames[r.kind])}</td><td>${E(S.data.partners.find((p) => p.id === r.partner_id)?.name || "公司通用")}</td><td>${E(r.locale || "不限")}</td><td>${E(S.data.form_templates.find((t) => t.id === r.template_id)?.name || r.template_id)}</td></tr>`,
        ),
      ),
    ) +
    panel(
      "寄送紀錄",
      table(
        ["建立時間", "收件人", "主旨", "狀態", "嘗試次數", ""],
        d.outbox.map(
          (r) =>
            `<tr><td>${E(r.created_at)}</td><td>${E(r.recipient)}</td><td>${E(r.subject)}</td><td>${enStatus(r.status)}</td><td>${r.attempts}</td><td>${enOpenButton("delivery", r.id)}</td></tr>`,
        ),
      ),
    )
  );
}
function enHr(d) {
  const can = enAllowed("payroll_runs", "read") || d.runs?.length;
  return (
    `<div class="fd-actions">${S.data.enterprise_admin ? enBtn("臺灣薪資規則", "hr", "configure") + enBtn("工作日／休假日", "hr", "calendar") + enBtn("請假額度", "hr", "leave-balance") : ""}${enBtn("登錄出勤", "hr", "attendance") + enBtn("提出請假", "hr", "leave")}${enAllowed("payroll_runs", "update") ? enBtn("薪資條件", "hr", "terms") + enBtn("扣繳與匯款資料", "hr", "profile") : ""}${enAllowed("payroll_runs", "create") ? enBtn("建立月份薪資", "hr", "compute", "", "primary") : ""}</div><p>先於「聯絡與組織」建立員工並綁定登入帳號。出勤與請假依核准紀錄計算；投保金額、扣繳門檻及法定規則需由公司核對後保存，申報及實際匯款另依正式作業處理。</p>` +
    panel(
      "出勤",
      table(
        ["員工", "日期", "正常／加班分鐘", "狀態", ""],
        d.attendance.map(
          (a) =>
            `<tr><td>${E(d.employees?.find((e) => e.id === a.employee_id)?.name || a.employee_id)}</td><td>${E(a.date)}</td><td>${a.normal_minutes} / ${a.overtime_minutes}</td><td>${enStatus(a.status)}</td><td>${a.status === "pending" ? enBtn("核准／駁回", "hr", "decide", "attendance:" + a.id) : ""}${["pending", "approved"].includes(a.status) ? enBtn("取消", "hr", "decide-cancel", "attendance:" + a.id) : ""}</td></tr>`,
        ),
      ),
    ) +
    panel(
      "請假",
      table(
        ["員工", "日期", "假別／分鐘", "狀態", ""],
        d.leave.map(
          (a) =>
            `<tr><td>${E(d.employees?.find((e) => e.id === a.employee_id)?.name || a.employee_id)}</td><td>${E(a.date)}</td><td>${E(a.kind)} / ${a.end_minute - a.start_minute}</td><td>${enStatus(a.status)}</td><td>${a.status === "pending" ? enBtn("核准／駁回", "hr", "decide", "leave:" + a.id) : ""}${["pending", "approved"].includes(a.status) ? enBtn("取消", "hr", "decide-cancel", "leave:" + a.id) : ""}</td></tr>`,
        ),
      ),
    ) +
    (can
      ? panel(
          "薪資月份",
          table(
            ["單號", "月份", "狀態", ""],
            (d.runs || []).map(
              (r) =>
                `<tr><td>${E(r.no)}</td><td>${E(r.period)}</td><td>${enStatus(r.status)}</td><td>${enOpenButton("hr", r.id)}</td></tr>`,
            ),
          ),
        )
      : "")
  );
}
function enProduction(d) {
  return (
    `<div class="fd-actions">${enAllowed("production_routes", "create") ? enBtn("多階 BOM", "production", "bom") + enBtn("工作中心", "production", "center") + enBtn("產能行事曆", "production", "calendar") + enBtn("工藝路線", "production", "route") : ""}${enAllowed("production_jobs", "create") ? enBtn("建立製造工單", "production", "create", "", "primary") : ""}${enAllowed("mrp_plans", "create") ? enBtn("計算物料需求", "production", "preview") : ""}</div><p>工單凍結 BOM 與工藝路線；發放預留材料，領料轉在製，全部工序完成後依實際材料及加工費入庫。委外加工使用一般採購核准、進貨與付款管制。</p>` +
    panel(
      "製造工單",
      table(
        ["單號", "商品", "基本量", "開始／預計完成", "需求交期", "狀態", ""],
        d.jobs.map(
          (j) =>
            `<tr><td>${E(j.no)}</td><td>${E(S.data.products.find((p) => p.id === j.product_id)?.sku || j.product_id)}</td><td>${Q(j.qty)}</td><td>${E(j.start_date)} / ${E(j.end_date)}</td><td>${E(j.due_date)}</td><td>${enStatus(j.status)}</td><td>${enOpenButton("production", j.id)}</td></tr>`,
        ),
      ),
    ) +
    panel(
      "物料需求計畫",
      table(
        ["計畫", "狀態", "建議數", ""],
        d.plans.map(
          (p) =>
            `<tr><td>${E(p.no)}</td><td>${enStatus(p.status)}</td><td>${JSON.parse(p.result).length}</td><td>${enBtn("檢視建議", "production", "plan-open", p.id)}</td></tr>`,
        ),
      ),
    ) +
    panel(
      "工作中心",
      table(
        ["代號", "名稱", "每日可用分鐘"],
        d.centers.map(
          (c) =>
            `<tr><td>${E(c.code)}</td><td>${E(c.name)}</td><td>${c.daily_minutes}</td></tr>`,
        ),
      ),
    )
  );
}
const enField = (
  key,
  label,
  value = "",
  type = "text",
  choices = null,
  extra = {},
) => ({ key, label, value, type, choices, ...extra });
function enOptions(items, label = "name", blank = "請選擇") {
  return [
    ["", blank],
    ...items.map((x) => [
      String(x.id ?? x.code),
      typeof label === "function" ? label(x) : x[label],
    ]),
  ];
}
function enControl(f, name = f.key, value = f.value) {
  const attrs =
    f.type === "number" ? `step="${f.step || "0.01"}" min="${f.min ?? 0}"` : "";
  if (f.choices)
    return selectField(
      f.label,
      name,
      f.choices
        .map(
          ([k, n]) =>
            `<option value="${E(k)}" ${String(k) === String(value) ? "selected" : ""}>${E(n)}</option>`,
        )
        .join(""),
    );
  if (f.type === "textarea") return textarea(f.label, name, value);
  return field(
    f.label,
    name,
    value,
    f.type,
    `${attrs} ${f.optional ? "" : "required"}`,
  );
}
function enReadRows() {
  if (!EN.form?.group) return [];
  const f = document.querySelector("#modal-form");
  if (!f) return EN.form.group.rows;
  const values = Object.fromEntries(new FormData(f));
  return EN.form.group.rows.map((row, i) =>
    Object.fromEntries(
      EN.form.group.fields.map((x) => [
        x.key,
        values["r_" + i + "_" + x.key] ?? row[x.key] ?? x.value,
      ]),
    ),
  );
}
function enRenderRows() {
  const g = EN.form.group;
  if (!g) return;
  $("#ent-rows").innerHTML = table(
    [...g.fields.map((f) => f.label), ""],
    g.rows.map(
      (r, i) =>
        `<tr>${g.fields.map((f) => `<td>${enControl({ ...f, label: f.label + " " + (i + 1) }, "r_" + i + "_" + f.key, r[f.key] ?? f.value)}</td>`).join("")}<td>${btn("移除", "ent-row-remove", i, "small")}</td></tr>`,
    ),
  );
}
function enForm(
  title,
  domain,
  op,
  fields = [],
  { body = {}, group = null, checks = null, files = false, help = "" } = {},
) {
  EN.form = { domain, op, fields, body, group, checks };
  modal(
    title,
    `<form id="modal-form" data-form="ent-form"><div class="form-grid">${fields.map((f) => enControl(f)).join("")}</div>${checks ? `<fieldset><legend>${E(checks.label)}</legend>${checks.items.map((x) => `<label class="ent-check"><input type="checkbox" data-ent-selected value="${E(x[0])}">${E(x[1])}</label>`).join("")}</fieldset>` : ""}${group ? `<div class="enterprise-rows"><h3>${E(group.label)}</h3><div id="ent-rows"></div>${btn("新增一列", "ent-row-add", "", "small")}</div>` : ""}${files ? '<label for="ent-attachments">額外附件</label><input id="ent-attachments" type="file" multiple accept="application/pdf,image/png,image/jpeg,text/plain">' : ""}${help ? `<p>${E(help)}</p>` : !fields.length && !group && !checks ? `<p>${E(EN.entity?.id === body.id ? EN.entity.no || "" : "")} · ${E(title)}</p>` : ""}</form>`,
    formFooter("儲存／執行"),
    true,
  );
  enRenderRows();
}
async function enterpriseAction(action, id) {
  if (action === "ent-export") {
    const r = await enApi("hr/export?id=" + id),
      u = URL.createObjectURL(
        new Blob([r.csv], { type: "text/csv;charset=utf-8" }),
      ),
      a = document.createElement("a");
    a.href = u;
    a.download = r.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
    return;
  }
  if (action === "ent-refresh") {
    delete EN.cache[id];
    await enLoad(id);
    return;
  }
  if (action === "ent-row-add") {
    EN.form.group.rows = enReadRows();
    if (EN.form.group.rows.length >= 100) throw Error("最多 100 列");
    EN.form.group.rows.push({});
    enRenderRows();
    return;
  }
  if (action === "ent-row-remove") {
    EN.form.group.rows = enReadRows();
    EN.form.group.rows.splice(Number(id), 1);
    enRenderRows();
    return;
  }
  if (action === "ent-open") {
    const [domain, rid] = id.split("|");
    await enDetail(domain, rid);
    return;
  }
  const [domain, op, rid] = id.split("|"),
    d = EN.cache[domain] || {},
    F = enField,
    P = enOptions(S.data.products, (p) => p.sku + " · " + p.name),
    W = enOptions(S.data.warehouses),
    partners = enOptions(S.data.partners, (p) => p.code + " · " + p.name),
    B = enOptions(d.bins || [], (x) => x.code + " · " + x.name),
    employees = enOptions(d.employees || [], (x) => x.code + " · " + x.name),
    bool = [
      ["false", "否"],
      ["true", "是"],
    ],
    date = S.data.today;
  if (domain === "wms") {
    if (op === "enable") {
      enForm(
        "啟用倉庫儲位",
        "wms",
        op,
        [F("warehouse_id", "倉庫", "", "select", W)],
        {
          body: { version: 0 },
          help: "會依目前庫存與批號建立收貨區期初儲位流水，原庫存及帳務不變。",
        },
      );
      return;
    }
    if (op === "bin") {
      const r = d.bins.find((x) => x.id === Number(rid)) || {};
      enForm(
        "儲位設定",
        domain,
        op,
        [
          F("warehouse_id", "倉庫", r.warehouse_id || "", "select", W),
          F("code", "代號", r.code),
          F("name", "名稱", r.name),
          F("kind", "類型", r.kind || "storage", "select", [
            ["receiving", "收貨"],
            ["storage", "存放"],
            ["pick", "揀貨"],
            ["shipping", "出貨"],
            ["blocked", "凍結"],
          ]),
          F("priority", "優先順序", r.priority ?? 100, "number", null, {
            step: "1",
            integer: true,
          }),
          F(
            "capacity_qty",
            "容量基本量（0 不限）",
            inputQty(r.capacity_qty || 0),
            "number",
            null,
            { step: "0.001" },
          ),
          F(
            "active",
            "啟用",
            r.active !== 0 ? "true" : "false",
            "select",
            bool,
            { boolean: true },
          ),
        ],
        { body: r.id ? { id: r.id, version: r.version } : {} },
      );
      return;
    }
    if (op === "transfer") {
      enForm("移位／依規則上架", domain, op, [
        F("from_bin_id", "來源儲位", "", "select", B),
        F("to_bin_id", "目的儲位（留白按規則）", "", "select", [
          ["", "依規則自動上架"],
          ...B.slice(1),
        ]),
        F("product_id", "商品", "", "select", P),
        F("lot_code", "批號／序號（無則留白）", "", "text", null, {
          optional: true,
        }),
        F("qty", "基本數量", "1", "number", null, { step: "0.001" }),
        F("reason", "原因", "", "textarea"),
      ]);
      return;
    }
    if (op === "rule") {
      enForm("上架規則", domain, op, [
        F("bin_id", "目的儲位", "", "select", B),
        F("product_id", "指定商品（可不指定）", "", "select", [
          ["", "不限商品"],
          ...P.slice(1),
        ]),
        F("category", "指定分類（可留白）", "", "text", null, {
          optional: true,
        }),
        F("priority", "優先順序", 100, "number", null, {
          step: "1",
          integer: true,
        }),
      ]);
      return;
    }
    if (op === "replenishment") {
      enForm(
        "設定補揀",
        domain,
        op,
        [
          F("bin_id", "揀貨儲位", "", "select", B),
          F("product_id", "商品", "", "select", P),
          F("min_qty", "最低基本量", "1", "number", null, { step: "0.001" }),
          F("target_qty", "補足到基本量", "10", "number", null, {
            step: "0.001",
          }),
        ],
        { body: { version: 0 } },
      );
      return;
    }
    if (op === "replenish") {
      enForm("執行補揀", domain, op, [
        F("bin_id", "揀貨儲位", "", "select", B),
        F("product_id", "商品", "", "select", P),
        F("reason", "原因", "補揀作業"),
      ]);
      return;
    }
    if (op === "wave") {
      enForm(
        "建立儲位波次",
        domain,
        op,
        [
          F("warehouse_id", "倉庫", "", "select", W),
          F("notes", "說明", "", "textarea", null, { optional: true }),
        ],
        {
          checks: {
            key: "document_ids",
            label: "選擇同倉未交訂單",
            items: S.data.documents
              .filter(
                (x) =>
                  x.kind === "order" &&
                  ["approved", "partial"].includes(x.status),
              )
              .map((x) => [x.id, x.no + " · " + x.partner_name]),
          },
        },
      );
      return;
    }
    const r = await enApi("wms/detail?id=" + rid);
    enForm(
      enNames.wms +
        " · " +
        (op === "post"
          ? "波次出貨"
          : op === "cancel"
            ? "取消波次"
            : "重新分配"),
      domain,
      op,
      [...(op === "cancel" ? [F("reason", "原因", "", "textarea")] : [])],
      {
        body: { id: r.id, version: r.version },
        group:
          op === "post"
            ? {
                key: "quality_inspections",
                label: "有品檢管制的來源請選放行單",
                fields: [
                  F(
                    "document_id",
                    "來源訂單",
                    "",
                    "select",
                    enOptions([
                      ...new Map(
                        r.lines.map((l) => [
                          l.document_id,
                          { id: l.document_id, name: l.document_no },
                        ]),
                      ).values(),
                    ]),
                  ),
                  F("inspection_id", "放行單", "", "select", [
                    ["", "無品檢管制"],
                    ...(S.data.quality_inspections || [])
                      .filter((q) => q.postable)
                      .map((q) => [q.id, q.no]),
                  ]),
                ],
                rows: [],
              }
            : null,
      },
    );
    return;
  }
  if (domain === "fx") {
    const C = d.currencies.map((c) => [c.code, c.code + " · " + c.name]),
      A = d.gl_accounts.map((a) => [a.code, a.code + " " + a.name]),
      banks = enOptions(d.banks || []);
    if (op === "rate") {
      enForm(
        "登錄匯率",
        domain,
        op,
        [
          F("currency", "幣別", "USD", "select", C),
          F("date", "報價日", date, "date"),
          F("rate", "1 原幣換 TWD", "", "number", null, { step: "0.000001" }),
          F("source", "報價來源及核對說明", "", "textarea"),
        ],
        { body: { version: 0 } },
      );
      return;
    }
    if (op === "currency") {
      enForm("新增幣別", domain, op, [
        F("code", "ISO 三碼代號"),
        F("name", "幣別名稱"),
        F("precision", "原幣小數位", 2, "number", null, {
          step: "1",
          integer: true,
        }),
      ]);
      return;
    }
    if (op === "create") {
      enForm(
        "建立外幣收入／費用憑證",
        domain,
        op,
        [
          F("kind", "應收／應付", "receivable", "select", [
            ["receivable", "應收"],
            ["payable", "應付"],
          ]),
          F("partner_id", "往來對象", "", "select", partners),
          F("currency", "幣別", "USD", "select", C),
          F("date", "日期", date, "date"),
          F("due_date", "到期日", date, "date"),
          F("notes", "說明", "", "textarea", null, { optional: true }),
        ],
        {
          group: {
            key: "lines",
            label: "原幣憑證明細",
            fields: [
              F("account", "收入／費用科目", "", "select", [
                ["", "請選擇"],
                ...A,
              ]),
              F("description", "摘要"),
              F("amount", "原幣金額", "", "number", null, { step: "0.001" }),
            ],
            rows: [{}],
          },
          help: "日期須已有登錄匯率。本流程不代替商品進出貨或既有應收付帳款。",
        },
      );
      return;
    }
    if (op === "valuation") {
      enForm("期末匯率評價", domain, op, [F("date", "評價日", date, "date")], {
        checks: {
          key: "account_ids",
          label: "選擇未結帳款",
          items: d.accounts
            .filter((a) => a.status === "posted")
            .map((a) => [a.id, a.no + " · " + a.currency]),
        },
      });
      return;
    }
    if (op === "reverse-valuation") {
      enForm(
        "沖回期末評價",
        domain,
        op,
        [
          F("date", "沖回日期", date, "date"),
          F("reason", "原因", "", "textarea"),
        ],
        { body: { valuation_id: Number(rid) } },
      );
      return;
    }
    if (op === "reverse") {
      const r = EN.entity;
      enForm(
        "沖回外幣收付",
        domain,
        op,
        [
          F("date", "沖回日期", date, "date"),
          F("reason", "原因", "", "textarea"),
        ],
        { body: { settlement_id: Number(rid), version: r.version } },
      );
      return;
    }
    const r = await enApi("fx/detail?id=" + rid);
    enForm(
      op === "settle"
        ? "外幣收付"
        : op === "cancel"
          ? "取消草稿"
          : "外幣憑證立帳",
      domain,
      op,
      op === "settle"
        ? [
            F(
              "amount",
              "收付原幣金額",
              String((r.foreign_amount - r.foreign_paid) / 10 ** r.precision),
              "number",
              null,
              { step: String(1 / 10 ** r.precision) },
            ),
            F("date", "收付日期", date, "date"),
            F("bank_account_id", "TWD 收付帳戶", "", "select", banks),
          ]
        : op === "cancel"
          ? [F("reason", "原因", "", "textarea")]
          : [],
      { body: { id: r.id, version: r.version } },
    );
    return;
  }
  if (domain === "delivery") {
    if (op === "configure") {
      const p = d.policy || {};
      enForm(
        "寄件服務設定",
        domain,
        op,
        [
          F(
            "enabled",
            "啟用背景寄送",
            p.enabled ? "true" : "false",
            "select",
            bool,
            { boolean: true },
          ),
          F("from", "寄件信箱", p.from || "", "email"),
          F("display_name", "寄件顯示名稱", p.display_name || ""),
        ],
        {
          body: { version: p.version || 0 },
          help: "正式主機須設定 SMTP 連線及啟動背景服務。展示版只保存預覽。",
        },
      );
      return;
    }
    if (op === "defaults") {
      enForm(
        "客戶／語系預設版型",
        domain,
        op,
        [
          F("kind", "來源類型", "quote", "select", Object.entries(kindNames)),
          F("partner_id", "往來對象", "", "select", [
            ["", "公司通用"],
            ...partners.slice(1),
          ]),
          F("locale", "語系（可留白）", "zh-TW", "text", null, {
            optional: true,
          }),
          F(
            "template_id",
            "版型",
            "",
            "select",
            enOptions(
              S.data.form_templates.filter(
                (t) => t.active && t.kind !== "free",
              ),
              (t) => kindNames[t.kind] + " · " + t.name,
            ),
          ),
          F(
            "set_partner_language",
            "設為對象偏好語系",
            "true",
            "select",
            bool,
            { boolean: true },
          ),
        ],
        { body: { version: 0 } },
      );
      return;
    }
    if (op === "queue") {
      enForm(
        "建立文件寄送工作",
        domain,
        op,
        [
          F(
            "document_id",
            "來源交易（與表單擇一）",
            "",
            "select",
            enOptions(
              S.data.documents.filter((x) =>
                [
                  "approved",
                  "partial",
                  "completed",
                  "closed",
                  "converted",
                ].includes(x.status),
              ),
              (x) => x.no + " · " + x.partner_name,
            ),
          ),
          F(
            "entry_id",
            "已送出獨立表單",
            "",
            "select",
            enOptions(
              S.data.form_entries.filter((x) => x.status === "submitted"),
              (x) => x.no + " · " + x.title,
            ),
          ),
          F("template_id", "交易版型", "", "select", [
            ["", "依客戶／語系預設"],
            ...enOptions(
              S.data.form_templates.filter(
                (x) => x.active && x.kind !== "free",
              ),
            ).slice(1),
          ]),
          F("locale", "語系（留白依對象）", "", "text", null, {
            optional: true,
          }),
          F("recipient", "收件信箱", "", "email"),
          F("subject", "主旨"),
          F("text", "郵件內容", "", "textarea", null, { optional: true }),
        ],
        { files: true },
      );
      return;
    }
    const r = await enApi("delivery/detail?id=" + rid);
    enForm(
      "處理寄送工作",
      domain,
      "action",
      [
        F("action", "動作", "cancel", "select", [
          ["cancel", "取消"],
          ["retry", "重新排程"],
        ]),
        F("reason", "原因", "", "textarea"),
        F(
          "confirm_possible_duplicate",
          "已核對服務商並接受可能重複寄送",
          "false",
          "select",
          bool,
          { boolean: true },
        ),
      ],
      { body: { id: r.id, version: r.version } },
    );
    return;
  }
  if (domain === "hr") {
    if (op === "configure") {
      const p = d.template;
      enForm(
        "核定臺灣薪資規則",
        domain,
        op,
        [
          F("effective_date", "生效日期", date, "date"),
          F("source", "官方來源與公司核對說明", "", "textarea"),
          F("min_monthly", "最低月薪", p.min_monthly, "number"),
          F("min_hourly", "最低時薪", p.min_hourly, "number"),
          ...[
            "labor_bp",
            "labor_employee_bp",
            "labor_employer_bp",
            "health_bp",
            "health_employee_bp",
            "health_employer_bp",
            "health_average_dependents_bp",
            "employer_pension_bp",
            "occupational_bp",
          ].map((k) =>
            F(
              k,
              {
                labor_bp: "勞保與就保合計費率",
                labor_employee_bp: "勞就保員工分擔",
                labor_employer_bp: "勞就保雇主分擔",
                health_bp: "健保費率",
                health_employee_bp: "健保員工分擔",
                health_employer_bp: "健保雇主分擔",
                health_average_dependents_bp: "雇主平均眷口",
                employer_pension_bp: "雇主退休金提繳",
                occupational_bp: "職災雇主費率",
              }[k] + "（基點）",
              p[k],
              "number",
              null,
              { step: "1", integer: true },
            ),
          ),
          F("forbid_self_approval", "禁止自行核准", "true", "select", bool, {
            boolean: true,
          }),
          F("confirm_rules", "已核對適用規則及級距", "false", "select", bool, {
            boolean: true,
          }),
        ],
        {
          group: {
            key: "leave_types",
            label: "假別與工資比例",
            fields: [
              F("key", "代號"),
              F("label", "名稱"),
              F("paid_bp", "給薪基點", 10000, "number", null, {
                step: "1",
                integer: true,
              }),
              F("quota", "檢查額度", "true", "select", bool, { boolean: true }),
            ],
            rows: p.leave_types,
          },
        },
      );
      return;
    }
    if (op === "calendar") {
      enForm(
        "工作日／休假日",
        domain,
        op,
        [
          F("date", "日期", date, "date"),
          F("kind", "日別", "holiday", "select", [
            ["work", "工作日"],
            ["rest", "休息日"],
            ["holiday", "國定／公司假日"],
          ]),
          F("name", "名稱"),
        ],
        { body: { version: 0 } },
      );
      return;
    }
    if (op === "profile") {
      enForm(
        "扣繳與薪資匯款核對資料",
        domain,
        op,
        [
          F("employee_id", "員工", "", "select", employees),
          F("tax_identifier", "身分／居留或稅籍識別碼"),
          F("address", "扣繳地址"),
          F("bank_name", "銀行與分行"),
          F("bank_account", "員工匯款帳號"),
        ],
        {
          body: { version: 0 },
          help: "保存在目前公司的帳套，只有薪資資料權限可讀取；此設定不會向銀行發起匯款。",
        },
      );
      return;
    }
    if (op === "terms") {
      enForm("員工薪資與投保條件", domain, op, [
        F("employee_id", "員工", "", "select", employees),
        F("effective_date", "生效日期", date.slice(0, 7) + "-01", "date"),
        F("salary_kind", "計薪方式", "monthly", "select", [
          ["monthly", "月薪"],
          ["hourly", "時薪"],
        ]),
        F("amount", "月薪／時薪", "", "number"),
        F("labor_base", "勞保及就保投保月薪", "", "number"),
        F("health_base", "健保投保月薪", "", "number"),
        F("pension_base", "退休金提繳月薪", "", "number"),
        F("dependents", "健保眷屬人數", 0, "number", null, {
          step: "1",
          integer: true,
        }),
        F(
          "voluntary_pension_bp",
          "自願提繳基點（最多 600）",
          0,
          "number",
          null,
          { step: "1", integer: true },
        ),
        F("tax_resident", "稅務居住者", "true", "select", bool, {
          boolean: true,
        }),
        F("tax_bp", "居住者扣繳基點", 500, "number", null, {
          step: "1",
          integer: true,
        }),
        F("tax_exempt", "核對後的月薪扣繳門檻", "", "number"),
      ]);
      return;
    }
    if (op === "attendance" || op === "leave") {
      enForm(op === "attendance" ? "登錄出勤" : "提出請假", domain, op, [
        F(
          "employee_id",
          "員工",
          d.employee_id || "",
          "select",
          employees.length > 1
            ? employees
            : [
                ["", "請先綁定員工帳號"],
                ...(d.employee_id ? [[d.employee_id, "本人"]] : []),
              ],
        ),
        F("date", "日期", date, "date"),
        F("start", "開始", "09:00", "time"),
        F("end", "結束", op === "attendance" ? "18:00" : "17:00", "time"),
        ...(op === "attendance"
          ? [
              F("break_minutes", "休息分鐘", 60, "number", null, {
                step: "1",
                integer: true,
              }),
              F("overnight", "跨至翌日", "false", "select", bool, {
                boolean: true,
              }),
            ]
          : [F("kind", "假別代號", "annual")]),
        F("notes", "說明", "", "textarea"),
      ]);
      return;
    }
    if (op === "leave-balance") {
      enForm(
        "設定請假額度",
        domain,
        op,
        [
          F("employee_id", "員工", "", "select", employees),
          F("year", "年度", date.slice(0, 4), "number", null, {
            step: "1",
            integer: true,
          }),
          F("kind", "假別代號", "annual"),
          F("minutes", "可用分鐘", 480, "number", null, {
            step: "1",
            integer: true,
          }),
        ],
        { body: { version: 0 } },
      );
      return;
    }
    if (op === "decide" || op === "decide-cancel") {
      const [type, n] = rid.split(":"),
        r = (type === "leave" ? d.leave : d.attendance).find(
          (x) => x.id === Number(n),
        );
      enForm(
        "出勤／請假核定",
        domain,
        "decide",
        [
          ...(op === "decide"
            ? [
                F("action", "決定", "approve", "select", [
                  ["approve", "核准"],
                  ["reject", "駁回"],
                ]),
              ]
            : []),
          F("reason", "原因", "", "textarea"),
        ],
        {
          body: {
            id: r.id,
            version: r.version,
            type,
            ...(op === "decide-cancel" ? { action: "cancel" } : {}),
          },
        },
      );
      return;
    }
    if (op === "compute") {
      enForm(
        "建立月份薪資",
        domain,
        op,
        [
          F(
            "period",
            "月份",
            new Date(Date.parse(date.slice(0, 7) + "-01T00:00Z") - 86400000)
              .toISOString()
              .slice(0, 7),
            "month",
          ),
          F("notes", "已核對出勤、投保級距及扣繳的說明", "", "textarea"),
        ],
        {
          group: {
            key: "adjustments",
            label: "本期加給／其他扣款（選填）",
            fields: [
              F("employee_id", "員工", "", "select", employees),
              F("extra", "加給", "0", "number"),
              F("deduction", "其他代扣款", "0", "number"),
              ...[
                "base_pay",
                "overtime_pay",
                "tax",
                "labor_employee",
                "health_employee",
                "pension_employee",
                "labor_employer",
                "health_employer",
                "pension_employer",
              ].map((k) =>
                F(
                  k,
                  {
                    base_pay: "覆核本薪",
                    overtime_pay: "覆核加班費",
                    tax: "覆核扣繳",
                    labor_employee: "覆核員工勞保",
                    health_employee: "覆核員工健保",
                    pension_employee: "覆核員工自提",
                    labor_employer: "覆核雇主勞保",
                    health_employer: "覆核雇主健保",
                    pension_employer: "覆核雇主退休金",
                  }[k] + "（選填）",
                  "",
                  "number",
                  null,
                  { optional: true },
                ),
              ),
              F("statutory_reason", "覆核計算依據", "", "textarea", null, {
                optional: true,
              }),
              F("source_reference", "核定資料參考號", "", "text", null, {
                optional: true,
              }),
            ],
            rows: [],
          },
        },
      );
      return;
    }
    if (op === "remittance") {
      const r = EN.entity;
      enForm(
        "登錄薪資法定款繳納",
        domain,
        op,
        [
          F("kind", "繳納種類", "tax", "select", [
            ["tax", "扣繳所得稅"],
            ["insurance", "勞健保費"],
            ["pension", "退休金"],
            ["other", "其他薪資代扣款"],
          ]),
          F("amount", "已核對繳納金額", "", "number"),
          F("date", "繳納日期", date, "date"),
          F(
            "bank_account_id",
            "付款帳戶",
            "",
            "select",
            enOptions(S.data.bank_accounts || []),
          ),
          F("reference", "繳款書／交易參考號"),
        ],
        { body: { id: r.id, version: r.version } },
      );
      return;
    }
    if (op === "reverse-remittance") {
      const r = EN.entity;
      enForm(
        "沖回法定款繳納",
        domain,
        op,
        [
          F(
            "remittance_id",
            "繳納紀錄",
            "",
            "select",
            enOptions(
              r.remittances.filter((p) => p.status === "posted"),
              (p) => p.no + " " + money(p.amount),
            ),
          ),
          F("reason", "原因", "", "textarea"),
        ],
        { body: { version: r.version } },
      );
      return;
    }
    if (op === "pay") {
      const r = EN.entity;
      enForm(
        "薪資付款",
        domain,
        op,
        [
          F(
            "line_id",
            "員工薪資",
            "",
            "select",
            enOptions(
              r.lines,
              (x) =>
                (d.employees?.find((e) => e.id === x.employee_id)?.name ||
                  x.employee_id) +
                " · 未付 " +
                money(x.net_pay - x.paid),
            ),
          ),
          F(
            "bank_account_id",
            "付款帳戶",
            "",
            "select",
            enOptions(S.data.bank_accounts || []),
          ),
          F("amount", "付款金額", "", "number"),
          F("date", "付款日期", date, "date"),
        ],
        { body: { id: r.id, version: r.version } },
      );
      return;
    }
    if (op === "reverse-payment") {
      const r = EN.entity;
      enForm(
        "沖回薪資付款",
        domain,
        op,
        [
          F(
            "payment_id",
            "付款紀錄",
            "",
            "select",
            enOptions(
              r.payments.filter((p) => p.status === "posted"),
              (p) => p.no + " " + money(p.amount),
            ),
          ),
          F("reason", "原因", "", "textarea"),
        ],
        { body: { version: r.version } },
      );
      return;
    }
    const r = await enApi("hr/detail?id=" + rid);
    enForm(
      "薪資作業",
      domain,
      "action",
      [
        F("action", "動作", op, "select", [
          ["approve", "核准"],
          ["post", "提列過帳"],
          ["cancel", "取消草稿"],
          ["reverse", "沖回提列"],
        ]),
        F("reason", "原因", "", "textarea"),
      ],
      { body: { id: r.id, version: r.version } },
    );
    return;
  }
  if (domain === "production") {
    const C = enOptions(d.centers || []),
      routes = d.routes || [];
    if (op === "bom") {
      enForm(
        "多階 BOM",
        domain,
        op,
        [F("product_id", "製成品", "", "select", P), F("name", "材料表名稱")],
        {
          group: {
            key: "lines",
            label: "每 1 基本單位成品所需材料",
            fields: [
              F("product_id", "材料／半成品", "", "select", P),
              F("qty", "基本用量", "1", "number", null, { step: "0.001" }),
            ],
            rows: [{}],
          },
        },
      );
      return;
    }
    if (op === "center") {
      enForm("工作中心", domain, op, [
        F("code", "代號"),
        F("name", "名稱"),
        F("daily_minutes", "每日可用分鐘", 480, "number", null, {
          step: "1",
          integer: true,
        }),
        F("hourly_cost", "每小時分攤成本 TWD", "0", "number"),
      ]);
      return;
    }
    if (op === "calendar") {
      enForm(
        "產能行事曆",
        domain,
        op,
        [
          F("center_id", "工作中心", "", "select", C),
          F("date", "日期", date, "date"),
          F("minutes", "當日可用分鐘", 0, "number", null, {
            step: "1",
            integer: true,
          }),
        ],
        { body: { version: 0 } },
      );
      return;
    }
    if (op === "route") {
      enForm(
        "工藝路線",
        domain,
        op,
        [F("product_id", "製成品", "", "select", P), F("name", "路線名稱")],
        {
          group: {
            key: "operations",
            label: "依順序執行的工序（內製選中心；委外選供應商及服務品）",
            fields: [
              F("name", "工序"),
              F("center_id", "工作中心", "", "select", C),
              F(
                "supplier_id",
                "委外供應商",
                "",
                "select",
                enOptions(S.data.partners.filter((p) => p.kind !== "customer")),
              ),
              F(
                "service_product_id",
                "委外費服務品",
                "",
                "select",
                enOptions(S.data.products.filter((p) => !p.track_stock)),
              ),
              F("setup_minutes", "準備分鐘", 0, "number", null, {
                step: "1",
                integer: true,
              }),
              F("minutes_per_unit", "每單位分鐘", "1", "number", null, {
                step: "0.001",
              }),
              F("lead_days", "委外交期天", 0, "number", null, {
                step: "1",
                integer: true,
              }),
              F("unit_fee", "委外每單位費用", "0", "number"),
            ],
            rows: [{}],
          },
        },
      );
      return;
    }
    if (op === "create") {
      enForm("建立製造工單", domain, op, [
        F("product_id", "製成品", "", "select", P),
        F("warehouse_id", "倉庫", "", "select", W),
        F("qty", "基本數量", "1", "number", null, { step: "0.001" }),
        F("start_date", "最早開始日", date, "date"),
        F("due_date", "需求交期", date, "date"),
        F("accept_late", "允許排程晚於需求交期", "false", "select", bool, {
          boolean: true,
        }),
      ]);
      return;
    }
    if (op === "preview") {
      enForm(
        "計算物料需求",
        domain,
        op,
        [F("warehouse_id", "倉庫", "", "select", W)],
        {
          checks: {
            key: "document_ids",
            label: "來源訂單（可與獨立需求併用）",
            items: S.data.documents
              .filter(
                (x) =>
                  x.kind === "order" &&
                  ["pending", "approved", "partial"].includes(x.status),
              )
              .map((x) => [x.id, x.no + " · " + x.partner_name]),
          },
          group: {
            key: "forecasts",
            label: "獨立需求／預估",
            fields: [
              F("product_id", "商品", "", "select", P),
              F("qty", "基本數量", "1", "number", null, { step: "0.001" }),
              F("due_date", "需求日", date, "date"),
              F("reference", "需求說明", "獨立需求"),
            ],
            rows: [],
          },
        },
      );
      return;
    }
    if (op === "plan-open") {
      const p = d.plans.find((x) => x.id === Number(rid)),
        ls = JSON.parse(p.result);
      EN.entity = p;
      modal(
        p.no,
        table(
          ["商品", "需求基本量", "方式", "需求日"],
          ls.map(
            (l) =>
              `<tr><td>${E(l.sku)} ${E(l.name)}</td><td>${Q(l.qty)}</td><td>${l.kind === "manufacture" ? "製造" : "採購"}</td><td>${E(l.due_date)}</td></tr>`,
          ),
        ),
        p.status === "preview"
          ? enBtn("建立採購／製造單", "production", "commit", p.id)
          : btn("關閉", "close"),
        true,
      );
      return;
    }
    if (op === "commit") {
      const p = d.plans.find((x) => x.id === Number(rid));
      enForm(
        "建立 MRP 建議單據",
        domain,
        op,
        [
          F("accept_late", "允許排程逾期", "false", "select", bool, {
            boolean: true,
          }),
        ],
        {
          body: { id: p.id, version: p.version },
          help: "來源已改變時會拒絕執行。新增的是待核准採購或待發放製造單，不會自動付款或出庫。",
        },
      );
      return;
    }
    const j = await enApi("production/detail?id=" + rid),
      fields = [],
      body = { id: j.id, version: j.version };
    if (op === "issue")
      fields.push(
        F(
          "material_id",
          "材料",
          "",
          "select",
          enOptions(
            j.materials,
            (m) => m.sku + " · 未領 " + Q(m.required_qty - m.issued_qty),
          ),
        ),
        F("qty", "本次領料基本量", "1", "number", null, { step: "0.001" }),
      );
    if (["complete", "send", "receive", "recall", "extend"].includes(op))
      fields.push(
        F(
          "operation_id",
          "工序",
          "",
          "select",
          enOptions(j.operations, (o) => o.sequence + " " + o.name),
        ),
      );
    if (op === "complete")
      fields.push(
        F("actual_minutes", "實際工時分鐘", 0, "number", null, {
          step: "1",
          integer: true,
        }),
      );
    if (op === "extend")
      fields.push(
        F("start_date", "追加產能開始日", date, "date"),
        F("minutes", "追加分鐘", 60, "number", null, {
          step: "1",
          integer: true,
        }),
        F("reason", "原因"),
        F("accept_late", "接受重排後逾期", "false", "select", bool, {
          boolean: true,
        }),
      );
    if (op === "receive")
      fields.push(
        F("qty", "本次委外回貨基本量", "1", "number", null, { step: "0.001" }),
      );
    if (["send", "receive", "recall"].includes(op))
      fields.push(F("reference", "外部交接單號"));
    if (op === "recall")
      fields.push(F("reason", "未加工收回原因", "", "textarea"));
    if (op === "cancel")
      fields.push(
        F("material_disposition", "已領材料處理", "return", "select", [
          ["return", "材料完整退回"],
          ["scrap", "已耗用或報廢，轉費用"],
        ]),
        F("reason", "取消原因", "", "textarea"),
        F(
          "confirm_materials_returned",
          "確認材料已完整退回",
          "false",
          "select",
          bool,
          { boolean: true },
        ),
      );
    enForm(
      {
        release: "發放工單",
        issue: "製造領料",
        complete: "完成工序",
        extend: "追加產能",
        send: "委外送出並建立加工採購",
        receive: "委外回貨及加工進貨",
        recall: "收回未加工委外在製品",
        finish: "製造成品入庫",
        cancel: "取消工單",
      }[op] || op,
      domain,
      op,
      fields,
      {
        body,
        group: ["issue", "finish"].includes(op)
          ? {
              key: "lots",
              label: "追蹤商品批號／序號（未啟用可留空）",
              fields: [
                F("product_id", "商品", "", "select", P),
                F("code", "批號／序號"),
                F("qty", "基本量", "1", "number", null, { step: "0.001" }),
                F("expiry", "效期", "", "date", null, { optional: true }),
              ],
              rows: [],
            }
          : null,
      },
    );
    return;
  }
}
async function enDetail(domain, id) {
  const r = await enApi(domain + "/detail?id=" + id);
  EN.entity = r;
  let body = "",
    actions = "";
  if (domain === "wms") {
    body =
      `<p>${enStatus(r.status)}</p>` +
      table(
        ["來源", "商品", "本次基本量", "已配量", "不足"],
        r.lines.map(
          (l) =>
            `<tr><td>${E(l.document_no)}</td><td>${E(l.sku)}</td><td>${Q(l.base_qty)}</td><td>${Q(l.base_qty - l.shortage)}</td><td>${Q(l.shortage)}</td></tr>`,
        ),
      );
    if (r.status === "draft")
      actions =
        enBtn("重新分配", domain, "plan", r.id) +
        enBtn("波次出貨", domain, "post", r.id) +
        enBtn("取消波次", domain, "cancel", r.id);
  } else if (domain === "fx") {
    body =
      `<p>${E(r.currency)} · ${enStatus(r.status)} · 帳面餘額 TWD ${money(r.book_value, true)}</p>` +
      table(
        ["摘要", "原幣", "本位幣 TWD"],
        r.lines.map(
          (l) =>
            `<tr><td>${E(l.description)}</td><td>${E(String(l.foreign_amount / 10 ** r.precision))}</td><td>${money(l.base_amount, true)}</td></tr>`,
        ),
      ) +
      table(
        ["收付單", "原幣", "收付 TWD", "匯兌收益 TWD", "狀態", ""],
        r.settlements.map(
          (s) =>
            `<tr><td>${E(s.no)}</td><td>${E(String(s.foreign_amount / 10 ** r.precision))}</td><td>${money(s.cash_amount, true)}</td><td>${money(s.realized, true)}</td><td>${enStatus(s.status)}</td><td>${s.status === "posted" ? enBtn("沖回", domain, "reverse", s.id) : ""}</td></tr>`,
        ),
      );
    actions =
      r.status === "draft"
        ? enBtn("立帳", domain, "post", r.id) +
          enBtn("取消草稿", domain, "cancel", r.id)
        : r.status === "posted"
          ? enBtn("收付款", domain, "settle", r.id)
          : "";
  } else if (domain === "delivery") {
    body =
      `<p>${E(r.recipient)} · ${enStatus(r.status)}</p><p>${E(r.subject)}</p><p>${E(r.text)}</p><p role="status">${E(r.last_error)}</p>` +
      table(
        ["附件", "類型", "大小"],
        r.attachments.map(
          (a) =>
            `<tr><td>${E(a.name)}</td><td>${E(a.type)}</td><td>${a.bytes}</td></tr>`,
        ),
      );
    if (["queued", "retry", "failed", "uncertain", "demo"].includes(r.status))
      actions = enBtn("取消／重送", domain, "action", r.id);
  } else if (domain === "hr") {
    body =
      `<p>${E(r.period)} · ${enStatus(r.status)}</p>` +
      table(
        [
          "員工",
          "本薪／加班／加給",
          "請假／其他扣款",
          "稅／保險／自提",
          "淨薪",
          "已付",
          "薪資明細",
        ],
        r.lines.map(
          (l) =>
            `<tr><td>${E(JSON.parse(l.snapshot).employee.name)}</td><td>${money(l.base_pay)} / ${money(l.overtime_pay)} / ${money(l.extra_pay)}</td><td>${money(l.leave_deduction)} / ${money(l.other_deduction)}</td><td>${money(l.tax)} / ${money(l.labor_employee + l.health_employee)} / ${money(l.pension_employee)}</td><td>${money(l.net_pay)}</td><td>${money(l.paid)}</td><td>${r.allowed?.print ? `<a class="btn small" target="_blank" rel="noopener" href="${formLink("/print/payroll/" + r.id + "?line_id=" + l.id)}">列印</a>` : ""}</td></tr>`,
        ),
      );
    actions =
      r.status === "draft"
        ? enBtn("核准", domain, "approve", r.id) +
          enBtn("取消", domain, "cancel", r.id)
        : r.status === "approved"
          ? enBtn("提列過帳", domain, "post", r.id) +
            enBtn("取消", domain, "cancel", r.id)
          : r.status === "posted"
            ? enBtn("薪資付款", domain, "pay", r.id) +
              enBtn("登錄法定款繳納", domain, "remittance", r.id) +
              enBtn("沖回繳納", domain, "reverse-remittance", r.id) +
              btn("匯出核對資料", "ent-export", r.id, "small") +
              enBtn("沖回付款", domain, "reverse-payment", r.id) +
              enBtn("沖回提列", domain, "reverse", r.id)
            : "";
  } else {
    body =
      `<p>${enStatus(r.status)} · 基本量 ${Q(r.qty)} · 預計完成 ${E(r.end_date)}</p>` +
      table(
        ["材料", "需求量", "已領量"],
        r.materials.map(
          (m) =>
            `<tr><td>${E(m.sku)} ${E(m.name)}</td><td>${Q(m.required_qty)}</td><td>${Q(m.issued_qty)}</td></tr>`,
        ),
      ) +
      table(
        ["工序", "狀態", "計畫／實際分鐘", "委外送出／回貨", "加工採購"],
        r.operations.map(
          (o) =>
            `<tr><td>${o.sequence} ${E(o.name)}</td><td>${enStatus(o.status)}</td><td>${o.planned_minutes} / ${o.actual_minutes}</td><td>${Q(o.sent_qty)} / ${Q(o.received_qty)}</td><td>${o.purchase_no ? `<button type="button" class="btn small" data-open="document" data-id="${o.po_document_id}">${E(o.purchase_no)}</button>` : ""}</td></tr>`,
        ),
      ) +
      table(
        ["工作中心", "日期", "開始／結束分鐘"],
        r.slots
          .filter((s) => s.active)
          .map(
            (s) =>
              `<tr><td>${E(EN.cache.production.centers.find((c) => c.id === s.center_id)?.name)}</td><td>${E(s.date)}</td><td>${s.start_minute} / ${s.end_minute}</td></tr>`,
          ),
      );
    if (r.status === "draft")
      actions =
        enBtn("發放", domain, "release", r.id) +
        enBtn("取消", domain, "cancel", r.id);
    if (r.status === "released")
      actions =
        enBtn("領料", domain, "issue", r.id) +
        enBtn("完成工序", domain, "complete", r.id) +
        enBtn("追加產能", domain, "extend", r.id) +
        enBtn("委外送出", domain, "send", r.id) +
        enBtn("委外回貨", domain, "receive", r.id) +
        enBtn("未加工收回", domain, "recall", r.id) +
        enBtn("成品入庫", domain, "finish", r.id) +
        enBtn("取消", domain, "cancel", r.id);
  }
  modal(r.no || "寄送工作", body, actions || btn("關閉", "close"), true);
  for (const button of document.querySelectorAll(
    "#modal-root [data-action=ent-command]",
  )) {
    const op = button.dataset.id.split("|")[1],
      act = [
        "post",
        "pay",
        "settle",
        "finish",
        "complete",
        "issue",
        "send",
        "receive",
        "recall",
        "remittance",
      ].includes(op)
        ? "post"
        : op.startsWith("reverse")
          ? "reverse"
          : op === "approve" || op === "release"
            ? "approve"
            : op === "cancel"
              ? "cancel"
              : "update";
    if (r.allowed && !r.allowed[act]) button.remove();
  }
  const exportButton = document.querySelector(
    "#modal-root [data-action=ent-export]",
  );
  if (exportButton && !r.allowed?.export) exportButton.remove();
}
async function enterpriseSubmit(kind, b) {
  const config = EN.form;
  if (!config) throw Error("請重新開啟作業");
  const body = { ...config.body };
  for (const f of config.fields) {
    let v = b[f.key];
    if (f.boolean) v = v === "true";
    if (f.integer && v !== "") v = Number(v);
    body[f.key] = v;
  }
  if (config.group) {
    const values = enReadRows();
    body[config.group.key] = values.map((row) =>
      Object.fromEntries(
        config.group.fields.map((f) => [
          f.key,
          f.boolean
            ? row[f.key] === "true" || row[f.key] === true
            : f.integer
              ? Number(row[f.key])
              : row[f.key],
        ]),
      ),
    );
  }
  if (config.checks)
    body[config.checks.key] = [
      ...document.querySelectorAll("[data-ent-selected]:checked"),
    ].map((e) => Number(e.value));
  if (config.domain === "hr" && config.op === "configure") {
    const p = EN.cache.hr.template;
    body.definition = {
      ...p,
      ...Object.fromEntries(
        Object.entries(body).filter(
          ([k]) => !["effective_date", "confirm_rules"].includes(k),
        ),
      ),
    };
  }
  if (config.domain === "delivery" && config.op === "queue") {
    const files = [...($("#ent-attachments")?.files || [])];
    if (files.length > 4 || files.reduce((n, f) => n + f.size, 0) > 768 * 1024)
      throw Error("額外附件最多 4 個、合計 768 KB");
    body.attachments = await Promise.all(
      files.map(
        (f) =>
          new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () =>
              resolve({
                name: f.name,
                type: f.type,
                base64: String(reader.result).split(",")[1],
              });
            reader.onerror = () => reject(Error("讀取附件失敗"));
            reader.readAsDataURL(f);
          }),
      ),
    );
  }
  if (config.domain === "wms" && config.op === "enable")
    body.version =
      EN.cache.wms.controls.find(
        (c) => c.warehouse_id === Number(body.warehouse_id),
      )?.version || 0;
  if (config.domain === "wms" && config.op === "replenishment")
    body.version =
      EN.cache.wms.replenishment.find(
        (r) =>
          r.bin_id === Number(body.bin_id) &&
          r.product_id === Number(body.product_id),
      )?.version || 0;
  if (config.domain === "fx" && config.op === "rate")
    body.version =
      EN.cache.fx.rates.find(
        (r) => r.currency === body.currency && r.date === body.date,
      )?.version || 0;
  if (config.domain === "delivery" && config.op === "defaults")
    body.version =
      EN.cache.delivery.defaults.find(
        (r) =>
          r.kind === body.kind &&
          (r.partner_id || 0) === Number(body.partner_id || 0) &&
          r.locale === (body.locale || "").toLowerCase(),
      )?.version || 0;
  if (config.domain === "hr" && config.op === "profile")
    body.version =
      EN.cache.hr.profiles?.find(
        (r) => r.employee_id === Number(body.employee_id),
      )?.version || 0;
  if (config.domain === "hr" && config.op === "calendar")
    body.version =
      EN.cache.hr.calendar.find((r) => r.date === body.date)?.version || 0;
  if (config.domain === "hr" && config.op === "leave-balance")
    body.version =
      EN.cache.hr.leave_balances.find(
        (r) =>
          r.employee_id === Number(body.employee_id) &&
          r.year === Number(body.year) &&
          r.kind === body.kind,
      )?.version || 0;
  if (config.domain === "production" && config.op === "calendar")
    body.version =
      EN.cache.production.calendar.find(
        (r) => r.center_id === Number(body.center_id) && r.date === body.date,
      )?.version || 0;
  if (config.domain === "production" && config.op === "bom")
    body.version = EN.cache.production.boms.find(
      (r) => r.product_id === Number(body.product_id),
    )?.version;
  const r = await enApi(config.domain + "/" + config.op, body);
  delete EN.cache[config.domain];
  await refresh();
  await enLoad(config.domain);
  closeModal();
  toast(r?.no ? "作業完成 · " + r.no : "作業已儲存");
}
