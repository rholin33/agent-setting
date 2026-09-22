import path from 'node:path';
import { projectFiles, readJson, saveJson, withLock, validateConfig } from './team.mjs';
import { validateTranscript, sameWorktree, binding } from './sessions.mjs';
import { captureSession } from './launch-state.mjs';
import { inspectHealth, recoverInPane } from './health.mjs';
import { nodeCommand } from './platform.mjs';
import { rpc } from './orca.mjs';

export function appliedModelOf(catalogRole) {
  return { agent: catalogRole.agent, model: catalogRole.model, thinking: catalogRole.thinking ?? null };
}

// Core assumes the caller holds the project lock and owns `state`; multiple
// roles may run it concurrently because every mutation targets its own agent
// record and checkpoints serialize synchronously.
async function restartCore({ home, project, role, cli, snapshot, state, checkpoint,
  inspect = (handle, provider) => inspectHealth(cli, rpc, handle, provider),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = console.log }) {
  const files = projectFiles(home, project);
  const config = readJson(files.config);
  if (state.workspace !== project || config.workspace !== project) throw new Error('Project state path mismatch');
  const catalog = readJson(path.join(home, 'team.json'));
  if (!validateConfig(config, catalog).includes(role)) throw new Error(`Unknown project role: ${role}`);
  const saved = state.agents[role];
  if (!saved) throw new Error(`${role}: run orca-team first`);
  validateTranscript(saved, project);
  const catalogRole = catalog.find(item => item.name === role);
  if (!catalogRole) throw new Error(`Unknown role catalog entry: ${role}`);
  saved.model = catalogRole.model;
  saved.thinking = catalogRole.thinking;
  saved.agent = catalogRole.agent;
  const rows = (await cli(['terminal', 'list', '--worktree', `path:${project}`])).terminals.filter(row =>
    row.tabId === saved.tabId && row.leafId === saved.leafId && sameWorktree(`local::${row.worktreePath}`, project));
  if (rows.length !== 1 || !rows[0].connected || rows[0].orphaned) throw new Error(`${role}: pane unavailable; run orca-team to recover layout first`);
  const handle = rows[0].handle;
  let live = await inspect(handle, saved.agent);
  if (saved.pending) throw new Error(`${role}: launch pending; run orca-team to reconcile first`);
  if (live.kind === 'agent') {
    if (!captureSession(saved, live, project, binding(await snapshot(), saved, project))) throw new Error(`${role}: live conversation is unverified`);
    if (saved.restartIntent) throw new Error(`${role}: previous exit is unconfirmed; no second exit sent`);
    const idle = await cli(['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', '1000']);
    if (!idle.wait?.satisfied) throw new Error(`${role}: agent is busy; retry after its turn completes`);
    await cli(['terminal', 'read', '--terminal', handle, '--limit', '2000']);
    const current = await inspect(handle, saved.agent);
    if (current.kind !== 'agent' || current.terminal.incarnationId !== live.terminal.incarnationId ||
        !captureSession(saved, current, project, binding(await snapshot(), saved, project))) throw new Error(`${role}: process changed before exit`);
    saved.restartIntent = { sessionId: saved.session.id, createdAt: new Date().toISOString() };
    checkpoint();
    const receipt = await cli(['terminal', 'send', '--terminal', handle, '--text', '/quit', '--enter']);
    if (receipt.send?.accepted !== true) throw new Error(`${role}: exit unconfirmed; restart intent retained`);
    for (let attempt = 0; attempt < 30; attempt++) {
      live = await inspect(handle, saved.agent);
      if (live.terminal.incarnationId !== current.terminal.incarnationId) throw new Error(`${role}: pane changed during exit`);
      if (live.kind === 'shell') break;
      await sleep(500);
    }
  }
  if (live.kind !== 'shell') throw new Error(`${role}: exit not verified; no resume sent`);
  const command = nodeCommand([path.join(home, 'bin', 'orca-team.mjs'), 'launch', '--home', home, '--project', project, '--role', role, '--resume']);
  await recoverInPane({ name: role, saved, handle, command, cli, inspect, checkpoint, verifyBinding: async () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      if (captureSession(saved, await inspect(handle, saved.agent), project, binding(await snapshot(), saved, project))) return;
      await sleep(500);
    }
    throw new Error(`${role}: original conversation recovery unconfirmed; rerun orca-team`);
  } });
  delete saved.restartIntent;
  saved.appliedModel = appliedModelOf(catalogRole);
  checkpoint();
  log(`${role}: restarted in original pane; original conversation verified`);
}

export async function restartRole(options) {
  const files = projectFiles(options.home, options.project);
  return withLock(files.lock, async () => {
    const state = readJson(files.state);
    await restartCore({ ...options, state, checkpoint: () => saveJson(files.state, state) });
    return state;
  });
}

// Restart several roles concurrently under one lock. Busy, timed-out or
// unverifiable roles fail independently and never cancel their siblings.
export async function restartRoles({ roles, ...options }) {
  const files = projectFiles(options.home, options.project);
  return withLock(files.lock, async () => {
    const state = readJson(files.state);
    const checkpoint = () => saveJson(files.state, state);
    const settled = await Promise.allSettled(roles.map(role =>
      restartCore({ ...options, role, state, checkpoint })));
    saveJson(files.state, state);
    const reloaded = [], failed = [];
    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') reloaded.push(roles[index]);
      else failed.push({ name: roles[index], reason: result.reason?.message || String(result.reason) });
    });
    return { reloaded, failed };
  });
}
