const govStatus = {
  pending: "待簽核",
  approved: "已核准",
  rejected: "已退回",
  cancelled: "已取消",
};
let GV = {};
function governancePage() {
  const g = S.data.governance,
    tab = S.tab || "requests",
    requests = S.data.approval_requests || [];
  let body = "";
  if (tab === "requests")
    body = table(
      ["單號", "種類", "目前階段", "簽核狀態", ""],
      requests.map(
        (r) =>
          `<tr><td>${E(r.no)}</td><td>${E(kindNames[r.kind])}</td><td>${r.stage + 1}</td><td>${E(govStatus[r.status] || r.status)}</td><td>${btn("簽核／歷程", "gov-request", r.id, "small")}</td></tr>`,
      ),
    );
  else if (g && tab === "rules")
    body =
      btn("新增簽核規則", "gov-rule", "", "primary") +
      table(
        ["名稱", "單據", "金額範圍", "階段", "狀態", ""],
        g.rules.map(
          (r) =>
            `<tr><td>${E(r.name)}</td><td>${E(kindNames[r.kind])}</td><td>${money(r.min_amount)} – ${r.max_amount == null ? "不限" : money(r.max_amount)}</td><td>${r.stages.length}</td><td>${r.active ? "啟用" : "停用"}</td><td>${btn("編輯", "gov-rule", r.id, "small")}</td></tr>`,
        ),
      );
  else if (g && tab === "delegations")
    body =
      btn("新增代理", "gov-delegation", "", "primary") +
      table(
        ["原簽核人", "代理人", "期間", "狀態", ""],
        g.delegations.map(
          (r) =>
            `<tr><td>${E(g.users.find((u) => u.id === r.principal_id)?.name)}</td><td>${E(g.users.find((u) => u.id === r.delegate_id)?.name)}</td><td>${E(r.starts)} ～ ${E(r.ends)}</td><td>${r.active ? "啟用" : "停用"}</td><td>${btn("編輯／停用", "gov-delegation", r.id, "small")}</td></tr>`,
        ),
      );
  else if (g && tab === "periods")
    body = panel(
      "補打單期限",
      `<form data-form="gov-periods"><input type="hidden" name="version" value="${g.periods.version}"><div class="form-grid">${[
        ["trade", "交易"],
        ["inventory", "庫存"],
        ["finance", "帳務"],
      ]
        .map(([k, n]) =>
          field(
            n + "：最多回溯天數（空白不限）",
            k,
            g.periods[k] ?? "",
            "number",
            'min="0" max="3650"',
          ),
        )
        .join(
          "",
        )}</div><p class="hint">0 表示只能處理今天及未來日期。依台北日期計算；結帳日限制仍同時生效，管理員也不能從單據操作繞過期限。</p><button class="btn primary" type="submit">儲存政策</button></form>`,
    );
  else if (g && tab === "formats")
    body =
      `<p>指定版型的授權與功能、資料範圍及成本權限同時生效。未設定時沿用原授權；「允許」不會越過其他功能的拒絕。更動後所有連線須重新登入。</p>` +
      table(
        ["種類", "版型", ""],
        g.formats.map(
          (f) =>
            `<tr><td>${f.kind === "form" ? "表單" : "自訂報表"}</td><td>${E(f.name)}</td><td>${btn("逐人動作授權", "gov-grants", f.kind + ":" + f.id, "small")}</td></tr>`,
        ),
      );
  return (
    head(
      "簽核與操作政策",
      "金額條件、循序／會簽、限期代理、補打單及逐版型授權。",
      "",
      "APPROVAL & POLICY",
    ) +
    tabBar(
      [
        ["requests", "簽核請求"],
        ...(g
          ? [
              ["rules", "規則"],
              ["delegations", "代理"],
              ["periods", "補打單期限"],
              ["formats", "版型授權"],
            ]
          : []),
      ],
      tab,
    ) +
    body
  );
}
function govUserOptions(current) {
  return S.data.governance.users
    .filter((u) => u.active)
    .map(
      (u) =>
        `<option value="${u.id}" ${u.id === Number(current) ? "selected" : ""}>${E(u.name + " · " + u.username)}</option>`,
    )
    .join("");
}
function govCollectStages() {
  if (!GV.stages) return;
  GV.stages = [...document.querySelectorAll("[data-gov-stage]")].map((el) => ({
    name: el.querySelector('[name="stage_name"]').value,
    mode: el.querySelector('[name="stage_mode"]').value,
    source: el.querySelector('[name="stage_source"]').value,
    user_ids: [...el.querySelectorAll("input:checked")].map((c) =>
      Number(c.value),
    ),
  }));
}
function govRenderStages() {
  const root = $("#gov-stages");
  if (!root) return;
  root.innerHTML = GV.stages
    .map(
      (s, i) =>
        `<fieldset data-gov-stage="${i}" style="min-width:0;margin:12px 0"><legend>第 ${i + 1} 階段</legend><div class="form-grid">${field("名稱", "stage_name", s.name, "text", 'required maxlength="80"')}${selectField("方式", "stage_mode", `<option value="any" ${s.mode === "any" ? "selected" : ""}>任一人核准</option><option value="all" ${s.mode === "all" ? "selected" : ""}>全部會簽</option>`)}${selectField("簽核人來源", "stage_source", `<option value="users" ${s.source === "users" ? "selected" : ""}>指定人員</option><option value="manager" ${s.source === "manager" ? "selected" : ""}>經辦人的上階</option>`)}</div><p>指定人員（上階來源會忽略此選擇）</p><div style="display:flex;flex-wrap:wrap;gap:12px">${S.data.governance.users
          .filter((u) => u.active)
          .map(
            (u) =>
              `<label><input type="checkbox" value="${u.id}" ${s.user_ids.includes(u.id) ? "checked" : ""}> ${E(u.name)}</label>`,
          )
          .join(
            "",
          )}</div><p>${btn("上移", "gov-stage-up", i, "small")}${btn("移除階段", "gov-stage-remove", i, "small danger")}</p></fieldset>`,
    )
    .join("");
}
async function governanceAction(a, id) {
  const g = S.data.governance;
  if (a === "gov-rule") {
    const r = g.rules.find((r) => r.id === Number(id)) || {
      kind: "order",
      min_amount: 0,
      max_amount: null,
      active: 1,
      forbid_owner: true,
      distinct_actors: true,
      stages: [
        { name: "主管核准", source: "users", mode: "any", user_ids: [] },
      ],
    };
    GV = { rule: r, stages: structuredClone(r.stages) };
    modal(
      "條件式簽核規則",
      `<form id="modal-form" data-form="gov-rule"><div class="form-grid">${field("規則名稱", "name", r.name || "", "text", 'required maxlength="100"')}${selectField(
        "單據種類",
        "kind",
        Object.entries(kindNames)
          .filter(([k]) => ["quote", "order", "purchase"].includes(k))
          .map(
            ([k, n]) =>
              `<option value="${k}" ${r.kind === k ? "selected" : ""}>${E(n)}</option>`,
          )
          .join(""),
      )}${field("含稅金額下限", "min_amount", inputMoney(r.min_amount), "number", 'required min="0" step="0.01"')}${field("含稅金額上限（空白不限）", "max_amount", r.max_amount == null ? "" : inputMoney(r.max_amount), "number", 'min="0" step="0.01"')}${selectField("狀態", "active", `<option value="1">啟用</option><option value="0" ${!r.active ? "selected" : ""}>停用</option>`)}${selectField("禁止經辦人自行／代理核准", "forbid_owner", `<option value="1">禁止</option><option value="0" ${!r.forbid_owner ? "selected" : ""}>允許</option>`)}${selectField("跨階核准人不得重複", "distinct_actors", `<option value="1">禁止重複</option><option value="0" ${!r.distinct_actors ? "selected" : ""}>允許重複</option>`)}</div><div id="gov-stages"></div>${btn("新增階段", "gov-stage-add", "", "small")}<p class="hint">同種類啟用規則的金額區間不可重疊。送審時凍結規則及可用簽核人，修改規則只影響後續送審；所有人仍須具備來源單據核准權。最後一階通過才核准單據並預留庫存。</p></form>`,
      formFooter(),
      true,
    );
    govRenderStages();
    return;
  }
  if (a.startsWith("gov-stage-")) {
    govCollectStages();
    if (a === "gov-stage-add") {
      if (GV.stages.length >= 10) throw Error("最多十階");
      GV.stages.push({
        name: "新增階段",
        mode: "any",
        source: "users",
        user_ids: [],
      });
    }
    if (a === "gov-stage-remove") GV.stages.splice(Number(id), 1);
    if (a === "gov-stage-up" && Number(id) > 0) {
      const i = Number(id);
      [GV.stages[i - 1], GV.stages[i]] = [GV.stages[i], GV.stages[i - 1]];
    }
    govRenderStages();
    return;
  }
  if (a === "gov-delegation") {
    const r = g.delegations.find((r) => r.id === Number(id)) || {
      kind: "all",
      starts: S.data.today,
      ends: S.data.today,
      active: 1,
    };
    GV = { delegation: r };
    modal(
      "限期簽核代理",
      `<form id="modal-form" data-form="gov-delegation"><div class="form-grid">${selectField("原簽核人", "principal_id", govUserOptions(r.principal_id))}${selectField("代理人", "delegate_id", govUserOptions(r.delegate_id))}${field("開始日期", "starts", r.starts, "date", "required")}${field("結束日期", "ends", r.ends, "date", "required")}${selectField(
        "單據種類",
        "kind",
        Object.entries({ all: "全部", ...kindNames })
          .filter(([k]) => ["all", "quote", "order", "purchase"].includes(k))
          .map(
            ([k, n]) =>
              `<option value="${k}" ${r.kind === k ? "selected" : ""}>${E(n)}</option>`,
          )
          .join(""),
      )}${selectField("狀態", "active", `<option value="1">啟用</option><option value="0" ${!r.active ? "selected" : ""}>停用</option>`)}</div><p>代理人與原簽核人都必須保有來源單據核准權。代理不會授予來源資料檢視權；停用或到期立即生效。</p></form>`,
      formFooter(),
    );
    return;
  }
  if (a === "gov-grants") {
    const [kind, raw] = id.split(":"),
      formatId = Number(raw),
      format = g.formats.find((f) => f.kind === kind && f.id === formatId);
    GV = { format };
    modal(
      "逐人版型授權 · " + format.name,
      `<form id="modal-form" data-form="gov-grants">${selectField("使用者", "user_id", govUserOptions(""))}<p>每個動作可分開設定；拒絕查看也會阻擋該版型的其他操作。填寫紀錄另按其動作設定。</p><div id="gov-grant-fields" class="form-grid"></div></form>`,
      formFooter("儲存並重新登入"),
      true,
    );
    govRenderGrants();
    return;
  }
  if (a === "gov-request") {
    const r = await api("/api/governance/requests/" + id);
    GV = { request: r };
    const principals = r.available_principals || [];
    modal(
      "簽核歷程 · " + r.document.no,
      `<p>${E(r.definition.name)} · 規則修訂 ${r.definition.rule_version} · ${E(govStatus[r.status] || r.status)} · 單據修訂 ${r.document.version}</p><ol>${r.definition.stages.map((s, i) => `<li>${E(s.name)} · ${s.mode === "all" ? "全部會簽" : "任一人"}${i === r.stage && r.status === "pending" ? " ← 目前階段" : ""}</li>`).join("")}</ol>${table(
        ["階段", "指定人", "實際核准／代理人", "決定", "原因"],
        r.votes.map(
          (v) =>
            `<tr><td>${v.stage + 1}</td><td>${E(v.principal_name)}</td><td>${E(v.actor_name)}</td><td>${E({ approve: "核准", reject: "退回" }[v.decision] || v.decision)}</td><td>${E(v.reason)}</td></tr>`,
        ),
      )}${r.status === "pending" && principals.length ? `<form id="modal-form" data-form="gov-decision"><div class="form-grid">${selectField("以哪位簽核人身分處理", "principal_id", principals.map((p) => `<option value="${p.id}">${E(p.name)}${p.id !== S.data.user.id ? "（代理）" : ""}</option>`).join(""))}${selectField("決定", "decision", '<option value="approve">核准本階段</option><option value="reject">退回</option>')}${textarea("原因（退回必填）", "reason", "")}</div></form>` : "<p>此帳號目前沒有待辦簽核席次；歷程仍可依來源權限檢視。</p>"}`,
      r.status === "pending" && principals.length
        ? formFooter("確認決定")
        : btn("關閉", "close"),
      true,
    );
    return;
  }
}
function govRenderGrants() {
  const g = S.data.governance,
    f = GV.format,
    user = Number($('#modal-form [name="user_id"]').value);
  $("#gov-grant-fields").innerHTML = Object.entries(g.format_actions[f.kind])
    .map(([a, label]) => {
      const effect =
        g.grants.find(
          (r) =>
            r.kind === f.kind &&
            r.format_id === f.id &&
            r.user_id === user &&
            r.action === a,
        )?.effect || "";
      return selectField(
        label,
        "grant_" + a,
        [
          ["", "沿用原授權"],
          ["allow", "允許（仍受功能與資料權限限制）"],
          ["deny", "拒絕"],
        ]
          .map(
            ([k, n]) =>
              `<option value="${k}" ${effect === k ? "selected" : ""}>${n}</option>`,
          )
          .join(""),
      );
    })
    .join("");
}
document.addEventListener("change", (e) => {
  if (e.target.matches('#modal-form[data-form="gov-grants"] [name="user_id"]'))
    govRenderGrants();
});
async function governanceSubmit(kind, b) {
  let r;
  if (kind === "gov-rule") {
    govCollectStages();
    r = await api("/api/governance/rules", {
      ...b,
      id: GV.rule.id,
      version: GV.rule.version,
      forbid_owner: b.forbid_owner === "1",
      distinct_actors: b.distinct_actors === "1",
      stages: GV.stages,
    });
  }
  if (kind === "gov-delegation")
    r = await api("/api/governance/delegations", {
      ...b,
      id: GV.delegation.id,
      version: GV.delegation.version,
    });
  if (kind === "gov-periods") r = await api("/api/governance/periods", b);
  if (kind === "gov-grants") {
    const g = S.data.governance,
      f = GV.format,
      user = Number(b.user_id),
      grants = g.grants.filter(
        (r) =>
          !(r.kind === f.kind && r.format_id === f.id && r.user_id === user) &&
          r.kind === f.kind &&
          r.format_id === f.id,
      );
    for (const a of Object.keys(g.format_actions[f.kind]))
      if (b["grant_" + a])
        grants.push({ user_id: user, action: a, effect: b["grant_" + a] });
    await api("/api/governance/grants", {
      kind: f.kind,
      format_id: f.id,
      version:
        g.grant_versions.find((r) => r.kind === f.kind && r.format_id === f.id)
          ?.version || 0,
      grants,
    });
    closeModal();
    S.data = null;
    S.csrf = "";
    await init();
    toast("版型授權已更新，請重新登入");
    return;
  }
  if (kind === "gov-decision") {
    const q = GV.request;
    r = await api("/api/documents/" + q.document.id + "/" + b.decision, {
      version: q.document.version,
      principal_id: b.principal_id,
      reason: b.reason,
    });
    closeModal();
    await refresh();
    await governanceAction("gov-request", q.id);
    toast(
      r.status === "pending"
        ? "本階段已記錄，等待後續簽核"
        : "單據已" + (r.status === "approved" ? "核准" : "退回"),
    );
    return;
  }
  closeModal();
  await refresh();
  toast("政策已儲存");
}
