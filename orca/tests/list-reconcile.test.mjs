import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileTerminalList } from '../lib/list-reconcile.mjs';

function fixture() {
  const row = (handle, tabId = handle) => ({ handle, tabId, leafId: handle, incarnationId: 'epoch', executionHostId: 'local', worktreePath: '/project', connected: true });
  let rows = ['role', 'return', 'remote', 'helper', 'extra'].map(h => row(h));
  const closed = [], audits = [];
  const inventory = () => ({ terminals: rows, totalCount: rows.length, truncated: false, hostScope: { hostIds: ['local'], omittedHostIds: [] } });
  const options = { project: '/project', config: { tabs: [{ agents: ['master'] }] },
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
