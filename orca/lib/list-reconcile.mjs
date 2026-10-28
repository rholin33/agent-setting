import fs from 'node:fs';
import path from 'node:path';
import { completeLocalInventory } from './platform.mjs';
import { sameWorktree } from './sessions.mjs';
import { projectFiles, readJson, saveJson, withLock } from './team.mjs';

export async function reconcileTerminalList({ project, config, state, protectedHandles = [], cli, audit }) {
  const list = async () => {
    const inventory = await cli(['terminal', 'list', '--worktree', `path:${project}`]);
    if (!completeLocalInventory(inventory) || inventory.terminals.some(t =>
      t.executionHostId !== 'local' || !sameWorktree(`local::${t.worktreePath}`, project))) {
      throw new Error('Complete local project inventory required for list reconciliation');
    }
    return inventory.terminals;
  };
  const rows = await list(), keep = new Set(protectedHandles);
  for (const name of config.tabs.flatMap(tab => tab.agents)) {
    const saved = state.agents[name];
    const matches = rows.filter(t => t.tabId === saved?.tabId && t.leafId === saved?.leafId && t.connected && !t.orphaned);
    if (matches.length !== 1 || saved.pending) throw new Error(`${name}: configured pane unconfirmed; no list cleanup`);
    keep.add(matches[0].handle);
  }
  const extras = rows.filter(t => !keep.has(t.handle));
  const record = { project, at: new Date().toISOString(), status: 'planned', kept: [...keep], extras, closed: [] };
  await audit(structuredClone(record));
  for (const target of extras) {
    const current = (await cli(['terminal', 'show', '--terminal', target.handle])).terminal;
    if (!current || ['handle', 'incarnationId', 'tabId', 'leafId', 'worktreePath', 'executionHostId'].some(k => current[k] !== target[k])) {
      throw new Error(`${target.handle}: terminal identity changed during reconciliation`);
    }
    await cli(['terminal', 'close', '--terminal', target.handle]);
    record.closed.push(target.handle);
    await audit(structuredClone(record));
  }
  const after = await list();
  if (after.some(t => !keep.has(t.handle)) || rows.filter(t => keep.has(t.handle)).some(t => !after.some(a => a.handle === t.handle && a.incarnationId === t.incarnationId))) {
    throw new Error('Terminal list reconciliation unconfirmed: extras remain or retained panes changed');
  }
  record.status = 'completed'; await audit(record);
  return record;
}

// Read only binding records, never titles: remote transports and original return
// panes remain valid even when the owner is on another machine.
function collectBindings(value, handles, panes) {
  if (!value || typeof value !== 'object') return;
  for (const item of Object.values(value)) {
    if (typeof item === 'string' && /^term_[\w-]+$/.test(item)) handles.add(item);
    else if (item && typeof item === 'object') collectBindings(item, handles, panes);
  }
  if (value.tabId && value.leafId) panes.add(`${value.tabId}:${value.leafId}`);
}
function readBindings(directory, handles, panes) {
  if (!fs.existsSync(directory)) return;
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) readBindings(file, handles, panes);
    else if (item.isFile() && item.name.endsWith('.json')) collectBindings(readJson(file), handles, panes);
  }
}
export async function reconcileProjectList({ home, project, cli, log = console.log }) {
  const files = projectFiles(home, project);
  return withLock(files.lock, async () => {
    const config = readJson(files.config), state = readJson(files.state);
    const remoteFile = path.join(files.directory, 'remote-switches.json');
    const remote = fs.existsSync(remoteFile) ? readJson(remoteFile) : { roles: {} };
    if (Object.values(remote.roles).some(r => r.pending)) throw new Error('Pending remote handoff prevents list reconciliation');
    const handles = new Set(), panes = new Set();
    collectBindings(remote, handles, panes);
    readBindings(path.join(files.directory, 'claude-runtime'), handles, panes);
    readBindings(path.join(home, 'remote-master', 'runtime'), handles, panes);
    const inventory = await cli(['terminal', 'list', '--worktree', `path:${project}`]);
    if (!completeLocalInventory(inventory)) throw new Error('Complete inventory required');
    const absentReturns = Object.entries(remote.roles).filter(([name, entry]) => entry.runtime &&
      !inventory.terminals.some(t => t.tabId === state.agents[name]?.tabId && t.leafId === state.agents[name]?.leafId));
    if (absentReturns.length) {
      log(`Terminal list cleanup deferred: original local return panes absent for ${absentReturns.map(([name]) => name).join(', ')}; all live terminals retained.`);
      return { status: 'deferred', closed: [] };
    }
    for (const t of inventory.terminals) if (panes.has(`${t.tabId}:${t.leafId}`)) handles.add(t.handle);
    const directory = path.join(files.directory, 'list-reconciliation');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${Date.now()}-${process.pid}.json`);
    const result = await reconcileTerminalList({ project, config, state, protectedHandles: [...handles], cli,
      audit: record => saveJson(file, record) });
    log(`Verified team list: removed ${result.closed.length} extra terminal(s); configured roles and remote bindings retained.`);
    return result;
  });
}
