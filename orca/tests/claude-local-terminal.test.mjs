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

function disconnected(f) {
  fs.writeFileSync(f.receipt, JSON.stringify({ version: 1, status: 'created', terminal: f.terminal }));
  f.connected();
  const status = JSON.parse(fs.readFileSync(f.status));
  status.state = 'disconnected'; status.pid = 99999999;
  fs.writeFileSync(f.status, JSON.stringify(status));
  const cli = f.options.cli;
  f.options.inspect = async () => ({ kind: 'shell', terminal: f.terminal });
  f.options.cli = async args => {
    if (args[1] === 'read') return { terminal: { source: 'screen', tail: ['PS C:\\project>'] } };
    if (args[1] === 'send') {
      f.calls.push(args);
      const intent = JSON.parse(fs.readFileSync(path.join(f.options.home, 'local-reconnect.json')));
      assert.equal(intent.status, 'starting');
      f.connected();
      const status = JSON.parse(fs.readFileSync(f.status)); status.connectionId = intent.id;
      fs.writeFileSync(f.status, JSON.stringify(status));
      return { send: { accepted: true } };
    }
    return cli(args);
  };
}

test('reconnects a stopped client in the same proven empty shell and retains the remote endpoint', async t => {
  const f = fixture(t); disconnected(f);
  let verified = 0; f.options.verify = async () => { verified++; };
  assert.equal((await ensureClaudeLocalTerminal(f.options)).handle, 'local');
  assert.equal(f.calls.filter(c => c[1] === 'send').length, 1);
  assert.ok(!f.calls.some(c => c[1] === 'create' || c[1] === 'close'));
  assert.ok(verified >= 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.options.home, 'local-reconnect.json'))).status, 'connected');
  await ensureClaudeLocalTerminal(f.options);
  assert.equal(f.calls.filter(c => c[1] === 'send').length, 1);
});

for (const problem of ['live-process', 'missing-pid', 'agent', 'changed-incarnation', 'draft', 'draft-ending-with-prompt', 'unknown-delivery', 'foreign-status']) {
  test(`disconnected presentation refuses ${problem} without launching or clearing input`, async t => {
    const f = fixture(t); disconnected(f);
    if (['live-process', 'missing-pid', 'foreign-status'].includes(problem)) {
      const status = JSON.parse(fs.readFileSync(f.status));
      if (problem === 'live-process') status.pid = process.pid;
      else if (problem === 'missing-pid') delete status.pid;
      else status.remote.session = 'other';
      fs.writeFileSync(f.status, JSON.stringify(status));
    }
    if (problem === 'agent') f.options.inspect = async () => ({ kind: 'agent', terminal: f.terminal });
    if (problem === 'changed-incarnation') f.options.inspect = async () => ({ kind: 'shell', terminal: { ...f.terminal, incarnationId: 'new' } });
    if (problem.startsWith('draft')) {
      const cli = f.options.cli;
      f.options.cli = args => args[1] === 'read' ? { terminal: { source: 'screen', tail: ['PS C:\\project> unfinished draft' + (problem.endsWith('prompt') ? ' >' : '')] } } : cli(args);
    }
    if (problem === 'unknown-delivery') fs.writeFileSync(path.join(f.options.home, 'local-reconnect.json'), JSON.stringify({ status: 'starting', id: 'unknown' }));
    await assert.rejects(ensureClaudeLocalTerminal(f.options));
    assert.ok(!f.calls.some(c => ['send', 'create', 'close'].includes(c[1])));
  });
}

test('unknown reconnect send retains intent and cannot be replayed on the next startup', async t => {
  const f = fixture(t); disconnected(f);
  const cli = f.options.cli;
  f.options.cli = args => { if (args[1] === 'send') { f.calls.push(args); throw Error('lost receipt'); } return cli(args); };
  await assert.rejects(ensureClaudeLocalTerminal(f.options), /lost receipt/);
  await assert.rejects(ensureClaudeLocalTerminal(f.options), /uncertain/);
  assert.equal(f.calls.filter(c => c[1] === 'send').length, 1);
});

test('a lost send receipt can be reconciled by the exact new client without another send', async t => {
  const f = fixture(t); disconnected(f);
  const cli = f.options.cli;
  f.options.cli = async args => {
    const result = await cli(args);
    if (args[1] === 'send') throw Error('lost receipt after launch');
    return result;
  };
  await assert.rejects(ensureClaudeLocalTerminal(f.options), /lost receipt/);
  await ensureClaudeLocalTerminal(f.options);
  assert.equal(f.calls.filter(c => c[1] === 'send').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.options.home, 'local-reconnect.json'))).status, 'connected');
});

test('a second disconnect reconnects once with a fresh identity and archives the previous receipt', async t => {
  const f = fixture(t); disconnected(f);
  await ensureClaudeLocalTerminal(f.options);
  const receipt = path.join(f.options.home, 'local-reconnect.json');
  const first = fs.readFileSync(receipt, 'utf8');
  const status = JSON.parse(fs.readFileSync(f.status)); status.pid = 99999999; status.state = 'disconnected';
  fs.writeFileSync(f.status, JSON.stringify(status));
  await ensureClaudeLocalTerminal(f.options);
  assert.equal(f.calls.filter(c => c[1] === 'send').length, 2);
  assert.notEqual(JSON.parse(fs.readFileSync(receipt)).id, JSON.parse(first).id);
  const archive = fs.readdirSync(f.options.home).find(name => name.startsWith('local-reconnect.json.previous-'));
  assert.equal(fs.readFileSync(path.join(f.options.home, archive), 'utf8'), first);
});

test('remote identity changes during reconnect stop before launcher input', async t => {
  const f = fixture(t); disconnected(f);
  let count = 0; f.options.verify = async () => { if (++count === 2) throw Error('remote changed'); };
  await assert.rejects(ensureClaudeLocalTerminal(f.options), /remote changed/);
  assert.ok(!f.calls.some(c => c[1] === 'send'));
});
