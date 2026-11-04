import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream';
import { allowedHostnames,backendURL,hostname,validateSecret,appVersion } from './deployment.mjs';

const requestHeaders=['accept','content-type','content-length','cookie','origin','user-agent','x-erp-request','x-csrf-token','idempotency-key','x-erp-company'];
const hopHeaders=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','server','x-powered-by','x-erp-proxy-token','x-erp-public-host','x-erp-public-proto']);
const security={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"};
function problem(req,res,status,code,message){
  if(res.headersSent){res.destroy();return;}
  const json=String(req.url).startsWith('/api/')||String(req.headers.accept||'').includes('application/json');
  res.writeHead(status,{...security,'Content-Type':json?'application/json; charset=utf-8':'text/html; charset=utf-8'});
  if(json)return res.end(JSON.stringify({error:message,code,version:appVersion}));
  res.end(`<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ERP 雲端部署設定</title><style>body{font:18px/1.8 system-ui;background:#f5f7fa;color:#243244;margin:8vh auto;padding:24px;max-width:760px}main{background:white;padding:32px;border-radius:16px}code{background:#eef1f5;padding:3px 6px}h1{font-size:28px}</style><main><h1>ERP 雲端部署設定</h1><p>${message}</p><ol><li>以專案提供的容器設定啟動後端，並掛載持久磁碟。</li><li>在網站環境設定 <code>ERP_BACKEND_URL</code>，填入後端 HTTPS 網址。</li><li>前後端設定相同的 <code>ERP_PROXY_SECRET</code>，並將前台網域加入後端的 <code>ERP_ALLOWED_HOSTS</code>。</li><li>重新部署目前的功能分支；詳細步驟見儲存庫的 <code>docs/雲端部署.md</code>。</li></ol><p>目前版本 ${appVersion}。正式帳套需要持久儲存；函式暫存磁碟不適合保存帳務資料。</p></main></html>`);
}
export function createGateway(env=process.env,{allowLocalHTTP=false,timeout=25000}={}){
  let backend,secret,allowed,configured=false;
  try{backend=backendURL(env.ERP_BACKEND_URL,{allowLocalHTTP});secret=validateSecret(env.ERP_PROXY_SECRET,'ERP_PROXY_SECRET');allowed=allowedHostnames(env,{vercel:true});configured=true;}catch{}
  return async function gateway(req,res){
    if(!configured)return problem(req,res,503,'ERP_DEPLOYMENT_NOT_CONFIGURED','網站入口已啟動，尚未完成持久化後端連線設定。');
    let siteHost;
    try{siteHost=hostname(req.headers.host);if(!allowed.has(siteHost))throw Error();}catch{return problem(req,res,403,'ERP_HOST_NOT_ALLOWED','此主機名稱未獲允許。');}
    if(siteHost===backend.hostname)return problem(req,res,503,'ERP_BACKEND_LOOP','後端網址不能填入目前的前台網址，請使用獨立的持久化後端。');
    if(!['GET','POST'].includes(req.method))return problem(req,res,405,'ERP_METHOD_NOT_ALLOWED','方法不支援。');
    if(!/^\/(?!\/)/.test(req.url)||/[\r\n\\]/.test(req.url))return problem(req,res,400,'ERP_INVALID_PATH','請求路徑格式錯誤。');
    if(req.method==='POST'&&req.headers.origin){
      try{const origin=new URL(req.headers.origin);if(origin.host!==req.headers.host||origin.protocol!=='https:')throw Error();}catch{return problem(req,res,403,'ERP_ORIGIN_NOT_ALLOWED','不允許跨來源操作。');}
    }
    if(Number(req.headers['content-length'])>2*1024*1024)return problem(req,res,413,'ERP_BODY_TOO_LARGE','請求內容不得超過 2MB。');
    const headers=Object.fromEntries(requestHeaders.filter(key=>req.headers[key]!==undefined).map(key=>[key,req.headers[key]]));
    // The platform's Node helpers may already have consumed and parsed JSON.
    // Re-encode that body rather than piping an exhausted IncomingMessage.
    let parsedBody;
    if(Object.hasOwn(req,'body')){
      try{const body=req.body;parsedBody=Buffer.isBuffer(body)?body:Buffer.from(body===undefined?'':typeof body==='string'?body:JSON.stringify(body));}catch{return problem(req,res,400,'ERP_INVALID_JSON','JSON 格式錯誤。');}
      if(parsedBody.length>2*1024*1024)return problem(req,res,413,'ERP_BODY_TOO_LARGE','請求內容不得超過 2MB。');
      headers['content-length']=String(parsedBody.length);
    }
    Object.assign(headers,{'host':backend.host,'x-erp-proxy-token':secret,'x-erp-public-host':req.headers.host,'x-erp-public-proto':'https'});
    return new Promise(resolve=>{
      res.once('finish',resolve);res.once('close',resolve);
      const upstream=(backend.protocol==='https:'?https:http).request(backend,{method:req.method,path:req.url,headers});
      let completed=false;
      const fail=()=>{if(completed)return;completed=true;upstream.destroy();problem(req,res,502,'ERP_BACKEND_UNAVAILABLE','後端暫時無法連線，請檢查後端服務與代理設定。');};
      const timer=setTimeout(fail,timeout);timer.unref();
      upstream.on('error',fail);
      upstream.on('response',response=>{
        const blocked=new Set([...hopHeaders,...String(response.headers.connection||'').split(',').map(v=>v.trim().toLowerCase())]);
        const responseHeaders=Object.fromEntries(Object.entries(response.headers).filter(([key])=>!blocked.has(key)));
        responseHeaders['cache-control']='no-store';res.writeHead(response.statusCode,responseHeaders);
        pipeline(response,res,()=>{completed=true;clearTimeout(timer);upstream.destroy();});
      });
      req.on('aborted',()=>{completed=true;clearTimeout(timer);upstream.destroy();});
      req.on('error',fail);
      res.on('close',()=>{completed=true;clearTimeout(timer);upstream.destroy();});
      let size=0;
      req.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024&&!completed){completed=true;clearTimeout(timer);upstream.destroy();problem(req,res,413,'ERP_BODY_TOO_LARGE','請求內容不得超過 2MB。');}});
      if(parsedBody!==undefined)upstream.end(parsedBody);else req.pipe(upstream);
    });
  };
}
