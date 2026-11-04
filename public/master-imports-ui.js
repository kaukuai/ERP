const masterImportLabels={sku:'品號',name:'名稱',spec:'規格',category:'分類',unit:'單位',barcode:'條碼',invoice_name:'發票品名',price:'售價',cost:'參考成本',safety_qty:'安全量',code:'對象代號',kind:'對象類型',contact:'聯絡人',phone:'電話',email:'電子郵件',tax_id:'統編',address:'地址',payment_days:'付款天數',credit_limit:'信用額度',notes:'備註',warehouse_code:'倉庫代號',qty:'期初數量',unit_cost:'期初單位成本'};
const masterImportKinds={products:'商品基本資料',partners:'客戶／供應商',opening_stock:'期初庫存'};
function masterImportPanel(){
  const templates=S.data.master_import_templates||[],preview=S.masterPreview?.company===S.company?S.masterPreview:null;
  return panel('Excel／CSV 欄位映射範本',`<div class="panel-body"><p>先設定來源欄名與固定值，再上傳純值 XLSX 或 UTF-8 CSV。僅新增資料，預覽通過後整批寫入；請先備份。</p>${table(['範本','類型／修訂','欄位映射',''],templates.map(t=>`<tr><td>${E(t.name)}</td><td>${E(masterImportKinds[t.kind])} · ${t.version}</td><td>${E(Object.entries(t.columns).map(([key,value])=>(masterImportLabels[key]||key)+' ← '+value).join('、'))}</td><td>${btn('編輯','master-template-edit',t.id,'small')}</td></tr>`))}${templates.length?`<form id="master-import-form" data-form="master-import-preview"><div class="form-grid">${selectField('匯入範本','template_id',options(templates,t=>t.name+' · '+masterImportKinds[t.kind],'id','','請選擇範本'))}<div class="field"><label for="master-import-file">檔案（最多 2,000 列）</label><input id="master-import-file" type="file" accept=".xlsx,.csv" required></div></div><p class="hint">XLSX 上限 1 MB，只讀 sheet1 純值，不執行公式或巨集；CSV 上限 1.5 MB。代號、條碼及統編請在來源檔設為文字，以保留前導零。</p><button type="submit" class="btn primary">預覽映射與檢核</button><p class="form-error" id="master-import-error" role="alert"></p></form>`:'<p class="hint">請先建立一個匯入範本。</p>'}<div id="master-import-result">${preview?masterImportResult(preview):''}</div></div>`,btn('新增映射範本','master-template-edit','','primary','plus'));
}
function masterImportResult(r){
  const keys=Object.keys(r.rows[0]||{});
  return `<div class="section-title">${E(r.template_name)} · 修訂 ${r.template_version} · ${r.count} 筆</div><p class="hint">來源 SHA-256：${E(r.source_hash)}</p>${r.errors.length?`<div class="alert error">${r.errors.slice(0,30).map(e=>'第 '+e.row+' 列：'+E(e.message)).join('<br>')}</div>`:`<div class="alert">檢核通過，尚未寫入主檔。以下顯示前 30 筆映射結果。</div>${btn('確認整批匯入','master-import-commit',r.id,'primary','check')}`}${table(keys.map(k=>E(masterImportLabels[k]||k)),r.rows.map(row=>`<tr>${keys.map(k=>`<td>${E(row[k])}</td>`).join('')}</tr>`))}`;
}
function masterTemplateForm(id,kind,draft){
  const saved=(S.data.master_import_templates||[]).find(t=>t.id===Number(id)),t=draft||saved||{};
  kind=kind||t.kind||'products';S.masterTemplate=saved||null;
  const required={products:['sku','name'],partners:['code','name'],opening_stock:['sku','warehouse_code','qty']};
  const columns=t.columns||Object.fromEntries(required[kind].map(key=>[key,key])),defaults=t.defaults||{};
  modal(saved?'編輯映射範本':'新增映射範本',`<form id="modal-form" data-form="master-template"><div class="form-grid">${field('範本名稱','name',t.name||'','text','required maxlength="100"')}${selectField('匯入類型','template_kind',Object.entries(masterImportKinds).map(([value,label])=>`<option value="${value}" ${value===kind?'selected':''}>${E(label)}</option>`).join(''))}</div><p class="hint">來源欄名必須與檔案表頭完全相同；也可以只填固定值。同一欄不可兩者都填。金額最多二位、數量三位小數，期初庫存只接受尚無流水的品項／倉庫。</p>${table(['目標欄位','來源檔欄名','或固定值'],S.data.master_import_fields[kind].map(key=>`<tr><td>${E(masterImportLabels[key])}${required[kind].includes(key)?' *':''}<span class="mini-name mono">${E(key)}</span></td><td><input name="source_${key}" value="${E(columns[key]||'')}" maxlength="100" aria-label="${E(masterImportLabels[key])}來源欄名"></td><td><input name="fixed_${key}" value="${E(defaults[key]||'')}" maxlength="2000" aria-label="${E(masterImportLabels[key])}固定值"></td></tr>`))}</form>`,formFooter('儲存映射範本'),true);
  $('#modal-root #f-template_kind').disabled=!!saved;
  $('#modal-root #f-template_kind').addEventListener('change',ev=>{const name=$('#modal-root #f-name').value;masterTemplateForm('',ev.target.value,{name});});
}
async function masterImportAction(action,id){
  if(action==='master-template-edit'){masterTemplateForm(id);return;}
  if(action==='master-import-commit'){
    if(S.masterPreview?.company!==S.company||String(S.masterPreview.id)!==String(id))throw Error('請重新上傳預覽');
    const r=await api('/api/imports/'+id+'/commit',{});S.masterPreview=null;await refresh();toast('已整批匯入 '+r.count+' 筆');
  }
}
async function masterImportSubmit(kind,b){
  if(kind==='master-template'){
    const old=S.masterTemplate,selected=old?.kind||b.template_kind,columns={},defaults={};
    for(const key of S.data.master_import_fields[selected]){if(b['source_'+key]?.trim())columns[key]=b['source_'+key].trim();if(b['fixed_'+key]?.trim())defaults[key]=b['fixed_'+key].trim();}
    await api('/api/master-import-templates',{id:old?.id,version:old?.version,kind:selected,name:b.name,columns,defaults});closeModal();await refresh();toast('匯入映射範本已儲存');
  }else if(kind==='master-import-preview'){
    S.masterPreview=null;
    $('#master-import-result')?.replaceChildren();
    const file=$('#master-import-file').files[0];if(!file||!b.template_id)throw Error('請選擇範本及檔案');
    const format=file.name.toLowerCase().endsWith('.xlsx')?'xlsx':file.name.toLowerCase().endsWith('.csv')?'csv':'';
    if(!format||file.size>(format==='xlsx'?1048576:1500000))throw Error('僅支援 1 MB 以下 XLSX 或 1.5 MB 以下 CSV');
    const payload={template_id:b.template_id,format};
    if(format==='csv')payload.text=await file.text();
    else{const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let at=0;at<bytes.length;at+=8192)binary+=String.fromCharCode(...bytes.subarray(at,at+8192));payload.base64=btoa(binary);}
    const result=await api('/api/master-imports/preview',payload);S.masterPreview={...result,company:S.company};render();
  }
}
