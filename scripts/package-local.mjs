import { existsSync,mkdirSync,copyFileSync,writeFileSync,readdirSync,chmodSync,rmSync,readFileSync } from 'node:fs';
import { join,resolve,dirname,relative,isAbsolute,sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root=resolve(import.meta.dirname,'..');
export function packageLocal(output=join(root,'artifacts/local/ERP-local')){
  if(Number(process.versions.node.split('.')[0])!==24)throw Error('請使用 Node.js 24 建立本機包');
  output=resolve(output);const fromOutput=relative(output,root);if(!fromOutput||!fromOutput.startsWith('..')&&!isAbsolute(fromOutput))throw Error('輸出位置不可覆蓋原始碼');
  if(['src','public','vendor'].includes(relative(root,output).split(sep)[0]))throw Error('輸出位置不可放在要打包的程式目錄內');
  if(existsSync(output)&&!existsSync(join(output,'local-package.json')))throw Error('輸出資料夾不是既有程式包，拒絕清除：'+output);
  function inspect(folder){for(const entry of readdirSync(folder,{withFileTypes:true})){if(entry.isSymbolicLink()||/^(data|backups|\.company-workspaces)$/i.test(entry.name)||/\.(sqlite|db)(\.|$)/i.test(entry.name))throw Error('輸出資料夾含資料或連結，拒絕清除');if(entry.isDirectory())inspect(join(folder,entry.name));}}
  if(existsSync(output))inspect(output);
  rmSync(output,{recursive:true,force:true});mkdirSync(join(output,'app'),{recursive:true});
  function copyTree(folder){
    for(const entry of readdirSync(join(root,folder),{withFileTypes:true})){
      const name=join(folder,entry.name);if(/(^|[\\/])(data|backups|node_modules|\.git|\.vercel)([\\/]|$)|(^|[\\/])\.env|\.(sqlite|db|log|pem|key)(\.|$)/i.test(name))throw Error('程式來源含不應打包的資料：'+name);
      if(entry.isDirectory())copyTree(name);else if(entry.isFile()){const destination=join(output,'app',name);mkdirSync(dirname(destination),{recursive:true});copyFileSync(join(root,name),destination);}else throw Error('拒絕打包符號連結：'+name);
    }
  }
  for(const folder of ['src','public','vendor'])copyTree(folder);
  for(const file of ['scripts/local.mjs','scripts/delivery-worker.mjs','scripts/pre-upgrade.mjs','scripts/backup-service.mjs','THIRD-PARTY-NOTICES.md']){const destination=join(output,'app',file);mkdirSync(dirname(destination),{recursive:true});copyFileSync(join(root,file),destination);}
  const original=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  writeFileSync(join(output,'app/package.json'),JSON.stringify({name:'erp-local',version:original.version,private:true,type:'module',engines:{node:'24.x'},scripts:{start:'node scripts/local.mjs',backup:'node scripts/local.mjs --backup'}},null,2));
  mkdirSync(join(output,'runtime'));
  const executable=process.platform==='win32'?'node.exe':'node';copyFileSync(process.execPath,join(output,'runtime',executable));chmodSync(join(output,'runtime',executable),0o755);
  const license=[join(dirname(process.execPath),'LICENSE'),join(dirname(dirname(process.execPath)),'LICENSE')].find(existsSync);if(!license)throw Error('找不到 Node.js 授權檔，不能交付執行環境');copyFileSync(license,join(output,'runtime/LICENSE'));
  mkdirSync(join(output,'scripts'),{recursive:true});copyFileSync(join(root,'scripts/install-backup-task.ps1'),join(output,'scripts/install-backup-task.ps1'));
  for(const file of ['start.cmd','demo.cmd','backup.cmd','schedule-backup.cmd'])copyFileSync(join(root,file),join(output,file));
  for(const [file,args]of [['start-local.sh',''],['demo-local.sh','--demo'],['backup-local.sh','--backup']]){const text='#!/bin/sh\nset -eu\ncd "$(dirname "$0")"\nexec ./runtime/node ./app/scripts/local.mjs '+args+' "$@"\n';writeFileSync(join(output,file),text,{mode:0o755});}
  writeFileSync(join(output,'使用說明.txt'),'ERP 本機版\r\n\r\nWindows：解壓縮後雙擊 start.cmd，瀏覽器會自動開啟。\r\n不需要另外安裝 Node.js、Git 或資料庫。\r\n首次使用請自行建立管理員，沒有預設密碼。\r\n\r\n資料預設保存在 %LOCALAPPDATA%\\ERP-Local\\data，程式關閉後仍保留。\r\n新版解壓到另一個資料夾仍會沿用同一份本機設定；請先關閉舊版再啟動新版。\r\n若偵測到舊資料位置，會沿用原位置；實際位置以啟動畫面為準。\r\n更新前會備份全部帳套並驗證副本，失敗就不啟動新版。\r\n關閉服務後可雙擊 backup.cmd 手動備份，並將備份另存到其他磁碟。\r\n請保留完整資料資料夾、公司目錄及 backups，不要只保留單一 SQLite。\r\n\r\ndemo.cmd 使用另一份本機虛構示範資料，不會取代正式帳套。\r\n網頁展示與本機資料分開，不會自動同步正式資料到網站或 GitHub。\r\n');
  const metadata={format:1,version:original.version,platform:process.platform,arch:process.arch,node:process.version,created_at:new Date().toISOString(),contains_business_data:false};writeFileSync(join(output,'local-package.json'),JSON.stringify(metadata,null,2));
  const hashes=[];function digest(folder=''){for(const entry of readdirSync(join(output,folder),{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){const name=join(folder,entry.name);if(entry.isDirectory())digest(name);else hashes.push(createHash('sha256').update(readFileSync(join(output,name))).digest('hex')+'  '+name.replaceAll('\\','/'));}}digest();writeFileSync(join(output,'SHA256SUMS.txt'),hashes.join('\n')+'\n');return {output,...metadata};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{if(process.argv.length>3)throw Error('用法：node scripts/package-local.mjs [OUTPUT]');console.log(JSON.stringify(packageLocal(process.argv[2]),null,2));}catch(error){console.error(error.message);process.exitCode=1;}
}
