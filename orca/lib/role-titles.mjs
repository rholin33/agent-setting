import { sameWorktree } from './sessions.mjs';
import path from 'node:path';

// A custom parent-tab title overrides *every* agent row in a split. Clear it
// only after every OMP pane has a distinct native role title. Never inject
// /rename into a running agent during ordinary startup.
export async function revealRoleTitles({ project, config, state, inventory, cli }) {
  const targets = [];
  for (const tab of config.tabs) {
    if (tab.agents.length < 2 || !tab.agents.every(name => state.agents[name]?.agent === 'omp')) continue;
    const saved = tab.agents.map(name => state.agents[name]);
    const tabId = saved[0].tabId;
    const rows = inventory.terminals.filter(row => row.tabId === tabId);
    if (!tabId || saved.some(role => role.tabId !== tabId) || rows.length !== saved.length) {
      throw new Error(`${tab.title}: shared tab identity is unverified`);
    }
    for (const [index, name] of tab.agents.entries()) {
      const matches = rows.filter(row => row.leafId === saved[index].leafId && row.connected && !row.orphaned &&
        sameWorktree(`local::${row.worktreePath}`, project));
      const rawTitle = matches[0]?.title || '';
      const suffix = ` - ${path.posix.basename(project.replaceAll('\\', '/'))}`;
      const title = rawTitle.endsWith(suffix) ? rawTitle.slice(0, -suffix.length) : rawTitle;
      // Accept the native plain name or OMP's decorated /rename title, never
      // a prompt that happens to mention this role or its sibling's name.
      if (matches.length !== 1 || !new RegExp(`(?:^|> |: | - )${name}(?: \\(local retained\\))?$`).test(title)) {
        throw new Error(`${name}: native role title unavailable; shared tab label retained`);
      }
    }
    targets.push({ tabId, handle: rows[0].handle });
  }
  for (const { tabId, handle } of targets) {
    const { rename } = await cli(['terminal', 'rename', '--terminal', handle]);
    if (rename?.handle !== handle || rename.tabId !== tabId || rename.title !== null) {
      throw new Error('Native role titles are unconfirmed; shared tab reset receipt mismatch');
    }
  }
}
