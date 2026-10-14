import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectFiles, saveJson } from './team.mjs';
import { orca, rpc } from './orca.mjs';
import { daemonSessions } from './windows-health.mjs';
import { macProcesses, macTree } from './macos-health.mjs';

const read = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const script = fileURLToPath(import.meta.url);

// Never discover cleanup targets by their display titles.
export function registerAuxiliary({ home, project, kind, terminal, intents = [], repairCreatedAt }, launch = true) {
  if (!terminal?.handle || !terminal.incarnationId) return null;
  if (!['remote-setup', 'startup-repair'].includes(kind)) throw new Error('Unsupported auxiliary kind');
  const directory = path.join(path.dirname(projectFiles(home, project).state), 'auxiliary-terminals');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${terminal.handle}.json`);
  if (!/^[\w-]+$/.test(terminal.handle)) throw new Error('Invalid auxiliary handle');
  const record = { version: 1, home, project, kind, terminal: terminal.handle, incarnation: terminal.incarnationId,
    intents: intents.map(i => ({ role: i.role, id: i.id })), repairCreatedAt, status: 'waiting', createdAt: new Date().toISOString() };
  if (fs.existsSync(file)) throw new Error('Auxiliary is already registered');
  persist(file, record);
  if (launch) {
    const env = { ...process.env };
    delete env.ORCA_ENVIRONMENT; delete env.ORCA_PAIRING_CODE;
    const child = spawn(process.execPath, [script, '--watch', file], { detached: true, stdio: 'ignore', env });
    child.on('error', () => persist(file, { ...record, status: 'retained', reason: 'cleanup_worker_unavailable' }));
    child.unref();
  }
  return file;
}
function persist(file, record) { saveJson(file, record); fs.chmodSync(file, 0o600); }
function containsHandle(value, handle) {
  if (value === handle) return true;
  return value && typeof value === 'object' && Object.values(value).some(v => containsHandle(v, handle));
}
export function eligible(record) {
  const directory = path.dirname(projectFiles(record.home, record.project).state);
  const registry = read(path.join(directory, 'remote-switches.json')) || { roles: {} };
  if (Object.values(registry.roles).some(r => r.pending)) return false;
  if (containsHandle(registry, record.terminal) || containsHandle(read(path.join(directory, 'state.json')), record.terminal)) return false;
  const runtime = path.join(record.home, 'remote-master', 'runtime');
  if (fs.existsSync(runtime)) for (const entry of fs.readdirSync(runtime, { withFileTypes: true })) {
    if (entry.isDirectory() && containsHandle(read(path.join(runtime, entry.name, 'adapter.json')), record.terminal)) return false;
  }
  if (record.kind === 'startup-repair') {
    const repair = read(path.join(directory, 'startup-repair.json'));
    return repair?.status === 'completed' && repair.terminal === record.terminal && repair.incarnation === record.incarnation && repair.createdAt === record.repairCreatedAt;
  }
  return record.kind === 'remote-setup' && record.intents.length > 0 && record.intents.every(intent =>
    registry.roles[intent.role]?.setupOutcomes?.some(o => (o.id || o.intent?.id) === intent.id && ['accepted', 'rejected', 'preflight_failed'].includes(o.status)));
}

export async function noServiceChildren(terminal) {
  if (process.platform !== 'darwin') {
    const { process: p } = await rpc('terminal.inspectProcess', { terminal: terminal.handle, expectedIncarnationId: terminal.incarnationId, scanChildProcesses: true });
    return p?.foregroundProcessEvidence?.verdict === 'live' && p.foregroundProcessEvidence.ptyIncarnationId === terminal.incarnationId &&
      p.foregroundProcessEvidence.capturedAgeMs <= 2000 && p.childProcessEvidence === 'no-children' && p.foregroundProcess === 'codex';
  }
  const inventory = await daemonSessions(terminal);
  const matches = inventory.sessions.filter(s => s.terminalHandle === terminal.handle && s.incarnationId === terminal.incarnationId && s.sessionId === terminal.ptyId && s.isAlive);
  if (matches.length !== 1) return false;
  const rows = await macProcesses();
  const chain = macTree(rows, matches[0].pid, 'codex');
  if (!chain) return false;
  const ids = new Set(JSON.parse(chain).map(row => row[0]));
  // Only Codex's own idle code-mode helper may remain below the proven CLI chain.
  for (let changed = true; changed;) {
    changed = false;
    for (const row of rows) if (ids.has(row.parent) && !ids.has(row.pid)) {
      if (row.name !== 'codex-code-mode-host') return false;
      ids.add(row.pid); changed = true;
    }
  }
  return JSON.parse(chain).some(row => row[5] === 'codex');
}
function matches(record, terminal) {
  return terminal?.handle === record.terminal && terminal.incarnationId === record.incarnation && terminal.connected && !terminal.orphaned &&
    terminal.executionHostId === 'local' && terminal.worktreePath === record.project && terminal.agentIdentity === 'codex';
}
export async function cleanupAuxiliary(file, { cli = orca, services = noServiceChildren, waitMs = 1000 } = {}) {
  const record = read(file);
  if (!record || record.status === 'closed') return { status: record?.status || 'missing' };
  if (!eligible(record)) return { status: 'retained', reason: 'unsettled_or_protected' };
  const terminal = (await cli(['terminal', 'show', '--terminal', record.terminal])).terminal;
  if (!matches(record, terminal)) return { status: 'retained', reason: 'identity_changed' };
  const idle = await cli(['terminal', 'wait', '--terminal', record.terminal, '--for', 'tui-idle', '--timeout-ms', String(waitMs)]);
  if (idle.wait?.satisfied !== true) return { status: 'retained', reason: 'not_idle' };
  const screen = (await cli(['terminal', 'read', '--terminal', record.terminal, '--screen'])).terminal;
  const composer = screen.tail?.filter(line => /^\s*›/.test(line)).at(-1)?.trim();
  if (screen.source !== 'screen' || !['›', '› Ask Codex to do anything'].includes(composer)) return { status: 'retained', reason: 'draft_not_empty_or_unknown' };
  if (!await services(terminal)) return { status: 'retained', reason: 'service_children_or_unknown' };
  const current = (await cli(['terminal', 'show', '--terminal', record.terminal])).terminal;
  if (!matches(record, current) || !eligible(record)) return { status: 'retained', reason: 'state_changed' };
  await cli(['terminal', 'close', '--terminal', record.terminal]);
  const remaining = (await cli(['terminal', 'list', '--worktree', `path:${record.project}`])).terminals;
  if (!Array.isArray(remaining) || remaining.some(t => t.handle === record.terminal)) throw new Error('Auxiliary close unconfirmed');
  persist(file, { ...record, status: 'closed', closedAt: new Date().toISOString() });
  return { status: 'closed', terminal: record.terminal };
}
async function watch(file) {
  // No extra UI terminal; bounded lifetime and durable evidence if cleanup cannot finish.
  const deadline = Date.now() + 6 * 60 * 60 * 1000;
  while (Date.now() < deadline) {
    const record = read(file);
    if (!record || record.status === 'closed') return;
    try {
      if (eligible(record)) {
        const result = await cleanupAuxiliary(file, { waitMs: 30000 });
        if (result.status === 'closed') return;
        if (result.reason !== 'not_idle') { persist(file, { ...record, ...result }); return; }
      }
    } catch { /* A transient CLI failure never grants permission to close. */ }
    await pause(2000);
  }
  const record = read(file);
  if (record && record.status !== 'closed') persist(file, { ...record, status: 'retained', reason: 'cleanup_deadline' });
}
if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  delete process.env.ORCA_ENVIRONMENT; delete process.env.ORCA_PAIRING_CODE;
  if (process.argv[2] === '--watch' && process.argv[3]) await watch(process.argv[3]);
  else throw new Error('Expected --watch RECORD');
}
