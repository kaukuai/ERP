import {
  fail,
  integer,
  scaled,
  txt,
  dateValue,
  today,
  now,
  ratio,
} from "./core.mjs";
import { moneyPermission } from "./control-access.mjs";
import {
  enterprisePermission as permission,
  enterpriseRows as rows,
  revision,
  event,
} from "./enterprise-common.mjs";
const resource = "foreign_accounts";
export function foreignMinor(value, precision) {
  if (precision === 0) {
    const s = String(value ?? "0");
    if (!/^\d{1,12}$/.test(s)) fail("此幣別不接受小數");
    return integer(s);
  }
  return scaled(value, precision);
}
export function baseAmount(amount, rate, precision = 2) {
  return ratio(amount, rate * 100, 10 ** precision * 1e6);
}
const control = (a) => (a.kind === "receivable" ? "1102" : "2002");
const gainLines = (difference, unrealized = false) =>
  difference > 0
    ? [[unrealized ? "4301" : "4300", 0, difference]]
    : difference < 0
      ? [[unrealized ? "5301" : "5300", -difference, 0]]
      : [];
const reverse = (lines) => lines.map(([a, d, c]) => [a, c, d]);
export class ForeignExchange {
  constructor(e) {
    this.e = e;
  }
  permission(u, action = "read", id = null) {
    permission(this.e, u, resource, action, id);
    moneyPermission(this.e, u);
  }
  rate(u, b) {
    this.e.access.requireAdmin(u);
    return this.e.tx(() => {
      const currency = txt(b.currency, 3, true).toUpperCase(),
        c = this.e.get(
          "SELECT * FROM fx_currencies WHERE code=? AND active=1",
          currency,
        );
      if (!c) fail("幣別不存在");
      const date = dateValue(b.date);
      if (date > today()) fail("不能登錄未來匯率");
      const rate = scaled(b.rate, 6, 1, 1e12),
        source = txt(b.source, 300, true),
        old = this.e.get(
          "SELECT * FROM fx_rates WHERE currency=? AND date=?",
          currency,
          date,
        );
      if ((old?.version || 0) !== integer(b.version ?? 0))
        fail("匯率已變更", 409);
      this.e.run(
        "INSERT INTO fx_rates(currency,date,rate,source,created_by) VALUES(?,?,?,?,?) ON CONFLICT(currency,date) DO UPDATE SET rate=excluded.rate,source=excluded.source,version=version+1,created_by=excluded.created_by",
        currency,
        date,
        rate,
        source,
        u.id,
      );
      const row = this.e.get(
        "SELECT * FROM fx_rates WHERE currency=? AND date=?",
        currency,
        date,
      );
      event(this.e, u, "fx_rates", row.id, "save", { before: old, after: row });
      return row;
    });
  }
  currency(u, b) {
    this.e.access.requireAdmin(u);
    const code = txt(b.code, 3, true).toUpperCase();
    if (!/^[A-Z]{3}$/.test(code) || code === "TWD")
      fail("請用 TWD 以外的三碼 ISO 幣別");
    return this.e.tx(() => {
      const old = this.e.get("SELECT * FROM fx_currencies WHERE code=?", code),
        precision = integer(b.precision, 0, 3);
      if (
        old &&
        (old.precision !== precision || old.version !== integer(b.version, 1))
      )
        fail("既有幣別精度不可變更或資料已更新", 409);
      this.e.run(
        "INSERT INTO fx_currencies(code,name,precision) VALUES(?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name,active=excluded.active,version=version+1",
        code,
        txt(b.name, 40, true),
        precision,
      );
      event(this.e, u, "fx_currencies", 0, "save", { code, precision });
      return { ok: true };
    });
  }
  quote(currency, date) {
    const r = this.e.get(
      "SELECT * FROM fx_rates WHERE currency=? AND date<=? ORDER BY date DESC LIMIT 1",
      currency,
      date,
    );
    if (!r) fail("此日期尚無可用匯率，請先登錄並註明來源", 409);
    return r;
  }
  account(u, id, action = "read") {
    this.permission(u, action, id);
    const a = this.e.get(
      "SELECT * FROM foreign_accounts WHERE id=?",
      integer(id, 1),
    );
    if (!a) fail("外幣帳款不存在", 404);
    this.e.partner(u, a.partner_id);
    a.lines = this.e.all(
      "SELECT * FROM foreign_account_lines WHERE account_id=?",
      a.id,
    );
    a.settlements = this.e.all(
      "SELECT * FROM fx_settlements WHERE account_id=? ORDER BY id",
      a.id,
    );
    return a;
  }
  create(u, b) {
    this.permission(u, "create");
    return this.e.tx(() => {
      const kind = b.kind;
      if (!["receivable", "payable"].includes(kind)) fail("帳款類型錯誤");
      const p = this.e.partner(
          u,
          b.partner_id,
          kind === "receivable" ? "customer" : "supplier",
        ),
        currency = txt(b.currency, 3, true).toUpperCase(),
        c = this.e.get(
          "SELECT * FROM fx_currencies WHERE code=? AND active=1",
          currency,
        );
      if (!c) fail("幣別不存在");
      const date = dateValue(b.date),
        due = dateValue(b.due_date || date);
      if (date > today() || due < date) fail("帳款日期或到期日錯誤");
      this.e.checkPeriod(date, "finance");
      const r = this.quote(currency, date);
      if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 100)
        fail("請輸入 1–100 筆明細");
      const ls = b.lines.map((l) => {
        const account = txt(l.account, 20, true),
          a = this.e.get("SELECT * FROM accounts WHERE code=?", account);
        if (!a || !["expense", "revenue"].includes(a.kind))
          fail("外幣憑證明細只接受收入／費用科目；存貨及既有應付請用原流程");
        return {
          account,
          description: txt(l.description, 200, true),
          amount: foreignMinor(l.amount, c.precision),
        };
      });
      if (ls.some((l) => !l.amount)) fail("明細金額須大於零");
      const amount = integer(
          ls.reduce((n, l) => n + l.amount, 0),
          1,
        ),
        home = baseAmount(amount, r.rate, c.precision);
      if (!home) fail("換算金額小於 0.01 TWD");
      const no = this.e.number(kind === "receivable" ? "FXAR" : "FXAP"),
        id = Number(
          this.e.run(
            "INSERT INTO foreign_accounts(no,kind,partner_id,currency,precision,foreign_amount,original_base,rate,date,due_date,notes,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            no,
            kind,
            p.id,
            currency,
            c.precision,
            amount,
            home,
            r.rate,
            date,
            due,
            txt(b.notes, 2000),
            u.id,
            now(),
          ).lastInsertRowid,
        );
      let done = 0,
        allocated = 0;
      for (const l of ls) {
        done += l.amount;
        const cumulative = ratio(home, done, amount),
          base = cumulative - allocated;
        allocated = cumulative;
        this.e.run(
          "INSERT INTO foreign_account_lines(account_id,account,description,foreign_amount,base_amount) VALUES(?,?,?,?,?)",
          id,
          l.account,
          l.description,
          l.amount,
          base,
        );
      }
      this.permission(u, "create", id);
      event(this.e, u, resource, id, "create", {
        currency,
        amount,
        home,
        rate: r,
      });
      return this.account(u, id);
    });
  }
  post(u, b) {
    return this.e.tx(() => {
      const a = this.account(u, b.id, "post");
      revision(a, b);
      if (a.status !== "draft") fail("只有草稿可以立帳", 409);
      this.e.checkPeriod(a.date, "finance");
      const ls =
        a.kind === "receivable"
          ? [
              [control(a), a.original_base, 0],
              ...a.lines.map((l) => [l.account, 0, l.base_amount]),
            ]
          : [
              ...a.lines.map((l) => [l.account, l.base_amount, 0]),
              [control(a), 0, a.original_base],
            ];
      this.e.journal(u, "外幣原始憑證", a.no, ls, a.date);
      this.e.run(
        "UPDATE foreign_accounts SET status='posted',book_value=original_base,version=version+1 WHERE id=?",
        a.id,
      );
      event(this.e, u, resource, a.id, "post", { lines: ls });
      return this.account(u, a.id);
    });
  }
  chronology(a, date) {
    const last = this.e.get(
      "SELECT max(date) date FROM (SELECT date FROM fx_settlements WHERE account_id=? AND status='posted' UNION ALL SELECT v.date FROM fx_valuations v JOIN fx_valuation_lines l ON l.valuation_id=v.id WHERE l.account_id=? AND v.status='posted')",
      a.id,
      a.id,
    )?.date;
    if (date < a.date || (last && date < last))
      fail("日期早於來源或後續收付／評價，請先沖回後續作業", 409);
    if (date > today()) fail("不能過帳未來日期");
    this.e.checkPeriod(date, "finance");
  }
  settle(u, b) {
    return this.e.tx(() => {
      const a = this.account(u, b.id, "post");
      revision(a, b);
      if (a.status !== "posted") fail("帳款尚未立帳或已結清", 409);
      const date = dateValue(b.date);
      this.chronology(a, date);
      const amount = foreignMinor(b.amount, a.precision),
        left = a.foreign_amount - a.foreign_paid;
      if (!amount || amount > left) fail("外幣收付超過未結餘額");
      const r = this.quote(a.currency, date),
        cash = baseAmount(amount, r.rate, a.precision),
        book =
          amount === left ? a.book_value : ratio(a.book_value, amount, left);

      const bank = this.e.get(
        "SELECT * FROM bank_accounts WHERE id=? AND active=1",
        integer(b.bank_account_id, 1),
      );
      if (!bank) fail("收付帳戶不存在");
      this.e.access.assert(
        this.e.access.policy(u),
        "banks",
        "post",
        "bank_accounts",
        bank.id,
      );
      if (
        a.kind === "payable" &&
        this.e.get(
          "SELECT COALESCE(sum(debit-credit),0) n FROM journal_lines WHERE account=?",
          bank.gl_code,
        ).n < cash
      )
        fail("付款帳戶餘額不足", 409);
      const gain = a.kind === "receivable" ? cash - book : book - cash,
        ls =
          a.kind === "receivable"
            ? [
                [bank.gl_code, cash, 0],
                [control(a), 0, book],
                ...gainLines(gain),
              ]
            : [
                [control(a), book, 0],
                [bank.gl_code, 0, cash],
                ...gainLines(gain),
              ],
        no = this.e.number("FXPAY");
      this.e.journal(u, "外幣收付與已實現匯兌", no, ls, date);
      const id = Number(
        this.e.run(
          "INSERT INTO fx_settlements(no,account_id,date,foreign_amount,rate,cash_amount,book_released,realized,bank_account_id,account_version,journal_snapshot,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
          no,
          a.id,
          date,
          amount,
          r.rate,
          cash,
          book,
          gain,
          bank.id,
          a.version + 1,
          JSON.stringify(ls),
          u.id,
          now(),
        ).lastInsertRowid,
      );
      this.e.run(
        "UPDATE foreign_accounts SET foreign_paid=foreign_paid+?,book_value=book_value-?,status=?,version=version+1 WHERE id=?",
        amount,
        book,
        amount === left ? "settled" : "posted",
        a.id,
      );
      event(this.e, u, resource, a.id, "settle", {
        id,
        no,
        rate: r,
        amount,
        cash,
        book,
        gain,
      });
      this.e.run(
        "INSERT INTO foreign_activity(account_id,kind,entity_id) VALUES(?,?,?)",
        a.id,
        "settlement",
        id,
      );
      return this.account(u, a.id);
    });
  }
  reverseSettlement(u, b) {
    return this.e.tx(() => {
      const s = this.e.get(
        "SELECT * FROM fx_settlements WHERE id=?",
        integer(b.settlement_id, 1),
      );
      if (!s) fail("收付不存在", 404);
      const a = this.account(u, s.account_id, "reverse");
      revision(a, b);
      const last = this.e.get(
        "SELECT * FROM foreign_activity WHERE account_id=? AND active=1 ORDER BY id DESC LIMIT 1",
        a.id,
      );
      if (
        s.status !== "posted" ||
        last?.kind !== "settlement" ||
        last.entity_id !== s.id
      )
        fail("請由最後一筆收付／評價依序沖回", 409);
      const reason = txt(b.reason, 500, true),
        date = dateValue(b.date);
      this.e.access.assert(
        this.e.access.policy(u),
        "banks",
        "post",
        "bank_accounts",
        s.bank_account_id,
      );
      if (a.kind === "receivable") {
        const bank = this.e.get(
          "SELECT * FROM bank_accounts WHERE id=?",
          s.bank_account_id,
        );
        if (
          this.e.get(
            "SELECT COALESCE(sum(debit-credit),0) n FROM journal_lines WHERE account=?",
            bank.gl_code,
          ).n < s.cash_amount
        )
          fail("退款帳戶餘額不足，不能沖回原收款", 409);
      }
      this.chronology(a, date);
      const no = this.e.number("FXREV");
      this.e.journal(
        u,
        "外幣收付沖回 " + reason,
        no,
        reverse(JSON.parse(s.journal_snapshot)),
        date,
      );
      this.e.run(
        "UPDATE fx_settlements SET status='reversed' WHERE id=?",
        s.id,
      );
      this.e.run("UPDATE foreign_activity SET active=0 WHERE id=?", last.id);
      this.e.run(
        "UPDATE foreign_accounts SET foreign_paid=foreign_paid-?,book_value=book_value+?,status='posted',version=version+1 WHERE id=?",
        s.foreign_amount,
        s.book_released,
        a.id,
      );
      event(this.e, u, resource, a.id, "reverse_settlement", {
        no,
        settlement_id: s.id,
        reason,
      });
      return this.account(u, a.id);
    });
  }
  valuation(u, b) {
    this.permission(u, "post");
    return this.e.tx(() => {
      const date = dateValue(b.date);
      if (date > today()) fail("評價日不可在未來");
      this.e.checkPeriod(date, "finance");
      if (
        !Array.isArray(b.account_ids) ||
        !b.account_ids.length ||
        b.account_ids.length > 200
      )
        fail("請選擇 1–200 筆未結帳款");
      const seen = new Set(),
        changes = [];
      for (const id of b.account_ids) {
        const a = this.account(u, id, "post");
        if (seen.has(a.id)) fail("帳款重複");
        seen.add(a.id);
        if (a.status !== "posted" || a.date > date)
          fail("來源不是評價日的未結帳款");
        this.chronology(a, date);
        const r = this.quote(a.currency, date),
          amount = a.foreign_amount - a.foreign_paid,
          next = baseAmount(amount, r.rate, a.precision),
          diff = next - a.book_value,
          gain = a.kind === "receivable" ? diff : -diff;
        const ls = diff
          ? [
              a.kind === "receivable"
                ? [control(a), Math.max(diff, 0), Math.max(-diff, 0)]
                : [control(a), Math.max(-diff, 0), Math.max(diff, 0)],
              ...gainLines(gain, true),
            ]
          : [];
        changes.push({ a, r, amount, next, ls });
      }
      const no = this.e.number("FXVAL"),
        id = Number(
          this.e.run(
            "INSERT INTO fx_valuations(no,date,created_by,created_at) VALUES(?,?,?,?)",
            no,
            date,
            u.id,
            now(),
          ).lastInsertRowid,
        );
      for (const { a, r, amount, next, ls } of changes) {
        this.e.journal(u, "外幣期末評價", no, ls, date);
        this.e.run(
          "INSERT INTO fx_valuation_lines(valuation_id,account_id,foreign_outstanding,old_book,new_book,rate,account_version,journal_snapshot) VALUES(?,?,?,?,?,?,?,?)",
          id,
          a.id,
          amount,
          a.book_value,
          next,
          r.rate,
          a.version + 1,
          JSON.stringify(ls),
        );
        this.e.run(
          "UPDATE foreign_accounts SET book_value=?,version=version+1 WHERE id=?",
          next,
          a.id,
        );
        this.e.run(
          "INSERT INTO foreign_activity(account_id,kind,entity_id) VALUES(?,?,?)",
          a.id,
          "valuation",
          id,
        );
      }
      event(this.e, u, "fx_valuations", id, "post", {
        no,
        accounts: changes.map((r) => r.a.id),
      });
      return { id, no };
    });
  }
  reverseValuation(u, b) {
    this.permission(u, "reverse");
    return this.e.tx(() => {
      const v = this.e.get(
        "SELECT * FROM fx_valuations WHERE id=?",
        integer(b.valuation_id, 1),
      );
      if (!v || v.status !== "posted") fail("評價不存在或已沖回", 409);
      const date = dateValue(b.date),
        reason = txt(b.reason, 500, true),
        ls = this.e.all(
          "SELECT * FROM fx_valuation_lines WHERE valuation_id=?",
          v.id,
        );
      for (const l of ls) {
        const a = this.account(u, l.account_id, "reverse");
        const last = this.e.get(
          "SELECT * FROM foreign_activity WHERE account_id=? AND active=1 ORDER BY id DESC LIMIT 1",
          a.id,
        );
        if (last?.kind !== "valuation" || last.entity_id !== v.id)
          fail("來源已有後續收付／評價，請先依序沖回", 409);
        this.chronology(a, date);
        this.e.journal(
          u,
          "期末評價沖回 " + reason,
          this.e.number("FXVR"),
          reverse(JSON.parse(l.journal_snapshot)),
          date,
        );
        this.e.run(
          "UPDATE foreign_accounts SET book_value=?,version=version+1 WHERE id=?",
          l.old_book,
          a.id,
        );
        this.e.run("UPDATE foreign_activity SET active=0 WHERE id=?", last.id);
      }
      this.e.run("UPDATE fx_valuations SET status='reversed' WHERE id=?", v.id);
      event(this.e, u, "fx_valuations", v.id, "reverse", { reason, date });
      return { ok: true };
    });
  }
  cancel(u, b) {
    return this.e.tx(() => {
      const a = this.account(u, b.id, "cancel");
      revision(a, b);
      if (a.status !== "draft") {
        this.permission(u, "reverse", a.id);
        if (
          a.status !== "posted" ||
          a.foreign_paid ||
          this.e.get(
            "SELECT id FROM foreign_activity WHERE account_id=? AND active=1",
            a.id,
          )
        )
          fail("請先依序沖回所有收付及評價，再取消原始憑證", 409);
        this.chronology(a, dateValue(b.date));
        const ls =
          a.kind === "receivable"
            ? [
                [control(a), a.original_base, 0],
                ...a.lines.map((l) => [l.account, 0, l.base_amount]),
              ]
            : [
                ...a.lines.map((l) => [l.account, l.base_amount, 0]),
                [control(a), 0, a.original_base],
              ];
        this.e.journal(
          u,
          "外幣原始憑證沖回 " + txt(b.reason, 500, true),
          this.e.number("FXC"),
          reverse(ls),
        );
      }
      this.e.run(
        "UPDATE foreign_accounts SET status='cancelled',book_value=0,version=version+1 WHERE id=?",
        a.id,
      );
      event(this.e, u, resource, a.id, "cancel", {
        reason: txt(b.reason, 500, true),
      });
      return this.account(u, a.id);
    });
  }
  data(u) {
    this.permission(u);
    return {
      currencies: this.e.all("SELECT * FROM fx_currencies"),
      rates: this.e.all("SELECT * FROM fx_rates ORDER BY date DESC LIMIT 500"),
      accounts: rows(this.e, u, resource),
      valuations: rows(this.e, u, "fx_valuations"),
      gl_accounts: this.e.all(
        "SELECT * FROM accounts WHERE kind IN ('expense','revenue')",
      ),
      banks: this.e.all("SELECT id,code,name FROM bank_accounts"),
    };
  }
}
