// HTTP fixtures must never inherit a deployed server's storage or credentials.
export function serverEnv(overrides={}){
  const base=Object.fromEntries(Object.entries(process.env).filter(([name])=>{
    const key=name.toUpperCase();return !key.startsWith('ERP_')&&!['PORT','VERCEL','RENDER','RENDER_EXTERNAL_HOSTNAME'].includes(key);
  }));
  return {...base,...overrides};
}
