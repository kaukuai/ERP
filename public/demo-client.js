(() => {
  const nativeFetch=window.fetch.bind(window),storageKey='erp-web-demo-v1';let queue=Promise.resolve();
  const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  window.erpCompanyPath=path=>{const url=new URL(path,location.origin);url.searchParams.set('company',sessionStorage.getItem('cheng-company')||'default');return url.pathname+url.search;};
  window.erpImageAttrs=path=>(window.ERP_DEMO_MODE?'data-demo-image':'src')+'="'+escape(window.erpCompanyPath(path))+'"';
  window.resetWebDemo=()=>{sessionStorage.removeItem(storageKey);sessionStorage.removeItem('cheng-company');location.assign('/');};
  window.fetch=(input,options={})=>{
    const url=new URL(input instanceof Request?input.url:String(input),location.href);
    if(!window.ERP_DEMO_MODE||url.origin!==location.origin||!/^\/(api|print)\//.test(url.pathname)||url.pathname==='/api/demo-action')return nativeFetch(input,options);
    const run=async()=>{
      const headers=new Headers(input instanceof Request?input.headers:undefined);for(const [key,value]of new Headers(options.headers))headers.set(key,value);
      const method=options.method||(input instanceof Request?input.method:'GET'),body=options.body??(input instanceof Request&&method==='POST'?await input.clone().text():undefined);
      const response=await nativeFetch('/api/demo-action',{method:'POST',headers:{'Content-Type':'application/json','X-ERP-Demo':'1'},credentials:'same-origin',body:JSON.stringify({path:url.pathname+url.search,method,body,headers:Object.fromEntries(headers),state:sessionStorage.getItem(storageKey)||undefined})});
      const packet=await response.json();if(!response.ok)return new Response(JSON.stringify(packet),{status:response.status,headers:{'Content-Type':'application/json'}});
      sessionStorage.setItem(storageKey,packet.state);
      if(method==='POST'&&url.pathname==='/api/product-images'&&packet.status<300){for(const pending of images.values())pending.then(url=>setTimeout(()=>URL.revokeObjectURL(url),10000)).catch(()=>{});images.clear();}
      const bytes=Uint8Array.from(atob(packet.body),char=>char.charCodeAt(0));return new Response(bytes,{status:packet.status,headers:packet.headers});
    };
    const next=queue.then(run);queue=next.catch(()=>{});return next;
  };
  window.demoDownload=async(path,name)=>{
    const response=await fetch(path,{headers:{'X-ERP-Company':sessionStorage.getItem('cheng-company')||'default'}});
    if(!response.ok)throw Error((await response.json()).error||'下載失敗');
    const url=URL.createObjectURL(await response.blob()),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
  };
  document.addEventListener('click',event=>{
    if(!window.ERP_DEMO_MODE)return;
    if(event.target.closest('[data-action="demo-reset"]')){event.preventDefault();event.stopImmediatePropagation();window.resetWebDemo();return;}
    const a=event.target.closest('a[href]');if(!a)return;const url=new URL(a.href,location.href);
    if(url.origin!==location.origin||!url.pathname.startsWith('/print/'))return;
    event.preventDefault();event.stopImmediatePropagation();
    // Copy this tab's demo state into the print tab before removing its opener.
    const page=window.open(url.href,'_blank');if(page)page.opener=null;
  },true);
  const images=new Map();
  const loadImages=()=>{
    if(!window.ERP_DEMO_MODE)return;
    for(const img of document.querySelectorAll('img[data-demo-image]:not([data-demo-loading])')){
      img.dataset.demoLoading='1';const path=img.dataset.demoImage,company=sessionStorage.getItem('cheng-company')||'default',key=company+':'+path;
      if(!images.has(key))images.set(key,fetch(path,{headers:{'X-ERP-Company':company}}).then(async response=>{if(!response.ok)throw Error();return URL.createObjectURL(await response.blob());}));
      images.get(key).then(url=>img.src=url).catch(()=>{img.alt='圖片無法載入';});
    }
  };
  new MutationObserver(loadImages).observe(document.documentElement,{childList:true,subtree:true});
})();
