const FM = globalThis.ERPFormModel;
let FD = { mode: "list", selected: 0, dirty: false };
const formStatus = { draft: "草稿", submitted: "已送出", cancelled: "已取消" };
function formLink(path) {
  return (
    path +
    (path.includes("?") ? "&" : "?") +
    "company=" +
    encodeURIComponent(S.company || "default")
  );
}
function formSelect(label, key, current, choices, attrs = "") {
  return `<label class="fd-control">${E(label)}<select data-fd-prop="${E(key)}" ${attrs}>${Object.entries(
    choices,
  )
    .map(
      ([v, n]) =>
        `<option value="${E(v)}" ${String(current) === v ? "selected" : ""}>${E(n)}</option>`,
    )
    .join("")}</select></label>`;
}
function formInput(label, key, value, type = "text", attrs = "") {
  return `<label class="fd-control">${E(label)}<input data-fd-prop="${E(key)}" type="${type}" value="${E(value ?? "")}" ${attrs}></label>`;
}
function formTextarea(label, key, value) {
  return `<label class="fd-control">${E(label)}<textarea data-fd-prop="${E(key)}" rows="3" maxlength="8000">${E(value || "")}</textarea></label>`;
}
function formsPage() {
  const userKey = S.company + ":" + S.data.user.id;
  if (FD.userKey !== userKey)
    FD = { mode: "list", selected: 0, dirty: false, userKey };
  if (FD.mode === "design") return formDesignPage();
  if (FD.mode === "entry") return formEntryPage();
  const d = S.data;
  return (
    head(
      "表單設計與填寫",
      "建立各種企業格式，或由報價、訂單、採購單帶入資料列印。",
      d.form_permissions?.design
        ? btn("新增版型", "form-new", "", "primary", "plus") +
            btn("匯入版型", "form-import")
        : "",
      "FORMS",
    ) +
    `<p class="hint">範本僅保存版面與欄位。工作報告、案件清單及費用記錄不會自動產生交易或會計分錄。</p>` +
    panel(
      "表單範本",
      table(
        ["名稱", "資料來源", "修訂", "狀態", "操作"],
        (d.form_templates || []).map(
          (t) =>
            `<tr><td>${E(t.name)}</td><td>${E(FM.kinds[t.kind])}</td><td>${t.version}</td><td>${t.active ? "使用中" : "已停用"}</td><td><div class="fd-actions">${t.kind === "free" && t.active && t.allowed?.fill && d.form_permissions.fill ? btn("填寫", "form-fill", t.id, "small") : ""}${d.form_permissions.print && t.allowed?.print ? `<a class="btn small" target="_blank" rel="noopener" href="${formLink("/print/form-templates/" + t.id)}">空白列印</a>` : ""}${d.form_permissions.edit && t.allowed?.update ? btn("編輯版型", "form-edit", t.id, "small") : ""}${d.form_permissions.design ? btn("複製", "form-copy", t.id, "small") : ""}${d.form_permissions.export && t.allowed?.export ? btn("匯出版型", "form-export", t.id, "small") : ""}</div></td></tr>`,
        ),
      ),
    ) +
    panel(
      "填寫紀錄",
      table(
        ["表單編號", "標題", "狀態", "範本修訂", "操作"],
        (d.form_entries || []).map(
          (r) =>
            `<tr><td>${E(r.no)}</td><td>${E(r.title)}</td><td>${E(formStatus[r.status])}</td><td>${r.template_version}</td><td>${btn("開啟", "form-entry", r.id, "small")}${d.form_permissions.entry_print && r.allowed?.print ? `<a class="btn small" target="_blank" rel="noopener" href="${formLink("/print/form-entries/" + r.id)}">列印</a>` : ""}</td></tr>`,
        ),
      ),
      "最多顯示最新 500 筆本人或授權範圍內的紀錄。",
    )
  );
}
function formDesignPage() {
  const d = FD.template.definition,
    p = d.page,
    b = d.blocks[FD.selected];
  const props = b ? formBlockProperties(b) : "<p>先選取左側區塊。</p>";
  queueMicrotask(formRenderPreview);
  return (
    head(
      "編排表單",
      FD.dirty ? "有尚未儲存的修改" : "拖曳調整順序，或使用上下移動按鈕。",
      btn("返回清單", "form-list") +
        btn("預覽", "form-preview") +
        btn("儲存版型", "form-save", "", "primary", "check"),
      "FORM DESIGNER",
    ) +
    `<div id="form-design-error" class="form-error" role="alert"></div><div class="fd-settings">${formInput("版型名稱", "name", FD.template.name)}${formSelect("來源類型", "kind", d.kind, FM.kinds, FD.template.id ? "disabled" : "")}${formSelect("紙型", "paper", p.paper, { a4: "A4", a5: "A5", letter: "Letter", custom: "自訂尺寸" })}${formSelect("方向", "orientation", p.orientation, { portrait: "直式", landscape: "橫式" })}${p.paper === "custom" ? formInput("紙寬 mm", "width", p.width, "number", 'min="80" max="420"') + formInput("紙高 mm", "height", p.height, "number", 'min="100" max="594"') : ""}${formInput("頁邊距 mm", "margin", p.margin, "number", 'min="6" max="30"')}${formInput("預設字級 pt", "font", p.font, "number", 'min="9" max="18"')}${formInput("框線顏色", "accent", p.accent, "color")}${formSelect("使用狀態", "active", FD.template.active === false ? "0" : "1", { 1: "使用中", 0: "停用（舊紀錄保留）" })}</div>
    <div class="fd-designer"><section class="panel fd-palette"><h2>版面區塊</h2><div class="fd-add">${Object.entries(
      FM.types,
    )
      .map(([k, n]) => btn("+ " + n, "form-add", k, "small"))
      .join(
        "",
      )}</div><ol class="fd-blocks">${d.blocks.map((x, i) => `<li draggable="true" data-fd-drag="${i}" class="${i === FD.selected ? "selected" : ""}"><button type="button" data-action="form-select" data-id="${i}"><strong>${i + 1}. ${E(FM.types[x.type])}</strong><span>${E(x.label || x.text || x.binding || "未命名")}</span><small>${x.span || 12}/12 欄</small></button></li>`).join("")}</ol></section><section class="panel fd-preview-panel"><h2>列印版面預覽</h2><label class="fd-control">預覽縮放<select id="fd-zoom"><option value="fit">符合視窗寬度</option><option value="actual" ${FD.zoom === "actual" ? "selected" : ""}>100% 實際尺寸</option></select></label><p class="hint">長表格列印時自動分頁，欄名會重複顯示。</p><iframe id="fd-preview" title="表單即時預覽" sandbox=""></iframe></section><section class="panel fd-properties"><h2>區塊設定</h2>${props}</section></div>`
  );
}
function formBlockProperties(b) {
  const custom = b.type === "field" && !b.binding;
  return `<div data-fd-block>${formInput("欄位識別碼（填寫後請勿更改）", "id", b.id)}${formInput("標籤", "label", b.label)}${!["table", "pagebreak"].includes(b.type) ? formInput("寬度（1–12 欄）", "span", b.span, "number", 'min="1" max="12"') : ""}${formInput("最小高度 mm", "min_height", b.min_height, "number", 'min="0" max="100"')}${formInput("字級 pt", "font", b.font, "number", 'min="8" max="36"')}${formSelect("對齊", "align", b.align, { left: "靠左", center: "置中", right: "靠右" })}${formSelect("粗體", "bold", String(b.bold), { false: "一般", true: "粗體" })}${formSelect("框線", "border", String(b.border), { false: "無框", true: "有框" })}
    ${["text", "signature"].includes(b.type) ? formTextarea("顯示文字", "text", b.text) : ""}
    ${b.type === "field" ? formSelect("欄位來源", "binding", b.binding, { "": "自行填寫", ...Object.fromEntries(Object.entries(FM.bindings).filter(([k]) => FD.template.definition.kind !== "free" || k.startsWith("company."))) }) : ""}
    ${custom ? formFieldProperties(b) : ""}
    ${b.type === "image" ? `<label class="fd-control">PNG／JPEG 圖片（250 KB 以內）<input id="fd-image" type="file" accept="image/png,image/jpeg"></label>${btn("清除圖片", "form-image-clear", "", "small")}` : ""}
    ${b.type === "table" ? formSelect("表格來源", "source", b.source, FD.template.definition.kind === "free" ? { custom: "自行填寫" } : { custom: "自行填寫", lines: "來源單據明細" }) + formInput("至少保留空白列", "blank_rows", b.blank_rows, "number", 'min="0" max="40"') + formInput("每列最小高度 mm", "row_height", b.row_height, "number", 'min="5" max="40"') + `<div id="fd-columns">${b.columns.map((c, i) => `<details data-fd-column="${i}"><summary>${i + 1}. ${E(c.label)}</summary>${formInput("欄位識別碼", "id", c.id)}${formInput("欄名", "label", c.label)}${formInput("相對欄寬", "width", c.width, "number", 'min="1" max="100"')}${formSelect("對齊", "align", c.align, { left: "靠左", center: "置中", right: "靠右" })}${b.source === "lines" ? formSelect("明細欄位", "binding", c.binding, FM.lineBindings) : formFieldProperties(c)}<div class="fd-actions">${btn("左移", "form-column-up", i, "small")}${btn("右移", "form-column-down", i, "small")}${btn("移除欄", "form-column-remove", i, "small danger")}</div></details>`).join("")}</div>${btn("新增表格欄", "form-column-add", "", "small")}` : ""}
    <div class="fd-actions">${btn("上移", "form-up", "", "small")}${btn("下移", "form-down", "", "small")}${btn("複製區塊", "form-block-copy", "", "small")}${btn("移除區塊", "form-remove", "", "small danger")}</div></div>`;
}
function formFieldProperties(c) {
  return (
    formSelect("輸入型別", "input_type", c.input_type, FM.inputTypes) +
    formSelect("送出時必填", "required", String(c.required), {
      false: "選填",
      true: "必填",
    }) +
    (c.input_type === "choice"
      ? formTextarea(
          "選項（每行一個）",
          "options",
          (c.options || []).join("\n"),
        )
      : "")
  );
}
function formPreviewContext() {
  return {
    "company.name": S.data.settings.company,
    "company.address": S.data.settings.address,
    "company.phone": S.data.settings.phone,
    "company.tax_id": S.data.settings.tax_id,
  };
}
function formRenderPreview() {
  const iframe = $("#fd-preview");
  if (!iframe || FD.mode !== "design") return;
  try {
    const d = FM.validate(FD.template.definition);
    iframe.srcdoc = FM.render(d, {}, formPreviewContext(), {
      title: FD.template.name,
      script: false,
      toolbar: false,
      previewScale:
        FD.zoom === "actual"
          ? 1
          : Math.min(
              1,
              (iframe.clientWidth - 20) /
                (((d.page.orientation === "landscape"
                  ? d.page.height
                  : d.page.width) *
                  96) /
                  25.4),
            ),
    });
    $("#form-design-error").textContent = "";
  } catch (e) {
    $("#form-design-error").textContent = e.message;
  }
}
function formChanged() {
  FD.dirty = true;
  formRenderPreview();
}
function formUniqueId(prefix = "field") {
  return prefix + "_" + crypto.randomUUID().replaceAll("-", "").slice(0, 8);
}
function formDownload(filename, data) {
  const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    ),
    a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function formInputControl(c, value, key, disabled = false) {
  const common = `data-form-value="${E(key)}" ${disabled ? "disabled" : ""} aria-label="${E(c.label)}"`;
  if (c.input_type === "textarea")
    return `<textarea ${common} maxlength="8000" rows="3">${E(value || "")}</textarea>`;
  if (c.input_type === "choice")
    return `<select ${common}><option value="">請選擇</option>${(c.options || []).map((v) => `<option ${value === v ? "selected" : ""}>${E(v)}</option>`).join("")}</select>`;
  if (c.input_type === "checkbox")
    return `<input ${common} type="checkbox" ${value === true ? "checked" : ""}>`;
  return `<input ${common} type="${c.input_type === "date" ? "date" : c.input_type === "number" ? "number" : "text"}" ${c.input_type === "number" ? 'step="any"' : ""} value="${E(value || "")}" maxlength="1000">`;
}
function formEntryPage() {
  const r = FD.entry,
    locked =
      (r.status && r.status !== "draft") ||
      !(r.id ? r.allowed?.update : S.data.form_permissions.fill);
  const fields = r.definition.blocks.filter(
    (b) =>
      (b.type === "field" && !b.binding) ||
      (b.type === "table" && b.source === "custom"),
  );
  const actions =
    btn("返回清單", "form-list") +
    (r.id ? btn("歷程", "form-entry-history", r.id) : "") +
    (r.id && r.allowed?.print
      ? `<a class="btn" target="_blank" rel="noopener" href="${formLink("/print/form-entries/" + r.id)}">列印／PDF</a>`
      : "") +
    (!locked ? btn("儲存草稿", "form-entry-save", "", "primary") : "") +
    (r.id && r.status === "draft" && r.allowed?.submit
      ? btn("確認送出", "form-entry-submit")
      : "") +
    (r.id && r.status !== "cancelled" && r.allowed?.cancel
      ? btn("取消紀錄", "form-entry-cancel", "", "danger")
      : "");
  return (
    head(
      r.no || "填寫表單",
      `範本修訂 ${r.template_version} · ${formStatus[r.status || "draft"]} · 送出後內容鎖定，保留原版面與歷程。`,
      actions,
      "FORM ENTRY",
    ) +
    `<section class="panel fd-entry"><label class="fd-control">紀錄標題<input id="form-entry-title" maxlength="120" value="${E(r.title)}" ${locked ? "disabled" : ""}></label><div class="fd-entry-grid">${fields.map((b) => (b.type === "field" ? `<label class="fd-control" style="grid-column:span ${b.span > 6 ? 2 : 1}">${E(b.label)}${b.required ? " *" : ""}${formInputControl(b, r.values[b.id], b.id, locked)}</label>` : `<section class="fd-entry-table"><h3>${E(b.label || "明細")}</h3><div class="table-wrap"><table><thead><tr>${b.columns.map((c) => `<th>${E(c.label)}${c.required ? " *" : ""}</th>`).join("")}${locked ? "" : "<th>操作</th>"}</tr></thead><tbody>${(r.values[b.id] || []).map((row, i) => `<tr>${b.columns.map((c) => `<td>${formInputControl(c, row[c.id], b.id + ":" + i + ":" + c.id, locked)}</td>`).join("")}${locked ? "" : `<td>${btn("移除", "form-entry-row-remove", b.id + ":" + i, "small danger")}</td>`}</tr>`).join("")}</tbody></table></div>${locked ? "" : btn("新增一列", "form-entry-row-add", b.id, "small", "plus")}</section>`)).join("")}</div><p class="hint">空白明細不會自動加入填寫資料；需要填寫時請新增一列。各費用、金額及里程是填寫紀錄，需自行核對。</p><div class="form-error" role="alert" id="form-entry-error"></div></section>`
  );
}
function formCollectEntry() {
  FD.entry.title = $("#form-entry-title")?.value ?? FD.entry.title;
  for (const el of $$("[data-form-value]")) {
    const parts = el.dataset.formValue.split(":"),
      v = el.type === "checkbox" ? el.checked : el.value;
    if (parts.length === 1) FD.entry.values[parts[0]] = v;
    else FD.entry.values[parts[0]][Number(parts[1])][parts[2]] = v;
  }
}
async function formsAction(action, id) {
  const blocks = FD.template?.definition.blocks,
    b = blocks?.[FD.selected];
  if (action === "form-list") {
    if (FD.dirty && !window.confirm("有尚未儲存的修改，確定離開？")) return;
    FD.mode = "list";
    FD.dirty = false;
    await refresh();
    return;
  }
  if (action === "form-new") {
    modal(
      "選擇起始版型",
      `<div class="fd-presets">${FM.presets()
        .map((p) => btn(p.name, "form-preset", p.key))
        .join(
          "",
        )}${btn("空白自訂表單", "form-preset", "blank")}</div><p>可調整文字、欄位、明細、空白列、圖片與簽核區。內建版型不包含任何企業專用條款。</p>`,
    );
    return;
  }
  if (action === "form-preset") {
    const p = FM.presets().find((p) => p.key === id);
    FD.template = {
      name: p?.name || "自訂表單",
      definition: p?.definition || FM.validate(FM.starter()),
      active: true,
    };
    FD.mode = "design";
    FD.selected = 0;
    FD.dirty = true;
    closeModal();
    navigate("forms");
    return;
  }
  if (["form-edit", "form-copy"].includes(action)) {
    const t = await api("/api/form-templates/" + id);
    FD.template = { ...t, active: !!t.active };
    if (action === "form-copy") {
      delete FD.template.id;
      delete FD.template.version;
      FD.template.name += " 副本";
    }
    FD.mode = "design";
    FD.selected = 0;
    FD.dirty = action === "form-copy";
    navigate("forms");
    return;
  }
  if (action === "form-save") {
    const t = FD.template,
      definition = FM.validate(t.definition);
    FD.template = await api("/api/form-templates", { ...t, definition });
    FD.template.active = !!FD.template.active;
    FD.dirty = false;
    await refresh();
    toast("版型已儲存，舊填寫紀錄仍保留原修訂");
    return;
  }
  if (action === "form-select") {
    FD.selected = Number(id);
    render();
    return;
  }
  if (action === "form-preview") {
    const r = await api("/api/form-preview", {
      id: FD.template.id,
      name: FD.template.name,
      definition: FM.validate(FD.template.definition),
    });
    modal(
      "版型預覽",
      '<iframe id="form-preview-large" class="fd-large-preview" title="完整表單預覽" sandbox=""></iframe>',
      btn("關閉", "close"),
      true,
    );
    $("#form-preview-large").srcdoc = r.html;
    return;
  }
  if (action === "form-add") {
    const block = {
      id: formUniqueId(id),
      type: id,
      span: 12,
      label: FM.types[id],
      text: id === "text" ? "輸入文字" : "",
      binding: "",
      input_type: "text",
      font: FD.template.definition.page.font,
      min_height: 8,
      align: "left",
      source: "custom",
      blank_rows: 5,
      row_height: 9,
      columns: [
        { id: "description", label: "內容", width: 1, input_type: "textarea" },
      ],
    };
    blocks.push(block);
    FD.template.definition = FM.validate(FD.template.definition);
    FD.selected = blocks.length - 1;
    FD.dirty = true;
    render();
    return;
  }
  if (["form-up", "form-down"].includes(action)) {
    const to = FD.selected + (action === "form-up" ? -1 : 1);
    if (to >= 0 && to < blocks.length) {
      blocks.splice(to, 0, blocks.splice(FD.selected, 1)[0]);
      FD.selected = to;
      FD.dirty = true;
      render();
    }
    return;
  }
  if (action === "form-remove") {
    if (blocks.length === 1) throw new Error("至少保留一個區塊");
    blocks.splice(FD.selected, 1);
    FD.selected = Math.min(FD.selected, blocks.length - 1);
    FD.dirty = true;
    render();
    return;
  }
  if (action === "form-block-copy") {
    const c = structuredClone(b);
    c.id = formUniqueId(b.type);
    blocks.splice(FD.selected + 1, 0, c);
    FD.selected++;
    FD.dirty = true;
    render();
    return;
  }
  if (action === "form-image-clear") {
    b.src = "";
    formChanged();
    return;
  }
  if (action.startsWith("form-column-")) {
    const i = Number(id),
      cs = b.columns;
    if (action === "form-column-add") {
      if (cs.length >= 12) throw new Error("最多 12 欄");
      cs.push({
        id: formUniqueId("column"),
        label: "新欄位",
        width: 1,
        align: "left",
        input_type: "text",
        required: false,
        options: [],
        ...(b.source === "lines" ? { binding: "name" } : {}),
      });
    }
    if (action === "form-column-remove") {
      if (cs.length === 1) throw new Error("至少保留一欄");
      cs.splice(i, 1);
    }
    const to = i + (action === "form-column-up" ? -1 : 1);
    if (
      ["form-column-up", "form-column-down"].includes(action) &&
      to >= 0 &&
      to < cs.length
    )
      cs.splice(to, 0, cs.splice(i, 1)[0]);
    FD.dirty = true;
    render();
    return;
  }
  if (action === "form-export") {
    const t = await api("/api/form-templates/" + id + "/export");
    formDownload("erp-form-template.json", t);
    return;
  }
  if (action === "form-import") {
    modal(
      "匯入表單版型",
      `<p>選擇本系統匯出的 JSON 版型檔。舊 Word／Excel 表單請使用起始範本重建欄位與版面。</p><input id="form-import-file" type="file" accept=".json,application/json" aria-label="版型檔案"><p>匯入後先進入編輯預覽，按儲存才會建立新範本。</p>`,
    );
    return;
  }
  if (action === "form-fill") {
    const t = await api("/api/form-templates/" + id);
    FD.entry = {
      template_id: t.id,
      template_version: t.version,
      title: t.name,
      definition: t.definition,
      values: {},
      status: "draft",
    };
    FD.mode = "entry";
    FD.dirty = false;
    navigate("forms");
    return;
  }
  if (action === "form-entry") {
    FD.entry = await api("/api/form-entries/" + id);
    FD.mode = "entry";
    FD.dirty = false;
    navigate("forms");
    return;
  }
  if (action === "form-entry-row-add") {
    formCollectEntry();
    const rows = (FD.entry.values[id] ||= []);
    if (rows.length >= 200) throw new Error("最多 200 列");
    rows.push({});
    FD.dirty = true;
    render();
    return;
  }
  if (action === "form-entry-row-remove") {
    formCollectEntry();
    const [key, index] = id.split(":");
    FD.entry.values[key].splice(Number(index), 1);
    FD.dirty = true;
    render();
    return;
  }
  if (["form-entry-save", "form-entry-submit"].includes(action)) {
    formCollectEntry();
    const r = FD.entry;
    FM.validateValues(r.definition, r.values, action === "form-entry-submit");
    if (!r.id || r.allowed?.update)
      FD.entry = await api("/api/form-entries", {
        id: r.id,
        version: r.version,
        template_id: r.template_id,
        template_version: r.template_version,
        title: r.title,
        values: r.values,
      });
    FD.dirty = false;
    if (action === "form-entry-submit")
      FD.entry = await api("/api/form-entries/" + FD.entry.id + "/submit", {
        version: FD.entry.version,
      });
    await refresh();
    toast(action === "form-entry-save" ? "草稿已儲存" : "表單已送出，內容鎖定");
    return;
  }
  if (action === "form-entry-history") {
    const data = await api("/api/form-entries/" + id + "/history");
    modal(
      "填寫歷程",
      table(
        ["修訂", "動作", "時間 UTC", "內容"],
        data.events.map(
          (x) =>
            `<tr><td>${x.version}</td><td>${E({ save: "保存", submit: "送出", cancel: "取消" }[x.action])}</td><td>${E(x.created_at)}</td><td><details><summary>查看內容</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${E(JSON.stringify(x.detail, null, 2))}</pre></details></td></tr>`,
        ),
      ),
      btn("關閉", "close"),
      true,
    );
    return;
  }
  if (action === "form-entry-cancel") {
    modal(
      "取消填寫紀錄",
      `<form id="form-cancel" data-form="forms-cancel">${textarea("取消原因（必填）", "reason")}</form>`,
      formFooter("確認取消", "form-cancel"),
    );
    return;
  }
  if (action === "form-doc-print") {
    const doc = await api("/api/documents/" + id),
      ts = (S.data.form_templates || []).filter(
        (t) =>
          t.active &&
          t.kind === doc.kind &&
          t.allowed?.print &&
          S.data.form_permissions.print,
      );
    const preset=await api('/api/enterprise/delivery/resolve?document_id='+doc.id);
    if(preset.template_id){const chosen=ts.find(t=>t.id===preset.template_id);if(chosen)ts.splice(ts.indexOf(chosen),1),ts.unshift({...chosen,name:'預設 · '+chosen.name+' ('+preset.locale+')'});}
    modal(
      "選擇列印版型",
      ts.length
        ? `<div class="fd-presets">${ts.map((t) => `<a class="btn" target="_blank" rel="noopener" href="${formLink("/print/form-templates/" + t.id + "?document_id=" + doc.id)}">${E(t.name)} · 修訂 ${t.version}</a>`).join("")}</div>`
        : "<p>尚無相符版型，請至「表單設計與填寫」新增此類交易版型。</p>",
    );
    return;
  }
}
async function formsSubmit(kind, b) {
  if (kind === "forms-cancel") {
    const row = FD.entry;
    FD.entry = await api("/api/form-entries/" + row.id + "/cancel", {
      version: row.version,
      reason: b.reason,
    });
    FD.dirty = false;
    closeModal();
    await refresh();
  }
}
document.addEventListener("input", (ev) => {
  if (ev.target.matches("[data-form-value],#form-entry-title")) FD.dirty = true;
  const el = ev.target;
  if (!el.dataset.fdProp || FD.mode !== "design") return;
  const k = el.dataset.fdProp,
    col = el.closest("[data-fd-column]"),
    inBlock = !!el.closest("[data-fd-block]");
  let target;
  if (col)
    target =
      FD.template.definition.blocks[FD.selected].columns[
        Number(col.dataset.fdColumn)
      ];
  else if (inBlock) target = FD.template.definition.blocks[FD.selected];
  else if (k === "name" || k === "active") target = FD.template;
  else if (k === "kind") target = FD.template.definition;
  else target = FD.template.definition.page;
  let value = el.value;
  if (el.type === "number") value = Number(value);
  if (["bold", "border", "required"].includes(k)) value = value === "true";
  if (k === "active") value = value === "1";
  if (k === "options") value = value.split("\n");
  target[k] = value;
  formChanged();
});
document.addEventListener("change", async (ev) => {
  try {
    const el = ev.target,
      k = el.dataset.fdProp;
    if (el.id === "fd-zoom") {
      FD.zoom = el.value;
      formRenderPreview();
      return;
    }
    if (k && ["paper", "kind", "binding", "input_type", "source"].includes(k)) {
      const b = FD.template.definition.blocks[FD.selected];
      if (k === "input_type" && el.value === "choice") {
        const col = el.closest("[data-fd-column]"),
          target = col ? b.columns[Number(col.dataset.fdColumn)] : b;
        if (!target.options?.length) target.options = ["選項一", "選項二"];
      }
      if (k === "source")
        b.columns = b.columns.map((c) => ({
          ...c,
          ...(b.source === "lines"
            ? { binding: "name" }
            : { input_type: "text", required: false, options: [] }),
        }));
      if (k === "kind") {
        FD.template.definition = FM.validate(FM.starter(el.value));
        FD.selected = 0;
      }
      render();
    }
    if (el.id === "fd-image") {
      const f = el.files[0];
      if (!f) return;
      if (f.size > 250000) throw new Error("請選擇 250 KB 以內圖片");
      const src = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(f);
      });
      const draft = structuredClone(FD.template.definition);
      draft.blocks[FD.selected].src = src;
      FD.template.definition = FM.validate(draft);
      formChanged();
    }
    if (el.id === "form-import-file") {
      const f = el.files[0];
      if (!f) return;
      if (f.size > 750000) throw new Error("版型檔過大");
      const data = JSON.parse(await f.text());
      if (
        data.format !== "erp-form-template" ||
        data.version !== 1 ||
        typeof data.name !== "string" ||
        data.name.length > 100
      )
        throw new Error("不是支援的版型檔");
      FD.template = {
        name: data.name,
        definition: FM.validate(data.definition),
        active: true,
      };
      FD.mode = "design";
      FD.selected = 0;
      FD.dirty = true;
      closeModal();
      navigate("forms");
    }
  } catch (e) {
    toast(e.message, true);
  }
});
document.addEventListener("dragstart", (ev) => {
  const li = ev.target.closest("[data-fd-drag]");
  if (li)
    ev.dataTransfer.setData("text/plain", "erp-block:" + li.dataset.fdDrag);
});
document.addEventListener("dragover", (ev) => {
  if (ev.target.closest("[data-fd-drag]")) ev.preventDefault();
});
document.addEventListener("drop", (ev) => {
  const li = ev.target.closest("[data-fd-drag]");
  if (!li || FD.mode !== "design") return;
  ev.preventDefault();
  const str = ev.dataTransfer.getData("text/plain");
  if (!/^erp-block:\d+$/.test(str)) return;
  const from = Number(str.split(":")[1]),
    to = Number(li.dataset.fdDrag),
    blocks = FD.template.definition.blocks;
  if (from >= blocks.length) return;
  blocks.splice(to, 0, blocks.splice(from, 1)[0]);
  FD.selected = to;
  FD.dirty = true;
  render();
});
window.addEventListener("beforeunload", (ev) => {
  if (FD.dirty) {
    ev.preventDefault();
    ev.returnValue = "";
  }
});

let formResizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(formResizeTimer);
  formResizeTimer = setTimeout(formRenderPreview, 100);
});
