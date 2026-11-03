function completionPage() {
  const d = S.data,
    tab = S.tab || "stock";
  let body = "";
  const forms = (items) =>
    items
      .map(([label, key]) => btn(label, "completion-form", key, "small"))
      .join(" ");
  if (tab === "stock")
    body =
      forms([
        ["新增進出庫／在途調撥", "stock-document"],
        ["拆解成品", "disassemble"],
        ["組合銷售", "kit-sale"],
        ["缺貨訂單分配", "partial-release"],
      ]) +
      table(
        ["單號", "種類", "狀態", "倉庫", ""],
        (d.stock_documents || []).map(
          (x) =>
            `<tr><td>${E(x.no)}</td><td>${E({ receipt: "非交易入庫", issue: "非交易出庫", transfer: "在途調撥" }[x.kind])}</td><td>${E({ draft: "草稿", approved: "已核准", posted: "已過帳", dispatched: "在途／待驗收", received: "已驗收", cancelled: "已取消" }[x.status] || x.status)}</td><td>${E(x.from_name || "—")} → ${E(x.to_name || "—")}</td><td>${btn("明細／操作", "completion-stock", x.id, "small")}</td></tr>`,
        ),
      );
  else if (tab === "products")
    body =
      forms([
        ["建立商品分類", "category"],
        ["建立自訂欄位", "custom-field"],
        ["設定商品分類與欄位", "product-attributes"],
        ["補貨政策", "replenishment-policy"],
        ["批次補貨草稿", "replenish"],
        ["批次更新參考成本", "cost-batch"],
      ]) +
      table(
        ["分類代碼", "名稱", "上層"],
        (d.product_categories || []).map(
          (x) =>
            `<tr><td>${E(x.code)}</td><td>${E(x.name)}</td><td>${E(d.product_categories.find((p) => p.id === x.parent_id)?.name || "根分類")}</td></tr>`,
        ),
      );
  else if (tab === "counts")
    body =
      forms([
        ["盤點檔案映射匯入", "count-file"],
        ["盤點差異預覽", "count-preview"],
        ["盤點異動重基", "count-rebase"],
      ]) +
      `<p>盤點重基會將快照後異動同時加到帳面與實盤，保留原差異；先預覽、核對原因後才可執行。</p>`;
  else if (tab === "finance")
    body =
      forms([
        ["期初預收付", "opening-fund"],
        ["混合收付款", "settlement"],
        ["已退款收付沖銷", "payment-reversal"],
        ["憑證來源關聯", "invoice-link"],
        ["指派資料負責人", "assign"],
        ["標準成本", "standards"],
        ["成本政策", "cost-policy"],
        ["月加權結算", "monthly-cost-preview"],
        ["模組結帳／重開", "closing"],
      ]) +
      `<p>期初預收付對應期初權益，不虛構銀行進出。混合收付可使用銀行、現金、預收付、票據及收款手續費。</p>`;
  else if (tab === "reports")
    body = forms([
      ["往來歷史與關聯", "history"],
      ["歷史庫存／庫齡", "stock-history"],
      ["歷史帳齡", "aging"],
      ["交叉矩陣", "matrix"],
    ]);
  else
    body =
      forms([["顯示精度與輸入順序", "preferences"]]) +
      `<p>數量最多三位、金額最多二位；顯示設定不改變底層整數精度。每位使用者分開保存。</p>`;
  return (
    head(
      "完整營運作業",
      "分區操作進出庫、補貨、盤點、期初及歷史分析。",
      "",
      "BUSINESS WORKFLOWS",
    ) +
    tabBar(
      [
        ["stock", "進出庫與組拆裝"],
        ["products", "分類與補貨"],
        ["counts", "盤點控制"],
        ["finance", "收付與結帳"],
        ["reports", "歷史與矩陣"],
        ["preferences", "個人設定"],
      ],
      tab,
    ) +
    `<section class="panel"><div class="panel-body">${body}</div></section>`
  );
}
function completionSelect(label, key, rows, selected = "", blank) {
  return selectField(
    label,
    key,
    options(
      rows,
      (r) =>
        r.sku
          ? r.sku + " · " + r.name
          : r.no
            ? r.no + (r.partner_name ? " · " + r.partner_name : "")
            : r.name,
      "id",
      selected,
      blank,
    ),
  );
}
function completionLineRows() {
  return (
    "<h3>商品明細（空白列略過）</h3>" +
    [0, 1, 2, 3]
      .map(
        (i) =>
          `<div class="form-grid" data-completion-line="${i}">${completionSelect("商品", "line_product_" + i, S.data.products)}${field("數量", "line_qty_" + i, "1", "number", 'min="0.001" step="0.001"')}${field("單位成本（入庫使用）", "line_cost_" + i, "0", "number", 'min="0" step="0.01"')}</div>`,
      )
      .join("")
  );
}
async function completionForm(kind) {
  const d = S.data,
    product = () => completionSelect("商品", "product_id", d.products),
    warehouse = (label, key) => completionSelect(label, key, d.warehouses),
    partner = () => completionSelect("往來對象", "partner_id", d.partners),
    qty = () => field("數量", "qty", "1", "number", 'min="0.001" step="0.001"'),
    reason = () => textarea("原因／核對說明", "reason", ""),
    date = () => field("日期", "date", d.today, "date", "required");
  let body = "",
    title = "";
  S.completionKind = kind;
  if (kind === "stock-document") {
    title = "非交易進出庫／在途調撥";
    body =
      selectField(
        "種類",
        "kind",
        '<option value="receipt">非交易入庫</option><option value="issue">非交易出庫</option><option value="transfer">兩階段在途調撥</option>',
      ) +
      warehouse("來源倉（出庫／調撥必填）", "from_id") +
      warehouse("目的倉（入庫／調撥必填）", "to_id") +
      date() +
      textarea("用途說明", "notes", "") +
      completionLineRows();
  } else if (kind === "category") {
    title = "新增商品分類";
    body =
      field("代碼", "code", "", "text", "required") +
      field("分類名稱", "name", "", "text", "required") +
      completionSelect("上層分類", "parent_id", d.product_categories);
  } else if (kind === "custom-field") {
    title = "新增商品自訂欄位";
    body =
      field(
        "欄位代碼（小寫英數與底線）",
        "code",
        "",
        "text",
        'required pattern="[a-z][a-z0-9_]{0,39}"',
      ) +
      field("欄位名稱", "label", "", "text", "required") +
      selectField(
        "型別",
        "type",
        '<option value="text">文字</option><option value="number">數字</option><option value="date">日期</option><option value="choice">選項</option><option value="boolean">是／否</option>',
      ) +
      selectField(
        "是否必填",
        "required",
        '<option value="0">選填</option><option value="1">必填</option>',
      ) +
      textarea("選項（選項型別時每行一個）", "options", "");
  } else if (kind === "product-attributes") {
    title = "商品分類與自訂欄位";
    body =
      product() +
      completionSelect("商品分類", "category_id", d.product_categories) +
      (d.custom_field_definitions || [])
        .filter((f) => f.active)
        .map((f) =>
          f.type === "choice"
            ? selectField(
                f.label,
                "custom_" + f.code,
                f.options
                  .map((v) => `<option value="${E(v)}">${E(v)}</option>`)
                  .join(""),
              )
            : f.type === "boolean"
              ? selectField(
                  f.label,
                  "custom_" + f.code,
                  '<option value="0">否</option><option value="1">是</option>',
                )
              : field(
                  f.label,
                  "custom_" + f.code,
                  "",
                  f.type === "date"
                    ? "date"
                    : f.type === "number"
                      ? "number"
                      : "text",
                  f.required ? "required" : "",
                ),
        )
        .join("");
  } else if (kind === "opening-fund") {
    title = "歷史期初預收付";
    body =
      selectField(
        "類型",
        "kind",
        '<option value="customer_advance">客戶期初預收</option><option value="supplier_advance">廠商期初預付</option>',
      ) +
      partner() +
      field("金額", "amount", "", "number", 'min="0.01" step="0.01" required') +
      date() +
      field("原始來源參考", "reference", "", "text", "required");
  } else if (kind === "closing") {
    title = "模組結帳／重開";
    body =
      selectField(
        "模組",
        "module",
        '<option value="inventory">庫存</option><option value="finance">財務</option><option value="trade">交易</option>',
      ) +
      field("結帳截止日（留白重開）", "closed_until", "", "date") +
      reason() +
      "<p>重開須記錄原因。既有全公司結帳截止日仍有效，不能用模組重開繞過。</p>";
  } else if (kind === "replenishment-policy") {
    title = "補貨策略";
    body =
      product() +
      field(
        "目標存量",
        "target_qty",
        "0",
        "number",
        'min="0" step="0.001" required',
      ) +
      field(
        "最少採購量",
        "min_order_qty",
        "0",
        "number",
        'min="0" step="0.001"',
      ) +
      field(
        "採購倍量",
        "multiple_qty",
        "1",
        "number",
        'min="0.001" step="0.001"',
      ) +
      field("交期天數", "lead_days", "0", "number", 'min="0" max="365"');
  } else if (kind === "replenish") {
    title = "多品項批次補貨";
    body =
      warehouse("入庫倉", "warehouse_id") +
      date() +
      `<div class="full">${(d.replenishment || [])
        .filter((r) => r.suggested_qty > 0)
        .map(
          (r) =>
            `<label style="display:block;margin:10px"><input type="checkbox" data-completion-product value="${r.product_id}"> ${E(r.sku)} · ${E(r.name)} · ${Q(r.suggested_qty)} ${E(r.unit)} · ${E(r.supplier_name || "未設定供應商")}</label>`,
        )
        .join("")}</div>`;
  } else if (["count-preview", "count-rebase", "count-file"].includes(kind)) {
    title = {
      "count-preview": "盤點差異預覽",
      "count-rebase": "盤點異動重基",
      "count-file": "盤點 CSV／XLSX 映射匯入",
    }[kind];
    body = completionSelect(
      "草稿盤點單",
      "count_id",
      (d.inventory_counts || []).filter((c) => c.status === "draft"),
    );
    if (kind === "count-rebase") body += reason();
    if (kind === "count-file")
      body +=
        `<div class="field full"><label>CSV／XLSX 純值檔案（1 MB 以下）</label><input id="completion-file" type="file" accept=".csv,.xlsx" required></div>` +
        field("品號來源欄名", "sku_column", "sku", "text", "required") +
        field(
          "實盤量來源欄名",
          "qty_column",
          "actual_qty",
          "text",
          "required",
        ) +
        field("盤點區域來源欄名（選填）", "zone_column", "zone");
  } else if (kind === "disassemble") {
    title = "成品拆解為 BOM 材料";
    body =
      product() +
      warehouse("倉庫", "warehouse_id") +
      qty() +
      reason() +
      "<p>依當前 BOM 用量與材料參考成本權重分配成品帳面成本；分配合計保留精確尾差。</p>";
  } else if (kind === "kit-sale") {
    title = "組合品銷售（展開材料）";
    body =
      completionSelect("組合品 BOM", "kit_id", d.boms || []) +
      partner() +
      warehouse("出貨倉", "warehouse_id") +
      qty() +
      field(
        "每組未稅售價",
        "price",
        "",
        "number",
        'min="0" step="0.01" required',
      ) +
      date() +
      "<p>建立展開材料的訂單草稿，保留組合快照，後續仍須送審與核准。</p>";
  } else if (kind === "partial-release") {
    title = "缺貨訂單部分配置";
    body =
      completionSelect(
        "待審訂單",
        "document_id",
        d.documents.filter((x) => x.kind === "order" && x.status === "pending"),
      ) +
      selectField(
        "策略",
        "strategy",
        '<option value="proportional">按最低可用比例配置</option><option value="available">各品項盡量配置</option>',
      ) +
      "<p>可用量建立並核准子訂單；原訂單保留缺貨餘量與關聯，不會預留不足庫存。</p>";
  } else if (kind === "settlement") {
    title = "混合收付款";
    body =
      selectField(
        "收付方向",
        "kind",
        '<option value="receivable">收款</option><option value="payable">付款</option>',
      ) +
      partner() +
      date() +
      selectField(
        "超收付的處理",
        "excess_to_advance",
        '<option value="0">金額必須剛好相等</option><option value="1">已核對，超額轉一般預收付</option>',
      ) +
      `<h3 class="full">沖抵帳款（填本次金額，0 略過）</h3>` +
      (d.open_items || [])
        .filter((x) => x.amount > x.paid)
        .map((o) =>
          field(
            o.partner_name +
              " · " +
              o.source_no +
              "（餘額 " +
              money(o.amount - o.paid, true) +
              "）",
            "settle_" + o.id,
            "0",
            "number",
            'min="0" step="0.01"',
          ),
        )
        .join("") +
      `<h3 class="full">收付方式（0 略過）</h3>` +
      [0, 1, 2, 3]
        .map(
          (i) =>
            `<div data-completion-tender="${i}" class="full form-grid">${selectField("方式", "tender_kind_" + i, '<option value="bank">銀行</option><option value="cash">現金</option><option value="fund">預收付／待退款</option><option value="cheque">票據</option><option value="fee">收款內扣手續費</option><option value="bank_fee">額外銀行手續費（不抵帳款）</option>')}${field("金額", "tender_amount_" + i, "0", "number", 'min="0" step="0.01"')}${completionSelect("實收付帳戶", "tender_bank_" + i, d.bank_accounts || [])}${completionSelect("預收付來源", "tender_fund_" + i, d.funds || [])}${field("票號（票據時填）", "tender_bill_" + i)}${field("票據到期日", "tender_due_" + i, d.today, "date")}</div>`,
        )
        .join("");
  } else if (kind === "invoice-link") {
    title = "本地發票與出庫來源關聯";
    body =
      completionSelect(
        "本地發票紀錄",
        "invoice_id",
        (d.invoice_records || []).map((x) => ({ ...x, name: x.invoice_no })),
      ) +
      completionSelect(
        "銷貨出庫單",
        "fulfilment_id",
        (d.fulfilments || []).filter((x) => x.kind === "shipment"),
      ) +
      field(
        "本次關聯金額",
        "amount",
        "",
        "number",
        'min="0.01" step="0.01" required',
      ) +
      "<p>此為本地來源追溯；不會連線開立或驗證正式發票。</p>";
  } else if (kind === "assign") {
    title = "指派資料負責人";
    body =
      selectField(
        "資料類型",
        "resource",
        '<option value="partners">往來對象</option><option value="orders">訂單</option><option value="quotes">報價</option><option value="purchases">採購</option>',
      ) +
      field("資料 ID", "id", "", "number", 'min="1" required') +
      completionSelect("新負責人", "owner_id", d.owners) +
      reason();
  } else if (kind === "standards") {
    title = "商品標準成本";
    body =
      product() +
      field(
        "每基本單位標準成本",
        "cost",
        "",
        "number",
        'min="0" step="0.01" required',
      ) +
      reason();
  } else if (kind === "cost-policy") {
    title = "成本計價政策";
    body =
      selectField(
        "計價方法",
        "method",
        '<option value="moving">移動加權</option><option value="standard">標準成本（差異另列）</option><option value="monthly">月加權（月內暫算，月末結算）</option>',
      ) +
      field("生效日", "effective_date", d.today, "date", "required") +
      reason() +
      "<p>政策今天生效；標準成本會重估現有庫存並留差異。月加權需整月來源，複合成本來源會先阻擋自動結算。</p>";
  } else if (kind === "monthly-cost-preview") {
    title = "月加權成本結算預覽";
    body = date() + reason();
  } else if (kind === "payment-reversal") {
    title = "核對退款後沖銷收付款";
    body =
      completionSelect("原收付款", "payment_id", d.payments || []) +
      date() +
      reason() +
      selectField(
        "已退款的處理",
        "offset_refunds",
        '<option value="0">遇到已退款先阻擋</option><option value="1">已核對，從本次實際沖銷現金扣除先前退款</option>',
      );
  } else if (kind === "cost-batch") {
    title = "批次成本匯入與重估";
    body =
      selectField(
        "匯入目標",
        "target",
        '<option value="reference">商品參考成本</option><option value="inventory">庫存價值重估</option>',
      ) +
      textarea(
        "每行「品號,成本,倉庫代碼,總價」（不含標題；重估時填倉庫，總價可留白依單價）",
        "cost_rows",
        "",
      ) +
      reason() +
      "<p>先預覽再整批確認。參考成本不回改庫存；庫存重估另記不可覆寫流水與差異分錄，保留原交易成本。</p>";
  } else if (kind === "preferences") {
    title = "我的顯示與輸入設定";
    const p = d.user_preferences;
    body =
      field(
        "數量顯示小數位",
        "quantity_digits",
        p.quantity_digits,
        "number",
        'min="0" max="3" required',
      ) +
      field(
        "金額顯示小數位",
        "money_digits",
        p.money_digits,
        "number",
        'min="0" max="2" required',
      ) +
      selectField(
        "輸入順序",
        "input_order",
        [
          "qty,price,discount_bp",
          "price,qty,discount_bp",
          "qty,discount_bp,price",
          "discount_bp,price,qty",
        ]
          .map(
            (x) =>
              `<option value="${x}" ${p.input_order === x ? "selected" : ""}>${E(
                x
                  .split(",")
                  .map(
                    (k) =>
                      ({ qty: "數量", price: "單價", discount_bp: "折扣" })[k],
                  )
                  .join(" → "),
              )}</option>`,
          )
          .join(""),
      );
  } else {
    title = {
      history: "往來歷史與關聯",
      "stock-history": "歷史庫存、呆滯與庫齡",
      aging: "指定日帳齡",
      matrix: "交易交叉矩陣",
    }[kind];
    body =
      kind === "history"
        ? partner()
        : kind === "stock-history"
          ? field("截止日", "date", d.today, "date", "required") +
            field("呆滯天數", "slow_days", "90", "number", 'min="1" max="3650"')
          : kind === "aging"
            ? partner() +
              field("截止日", "date", d.today, "date", "required") +
              selectField(
                "應收／應付",
                "kind",
                '<option value="receivable">應收</option><option value="payable">應付</option>',
              )
            : field(
                "起日",
                "from",
                d.today.slice(0, 7) + "-01",
                "date",
                "required",
              ) +
              field("迄日", "to", d.today, "date", "required") +
              selectField(
                "交易類型",
                "kind",
                '<option value="sales">銷售</option><option value="purchases">採購</option>',
              ) +
              selectField(
                "列維度",
                "row",
                [
                  "partner",
                  "product",
                  "category",
                  "owner",
                  "department",
                  "month",
                ]
                  .map(
                    (x) =>
                      `<option value="${x}">${E({ partner: "往來對象", product: "商品", category: "分類", owner: "業務", department: "部門", month: "月份" }[x])}</option>`,
                  )
                  .join(""),
              ) +
              selectField(
                "欄維度",
                "column",
                [
                  "month",
                  "product",
                  "partner",
                  "category",
                  "owner",
                  "department",
                ]
                  .map(
                    (x) =>
                      `<option value="${x}">${E({ partner: "往來對象", product: "商品", category: "分類", owner: "業務", department: "部門", month: "月份" }[x])}</option>`,
                  )
                  .join(""),
              );
  }
  modal(
    title,
    `<form id="modal-form" data-form="completion"><div class="form-grid">${body}</div></form>`,
    formFooter(
      ["history", "stock-history", "aging", "matrix", "count-preview"].includes(
        kind,
      )
        ? "查詢"
        : "預覽／儲存",
    ),
    true,
  );
}
async function completionSubmit(b) {
  const kind = S.completionKind,
    d = S.data,
    payload = { ...b };
  if (kind === "stock-document")
    payload.lines = [...document.querySelectorAll("[data-completion-line]")]
      .map((el) => {
        const i = el.dataset.completionLine;
        return {
          product_id: b["line_product_" + i],
          qty: b["line_qty_" + i],
          unit_cost: b["line_cost_" + i],
        };
      })
      .filter((l) => l.product_id);
  if (kind === "custom-field") {
    payload.required = b.required === "1";
    payload.options = b.options
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);
  }
  if (kind === "product-attributes") {
    const p = d.products.find((x) => x.id === Number(b.product_id));
    payload.version = p.version;
    payload.values = Object.fromEntries(
      Object.entries(b)
        .filter(([k]) => k.startsWith("custom_"))
        .map(([k, v]) => [k.slice(7), v]),
    );
  }
  if (kind === "assign") {
    const row =
      b.resource === "partners"
        ? d.partners.find((x) => x.id === Number(b.id))
        : d.documents.find((x) => x.id === Number(b.id));
    if (!row) throw Error("請選本帳號可見的資料 ID");
    payload.version = row.version;
  }
  if (kind === "standards") {
    payload.rows = [
      {
        product_id: b.product_id,
        cost: b.cost,
        version:
          d.standard_costs.find((x) => x.product_id === Number(b.product_id))
            ?.version || 0,
      },
    ];
  }
  if (kind === "closing")
    payload.version =
      d.module_closings.find((x) => x.module === b.module)?.version || 0;
  if (kind === "replenishment-policy")
    payload.version =
      d.replenishment_policies.find(
        (x) => x.product_id === Number(b.product_id),
      )?.version || 0;
  if (kind === "replenish")
    payload.product_ids = [
      ...document.querySelectorAll("[data-completion-product]:checked"),
    ].map((x) => Number(x.value));
  if (["count-preview", "count-file", "count-rebase"].includes(kind)) {
    const c = d.inventory_counts.find((x) => x.id === Number(b.count_id));
    payload.version = c.version;
  }
  if (kind === "count-file") {
    const file = document.querySelector("#completion-file").files[0];
    if (!file || file.size > 1048576) throw Error("請選 1 MB 以下檔案");
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    payload.base64 = btoa(binary);
    payload.format = file.name.toLowerCase().endsWith(".xlsx") ? "xlsx" : "csv";
    payload.columns = {
      sku: b.sku_column,
      actual_qty: b.qty_column,
      zone: b.zone_column,
    };
  }
  if (kind === "partial-release")
    payload.version = d.documents.find(
      (x) => x.id === Number(b.document_id),
    ).version;
  if (kind === "cost-batch")
    payload.rows = b.cost_rows
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((x) => {
        const [sku, cost, warehouse_code, new_value] = x.split(",");
        return {
          sku: sku.trim(),
          cost: cost?.trim(),
          warehouse_code: warehouse_code?.trim(),
          new_value: new_value?.trim(),
        };
      });
  if (kind === "settlement") {
    payload.excess_to_advance = b.excess_to_advance === "1";
    payload.lines = Object.entries(b)
      .filter(([k, v]) => k.startsWith("settle_") && Number(v) > 0)
      .map(([k, v]) => ({ open_item_id: Number(k.slice(7)), amount: v }));
    payload.tenders = [0, 1, 2, 3]
      .filter((i) => Number(b["tender_amount_" + i]) > 0)
      .map((i) => ({
        kind: b["tender_kind_" + i],
        amount: b["tender_amount_" + i],
        bank_account_id: b["tender_bank_" + i],
        fund_id: b["tender_fund_" + i],
        bill_number: b["tender_bill_" + i],
        due_date: b["tender_due_" + i],
      }));
  }
  if (kind === "payment-reversal") {
    payload.offset_refunds = b.offset_refunds === "1";
    await api("/api/finance/payment-reversals", payload);
    closeModal();
    await refresh();
    toast("已核對退款並沖銷");
    return;
  }
  const isGet = ["history", "stock-history", "aging", "matrix"].includes(kind),
    r = await api(
      "/api/completion/" +
        (kind === "closing" ? "closing-preview" : kind) +
        (isGet ? "?" + new URLSearchParams(payload) : ""),
      isGet ? undefined : payload,
    );
  if (
    [
      "closing",
      "monthly-cost-preview",
      "count-file",
      "count-rebase",
      "cost-batch",
    ].includes(kind)
  ) {
    S.completionPending = {
      kind: kind === "monthly-cost-preview" ? "monthly-cost" : kind,
      payload: { ...payload, token: r.token, preview: false },
    };
    modal(
      "核對預覽",
      completionResult(kind, r),
      btn("取消", "close") +
        (r.valid === false
          ? ""
          : btn("確認寫入", "completion-commit", "", "primary")),
      true,
    );
    return;
  }
  if (isGet || kind === "count-preview") {
    S.completionReport = { kind, payload };
    modal(
      "查詢結果",
      completionResult(kind, r),
      btn("關閉", "close") +
        (isGet ? btn("匯出 CSV", "completion-export") : "") +
        (kind === "aging" && payload.partner_id
          ? `<a class="btn" href="/print/completion-statement?${E(new URLSearchParams({ ...payload, company: S.company }))}" target="_blank" rel="noopener">列印對帳單</a>`
          : ""),
      true,
    );
    return;
  }
  closeModal();
  await refresh();
  toast("作業已完成");
}
function completionResult(kind, r) {
  if (kind === "closing")
    return (
      `<p>${E(r.note)}</p><p>${r.valid ? "核對通過" : "核對未通過，請先檢查一致性問題"}</p>` +
      table(
        ["科目", "借方", "貸方", "餘額"],
        r.rows.map(
          (x) =>
            `<tr><td>${E(x.account)} ${E(x.name)}</td><td>${money(x.debit, true)}</td><td>${money(x.credit, true)}</td><td>${money(x.balance, true)}</td></tr>`,
        ),
      )
    );
  if (kind === "matrix")
    return table(
      ["列", "欄", "未稅", "稅額", "成本", "毛利", "銷售費用", "貢獻利益"],
      r.cells.map(
        (c) =>
          `<tr><td>${E(c.row_name)}</td><td>${E(c.column_name)}</td><td>${money(c.net, true)}</td><td>${money(c.tax, true)}</td><td>${money(c.cost, true)}</td><td>${money(c.margin, true)}</td><td>${money(c.selling_expense, true)}</td><td>${money(c.contribution, true)}</td></tr>`,
      ),
    );
  if (kind === "history")
    return (
      `<p>${E(r.note)}</p>` +
      table(
        ["類型", "單號／ID", "日期", "金額"],
        r.nodes.map(
          (n) =>
            `<tr><td>${E(n.type)}</td><td>${E(n.no || n.id)}</td><td>${E(n.date || n.created_at?.slice(0, 10) || "")}</td><td>${money(n.total ?? n.amount, true)}</td></tr>`,
        ),
      ) +
      table(
        ["來源", "關聯到"],
        r.edges.map((e) => `<tr><td>${E(e.from)}</td><td>${E(e.to)}</td></tr>`),
      )
    );
  const rows = r.rows || [];
  return (
    (r.note ? `<p>${E(r.note)}</p>` : "") +
    (r.stale
      ? '<p class="warning-note">盤點快照後有異動，需重基或重盤才能過帳。</p>'
      : "") +
    table(
      kind === "stock-history"
        ? [
            "品號／倉庫",
            "歷史數量",
            "歷史金額",
            "庫齡 ≤30／31–90／91–180／181+",
            "呆滯",
          ]
        : kind === "aging"
          ? ["來源", "往來對象", "到期日", "未結", "逾期天數"]
          : kind === "monthly-cost-preview"
            ? ["品號／倉庫", "原價值", "月加權價值", "差異"]
            : kind === "cost-batch"
              ? ["品號", "原成本", "新成本"]
              : ["品號", "帳面", "實盤／重基實盤", "差異／異動"],
      rows.map((x) =>
        kind === "stock-history"
          ? `<tr><td>${E(x.sku)} / ${E(x.warehouse_name)}</td><td>${Q(x.qty)}</td><td>${money(x.value, true)}</td><td>${Object.values(x.age_buckets).map(Q).join(" / ")}</td><td>${x.slow ? "是" : "否"}</td></tr>`
          : kind === "aging"
            ? `<tr><td>${E(x.source_no)}</td><td>${E(x.partner_name)}</td><td>${E(x.due_date)}</td><td>${money(x.outstanding, true)}</td><td>${x.days_overdue}</td></tr>`
            : kind === "monthly-cost-preview"
              ? `<tr><td>${E(x.sku)} / ${x.warehouse_id}</td><td>${money(x.old_value, true)}</td><td>${money(x.new_value, true)}</td><td>${money(x.difference, true)}</td></tr>`
              : kind === "cost-batch"
                ? `<tr><td>${E(x.sku)}</td><td>${money(x.old_cost, true)}</td><td>${money(x.new_cost, true)}</td></tr>`
                : `<tr><td>${E(x.sku)}</td><td>${Q(x.expected_qty)}</td><td>${Q(x.new_actual ?? x.actual_qty)}</td><td>${Q(x.movement ?? x.difference)}</td></tr>`,
      ),
    )
  );
}
async function completionAction(a, id) {
  if (a === "completion-document-history") {
    const r = await api("/api/completion/history?document_id=" + id);
    S.completionReport = { kind: "history", payload: { document_id: id } };
    modal(
      "單據交易關聯",
      completionResult("history", r),
      btn("關閉", "close") + btn("匯出 CSV", "completion-export"),
      true,
    );
    return;
  }
  if (a === "completion-form") return completionForm(id);
  if (a === "completion-commit") {
    const x = S.completionPending;
    await api("/api/completion/" + x.kind, x.payload);
    closeModal();
    await refresh();
    toast("已依預覽結果寫入");
    return;
  }
  if (a === "completion-export") {
    const x = S.completionReport,
      r = await api(
        "/api/completion/" +
          x.kind +
          "?" +
          new URLSearchParams({ ...x.payload, format: "csv" }),
      ),
      blob = new Blob([r.csv], { type: "text/csv;charset=utf-8" }),
      url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = "erp-report.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  if (a === "completion-stock") {
    const r = await api("/api/completion/stock-detail?id=" + id);
    S.completionStock = r;
    modal(
      "庫存單 " + r.no,
      `<p>${E({ receipt: "非交易入庫", issue: "非交易出庫", transfer: "在途調撥" }[r.kind] || r.kind)} · ${E({ draft: "草稿", approved: "已核准", posted: "已過帳", dispatched: "在途／待驗收", received: "已驗收", cancelled: "已取消" }[r.status] || r.status)} · ${E(r.notes)}</p>${table(
        ["品號", "數量", "已驗收／本次驗收"],
        r.lines.map(
          (l) =>
            `<tr><td>${E(l.sku)} ${E(l.name)}</td><td>${Q(l.qty)}</td><td>${Q(l.received_qty)}${r.status === "dispatched" ? `<input type="number" data-completion-receive="${l.id}" min="0" max="${inputQty(l.qty - l.received_qty)}" step="0.001" value="${inputQty(l.qty - l.received_qty)}" aria-label="${E(l.sku)}本次驗收量">` : ""}</td></tr>`,
        ),
      )}<p><a class="btn" href="/print/completion-stock/${r.id}?company=${E(S.company)}" target="_blank" rel="noopener">列印</a></p>`,
      btn("關閉", "close") +
        (r.status === "draft"
          ? btn("核准", "completion-stock-action", "approve", "", "check") +
            btn("取消", "completion-stock-action", "cancel", "danger")
          : r.status === "approved"
            ? btn(
                r.kind === "transfer" ? "發出並轉在途" : "確認過帳",
                "completion-stock-action",
                "post",
                "primary",
              )
            : r.status === "dispatched"
              ? btn(
                  "確認本次驗收",
                  "completion-stock-action",
                  "receive",
                  "primary",
                )
              : ""),
      true,
    );
    return;
  }
  if (a === "completion-stock-action") {
    const d = S.completionStock,
      payload = { id: d.id, version: d.version, action: id };
    if (id === "cancel") payload.reason = "使用者取消未過帳庫存單";
    if (id === "receive")
      payload.lines = d.lines
        .filter((l) => l.qty > l.received_qty)
        .map((l) => ({
          line_id: l.id,
          qty:
            document.querySelector(`[data-completion-receive="${l.id}"]`)
              ?.value || "0",
        }));
    await api("/api/completion/stock-action", payload);
    closeModal();
    await refresh();
    toast("庫存單狀態已更新");
  }
}
function applyUserInputOrder() {
  const root = document.querySelector("#doc-lines table");
  if (!root) return;
  const order = (
    S.data?.user_preferences?.input_order || "qty,price,discount_bp"
  ).split(",");
  const indexes = { qty: 1, price: 2, discount_bp: 3 },
    rows = [...root.querySelectorAll("tr")];
  for (const row of rows) {
    const cells = [...row.children];
    if (cells.length < 4) continue;
    const selected = order.map((key) => cells[indexes[key]]);
    for (const cell of selected) row.insertBefore(cell, cells[4] || null);
  }
}
