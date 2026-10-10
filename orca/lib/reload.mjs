import fs from 'node:fs';
import path from 'node:path';
import { projectFiles, readJson } from './team.mjs';
import { sameWorktree } from './sessions.mjs';
import { restartRoles } from './restart.mjs';

// Reuse roles whose applied configuration matches. Unknown or changed configs
// restart with their original conversation; shells recover in the start pass.
// Restarts stay sequential because desktop focus is shared between panes.
export async function reloadRunning({ home, project, names, cli, snapshot, inspect, log = console.log, restart = restartRoles, now = Date.now }) {
  const files = projectFiles(home, project);
  if (!fs.existsSync(files.config) || !fs.existsSync(files.state)) return { reloaded: [], skipped: [], current: [] };
  const config = readJson(files.config);
  const state = readJson(files.state);
  const catalog = readJson(path.join(home, 'team.json'));
  const scope = names || config.tabs.flatMap(tab => tab.agents);
  const inventory = await cli(['terminal', 'list', '--worktree', `path:${project}`]);
  const stale = [], current = [];
  for (const name of scope) {
    const saved = state.agents[name];
    const role = catalog.find(item => item.name === name);
    if (!saved?.session || !saved.tabId || saved.pending || !role) continue;
    const rows = (inventory.terminals || []).filter(row =>
      row.tabId === saved.tabId && row.leafId === saved.leafId && sameWorktree(`local::${row.worktreePath}`, project));
    if (rows.length !== 1) continue;
    if (!rows[0].connected || rows[0].orphaned) continue;
    const applied = saved.appliedModel;
    if (!saved.restartIntent && applied?.agent === role.agent && applied.model === role.model &&
        (applied.thinking ?? null) === (role.thinking ?? null)) {
      current.push(name);
      continue;
    }
    // 只有真正跑着智能体的窗格才在这里重启；空壳或不可验证的窗格留给启动阶段
    // 按配置恢复，避免刚恢复的角色在同一次命令里被重启两次。
    const live = await inspect(rows[0].handle, saved.agent);
    if (live.kind !== 'agent') continue;
    stale.push(name);
  }
  if (!stale.length) {
    log('No running role to restart');
    return { reloaded: [], skipped: [], current };
  }
  log(`Restarting ${stale.length} running role(s) with current model config: ${stale.join(', ')}`);
  const started = now();
  const { reloaded, failed } = await restart({ home, project, roles: stale, cli, snapshot, log });
  const skipped = failed;
  for (const item of failed) log(`Warning: ${item.name} not reloaded: ${item.reason}`);
  if (reloaded.length) log(`Reloaded with current model config (${Math.round((now() - started) / 1000)}s): ${reloaded.join(', ')}`);
  return { reloaded, skipped, current };
}
