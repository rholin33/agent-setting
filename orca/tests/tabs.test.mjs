import test from 'node:test';
import assert from 'node:assert/strict';
import { pinGroupTabs } from '../lib/tabs.mjs';

function fixture({ ignoreWrite = false, extraPane = false } = {}) {
  const state = { agents: { master: { tabId: 't', leafId: 'm' }, loader: { tabId: 't', leafId: 'l' } } };
  const config = { tabs: [{ title: 'master', agents: ['master', 'loader'] }] };
  const rows = ['m', 'l', ...(extraPane ? ['other'] : [])].map(leafId => ({ type: 'terminal', id: `t::${leafId}`, parentTabId: 't', leafId }));
  rows.push({ type: 'terminal', id: 'unrelated', parentTabId: 'other-tab', leafId: 'x' });
  const writes = [];
  const rpc = async (method, params) => {
    assert.equal(params.worktree, 'path:D:/project');
    if (method === 'session.tabs.list') return { tabs: structuredClone(rows) };
    assert.equal(method, 'session.tabs.setTabProps');
    assert.equal(params.tabId, 't'); assert.equal(params.isPinned, true);
    writes.push(params);
    if (!ignoreWrite) for (const row of rows.filter(row => row.parentTabId === 't')) row.isPinned = true;
    return { updated: true };
  };
  return { options: { project: 'D:/project', config, state, rpc, sleep: async () => {} }, rows, writes };
}

test('pins each parent once, verifies both panes and leaves unrelated tabs unchanged', async () => {
  const { options, rows, writes } = fixture();
  await pinGroupTabs(options); await pinGroupTabs(options);
  assert.equal(writes.length, 1);
  assert.equal(rows.at(-1).isPinned, undefined);
});

test('updated true without readback is failure, never a successful pin', async () => {
  const { options, writes } = fixture({ ignoreWrite: true });
  await assert.rejects(pinGroupTabs(options), /pin.*not applied/i);
  assert.equal(writes.length, 1);
});

test('missing, extra and mismatched panes are refused before pin mutations', async () => {
  for (const kind of ['missing', 'extra', 'mismatch']) {
    const { options, rows, writes } = fixture({ extraPane: kind === 'extra' });
    if (kind === 'missing') rows.shift();
    if (kind === 'mismatch') options.state.agents.loader.tabId = 'other';
    await assert.rejects(pinGroupTabs(options), /Cannot verify/);
    assert.equal(writes.length, 0);
  }
});
