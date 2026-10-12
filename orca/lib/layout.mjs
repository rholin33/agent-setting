import { rpc as callRpc } from './orca.mjs';

// Reconcile presentation only; never create/close panes or restart agents.
export async function restoreGroupLayout({ project, config, state, rpc = callRpc, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const worktree = `path:${project}`;
  const read = () => rpc('session.tabs.list', { worktree });
  const before = await read();
  const targets = config.tabs.map(tab => {
    const agents = tab.agents.map(name => state.agents[name]);
    const tabId = agents[0]?.tabId;
    if (!tabId || agents.some(agent => !agent?.leafId || agent.tabId !== tabId)) throw new Error(`Cannot restore ${tab.title}: roles are not in one tab`);
    const rows = before.tabs.filter(row => row.type === 'terminal' && row.parentTabId === tabId);
    if (rows.length !== agents.length || agents.some(agent => rows.filter(row => row.leafId === agent.leafId).length !== 1)) throw new Error(`Cannot restore ${tab.title}: unexpected or missing panes`);
    const groups = before.tabGroups.filter(group => group.tabOrder.includes(tabId));
    if (groups.length !== 1) throw new Error(`Cannot restore ${tab.title}: ambiguous tab group`);
    const leaves = agents.map(agent => ({ type: 'leaf', leafId: agent.leafId }));
    const root = leaves.length === 1 ? leaves[0] : { type: 'split', direction: tab.direction, ratio: tab.ratio, first: leaves[0], second: leaves[1] };
    return { tabId, groupId: groups[0].id, root };
  });
  if (new Set(targets.map(target => target.tabId)).size !== targets.length) throw new Error('Configured groups share a tab');
  if (new Set(targets.map(target => target.groupId)).size !== 1) throw new Error('Team tabs span desktop groups; manual grouping required');
  const group = before.tabGroups.find(group => group.id === targets[0].groupId);
  const ids = targets.map(target => target.tabId);
  const tabOrder = [...ids, ...group.tabOrder.filter(id => !ids.includes(id))];
  const rootMatches = (actual, expected) => expected.type === 'leaf'
    ? actual?.type === 'leaf' && actual.leafId === expected.leafId
    : actual?.type === 'split' && actual.direction === expected.direction && (actual.ratio ?? 0.5) === expected.ratio && rootMatches(actual.first, expected.first) && rootMatches(actual.second, expected.second);
  const paneMatches = (snapshot, target) => {
    const rows = snapshot.tabs.filter(row => row.parentTabId === target.tabId && row.type === 'terminal');
    return rows.length === (target.root.type === 'leaf' ? 1 : 2) && rows.every(row => rootMatches(row.parentLayout?.root, target.root) && !row.parentLayout?.expandedLeafId);
  };
  let changed = false;
  for (const target of targets) {
    if (paneMatches(before, target)) continue;
    await rpc('session.tabs.updatePaneLayout', { worktree, tabId: target.tabId, root: target.root, expandedLeafId: null });
    changed = true;
  }
  if (JSON.stringify(group.tabOrder) !== JSON.stringify(tabOrder)) {
    await rpc('session.tabs.move', { worktree, tabId: ids[0], targetGroupId: group.id, kind: 'reorder', tabOrder });
    changed = true;
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    const after = changed ? await read() : before;
    const order = after.tabGroups.find(item => item.id === group.id)?.tabOrder;
    if (JSON.stringify(order) === JSON.stringify(tabOrder) && targets.every(target => paneMatches(after, target))) return;
    await sleep(200);
  }
  throw new Error('Orca did not apply the configured tab order/pane layout; existing sessions retained');
}
