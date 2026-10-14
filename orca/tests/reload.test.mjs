import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reloadRunning } from '../lib/reload.mjs';
import { projectKey } from '../lib/platform.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-reload-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = 'D:/Code/sample';
  const directory = path.join(home, 'projects', projectKey(project));
  fs.mkdirSync(directory, { recursive: true });
  const catalog = [
    { name: 'master', agent: 'pi', model: 'pay/gpt-6-astra', thinking: null, role: 'r' },
    { name: 'coder1', agent: 'codex', model: 'deepseek-v4.1-flash', thinking: 'medium', role: 'r' },
    { name: 'idle', agent: 'pi', model: 'local/deepseek-v4.1-flash', thinking: 'medium', role: 'r' },
  ];
  fs.writeFileSync(path.join(home, 'team.json'), JSON.stringify(catalog));
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({
    workspace: project, tabs: [{ title: 'master', agents: ['master'] }, { title: 'coder', agents: ['coder1'] }, { title: 'simple', agents: ['idle'] }],
  }));
  const saved = (tabId, leafId, extra = {}) => ({ tabId, leafId, session: { id: 'sid-' + tabId, transcriptPath: 'x.jsonl' }, ...extra });
  const state = { workspace: project, agents: {
    master: saved('t1', 'l1', { appliedModel: { agent: 'pi', model: 'pay/gpt-6-astra', thinking: null } }),
    coder1: saved('t2', 'l2', { appliedModel: { agent: 'codex', model: 'old-model', thinking: 'medium' } }),
    idle: saved('t3', 'l3'),
  } };
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify(state));
  const cli = async args => (args.includes('terminal') && args.includes('list')
    ? { terminals: [
      { tabId: 't1', leafId: 'l1', worktreePath: 'D:/Code/sample', connected: true },
      { tabId: 't2', leafId: 'l2', worktreePath: 'D:/Code/sample', connected: true },
      { tabId: 't3', leafId: 'l3', worktreePath: 'D:/Code/sample', connected: true },
    ] }
    : {});
  return { home, project, cli, catalog };
}

test('reload restarts only running roles whose configuration changed', async t => {
  const { home, project, cli } = fixture(t);
  const logs = [];
  const calls = [];
  const result = await reloadRunning({
    home, project, cli, snapshot: async () => ({}), inspect: async () => ({ kind: 'agent' }), log: msg => logs.push(msg),
    restart: async options => { assert.equal(options.forceExit, true); calls.push(options.roles); return { reloaded: options.roles, failed: [] }; },
  });
  assert.deepEqual(calls, [['coder1', 'idle']]);
  assert.deepEqual(result.reloaded, ['coder1', 'idle']);
  assert.deepEqual(result.current, ['master']);
  assert.ok(logs.some(line => line.includes('Restarting 2 running role(s)')));
});

test('matching configuration is reused without inspection; a changed role prompt restarts it', async t => {
  const { home, project, cli } = fixture(t);
  let inspected = 0;
  const run = () => reloadRunning({ home, project, cli, names: ['master'], log: () => {},
    inspect: async () => { inspected++; return { kind: 'agent' }; },
    restart: async options => { assert.equal(options.forceExit, true); assert.deepEqual(options.roles, ['master']); return { reloaded: options.roles, failed: [] }; } });
  let result = await run();
  assert.equal(inspected, 0);
  assert.deepEqual(result.current, ['master']);
  assert.deepEqual(result.reloaded, []);
  // 记录过提示指纹后，角色提示内容变化也要重启。
  fs.mkdirSync(path.join(home, 'roles'));
  fs.writeFileSync(path.join(home, 'roles', 'master.md'), 'new prompt');
  const file = path.join(home, 'projects', projectKey(project), 'state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.agents.master.appliedModel.prompt = 'stale-prompt-hash';
  fs.writeFileSync(file, JSON.stringify(state));
  result = await run();
  assert.equal(inspected, 1);
  assert.deepEqual(result.reloaded, ['master']);
});

test('reload without running panes performs no restarts', async t => {
  const { home, project } = fixture(t);
  const logs = [];
  let restarts = 0;
  const result = await reloadRunning({
    home, project, cli: async () => ({ terminals: [] }), snapshot: async () => ({}), inspect: async () => ({ kind: 'agent' }), log: msg => logs.push(msg),
    restart: async () => { restarts += 1; return { reloaded: [], failed: [] }; },
  });
  assert.equal(restarts, 0);
  assert.equal(result.reloaded.length, 0);
  assert.equal(result.current.length, 0);
  assert.ok(logs.some(line => line.includes('No running role to restart')));
});

test('reload reports failed parallel restarts as skipped warnings', async t => {
  const { home, project, cli } = fixture(t);
  const logs = [];
  const result = await reloadRunning({
    home, project, cli, snapshot: async () => ({}), inspect: async () => ({ kind: 'agent' }), log: msg => logs.push(msg),
    restart: async () => ({ reloaded: ['idle'], failed: [{ name: 'coder1', reason: 'agent is busy; retry after its turn completes' }] }),
  });
  assert.deepEqual(result.reloaded, ['idle']);
  assert.deepEqual(result.skipped.map(item => item.name), ['coder1']);
  assert.ok(logs.some(line => line.includes('Warning: coder1 not reloaded')));
});

test('roles whose panes are shells wait for the start pass instead of restarting', async t => {
  const { home, project, cli } = fixture(t);
  const logs = [];
  let restarts = 0;
  const result = await reloadRunning({
    home, project, cli, snapshot: async () => ({}), inspect: async () => ({ kind: 'shell' }), log: msg => logs.push(msg),
    restart: async () => { restarts += 1; return { reloaded: [], failed: [] }; },
  });
  assert.equal(restarts, 0);
  assert.equal(result.reloaded.length, 0);
  assert.ok(logs.some(line => line.includes('No running role to restart')));
});
