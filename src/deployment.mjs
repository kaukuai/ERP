import { createHash,timingSafeEqual } from 'node:crypto';

export const appVersion='0.8.0';
export const proxyHeaders=['x-erp-proxy-token','x-erp-public-host','x-erp-public-proto'];
export function secretMatches(actual,expected){
  if(typeof actual!=='string'||typeof expected!=='string'||!expected)return false;
  return timingSafeEqual(createHash('sha256').update(actual).digest(),createHash('sha256').update(expected).digest());
}
export function hostname(value){
  if(typeof value!=='string'||!value||/[\s,/@\\?#]/.test(value))throw Error('主機名稱格式錯誤');
  const url=new URL('http://'+value);
  if(url.pathname!=='/'||url.username||url.password)throw Error('主機名稱格式錯誤');
  return url.hostname.toLowerCase();
}
export function allowedHostnames(env=process.env,{vercel=false}={}){
  const names=['localhost','127.0.0.1','[::1]',...String(env.ERP_ALLOWED_HOSTS||'').split(',').map(s=>s.trim()).filter(Boolean)];
  if(env.RENDER==='true'&&env.RENDER_EXTERNAL_HOSTNAME)names.push(env.RENDER_EXTERNAL_HOSTNAME);
  if(vercel)names.push(...['VERCEL_URL','VERCEL_BRANCH_URL','VERCEL_PROJECT_PRODUCTION_URL'].map(k=>env[k]).filter(Boolean));
  return new Set(names.map(hostname));
}
export function requestSite(req,allowed,proxySecret){
  let host=req.headers.host,protocol=req.socket?.encrypted?'https':'http',proxied=false;
  if(proxyHeaders.some(name=>req.headers[name]!==undefined)){
    if(!secretMatches(req.headers['x-erp-proxy-token'],proxySecret))throw Error('代理驗證失敗');
    host=req.headers['x-erp-public-host'];protocol=req.headers['x-erp-public-proto'];proxied=true;
    if(protocol!=='https')throw Error('代理必須使用 HTTPS');
  }
  if(!allowed.has(hostname(host)))throw Error('此主機名稱未獲允許');
  return {host,protocol,proxied};
}
export function backendURL(value,{allowLocalHTTP=false}={}){
  const url=new URL(value);
  if(url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('ERP_BACKEND_URL 只能填入後端 HTTPS 網站原點');
  if(url.protocol!=='https:'&&!(allowLocalHTTP&&url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw Error('ERP_BACKEND_URL 必須使用 HTTPS');
  return url;
}
export function validateSecret(value,name){
  if(typeof value!=='string'||value.length<32||value.length>256||/[^\x21-\x7e]/.test(value))throw Error(name+' 需為 32–256 字元的獨立隨機密鑰');
  return value;
}
