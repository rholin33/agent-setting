import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// 本机项目的终端只会在本机执行主机上；Orca 列表省略已配对远端 runtime（runtime:<id>）不影响本机清单的完整性，
// 省略其他主机（如 SSH 目标）则仍视为不完整。
export function omitsOnlyPairedRuntimes(hostScope) {
  return Array.isArray(hostScope?.omittedHostIds) && hostScope.omittedHostIds.every(id => typeof id === 'string' && id.startsWith('runtime:'));
}

export function completeLocalInventory(inventory) {
  return Array.isArray(inventory?.terminals) && inventory.truncated === false && inventory.totalCount === inventory.terminals.length &&
    inventory.hostScope?.hostIds?.length === 1 && inventory.hostScope.hostIds[0] === 'local' && omitsOnlyPairedRuntimes(inventory.hostScope);
}

export function dataDirectory(platform = process.platform, env = process.env, home = os.homedir()) {
  if (env.ORCA_TEAM_DATA_DIR) return env.ORCA_TEAM_DATA_DIR;
  if (platform === 'win32') return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), 'orca');
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'orca');
  return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), 'orca');
}
export function normalizeProject(value, platform = process.platform) {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const resolved = api.resolve(value).replaceAll('\\', '/');
  return resolved.length > api.parse(resolved).root.length ? resolved.replace(/\/$/, '') : resolved;
}
export function projectKey(project, platform = process.platform) {
  const normalized = normalizeProject(project, platform);
  return createHash('sha256').update(platform === 'win32' ? normalized.toLowerCase() : normalized).digest('hex').slice(0, 16);
}
export function quote(value, platform = process.platform) {
  return platform === 'win32' ? "'" + value.replaceAll("'", "''") + "'" : "'" + value.replaceAll("'", "'\\''") + "'";
}
export function nodeCommand(args, platform = process.platform, executable = process.execPath) {
  const command = [executable, ...args].map(value => quote(value, platform)).join(' ');
  // Orca Windows terminals use PowerShell; encoded scripts avoid nested command quoting.
  return platform === 'win32' ? 'powershell.exe -NoLogo -NoProfile -EncodedCommand ' + Buffer.from('& ' + command, 'utf16le').toString('base64') : command;
}

// 进程启动时间（毫秒）；查询失败或进程不存在时返回 null，由调用方按"无法证明"处理。
export function processStartTime(pid, platform = process.platform, run = execFileSync) {
  try {
    if (platform === 'win32') {
      const script = `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`;
      return Date.parse(run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()) || null;
    }
    return Date.parse(run('/bin/ps', ['-o', 'lstart=', '-p', String(Number(pid))], { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim()) || null;
  } catch { return null; }
}

// 进程检查的并发上限：Windows 的 CIM 查询并发过高会失败，取更保守的值。
export const INSPECT_CONCURRENCY = process.platform === 'win32' ? 2 : 4;
// 按固定并发执行，结果保持输入顺序；任一任务失败即整体失败，语义与串行一致。
export async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const index = next++; results[index] = await task(items[index], index); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Windows 的 Python 启动器通常是 python，POSIX 上是 python3；ORCA_PYTHON 可覆盖。
export function pythonCommand(platform = process.platform, env = process.env) {
  return env.ORCA_PYTHON || (platform === 'win32' ? 'python' : 'python3');
}
