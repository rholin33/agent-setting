import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dataDirectory } from './platform.mjs';

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
  const tree = [root], seen = new Set([root.ProcessId]);
  for (let i = 0; i < tree.length; i++) for (const row of rows.filter(row => row.ParentProcessId === tree[i].ProcessId)) {
    if (seen.has(row.ProcessId) || !row.Created || row.Created < tree[i].Created || row.SessionId !== root.SessionId) return 'unverifiable';
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
  for (let i = 0; i < second.length; i++) for (const row of second) if (descendants.has(row.ParentProcessId)) descendants.add(row.ProcessId);
  const sessionPaths = second.filter(row => descendants.has(row.ProcessId) && /^node\.exe$/i.test(row.Name) &&
    /pi-coding-agent[\\/]dist[\\/](?:bundle[\\/])?cli\.js/i.test(row.CommandLine || ''))
    .flatMap(row => [...(row.CommandLine || '').matchAll(/(?:^|\s)--session\s+(?:"([^"]+)"|([^\s"]+))/g)].map(m => m[1] || m[2]));
  const sessionIds = second.filter(row => descendants.has(row.ProcessId) && /^codex\.exe$/i.test(row.Name))
    .flatMap(row => [...(row.CommandLine || '').matchAll(/(?:^|\s)resume\s+"?([0-9a-f-]{36})(?:"|\s|$)/gi)].map(m => m[1]));
  return { terminal: current, sessionPaths, sessionIds, kind: a === b ? b : 'unverifiable', reason: a === b && b !== 'unverifiable' ? 'windows_native_verified' : 'windows_process_tree_unverified' };
}
