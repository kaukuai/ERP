import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit development entry point. Normal start/demo keep their existing policy.
export function developmentEnvironment(env, args = []) {
  const next = { ...env };
  if (env.CODESPACES !== 'true') return next;
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const name = env.CODESPACE_NAME || '';
  const domain = env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev';
  const port = Number(env.PORT || (args.includes('--demo') ? 4321 : 4320));
  if (!label.test(name) || domain.length > 190 || !domain.split('.').every(x => label.test(x)) || !domain.includes('.') || !Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw Error('Codespaces 名稱、轉送網域或連接埠格式錯誤');
  }
  const hostname = `${name}-${port}.${domain}`;
  if (!hostname.split('.').every(x => label.test(x))) throw Error('Codespaces 轉送主機名稱過長');
  next.ERP_ALLOWED_HOSTS = [...new Set([...(env.ERP_ALLOWED_HOSTS || '').split(',').map(x => x.trim()).filter(Boolean), hostname])].join(',');
  next.ERP_SECURE_COOKIE = '1';
  return next;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Object.assign(process.env, developmentEnvironment(process.env, process.argv.slice(2)));
  await import('../src/server.mjs');
}
