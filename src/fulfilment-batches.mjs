import { legacySales } from './access-control.mjs';
import { permit,has,fail,integer,scaled,ratio,txt,now } from './core.mjs';
import { printPage } from './operations.mjs';
import { escapeHTML as E } from './print.mjs';

const money = n => (n / 100).toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = n => (n / 1000).toLocaleString('zh-TW', { maximumFractionDigits: 3 });
export class FulfilmentBatches {
  constructor(erp) { this.e = erp; }
  create(u, b) {
    permit(u, 'stock');
    return this.e.tx(() => {
      const e = this.e;
      if (!Array.isArray(b.documents) || b.documents.length < 2 || b.documents.length > 100) fail('請選擇 2–100 張來源單據');
      const seen = new Set();
      const sources = b.documents.map(source => {
        const d = e.doc(u, source.document_id);
        if (seen.has(d.id)) fail('來源單據重複');
        seen.add(d.id);
        if (d.version !== integer(source.version, 1)) fail('來源單據已更新，請重新載入', 409);
        if (!['order', 'purchase'].includes(d.kind) || !['approved', 'partial'].includes(d.status)) fail('請選擇已核准且未交完的訂單或採購單', 409);
        if (source.lines !== undefined) {
          if (!Array.isArray(source.lines) || !source.lines.length) fail('請填本次交貨明細');
          for (const line of source.lines) scaled(line.qty, 3);
        }
        if (e.get("SELECT pl.id FROM pick_lines pl JOIN pick_lists p ON p.id=pl.pick_id JOIN document_lines dl ON dl.id=pl.document_line_id WHERE dl.document_id=? AND p.status='draft' LIMIT 1", d.id)) fail('來源訂單已有作業中的揀貨單，請先完成或取消揀貨', 409);
        return { d, lines: source.lines, lots: source.lots };
      });
      const first = sources[0].d;
      if (sources.some(({ d }) => d.kind !== first.kind || d.partner_id !== first.partner_id || d.warehouse_id !== first.warehouse_id)) fail('合併單必須同一往來對象、倉庫及單據類型');
      if (b.shipping_address === undefined && sources.some(({ d }) => d.shipping_address !== first.shipping_address)) fail('來源送貨地址不同，請指定本次合併送貨地址');
      const no = e.number(first.kind === 'order' ? 'MS' : 'MR');
      const id = Number(e.run('INSERT INTO fulfilment_batches(no,kind,partner_id,warehouse_id,partner_snapshot,shipping_address,notes,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)', no, first.kind === 'order' ? 'shipment' : 'receipt', first.partner_id, first.warehouse_id, first.partner_snapshot, txt(b.shipping_address ?? first.shipping_address, 300), txt(b.notes, 2000), u.id, now()).lastInsertRowid);
      // Keep each source's frozen units, tax allocation, cost and return linkage.
      // The outer transaction makes the combined document and all postings atomic.
      for (const { d, lines, lots } of sources) {
        const f = e.fulfil(u, d.id, lines === undefined ? {lots} : { lines,lots });
        e.run('INSERT INTO fulfilment_batch_sources VALUES(?,?)', id, f.id);
      }
      e.log(u, 'combine_fulfilments', 'fulfilment_batch', id, { no, documents: [...seen] });
      return this.get(u, id);
    });
  }
  get(u, id) {
    permit(u, 'all');
    if (legacySales(u)) fail('無權存取合併出入庫資料', 403);
    const e = this.e, batch = e.get('SELECT b.*,w.name warehouse_name FROM fulfilment_batches b JOIN warehouses w ON w.id=b.warehouse_id WHERE b.id=?', integer(id, 1));
    if (!batch) fail('合併出入庫單不存在', 404);
    batch.partner = JSON.parse(batch.partner_snapshot);
    batch.sources = e.all('SELECT f.*,d.no document_no FROM fulfilment_batch_sources s JOIN fulfilments f ON f.id=s.fulfilment_id JOIN documents d ON d.id=f.document_id WHERE s.batch_id=? ORDER BY f.id', batch.id);
    batch.lines = [];
    for (const source of batch.sources) {
      const f = e.fulfilment(u, source.id);
      if(source.calc_version<2&&(batch.kind==='shipment'||has(u,'cost'))){
        const total=f.lines.reduce((sum,line)=>sum+line.amount,0);let basis=0,net=0,tax=0;
        for(const line of f.lines){basis+=line.amount;const nextNet=total?ratio(source.net,basis,total):0,nextTax=total?ratio(source.tax,basis,total):0;line.net=nextNet-net;line.tax=nextTax-tax;line.total=line.net+line.tax;net=nextNet;tax=nextTax;}
      }
      batch.lines.push(...f.lines.map(line => ({ ...line, document_id: source.document_id, document_no: source.document_no, source_no: source.no })));
    }
    for (const key of ['net', 'tax', 'total']) batch[key] = integer(batch.sources.reduce((sum, f) => sum + f[key], 0));
    for (const source of batch.sources) {
      if (!has(u, 'cost')) { delete source.cost; if (batch.kind === 'receipt') for (const key of ['net', 'tax', 'total']) delete source[key]; }
    }
    if (!has(u, 'cost') && batch.kind === 'receipt') for (const key of ['net', 'tax', 'total']) delete batch[key];
    return batch;
  }
  data(u) {
    if (legacySales(u)) return {};
    return { fulfilment_batches: this.e.all('SELECT id FROM fulfilment_batches ORDER BY id DESC LIMIT 500').map(row => {
      const b = this.get(u, row.id);
      delete b.lines; delete b.partner_snapshot;
      return b;
    }) };
  }
  print(u, id) {
    const b = this.get(u, id), amounts = b.kind === 'shipment' || has(u, 'cost');
    return printPage((b.kind === 'shipment' ? '合併出貨單 ' : '合併進貨單 ') + b.no,
      `<p>${E(b.partner.name)} · ${E(b.warehouse_name)} · ${E(b.created_at.slice(0,10))}</p><p>送貨地址：${E(b.shipping_address)}</p><table><thead><tr><th>來源單據／出入庫</th><th>品號／品名</th><th>數量／單位</th>${amounts ? '<th>未稅</th><th>稅額</th><th>含稅</th>' : ''}</tr></thead><tbody>${b.lines.map(l => `<tr><td>${E(l.document_no)}<br>${E(l.source_no)}</td><td>${E(l.sku)} ${E(l.name)}</td><td>${qty(l.qty)} ${E(l.unit)}</td>${amounts ? `<td>${money(l.net ?? l.amount)}</td><td>${money(l.tax ?? 0)}</td><td>${money(l.total ?? l.amount)}</td>` : ''}</tr>`).join('')}</tbody></table>${amounts ? `<p>未稅 ${money(b.net)} · 稅額 ${money(b.tax)} · 合計 TWD ${money(b.total)}</p>` : ''}<p>備註：${E(b.notes)}</p>`);
  }
}
