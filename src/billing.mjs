import { permit,has,fail,integer,scaled,txt,dateValue,today,now } from './core.mjs';
import { Finance } from './finance.mjs';
import { billingDates } from './rules.mjs';
import { printPage } from './operations.mjs';
import { escapeHTML as E } from './print.mjs';

export function recordOpenItem(e, fid, kind, partner, total, date = today()) {
  const billing = billingDates(date, partner), pending = partner.billing_policy === 'batch' && !e.forceImmediateBilling;
  e.run('INSERT INTO open_items(fulfilment_id,kind,partner_id,amount,due_date,account_period,billing_state,closing_date) VALUES(?,?,?,?,?,?,?,?)', fid, kind, partner.id, total, billing.due_date, billing.period, pending ? 'pending' : 'posted', billing.closing_date);
  return kind === 'receivable' ? (pending ? '1110' : '1100') : (pending ? '2005' : '2000');
}
export const itemAccount = item => item.kind === 'receivable' ? (item.billing_state === 'pending' ? '1110' : '1100') : (item.billing_state === 'pending' ? '2005' : '2000');

export class MonthlyBilling {
  constructor(e) { this.e = e; }
  pending(u, b) {
    permit(u, 'finance');
    if (!['receivable', 'payable'].includes(b.kind)) fail('應收付類型錯誤');
    const partner = this.e.partner(u, b.partner_id, b.kind === 'receivable' ? 'customer' : 'supplier');
    const period = txt(b.account_period, 7, true);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) fail('帳期需為 YYYY-MM');
    const rows = this.e.all("SELECT o.*,f.no source_no,f.date,d.no document_no FROM open_items o JOIN fulfilments f ON f.id=o.fulfilment_id JOIN documents d ON d.id=f.document_id WHERE o.partner_id=? AND o.kind=? AND o.account_period=? AND o.billing_state='pending' ORDER BY o.id", partner.id, b.kind, period);
    return { partner, period, rows, total: integer(rows.reduce((sum, row) => sum + row.amount, 0)) };
  }
  close(u, b) {
    permit(u, 'finance');
    return this.e.tx(() => {
      const e = this.e, p = this.pending(u, b), date = dateValue(b.date);
      e.checkPeriod(date);
      if (date > today()) fail('立帳日不可晚於今天');
      if (!p.rows.length) fail('此帳期沒有待立帳交易，可能已完成月結', 409);
      if (p.rows.some(row => row.closing_date > date)) fail('尚未到本帳期截止日', 409);
      if (!Array.isArray(b.items) || b.items.length !== p.rows.length || new Set(b.items.map(x => x.id)).size !== p.rows.length || p.rows.some(row => !b.items.some(x => x.id === row.id && x.amount === row.amount))) fail('待立帳資料已異動，請重新預覽', 409);
      const due = b.due_date ? dateValue(b.due_date) : p.rows.reduce((max, row) => row.due_date > max ? row.due_date : max, p.rows[0].due_date);
      const no = e.number(b.kind === 'receivable' ? 'MBR' : 'MBP');
      const id = Number(e.run('INSERT INTO billing_batches(no,kind,partner_id,partner_snapshot,account_period,date,due_date,amount_snapshot,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', no, b.kind, p.partner.id, JSON.stringify({ code: p.partner.code, name: p.partner.name }), p.period, date, due, p.total, u.id, now()).lastInsertRowid);
      for (const row of p.rows) {
        if (row.paid !== 0) fail('待立帳交易已有沖帳，請先核對', 409);
        e.run('INSERT INTO billing_batch_lines VALUES(?,?,?)', id, row.id, row.amount);
        e.run("UPDATE open_items SET billing_state='posted',billing_batch_id=?,due_date=? WHERE id=? AND billing_state='pending'", id, due, row.id);
      }
      if (p.total) e.journal(u, '批次月結立帳', no, b.kind === 'receivable' ? [['1100', p.total, 0], ['1110', 0, p.total]] : [['2005', p.total, 0], ['2000', 0, p.total]], date);
      e.log(u, 'monthly_billing', 'billing_batch', id, { no, total: p.total, source_items: p.rows.map(row => row.id) });
      return this.get(u, id);
    });
  }
  get(u, id) {
    permit(u, 'finance');
    const e = this.e, batch = e.get('SELECT * FROM billing_batches WHERE id=?', integer(id, 1));
    if (!batch) fail('月結帳單不存在', 404);
    batch.partner = JSON.parse(batch.partner_snapshot);
    batch.lines = e.all('SELECT o.*,l.amount_snapshot,f.no source_no,d.no document_no FROM billing_batch_lines l JOIN open_items o ON o.id=l.open_item_id JOIN fulfilments f ON f.id=o.fulfilment_id JOIN documents d ON d.id=f.document_id WHERE l.batch_id=? ORDER BY o.id', batch.id);
    batch.amount = integer(batch.lines.reduce((sum, row) => sum + row.amount, 0));
    batch.paid = integer(batch.lines.reduce((sum, row) => sum + row.paid, 0));
    batch.outstanding = batch.amount - batch.paid;
    return batch;
  }
  pay(u, id, b) {
    permit(u, 'finance');
    return this.e.tx(() => {
      const batch = this.get(u, id), finance = new Finance(this.e), bank = finance.bank(b.bank_account_id), amount = scaled(b.amount, 2, 1);
      if (amount > batch.outstanding) fail('沖帳金額超過月結帳單餘額', 409);
      const date = dateValue(b.date);
      if (date < batch.date) fail('收付款日不得早於立帳日');
      let remaining = amount;
      for (const row of batch.lines) {
        const allocation = Math.min(remaining, row.amount - row.paid);
        if (allocation) this.e.pay(u, { open_item_id: row.id, amount: String(allocation / 100), bank_account_id: bank.id, method: bank.kind, date, reference: batch.no + ' ' + txt(b.reference, 200) });
        remaining -= allocation;
      }
      this.e.log(u, 'pay_monthly_bill', 'billing_batch', batch.id, { amount });
      return this.get(u, id);
    });
  }
  data(u) {
    if (!has(u, 'finance')) return {};
    return {
      monthly_bills: this.e.all('SELECT id FROM billing_batches ORDER BY id DESC LIMIT 1000').map(row => { const b = this.get(u, row.id); delete b.lines; delete b.partner_snapshot; return b; }),
      pending_billing: this.e.all("SELECT o.*,p.name partner_name,f.no source_no FROM open_items o JOIN partners p ON p.id=o.partner_id JOIN fulfilments f ON f.id=o.fulfilment_id WHERE o.billing_state='pending' ORDER BY o.account_period,o.partner_id,o.id"),
    };
  }
  print(u, id) {
    const b = this.get(u, id), m = n => (n / 100).toFixed(2);
    return printPage('月結' + (b.kind === 'receivable' ? '應收' : '應付') + '帳單 ' + b.no, `<p>${E(b.partner.name)} · 帳期 ${E(b.account_period)} · 立帳 ${E(b.date)} · 到期 ${E(b.due_date)}</p><table><tr><th>來源單據</th><th>出入庫單</th><th>立帳快照</th><th>目前帳額</th><th>已沖</th><th>未結</th></tr>${b.lines.map(l => `<tr><td>${E(l.document_no)}</td><td>${E(l.source_no)}</td><td>${m(l.amount_snapshot)}</td><td>${m(l.amount)}</td><td>${m(l.paid)}</td><td>${m(l.amount-l.paid)}</td></tr>`).join('')}</table><p>立帳合計 TWD ${m(b.amount_snapshot)} · 目前未結 TWD ${m(b.outstanding)}</p>`);
  }
}
