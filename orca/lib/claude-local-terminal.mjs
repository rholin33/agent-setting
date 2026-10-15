import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { nodeCommand, normalizeProject } from './platform.mjs';
import { readJson, saveJson, withLock } from './team.mjs';
import { verifyClaudeBinding } from './claude-binding.mjs';

// Presentation is local; task/session ownership remains the existing remote endpoint.
export async function ensureClaudeLocalTerminal({ home, project, config: file, endpoint, cli,
  verify = verifyClaudeBinding, attempts = 40, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const config = readJson(file);
  project = normalizeProject(project);
  if (config.version !== 1 || normalizeProject(config.project) !== project || config.role !== endpoint.role ||
      !isDeepStrictEqual(config.endpoint, endpoint)) throw new Error('Claude local presentation scope changed');
  await verify({ config: file, endpoint, project, cli });
  const directory = path.dirname(file), receipt = path.join(directory, 'local-terminal.json');
  return withLock(path.join(directory, 'local-terminal.lock'), async () => {
    const inventory = (await cli(['terminal', 'list', '--worktree', `path:${project}`])).terminals;
    if (!Array.isArray(inventory)) throw new Error('Local terminal inventory unavailable');
    let saved = fs.existsSync(receipt) ? readJson(receipt) : undefined;
    if (saved && (saved.status !== 'created' || !saved.terminal?.handle)) throw new Error('Local terminal creation uncertain; reconcile before retrying');
    let terminal = saved && inventory.find(t => t.handle === saved.terminal.handle);
    if (terminal && (terminal.incarnationId !== saved.terminal.incarnationId || terminal.executionHostId !== 'local' ||
        normalizeProject(terminal.worktreePath) !== project || !terminal.connected || terminal.orphaned)) {
      throw new Error('Bound local presentation terminal changed; original remote session retained');
    }
    if (!terminal) {
      // Absence comes only from a successful scoped inventory, never a failed query.
      if (saved) fs.copyFileSync(receipt, `${receipt}.previous-${Date.now()}`, fs.constants.COPYFILE_EXCL);
      saveJson(receipt, { version: 1, status: 'starting', role: config.role, project, remote: endpoint, at: new Date().toISOString() });
      const command = nodeCommand([path.join(home, 'bin', 'claude-remote-terminal.mjs'), '--config', path.resolve(file)]);
      const created = await cli(['terminal', 'create', '--worktree', `path:${project}`, '--title', `${config.role} · Claude Opus · remote`, '--command', command]);
      if (!created.terminal?.handle || !created.terminal.incarnationId || created.terminal.executionHostId !== 'local') {
        throw new Error('Local terminal creation uncertain; inspect existing panes before retrying');
      }
      terminal = created.terminal;
      saveJson(receipt, { version: 1, status: 'created', role: config.role, project, remote: endpoint, terminal, at: new Date().toISOString() });
    }
    const pane = terminal.paneKey || `${terminal.tabId}:${terminal.leafId}`;
    for (let i = 0; i < attempts; i++) {
      const statusFile = path.join(directory, 'local-terminal-status.json');
      const status = fs.existsSync(statusFile) ? readJson(statusFile) : null;
      let alive = false;
      if (Number.isSafeInteger(status?.pid) && status.pid > 0) { try { process.kill(status.pid, 0); alive = true; } catch {} }
      if (alive && status.state === 'connected' && status.localPane === pane && status.project === config.project &&
          status.role === config.role && status.runtimeId === config.runtimeId && isDeepStrictEqual(status.remote, endpoint) &&
          Date.now() - Date.parse(status.updatedAt) >= 0 && Date.now() - Date.parse(status.updatedAt) < 25000) return terminal;
      if (i + 1 < attempts) await delay(500);
    }
    throw new Error('Local Claude connection unconfirmed; retain pane and remote history, do not create another session');
  });
}
