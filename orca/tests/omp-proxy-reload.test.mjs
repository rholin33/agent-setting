import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appliedModelOf, sameAppliedConfig } from '../lib/launch-state.mjs';
import { reloadRunning } from '../lib/reload.mjs';
import { projectFiles } from '../lib/team.mjs';
const role = { name: 'master', agent: 'omp', model: 'pay/gpt-6-astra', thinking: 'high' };
const options = (server = '127.0.0.1:10808', enabled = 1, env = {}) => ({
  platform: 'win32', env, run: () => ` ProxyEnable REG_DWORD ${enabled}\n ProxyServer REG_SZ ${server}\n`,
});

test('legacy OMP fingerprint triggers one restart, then identical proxy is reused', () => {
  assert.equal(sameAppliedConfig({ appliedModel: role }, role, null, options()), false);
  const appliedModel = appliedModelOf(role, null, options());
  assert.equal(typeof appliedModel.proxy, 'string');
  assert.equal(sameAppliedConfig({ appliedModel }, role, null, options()), true);
  assert.equal(sameAppliedConfig({ appliedModel }, role, null, options('localhost:7890')), false);
  assert.equal(sameAppliedConfig({ appliedModel }, role, null, options('', 0)), false);
});

test('explicit provider proxy and bypass changes invalidate OMP fingerprint without persisting credentials', () => {
  const env = { PI_PROXY_PAY: 'http://user:secret@localhost:7890', NO_PROXY: 'localhost' };
  const appliedModel = appliedModelOf(role, null, options('', 0, env));
  assert.equal(JSON.stringify(appliedModel).includes('secret'), false);
  assert.equal(sameAppliedConfig({ appliedModel }, role, null, options('', 0, { ...env, NO_PROXY: 'example.com' })), false);
  assert.equal(sameAppliedConfig({ appliedModel }, role, null, options('', 0, { ...env, PI_PROXY_PAY: 'http://localhost:7891' })), false);
});

test('Codex fingerprint ignores system proxy changes', () => {
  const codex = { ...role, agent: 'codex' };
  const appliedModel = appliedModelOf(codex, null, options());
  assert.equal(appliedModel.proxy, undefined);
  assert.equal(sameAppliedConfig({ appliedModel }, codex, null, options('', 0)), true);
});

test('default reload restarts old OMP even when model and prompt match; second run reuses it', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-proxy-reload-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = home.replaceAll('\\', '/');
  const files = projectFiles(home, project);
  fs.mkdirSync(files.directory, { recursive: true });
  fs.writeFileSync(path.join(home, 'team.json'), JSON.stringify([role]));
  fs.writeFileSync(files.config, JSON.stringify({ tabs: [{ title: 'master', agents: ['master'] }] }));
  const saved = { agent: 'omp', tabId: 'tab', leafId: 'leaf', session: { id: 'original' }, appliedModel: role };
  const state = { agents: { master: saved } };
  fs.writeFileSync(files.state, JSON.stringify(state));
  let count = 0;
  const run = () => reloadRunning({ home, project, ompProxyOptions: options(), log: () => {},
    cli: async () => ({ terminals: [{ tabId: 'tab', leafId: 'leaf', handle: 'handle', worktreePath: project, connected: true }] }),
    inspect: async () => ({ kind: 'agent' }),
    restart: async request => {
      count++;
      assert.deepEqual(request.roles, ['master']);
      assert.equal(saved.session.id, 'original');
      saved.appliedModel = appliedModelOf(role, home, options());
      fs.writeFileSync(files.state, JSON.stringify(state));
      return { reloaded: ['master'], failed: [] };
    },
  });
  assert.deepEqual((await run()).reloaded, ['master']);
  assert.deepEqual((await run()).current, ['master']);
  assert.equal(count, 1);
});
