/* Shared, deterministic form schema and renderer. No HTML, script or arbitrary CSS in saved designs. */
(() => {
  "use strict";
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const kinds = {
    free: "自行填寫表單",
    quote: "報價單",
    order: "銷售訂單",
    purchase: "採購訂購單",
  };
  const bindings = {
    "company.name": "公司名稱",
    "company.address": "公司地址",
    "company.phone": "公司電話",
    "company.tax_id": "公司統編",
    "document.no": "單據編號",
    "document.date": "單據日期",
    "document.due_date": "預定交期",
    "document.valid_until": "報價有效期限",
    "document.owner_name": "承辦人",
    "document.shipping_address": "交貨地址",
    "document.notes": "單據備註",
    "document.net": "未稅合計",
    "document.tax": "稅額",
    "document.total": "含稅合計",
    "document.header_discount": "整單折扣",
    "partner.code": "往來代號",
    "partner.name": "往來名稱",
    "partner.contact": "聯絡人",
    "partner.phone": "聯絡電話",
    "partner.tax_id": "往來統編",
    "partner.address": "往來地址",
  };
  const lineBindings = {
    index: "項次",
    sku: "品號",
    name: "品名",
    spec: "規格",
    qty: "數量",
    unit: "單位",
    price: "單價",
    discount_bp: "折數 %",
    amount: "金額（依來源稅別）",
    net: "未稅金額",
    tax: "稅額",
    total: "含稅金額",
    notes: "備註",
  };
  const types = {
    text: "文字／標題",
    field: "欄位",
    table: "明細表格",
    signature: "簽核空格",
    image: "抬頭圖片",
    spacer: "留白",
    rule: "分隔線",
    pagebreak: "換頁",
  };
  const inputTypes = {
    text: "單行文字",
    textarea: "多行文字",
    number: "數字",
    date: "日期",
    choice: "單選",
    checkbox: "勾選",
  };
  const bad = (message) => {
    throw new Error(message);
  };
  const text = (v, max = 1000) => {
    if (
      typeof v !== "string" ||
      v.length > max ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)
    )
      bad("文字格式錯誤或過長");
    return v;
  };
  const num = (v, min, max) => {
    if (!Number.isInteger(v) || v < min || v > max)
      bad(`數值需介於 ${min}–${max}`);
    return v;
  };
  const one = (v, choices) => {
    if (!choices.includes(v)) bad("不支援的表單設定");
    return v;
  };
  const key = (v) => {
    if (
      typeof v !== "string" ||
      !/^[a-z][a-z0-9_]{0,39}$/.test(v) ||
      ["constructor", "prototype", "__proto__"].includes(v)
    )
      bad("欄位識別碼需為英文小寫開頭的英數或底線");
    return v;
  };
  const checkObject = (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v))
      bad("表單物件格式錯誤");
  };
  function input(v) {
    const type = one(v.input_type || "text", Object.keys(inputTypes));
    const options =
      type === "choice"
        ? Array.isArray(v.options)
          ? v.options.map((x) => text(x, 100))
          : bad("請設定選項")
        : [];
    if (
      type === "choice" &&
      (!options.length ||
        options.length > 40 ||
        new Set(options).size !== options.length ||
        options.some((x) => !x.trim()))
    )
      bad("選項需為 1–40 個不重複的非空文字");
    return { input_type: type, required: v.required === true, options };
  }
  function validate(value) {
    checkObject(value);
    if (value.schema !== 1) bad("不支援的表單版本");
    const kind = one(value.kind, Object.keys(kinds)),
      p = value.page;
    checkObject(p);
    const paper = one(p.paper, ["a4", "a5", "letter", "custom"]),
      orientation = one(p.orientation, ["portrait", "landscape"]);
    const size = { a4: [210, 297], a5: [148, 210], letter: [216, 279] }[
      paper
    ] || [num(p.width, 80, 420), num(p.height, 100, 594)];
    const page = {
      paper,
      orientation,
      width: size[0],
      height: size[1],
      margin: num(p.margin, 6, 30),
      font: num(p.font, 9, 18),
      accent:
        typeof p.accent === "string" && /^#[a-fA-F0-9]{6}$/.test(p.accent)
          ? p.accent
          : bad("顏色需為六碼色碼"),
    };
    if (Math.min(...size) - 2 * page.margin < 60) bad("頁邊距過大");
    if (
      !Array.isArray(value.blocks) ||
      !value.blocks.length ||
      value.blocks.length > 100
    )
      bad("表單需包含 1–100 個區塊");
    const ids = new Set();
    let tables = 0;
    const blocks = value.blocks.map((b) => {
      checkObject(b);
      const id = key(b.id);
      if (ids.has(id)) bad("區塊識別碼重複");
      ids.add(id);
      const type = one(b.type, Object.keys(types));
      const r = {
        id,
        type,
        span: ["table", "pagebreak"].includes(type)
          ? 12
          : num(b.span ?? 12, 1, 12),
        label: text(b.label || "", 120),
        align: one(b.align || "left", ["left", "center", "right"]),
        font: num(b.font ?? page.font, 8, 36),
        bold: b.bold === true,
        border: b.border === true,
        min_height: num(b.min_height ?? 8, 0, 100),
      };
      if (type === "text" || type === "signature")
        r.text = text(b.text || "", type === "text" ? 8000 : 200);
      if (type === "field") {
        r.binding = text(b.binding || "", 80);
        if (
          r.binding &&
          (!Object.hasOwn(bindings, r.binding) ||
            (kind === "free" && !r.binding.startsWith("company.")))
        )
          bad("此欄位來源不適用表單類型");
        Object.assign(r, input(b));
      }
      if (type === "image") {
        r.src = text(b.src || "", 350000);
        if (
          r.src &&
          !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(r.src)
        )
          bad("圖片僅接受 PNG／JPEG，不接受外部網址或 SVG");
        if (
          r.src &&
          !/^data:image\/(?:png;base64,iVBORw0KGgo|jpeg;base64,\/9j\/)/.test(
            r.src,
          )
        )
          bad("圖片內容與格式不符");
      }
      if (type === "table") {
        if (++tables > 8) bad("最多 8 個表格");
        r.source = one(b.source || "custom", ["custom", "lines"]);
        if (kind === "free" && r.source === "lines")
          bad("自行填寫表單不能綁定交易明細");
        r.blank_rows = num(b.blank_rows ?? 5, 0, 40);
        r.row_height = num(b.row_height ?? 9, 5, 40);
        if (
          !Array.isArray(b.columns) ||
          !b.columns.length ||
          b.columns.length > 12
        )
          bad("明細表格需有 1–12 欄");
        const colIds = new Set();
        r.columns = b.columns.map((c) => {
          checkObject(c);
          const id = key(c.id);
          if (colIds.has(id)) bad("表格欄位識別碼重複");
          colIds.add(id);
          const col = {
            id,
            label: text(c.label || "", 100),
            width: num(c.width ?? 1, 1, 100),
            align: one(c.align || "left", ["left", "center", "right"]),
          };
          if (r.source === "lines")
            col.binding = one(c.binding, Object.keys(lineBindings));
          else Object.assign(col, input(c));
          return col;
        });
      }
      return r;
    });
    const result = { schema: 1, kind, page, blocks };
    if (JSON.stringify(result).length > 600000)
      bad("表單版型過大，請縮小圖片或文字");
    return result;
  }
  function validateValues(def, values, complete = false) {
    checkObject(values);
    const allowed = new Set(
      def.blocks
        .filter(
          (b) =>
            (b.type === "field" && !b.binding) ||
            (b.type === "table" && b.source === "custom"),
        )
        .map((b) => b.id),
    );
    if (Object.keys(values).some((k) => !allowed.has(k)))
      bad("包含未定義或禁止填入的欄位");
    const cell = (v, c) => {
      if (v === undefined || v === null) v = "";
      if (c.input_type === "checkbox") {
        if (![true, false, ""].includes(v)) bad(`${c.label} 需為勾選值`);
        if (complete && c.required && v !== true) bad(`${c.label} 為必填勾選`);
        return v === true;
      }
      v = text(v, c.input_type === "textarea" ? 8000 : 1000);
      if (complete && c.required && !v.trim()) bad(`${c.label} 為必填欄位`);
      if (!v) return "";
      if (c.input_type === "number" && !/^-?\d{1,12}(\.\d{1,4})?$/.test(v))
        bad(`${c.label} 需為數字，最多 12 位整數及 4 位小數`);
      if (
        c.input_type === "date" &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(v) ||
          Number.isNaN(Date.parse(v)) ||
          new Date(v + "T00:00:00Z").toISOString().slice(0, 10) !== v)
      )
        bad(`${c.label} 日期無效`);
      if (c.input_type === "choice" && !c.options.includes(v))
        bad(`${c.label} 不在允許選項中`);
      return v;
    };
    const out = {};
    for (const b of def.blocks) {
      if (b.type === "field" && !b.binding) out[b.id] = cell(values[b.id], b);
      if (b.type === "table" && b.source === "custom") {
        const rows = values[b.id] ?? [];
        if (!Array.isArray(rows) || rows.length > 200)
          bad("每個表格最多 200 列");
        out[b.id] = rows.map((row) => {
          checkObject(row);
          if (Object.keys(row).some((k) => !b.columns.some((c) => c.id === k)))
            bad("明細包含未定義欄位");
          return Object.fromEntries(
            b.columns.map((c) => [c.id, cell(row[c.id], c)]),
          );
        });
      }
    }
    if (JSON.stringify(out).length > 400000) bad("填寫資料過大");
    return out;
  }
  const display = (v) =>
    typeof v === "boolean" ? (v ? "☑" : "☐") : String(v ?? "");
  function render(def, values = {}, context = {}, options = {}) {
    const p = def.page,
      land = p.orientation === "landscape",
      w = land ? p.height : p.width,
      h = land ? p.width : p.height;
    const binding = (k) => context[k] ?? "";
    const content = (b) => {
      if (b.type === "text") return `<div class="ff-text">${esc(b.text)}</div>`;
      if (b.type === "field")
        return `<div class="ff-label">${esc(b.label)}</div><div class="ff-value">${esc(display(b.binding ? binding(b.binding) : values[b.id])) || "&#160;"}</div>`;
      if (b.type === "signature")
        return `<div class="ff-signature">${esc(b.label || b.text)}</div>`;
      if (b.type === "image")
        return b.src
          ? `<img alt="${esc(b.label || "抬頭圖片")}" src="${esc(b.src)}">`
          : '<div class="ff-image-placeholder">抬頭圖片</div>';
      if (b.type === "rule") return "<hr>";
      if (b.type !== "table") return "";
      let rows =
        b.source === "lines" ? context.lines || [] : values[b.id] || [];
      rows = [
        ...rows,
        ...Array.from(
          { length: Math.max(0, b.blank_rows - rows.length) },
          () => ({}),
        ),
      ];
      const total = b.columns.reduce((s, c) => s + c.width, 0);
      return `${b.label ? `<div class="ff-label">${esc(b.label)}</div>` : ""}<table class="ff-table"><colgroup>${b.columns.map((c) => `<col style="width:${(c.width / total) * 100}%">`).join("")}</colgroup><thead><tr>${b.columns.map((c) => `<th>${esc(c.label)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr style="height:${b.row_height}mm">${b.columns.map((c) => `<td style="text-align:${c.align}">${esc(display(row[b.source === "lines" ? c.binding : c.id])) || "&#160;"}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    };
    let rows = "",
      group = [],
      span = 0;
    const flush = () => {
      if (group.length) rows += `<div class="ff-row">${group.join("")}</div>`;
      group = [];
      span = 0;
    };
    for (const b of def.blocks) {
      if (b.type === "pagebreak") {
        flush();
        rows += '<div class="ff-pagebreak"></div>';
        continue;
      }
      if (span + b.span > 12 || b.type === "table") flush();
      const html = `<section class="ff-block ff-${b.type}${b.border ? " ff-border" : ""}" data-block-id="${b.id}" style="width:${(b.span / 12) * 100}%;min-height:${b.min_height}mm;font-size:${b.font}pt;text-align:${b.align};font-weight:${b.bold ? 700 : 400}">${content(b)}</section>`;
      if (b.type === "table") rows += html;
      else {
        group.push(html);
        span += b.span;
      }
    }
    flush();
    const title = options.title || kinds[def.kind];
    return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
*{box-sizing:border-box}body{margin:0;background:#e9ecef;color:#182128;font-family:'Microsoft JhengHei','Noto Sans CJK TC','Noto Sans TC',sans-serif}.ff-toolbar{padding:14px;display:flex;gap:15px;align-items:center;background:white;flex-wrap:wrap}.ff-toolbar button{padding:9px 18px;cursor:pointer}.ff-sheet{width:${w}mm;min-height:${h}mm;margin:20px auto;padding:${p.margin}mm;background:white;font-size:${p.font}pt;line-height:1.5;--ff-accent:${p.accent}}.ff-row{display:flex;flex-wrap:nowrap;align-items:stretch;break-inside:avoid}.ff-block{min-width:0;padding:2mm;overflow-wrap:anywhere;white-space:normal}.ff-border{border:0.3mm solid var(--ff-accent)}.ff-text,.ff-value{white-space:pre-wrap;overflow-wrap:anywhere}.ff-label{font-size:0.85em;color:#475561;margin-bottom:1mm}.ff-value{min-height:6mm}.ff-signature{padding-top:12mm;border-bottom:0.3mm solid var(--ff-accent)}.ff-block img{display:block;max-width:100%;max-height:45mm;object-fit:contain;margin:auto}.ff-image-placeholder{border:1px dashed #888;padding:8mm;color:#666}.ff-table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:inherit}.ff-table th,.ff-table td{border:0.25mm solid var(--ff-accent);padding:1.7mm;overflow-wrap:anywhere;white-space:pre-wrap;vertical-align:top}.ff-table th{background:#edf1f3;font-weight:600}.ff-table thead{display:table-header-group}.ff-table tr{break-inside:avoid}.ff-pagebreak{break-before:page;height:8mm;border-top:2px dashed #acb6bd;margin:5mm 0}.ff-mark{border:1px dashed #895623;padding:2mm;margin-bottom:3mm;overflow-wrap:anywhere}.ff-sheet hr{border:0;border-top:0.3mm solid var(--ff-accent)}.ff-foot{font-size:9pt;margin-top:4mm;color:#556;overflow-wrap:anywhere}@page{size:${w}mm ${h}mm;margin:${p.margin}mm;@bottom-right{content:counter(page);font-size:9pt}}@media print{body{background:white}.ff-toolbar{display:none}.ff-sheet{width:auto;min-height:0;margin:0;padding:0}.ff-pagebreak{height:0;border:0;margin:0}.ff-table th{print-color-adjust:exact;-webkit-print-color-adjust:exact}}@media screen and (max-width:800px){.ff-sheet{margin:8px 0}.ff-toolbar{position:sticky;left:0;width:100vw}}
</style>${options.script === false ? "" : '<script src="/print.js" defer></script>'}</head><body>${options.toolbar === false ? "" : `<div class="ff-toolbar"><button id="print" type="button">列印／另存 PDF</button><span>${esc(title)} · ${esc(options.note || "請在列印視窗確認紙張與邊界")}</span></div>`}<main class="ff-sheet">${options.mark ? `<div class="ff-mark">${esc(options.mark)}</div>` : ""}${rows}<div class="ff-foot">${esc(options.footer || "")}</div></main></body></html>`.replace(
      "</style>",
      (options.previewScale
        ? `@media screen{.ff-sheet{zoom:${Math.max(0.15, Math.min(1, Number(options.previewScale) || 1))};margin:8px auto}}`
        : "") + "</style>",
    );
  }
  function starter(kind = "free") {
    return {
      schema: 1,
      kind,
      page: {
        paper: "a4",
        orientation: "portrait",
        width: 210,
        height: 297,
        margin: 12,
        font: 11,
        accent: "#334155",
      },
      blocks: [
        {
          id: "company",
          type: "field",
          span: 12,
          label: "",
          binding: "company.name",
          align: "center",
          font: 20,
          bold: true,
        },
        {
          id: "title",
          type: "text",
          span: 12,
          text: kinds[kind],
          align: "center",
          font: 18,
          bold: true,
        },
        ...(kind === "free"
          ? [
              {
                id: "date",
                type: "field",
                span: 6,
                label: "日期",
                input_type: "date",
                required: true,
              },
              {
                id: "name",
                type: "field",
                span: 6,
                label: "填表人",
                required: true,
              },
            ]
          : [
              {
                id: "partner",
                type: "field",
                span: 6,
                label: kind === "purchase" ? "供應廠商" : "客戶",
                binding: "partner.name",
              },
              {
                id: "number",
                type: "field",
                span: 6,
                label: "單據編號",
                binding: "document.no",
              },
              {
                id: "contact",
                type: "field",
                span: 6,
                label: "聯絡人",
                binding: "partner.contact",
              },
              {
                id: "date",
                type: "field",
                span: 6,
                label: "單據日期",
                binding: "document.date",
              },
              {
                id: "phone",
                type: "field",
                span: 6,
                label: "聯絡電話",
                binding: "partner.phone",
              },
              {
                id: "due",
                type: "field",
                span: 6,
                label: kind === "quote" ? "有效期限" : "預定交期",
                binding:
                  kind === "quote"
                    ? "document.valid_until"
                    : "document.due_date",
              },
              {
                id: "address",
                type: "field",
                span: 12,
                label: "交貨地址",
                binding: "document.shipping_address",
              },
            ]),
        {
          id: "items",
          type: "table",
          label: "",
          source: kind === "free" ? "custom" : "lines",
          blank_rows: 6,
          row_height: 10,
          columns:
            kind === "free"
              ? [
                  { id: "item", label: "項目", width: 2 },
                  {
                    id: "description",
                    label: "內容說明",
                    width: 5,
                    input_type: "textarea",
                  },
                ]
              : ["index", "name", "spec", "qty", "unit", "price", "amount"].map(
                  (binding, i) => ({
                    id: binding,
                    binding,
                    label: lineBindings[binding],
                    width: [1, 4, 4, 2, 1, 3, 3][i],
                    align: i > 2 ? "right" : "left",
                  }),
                ),
        },
        ...(kind === "free"
          ? []
          : [
              {
                id: "net",
                type: "field",
                span: 4,
                label: "未稅合計",
                binding: "document.net",
                align: "right",
              },
              {
                id: "tax",
                type: "field",
                span: 4,
                label: "稅額",
                binding: "document.tax",
                align: "right",
              },
              {
                id: "total",
                type: "field",
                span: 4,
                label: "含稅合計",
                binding: "document.total",
                align: "right",
                bold: true,
              },
            ]),
        {
          id: "notes",
          type: "field",
          span: 12,
          label: "備註",
          ...(kind === "free"
            ? { input_type: "textarea" }
            : { binding: "document.notes" }),
        },
        { id: "signature1", type: "signature", span: 6, label: "承辦" },
        { id: "signature2", type: "signature", span: 6, label: "確認" },
      ],
    };
  }
  function presets() {
    const result = ["quote", "order", "purchase"].map((kind) => ({
      key: kind,
      name: kinds[kind],
      definition: validate(starter(kind)),
    }));
    const definitions = [
      [
        "inquiry",
        "詢價單",
        [
          ["recipient", "詢價對象", "text"],
          ["contact", "聯絡人", "text"],
          ["case", "案號", "text"],
          ["subject", "事項", "text"],
        ],
        [
          ["item", "品名規格", "textarea"],
          ["qty", "數量", "number"],
          ["unit", "單位", "text"],
          ["price", "報價", "number"],
        ],
      ],
      [
        "active_cases",
        "進行中案件",
        [
          ["owner", "業務", "text"],
          ["period", "報表日期", "date"],
        ],
        [
          ["customer", "客戶", "text"],
          ["project", "項目", "textarea"],
          ["amount", "金額", "number"],
          ["progress", "進度", "textarea"],
        ],
      ],
      [
        "quoted_cases",
        "已報價案件",
        [
          ["owner", "業務", "text"],
          ["period", "報表日期", "date"],
        ],
        [
          ["customer", "客戶", "text"],
          ["project", "項目", "textarea"],
          ["quote_no", "報價單號", "text"],
          ["amount", "金額", "number"],
        ],
      ],
      [
        "lost_cases",
        "未得標案件說明",
        [
          ["owner", "業務", "text"],
          ["period", "報表日期", "date"],
        ],
        [
          ["customer", "客戶", "text"],
          ["project", "項目", "textarea"],
          ["amount", "金額", "number"],
          ["reason", "未得標原因", "textarea"],
        ],
      ],
      [
        "daily_work",
        "每日工作報告",
        [
          ["department", "單位", "text"],
          ["start_mileage", "出發里程", "number"],
          ["end_mileage", "返抵里程", "number"],
          ["purpose", "外出原因", "text"],
        ],
        [
          ["period", "上午／下午", "text"],
          ["content", "商談及工作內容", "textarea"],
          ["conclusion", "結論及說明", "textarea"],
        ],
      ],
      [
        "sales_daily",
        "業務日報",
        [["department", "部門", "text"]],
        [
          ["period", "時段", "text"],
          ["customer", "拜訪對象", "text"],
          ["contact", "接洽人", "text"],
          ["phone", "電話", "text"],
          ["address", "地址", "textarea"],
          ["result", "拜訪結果", "textarea"],
        ],
      ],
      [
        "weekly_plan",
        "一週工作計畫",
        [["week_start", "週起始日", "date"]],
        [
          ["date", "日期", "date"],
          ["morning", "上午計畫", "textarea"],
          ["afternoon", "下午計畫", "textarea"],
          ["notes", "備註", "textarea"],
        ],
      ],
      [
        "vehicle_month",
        "汽機車月報",
        [
          ["vehicle", "車牌／車輛", "text"],
          ["period", "月份", "text"],
        ],
        [
          ["date", "日期", "date"],
          ["start", "起程", "number"],
          ["end", "終程", "number"],
          ["mileage", "里程", "number"],
          ["toll", "過路費", "number"],
          ["meal", "誤餐費", "number"],
          ["parking", "停車費", "number"],
          ["destination", "目的地", "textarea"],
        ],
      ],
    ];
    for (const [key, name, fields, cols] of definitions) {
      const d = starter();
      d.blocks[1].text = name;
      d.blocks.splice(
        4,
        0,
        ...fields.map(([id, label, input_type]) => ({
          id,
          type: "field",
          span: 6,
          label,
          input_type,
        })),
      );
      const table = d.blocks.find((b) => b.type === "table");
      table.blank_rows = ["weekly_plan"].includes(key)
        ? 5
        : key === "vehicle_month"
          ? 15
          : 8;
      table.columns = cols.map(([id, label, input_type]) => ({
        id,
        label,
        input_type,
        width: input_type === "textarea" ? 3 : 2,
      }));
      if (["vehicle_month", "sales_daily"].includes(key))
        d.page.orientation = "landscape";
      result.push({ key, name, definition: validate(d) });
    }
    return result;
  }
  globalThis.ERPFormModel = Object.freeze({
    esc,
    kinds,
    bindings,
    lineBindings,
    types,
    inputTypes,
    validate,
    validateValues,
    render,
    starter,
    presets,
  });
})();
