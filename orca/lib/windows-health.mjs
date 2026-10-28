import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { completeLocalInventory, dataDirectory } from './platform.mjs';
import { sameWorktree } from './sessions.mjs';
import { snapshot as readSnapshot } from './orca.mjs';
import { claudeSessionIds } from './claude.mjs';
import { provesClaudePresentation } from './claude-presentation-proof.mjs';

// Newer Orca builds remove closed panes without persisting tombstones.
// Prove absence from both the native PTY host and OS before resuming history.
export async function verifyWindowsAbsence({ project, missing, cli, platform = process.platform, inventory = daemonSessions, processes = windowsProcesses, snapshot = readSnapshot, presentation = provesClaudePresentation }) {
  if (platform !== 'win32') throw new Error('Native absence verification is only available on Windows');
  const normalize = value => value.replaceAll('\\', '/').toLowerCase();
  const proofs = [];
  for (let pass = 0; pass < 2; pass++) {
    const native = await inventory();
    const desktop = await cli(['terminal', 'list', '--worktree', `path:${project}`, '--include-visual-layouts']);
    const rows = await processes();
    const snap = await snapshot();
    if (!native.identity?.launchNonce || !Array.isArray(native.sessions) || !Array.isArray(rows) ||
        !completeLocalInventory(desktop)) throw new Error('Incomplete local terminal inventory');
    const active = native.sessions.filter(s => sameWorktree(s.sessionId.split('@@')[0], project) && s.isAlive !== false);
    for (const s of active) {
      const match = desktop.terminals.filter(t => t.handle === s.terminalHandle && t.ptyId === s.sessionId && t.incarnationId === s.incarnationId);
      if (s.isAlive !== true || s.wslDistro || match.length !== 1) throw new Error('Hidden or unverifiable project PTY; no duplicate launched');
    }
    for (const t of desktop.terminals) {
      if (!t.connected || t.orphaned || t.executionHostId !== 'local' ||
          active.filter(s => s.terminalHandle === t.handle).length !== 1) throw new Error('Desktop/native terminal inventory mismatch');
      if (missing.some(({ saved }) => saved.tabId === t.tabId && saved.leafId === t.leafId)) throw new Error('Original pane is still present');
      const s = active.find(s => s.terminalHandle === t.handle);
      if (t.agentIdentity || ['pi', 'omp', 'codex', 'claude'].some(provider => classifyWindows(rows, s, provider) === 'agent')) {
        const live = snap.sleepingAgentSessionsByPaneKey?.[`${t.tabId}:${t.leafId}`];
        if (live?.origin === 'live' && sameWorktree(live.worktreeId, project) && live.providerSession?.id) {
          if (missing.some(({ saved }) => saved.session.id === live.providerSession.id)) throw new Error('Original conversation is running in another pane');
        } else {
          const descendants = new Set([s.pid]);
          const sRoot = rows.find(r => r.ProcessId === s.pid);
          if (sRoot?.Created) {
            const queue = [sRoot];
            for (let i = 0; i < queue.length; i++) {
              const pCreated = queue[i].Created ? BigInt(queue[i].Created) : 0n;
              for (const r of rows.filter(row => row.ParentProcessId === queue[i].ProcessId)) {
                if (descendants.has(r.ProcessId) || r.SessionId !== sRoot.SessionId) continue;
                const cCreated = r.Created ? BigInt(r.Created) : pCreated;
                if (cCreated < pCreated) continue;
                descendants.add(r.ProcessId); queue.push(r);
              }
            }
          }
          const agents = rows.filter(r => descendants.has(r.ProcessId) && (/^(?:codex|omp|claude)\.exe$/i.test(r.Name) ||
            /^node\.exe$/i.test(r.Name) && /pi-coding-agent[\\/]dist[\\/](?:bundle[\\/])?cli\.js/i.test(r.CommandLine || '')));
          if ((!agents.length && !presentation({ terminal: t, descendants, rows })) || agents.some(r => /^codex\.exe$/i.test(r.Name)
            ? !/(?:^|\s)resume\s+"?[0-9a-f-]{36}(?:"|\s|$)/i.test(r.CommandLine || '')
            : /^claude\.exe$/i.test(r.Name) ? !claudeSessionIds(r.CommandLine || '').length
            : !/(?:^|\s)(?:--session|--resume)\s+(?:"[^"]+"|[^\s"]+)/.test(r.CommandLine || ''))) throw new Error('Running agent conversation is unbound');
        }
      }
    }
    for (const row of rows.filter(r => /^(?:node|codex|claude|pi|omp|wsl|bash)(?:\.exe)?$/i.test(r.Name))) {
      if (typeof row.CommandLine !== 'string' || !row.CommandLine) throw new Error('Agent process command line is unreadable');
      const command = normalize(row.CommandLine);
      for (const { name, saved } of missing) {
        if (!saved.session?.id || !saved.session.transcriptPath) throw new Error('Original conversation identity is unavailable');
        if (command.includes(normalize(saved.session.id)) || command.includes(normalize(saved.session.transcriptPath))) throw new Error(`${name}: original conversation process still running`);
      }
    }
    const roots = active.map(s => {
      const root = rows.find(r => r.ProcessId === s.pid);
      if (!root?.Created) throw new Error('Native PTY process cannot be verified');
      return [s.terminalHandle, s.incarnationId, s.pid, root.Created];
    }).sort((a, b) => a[0].localeCompare(b[0]));
    proofs.push(JSON.stringify([native.identity.launchNonce, roots]));
  }
  if (proofs[0] !== proofs[1]) throw new Error('Terminal processes changed during absence verification');
  return true;
}

// Orca 会随版本升级终端宿主守护进程（v36 → v39 → …），文件名带版本号。
// 取本机已注册的最高版本，避免硬编码版本号在 Orca 升级后让所有角色变成不可验证。
export function terminalHostVersion(directory = path.join(dataDirectory(), 'daemon')) {
  const versions = fs.readdirSync(directory)
    .map(name => name.match(/^daemon-v(\d+)\.pid$/)?.[1])
    .filter(Boolean).map(Number);
  if (!versions.length) throw new Error('terminal_host_version_unavailable');
  return Math.max(...versions);
}

// Read-only terminal-host protocol adapter: never attaches or writes a terminal.
// Orca 升级后旧宿主会继续托管升级前的终端，多个宿主同时存活是常态。
// 指定终端时只返回唯一拥有它的宿主；全局清单则合并所有存活宿主，
// 组合标识让前后两次采样仍能发现任何一个宿主的重启。
export function selectTerminalHost(inventories, terminal) {
  if (terminal) {
    if (!terminal.handle || !terminal.ptyId || !terminal.incarnationId) throw new Error('Incomplete terminal host selector');
    const matches = inventories.flatMap(host => host.sessions.filter(session =>
      session.terminalHandle === terminal.handle && session.sessionId === terminal.ptyId &&
      session.incarnationId === terminal.incarnationId && session.isAlive === true).map(() => host));
    if (matches.length !== 1) throw new Error('Terminal host ownership unavailable or ambiguous');
    return matches[0];
  }
  if (!inventories.length) throw new Error('terminal_host_inventory_unavailable');
  const active = inventories.filter(value => value.sessions.length > 0);
  if (active.length <= 1) return active[0] ?? inventories[0];
  const handles = active.flatMap(host => host.sessions.map(session => session.terminalHandle));
  if (new Set(handles).size !== handles.length) throw new Error('Terminal handle is claimed by multiple hosts; inventory is ambiguous');
  return { identity: { launchNonce: active.map(host => host.identity?.launchNonce).join('+') }, sessions: active.flatMap(host => host.sessions) };
}

export async function daemonSessions(terminal, { directory = path.join(dataDirectory(), 'daemon'), read = readDaemonSessions, alive = processAlive } = {}) {
  const versions = fs.readdirSync(directory)
    .map(name => name.match(/^daemon-v(\d+)\.pid$/)?.[1])
    .filter(Boolean).map(Number).sort((a, b) => b - a);
  const inventories = [];
  for (const version of versions) {
    try { inventories.push(await read(directory, version)); }
    catch (error) {
      // 进程已退出的过期登记可以忽略；存活宿主读不到时全局清单不完整，必须失败。
      if (!terminal && registeredHostAlive(directory, version, alive)) throw new Error('terminal_host_inventory_incomplete', { cause: error });
    }
  }
  return selectTerminalHost(inventories, terminal);
}

function registeredHostAlive(directory, version, alive) {
  try { return alive(JSON.parse(fs.readFileSync(path.join(directory, `daemon-v${version}.pid`), 'utf8')).pid); }
  catch { return false; }
}

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

async function readDaemonSessions(directory, version) {
  const expected = JSON.parse(fs.readFileSync(path.join(directory, `daemon-v${version}.pid`), 'utf8'));
  const token = fs.readFileSync(path.join(directory, `daemon-v${version}.token`), 'utf8').trim();
  const suffix = createHash('sha256').update(directory).digest('hex').slice(0, 12);
  return new Promise((resolve, reject) => {
    const endpoint = process.platform === 'win32' ? `\\\\?\\pipe\\orca-terminal-host-v${version}-${suffix}` : path.join(directory, `daemon-v${version}.sock`);
    const socket = net.createConnection(endpoint);
    let buffer = '', hello = false, identity;
    const id = randomUUID();
    const fail = () => { clearTimeout(timer); socket.destroy(); reject(new Error('windows_daemon_inventory_unavailable')); };
    const timer = setTimeout(fail, 5000);
    socket.setEncoding('utf8');
    socket.on('error', fail); socket.on('end', fail);
    socket.on('connect', () => socket.write(JSON.stringify({ type: 'hello', version, token, clientId: randomUUID(), role: 'control' }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) return fail();
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let reply;
        try { reply = JSON.parse(line); } catch { return fail(); }
        if (!hello) {
          identity = reply.daemonIdentity;
          if (!reply.ok || identity?.pid !== expected.pid || !expected.launchNonce || identity?.launchNonce !== expected.launchNonce) return fail();
          hello = true; socket.write(JSON.stringify({ id, type: 'listSessions' }) + '\n');
        } else if (reply.id === id) {
          if (!reply.ok || !Array.isArray(reply.payload?.sessions)) return fail();
          clearTimeout(timer); socket.end(); resolve({ identity, sessions: reply.payload.sessions });
        }
      }
    });
  });
}

export async function windowsProcesses() {
  const script = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ErrorActionPreference = "Stop"; ' +
    'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,CreationDate,SessionId | ' +
    'Select-Object ProcessId,ParentProcessId,Name,CommandLine,SessionId,@{n="Created";e={$_.CreationDate.ToUniversalTime().Ticks.ToString()}} | ConvertTo-Json -Compress';
  const { stdout } = await promisify(execFile)(path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 8000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' });
  const rows = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  if (!Array.isArray(rows) || !rows.some(row => row.ProcessId === process.pid)) throw new Error('windows_process_table_incomplete');
  return rows;
}

export function classifyWindows(rows, session, provider) {
  const root = rows.find(row => row.ProcessId === session.pid);
  if (!root?.Created || !/^(pwsh|powershell|cmd)\.exe$/i.test(root.Name) || !Number.isInteger(root.SessionId)) return 'unverifiable';
  const rootCreated = BigInt(root.Created);
  const tree = [root], seen = new Set([root.ProcessId]);
  for (let i = 0; i < tree.length; i++) for (const row of rows.filter(row => row.ParentProcessId === tree[i].ProcessId)) {
    if (row.Created && BigInt(row.Created) < rootCreated) continue;
    if (seen.has(row.ProcessId) || !row.Created || BigInt(row.Created) < BigInt(tree[i].Created) || row.SessionId !== root.SessionId) return 'unverifiable';
    seen.add(row.ProcessId); tree.push(row);
  }
  if (tree.length === 1) return 'shell';
  const agent = tree.slice(1).some(row => provider === 'codex'
    ? /^codex\.exe$/i.test(row.Name)
    : provider === 'omp' ? /^omp\.exe$/i.test(row.Name)
    : provider === 'claude' ? /^claude\.exe$/i.test(row.Name)
    : /^node\.exe$/i.test(row.Name) && /(?:^|[\\/])pi-coding-agent[\\/]dist[\\/](?:bundle[\\/])?cli\.js(?:"|\s|$)/i.test(row.CommandLine || ''));
  return agent ? 'agent' : 'unverifiable';
}

export async function inspectWindows(terminal, provider, { inventory = daemonSessions, processes = windowsProcesses, show } = {}) {
  const match = list => list.sessions.filter(s => s.terminalHandle === terminal.handle && s.sessionId === terminal.ptyId && s.incarnationId === terminal.incarnationId && s.isAlive && !s.wslDistro);
  const before = await inventory(), initial = match(before);
  if (initial.length !== 1) throw new Error('windows_pane_identity_unavailable');
  const [first, second] = await Promise.all([processes(), processes()]);
  const after = await inventory(), final = match(after);
  const current = show ? await show() : terminal;
  if (final.length !== 1 || initial[0].pid !== final[0].pid || initial[0].sessionId !== final[0].sessionId ||
      before.identity.launchNonce !== after.identity.launchNonce || current.incarnationId !== terminal.incarnationId ||
      current.ptyId !== terminal.ptyId || !current.connected || current.orphaned) throw new Error('windows_pane_identity_changed');
  const root1 = first.find(r => r.ProcessId === initial[0].pid), root2 = second.find(r => r.ProcessId === initial[0].pid);
  if (!root1?.Created || root1.Created !== root2?.Created) throw new Error('windows_root_identity_changed');
  const a = classifyWindows(first, initial[0], provider), b = classifyWindows(second, final[0], provider);
  const descendants = new Set([initial[0].pid]);
  if (root2?.Created) {
    const queue = [root2];
    for (let i = 0; i < queue.length; i++) {
      const pCreated = queue[i].Created ? BigInt(queue[i].Created) : 0n;
      for (const r of second.filter(row => row.ParentProcessId === queue[i].ProcessId)) {
        if (descendants.has(r.ProcessId) || r.SessionId !== root2.SessionId) continue;
        const cCreated = r.Created ? BigInt(r.Created) : pCreated;
        if (cCreated < pCreated) continue;
        descendants.add(r.ProcessId); queue.push(r);
      }
    }
  }
  const sessionPaths = second.filter(row => descendants.has(row.ProcessId) && (/^omp\.exe$/i.test(row.Name) || /^node\.exe$/i.test(row.Name) &&
    /pi-coding-agent[\\/]dist[\\/](?:bundle[\\/])?cli\.js/i.test(row.CommandLine || '')))
    .flatMap(row => [...(row.CommandLine || '').matchAll(/(?:^|\s)(?:--session|--resume)\s+(?:"([^"]+)"|([^\s"]+))/g)].map(m => m[1] || m[2]));
  const sessionIds = [
    ...second.filter(row => descendants.has(row.ProcessId) && /^codex\.exe$/i.test(row.Name))
      .flatMap(row => [...(row.CommandLine || '').matchAll(/(?:^|\s)resume\s+"?([0-9a-f-]{36})(?:"|\s|$)/gi)].map(m => m[1])),
    ...second.filter(row => descendants.has(row.ProcessId) && /^claude\.exe$/i.test(row.Name))
      .flatMap(row => claudeSessionIds(row.CommandLine || '')),
  ];
  const providerRow = second.find(row => descendants.has(row.ProcessId) && new RegExp(`^${provider}\\.exe$`, 'i').test(row.Name || ''));
  return { terminal: current, sessionPaths, sessionIds, kind: a === b ? b : 'unverifiable', reason: a === b && b !== 'unverifiable' ? 'windows_native_verified' : 'windows_process_tree_unverified',
    providerProcess: providerRow?.Created ? `${providerRow.ProcessId}@${providerRow.Created}` : undefined };
}
