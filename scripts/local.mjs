import { existsSync,mkdirSync,readFileSync,writeFileSync,readdirSync } from 'node:fs';
import { resolve,join,dirname,isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash,randomUUID } from 'node:crypto';
import { fork,spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { acquireLocalLock } from '../src/local-lock.mjs';

const execute=promisify(execFile),root=resolve(import.meta.dirname,'..');
export function localHome(env=process.env,platform=process.platform,userHome=homedir()){
  if(env.ERP_LOCAL_HOME){if(!isAbsolute(env.ERP_LOCAL_HOME))throw Error('ERP_LOCAL_HOME 必須為絕對路徑');return env.ERP_LOCAL_HOME;}
  const base=platform==='win32'?(env.LOCALAPPDATA||join(userHome,'AppData','Local')):platform==='darwin'?join(userHome,'Library','Application Support'):(env.XDG_DATA_HOME||join(userHome,'.local','share'));
  return join(base,'ERP-Local');
}
export function fingerprint(directory=root){
  const hash=createHash('sha256').update(process.version);
  function walk(folder){for(const entry of readdirSync(join(directory,folder),{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){const name=join(folder,entry.name);if(entry.isDirectory())walk(name);else if(entry.isFile())hash.update(name.replaceAll('\\','/')).update('\0').update(readFileSync(join(directory,name)));else throw Error('本機程式包不支援符號連結');}}
  for(const folder of ['src','public','vendor'])walk(folder);
  for(const file of ['package.json','scripts/local.mjs','scripts/pre-upgrade.mjs','scripts/backup-service.mjs','scripts/delivery-worker.mjs'])hash.update(file).update(readFileSync(join(directory,file)));
  return hash.digest('hex');
}
export function publicSite(value){if(!value)return '';const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('共用網址須為完整 HTTPS 網站原點，不可含帳密、路徑或參數');return u.origin;}
function argumentsFor(args){
  const options={demo:false,browser:true,backup:false,new:false};
  for(let i=0;i<args.length;i++){
    const arg=args[i];if(arg==='--demo')options.demo=true;else if(arg==='--no-browser')options.browser=false;else if(arg==='--backup')options.backup=true;else if(arg==='--new')options.new=true;
    else if(arg==='--local-only')options.site='';else if(['--data-dir','--port','--site'].includes(arg)){if(!args[i+1]||args[i+1].startsWith('--'))throw Error(arg+' 缺少參數');options[arg==='--data-dir'?'dataDir':arg==='--site'?'site':'port']=args[++i];}else throw Error('未知參數：'+arg);
  }
  const port=Number(options.port||(options.demo?4321:4320));if(!Number.isInteger(port)||port<1024||port>65535)throw Error('連接埠需介於 1024–65535');return {...options,port};
}
function openBrowser(url){
  const command=process.platform==='win32'?'cmd':process.platform==='darwin'?'open':'xdg-open',args=process.platform==='win32'?['/d','/c','start','',url]:[url];
  const child=spawn(command,args,{stdio:'ignore',detached:true,windowsHide:true});child.on('error',()=>console.log('請以瀏覽器開啟：'+url));child.unref();
}
async function available(port){
  const server=createServer();await new Promise((resolve,reject)=>{server.once('error',()=>reject(Error('連接埠 '+port+' 已被使用，請先關閉既有服務再啟動／更新。')));server.listen(port,'127.0.0.1',resolve);});await new Promise(resolve=>server.close(resolve));
}
function childEnvironment(){return Object.fromEntries(Object.entries(process.env).filter(([name])=>/^ERP_MAIL_(?:[A-Z0-9_]+_)?(?:HOST|PORT|TLS|USER|PASSWORD)$/.test(name.toUpperCase())||!name.toUpperCase().startsWith('ERP_')&&!['PORT','VERCEL','CODESPACES','RENDER','NODE_TEST_CONTEXT'].includes(name.toUpperCase())));}
export async function startLocal(args=process.argv.slice(2)){
  if(Number(process.versions.node.split('.')[0])!==24)throw Error('本機版需要 Node.js 24，請使用隨程式包提供的啟動檔。');
  const options=argumentsFor(args),home=localHome(),configFile=join(home,options.demo?'demo.json':'company.json'),version=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version,build=fingerprint();
  let previous=null;if(existsSync(configFile)){try{previous=JSON.parse(readFileSync(configFile,'utf8'));if(previous.format!==1||previous.initialized!==true||!isAbsolute(previous.dataDir)||!Number.isSafeInteger(previous.pid)||previous.pid<1||!Number.isInteger(previous.port)||previous.port<1024||previous.port>65535||typeof previous.build!=='string'||!/^[a-f0-9]{64}$/.test(previous.build)||typeof previous.instance!=='string'||!/^[a-f0-9-]{36}$/.test(previous.instance))throw Error();}catch{throw Error('本機設定檔無法讀取，請先保留資料並核對：'+configFile);}}
  const site=publicSite(options.site??previous?.publicSite??'');if(options.demo&&site)throw Error('本機示範模式不能設定共用網址');
  const filename=options.demo?'demo.sqlite':'company.sqlite',legacy=join(root,'data',filename);
  const dataDir=options.dataDir?resolve(options.dataDir):previous?.dataDir||(existsSync(legacy)?dirname(legacy):join(home,options.demo?'demo':'data')),database=join(dataDir,filename);
  if(options.new&&existsSync(database))throw Error('指定位置已有資料庫，不能建立空庫覆蓋。');
  if(previous?.initialized&&!existsSync(database)&&!options.new)throw Error('找不到原本的資料庫；不會建立空庫替代。請先還原備份或核對資料位置：'+database);
  if(site){if(!existsSync(database))throw Error('請先以本機模式建立公司及管理員，再設定共用網址');const check=new DatabaseSync(database,{readOnly:true});try{if(!check.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get()||!check.prepare('SELECT id FROM users WHERE active=1 LIMIT 1').get())throw Error('請先以本機模式建立公司及管理員，再設定共用網址');}finally{check.close();}}
  if(previous){
    let status;try{const response=await fetch('http://127.0.0.1:'+previous.port+'/healthz',{signal:AbortSignal.timeout(2000)});if(response.ok)status=await response.json();}catch{}
    if(status?.local_instance===previous.instance&&previous.dataDir===dataDir&&previous.build===build&&(previous.publicSite||'')===site&&!options.backup&&!options.new){const url=site||'http://127.0.0.1:'+previous.port;console.log('本機服務已在執行：'+url);if(options.browser)openBrowser(url);return {existing:true};}
    if(status?.local_instance===previous.instance)throw Error('先前的服務仍在執行，請先關閉舊版 ERP 視窗，再啟動新版或備份。');
  }
  await available(options.port);
  mkdirSync(dataDir,{recursive:true,mode:0o700});const release=acquireLocalLock(database);
  try{
  if(existsSync(database)){
    const db=new DatabaseSync(database,{readOnly:true});try{for(const name of ['settings','users'])if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))throw Error('資料庫格式不符，請保留原檔並核對備份，不能建立空庫替代。');}finally{db.close();}
  }
  if(existsSync(database)&&(options.backup||previous?.build!==build)){
    console.log('正在備份全部帳套，並在副本驗證更新…');
    const result=await execute(process.execPath,[join(root,'scripts/pre-upgrade.mjs'),'--db',database,'--all-companies'],{env:childEnvironment(),maxBuffer:4*1024*1024});
    const report=JSON.parse(result.stdout),databases=report.databases||[report],manifest=join(dataDir,'backups','local-backup-'+Date.now()+'-'+randomUUID().slice(0,8)+'.json');
    writeFileSync(manifest,JSON.stringify({created_at:new Date().toISOString(),root_database:database,application_version:version,databases},null,2),{mode:0o600});console.log('已備份並驗證 '+databases.length+' 個帳套；完整備份清單：'+manifest);
  }
  if(options.backup){if(!existsSync(database))throw Error('尚未建立本機資料庫，沒有可備份的資料。');return {backup:true};}
  mkdirSync(home,{recursive:true,mode:0o700});mkdirSync(dataDir,{recursive:true,mode:0o700});
  const instance=randomUUID(),env={...childEnvironment(),ERP_HOST:'127.0.0.1',ERP_ALLOWED_HOSTS:'localhost,127.0.0.1,[::1]'+(site?','+new URL(site).hostname:''),ERP_SECURE_COOKIE:site?'1':'0',ERP_DB:database,PORT:String(options.port),ERP_LOCAL_INSTANCE:instance};
  let startupFailure=false;
  release();
  const child=fork(join(root,'src/server.mjs'),options.demo?['--demo']:[],{env,stdio:['inherit','inherit','inherit','ipc']});
  const stop=()=>{if(child.exitCode===null)child.kill();};for(const signal of ['SIGINT','SIGTERM'])process.once(signal,stop);
  child.on('message',message=>{
    if(message?.type!=='ready')return;
    const config={format:1,initialized:true,dataDir,version,build,pid:child.pid,port:options.port,instance,publicSite:site};
    try{writeFileSync(configFile,JSON.stringify(config,null,2),{mode:0o600});}catch(error){console.error('無法保存本機設定：'+error.message);startupFailure=true;stop();return;}
    const url=site||'http://127.0.0.1:'+options.port;console.log('本機資料會保留在：'+dataDir);if(site)console.log('公司共用網址：'+site+'（需由本機 HTTPS 反向代理提供）');console.log('關閉此視窗會停止服務，資料不會清除。');if(options.browser)openBrowser(url);if(process.send)process.send({type:'ready',port:options.port});
  });
  child.on('error',error=>{console.error('服務無法啟動：'+error.message);startupFailure=true;process.exitCode=1;});
  child.on('exit',code=>{for(const signal of ['SIGINT','SIGTERM'])process.removeListener(signal,stop);process.exitCode=startupFailure?1:code||0;if(process.connected)process.disconnect();});
  return {child};
  }finally{release();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))startLocal().catch(error=>{console.error('本機 ERP：'+error.message);process.exitCode=1;});
