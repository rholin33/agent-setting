import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureClaudeLocalTerminal } from '../lib/claude-local-terminal.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-local-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = home.replaceAll('\\', '/');
  const endpoint = { runtime: 'claude', role: 'archi', environment: 'paired', terminal: 'remote', incarnation: 'remote-inc', session: 'native-session' };
  const config = path.join(home, 'binding.json');
  fs.writeFileSync(config, JSON.stringify({ version: 1, project, role: 'archi', runtimeId: 'runtime', endpoint }));
  const terminal = { handle: 'local', incarnationId: 'local-inc', executionHostId: 'local', worktreePath: project, connected: true, tabId: 'tab', leafId: 'leaf', paneKey: 'tab:leaf' };
  const receipt = path.join(home, 'local-terminal.json');
  const status = path.join(home, 'local-terminal-status.json');
  const connected = () => fs.writeFileSync(status, JSON.stringify({ state: 'connected', project, role: 'archi', runtimeId: 'runtime', remote: endpoint, pid: process.pid, localPane: 'tab:leaf', updatedAt: new Date().toISOString() }));
  const calls = [];
  const cli = async args => {
    calls.push(args);
    if (args[1] === 'list') return { terminals: [terminal] };
    if (args[1] === 'create') { connected(); return { terminal }; }
    throw Error('Unexpected mutation: ' + args.join(' '));
  };
  const options = { home, project, config, endpoint, cli, verify: async () => {}, attempts: 1 };
  return { options, terminal, receipt, status, connected, calls };
}

test('mounts an existing remote owner in the requested local project, without remote launch or input', async t => {
  const f = fixture(t);
  assert.equal((await ensureClaudeLocalTerminal(f.options)).handle, 'local');
  const create = f.calls.find(c => c[1] === 'create');
  assert.equal(create[create.indexOf('--worktree') + 1], `path:${f.options.project}`);
  assert.ok(!create.includes('--environment'));
  assert.ok(!f.calls.some(c => c[1] === 'send' || c[1] === 'close'));
});
test('reuses the verified local pane without creating a second entry', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.receipt, JSON.stringify({ version: 1, status: 'created', terminal: f.terminal })); f.connected();
  await ensureClaudeLocalTerminal(f.options);
  assert.ok(!f.calls.some(c => c[1] === 'create'));
});
test('rejects another project before creating a terminal', async t => {
  const f = fixture(t);
  await assert.rejects(ensureClaudeLocalTerminal({ ...f.options, project: f.options.project + '-other' }), /scope/);
  assert.equal(f.calls.length, 0);
});
test('unknown creation is retained and never replayed', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.receipt, JSON.stringify({ version: 1, status: 'starting' }));
  await assert.rejects(ensureClaudeLocalTerminal(f.options), /uncertain/);
  assert.ok(!f.calls.some(c => c[1] === 'create'));
});
test('stale or wrong-session client cannot be reported as connected', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.receipt, JSON.stringify({ version: 1, status: 'created', terminal: f.terminal })); f.connected();
  const status = JSON.parse(fs.readFileSync(f.status)); status.remote.session = 'other'; fs.writeFileSync(f.status, JSON.stringify(status));
  await assert.rejects(ensureClaudeLocalTerminal(f.options), /connection/);
  assert.ok(!f.calls.some(c => c[1] === 'create' || c[1] === 'send'));
});
