import test from 'node:test';
import assert from 'node:assert/strict';
import { developmentEnvironment } from '../scripts/dev.mjs';

test('local development preserves binding and security settings', () => {
  const env = { ERP_HOST: '127.0.0.1', ERP_ALLOWED_HOSTS: 'erp.internal', ERP_SECURE_COOKIE: '0' };
  assert.deepEqual(developmentEnvironment(env, ['--demo']), env);
  assert.deepEqual(env, { ERP_HOST: '127.0.0.1', ERP_ALLOWED_HOSTS: 'erp.internal', ERP_SECURE_COOKIE: '0' });
});

test('Codespaces allows only the exact forwarded port and retains host/origin controls', () => {
  const env = { CODESPACES: 'true', CODESPACE_NAME: 'sample-project-123', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev', ERP_ALLOWED_HOSTS: 'erp.internal' };
  const demo = developmentEnvironment(env, ['--demo']);
  assert.equal(demo.ERP_ALLOWED_HOSTS, 'erp.internal,sample-project-123-4321.app.github.dev');
  assert.equal(demo.ERP_SECURE_COOKIE, '1');
  assert.equal(demo.ERP_HOST, undefined);
  assert.equal(developmentEnvironment({ ...env, PORT: '5000' }).ERP_ALLOWED_HOSTS, 'erp.internal,sample-project-123-5000.app.github.dev');
  assert.equal(developmentEnvironment(env).ERP_ALLOWED_HOSTS, 'erp.internal,sample-project-123-4320.app.github.dev');
  for (const bad of [{ CODESPACE_NAME: '*' }, { CODESPACE_NAME: 'a'.repeat(63) }, { GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'bad..example' }, { GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'https://app.github.dev' }, { PORT: '4321,evil' }]) {
    assert.throws(() => developmentEnvironment({ ...env, ...bad }), /格式錯誤|過長/);
  }
});
