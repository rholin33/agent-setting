import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectFiles, readJson } from './team.mjs';
import { sameWorktree } from './sessions.mjs';

export async function updatePiBeforeStart({ home, project, names, cli, log = console.log,
  run = (command, args) => spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }) }) {
  const files = projectFiles(home, project);
  const catalog = readJson(path.join(home, 'team.json'));
  const piNames = catalog.filter(role => role.agent === 'pi').map(role => role.name);
  if (!piNames.some(name => names.includes(name))) return { updated: false, restarted: [] };

  // 更新全局 Pi 包会替换运行中进程仍需加载的文件；先确认当前项目没有活跃 Pi 会话。
  if (fs.existsSync(files.state)) {
    const state = readJson(files.state);
    const inventory = await cli(['terminal', 'list', '--worktree', `path:${project}`]);
    const active = piNames.filter(name => {
      const saved = state.agents[name];
      return saved?.session && inventory.terminals?.some(row => row.tabId === saved.tabId && row.leafId === saved.leafId &&
        row.connected && !row.orphaned && sameWorktree(`local::${row.worktreePath}`, project));
    });
    if (active.length) {
      log(`Pi update deferred while project roles have live panes: ${active.join(', ')}`);
      return { updated: false, restarted: [] };
    }
  }

  const result = run(process.platform === 'win32' ? 'pi.cmd' : 'pi', ['update', '--all']);
  if (result.error || result.status !== 0) {
    throw new Error(`pi update --all failed: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
  }
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (output.trim()) log(output.trim());
  // Pi 总会打印 "Updated packages"，即使 npm 报告 up to date；仅在包实际变化时重启进程。
  const updated = /(?:^|\n)Updated pi from\b/m.test(output) ||
    /(?:^|\n)(?:added|removed|changed) \d+ packages?\b/m.test(output);
  return { updated, restarted: [] };
}
