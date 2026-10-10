import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { daemonSessions, windowsProcesses } from './windows-health.mjs';
import { macProcesses, macTree } from './macos-health.mjs';

const execute = promisify(execFile);

export async function terminateMacAgent({ terminal, saved, inventory = daemonSessions,
  processes = macProcesses, kill = (pid, signal) => process.kill(pid, signal) }) {
  if (terminal.executionHostId !== 'local') throw new Error('Refusing to terminate a remote process');
  const match = value => value.sessions.filter(row => row.terminalHandle === terminal.handle &&
    row.incarnationId === terminal.incarnationId && row.sessionId === terminal.ptyId && row.isAlive === true);
  const before = await inventory(), sessions = match(before);
  if (sessions.length !== 1) throw new Error('Pane process identity unavailable');
  const rows = await processes();
  const tree = macTree(rows, sessions[0].pid, saved.agent);
  if (!tree) throw new Error('Provider process is ambiguous');
  const candidates = JSON.parse(tree).filter(row => row[5] === saved.agent);
  if (candidates.length !== 1) throw new Error('Provider process is ambiguous');
  const target = rows.find(row => row.pid === candidates[0][0]);
  const descendants = [target];
  for (let index = 0; index < descendants.length; index++) {
    for (const row of rows.filter(row => row.parent === descendants[index].pid)) {
      if (descendants.some(item => item.pid === row.pid) || row.tty !== target.tty ||
          !Number.isFinite(Date.parse(row.created)) || Date.parse(row.created) < Date.parse(descendants[index].created))
        throw new Error('Provider descendant identity unavailable');
      descendants.push(row);
    }
  }
  // Never signal the foreground group: launch wrappers can share it with the shell.
  for (const row of descendants.reverse()) {
    const currentHost = await inventory(), currentSessions = match(currentHost);
    const current = await processes();
    if (currentHost.identity.launchNonce !== before.identity.launchNonce || currentSessions.length !== 1 ||
        currentSessions[0].pid !== sessions[0].pid || macTree(current, sessions[0].pid, saved.agent) !== tree)
      throw new Error('Pane process identity changed before termination');
    const observed = current.find(item => item.pid === row.pid);
    if (!observed) continue;
    if (observed.created !== row.created || observed.parent !== row.parent || observed.tty !== row.tty)
      throw new Error('Provider PID changed');
    kill(row.pid, 'SIGKILL');
  }
}

async function terminateAgent({ terminal, saved }) {
  if (process.platform === 'darwin') return terminateMacAgent({ terminal, saved });
  if (process.platform !== 'win32') throw new Error('Forced process termination currently supports local Windows and macOS panes only');
  if (terminal.executionHostId !== 'local') throw new Error('Refusing to terminate a remote process');
  const inventory = await daemonSessions();
  const sessions = inventory.sessions.filter(row => row.terminalHandle === terminal.handle &&
    row.incarnationId === terminal.incarnationId && row.sessionId === terminal.ptyId && row.isAlive);
  if (sessions.length !== 1) throw new Error('Pane process identity unavailable');
  const rows = await windowsProcesses();
  const root = rows.find(row => row.ProcessId === sessions[0].pid);
  if (!root?.Created) throw new Error('PTY root missing');
  const tree = [root];
  for (let i = 0; i < tree.length; i++) {
    for (const row of rows.filter(row => row.ParentProcessId === tree[i].ProcessId)) {
      if (!row.Created || row.SessionId !== root.SessionId || BigInt(row.Created) < BigInt(tree[i].Created)) continue;
      if (!tree.some(existing => existing.ProcessId === row.ProcessId)) tree.push(row);
    }
  }
  const candidates = tree.slice(1).filter(row => saved.agent === 'codex' ? /^codex\.exe$/i.test(row.Name) : saved.agent === 'omp' ? /^omp\.exe$/i.test(row.Name) :
    /^node\.exe$/i.test(row.Name) && /pi-coding-agent[\\/]dist[\\/](?:bundle[\\/])?cli\.js/i.test(row.CommandLine || ''));
  if (candidates.length !== 1) throw new Error('Provider process is ambiguous');
  const target = candidates[0];
  // Recheck the exact process creation time in the same PowerShell that stops
  // descendants. Preserve the PTY root shell so the original pane can resume.
  const script = `$ErrorActionPreference='Stop'; $targetProcess=Get-CimInstance Win32_Process -Filter 'ProcessId=${target.ProcessId}'; ` +
    `if (!$targetProcess -or $targetProcess.CreationDate.ToUniversalTime().Ticks.ToString() -ne '${target.Created}') { throw 'Provider PID changed' }; ` +
    `$providerRows=Get-CimInstance Win32_Process; function Stop-ProviderTree([int]$providerPid) { ` +
    `foreach ($childProcess in $providerRows | Where-Object ParentProcessId -eq $providerPid) { Stop-ProviderTree $childProcess.ProcessId }; ` +
    `Stop-Process -Id $providerPid -Force -ErrorAction SilentlyContinue }; Stop-ProviderTree ${target.ProcessId}`;
  await execute(path.win32.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
}

export async function exitAgent({ name, saved, handle, terminal, cli, inspect, verify, checkpoint,
  force = terminateAgent, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = console.log }) {
  const observe = async () => {
    const live = await inspect(handle, saved.agent);
    if (live.terminal.incarnationId !== terminal.incarnationId) throw new Error(`${name}: pane changed during exit`);
    if (live.kind === 'agent') await verify(live);
    return live;
  };
  let live = await observe();
  if (live.kind === 'shell') return live;
  if (live.kind !== 'agent') throw new Error(`${name}: provider process cannot be verified`);
  saved.restartIntent = { sessionId: saved.session.id, createdAt: new Date().toISOString() };
  checkpoint();
  log(`${name}: interrupting current task before exit`);
  const interrupt = await cli(['terminal', 'send', '--terminal', handle, '--interrupt']);
  if (interrupt.send?.accepted !== true) throw new Error(`${name}: interrupt unconfirmed`);
  await sleep(500);
  live = await observe();
  if (live.kind === 'shell') return live;
  let idle;
  try { idle = await cli(['terminal', 'wait', '--terminal', handle, '--for', 'tui-idle', '--timeout-ms', '5000']); }
  catch (error) { if (!/timeout/i.test(error.message)) throw error; }
  if (idle?.wait?.satisfied) {
    await observe();
    const cleared = await cli(['terminal', 'send', '--terminal', handle, '--text', '\u0015\u000b']);
    if (cleared.send?.accepted !== true) throw new Error(`${name}: editor clear unconfirmed`);
    await observe();
    await cli(['terminal', 'send', '--terminal', handle, '--text', '/quit', '--enter']);
    for (let attempt = 0; attempt < 5; attempt++) {
      await sleep(500);
      live = await observe();
      if (live.kind === 'shell') return live;
    }
  }
  live = await observe();
  if (live.kind === 'shell') return live;
  if (live.kind !== 'agent') throw new Error(`${name}: process unverified before force termination`);
  log(`${name}: graceful exit incomplete; terminating verified provider process tree`);
  await force({ terminal: live.terminal, saved });
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(500);
    live = await observe();
    if (live.kind === 'shell') return live;
  }
  throw new Error(`${name}: forced exit not confirmed; update must not proceed`);
}
