import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreGroupLayout } from '../lib/layout.mjs';

function fixture({ ignored = false } = {}) {
  const roles = [['master', 'loader'], ['coder1', 'coder2'], ['reviewer', 'test'], ['archi'], ['simple'], ['designer']];
  const titles = ['master', 'coder', 'reviewer', 'archi', 'simple', 'designer'];
  const config = { tabs: roles.map((agents, i) => ({ title: titles[i], agents, ...(agents.length === 2 ? { direction: 'vertical', ratio: 0.5 } : {}) })) };
  const state = { agents: Object.fromEntries(roles.flatMap((names, i) => names.map(name => [name, { tabId: titles[i], leafId: name }]))) };
  const snapshot = { tabGroups: [{ id: 'g', tabOrder: ['master', 'archi', 'service', 'coder', 'designer', 'reviewer', 'simple', 'editor'] }], tabs: roles.flatMap((names, i) => {
    const leaves = names.map(leafId => ({ type: 'leaf', leafId }));
    const root = names.length === 1 ? leaves[0] : { type: 'split', direction: 'horizontal', ratio: 0.7, first: leaves[1], second: leaves[0] };
    return names.map(leafId => ({ type: 'terminal', parentTabId: titles[i], leafId, ptyId: `pty-${leafId}`, parentLayout: { root, expandedLeafId: names.length === 2 ? names[0] : null } }));
  }) };
  const writes = [];
  const rpc = async (method, params) => {
    if (method === 'session.tabs.list') return structuredClone(snapshot);
    writes.push({ method, params });
    if (!ignored && method === 'session.tabs.updatePaneLayout') for (const row of snapshot.tabs.filter(row => row.parentTabId === params.tabId)) row.parentLayout = { root: params.root, expandedLeafId: params.expandedLeafId };
    else if (!ignored && method === 'session.tabs.move') snapshot.tabGroups[0].tabOrder = params.tabOrder;
    return { updated: true };
  };
  return { snapshot, writes, options: { project: '/project', config, state, rpc, sleep: async () => {} } };
}
test('six groups/nine roles restore order and equal left/right panes, preserve PTYs and unrelated tabs, rerun is idempotent', async () => {
  const { snapshot, writes, options } = fixture();
  const identities = snapshot.tabs.map(row => [row.leafId, row.ptyId]);
  await restoreGroupLayout(options);
  assert.deepEqual(snapshot.tabGroups[0].tabOrder, ['master', 'coder', 'reviewer', 'archi', 'simple', 'designer', 'service', 'editor']);
  assert.deepEqual(snapshot.tabs.map(row => [row.leafId, row.ptyId]), identities);
  for (const tab of options.config.tabs) {
    const layout = snapshot.tabs.find(row => row.parentTabId === tab.title).parentLayout;
    if (tab.agents.length === 2) {
      assert.equal(layout.root.direction, 'vertical'); assert.equal(layout.root.ratio, 0.5);
      assert.equal(layout.root.first.leafId, tab.agents[0]); assert.equal(layout.root.second.leafId, tab.agents[1]);
    } else assert.deepEqual(layout.root, { type: 'leaf', leafId: tab.agents[0] });
    assert.equal(layout.expandedLeafId, null);
  }
  const count = writes.length; await restoreGroupLayout(options); assert.equal(writes.length, count);
});
test('acknowledgement without applied readback fails', async () => {
  await assert.rejects(restoreGroupLayout(fixture({ ignored: true }).options), /did not apply/);
});
test('missing/extra pane, separate role tab and separate desktop group refuse before mutations', async () => {
  for (const kind of ['missing', 'extra', 'separate', 'group']) {
    const { snapshot, writes, options } = fixture();
    if (kind === 'missing') snapshot.tabs.shift();
    if (kind === 'extra') snapshot.tabs.push({ type: 'terminal', parentTabId: 'master', leafId: 'foreign' });
    if (kind === 'separate') options.state.agents.loader.tabId = 'foreign';
    if (kind === 'group') { snapshot.tabGroups[0].tabOrder = snapshot.tabGroups[0].tabOrder.filter(id => id !== 'designer'); snapshot.tabGroups.push({ id: 'other', tabOrder: ['designer'] }); }
    await assert.rejects(restoreGroupLayout(options)); assert.equal(writes.length, 0);
  }
});
