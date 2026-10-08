import { sameWorktree } from './sessions.mjs';

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
