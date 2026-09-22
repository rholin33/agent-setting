import fs from 'node:fs';
import path from 'node:path';
import { projectFiles, readJson } from './team.mjs';
import { sameWorktree } from './sessions.mjs';
import { restartRoles } from './restart.mjs';

export function desiredModelOf(role) {
  return { agent: role.agent, model: role.model, thinking: role.thinking ?? null };
}
export function sameAppliedConfig(saved, role) {
  const applied = saved.appliedModel;
  if (!applied) return false;
  const desired = desiredModelOf(role);
  return applied.agent === desired.agent && applied.model === desired.model &&
    (applied.thinking ?? null) === desired.thinking;
}

// Reload semantics: roles already running the current model configuration are
// kept as-is; only roles whose applied configuration differs (or is unknown)
// restart, concurrently, and resume their exact conversations. Busy, timed-out
// or unverifiable roles are skipped with a warning so no in-flight work is
// lost; absent panes are left to runTeam start.
export async function reloadRunning({ home, project, names, cli, snapshot, log = console.log, restart = restartRoles, now = Date.now }) {
  const files = projectFiles(home, project);
  if (!fs.existsSync(files.config) || !fs.existsSync(files.state)) return { reloaded: [], skipped: [], current: [] };
  const config = readJson(files.config);
  const state = readJson(files.state);
  const catalog = readJson(path.join(home, 'team.json'));
  const scope = names || config.tabs.flatMap(tab => tab.agents);
  let inventory;
  try { inventory = await cli(['terminal', 'list', '--worktree', `path:${project}`]); }
  catch { return { reloaded: [], skipped: [], current: [] }; }
  const stale = [], current = [];
  for (const name of scope) {
    const saved = state.agents[name];
    const role = catalog.find(item => item.name === name);
    if (!saved?.session || !saved.tabId || saved.pending || !role) continue;
    const rows = (inventory.terminals || []).filter(row =>
      row.tabId === saved.tabId && row.leafId === saved.leafId && sameWorktree(`local::${row.worktreePath}`, project));
    if (rows.length !== 1) continue;
    if (sameAppliedConfig(saved, role)) current.push(name);
    else stale.push(name);
  }
  if (!stale.length) {
    if (current.length) log(`Model config unchanged; ${current.length} running role(s) kept as-is`);
    return { reloaded: [], skipped: [], current };
  }
  const started = now();
  const { reloaded, failed } = await restart({ home, project, roles: stale, cli, snapshot, log });
  const skipped = failed;
  for (const item of failed) log(`Warning: ${item.name} not reloaded: ${item.reason}`);
  if (reloaded.length) log(`Reloaded with current model config in parallel (${Math.round((now() - started) / 1000)}s): ${reloaded.join(', ')}`);
  if (current.length) log(`Model config unchanged; kept as-is: ${current.join(', ')}`);
  return { reloaded, skipped, current };
}
