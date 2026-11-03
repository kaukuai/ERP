(async()=>{
  try{
    const query=new URLSearchParams(location.search),response=await fetch(location.pathname+location.search,{headers:{'X-ERP-Company':query.get('company')||sessionStorage.getItem('cheng-company')||'default'}});
    if(!response.ok)throw Error((await response.json()).error||'無法準備單據');
    const html=await response.text();document.open();document.write(html);document.close();
  }catch(error){const target=document.getElementById('demo-print-status');target.textContent=error.message;const link=document.createElement('a');link.href='/';link.textContent='回到展示頁面';target.appendChild(link);}
})();
