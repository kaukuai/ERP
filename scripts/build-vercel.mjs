import { mkdirSync,writeFileSync,cpSync,rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join,resolve } from 'node:path';

const root=resolve(import.meta.dirname,'..'),output=join(root,'.vercel/output'),fn=join(output,'functions/erp.func');
rmSync(output,{recursive:true,force:true});mkdirSync(fn,{recursive:true});mkdirSync(join(output,'static'));
for(const name of ['src','api','public','vendor'])cpSync(join(root,name),join(fn,name),{recursive:true});
cpSync(join(root,'package.json'),join(fn,'package.json'));
mkdirSync(join(fn,'demo-private'));writeFileSync(join(fn,'demo-private/key.json'),JSON.stringify({key:randomBytes(32).toString('hex')}),{mode:0o644});
writeFileSync(join(fn,'.vc-config.json'),JSON.stringify({runtime:'nodejs24.x',handler:'api/index.mjs',launcherType:'Nodejs',shouldAddHelpers:false,maxDuration:60}));
writeFileSync(join(output,'config.json'),JSON.stringify({version:3,routes:[{src:'/(.*)',dest:'/erp'}]}));
console.log('ERP deployment built: interactive demo by default; ERP_MODE=production uses the configured persistent backend.');
