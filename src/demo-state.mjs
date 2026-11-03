import { createCipheriv,createDecipheriv,randomBytes } from 'node:crypto';
import { deflateRawSync,inflateRawSync } from 'node:zlib';
import { readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync } from 'node:fs';
import { join } from 'node:path';

const maxState=2*1024*1024,maxFiles=8,maxBytes=8*1024*1024;
const companyFile=/^company-[0-9a-f-]{36}\.sqlite$/;
export class DemoStateError extends Error {}
export function demoCodec(key,{clock=Date.now}={}){
  if(!Buffer.isBuffer(key)||key.length!==32)throw Error('展示版私鑰未正確建立');
  return {
    decode(token){
      try{
        if(typeof token!=='string'||token.length>maxState||!token.length||!/^[A-Za-z0-9_-]+$/.test(token))throw Error();
        const bytes=Buffer.from(token,'base64url');if(bytes.length<29)throw Error();
        const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAAD(Buffer.from('erp-web-demo-v1'));decipher.setAuthTag(bytes.subarray(12,28));
        const data=Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]);
        const state=JSON.parse(inflateRawSync(data,{maxOutputLength:12*1024*1024}).toString('utf8'));
        if(state.version!==1||!Number.isSafeInteger(state.expires)||state.expires<clock()||!state.cookies||typeof state.cookies!=='object'||Array.isArray(state.cookies))throw Error();
        return state;
      }catch{throw new DemoStateError('展示資料已失效，請按「重新開始展示」載入新的示範資料。');}
    },
    encode(state){
      const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('erp-web-demo-v1'));
      const bytes=deflateRawSync(Buffer.from(JSON.stringify({...state,version:1,expires:clock()+8*3600000}))),encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]);
      const token=Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');
      if(token.length>maxState)throw new DemoStateError('展示資料量已達上限，請重新開始展示。');return token;
    },
  };
}
export function snapshotDemo(directory,cookies){
  const files={'root.sqlite':readFileSync(join(directory,'root.sqlite')).toString('base64')},companies=join(directory,'.company-workspaces');
  if(existsSync(companies))for(const name of readdirSync(companies))if(companyFile.test(name))files[name]=readFileSync(join(companies,name)).toString('base64');
  validateFiles(files);return {files,cookies};
}
function validateFiles(files){
  if(!files||typeof files!=='object'||Array.isArray(files)||!Object.hasOwn(files,'root.sqlite')||Object.keys(files).length>maxFiles)throw new DemoStateError('展示帳套數量已達上限，請重新開始展示。');
  let size=0;const decoded=[];
  for(const [name,value]of Object.entries(files)){
    if(name!=='root.sqlite'&&!companyFile.test(name))throw new DemoStateError('展示資料格式錯誤');
    if(typeof value!=='string'||value.length>12*1024*1024)throw new DemoStateError('展示資料格式錯誤');
    const bytes=Buffer.from(value,'base64');size+=bytes.length;
    if(size>maxBytes||bytes.subarray(0,16).toString()!=='SQLite format 3\0')throw new DemoStateError('展示資料量已達上限，請重新開始展示。');
    decoded.push([name,bytes]);
  }return decoded;
}
export function restoreDemo(directory,state){
  for(const [name,bytes]of validateFiles(state.files)){
    const destination=name==='root.sqlite'?directory:join(directory,'.company-workspaces');mkdirSync(destination,{recursive:true});writeFileSync(join(destination,name),bytes,{flag:'wx',mode:0o600});
  }
}
