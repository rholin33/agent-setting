import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { daemonSessions } from './windows-health.mjs';

export async function macProcesses() {
  const { stdout } = await promisify(execFile)('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,tpgid=,tty=,lstart=,comm='], { encoding: 'utf8', timeout: 5000 });
  return stdout.trim().split('\n').map(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/);
    if (!m) throw new Error('Incomplete macOS process table');
    return { pid: +m[1], parent: +m[2], group: +m[3], foreground: +m[4], tty: m[5], created: m[6], name: path.basename(m[7]) };
  });
}
export function macTree(rows, pid, provider) {
  const root = rows.find(r => r.pid === pid);
  if (!root || root.tty === '??') return null;
  const tree = [root], seen = new Set([pid]);
  for (let i = 0; i < tree.length; i++) for (const row of rows.filter(r => r.parent === tree[i].pid)) {
    if (seen.has(row.pid) || row.tty !== root.tty || Date.parse(row.created) < Date.parse(tree[i].created)) return null;
    seen.add(row.pid); tree.push(row);
  }
  const agents = tree.filter(r => r.name === provider && r.group === r.foreground);
  const idleShell = agents.length === 0 && tree.every(r => /^(login|zsh|bash|sh|fish|dash)$/.test(r.name)) && tree.filter(r => r.group === r.foreground && /^(zsh|bash|sh|fish|dash)$/.test(r.name)).length === 1;
  if (agents.length !== 1 && !idleShell) return null;
  return JSON.stringify(tree.map(r => [r.pid,r.parent,r.created,r.group,r.foreground,r.name]));
}
export async function inspectMac(terminal, provider, { inventory = daemonSessions, processes = macProcesses, show } = {}) {
  const match = r => r.sessions.filter(s => s.terminalHandle === terminal.handle && s.sessionId === terminal.ptyId && s.incarnationId === terminal.incarnationId && s.isAlive === true);
  const before = await inventory(), first = match(before);
  if (first.length !== 1) throw new Error('macOS pane identity unavailable');
  const a = macTree(await processes(), first[0].pid, provider);
  const b = macTree(await processes(), first[0].pid, provider);
  const after = await inventory(), last = match(after), current = await show();
  if (!a || a !== b || last.length !== 1 || first[0].pid !== last[0].pid || before.identity.launchNonce !== after.identity.launchNonce || current.incarnationId !== terminal.incarnationId || current.ptyId !== terminal.ptyId || !current.connected || current.orphaned) throw new Error('macOS process identity unverified');
  const tree = JSON.parse(b), providerPids = tree.filter(row => row[5] === provider).map(row => row[0]);
  const sessionIds = [], sessionPaths = [];
  for (const pid of providerPids) {
    const { stdout } = await promisify(execFile)('/bin/ps', ['-ww', '-p', String(pid), '-o', 'args='], { encoding: 'utf8', timeout: 5000 });
    if (provider === 'pi') {
      const { stdout: files } = await promisify(execFile)('/usr/sbin/lsof', ['-a', '-p', String(pid), '-Fn'], { encoding: 'utf8', timeout: 5000 });
      sessionPaths.push(...files.split('\n').filter(line => line.startsWith('n/') && line.endsWith('.jsonl')).map(line => line.slice(1)));
    }
    if (provider === 'codex') sessionIds.push(...[...stdout.matchAll(/(?:^|\s)resume\s+([0-9a-f-]{36})(?:\s|$)/gi)].map(m => m[1]));
  }
  if (provider === 'pi' && !sessionPaths.length) {
    // Pi changes its process title; inspect the verified launch wrapper, which
    // carries the role and project while the provider itself remains foreground.
    const { default: fs } = await import('node:fs');
    for (const row of tree.filter(row => row[5] === 'node')) {
      const { stdout } = await promisify(execFile)('/bin/ps', ['-ww', '-p', String(row[0]), '-o', 'args='], { encoding: 'utf8', timeout: 5000 });
      const match = stdout.match(/(\/[^\n]+?)\/bin\/orca-team\.mjs launch --home (.+?) --project (.+?) --role ([\w-]+) --resume(?:\s|$)/);
      if (!match) continue;
      const { projectFiles } = await import('./team.mjs');
      const saved = JSON.parse(fs.readFileSync(projectFiles(match[2], match[3]).state, 'utf8')).agents[match[4]];
      if (saved?.leafId === terminal.leafId && saved?.tabId === terminal.tabId && saved.session?.transcriptPath) sessionPaths.push(saved.session.transcriptPath);
    }
  }
  const check = macTree(await processes(), first[0].pid, provider);
  if (check !== b) throw new Error('macOS process changed while reading conversation arguments');
  const providerProcess = tree.find(row => row[5] === provider);
  return { terminal: current, kind: providerPids.length ? 'agent' : 'shell', sessionIds, sessionPaths, reason: 'macos_native_verified',
    providerStartedAt: providerProcess ? new Date(providerProcess[2]).toISOString() : undefined };
}

// Prove closed conversations absent without relying on optional renderer tombstones.
export async function macConversationUsers(missing) {
  const files = missing.map(({ saved }) => saved.session.transcriptPath);
  let stdout;
  try {
    ({ stdout } = await promisify(execFile)('/usr/sbin/lsof', ['-t', '--', ...files], { encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 }));
  } catch (error) {
    if (error.code !== 1 || error.stdout?.trim() || error.stderr?.trim()) throw new Error('Cannot inspect original transcript file owners');
    stdout = '';
  }
  if (stdout.trim()) throw new Error('Original conversation transcript is still open by a process');
  const result = await promisify(execFile)('/bin/ps', ['-axww', '-o', 'pid=,args='], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  for (const { name, saved } of missing) {
    if (result.stdout.includes(saved.session.id) || result.stdout.includes(saved.session.transcriptPath)) throw new Error(`${name}: original conversation process still running`);
  }
}

export async function verifyMacAbsence({ project, missing, cli, inventory = daemonSessions, processes = macProcesses, conversationUsers = macConversationUsers }) {
  const { sameWorktree, validateTranscript } = await import('./sessions.mjs');
  for (const { saved } of missing) validateTranscript(saved, project);
  const proofs = [];
  for (let pass = 0; pass < 2; pass++) {
    const native = await inventory();
    const desktop = await cli(['terminal', 'list', '--worktree', `path:${project}`, '--include-visual-layouts']);
    if (!native.identity?.launchNonce || !Array.isArray(native.sessions) || !Array.isArray(desktop.terminals) || desktop.truncated !== false || desktop.totalCount !== desktop.terminals.length || desktop.hostScope?.hostIds?.length !== 1 || desktop.hostScope.hostIds[0] !== 'local' || desktop.hostScope.omittedHostIds?.length !== 0) throw new Error('Incomplete local terminal inventory');
    const active = native.sessions.filter(s => sameWorktree(s.sessionId?.split('@@')[0], project) && s.isAlive !== false);
    // Refuse partial/hidden project processes until their conversation ownership is known.
    if (active.length || desktop.terminals.length) throw new Error('Project still has live terminals; missing-role absence is not proven');
    const rows = await processes();
    if (!rows.some(row => row.pid === process.pid)) throw new Error('Incomplete native process table');
    await conversationUsers(missing);
    proofs.push(native.identity.launchNonce);
  }
  if (proofs[0] !== proofs[1]) throw new Error('Terminal host changed during absence verification');
  return true;
}
