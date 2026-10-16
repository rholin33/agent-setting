import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { nodeCommand, normalizeProject } from './platform.mjs';
import { readJson, saveJson, withLock } from './team.mjs';
import { verifyClaudeBinding } from './claude-binding.mjs';
import { inspectHealth } from './health.mjs';
import { rpc } from './orca.mjs';

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

// Presentation is local; task/session ownership remains the existing remote endpoint.
export async function ensureClaudeLocalTerminal({ home, project, config: file, endpoint, cli,
  verify = verifyClaudeBinding, inspect = handle => inspectHealth(cli, rpc, handle, 'claude'),
  attempts = 40, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
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
    const reconnectFile = path.join(directory, 'local-reconnect.json');
    let reconnect = fs.existsSync(reconnectFile) ? readJson(reconnectFile) : undefined;
    const matches = status => status?.localPane === pane && status.project === config.project &&
      status.role === config.role && status.runtimeId === config.runtimeId && isDeepStrictEqual(status.remote, endpoint);
    const reconnectMatches = () => reconnect?.local?.handle === terminal.handle &&
      reconnect.local.incarnationId === terminal.incarnationId && reconnect.project === project &&
      isDeepStrictEqual(reconnect.remote, endpoint);
    const readStatus = () => {
      const statusFile = path.join(directory, 'local-terminal-status.json');
      return fs.existsSync(statusFile) ? readJson(statusFile) : null;
    };
    const ready = status => processAlive(status?.pid) && status.state === 'connected' && matches(status) &&
      Date.now() - Date.parse(status.updatedAt) >= 0 && Date.now() - Date.parse(status.updatedAt) < 25000;
    const emptyShell = async () => {
      const live = await inspect(terminal.handle);
      if (live.kind !== 'shell' || live.terminal?.handle !== terminal.handle ||
          live.terminal.incarnationId !== terminal.incarnationId || live.terminal.ptyId !== terminal.ptyId ||
          live.terminal.executionHostId !== 'local' || normalizeProject(live.terminal.worktreePath) !== project ||
          !live.terminal.connected || live.terminal.orphaned) throw new Error('Local Claude reconnect requires the original verified idle shell');
      const screen = (await cli(['terminal', 'read', '--terminal', terminal.handle, '--screen', '--limit', '2000'])).terminal;
      const last = (screen?.tail || []).filter(line => line.trim()).at(-1)?.trim() || '';
      const empty = last.startsWith('PS ') ? /^PS [^>\r\n]+>$/.test(last) : /^(?:[^\s]*[$#%>]|➜ \S+ [✗✔])$/.test(last);
      if (screen?.source !== 'screen' || !empty) {
        throw new Error('Local Claude reconnect requires an empty shell prompt; draft retained');
      }
    };
    const previous = readStatus();
    // Restart only the presentation transport, never the remote Claude process.
    // A durable nonce links a once-only send to the new client's heartbeat.
    if (saved && !ready(previous) && matches(previous) && Number.isSafeInteger(previous.pid) && previous.pid > 0 && !processAlive(previous.pid)) {
      if (reconnect && (reconnect.status !== 'connected' || !reconnectMatches() ||
          previous.connectionId !== reconnect.id)) throw new Error('Local Claude reconnect uncertain; reconcile before retrying');
      await emptyShell();
      await verify({ config: file, endpoint, project, cli });
      await emptyShell();
      if (!isDeepStrictEqual(previous, readStatus())) throw new Error('Local Claude client status changed before reconnect');
      if (reconnect) fs.copyFileSync(reconnectFile, `${reconnectFile}.previous-${randomUUID()}`, fs.constants.COPYFILE_EXCL);
      reconnect = { version: 1, id: randomUUID(), status: 'starting', project, remote: endpoint,
        local: terminal, previous, at: new Date().toISOString() };
      const command = nodeCommand([path.join(home, 'bin', 'claude-remote-terminal.mjs'), '--config', path.resolve(file), '--connection-id', reconnect.id]);
      saveJson(reconnectFile, reconnect);
      const sent = await cli(['terminal', 'send', '--terminal', terminal.handle, '--text', command, '--enter']);
      if (sent.send?.accepted !== true) throw new Error('Local Claude reconnect input uncertain; do not resend');
    }
    for (let i = 0; i < attempts; i++) {
      const status = readStatus();
      if (ready(status)) {
        if (reconnect?.status === 'starting') {
          if (!reconnectMatches() || status.connectionId !== reconnect.id) throw new Error('Local Claude reconnect client identity unconfirmed');
          reconnect.status = 'connected'; reconnect.verifiedAt = new Date().toISOString();
          saveJson(reconnectFile, reconnect);
        }
        return terminal;
      }
      if (i + 1 < attempts) await delay(500);
    }
    throw new Error('Local Claude connection unconfirmed; retain pane and remote history, do not create another session');
  });
}
