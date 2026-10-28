import fs from 'node:fs';
import path from 'node:path';
import { projectFiles, readJson } from './team.mjs';
import { sameWorktree } from './sessions.mjs';
import { restartRoles } from './restart.mjs';
import { sameAppliedConfig } from './launch-state.mjs';
import { mapLimit, INSPECT_CONCURRENCY } from './platform.mjs';

// Running roles whose applied fingerprint (CLI, model, thinking, role prompt, OMP proxy)
// still matches are reused untouched; only changed roles are stopped and resumed
// with their original conversation. `orca-team restart` forces a restart.
// Shells recover in the start pass.
// Restarts stay sequential because desktop focus is shared between panes.
export async function reloadRunning({ home, project, names, cli, snapshot, inspect, log = console.log, restart = restartRoles, now = Date.now, ompProxyOptions }) {
  const files = projectFiles(home, project);
  if (!fs.existsSync(files.config) || !fs.existsSync(files.state)) return { reloaded: [], skipped: [], current: [] };
  const config = readJson(files.config);
  const state = readJson(files.state);
  const catalog = readJson(path.join(home, 'team.json'));
  const scope = names || config.tabs.flatMap(tab => tab.agents);
  const inventory = await cli(['terminal', 'list', '--worktree', `path:${project}`]);
  const changed = [], current = [];
  for (const name of scope) {
    const saved = state.agents[name];
    const role = catalog.find(item => item.name === name);
    if (!saved?.session || !saved.tabId || saved.pending || !role) continue;
    const rows = (inventory.terminals || []).filter(row =>
      row.tabId === saved.tabId && row.leafId === saved.leafId && sameWorktree(`local::${row.worktreePath}`, project));
    if (rows.length !== 1) continue;
    if (!rows[0].connected || rows[0].orphaned) continue;
    // 指纹未变的角色不检查进程、不重启；窗格里不是 agent 的情况留给启动阶段恢复。
    if (sameAppliedConfig(saved, role, home, ompProxyOptions)) { current.push(name); continue; }
    changed.push({ name, handle: rows[0].handle, agent: saved.agent });
  }
  // 只有真正跑着智能体的窗格才在这里重启；空壳或不可验证的窗格留给启动阶段
  // 按配置恢复，避免刚恢复的角色在同一次命令里被重启两次。检查只读，可并行。
  const kinds = await mapLimit(changed, INSPECT_CONCURRENCY, item => inspect(item.handle, item.agent));
  const stale = changed.filter((_, index) => kinds[index].kind === 'agent').map(item => item.name);
  if (!stale.length) {
    log('No running role to restart');
    return { reloaded: [], skipped: [], current };
  }
  log(`Restarting ${stale.length} running role(s) with current model config: ${stale.join(', ')}`);
  const started = now();
  const { reloaded, failed } = await restart({ home, project, roles: stale, forceExit: true, cli, snapshot, log });
  const skipped = failed;
  for (const item of failed) log(`Warning: ${item.name} not reloaded: ${item.reason}`);
  if (reloaded.length) log(`Reloaded with current model config (${Math.round((now() - started) / 1000)}s): ${reloaded.join(', ')}`);
  return { reloaded, skipped, current };
}
