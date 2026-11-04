let CT = {};
let controlsSession = "";
function ctlSession() {
  const key = (S.company || "default") + ":" + S.data?.user.id;
  if (key !== controlsSession) {
    CT = {};
    controlsSession = key;
    return true;
  }
  return false;
}
async function controlApi(path, body) {
  const key = (S.company || "default") + ":" + S.data?.user.id;
  const result = await api(path, body);
  if (key !== (S.company || "default") + ":" + S.data?.user.id)
    throw Error("帳套或帳號已切換，請在目前帳套重新開啟作業");
  return result;
}

const ctlState = {
  draft: "草稿",
  passed: "檢驗合格／待放行",
  failed: "檢驗不合格",
  released: "已放行／待進出貨",
  consumed: "已進出貨",
  cancelled: "已取消",
  approved: "已核准",
};
function controlsPage() {
  ctlSession();
  const d = S.data,
    tab = S.tab || "quality";
  let body = "";
  if (tab === "quality")
    body =
      (d.quality_permissions?.create
        ? btn("建立本批品檢", "ctl-qi-new", "", "primary")
        : "") +
      "<p>待驗貨品不進入可用庫存。檢驗合格並放行後，回原單據執行本批進出貨。</p>" +
      table(
        ["品檢單", "來源", "方向", "狀態", ""],
        (d.quality_inspections || []).map(
          (q) =>
            `<tr><td>${E(q.no)}</td><td>${E(q.source_no)}</td><td>${q.direction === "receipt" ? "進貨" : "出貨"}</td><td>${E(ctlState[q.status])}</td><td>${btn("檢驗／歷程", "ctl-qi-open", q.id, "small")}</td></tr>`,
        ),
      );
  else if (tab === "specs")
    body =
      (d.quality_permissions?.configure
        ? btn("新增品檢規格", "ctl-spec", "", "primary")
        : "") +
      table(
        ["規格", "商品", "方向", "修訂", "狀態", ""],
        (d.quality_specs || []).map(
          (s) =>
            `<tr><td>${E(s.name)}</td><td>${E(d.products.find((p) => p.id === s.product_id)?.sku || s.product_id)}</td><td>${s.direction === "receipt" ? "進貨" : "出貨"}</td><td>${s.version}</td><td>${s.active ? "啟用" : "停用"}</td><td>${d.quality_permissions?.configure ? btn("編輯", "ctl-spec", s.id, "small") : ""}</td></tr>`,
        ),
      );
  else if (tab === "vendor")
    body =
      (d.vendor_bill_permissions?.create
        ? btn("新增供應商請款", "ctl-vendor-new", "", "primary")
        : "") +
      "<p>請款憑證獨立保存，與採購及進貨比對；核對不會再建立一筆應付或自動調整差額。</p>" +
      table(
        ["請款單", "供應商憑證號", "總額", "狀態", "付款核對", ""],
        (d.vendor_bills || []).map(
          (b) =>
            `<tr><td>${E(b.no)}</td><td>${E(b.invoice_ref)}</td><td>${money(b.total, true)}</td><td>${E(ctlState[b.status])}</td><td>${b.status === "approved" ? (b.payment_valid ? "有效" : "來源已異動／須重核") : "待核對"}</td><td>${btn("三方核對／歷程", "ctl-vendor-open", b.id, "small")}</td></tr>`,
        ),
      );
  else if (tab === "policy" && d.vendor_bill_permissions?.configure) {
    const p = d.procurement_control_policy;
    body = `<form data-form="ctl-policy"><input type="hidden" name="version" value="${p.version}"><div class="form-grid">${selectField("付款前須核對", "require_matching", `<option value="0">關閉</option><option value="1" ${p.require_matching ? "selected" : ""}>啟用</option>`)}${selectField("禁止請款填寫者自行核准", "forbid_self_approval", `<option value="1">禁止</option><option value="0" ${!p.forbid_self_approval ? "selected" : ""}>允許</option>`)}${field("數量容忍基點（100 = 1%）", "quantity_tolerance_bp", p.quantity_tolerance_bp, "number", 'required min="0" max="1000"')}${field("單價／未稅金額容忍基點（100 = 1%）", "net_tolerance_bp", p.net_tolerance_bp, "number", 'required min="0" max="1000"')}${field("每列稅額容忍 TWD", "tax_tolerance", inputMoney(p.tax_tolerance_cents), "number", 'required min="0" max="100" step="0.01"')}</div><p>開啟後，既有未付應付也須核對才可繼續付款；單筆、批次、月結、預付沖抵及票據均檢查。退貨／折讓後核對失效，須取消舊核對並依新餘額重新建單。容忍差額只記錄，不會改帳。</p><button class="btn primary" type="submit">儲存核對政策</button></form>`;
  }
  return (
    head(
      "品質與請款控管",
      "檢驗規格、本批放行、供應商請款及三方核對。",
      "",
      "QUALITY & MATCHING",
    ) +
    tabBar(
      [
        ["quality", "品檢待辦"],
        ["specs", "檢驗規格"],
        ...(d.vendor_bill_permissions ? [["vendor", "供應商請款"]] : []),
        ...(d.vendor_bill_permissions?.configure
          ? [["policy", "核對政策"]]
          : []),
      ],
      tab,
    ) +
    body
  );
}
function ctlCollectParameters() {
  CT.parameters = [...document.querySelectorAll("[data-ctl-parameter]")].map(
    (el) => ({
      key: el.querySelector('[name="p_key"]').value,
      label: el.querySelector('[name="p_label"]').value,
      type: el.querySelector('[name="p_type"]').value,
      unit: el.querySelector('[name="p_unit"]').value,
      lower: el.querySelector('[name="p_lower"]').value,
      upper: el.querySelector('[name="p_upper"]').value,
      expected_text: el.querySelector('[name="p_expected"]').value,
    }),
  );
}
function ctlRenderParameters() {
  $("#ctl-parameters").innerHTML = CT.parameters
    .map((p, i) =>
      `<fieldset data-ctl-parameter="${i}" style="min-width:0;margin:12px 0"><legend>檢驗參數 ${i + 1}</legend><div class="form-grid">${field("代碼（小寫英數及底線）", "p_key", p.key, "text", 'required pattern="[a-z][a-z0-9_]*" maxlength="40"')}${field("名稱", "p_label", p.label, "text", 'required maxlength="80"')}${selectField("類型", "p_type", `<option value="number">數值範圍</option><option value="text" ${p.type === "text" ? "selected" : ""}>文字完全相符</option>`)}${field("單位", "p_unit", p.unit || "")}${field("數值下限", "p_lower", p.lower ?? "0", "number", 'step="0.0001"')}${field("數值上限", "p_upper", p.upper ?? "0", "number", 'step="0.0001"')}${field("文字標準（文字類型必填）", "p_expected", p.expected_text || "")}</div>${btn("移除此參數", "ctl-param-remove", i, "small danger")}</fieldset>`.replace(
        /(for|id)="f-p_([^"]*)"/g,
        (_, attribute, key) => `${attribute}="f-p_${i}_${key}"`,
      ),
    )
    .join("");
}
function ctlQiInputs(q) {
  return q.lines
    .map(
      (l) =>
        `<section class="info-card"><h3>${E(l.sku)} · ${E(l.name)} · 本批 ${Q(l.qty)} ${E(l.unit)}</h3>${l.spec_id ? `<p>規格修訂 ${l.spec_version} · 基本量 ${Q(l.base_qty)} ${E(l.base_unit)} · 至少抽樣 ${Q(l.required_sample_qty)}</p><div class="form-grid">${field("實際抽樣基本量", "sample_" + l.id, inputQty(l.sampled_qty), "number", `step="0.001" min="0" max="${inputQty(l.base_qty)}" ${q.status !== "draft" || !q.allowed.update ? "disabled" : ""}`)}${l.definition.parameters.map((p) => field(p.label + (p.unit ? "（" + p.unit + "）" : ""), "reading_" + l.id + "_" + p.key, l.readings[p.key] ?? "", p.type === "number" ? "number" : "text", `${p.type === "number" ? 'step="0.0001"' : ""} ${q.status !== "draft" || !q.allowed.update ? "disabled" : ""} maxlength="100"`)).join("")}</div><p class="hint">${l.definition.parameters.map((p) => E(p.label + ": " + (p.type === "number" ? `${p.lower / 10000} ～ ${p.upper / 10000}` : p.expected_text))).join("；")}</p>` : "<p>本列不需檢驗，仍綁定本批進出貨數量。</p>"}</section>`,
    )
    .join("");
}
async function controlsAction(a, id) {
  ctlSession();
  const d = S.data;
  if (a === "ctl-spec") {
    const s = (d.quality_specs || []).find((s) => s.id === Number(id)) || {
      product_id: d.products[0]?.id,
      direction: "receipt",
      active: 1,
      definition: {
        sampling_bp: 10000,
        min_sample_qty: 1000,
        forbid_self_release: true,
        parameters: [
          {
            key: "appearance",
            label: "外觀",
            type: "text",
            expected_text: "合格",
          },
        ],
      },
    };
    CT = {
      spec: s,
      parameters: s.definition.parameters.map((p) => ({
        ...p,
        lower: p.lower == null ? "0" : String(p.lower / 10000),
        upper: p.upper == null ? "0" : String(p.upper / 10000),
      })),
    };
    modal(
      "商品品檢規格",
      `<form id="modal-form" data-form="ctl-spec"><div class="form-grid">${field("規格名稱", "name", s.name || "", "text", 'required maxlength="100"')}${selectField(
        "商品",
        "product_id",
        options(d.products, (p) => p.sku + " · " + p.name, "id", s.product_id),
      )}${selectField("管制方向", "direction", `<option value="receipt">進貨前</option><option value="shipment" ${s.direction === "shipment" ? "selected" : ""}>出貨前</option>`)}${field("抽樣比例基點（10000 = 全檢）", "sampling_bp", s.definition.sampling_bp, "number", 'required min="1" max="10000"')}${field("最低抽樣基本量", "min_sample_qty", inputQty(s.definition.min_sample_qty), "number", 'required min="0.001" step="0.001"')}${selectField("禁止品檢填寫者自行放行", "forbid_self_release", `<option value="1">禁止</option><option value="0" ${!s.definition.forbid_self_release ? "selected" : ""}>允許</option>`)}${selectField("狀態", "active", `<option value="1">啟用</option><option value="0" ${!s.active ? "selected" : ""}>停用</option>`)}</div><div id="ctl-parameters"></div>${btn("新增參數", "ctl-param-add", "", "small")}<p>每個參數記錄一組本批測量／綜合判定。規格修改不回改已建立品檢單；最低抽樣量不會超過本批基本量。</p></form>`,
      formFooter(),
      true,
    );
    ctlRenderParameters();
    return;
  }
  if (a === "ctl-param-add" || a === "ctl-param-remove") {
    ctlCollectParameters();
    if (a === "ctl-param-add") {
      if (CT.parameters.length >= 30) throw Error("最多 30 個參數");
      CT.parameters.push({
        key: "parameter_" + (CT.parameters.length + 1),
        label: "新增參數",
        type: "number",
        lower: "0",
        upper: "1",
      });
    } else CT.parameters.splice(Number(id), 1);
    ctlRenderParameters();
    return;
  }
  if (a === "ctl-qi-new") {
    const docs = d.documents.filter(
      (x) =>
        ["order", "purchase"].includes(x.kind) &&
        ["approved", "partial"].includes(x.status),
    );
    modal(
      "選擇本批品檢來源",
      `<form id="modal-form" data-form="ctl-qi-source">${selectField(
        "已核准來源單據",
        "document_id",
        options(docs, (x) => x.no + " · " + x.partner_name, "id", ""),
      )}</form>`,
      formFooter("設定本批數量"),
    );
    return;
  }
  if (a === "ctl-qi-open") {
    const q = await controlApi("/api/controls/quality-inspections/" + id);
    CT = { inspection: q };
    modal(
      "品檢 · " + q.no,
      `<p>${E(q.source_no)} · ${E(ctlState[q.status])} · 單據修訂 ${q.document_version}</p>${q.status === "released" && !q.postable ? '<p class="form-error">來源或後續品檢已變更，不能沿用此放行單。</p>' : ""}<form id="modal-form" data-form="ctl-qi-readings">${ctlQiInputs(q)}${textarea("檢驗備註", "notes", q.notes)}</form><div class="actions">${q.status === "draft" && q.allowed.submit ? btn("送出判定", "ctl-qi-submit", "", "primary") : ""}${q.status === "passed" && q.allowed.approve ? btn("核准放行", "ctl-qi-approve", "", "primary") : ""}${q.postable && q.allowed.post && d.permissions.stock ? btn("使用此放行單進出貨", "ctl-qi-post", "", "primary") : ""}${!["consumed", "cancelled"].includes(q.status) && q.allowed.cancel ? btn("取消品檢", "ctl-qi-cancel", "", "danger") : ""}${d.quality_permissions?.create && ["failed", "cancelled"].includes(q.status) ? btn("另建一張重新檢驗", "ctl-qi-retest") : ""}</div>${table(
        ["動作", "人員", "時間"],
        q.events.map(
          (ev) =>
            `<tr><td>${E({ create: "建立", save: "保存讀值", submit: "送出判定", approve: "核准放行", cancel: "取消", consume: "進出貨" }[ev.action] || ev.action)}</td><td>${E(ev.actor_name)}</td><td>${E(ev.created_at)}</td></tr>`,
        ),
      )}`,
      q.status === "draft" && q.allowed.update
        ? formFooter("儲存讀值")
        : btn("關閉", "close"),
      true,
    );
    return;
  }
  if (a === "ctl-qi-retest") {
    const q = CT.inspection,
      source = await controlApi("/api/documents/" + q.document_id),
      r = await controlApi("/api/controls/quality-inspections", {
        document_id: source.id,
        document_version: source.version,
        lines: q.lines.map((l) => ({
          line_id: l.document_line_id,
          qty: inputQty(l.qty),
        })),
        notes: "重新檢驗，前次：" + q.no,
      });
    await refresh();
    await controlsAction("ctl-qi-open", r.id);
    return;
  }
  if (a === "ctl-qi-post") {
    const q = CT.inspection;
    await fulfilForm(q.document_id);
    $("#f-quality_inspection_id").value = q.id;
    for (const el of $$("[data-fulfil-line]"))
      el.value = inputQty(
        q.lines.find(
          (l) => l.document_line_id === Number(el.dataset.fulfilLine),
        )?.qty || 0,
      );
    return;
  }
  if (["ctl-qi-submit", "ctl-qi-approve"].includes(a)) {
    let q = CT.inspection;
    if (a === "ctl-qi-submit" && q.allowed.update) q = await ctlSaveReadings();
    const r = await controlApi(
      "/api/controls/quality-inspections/" + q.id + "/action",
      {
        action: a === "ctl-qi-submit" ? "submit" : "approve",
        version: q.version,
      },
    );
    closeModal();
    await refresh();
    await controlsAction("ctl-qi-open", r.id);
    return;
  }
  if (a === "ctl-qi-cancel" || a === "ctl-vendor-cancel") {
    CT.cancelTarget = a;
    modal(
      "取消控管單",
      `<form id="modal-form" data-form="ctl-cancel">${textarea("取消原因（必填）", "reason", "")}</form>`,
      formFooter("確認取消"),
    );
    return;
  }
  if (a === "ctl-vendor-search") {
    CT.vendorHeader = Object.fromEntries(
      new FormData($("#modal-form")).entries(),
    );
    CT.keptRows = CT.vendorRows.flatMap((r, i) =>
      $('[data-ctl-bill-select="' + i + '"]').checked
        ? [
            {
              ...r,
              selected: true,
              qty: $('[data-ctl-bill-qty="' + i + '"]').value,
              net: $('[data-ctl-bill-net="' + i + '"]').value,
              tax: $('[data-ctl-bill-tax="' + i + '"]').value,
            },
          ]
        : [],
    );
    await ctlVendorForm(CT.supplier_id, null, CT.vendorHeader.source_no);
    return;
  }
  if (a === "ctl-vendor-new") {
    const suppliers = d.partners.filter((p) =>
      ["supplier", "both"].includes(p.kind),
    );
    CT = { bill: {} };
    modal(
      "選擇請款供應商",
      `<form id="modal-form" data-form="ctl-vendor-source">${selectField("供應商", "supplier_id", options(suppliers, "name", "id", ""))}</form>`,
      formFooter("選進貨明細"),
    );
    return;
  }
  if (a === "ctl-vendor-open") {
    const b = await controlApi("/api/controls/vendor-bills/" + id);
    CT = { bill: b };
    modal(
      "三方核對 · " + b.no,
      `<p>憑證 ${E(b.invoice_ref)} · ${E(ctlState[b.status])} · 帳面核對 ${b.payment_valid ? "有效" : "尚未有效"}</p>${table(
        [
          "採購／進貨",
          "商品",
          "進貨未退／請款量",
          "帳面未稅／請款未稅",
          "帳面稅額／請款稅額",
        ],
        b.match.lines.map(
          (l) =>
            `<tr><td>${E(l.source.document_no)}<br>${E(l.source.receipt_no)}</td><td>${E(l.source.name)}</td><td>${Q(l.source.expected_qty)} / ${Q(l.qty)}</td><td>${money(l.source.expected_net, true)} / ${money(l.claimed_net, true)}</td><td>${money(l.source.expected_tax, true)} / ${money(l.claimed_tax, true)}</td></tr>`,
        ),
      )}<p class="${b.match.within_tolerance ? "hint" : "form-error"}">${b.match.within_tolerance ? "核對在容忍範圍內" : E(b.match.issues.join("；"))}</p>${b.status === "draft" && b.allowed.approve ? `<form id="modal-form" data-form="ctl-vendor-approve">${textarea("核准原因（必填）", "reason", "")}${selectField("接受容忍範圍內的差額", "accept_variance", '<option value="0">尚未確認</option><option value="1">已核對，接受差額（不自動改帳）</option>')}</form>` : ""}<div class="actions">${b.status === "draft" && b.allowed.update ? btn("修改請款明細", "ctl-vendor-edit", b.id) : ""}${b.status !== "cancelled" && b.allowed.cancel ? btn("取消核對／請款", "ctl-vendor-cancel", "", "danger") : ""}</div><p>核准不會重複立應付；付款仍依 ERP 帳款餘額。取消不會沖銷既有付款。來源退貨／折讓後，請取消舊核對並依新餘額重新建單。</p>${table(
        ["動作", "人員", "時間"],
        b.events.map(
          (ev) =>
            `<tr><td>${E({ save: "保存", approve: "核准", cancel: "取消" }[ev.action])}</td><td>${E(ev.actor_name)}</td><td>${E(ev.created_at)}</td></tr>`,
        ),
      )}`,
      b.status === "draft" && b.allowed.approve
        ? formFooter("核准請款")
        : btn("關閉", "close"),
      true,
    );
    return;
  }
  if (a === "ctl-vendor-edit") {
    const b = await controlApi("/api/controls/vendor-bills/" + id);
    CT = { bill: b };
    await ctlVendorForm(b.supplier_id, b);
    return;
  }
}
async function ctlSaveReadings() {
  const q = CT.inspection,
    b = {
      version: q.version,
      notes: $("#f-notes").value,
      lines: q.lines
        .filter((l) => l.spec_id)
        .map((l) => ({
          id: l.id,
          sampled_qty: $('[name="sample_' + l.id + '"]').value,
          readings: Object.fromEntries(
            l.definition.parameters.map((p) => [
              p.key,
              $('[name="reading_' + l.id + "_" + p.key + '"]').value,
            ]),
          ),
        })),
    };
  const r = await controlApi(
    "/api/controls/quality-inspections/" + q.id + "/save",
    b,
  );
  CT.inspection = r;
  return r;
}
async function ctlVendorForm(supplierId, old, sourceNo = "") {
  CT.supplier_id = Number(supplierId);
  const sources = old
    ? []
    : await controlApi(
        "/api/controls/vendor-sources?" +
          new URLSearchParams({
            supplier_id: String(supplierId),
            source_no: sourceNo,
          }),
      );
  const kept = CT.keptRows || [];
  const rows = old
    ? old.match.lines.map((l) => ({
        source: l.source,
        qty: inputQty(l.qty),
        net: inputMoney(l.claimed_net),
        tax: inputMoney(l.claimed_tax),
        selected: true,
      }))
    : [
        ...kept,
        ...sources
          .filter((s) => !kept.some((r) => r.source.id === s.id))
          .map((s) => ({
            source: s,
            qty: inputQty(s.expected_qty),
            net: inputMoney(s.expected_net),
            tax: inputMoney(s.expected_tax),
            selected: false,
          })),
      ];
  const header = CT.vendorHeader || {
    invoice_ref: old?.invoice_ref || "",
    date: old?.date || S.data.today,
    total: old ? inputMoney(old.total) : "",
    notes: old?.notes || "",
  };
  CT.vendorRows = rows;
  modal(
    "供應商請款憑證",
    `<form id="modal-form" data-form="ctl-vendor"><div class="form-grid">${field("供應商憑證號（同供應商不可重複）", "invoice_ref", header.invoice_ref, "text", 'required maxlength="100"')}${field("憑證日期", "date", header.date, "date", "required")}${field("憑證總額（須等於選取列合計）", "total", header.total, "number", 'required min="0.01" step="0.01"')}</div><p>每張進貨單需選全部未退明細。可合併多張進貨；若要分批請款，請先分批進貨。查詢最多顯示 500 筆來源，已勾選列會保留。</p><div class="form-grid">${field("查更舊來源：輸入完整採購或進貨單號", "source_no", sourceNo, "text", 'maxlength="100"')}</div>${btn("查詢並加入來源", "ctl-vendor-search", "", "small")}${table(
      ["選取", "進貨／採購", "商品", "請款數量", "未稅金額", "稅額"],
      rows.map(
        (r, i) =>
          `<tr><td><input type="checkbox" data-ctl-bill-select="${i}" ${r.selected ? "checked" : ""} aria-label="選取第 ${i + 1} 列"></td><td>${E(r.source.receipt_no)}<br>${E(r.source.document_no)}</td><td>${E(r.source.sku)} · ${E(r.source.name)}</td><td><input data-ctl-bill-qty="${i}" value="${E(r.qty)}" type="number" step="0.001" min="0.001" style="width:95px" aria-label="第 ${i + 1} 列數量"></td><td><input data-ctl-bill-net="${i}" value="${E(r.net)}" type="number" step="0.01" min="0" style="width:110px" aria-label="第 ${i + 1} 列未稅"></td><td><input data-ctl-bill-tax="${i}" value="${E(r.tax)}" type="number" step="0.01" min="0" style="width:95px" aria-label="第 ${i + 1} 列稅額"></td></tr>`,
      ),
    )}${textarea("請款備註", "notes", header.notes)}</form>`,
    formFooter("儲存並核對"),
    true,
  );
}
async function controlsSubmit(kind, b) {
  if (ctlSession()) throw Error("帳套或帳號已切換，請重新開啟作業");
  if (kind === "ctl-spec") {
    ctlCollectParameters();
    await controlApi("/api/controls/quality-specs", {
      ...b,
      id: CT.spec.id,
      version: CT.spec.version,
      forbid_self_release: b.forbid_self_release === "1",
      parameters: CT.parameters,
    });
  }
  if (kind === "ctl-policy")
    await controlApi("/api/controls/procurement-policy", {
      ...b,
      require_matching: b.require_matching === "1",
      forbid_self_approval: b.forbid_self_approval === "1",
    });
  if (kind === "ctl-qi-source") {
    const source = await controlApi("/api/documents/" + b.document_id);
    CT = { source };
    modal(
      "本批待驗數量",
      `<form id="modal-form" data-form="ctl-qi-create"><p>${E(source.no)} · 來源修訂 ${source.version}</p>${table(
        ["商品", "本批數量（交易單位）"],
        source.lines
          .filter((l) => l.qty - l.done_qty - l.closed_qty > 0)
          .map(
            (l) =>
              `<tr><td>${E(l.sku)} · ${E(l.name)} · ${E(l.unit)}</td><td><input type="number" data-ctl-qi-line="${l.id}" value="${inputQty(l.qty - l.done_qty - l.closed_qty)}" min="0" max="${inputQty(l.qty - l.done_qty - l.closed_qty)}" step="0.001" style="width:110px" aria-label="${E(l.name)}待驗數量"></td></tr>`,
          ),
      )}${textarea("本批備註", "notes", "")}</form>`,
      formFooter("建立品檢單"),
      true,
    );
    return;
  }
  if (kind === "ctl-qi-create") {
    const r = await controlApi("/api/controls/quality-inspections", {
      document_id: CT.source.id,
      document_version: CT.source.version,
      lines: $$("[data-ctl-qi-line]").map((el) => ({
        line_id: Number(el.dataset.ctlQiLine),
        qty: el.value,
      })),
      notes: b.notes,
    });
    closeModal();
    await refresh();
    await controlsAction("ctl-qi-open", r.id);
    return;
  }
  if (kind === "ctl-qi-readings") {
    const r = await ctlSaveReadings();
    closeModal();
    await refresh();
    await controlsAction("ctl-qi-open", r.id);
    return;
  }
  if (kind === "ctl-cancel") {
    const quality = CT.cancelTarget === "ctl-qi-cancel",
      r = quality ? CT.inspection : CT.bill;
    await controlApi(
      "/api/controls/" +
        (quality ? "quality-inspections" : "vendor-bills") +
        "/" +
        r.id +
        "/action",
      { version: r.version, action: "cancel", reason: b.reason },
    );
  }
  if (kind === "ctl-vendor-source") {
    await ctlVendorForm(b.supplier_id);
    return;
  }
  if (kind === "ctl-vendor") {
    const rows = CT.vendorRows,
      selected = $$("[data-ctl-bill-select]:checked").map((el) =>
        Number(el.dataset.ctlBillSelect),
      );
    const r = await controlApi("/api/controls/vendor-bills", {
      ...b,
      supplier_id: CT.supplier_id,
      id: CT.bill?.id,
      version: CT.bill?.version,
      lines: selected.map((i) => ({
        receipt_line_id: rows[i].source.id,
        qty: $('[data-ctl-bill-qty="' + i + '"]').value,
        net: $('[data-ctl-bill-net="' + i + '"]').value,
        tax: $('[data-ctl-bill-tax="' + i + '"]').value,
      })),
    });
    closeModal();
    await refresh();
    await controlsAction("ctl-vendor-open", r.id);
    return;
  }
  if (kind === "ctl-vendor-approve") {
    const r = CT.bill;
    await controlApi("/api/controls/vendor-bills/" + r.id + "/action", {
      action: "approve",
      version: r.version,
      token: r.match.token,
      reason: b.reason,
      accept_variance: b.accept_variance === "1",
    });
    closeModal();
    await refresh();
    await controlsAction("ctl-vendor-open", r.id);
    return;
  }
  closeModal();
  await refresh();
  toast("控管資料已儲存");
}
