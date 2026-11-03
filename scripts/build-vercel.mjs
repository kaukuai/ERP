import { mkdirSync,writeFileSync } from 'node:fs';

// The function proxies all assets and requests to one persistent backend.
// Keep this output separate from public/ so static routes cannot bypass it.
mkdirSync(new URL('../vercel-public/',import.meta.url),{recursive:true});
writeFileSync(new URL('../vercel-public/.gitkeep',import.meta.url),'');
console.log('ERP gateway ready. Configure ERP_BACKEND_URL and ERP_PROXY_SECRET in the deployment environment.');
