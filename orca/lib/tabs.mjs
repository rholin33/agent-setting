import { rpc as callRpc } from './orca.mjs';

export async function pinGroupTabs({ project, config, state, rpc = callRpc, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const worktree = `path:${project}`;
  const read = () => rpc('session.tabs.list', { worktree });
  const groups = config.tabs.map(tab => {
    const agents = tab.agents.map(name => state.agents[name]);
    const tabId = agents[0]?.tabId;
    if (!tabId || agents.some(agent => !agent?.leafId || agent.tabId !== tabId)) throw new Error(`Cannot verify group ${tab.title} for pinning`);
    return { title: tab.title, tabId, leaves: agents.map(agent => agent.leafId) };
  });
  const rowsFor = (snapshot, group) => {
    const rows = (snapshot.tabs || []).filter(row => row.type === 'terminal' && row.parentTabId === group.tabId);
    if (rows.length !== group.leaves.length || group.leaves.some(leaf => rows.filter(row => row.leafId === leaf).length !== 1)) throw new Error(`Cannot verify visible panes for ${group.title}`);
    return rows;
  };
  const before = await read();
  // Validate all targets before changing any tab; never pin by a display title.
  const pending = groups.filter(group => rowsFor(before, group).some(row => row.isPinned !== true));
  for (const group of pending) await rpc('session.tabs.setTabProps', { worktree, tabId: group.tabId, isPinned: true });
  if (!pending.length) return;
  for (let attempt = 0; attempt < 10; attempt++) {
    const after = await read();
    if (groups.every(group => rowsFor(after, group).every(row => row.isPinned === true))) return;
    await sleep(200);
  }
  throw new Error('Tab pinning was not applied by Orca. Agents/layout are retained. This desktop version may acknowledge setTabProps without applying it. Native pins are not a hard close lock.');
}
