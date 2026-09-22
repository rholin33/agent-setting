import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reloadRunning, sameAppliedConfig, desiredModelOf } from '../lib/reload.mjs';
import { appliedModelOf } from '../lib/restart.mjs';
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

test('sameAppliedConfig compares agent, model and thinking', () => {
  const role = { agent: 'codex', model: 'm', thinking: 'medium' };
  assert.equal(sameAppliedConfig({ appliedModel: appliedModelOf(role) }, role), true);
  assert.equal(sameAppliedConfig({ appliedModel: { ...appliedModelOf(role), thinking: null } }, role), false);
  assert.equal(sameAppliedConfig({}, role), false);
  assert.deepEqual(desiredModelOf(role), { agent: 'codex', model: 'm', thinking: 'medium' });
});

test('reload restarts only stale running roles and keeps current ones', async t => {
  const { home, project, cli } = fixture(t);
  const logs = [];
  const calls = [];
  const result = await reloadRunning({
    home, project, cli, snapshot: async () => ({}), log: msg => logs.push(msg),
    restart: async options => { calls.push(options.roles); return { reloaded: options.roles, failed: [] }; },
  });
  assert.deepEqual(calls, [['coder1', 'idle']]);
  assert.deepEqual(result.reloaded, ['coder1', 'idle']);
  assert.deepEqual(result.current, ['master']);
  assert.ok(logs.some(line => line.includes('kept as-is')));
});

test('reload without stale roles performs no restarts', async t => {
  const { home, project, cli } = fixture(t);
  const stateFile = path.join(home, 'projects', projectKey('D:/Code/sample'), 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.agents.coder1.appliedModel = { agent: 'codex', model: 'deepseek-v4.1-flash', thinking: 'medium' };
  state.agents.idle.appliedModel = { agent: 'pi', model: 'local/deepseek-v4.1-flash', thinking: 'medium' };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const logs = [];
  let restarts = 0;
  const result = await reloadRunning({
    home, project, cli, snapshot: async () => ({}), log: msg => logs.push(msg),
    restart: async () => { restarts += 1; return { reloaded: [], failed: [] }; },
  });
  assert.equal(restarts, 0);
  assert.equal(result.reloaded.length, 0);
  assert.equal(result.current.length, 3);
  assert.ok(logs.some(line => line.includes('3 running role(s) kept as-is')));
});

test('reload reports failed parallel restarts as skipped warnings', async t => {
  const { home, project, cli } = fixture(t);
  const logs = [];
  const result = await reloadRunning({
    home, project, cli, snapshot: async () => ({}), log: msg => logs.push(msg),
    restart: async () => ({ reloaded: ['idle'], failed: [{ name: 'coder1', reason: 'agent is busy; retry after its turn completes' }] }),
  });
  assert.deepEqual(result.reloaded, ['idle']);
  assert.deepEqual(result.skipped.map(item => item.name), ['coder1']);
  assert.ok(logs.some(line => line.includes('Warning: coder1 not reloaded')));
});
