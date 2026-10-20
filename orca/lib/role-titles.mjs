import { sameWorktree } from './sessions.mjs';
import path from 'node:path';
import { inspectHealth, provesSession } from './health.mjs';
import { rpc } from './orca.mjs';

// A custom parent-tab title overrides *every* agent row in a split. Clear it
// only after every OMP pane has a distinct native role title. Never inject
// /rename into a running agent during ordinary startup.
export async function revealRoleTitles({ project, config, state, inventory, cli, log = console.log,
  inspect = handle => inspectHealth(cli, rpc, handle, 'omp') }) {
  const targets = [];
  for (const tab of config.tabs) {
    if (tab.agents.length < 2 || !tab.agents.every(name => state.agents[name]?.agent === 'omp')) continue;
    const saved = tab.agents.map(name => state.agents[name]);
    const tabId = saved[0].tabId;
    const rows = inventory.terminals.filter(row => row.tabId === tabId);
    if (!tabId || saved.some(role => role.tabId !== tabId) || rows.length !== saved.length) {
      throw new Error(`${tab.title}: shared tab identity is unverified`);
    }
    let sharedLabelReason = null;
    for (const [index, name] of tab.agents.entries()) {
      const matches = rows.filter(row => row.leafId === saved[index].leafId && row.connected && !row.orphaned &&
        sameWorktree(`local::${row.worktreePath}`, project));
      const rawTitle = matches[0]?.title || '';
      const suffix = ` - ${path.posix.basename(project.replaceAll('\\', '/'))}`;
      const title = rawTitle.endsWith(suffix) ? rawTitle.slice(0, -suffix.length) : rawTitle;
      // Accept the native plain name or OMP's decorated /rename title, never
      // a prompt that happens to mention this role or its sibling's name.
      if (matches.length === 1 && title === 'OMP ready') {
        sharedLabelReason ||= 'OMP ready hides individual idle titles';
        continue;
      }
      if (matches.length !== 1 || !new RegExp(`(?:^|> |: | - )${name}(?: \\(local retained\\))?$`).test(title)) {
        const row = matches[0];
        // A user-named session is not a startup failure. Preserve its title and
        // use the shared role label only after native proof of the saved session.
        const live = matches.length === 1 && saved[index].session?.id ? await inspect(row.handle) : null;
        if (!row?.incarnationId || !row.ptyId || !live || !provesSession(live, saved[index]) ||
            live.terminal?.handle !== row.handle || live.terminal.incarnationId !== row.incarnationId ||
            live.terminal.ptyId !== row.ptyId || live.terminal.executionHostId !== 'local' ||
            !live.terminal.connected || live.terminal.orphaned ||
            !sameWorktree(`local::${live.terminal.worktreePath}`, project)) {
          throw new Error(`${name}: native role title unavailable; shared tab label retained`);
        }
        sharedLabelReason = 'Verified conversation has a custom native title';
      }
    }
    // 空闲时宿主可能显示通用标题；保留明确的组合标签，不把它误报为角色失联。
    targets.push({ tabId, handle: rows[0].handle, title: sharedLabelReason ? tab.agents.join(' · ') : null, reason: sharedLabelReason });
  }
  for (const { tabId, handle, title, reason } of targets) {
    const { rename } = await cli(['terminal', 'rename', '--terminal', handle, ...(title ? ['--title', title] : [])]);
    if (rename?.handle !== handle || rename.tabId !== tabId || rename.title !== title) {
      throw new Error('Native role titles are unconfirmed; shared tab reset receipt mismatch');
    }
    if (title) log(`Warning: ${reason}; using shared tab label ${title}`);
  }
}
