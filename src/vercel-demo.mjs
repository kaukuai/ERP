import { Readable,Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { readFileSync,readdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createApplication } from './application.mjs';
import { allowedHostnames,hostname,appVersion } from './deployment.mjs';
import { demoCodec,snapshotDemo,restoreDemo,DemoStateError } from './demo-state.mjs';

const root=resolve(import.meta.dirname,'..'),publicFiles=new Set(readdirSync(join(root,'public')).filter(name=>/^[a-z0-9.-]+$/i.test(name)));
const security={'Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'same-origin'};
function json(res,data,status=200){const text=JSON.stringify(data);if(Buffer.byteLength(text)>4*1024*1024)throw new DemoStateError('展示資料或下載內容過大，請縮小範圍或重新開始展示');res.writeHead(status,{...security,'Content-Type':'application/json; charset=utf-8'});res.end(text);}
async function payload(req){
  let value;
  if(Object.hasOwn(req,'body')){value=req.body;if(Buffer.isBuffer(value))value=value.toString('utf8');if(typeof value==='string')value=JSON.parse(value);}
  else{const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>4*1024*1024)throw Error('展示請求過大');chunks.push(chunk);}value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  if(!value||typeof value!=='object'||Array.isArray(value)||Buffer.byteLength(JSON.stringify(value))>4*1024*1024)throw Error('展示請求格式錯誤');return value;
}
async function dispatch(app,packet,outer,cookies){
  const headers={host:outer.headers.host,cookie:Object.entries(cookies).map(([key,value])=>key+'='+value).join('; ')};
  for(const key of ['x-erp-company','x-erp-request','x-csrf-token','idempotency-key'])if(typeof packet.headers?.[key]==='string')headers[key]=packet.headers[key];
  if(packet.method==='POST'){headers['content-type']='application/json';if(outer.headers.origin)headers.origin=outer.headers.origin;}
  const req=Readable.from(packet.method==='POST'?[Buffer.from(packet.body||'{}')]:[]);req.url=packet.path;req.method=packet.method;req.headers=headers;req.socket=outer.socket;
  const chunks=[];let status=200,responseHeaders={},size=0;
  const res=new Writable({write(chunk,encoding,done){size+=chunk.length;if(size>3*1024*1024)return done(new DemoStateError('展示回應過大，請縮小資料範圍'));chunks.push(Buffer.from(chunk));done();}});
  res.writeHead=(code,next)=>{status=code;responseHeaders=next;return res;};
  const completed=finished(res);completed.catch(()=>{});
  await app.handler(req,res);await completed;
  for(const cookie of [responseHeaders['Set-Cookie']||[]].flat()){
    const [pair]=cookie.split(';'),at=pair.indexOf('='),name=pair.slice(0,at),value=pair.slice(at+1);if(value)cookies[name]=value;else delete cookies[name];
  }
  const exposed=Object.fromEntries(Object.entries(responseHeaders).filter(([key])=>['content-type','content-disposition'].includes(key.toLowerCase())));
  return {status,headers:exposed,body:Buffer.concat(chunks).toString('base64')};
}
export function createDemoHandler({key,env=process.env,clock}={}){
  const codec=demoCodec(key,{clock}),allowed=allowedHostnames(env,{vercel:true});let pristine;
  return async function demo(req,res){
    let directory,app;
    try{
      if(!allowed.has(hostname(req.headers.host)))return json(res,{error:'此主機名稱未獲允許'},403);
      const url=new URL(req.url,'http://localhost'),path=url.pathname;
      if(req.method==='GET'&&path==='/runtime.js'){res.writeHead(200,{...security,'Content-Type':'text/javascript; charset=utf-8'});return res.end('window.ERP_DEMO_MODE=true;');}
      if(req.method==='GET'&&(path==='/healthz'||path==='/api/status'))return json(res,{ok:true,version:appVersion,demo:true,ephemeral_demo:true,initialized:true});
      if(req.method==='GET'&&(path.startsWith('/print/')||publicFiles.has(path==='/'?'index.html':path.slice(1)))){
        const name=path.startsWith('/print/')?'demo-print.html':path==='/'?'index.html':path.slice(1),type=name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':'text/html';
        res.writeHead(200,{...security,'Content-Type':type+'; charset=utf-8'});return res.end(readFileSync(join(root,'public',name)));
      }
      if(path!=='/api/demo-action'||req.method!=='POST')return json(res,{error:'請從展示頁面操作'},404);
      if(req.headers['x-erp-demo']!=='1'||!String(req.headers['content-type']||'').startsWith('application/json'))return json(res,{error:'展示請求驗證失敗'},403);
      if(req.headers.origin){let origin;try{origin=new URL(req.headers.origin);}catch{}if(!origin||origin.host!==req.headers.host||!['http:','https:'].includes(origin.protocol))return json(res,{error:'不允許跨來源操作'},403);}
      let packet;try{packet=await payload(req);}catch{return json(res,{error:'展示請求格式錯誤或內容過大'},400);}
      if(!['GET','POST'].includes(packet.method)||typeof packet.path!=='string'||!/^\/(api|print)\//.test(packet.path)||packet.path.startsWith('/api/demo-action')||packet.path.length>3000||/[\\\r\n]/.test(packet.path)||packet.body!==undefined&&typeof packet.body!=='string')return json(res,{error:'展示操作格式錯誤'},400);
      const state=packet.state?codec.decode(packet.state):null,cookies=state?{...state.cookies}:{};
      directory=mkdtempSync(join(tmpdir(),'erp-web-demo-'));
      if(state)restoreDemo(directory,state);else if(pristine)writeFileSync(join(directory,'root.sqlite'),pristine,{mode:0o600});
      app=createApplication({dbPath:join(directory,'root.sqlite'),demo:true,port:4321,allowed,secureCookie:true,ephemeralDemo:true,proxySecret:'',setupKey:''});
      // Cache only the untouched fixture. Every request receives a private copy.
      if(!state&&!pristine){app.close();app=null;pristine=readFileSync(join(directory,'root.sqlite'));app=createApplication({dbPath:join(directory,'root.sqlite'),demo:true,port:4321,allowed,secureCookie:true,ephemeralDemo:true,proxySecret:'',setupKey:''});}
      const response=await dispatch(app,packet,req,cookies);app.close();app=null;
      const next=codec.encode(snapshotDemo(directory,cookies));return json(res,{...response,state:next});
    }catch(error){
      if(error instanceof DemoStateError)return json(res,{error:error.message,code:'DEMO_STATE_EXPIRED'},409);
      console.error('ERP demo failed:',error.stack);return json(res,{error:'展示操作無法完成，請重新開始展示'},500);
    }finally{app?.close();if(directory)rmSync(directory,{recursive:true,force:true});}
  };
}
