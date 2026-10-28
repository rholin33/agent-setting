import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileTerminalList } from '../lib/list-reconcile.mjs';
import { reconcileProjectList } from '../lib/list-reconcile.mjs';
import { projectFiles, saveJson } from '../lib/team.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function fixture() {
  const row = (handle, tabId = handle) => ({ handle, tabId, leafId: handle, incarnationId: 'epoch', executionHostId: 'local', worktreePath: '/project', connected: true });
  let rows = ['role', 'return', 'remote', 'helper', 'extra'].map(h => row(h));
  const closed = [], audits = [];
  const inventory = () => ({ terminals: rows, totalCount: rows.length, truncated: false, hostScope: { hostIds: ['local'], omittedHostIds: [] } });
  const options = { project: '/project', config: { tabs: [{ agents: ['master'] }] },
    closeTargets: [row('extra')],
    state: { agents: { master: { tabId: 'role', leafId: 'role' } } },
    protectedHandles: ['return', 'remote', 'helper'], audit: r => audits.push(r),
    cli: async args => {
      if (args[1] === 'list') return inventory();
      if (args[1] === 'show') return { terminal: rows.find(r => r.handle === args[3]) };
      if (args[1] === 'close') { closed.push(args[3]); rows = rows.filter(r => r.handle !== args[3]); return {}; }
      throw new Error('Unexpected operation');
    } };
  return { options, closed, audits, inventory };
}
test('removes extras, preserves configured and remote return/service panes, repeat is a no-op', async () => {
  const f = fixture();
  await reconcileTerminalList(f.options);
  assert.deepEqual(f.closed, ['extra']);
  assert.equal(f.audits[0].status, 'planned');
  await reconcileTerminalList(f.options);
  assert.deepEqual(f.closed, ['extra']);
});

test('startup without explicit close targets preserves unregistered service and repair terminals', async () => {
  const f = fixture();
  delete f.options.closeTargets;
  f.options.protectedHandles = [];
  const result = await reconcileTerminalList(f.options);
  assert.deepEqual(f.closed, []);
  assert.equal(f.inventory().terminals.length, 5);
  assert.equal(result.status, 'completed');
});

test('stale close target cannot authorize closing a replacement terminal', async () => {
  const f = fixture();
  f.options.closeTargets[0].incarnationId = 'previous';
  await reconcileTerminalList(f.options);
  assert.deepEqual(f.closed, []);
});
test('missing configured pane prevents every close', async () => {
  const f = fixture(); f.options.state.agents.master.leafId = 'missing';
  await assert.rejects(reconcileTerminalList(f.options), /master/);
  assert.deepEqual(f.closed, []);
});
test('incomplete inventory prevents every close', async () => {
  const f = fixture(); f.options.cli = async () => ({ ...f.inventory(), truncated: true });
  await assert.rejects(reconcileTerminalList(f.options), /inventory/i);
  assert.deepEqual(f.closed, []);
});
test('changed incarnation is never closed', async () => {
  const f = fixture(), cli = f.options.cli;
  f.options.cli = async args => args[1] === 'show' ? { terminal: { ...(await cli(args)).terminal, incarnationId: 'new' } } : cli(args);
  await assert.rejects(reconcileTerminalList(f.options), /identity/i);
  assert.deepEqual(f.closed, []);
});
test('unconfirmed close fails verification', async () => {
  const f = fixture(), cli = f.options.cli;
  f.options.cli = async args => args[1] === 'close' ? {} : cli(args);
  await assert.rejects(reconcileTerminalList(f.options), /remain/i);
});

test('remote owner with an absent original return pane defers cleanup and preserves all live terminals', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-list-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const files = projectFiles(home, '/project');
  fs.mkdirSync(files.directory, { recursive: true });
  saveJson(files.config, { tabs: [{ agents: ['master'] }] });
  saveJson(files.state, { agents: { master: { tabId: 'old', leafId: 'return' } } });
  saveJson(path.join(files.directory, 'remote-switches.json'), { roles: { master: { runtime: 'claude' } } });
  const result = await reconcileProjectList({ home, project: '/project', log: () => {}, cli: async args => {
    assert.equal(args[1], 'list');
    return { terminals: [], totalCount: 0, truncated: false, hostScope: { hostIds: ['local'], omittedHostIds: [] } };
  } });
  assert.equal(result.status, 'deferred');
});
