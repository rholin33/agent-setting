import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dataDirectory } from './platform.mjs';
import { sameWorktree } from './sessions.mjs';
import { snapshot as readSnapshot } from './orca.mjs';

// Newer Orca builds remove closed panes without persisting tombstones.
// Prove absence from both the native PTY host and OS before resuming history.
export async function verifyWindowsAbsence({ project, missing, cli, platform = process.platform, inventory = daemonSessions, processes = windowsProcesses, snapshot = readSnapshot }) {
  if (platform !== 'win32') throw new Error('Native absence verification is only available on Windows');
  const normalize = value => value.replaceAll('\\', '/').toLowerCase();
  const proofs = [];
  for (let pass = 0; pass < 2; pass++) {
    const native = await inventory();
    const desktop = await cli(['terminal', 'list', '--worktree', `path:${project}`, '--include-visual-layouts']);
    const rows = await processes();
    const snap = await snapshot();
    if (!native.identity?.launchNonce || !Array.isArray(native.sessions) || !Array.isArray(rows) ||
        !Array.isArray(desktop.terminals) || desktop.truncated !== false || desktop.totalCount !== desktop.terminals.length ||
        desktop.hostScope?.hostIds?.length !== 1 || desktop.hostScope.hostIds[0] !== 'local' ||
        !Array.isArray(desktop.hostScope.omittedHostIds) || desktop.hostScope.omittedHostIds.length) throw new Error('Incomplete local terminal inventory');
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
      if (t.agentIdentity || ['pi', 'codex'].some(provider => classifyWindows(rows, s, provider) === 'agent')) {
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
          const agents = rows.filter(r => descendants.has(r.ProcessId) && (/^codex\.exe$/i.test(r.Name) ||
            /^node\.exe$/i.test(r.Name) && /pi-coding-agent[\\/]dist[\\/](?:bundle[\\/])?cli\.js/i.test(r.CommandLine || '')));
          if (!agents.length || agents.some(r => /^codex\.exe$/i.test(r.Name)
            ? !/(?:^|\s)resume\s+"?[0-9a-f-]{36}(?:"|\s|$)/i.test(r.CommandLine || '')
            : !/(?:^|\s)--session\s+(?:"[^"]+"|[^\s"]+)/.test(r.CommandLine || ''))) throw new Error('Running agent conversation is unbound');
        }
      }
    }
    for (const row of rows.filter(r => /^(?:node|codex|pi|wsl|bash)(?:\.exe)?$/i.test(r.Name))) {
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

// Read-only v36 protocol adapter: never attaches or writes a terminal.
export async function daemonSessions() {
  const directory = path.join(dataDirectory(), 'daemon'), version = 36;
  const expected = JSON.parse(fs.readFileSync(path.join(directory, `daemon-v${version}.pid`), 'utf8'));
  const token = fs.readFileSync(path.join(directory, `daemon-v${version}.token`), 'utf8').trim();
  const suffix = createHash('sha256').update(directory).digest('hex').slice(0, 12);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(`\\\\?\\pipe\\orca-terminal-host-v${version}-${suffix}`);
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
    : /^node\.exe$/i.test(row.Name) && /(?:^|[\\/])pi-coding-agent[\\/]dist[\\/](?:bundle[\\/])?cli\.js(?:"|\s|$)/i.test(row.CommandLine || ''));
  return agent ? 'agent' : 'unverifiable';
}

export async function inspectWindows(terminal, provider, { inventory = daemonSessions, processes = windowsProcesses, show } = {}) {
  const match = list => list.sessions.filter(s => s.terminalHandle === terminal.handle && s.sessionId === terminal.ptyId && s.incarnationId === terminal.incarnationId && s.isAlive && !s.wslDistro);
  const before = await inventory(), initial = match(before);
  if (initial.length !== 1) throw new Error('windows_pane_identity_unavailable');
  const first = await processes(), second = await processes();
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
  const sessionPaths = second.filter(row => descendants.has(row.ProcessId) && /^node\.exe$/i.test(row.Name) &&
    /pi-coding-agent[\\/]dist[\\/](?:bundle[\\/])?cli\.js/i.test(row.CommandLine || ''))
    .flatMap(row => [...(row.CommandLine || '').matchAll(/(?:^|\s)--session\s+(?:"([^"]+)"|([^\s"]+))/g)].map(m => m[1] || m[2]));
  const sessionIds = second.filter(row => descendants.has(row.ProcessId) && /^codex\.exe$/i.test(row.Name))
    .flatMap(row => [...(row.CommandLine || '').matchAll(/(?:^|\s)resume\s+"?([0-9a-f-]{36})(?:"|\s|$)/gi)].map(m => m[1]));
  return { terminal: current, sessionPaths, sessionIds, kind: a === b ? b : 'unverifiable', reason: a === b && b !== 'unverifiable' ? 'windows_native_verified' : 'windows_process_tree_unverified' };
}
