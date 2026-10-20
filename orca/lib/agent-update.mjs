import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ompExecutable } from './omp.mjs';
import { windowsProcesses } from './windows-health.mjs';

const packages = { codex: '@openai/codex', pi: '@earendil-works/pi-coding-agent' };
// 只读版本检查的超时；离线时不能拖住启动。
const CHECK_TIMEOUT_MS = 20000;
const execute = promisify(execFile);

export async function processInventory() {
  if (process.platform === 'win32') return windowsProcesses();
  // macOS 的 comm 会截断到 16 个字符，进程名改取完整命令行里的可执行文件名。
  const { stdout } = await execute('ps', ['-axww', '-o', 'args='], { maxBuffer: 16 * 1024 * 1024 });
  return parseProcessRows(stdout);
}
export function parseProcessRows(stdout) {
  return stdout.split('\n').filter(line => line.trim()).map(line => ({ Name: path.basename(line.trim().split(/\s+/)[0]), CommandLine: line.trim() }));
}

// omp 在 macOS/Linux 上由 bun 运行，进程名是 bun；它的 worker 也跑在 @oh-my-pi 包里。
const OMP_COMMAND = /(?:^|[\\/\s])bun(?:\.exe)?\s+\S*[\\/]omp(?:\s|$)|@oh-my-pi[\\/]pi-coding-agent[\\/]dist[\\/]cli\.js/i;
// npm 安装的 codex：node 包装脚本加 vendor 原生二进制；Codex 桌面端自带的 app-server 守护进程不是 npm 安装，排除。
const CODEX_COMMAND = /[\\/]bin[\\/]codex(?:\.js)?(?:\s|$)|@openai[\\/]codex[\\/]/i;
const PI_COMMAND = /(?:^|[\\/\s])node(?:\.exe)?\s+\S*[\\/]bin[\\/]pi(?:\s|$)|pi-coding-agent[\\/]dist[\\/](?:bundle[\\/])?cli\.js/i;
export function active(rows, agent) {
  return rows.some(row => {
    const name = row.Name || '', command = row.CommandLine || '';
    if (agent === 'omp') return /(?:^|[\\/])omp(?:\.exe)?$/i.test(name) || OMP_COMMAND.test(command);
    if (agent === 'codex') return !/app-server-daemon[\\/]releases/i.test(command) && (/^codex(?:\.exe)?$/i.test(name) || CODEX_COMMAND.test(command));
    return !/@oh-my-pi[\\/]/i.test(command) && PI_COMMAND.test(command);
  });
}

export async function runUpdateCommand(command, args) {
  // Only fixed command templates reach cmd.exe; never interpolate project paths.
  if (command === 'omp' && ['update', 'update --plugins', 'update --check'].includes(args.join(' '))) {
 try { return {status:0,...await execute(ompExecutable(),args,{windowsHide:true,maxBuffer:16*1024*1024,timeout:args.includes('--check')?CHECK_TIMEOUT_MS:0})}; }
 catch(error) {return {status:error.code || 1,stderr:error.stderr || error.message};}
 }
 const allowed = command === 'npm' && (args.join(' ') === 'list --global --depth=0 --json' ||
    args[0] === 'view' && Object.values(packages).includes(args[1]) && args.slice(2).join(' ') === 'version --json' ||
    args.slice(0, 2).join(' ') === 'install --global' && /^(@openai\/codex|@earendil-works\/pi-coding-agent)@\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(args[2]) && args.length === 3) ||
    command === 'pi' && args.join(' ') === 'update --extensions';
  if (!allowed) throw new Error('Unexpected update command');
  try {
    const executable = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : command;
    const argv = process.platform === 'win32' ? ['/d', '/s', '/c', `${command}.cmd ${args.join(' ')}`] : args;
    const readOnly = ['list', 'view'].includes(args[0]);
    const result = await execute(executable, argv, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: readOnly ? CHECK_TIMEOUT_MS : 0 });
    return { status: 0, ...result };
  } catch (error) { return { status: error.code || 1, stderr: error.stderr || error.message }; }
}

export async function updateAgentsBeforeStart({ agents, processes = processInventory, run = runUpdateCommand, log = console.log, lifecycle, syncConfigs }) {
  if (syncConfigs) await syncConfigs();
  const result = { updated: [], deferred: [], warnings: [] };
  const names = [...new Set(agents)].filter(name => packages[name] || name === 'omp');
  const warn = message => { result.warnings.push(message); log(`Warning: ${message}; continuing startup`); };
  const defer = name => { if (!result.deferred.includes(name)) result.deferred.push(name); log(`Update deferred: ${name} has a running process`); };
  let inventory;
  try { inventory = await processes(); }
  catch (error) { result.deferred.push(...names); warn(`Agent update skipped: ${error.message}`); return result; }
  let installed;
  const checked = async (command, args) => {
    const reply = await run(command, args);
    if (reply.error || reply.status !== 0) throw new Error(reply.error?.message || reply.stderr?.trim() || `exit ${reply.status}`);
    return reply.stdout || '';
  };
  for (const name of names) {
    let stopped = [];
    if (!lifecycle && active(inventory, name)) { defer(name); continue; }
    try {
      if (name === 'omp') {
        if (lifecycle) stopped = await lifecycle.stop(name);
        else if (active(await processes(), name)) { defer(name); continue; }
        log('Checking OMP program updates…');
        const programOutput = await checked('omp', ['update']);
        if (programOutput.trim()) log(programOutput.trim());
        log('Updating OMP plugin packages…');
        const pluginOutput = await checked('omp', ['update', '--plugins']);
        if (pluginOutput.trim()) log(pluginOutput.trim());
        result.updated.push(name);
        log('OMP program and plugin update completed successfully');
        continue;
      }
 installed ??= JSON.parse(await checked('npm', ['list', '--global', '--depth=0', '--json']));
      const current = installed.dependencies?.[packages[name]]?.version;
      if (!current) throw new Error(`${name} is not an npm global installation; update skipped`);
      const latest = JSON.parse(await checked('npm', ['view', packages[name], 'version', '--json']));
      if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(latest)) throw new Error(`Invalid ${name} registry version`);
      const requiresUpdate = latest !== current || name === 'pi';
      if (requiresUpdate && (lifecycle || active(await processes(), name))) {
        if (!lifecycle) { defer(name); continue; }
        stopped = await lifecycle.stop(name);
      }
      if (latest !== current) {
        if (!lifecycle && active(await processes(), name)) { defer(name); continue; }
        log(`Updating ${name}: ${current} → ${latest}`);
        await checked('npm', ['install', '--global', `${packages[name]}@${latest}`]);
        log(`${name}: program update completed successfully (${latest})`);
        result.updated.push(name);
      } else log(`${name}: latest installed (${current})`);
      if (name === 'pi') {
        if (!lifecycle && active(await processes(), name)) { defer(name); continue; }
        log('Updating Pi extension packages…');
        const output = await checked('pi', ['update', '--extensions']);
        if (output.trim()) log(output.trim());
        log('Pi extension update completed successfully');
      }
    } catch (error) {
      if (/partial shutdown recovery failed/.test(error.message)) throw error;
      warn(`${name} update failed: ${error.message}`);
    }
    finally {
      if (stopped.length) {
        try { await lifecycle.resume(stopped); }
        catch (error) { throw new Error(`${name}: session recovery after update failed: ${error.message}`, { cause: error }); }
      }
    }
  }
  return result;
}

// 版本检查每 24 小时最多联网一次，结果缓存在 agent-update-check.json。
const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
export async function checkAgentUpdates({ home, agents, run = runUpdateCommand, log = console.log, now = Date.now, ttlMs = UPDATE_CHECK_TTL_MS }) {
  const file = path.join(home, 'agent-update-check.json');
  const names = [...new Set(agents)].filter(name => packages[name] || name === 'omp').sort();
  let cache = null;
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 没有缓存时联网检查 */ }
  const fresh = cache && now() - Date.parse(cache.checkedAt) < ttlMs && names.every(name => name in (cache.agents || {}));
  if (!fresh) {
    const latestOf = async name => {
      if (name === 'omp') {
        const reply = await run('omp', ['update', '--check']);
        if (reply.status !== 0) throw new Error(reply.stderr?.trim() || `exit ${reply.status}`);
        const current = reply.stdout.match(/Current version:\s*(\S+)/)?.[1] ?? null;
        return { current, latest: reply.stdout.match(/New version available:\s*(\S+)/)?.[1] ?? current };
      }
      const [listed, viewed] = await Promise.all([run('npm', ['list', '--global', '--depth=0', '--json']), run('npm', ['view', packages[name], 'version', '--json'])]);
      if (viewed.status !== 0) throw new Error(viewed.stderr?.trim() || `exit ${viewed.status}`);
      return { current: JSON.parse(listed.stdout || '{}').dependencies?.[packages[name]]?.version ?? null, latest: JSON.parse(viewed.stdout) };
    };
    const results = await Promise.allSettled(names.map(latestOf));
    cache = { checkedAt: new Date(now()).toISOString(), agents: {} };
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') cache.agents[names[index]] = result.value;
      else {
        // 失败也缓存到下一个检查周期，离线时不在每次启动重复等待。
        cache.agents[names[index]] = { error: result.reason.message };
        log(`Warning: ${names[index]} update check failed: ${result.reason.message}`);
      }
    });
    fs.writeFileSync(file, JSON.stringify(cache, null, 2) + '\n');
  }
  const available = names.filter(name => cache.agents[name]?.current && cache.agents[name].latest && cache.agents[name].current !== cache.agents[name].latest);
  if (available.length) log(`Updates available: ${available.map(name => `${name} ${cache.agents[name].current} → ${cache.agents[name].latest}`).join(', ')}`);
  return available;
}

// start/restart 的自动更新：有新版本且没有任何进程在用该 CLI 时直接安装，不为更新停止角色。
// 运行中的进程会按需读取安装目录里带哈希的资源文件，替换会让它们出错，所以在用时跳过。
export async function autoUpdateAgents({ home, agents, processes = processInventory, run = runUpdateCommand, log = console.log, now = Date.now, syncConfigs }) {
  // 配置合并不依赖联网检查缓存或 CLI 是否需要升级。
  if (syncConfigs) await syncConfigs();
  const available = await checkAgentUpdates({ home, agents, run, log, now });
  if (!available.length) return { updated: [], deferred: [], warnings: [] };
  // 逐个 agent 的 deferred 日志由下面的汇总提示代替。
  const result = await updateAgentsBeforeStart({ agents: available, processes, run, log: line => /^Update deferred:/.test(line) || log(line) });
  if (result.updated.length) markUpdated(home, result.updated);
  if (result.deferred.length) log(`Update postponed for ${result.deferred.join(', ')}: still in use. It installs at the next start with no running process, or run \`orca-team update\` to stop, update and resume now`);
  return result;
}

function markUpdated(home, names) {
  const file = path.join(home, 'agent-update-check.json');
  const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const name of names) if (cache.agents[name]?.latest) cache.agents[name].current = cache.agents[name].latest;
  fs.writeFileSync(file, JSON.stringify(cache, null, 2) + '\n');
}

export function clearUpdateCheck(home) {
  fs.rmSync(path.join(home, 'agent-update-check.json'), { force: true });
}
