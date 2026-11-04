function extraWorkflowTabs(){const p=S.data.permissions;return [...(p.sell?[['metadata','外部／發票欄位'],['order-import','訂單匯入／SKU']]:[]),...(p.sell||p.stock?[['subscriptions','分期排程']]:[]),['custom-reports','自訂報表'],...financeWorkflowTabs(),...stockInvoiceTabs(),...servicePosTabs(),...companyWorkflowTabs()];}
function extraWorkflowContent(tab){
  const d=S.data,p=d.permissions;
  if(tab==='metadata'&&p.sell)return {body:table(['單號','客戶','狀態',''],d.documents.filter(x=>x.kind!=='purchase').map(x=>`<tr><td>${E(x.no)}</td><td>${E(x.partner_name)}</td><td>${status(x.status)}</td><td>${btn('外部／發票資料','workflow-meta',x.id,'small')}</td></tr>`))};
  if(tab==='subscriptions'&&(p.sell||p.stock))return {actions:p.approve?btn('建立分期排程','workflow-plan-form','','primary','plus'):'',body:table(['排程','來源訂單','狀態','期數',''],(d.subscription_plans||[]).map(x=>`<tr><td>${E(x.no)}</td><td>${E(x.document_no)}</td><td>${E({active:'進行中',paused:'已暫停',closed:'已結束'}[x.status])}</td><td>${x.periods.length}</td><td>${btn('期別／歷程','workflow-plan-open',x.id,'small')}</td></tr>`))};
  if(tab==='order-import'&&p.sell)return {actions:btn('新增欄位範本','workflow-template-form','','','plus')+btn('預覽匯入訂單','workflow-import-form','','primary','plus'),body:panel('欄位範本',table(['名稱','來源系統／商店','修訂',''],(d.order_import_templates||[]).map(t=>`<tr><td>${E(t.name)}</td><td>${E(t.namespace)}</td><td>${t.version}</td><td>${btn('修改映射','workflow-template-form',t.id,'small')}</td></tr>`)))+panel('平台 SKU 精確映射',table(['來源系統／商店','外部 SKU','ERP 品號／單位',''],(d.sku_mappings||[]).map(m=>`<tr><td>${E(m.platform)}</td><td>${E(m.external_sku)}</td><td>${E(m.sku)} · ${E(d.product_units.find(x=>x.id===m.unit_id)?.name||d.products.find(x=>x.id===m.product_id)?.unit)}</td><td>${p.masters?btn('修改','workflow-sku-form',m.id,'small'):''}</td></tr>`)),p.masters?btn('新增 SKU 映射','workflow-sku-form','','small','plus'):'')+panel('匯入與例外佇列',table(['批次','來源系統','狀態','錯誤'],(d.order_import_jobs||[]).map(j=>`<tr><td>#${j.id}</td><td>${E(j.namespace)}</td><td>${j.status==='committed'?'已建立訂單':'預覽'}</td><td>${j.errors.map(e=>`第 ${e.row} 列：${E(e.message)}`).join('<br>')||'無'}</td></tr>`)))};
  if(tab==='custom-reports')return {actions:d.user.role==='admin'?btn('新增報表版型','workflow-report-form','','primary','plus'):'',body:table(['報表名稱','資料集','可檢視／列印角色',''],(d.report_designs||[]).map(r=>`<tr><td>${E(r.name)}</td><td>${E(r.dataset)}</td><td>${r.view_roles.map(x=>E(roleNames[x])).join('、')}<span class="mini-name">列印：${r.print_roles.map(x=>E(roleNames[x])).join('、')}</span></td><td>${btn('查詢','workflow-report-run',r.id,'small')}${d.user.role==='admin'?btn('設計／權限','workflow-report-form',r.id,'small'):''}</td></tr>`))};
  return financeWorkflowContent(tab);
}

async function extraWorkflowAction(a,id){
  const d=S.data;
  if(a==='workflow-meta'){
    const doc=await api('/api/documents/'+id),m=await api('/api/documents/'+id+'/metadata');S.workflowDoc=doc;
    const edit=['draft','rejected'].includes(doc.status);
    modal('外部／發票資料 · '+doc.no,`<form id="modal-form" data-form="workflow-meta"><fieldset ${edit?'':'disabled'} style="border:0;padding:0"><div class="form-grid">${field('外部平台／商店代碼','platform',m.platform)}${field('外部訂單號','external_ref',m.external_ref)}${field('買受人統編','buyer_tax_id',m.buyer_tax_id)}${selectField('載具類型','carrier_type',[['','不使用'],['mobile','手機條碼'],['citizen','自然人憑證'],['other','其他載具']].map(([k,n])=>`<option value="${k}" ${m.carrier_type===k?'selected':''}>${n}</option>`).join(''))}${field('載具號碼','carrier_id',m.carrier_id)}${field('捐贈碼','donation_code',m.donation_code)}${field('物流商','logistics_provider',m.logistics_provider)}${field('物流追蹤號碼','tracking_no',m.tracking_no)}</div></fieldset><p class="hint">${edit?'存檔後增加修訂號；核准後保留原值。':'此單已核准，資料已凍結。'}此處保存資料，不會開立發票或向物流商送出請求。</p></form>`,edit?formFooter():btn('關閉','close'));
  }else if(a==='workflow-plan-form'){
    modal('建立分期排程',`<form id="modal-form" data-form="workflow-plan-choose"><div class="form-grid">${selectField('已核准訂單','document_id',options(d.documents.filter(x=>x.kind==='order'&&['approved','partial'].includes(x.status)&&!(d.subscription_plans||[]).some(p=>p.document_id===x.id)),x=>x.no+' · '+x.partner_name,'id',''))}${field('期數','count','3','number','required min="1" max="120" step="1"')}${field('第一期日期','start',d.today,'date','required')}${field('每期間隔天數','interval','30','number','required min="1" max="366" step="1"')}</div></form>`,formFooter('核對各期數量'));
  }else if(a==='workflow-plan-open'){
    const p=await api('/api/subscriptions/'+id);S.workflowPlan=p;
    modal('分期排程 '+p.no,`<p>${E(p.document_no)} · ${E({active:'進行中',paused:'已暫停',closed:'已結束'}[p.status])}</p>${table(['到期','狀態','各列數量','作業'],p.periods.map(r=>`<tr><td>${E(r.due_date)}</td><td>${E({pending:'待出貨',skipped:'已跳期',completed:'已出貨'}[r.status])}</td><td>${r.lines.map(l=>`來源列 #${l.line_id}：${E(l.qty)}`).join('<br>')}</td><td>${r.status==='pending'&&p.status!=='closed'?`${d.permissions.approve?btn('調整','workflow-period-adjust',r.id,'small')+btn('跳期','workflow-period-skip',r.id,'small'):''}${d.permissions.stock&&p.status==='active'?btn('執行出貨','workflow-period-execute',r.id,'small'):''}`:''}</td></tr>`))}<div class="section-title">不可覆寫的排程歷程</div>${table(['時間','操作','內容'],p.events.map(e=>`<tr><td>${E(e.created_at)}</td><td>${E(e.action)}</td><td>${E(e.detail)}</td></tr>`))}`,btn('關閉','close')+(d.permissions.approve&&p.status!=='closed'?btn(p.status==='paused'?'恢復排程':'暫停排程','workflow-plan-status',p.id)+btn('結束排程','workflow-plan-close',p.id):''),true);
  }else if(['workflow-plan-status','workflow-plan-close','workflow-period-skip','workflow-period-execute','workflow-period-adjust'].includes(a)){
    const plan=S.workflowPlan,period=plan.periods.find(p=>p.id===Number(id));S.workflowScheduleAction={a,plan,period};let content='';
    if(a==='workflow-period-adjust'){
      const doc=await api('/api/documents/'+plan.document_id);S.workflowScheduleAction.doc=doc;
      content=field('本期日期','due_date',period.due_date,'date','required')+table(['來源商品','本期數量'],doc.lines.map(l=>`<tr><td>${E(l.sku)} · ${E(l.name)}</td><td><input type="number" data-period-adjust="${l.id}" min="0" step="0.001" value="${E(period.lines.find(x=>x.line_id===l.id)?.qty||'0')}" required aria-label="${E(l.sku)} 本期數量"></td></tr>`));
    }
    const execute=a==='workflow-period-execute';
    modal(execute?'確認本期出貨':'調整排程',`<form id="modal-form" data-form="workflow-schedule-action"><p>${E(plan.no)} ${period?E(period.due_date):''}</p>${content}${execute?'<p>將依本期數量出庫與立帳，任何錯誤將整筆回復。</p>':textarea('原因（必填）','reason','')}</form>`,formFooter(execute?'確認出貨':'確認儲存'));
  }else if(a==='workflow-sku-form'){
    const m=(d.sku_mappings||[]).find(x=>x.id===Number(id))||{};S.workflowMapping=m;
    modal('平台 SKU 映射',`<form id="modal-form" data-form="workflow-sku"><div class="form-grid">${field('來源系統／商店代碼','platform',m.platform,'text','required')}${field('平台精確 SKU','external_sku',m.external_sku,'text','required')}${selectField('ERP 商品','product_id',options(d.products,x=>x.sku+' · '+x.name,'id',m.product_id))}${selectField('交易單位','unit_id','<option value="">基本單位</option>'+d.product_units.filter(x=>!m.product_id||x.product_id===m.product_id).map(x=>`<option value="${x.id}" ${m.unit_id===x.id?'selected':''}>${E(d.products.find(p=>p.id===x.product_id)?.sku)} · ${E(x.name)}</option>`).join(''))}</div><p class="hint">同一來源系統的外部 SKU 與 ERP 品號／單位一對一，不依名稱猜測。</p></form>`,formFooter());
  }else if(a==='workflow-template-form'){
    const t=(d.order_import_templates||[]).find(x=>x.id===Number(id))||{};S.workflowTemplate=t;
    modal('訂單欄位映射範本',`<form id="modal-form" data-form="workflow-template"><div class="form-grid">${field('範本名稱','name',t.name,'text','required')}${field('來源系統／商店代碼（須與 SKU 映射一致）','namespace',t.namespace,'text','required')}${[['order_ref','外部單號'],['customer_code','客戶代號'],['warehouse_code','倉庫代號'],['sku','外部 SKU'],['qty','數量'],['price','交易單位單價'],['date','訂單日期（選填）'],['due_date','交期（選填）'],['tax_mode','稅別（選填）'],['notes','備註（選填）']].map(([k,n],i)=>field(n+' 的 CSV 欄名','map_'+k,t.columns?.[k]??(i<6?k:''),'text',i<6?'required':'')).join('')}</div></form>`,formFooter(),true);
  }else if(a==='workflow-import-form'){
    modal('匯入訂單 CSV',`<form id="modal-form" data-form="workflow-import-preview"><div class="form-grid">${selectField('欄位映射範本','template_id',options(d.order_import_templates||[],'name','id',''))}<div class="field"><label for="workflow-import-file">UTF-8 CSV</label><input id="workflow-import-file" type="file" accept=".csv,text/csv" required></div></div><p class="hint">同一外部單號多列會合成一張草稿。先建立精確 SKU 映射，缺漏或重複會保留在例外佇列，修正後重新預覽。</p></form>`,formFooter('預覽與檢查'));
  }else if(a==='workflow-import-commit'){
    const r=await api('/api/order-imports/'+id+'/commit',{});closeModal();await refresh();toast('已建立 '+r.count+' 張訂單草稿');
  }else if(a==='workflow-report-form'){
    const r=(d.report_designs||[]).find(x=>x.id===Number(id))||{dataset:'documents',columns:[],view_roles:['admin'],print_roles:['admin'],paper:'a4',orientation:'portrait'};S.workflowReport=r;
    modal('自訂報表與權限',`<form id="modal-form" data-form="workflow-report"><div class="form-grid">${field('報表名稱','name',r.name,'text','required')}${selectField('資料集','dataset',Object.entries(d.report_catalog).map(([k,v])=>`<option value="${k}" ${r.dataset===k?'selected':''}>${E(v.name)}</option>`).join(''))}${selectField('紙張','paper','<option value="a4">A4</option><option value="a5" '+(r.paper==='a5'?'selected':'')+'>A5</option>')}${selectField('方向','orientation','<option value="portrait">直式</option><option value="landscape" '+(r.orientation==='landscape'?'selected':'')+'>橫式</option>')}</div><div class="section-title">欄位與順序（每行：欄位代碼=顯示標題）</div>${textarea('欄位設定','columns_text',r.columns.length?r.columns.map(c=>c.key+'='+c.label).join('\n'):'no=單號\npartner_name=往來\ndate=日期\ntotal=合計')}<p class="hint" id="workflow-report-catalog">${E(Object.entries(d.report_catalog[r.dataset].fields).map(([k,n])=>k+'：'+n).join('；'))}</p>${table(['角色','檢視','列印'],Object.entries(roleNames).map(([k,n])=>`<tr><td>${E(n)}</td><td><input type="checkbox" name="report_view" value="${k}" ${r.view_roles.includes(k)?'checked':''} aria-label="${E(n)}可檢視"></td><td><input type="checkbox" name="report_print" value="${k}" ${r.print_roles.includes(k)?'checked':''} aria-label="${E(n)}可列印"></td></tr>`))}</form>`,formFooter(),true);
  }else if(a==='workflow-report-run'){
    S.workflowReport=(d.report_designs||[]).find(r=>r.id===Number(id));
    modal('查詢 '+S.workflowReport.name,`<form id="modal-form" data-form="workflow-report-run"><div class="form-grid">${['documents','fulfilments'].includes(S.workflowReport.dataset)?field('起日（選填）','from','','date')+field('迄日（選填）','to','','date'):''}${field('類型代碼（選填）','kind','')}${field('狀態代碼（選填）','status','')}</div></form>`,formFooter('查詢報表'));
  }else return financeWorkflowAction(a,id);
  return true;
}

async function extraWorkflowSubmit(kind,b){
  let result;
  if(kind==='workflow-meta'){result=await api('/api/documents/'+S.workflowDoc.id+'/metadata',{...b,version:S.workflowDoc.version});}
  else if(kind==='workflow-plan-choose'){
    const doc=await api('/api/documents/'+b.document_id),count=Number(b.count),interval=Number(b.interval);S.workflowScheduleDoc=doc;
    const periods=Array.from({length:count},(_,i)=>({date:datePlus(b.start,i*interval),lines:doc.lines.map(l=>{const remaining=l.qty-l.done_qty-l.closed_qty,q=Math.floor(remaining/count)+(i===count-1?remaining%count:0);return {...l,quantity:q/1000};})}));
    modal('核對分期數量 · '+doc.no,`<form id="modal-form" data-form="workflow-plan-create">${periods.map((p,i)=>`<div class="section-title">第 ${i+1} 期</div><input type="date" data-period-date="${i}" value="${E(p.date)}" required aria-label="第 ${i+1} 期日期">${table(['商品／交易單位','數量'],p.lines.map(l=>`<tr><td>${E(l.sku)} · ${E(l.unit)}</td><td><input type="number" data-schedule-period="${i}" data-schedule-line="${l.id}" value="${l.quantity}" min="0" step="0.001" required aria-label="第 ${i+1} 期 ${E(l.sku)}數量"></td></tr>`))}`).join('')}<p class="hint">可修改各期日期與數量；所有期待交合計不得超過來源未交量。</p></form>`,formFooter('建立排程'),true);return true;
  }else if(kind==='workflow-plan-create'){
    const doc=S.workflowScheduleDoc,periods=$$('[data-period-date]').map(el=>({due_date:el.value,lines:$$('[data-schedule-period]').filter(x=>x.dataset.schedulePeriod===el.dataset.periodDate).map(x=>({line_id:Number(x.dataset.scheduleLine),qty:x.value})).filter(x=>Number(x.qty)>0)}));result=await api('/api/subscriptions',{document_id:doc.id,version:doc.version,periods});
  }else if(kind==='workflow-schedule-action'){
    const {a,plan,period}=S.workflowScheduleAction;
    if(a==='workflow-plan-status'||a==='workflow-plan-close')result=await api('/api/subscriptions/'+plan.id+'/status',{...b,version:plan.version,status:a==='workflow-plan-close'?'closed':plan.status==='paused'?'active':'paused'});
    else if(a==='workflow-period-execute')result=await api('/api/subscription-periods/'+period.id+'/execute',{version:period.version});
    else result=await api('/api/subscription-periods/'+period.id+'/change',{...b,version:period.version,action:a==='workflow-period-skip'?'skip':'adjust',lines:$$('[data-period-adjust]').map(el=>({line_id:Number(el.dataset.periodAdjust),qty:el.value})).filter(l=>Number(l.qty)>0)});
  }else if(kind==='workflow-sku'){result=await api('/api/sku-mappings',{...b,id:S.workflowMapping.id,version:S.workflowMapping.version});}
  else if(kind==='workflow-template'){
    const columns={};for(const [key,value]of Object.entries(b))if(key.startsWith('map_')&&value)columns[key.slice(4)]=value;
    result=await api('/api/order-import-templates',{name:b.name,namespace:b.namespace,columns,id:S.workflowTemplate.id,version:S.workflowTemplate.version});
  }else if(kind==='workflow-import-preview'){
    const file=$('#workflow-import-file').files[0];if(!file||file.size>1024*1024)throw Error('請選擇 1 MB 以下的 UTF-8 CSV');
    const r=await api('/api/order-imports/preview',{...b,rows:parseCSV(await file.text())});
    modal('訂單匯入預覽',`<p>可辨識 ${r.count} 張訂單；${r.errors.length} 筆錯誤。</p>${r.errors.length?table(['CSV 列','錯誤'],r.errors.map(e=>`<tr><td>${e.row}</td><td>${E(e.message)}</td></tr>`)):table(['外部單號','明細數','合計 TWD'],r.orders.map(o=>`<tr><td>${E(o.reference)}</td><td>${o.lines}</td><td>${money(o.total,true)}</td></tr>`))}<p class="hint">錯誤批次不會建立訂單。SKU 映射或來源資料修正後，請重新預覽。</p>`,btn('關閉','close')+(!r.errors.length?btn('確認整批建立草稿','workflow-import-commit',r.id,'primary'):''),true);return true;
  }else if(kind==='workflow-report'){
    const columns=b.columns_text.split(/\r?\n/).filter(x=>x.trim()).map(line=>{const at=line.indexOf('=');if(at<1)throw Error('每行請填「欄位代碼=顯示標題」');return {key:line.slice(0,at).trim(),label:line.slice(at+1).trim()};});
    result=await api('/api/custom-reports',{...b,id:S.workflowReport.id,version:S.workflowReport.version,columns,view_roles:$$('[name="report_view"]:checked').map(x=>x.value),print_roles:$$('[name="report_print"]:checked').map(x=>x.value)});
  }else if(kind==='workflow-report-run'){
    const query=new URLSearchParams(Object.fromEntries(Object.entries(b).filter(([,v])=>v))),r=await api('/api/custom-reports/'+S.workflowReport.id+'?'+query);
    modal(r.design.name,`<p class="hint">${E(r.note)}</p>${table(r.design.columns.map(c=>E(c.label)),r.rows.map(row=>`<tr>${r.design.columns.map(c=>`<td>${E(row[c.key]===null?'—':['net','tax','total','cost','value'].includes(c.key)?money(row[c.key],true):['qty','reserved','available'].includes(c.key)?Q(row[c.key]):row[c.key])}</td>`).join('')}</tr>`))}`,btn('關閉','close')+(r.design.print_roles.includes(S.data.user.role)&&r.design.allowed?.print?`<a class="btn primary" href="/print/custom-reports/${r.design.id}?${E(query)}" target="_blank" rel="noopener">列印</a>`:''),true);return true;
  }else return financeWorkflowSubmit(kind,b);
  closeModal();await refresh();toast('資料已儲存'+(result.no?' · '+result.no:''));return true;
}
document.addEventListener('change',ev=>{
  if(ev.target.id==='f-dataset'&&S.workflowReport&&$('#workflow-report-catalog'))$('#workflow-report-catalog').textContent=Object.entries(S.data.report_catalog[ev.target.value].fields).map(([k,v])=>k+'：'+v).join('；');
  if(ev.target.id==='f-product_id'&&ev.target.closest('[data-form="workflow-sku"]'))$('#f-unit_id').innerHTML='<option value="">基本單位</option>'+S.data.product_units.filter(x=>x.product_id===Number(ev.target.value)).map(x=>`<option value="${x.id}">${E(x.name)}</option>`).join('');
});
