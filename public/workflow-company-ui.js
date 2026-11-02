function companyLoginSelector(){return `<div class="field" style="margin-bottom:20px"><label for="login-company">公司／分店帳套</label><select id="login-company" data-company-select="1">${(S.companies||[]).map(c=>`<option value="${E(c.slug)}" ${(S.company||'default')===c.slug?'selected':''}>${E(c.name)}</option>`).join('')}</select></div>`;}
async function workflowSwitchCompany(slug){
  if(!(S.companies||[]).some(c=>c.slug===slug))throw Error('公司帳套不存在');
  S.company=slug;sessionStorage.setItem('cheng-company',slug);S.data=null;S.csrf='';S.page='dashboard';S.tab='';S.opsReport=null;S.rebuildPlan=null;S.posCart=[];S.posStoreId=null;S.posMemberId=null;S.workflowPosQuote=null;closeModal();await init();
}
function companyWorkflowTabs(){return [['companies','公司／分店帳套']];}
function companyWorkflowContent(tab){
  if(tab!=='companies')return null;const d=S.data;
  return {actions:btn('切換帳套','workflow-company-switch')+(d.company_info?.root&&d.user.role==='admin'?btn('建立獨立公司','workflow-company-create-form','','primary','plus'):'')+(!d.company_info?.root&&d.user.role==='admin'?btn('授權／撤銷彙總','workflow-company-grant-form'):'')+(d.company_info?.root&&d.permissions.finance?btn('查閱已授權彙總','workflow-company-summary'):''),body:`<div class="info-card"><p>目前帳套：${E(d.settings.company)}。各公司有獨立資料庫、帳號、登入 Cookie、倉庫與帳務；切換時須有該公司自己的登入工作階段。</p><p>跨公司查閱須由各公司管理員另行授權主要帳套使用者；建立公司不會自動取得其他公司的明細或彙總權限。</p></div>`+table(['帳套名稱','代碼',''],(d.company_catalog||[]).map(c=>`<tr><td>${E(c.name)}</td><td>${E(c.slug)}</td><td>${c.slug===S.company?'目前帳套':btn('切換','workflow-company-go',c.slug,'small')}</td></tr>`))+(d.user.role==='admin'&&!d.company_info?.root?panel('本公司已授權的主要帳套使用者',table(['主要帳套帳號','可見成本'],(d.company_summary_grants||[]).map(g=>`<tr><td>${E(g.root_username)}</td><td>${g.include_cost?'包含成本與存貨金額':'不含成本'}</td></tr>`))):'')};
}
async function companyWorkflowAction(a,id){
  const d=S.data;
  if(a==='workflow-company-switch')wfFinanceForm('切換公司／分店帳套','workflow-company-switch',selectField('目標帳套','slug',options(d.company_catalog||S.companies||[],'name','slug',S.company)),false,'切換並確認登入');
  else if(a==='workflow-company-go')await workflowSwitchCompany(id);
  else if(a==='workflow-company-create-form')wfFinanceForm('建立獨立公司／分店','workflow-company-create',`<div class="form-grid">${field('公司／分店名稱','name','','text','required maxlength="100"')}${field('帳套代碼（小寫英數連字號）','slug','','text','required pattern="[a-z][a-z0-9-]{0,31}" maxlength="32"')}${field('此公司管理員帳號','username','','text','required autocomplete="off"')}${field('此公司管理員姓名','admin_name','','text','required')}${field('此公司管理員密碼（至少 12 字）','password','','password','required minlength="12" maxlength="128" autocomplete="new-password"')}${field('預設倉庫代碼','warehouse_code','WH01','text','required')}${field('預設倉庫名稱','warehouse_name','主倉庫','text','required')}</div><p class="hint">會建立空白且獨立的帳套，原帳套的使用者、商品、庫存、公司資料及密碼不會自動複製。</p>`);
  else if(a==='workflow-company-grant-form')wfFinanceForm('本公司管理彙總授權','workflow-company-grant',`<div class="form-grid">${field('主要帳套的使用者帳號','root_username','','text','required')}${selectField('授權狀態','enabled','<option value="1">授予／更新</option><option value="0">撤銷</option>')}${selectField('彙總範圍','include_cost','<option value="0">營收、應收應付；不含成本</option><option value="1">另包含銷貨成本與存貨金額</option>')}</div><p class="hint">只開放彙總讀取，不提供本公司明細、登入權或修改權。</p>`);
  else if(a==='workflow-company-summary'){
    const r=await api('/api/company-summary');modal('已授權公司管理彙總',`<p>${E(r.note)}</p>${table(['帳套／幣別','累計未稅銷售','已立應收／應付','待立應收／應付','存貨金額／成本'],r.rows.map(c=>`<tr><td>${E(c.name)} · ${E(c.currency)}</td><td>${money(c.sales_net,true)}</td><td>${money(c.receivables,true)} / ${money(c.payables,true)}</td><td>${money(c.pending_receivables,true)} / ${money(c.pending_payables,true)}</td><td>${money(c.inventory_value,true)} / ${money(c.cost,true)}</td></tr>`))}`,btn('關閉','close'),true);
  }else return false;return true;
}
async function companyWorkflowSubmit(kind,b){
  if(kind==='workflow-company-switch'){await workflowSwitchCompany(b.slug);return true;}
  if(kind==='workflow-company-create'){const r=await api('/api/companies',b);closeModal();S.companies=await (await fetch('/api/companies')).json();await refresh();toast('已建立獨立帳套：'+r.name+'，切換後使用新帳套帳號登入');return true;}
  if(kind==='workflow-company-grant'){await api('/api/company-summary-grants',{...b,enabled:b.enabled==='1',include_cost:b.include_cost==='1'});closeModal();await refresh();toast('本公司彙總授權已更新');return true;}
  return false;
}
document.addEventListener('change',async ev=>{if(ev.target.dataset.companySelect==='1')try{await workflowSwitchCompany(ev.target.value);}catch(error){toast(error.message,true);}});
document.addEventListener('click',ev=>{
  const link=ev.target.closest('a[href^="/print/"]');if(link){const url=new URL(link.href);url.searchParams.set('company',S.company||'default');link.href=url.pathname+url.search;}
});
