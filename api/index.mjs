import { createGateway } from '../src/vercel-gateway.mjs';
import { readFileSync } from 'node:fs';

const mode=process.env.ERP_MODE||(process.env.ERP_BACKEND_URL?'production':'demo');
let handler;
export default async function entry(req,res){
  if(mode==='production'){handler??=Promise.resolve(createGateway());}
  else if(mode==='demo')handler??=import('../src/vercel-demo.mjs').then(({createDemoHandler})=>createDemoHandler({key:Buffer.from(JSON.parse(readFileSync(new URL('../demo-private/key.json',import.meta.url),'utf8')).key,'hex')}));
  else{res.writeHead(503,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});return res.end('ERP_MODE 僅接受 demo 或 production');}
  return (await handler)(req,res);
}
