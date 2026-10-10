import { sameWorktree } from './sessions.mjs';

// The renderer can retire a pane while the persisted snapshot still lists its tab.
// Never infer process absence from that snapshot alone, and retain the saved history.
export async function reconcileRoleTabs({ snapshot, project, config, state, inventory, published, verifyAbsent }) {
  const result = structuredClone(snapshot);
  const tabs = Object.entries(result.tabsByWorktree || {})
    .filter(([key]) => sameWorktree(key, project)).flatMap(([, rows]) => rows);
  const titles = new Set(config.tabs.map(group => group.displayTitle || group.title));
  const stale = [...new Map(tabs.filter(tab => titles.has((tab.customTitle || tab.title || '').trim()) &&
    !inventory.terminals.some(row => row.tabId === tab.id)).map(tab => [tab.id, tab])).values()];
  if (!stale.length) return result;
  const visible = await published();
  if (!Array.isArray(visible?.tabs)) throw new Error('Published tab inventory unavailable; recovery refused');
  for (const tab of stale) {
    if (visible.tabs.some(row => row.parentTabId === tab.id || row.id === tab.id)) {
      throw new Error(`Durable tab ${tab.id} still has an original pane in Orca; recovery refused`);
    }
    const proof = state.retiredTabs?.[tab.id];
    if (proof && sameWorktree(`local::${proof.project}`, project) && Object.keys(proof.sessions || {}).length &&
        Object.entries(proof.sessions).every(([name, id]) => state.agents[name]?.session?.id === id)) {
      // A replacement may now run this conversation; the proof was recorded before it launched.
      continue;
    }
    const group = config.tabs.find(group => (group.displayTitle || group.title) === (tab.customTitle || tab.title || '').trim());
    const missing = group.agents.map(name => ({ name, saved: state.agents[name] }));
    if (missing.some(({ saved }) => !saved?.session?.id || saved.tabId !== tab.id)) {
      throw new Error(`Tab ${tab.id}: original conversation binding unavailable; recovery refused`);
    }
    assertConversationAbsent(result, project, missing, inventory.terminals);
    if (await verifyAbsent({ project, missing }) !== true) throw new Error(`Tab ${tab.id}: process absence was not verified`);
    state.retiredTabs ||= {};
    state.retiredTabs[tab.id] = { project, verifiedAt: new Date().toISOString(),
      sessions: Object.fromEntries(missing.map(({ name, saved }) => [name, saved.session.id])) };
  }
  const ids = new Set(stale.map(tab => tab.id));
  for (const [key, rows] of Object.entries(result.tabsByWorktree || {})) {
    if (sameWorktree(key, project)) result.tabsByWorktree[key] = rows.filter(tab => !ids.has(tab.id));
  }
  return result;
}

// A missing PTY does not mean its durable tab has been closed.
export function assertUniqueRoleTabs(snapshot, project, config, inventory) {
  const tabs = Object.entries(snapshot.tabsByWorktree || {})
    .filter(([key]) => sameWorktree(key, project)).flatMap(([, rows]) => rows);
  for (const group of config.tabs) {
    // 同一个页签可能同时出现在桌面与无头快照里，按 id 去重后再判断重复。
    // displayTitle 是页签在 Orca 面板里的显示名（可列出同组角色），分组标题仍按 group.title 选择。
    const expected = group.displayTitle || group.title;
    const matches = [...new Map(tabs
      .filter(tab => (tab.customTitle || tab.title || '').trim() === expected)
      .map(tab => [tab.id, tab])).values()];
    if (matches.length > 1) throw new Error(`Duplicate durable tabs for ${expected} (${matches.map(tab => tab.id).join(', ')}); recovery refused, existing sessions retained`);
    if (matches.length === 1 && !inventory.terminals.some(row => row.tabId === matches[0].id)) {
      throw new Error(`Durable tab ${group.title} has no live PTY; restore its original pane in Orca before retrying`);
    }
  }
}

export function assertConversationAbsent(snapshot, project, missing, terminals) {
  for (const row of terminals) {
    const record = snapshot.sleepingAgentSessionsByPaneKey?.[`${row.tabId}:${row.leafId}`];
    if (!record || record.connectionId || !sameWorktree(record.worktreeId, project)) continue;
    for (const { name, saved } of missing) {
      const session = record.providerSession;
      if (session && (session.id === saved.session?.id ||
          (session.transcriptPath && session.transcriptPath === saved.session?.transcriptPath))) {
        throw new Error(`${name}: original conversation is bound to another live pane; recovery refused`);
      }
    }
  }
}
