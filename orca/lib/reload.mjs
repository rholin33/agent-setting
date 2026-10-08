import fs from 'node:fs';
import path from 'node:path';
import { projectFiles, readJson } from './team.mjs';
import { sameWorktree } from './sessions.mjs';
import { restartRoles } from './restart.mjs';

// 统一命令语义：运行中的角色一律按当前配置重启（保留原会话），无论之前应用过什么配置，
// 这样 Orca 重启后由 Orca 自己恢复的窗格也会回到配置状态。并发重启；忙碌、超时或无法
// 验证的角色只告警不计为已重启，不会丢失进行中的工作；没有运行的角色留给 runTeam 启动或恢复。
export async function reloadRunning({ home, project, names, cli, snapshot, inspect, log = console.log, restart = restartRoles, now = Date.now }) {
  const files = projectFiles(home, project);
  if (!fs.existsSync(files.config) || !fs.existsSync(files.state)) return { reloaded: [], skipped: [], current: [] };
  const config = readJson(files.config);
  const state = readJson(files.state);
  const catalog = readJson(path.join(home, 'team.json'));
  const scope = names || config.tabs.flatMap(tab => tab.agents);
  const inventory = await cli(['terminal', 'list', '--worktree', `path:${project}`]);
  const stale = [];
  for (const name of scope) {
    const saved = state.agents[name];
    const role = catalog.find(item => item.name === name);
    if (!saved?.session || !saved.tabId || saved.pending || !role) continue;
    const rows = (inventory.terminals || []).filter(row =>
      row.tabId === saved.tabId && row.leafId === saved.leafId && sameWorktree(`local::${row.worktreePath}`, project));
    if (rows.length !== 1) continue;
    // 只有真正跑着智能体的窗格才在这里重启；空壳或不可验证的窗格留给启动阶段
    // 按配置恢复，避免刚恢复的角色在同一次命令里被重启两次。
    const live = await inspect(rows[0].handle, saved.agent);
    if (live.kind !== 'agent') continue;
    stale.push(name);
  }
  if (!stale.length) {
    log('No running role to restart');
    return { reloaded: [], skipped: [], current: [] };
  }
  log(`Restarting ${stale.length} running role(s) with current model config: ${stale.join(', ')}`);
  const started = now();
  const { reloaded, failed } = await restart({ home, project, roles: stale, cli, snapshot, log });
  const skipped = failed;
  for (const item of failed) log(`Warning: ${item.name} not reloaded: ${item.reason}`);
  if (reloaded.length) log(`Reloaded with current model config in parallel (${Math.round((now() - started) / 1000)}s): ${reloaded.join(', ')}`);
  return { reloaded, skipped, current: [] };
}
