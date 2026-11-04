function workflowsPage() {
  const d = S.data, p = d.permissions, tab = S.tab || 'combined';
  const tabs = [['combined','合併進出貨'], ...(p.finance ? [['monthly','批次月結']] : []),...extraWorkflowTabs()];
  let body = '', actions = '';
  if (tab === 'combined' && d.user.role !== 'sales') {
    body = table(['合併單號','類型','往來／倉庫','來源單數','合計 TWD',''], (d.fulfilment_batches || []).map(b => `<tr><td class="mono">${E(b.no)}</td><td>${b.kind==='shipment'?'合併出貨':'合併進貨'}</td><td>${E(b.partner.name)}<span class="mini-name">${E(b.warehouse_name)}</span></td><td>${b.sources.length}</td><td>${money(b.total,true)}</td><td>${btn('明細／列印','workflow-batch-open',b.id,'small')}</td></tr>`));
    if (p.stock) actions = btn('建立合併單','workflow-batch-form','','primary','plus');
  } else if (tab === 'monthly' && p.finance) {
    const groups = new Map();
    for (const item of d.pending_billing || []) {
      const key = `${item.partner_id}:${item.kind}:${item.account_period}`;
      if (!groups.has(key)) groups.set(key, {...item, amount:0, count:0});
      const group = groups.get(key); group.amount += item.amount; group.count++;
    }
    body = panel('待月結交易', table(['對象','方向／帳期','筆數','待立帳 TWD',''], [...groups].map(([key,g]) => `<tr><td>${E(g.partner_name)}</td><td>${g.kind==='receivable'?'應收':'應付'} · ${E(g.account_period)}</td><td>${g.count}</td><td>${money(g.amount,true)}</td><td>${btn('預覽月結','workflow-month-preview',key,'small')}</td></tr>`))) + panel('月結帳單', table(['帳單／對象','方向／帳期','立帳／到期','立帳快照','目前未結',''], (d.monthly_bills||[]).map(b => `<tr><td>${E(b.no)}<span class="mini-name">${E(b.partner.name)}</span></td><td>${b.kind==='receivable'?'應收':'應付'} · ${E(b.account_period)}</td><td>${E(b.date)}<span class="mini-name">${E(b.due_date)}</span></td><td>${money(b.amount_snapshot,true)}</td><td>${money(b.outstanding,true)}</td><td>${btn('明細','workflow-month-open',b.id,'small')}${b.outstanding?btn('收付款','workflow-month-pay',b.id,'small'):''}</td></tr>`)));
  } else {const extra=extraWorkflowContent(tab);if(extra){body=extra.body;actions=extra.actions||'';}else body='<div class="empty">目前帳號沒有這項作業的檢視權限。</div>';}
  return head('交易作業中心','合併單逐列保留來源；月結先核對待立帳交易，再產生帳單。',actions) + tabBar(tabs,tab) + `<section class="panel">${body}</section>`;
}

async function workflowAction(action, id) {
  if (action === 'workflow-batch-form') {
    modal('選擇合併進出貨範圍', `<form id="modal-form" data-form="workflow-batch-choose"><div class="form-grid">${selectField('作業類型','kind','<option value="order">合併出貨</option><option value="purchase">合併進貨</option>')}${selectField('往來對象','partner_id',options(S.data.partners,'name','id',''))}${selectField('出入庫倉庫','warehouse_id',options(S.data.warehouses,'name','id',''))}</div><p class="hint">只可選擇同一對象、倉庫及類型的已核准未交單。</p></form>`, formFooter('選擇來源單據'));
  } else if (action === 'workflow-batch-open') {
    const b = await api('/api/fulfilment-batches/'+id);
    modal('合併單 '+b.no, `<p>${E(b.partner.name)} · ${E(b.warehouse_name)}</p><p>送貨地址：${E(b.shipping_address)}</p>${table(['來源單／出入庫','商品','交易數量','已退數量'],b.lines.map(l=>`<tr><td>${E(l.document_no)}<span class="mini-name">${E(l.source_no)}</span></td><td>${E(l.sku)} · ${E(l.name)}</td><td>${Q(l.qty)} ${E(l.unit)}</td><td>${Q(l.returned_qty)}</td></tr>`))}<p>合計 TWD ${money(b.total,true)} · ${E(b.notes)}</p>${S.data.permissions.approve?table(['原始出入庫','退貨'],b.sources.map(f=>`<tr><td>${E(f.no)} · ${E(f.document_no)}</td><td>${btn('依來源退貨','return-form',f.id,'small')}</td></tr>`)):''}`,btn('關閉','close')+`<a class="btn primary" href="/print/fulfilment-batches/${b.id}" target="_blank" rel="noopener">列印合併單</a>`,true);
  } else if (action === 'workflow-month-preview') {
    const [partner_id,kind,account_period] = id.split(':');
    const preview = await api('/api/monthly-bills/preview?'+new URLSearchParams({partner_id,kind,account_period}));
    S.monthPreview = {...preview,kind};
    const cutoff = preview.rows.reduce((date,r)=>r.closing_date>date?r.closing_date:date,'');
    modal('批次月結預覽',`<form id="modal-form" data-form="workflow-month-close"><p>${E(preview.partner.name)} · ${E(preview.period)} · 合計 TWD ${money(preview.total,true)}</p>${table(['來源單據','出入庫','截止日','待立帳'],preview.rows.map(r=>`<tr><td>${E(r.document_no)}</td><td>${E(r.source_no)}</td><td>${E(r.closing_date)}</td><td>${money(r.amount,true)}</td></tr>`))}<div class="form-grid">${field('立帳日期','date',S.data.today,'date',`required min="${E(cutoff)}" max="${E(S.data.today)}"`)}</div><p class="hint">${cutoff>S.data.today?'尚未到截止日 '+E(cutoff)+'，目前僅能預覽。':'確認後將全部待立帳交易合成一張帳單。來源異動時須重新預覽。'}</p></form>`,cutoff>S.data.today?btn('關閉','close'):formFooter('確認月結立帳'),true);
  } else if (action === 'workflow-month-open') {
    const b=await api('/api/monthly-bills/'+id);
    modal('月結帳單 '+b.no,`<p>${E(b.partner.name)} · ${E(b.account_period)} · 到期 ${E(b.due_date)}</p>${table(['來源訂單','出入庫','立帳快照','目前帳額','已沖帳','未結'],b.lines.map(l=>`<tr><td>${E(l.document_no)}</td><td>${E(l.source_no)}</td><td>${money(l.amount_snapshot,true)}</td><td>${money(l.amount,true)}</td><td>${money(l.paid,true)}</td><td>${money(l.amount-l.paid,true)}</td></tr>`))}<p>目前未結 TWD ${money(b.outstanding,true)}</p>`,btn('關閉','close')+`<a class="btn primary" href="/print/monthly-bills/${b.id}" target="_blank" rel="noopener">列印帳單</a>`,true);
  } else if (action === 'workflow-month-pay') {
    const b=await api('/api/monthly-bills/'+id); S.monthPay=b;
    modal('月結帳單收付款',`<form id="modal-form" data-form="workflow-month-pay"><p>${E(b.no)} · ${E(b.partner.name)} · 未結 ${money(b.outstanding,true)}</p><div class="form-grid">${selectField('資金帳戶','bank_account_id',options(S.data.bank_accounts.filter(b=>b.active),'name','id',''))}${field('收付款金額 TWD','amount',inputMoney(b.outstanding),'number',`required min="0.01" max="${inputMoney(b.outstanding)}" step="0.01"`)}${field('日期','date',S.data.today,'date','required')}${field('參考','reference','')}</div></form>`,formFooter('確認收付款'));
  } else return extraWorkflowAction(action,id);
  return true;
}

async function workflowSubmit(kind,b) {
  if(kind==='workflow-batch-choose') {
    const docs=S.data.documents.filter(d=>d.kind===b.kind&&d.partner_id===Number(b.partner_id)&&d.warehouse_id===Number(b.warehouse_id)&&['approved','partial'].includes(d.status));
    S.batchScope=b;
    modal('選擇來源單據',`<form id="modal-form" data-form="workflow-batch-select">${table(['選取','單號','對象','未交量'],docs.map(d=>`<tr><td><input type="checkbox" name="batch_choice" value="${d.id}" aria-label="選取 ${E(d.no)}"></td><td>${E(d.no)}</td><td>${E(d.partner_name)}</td><td>${Q(d.remaining_qty)}</td></tr>`))}<p class="hint">請選 2–100 張；下一步逐列指定本次交貨數量。</p></form>`,formFooter('填寫本次數量'),true); return;
  }
  if(kind==='workflow-batch-select') {
    const ids=$$('[name="batch_choice"]:checked').map(x=>x.value);
    if(ids.length<2||ids.length>100)throw Error('請選擇 2–100 張來源單據');
    const docs=await Promise.all(ids.map(id=>api('/api/documents/'+id))); S.batchSources=docs;
    modal('本次合併進出貨',`<form id="modal-form" data-form="workflow-batch-post">${table(['來源單據','商品','待交量','本次交貨量'],docs.flatMap(d=>d.lines.filter(l=>l.qty>l.done_qty+l.closed_qty).map(l=>`<tr><td>${E(d.no)}</td><td>${E(l.sku)} · ${E(l.name)}</td><td>${Q(l.qty-l.done_qty-l.closed_qty)} ${E(l.unit)}</td><td><input type="number" data-batch-line="${l.id}" data-document="${d.id}" min="0" max="${inputQty(l.qty-l.done_qty-l.closed_qty)}" step="0.001" value="${inputQty(l.qty-l.done_qty-l.closed_qty)}" required aria-label="${E(d.no)} ${E(l.sku)} 本次數量"></td></tr>`)))}<div class="form-grid">${field('本次送貨地址','shipping_address',docs[0].shipping_address,'text','maxlength="300"')}${textarea('合併單備註','notes','')}</div><p class="hint">不交貨的列填 0；每張來源單至少需有一列本次數量。確認後所有來源同時過帳，任何錯誤將整批回復。</p></form>`,formFooter('確認合併與過帳'),true); return;
  }
  let result,open;
  if(kind==='workflow-batch-post') {
    const documents=S.batchSources.map(d=>({document_id:d.id,version:d.version,lines:$$('[data-batch-line]').filter(x=>Number(x.dataset.document)===d.id).map(x=>({line_id:Number(x.dataset.batchLine),qty:x.value})).filter(x=>Number(x.qty)>0)}));
    result=await api('/api/fulfilment-batches',{...b,documents});open='workflow-batch-open';
  } else if(kind==='workflow-month-close') {
    const p=S.monthPreview;
    result=await api('/api/monthly-bills',{...b,kind:p.kind,partner_id:p.partner.id,account_period:p.period,items:p.rows.map(r=>({id:r.id,amount:r.amount}))});open='workflow-month-open';
  } else if(kind==='workflow-month-pay') {
    result=await api('/api/monthly-bills/'+S.monthPay.id+'/pay',b);open='workflow-month-open';
  } else {if(await extraWorkflowSubmit(kind,b))return;throw Error('未知的交易作業');}
  closeModal();await refresh();if(open)await workflowAction(open,result.id);toast('作業完成 · '+result.no);
}
