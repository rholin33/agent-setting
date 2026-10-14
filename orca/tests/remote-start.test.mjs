import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ensureOmp, ompSelection } from '../lib/omp-adapter.mjs';
import { parseRemoteRequests, startRemoteRequests } from '../lib/remote-start.mjs';
import { readRemoteSwitches, claimRemoteSetup } from '../lib/remote-switch.mjs';

// 模拟确定性交接：像真实流程一样在投递前领取意图并记录调用；不投递、不结算。
function directStub(calls = [], outcome) {
  return async options => {
    calls.push({ ...options, intent: { ...options.intent } });
    if (options.intent.status === 'prepared') await claimRemoteSetup({ home: options.home, project: options.project, role: options.role, intentId: options.intent.id });
    if (outcome) return outcome(options, calls.length);
    return { decision: 'accepted', revision: options.intent.baseRevision + 1 };
  };
}
import { createPickerState, pickerKey, pickPiModels } from '../lib/model-picker.mjs';
import { projectFiles } from '../lib/team.mjs';

const roles = [{ name: 'coder1', agent: 'codex', model: 'local' }, { name: 'designer', agent: 'omp', model: 'design' }];
const presets = [{ model: 'design' }];

function ompFixture(home, project, role, environment) {
  home = fs.realpathSync(home);
  const selection = { model: 'pay/saved-model', thinking: 'medium' };
  fs.writeFileSync(path.join(home, 'team.json'), JSON.stringify([{ name: role, agent: 'omp', model: 'pay/catalog-model', thinking: 'high' }]));
  fs.writeFileSync(path.join(home, 'omp-models.json'), JSON.stringify({ presets: [], roles: { [role]: selection } }));
  const id = createHash('sha256').update(project + '\0' + role).digest('hex').slice(0, 16);
  const adapterConfig = path.join(home, 'remote-master', 'runtime', `omp-${id}`, 'adapter.json');
  fs.mkdirSync(path.dirname(adapterConfig), { recursive: true });
  const endpoint = { runtime: 'omp', role, environment: 'local', terminal: 'term_target', incarnation: 'inc-target', session: 'native-target', adapterConfig };
  const bound = { project, role, ...selection, environment, endpoint, host_identity: { sessionId: endpoint.session },
    terminals: { guest: { handle: endpoint.terminal, incarnation: endpoint.incarnation } } };
  fs.writeFileSync(adapterConfig, JSON.stringify(bound), { mode: 0o600 });
  const terminal = { handle: endpoint.terminal, incarnationId: endpoint.incarnation, agentIdentity: 'omp', sessionId: endpoint.session,
    connected: true, writable: true, executionHostId: 'local', worktreePath: project };
  return { endpoint, terminal, bound, selection, ensureOmp: async () => endpoint };
}
test('remote cycle works independently of locked Codex model and supports off', () => {
  let state = createPickerState({ roles, presets });
  state = pickerKey(state, 'remote-next').state;
  assert.equal(state.rows[0].remote, 'codex');
  assert.equal(state.rows[0].model, 'local');
  state = pickerKey(state, 'remote-next').state;
  assert.equal(state.rows[0].remote, 'omp');
  state = pickerKey(state, 'remote-next').state;
  assert.equal(state.rows[0].remote, null);
});

test('picker returns selected Codex remote row and discards cancelled requests', async () => {
  async function run(keys) {
    const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, pause() {}, resume() {}, setEncoding() {} });
    const promise = pickPiModels({ roles, presets, stdin, stdout: { isTTY: true, write() {} } });
    stdin.emit('data', keys);
    return await promise;
  }
  const selection = await run('r\r');
  assert.equal(selection.coder1.remote, 'codex');
  assert.equal(selection.designer.remote, undefined);
  assert.equal(await run('r\u001b'), null);
});

test('remote CLI rejects unsupported runtime, unknown role, duplicates and malformed inputs', () => {
  assert.deepEqual(parseRemoteRequests(['codex:coder1', 'omp:designer'], ['coder1', 'designer']), [
    { runtime: 'codex', role: 'coder1' }, { runtime: 'omp', role: 'designer' },
  ]);
  assert.deepEqual(parseRemoteRequests(['off:coder1'], ['coder1']), [{ runtime: null, role: 'coder1' }]);
  for (const value of ['claude:coder1', 'omp:nope', 'codex', 'codex:coder1;pwd']) {
    assert.throws(() => parseRemoteRequests([value], ['coder1']));
  }
  assert.throws(() => parseRemoteRequests(['codex:coder1', 'omp:coder1'], ['coder1']), /Duplicate/);
});

test('ambiguous direct delivery keeps the source owner and is never resent', async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-launch-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = fs.realpathSync(home);
  const requests = [{ runtime: 'omp', role: 'designer' }];
  const omp = ompFixture(home, project, 'designer', 'claude');
  let ensured = 0;
  let created = 0;
  const cli = async args => {
    if (args[1] === 'list') return { terminals: [] };
    if (args[1] === 'show' && args[3] === 'term_target') return { terminal: omp.terminal };
    if (args[1] === 'show') return { terminal: { handle: 'term_source', connected: true, writable: true, incarnationId: 'inc-source', agentIdentity: 'codex', sessionId: 'native-source', worktreePath: project } };
    if (args[1] === 'create') { created++; throw new Error('ambiguous create'); }
    throw new Error(`Unexpected mutation: ${args[1]}`);
  };
  const direct = [];
  const args = { home, requests, project, environment: 'claude', sourceHandle: 'term_source', cli,
    ensureOmp: async () => { ensured++; return omp.endpoint; }, skill: new URL('../lib/remote-start.mjs', import.meta.url).pathname,
    runDirectHandoff: directStub(direct, (_, call) => { throw new Error(call === 1 ? 'ambiguous delivery' : 'still waiting'); }) };
  await assert.rejects(startRemoteRequests(args), /ambiguous delivery/);
  const first = readRemoteSwitches({ home, project }).roles.designer;
  assert.equal(first.owner.terminal, 'term_source');
  assert.equal(first.runtime, null);
  assert.equal(first.pending.status, 'setup_uncertain');
  // 再次运行只继续等待回执：不重新接入、不新建意图、不打开协调终端。
  await assert.rejects(startRemoteRequests(args), /still waiting/);
  assert.equal(created, 0);
  assert.equal(ensured, 1);
  assert.equal(direct.length, 2);
  assert.equal(direct[1].intent.status, 'setup_uncertain');
  assert.equal(direct[1].intent.id, first.pending.id);
  const retained = readRemoteSwitches({ home, project }).roles.designer;
  assert.equal(retained.pending.id, first.pending.id);
  assert.equal(retained.taskId, first.taskId);
});

test('missing or unproven business source never opens a setup or updates ownership', async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-source-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = fs.realpathSync(home);
  const base = { home, project, requests: [{ runtime: 'codex', role: 'master' }], skill: new URL('../lib/remote-start.mjs', import.meta.url).pathname };
  let created = 0;
  const cli = async args => {
    if (args[1] === 'list') return { terminals: [] };
    if (args[1] === 'show') return { terminal: { connected: true, writable: true, incarnationId: 'inc', agentIdentity: 'omp', worktreePath: project } };
    created++;
  };
  await assert.rejects(startRemoteRequests({ ...base, cli }), /source/);
  await assert.rejects(startRemoteRequests({ ...base, cli, sourceHandle: 'term_unproven' }), /session/);
  assert.equal(created, 0);
  assert.deepEqual(readRemoteSwitches({ home, project }).roles, {});
});

test('Codex-only group still opens remote picker without rewriting role configuration', async t => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { syncModels } = await import('../lib/model-sync.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-codex-only-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const catalog = JSON.stringify([roles[0]]);
  fs.writeFileSync(path.join(home, 'team.json'), catalog);
  fs.writeFileSync(path.join(home, 'config.toml'), 'model="local"\n');
  const requests = [];
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, pause() {}, setEncoding() {}, resume() { queueMicrotask(() => this.emit('data', 'rr\r')); } });
  await syncModels({ home, codexHome: home, stdin, stdout: { isTTY: true, write() {} }, remoteRequests: requests });
  assert.deepEqual(requests, [{ runtime: 'omp', role: 'coder1' }]);
  assert.equal(fs.readFileSync(path.join(home, 'team.json'), 'utf8'), catalog);
});

for (const scenario of ['verified', 'focus-failed', 'wrong-live-path', 'changed-process', 'wrong-header']) {
  test(`OMP source without renderer metadata: ${scenario}`, async t => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-native-session-')));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const project = home;
    const omp = ompFixture(home, project, 'archi');
    const transcriptPath = path.join(home, 'conversation.jsonl');
    fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'title', text: 'fixture' }) + '\n' +
      JSON.stringify({ type: 'session', id: scenario === 'wrong-header' ? 'other' : 'native-archi', cwd: project }) + '\n');
    const saved = { agent: 'omp', tabId: 'tab', leafId: 'leaf', session: { id: 'native-archi', transcriptPath } };
    const statePath = projectFiles(home, project).state;
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ agents: { archi: saved } }));
    const terminal = { handle: 'term_archi', tabId: 'tab', leafId: 'leaf', connected: true, writable: true,
      incarnationId: 'epoch', ptyId: 'pty', agentIdentity: 'omp', executionHostId: 'local', worktreePath: project };
    let created = 0;
    const cli = async args => {
      if (args[1] === 'list') return { terminals: [terminal] };
      if (args[1] === 'show' && args[3] === 'term_target') return { terminal: omp.terminal };
      if (args[1] === 'show') return { terminal };
      if (args[1] === 'create') { created++; return { terminal: { handle: 'setup' } }; }
      if (args[1] === 'switch') {
        assert.equal(args[args.indexOf('--terminal') + 1], 'setup');
        if (scenario === 'focus-failed') throw new Error('navigation unavailable');
        return {};
      }
      throw new Error('Unexpected runtime mutation');
    };
    const inspect = async () => ({ kind: 'agent', sessionPaths: [scenario === 'wrong-live-path' ? path.join(home, 'other.jsonl') : transcriptPath],
      terminal: { ...terminal, incarnationId: scenario === 'changed-process' ? 'new-epoch' : 'epoch' } });
    // 协调终端只剩远端 Codex 使用，焦点失败场景改用 codex；OMP 走确定性交接。
    const direct = [];
    const args = { home, project, requests: [{ runtime: scenario === 'focus-failed' ? 'codex' : 'omp', role: 'archi' }], cli, inspect, ensureOmp: omp.ensureOmp,
      snapshot: async () => ({}), skill: new URL('../lib/remote-start.mjs', import.meta.url).pathname, runDirectHandoff: directStub(direct) };
    if (scenario === 'verified') {
      await startRemoteRequests(args);
      const entry = readRemoteSwitches({ home, project }).roles.archi;
      assert.equal(entry.pending.source.session, 'native-archi');
      assert.equal(entry.runtime, null);
      assert.equal(created, 0);
      assert.equal(direct.length, 1);
      assert.equal(direct[0].intent.target.terminal, 'term_target');
    } else if (scenario === 'focus-failed') {
      await assert.rejects(startRemoteRequests(args));
      assert.equal(readRemoteSwitches({ home, project }).roles.archi.runtime, null);
      await assert.rejects(startRemoteRequests(args));
      assert.equal(created, 1);
    } else {
      await assert.rejects(startRemoteRequests(args), /conversation/i);
      assert.equal(created, 0);
      assert.deepEqual(readRemoteSwitches({ home, project }).roles, {});
    }
  });
}

function startupFixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omp-menu-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = home, role = 'master';
  const omp = ompFixture(home, project, role);
  const source = { runtime: 'codex', role, environment: 'local', terminal: 'term_source', incarnation: 'inc-source', session: 'native-source' };
  const sourceTerminal = { handle: source.terminal, connected: true, writable: true, incarnationId: source.incarnation,
    agentIdentity: source.runtime, sessionId: source.session, executionHostId: 'local', worktreePath: project };
  const calls = [];
  const cli = async args => {
    calls.push(args);
    if (args[1] === 'list') return { terminals: [] };
    if (args[1] === 'show') return { terminal: args[3] === source.terminal ? sourceTerminal : omp.terminal };
    if (args[1] === 'create') return { terminal: { handle: 'setup' } };
    if (args[1] === 'switch') return {};
    throw new Error('Unexpected runtime action');
  };
  const args = { home, project, requests: [{ runtime: 'omp', role }], sourceHandle: source.terminal, cli,
    ensureOmp: omp.ensureOmp, skill: new URL('../lib/remote-start.mjs', import.meta.url).pathname };
  const registryPath = path.join(projectFiles(home, project).directory, 'remote-switches.json');
  function saveEntry(extra = {}) {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const entry = { owner: source, local: source, runtime: null, taskId: 'task-1',
      ledgerDirectory: path.join(path.dirname(registryPath), 'remote-handoffs', role), ...extra };
    fs.writeFileSync(registryPath, JSON.stringify({ version: 1, roles: { [role]: entry } }));
    return entry;
  }
  return { args, omp, source, sourceTerminal, calls, saveEntry };
}

test('OMP readiness runs after source proof using saved selection and persists the fixed target before handoff', async t => {
  const f = startupFixture(t);
  let ensured = 0;
  const direct = [];
  await startRemoteRequests({ ...f.args, runDirectHandoff: directStub(direct, options => {
    assert.equal(options.intent.adapterConfig, f.omp.endpoint.adapterConfig);
    const entry = readRemoteSwitches(f.args).roles.master;
    assert.equal(entry.pending.adapterConfig, f.omp.endpoint.adapterConfig);
    assert.deepEqual(entry.owner, f.source);
    assert.equal(entry.runtime, null);
    return { decision: 'accepted', revision: 1 };
  }), ensureOmp: async request => {
    ensured++;
    assert.deepEqual({ model: request.model, thinking: request.thinking }, f.omp.selection);
    assert(f.calls.some(args => args[1] === 'show' && args[3] === f.source.terminal));
    assert.deepEqual(readRemoteSwitches(f.args).roles, {});
    return f.omp.endpoint;
  } });
  assert.equal(ensured, 1);
  const entry = readRemoteSwitches(f.args).roles.master;
  const { adapterConfig, ...target } = f.omp.endpoint;
  assert.deepEqual(entry.pending.target, target);
  assert.equal(entry.pending.adapterConfig, adapterConfig);
  assert.equal(entry.pending.status, 'setup_uncertain');
  assert.deepEqual(entry.owner, f.source);
  assert.equal(entry.runtime, null);
  assert.equal(direct.length, 1);
  assert.equal(direct[0].intent.status, 'prepared');
  assert.equal(f.calls.filter(args => args[1] === 'create').length, 0);
});

for (const scenario of ['unready', 'wrong-role', 'wrong-runtime', 'remote-host', 'wrong-project', 'wrong-incarnation', 'wrong-session', 'wrong-binding', 'public-config']) {
  test(`OMP ${scenario} cannot begin a switch or mutate source`, async t => {
    const f = startupFixture(t);
    if (scenario === 'wrong-role') f.omp.endpoint.role = 'other';
    if (scenario === 'wrong-runtime') f.omp.endpoint.runtime = 'codex';
    if (scenario === 'remote-host') f.omp.terminal.executionHostId = 'remote';
    if (scenario === 'wrong-project') f.omp.terminal.worktreePath = path.dirname(f.args.project);
    if (scenario === 'wrong-incarnation') f.omp.terminal.incarnationId = 'other';
    if (scenario === 'wrong-session') f.omp.terminal.sessionId = 'other';
    if (scenario === 'wrong-binding') fs.writeFileSync(f.omp.endpoint.adapterConfig, JSON.stringify({ ...f.omp.bound, model: 'pay/other' }));
    if (scenario === 'public-config') fs.chmodSync(f.omp.endpoint.adapterConfig, 0o644);
    await assert.rejects(startRemoteRequests({ ...f.args, ensureOmp: async () => {
      if (scenario === 'unready') throw new Error('not ready');
      return f.omp.endpoint;
    } }));
    assert.deepEqual(readRemoteSwitches(f.args).roles, {});
    assert(f.calls.every(args => ['list', 'show'].includes(args[1])));
  });
}

test('OMP preflight failure history survives, and only actual readiness permits new begin', async t => {
  const f = startupFixture(t);
  const failure = { status: 'preflight_failed', intent: { runtime: 'omp' }, reasons: ['previous transport unavailable'] };
  f.saveEntry({ lastSetupOutcome: failure });
  let ensured = 0;
  await assert.rejects(startRemoteRequests({ ...f.args, ensureOmp: async () => { ensured++; throw new Error('still not ready'); } }), /still not ready/);
  const blocked = readRemoteSwitches(f.args).roles.master;
  assert.equal(blocked.pending, undefined);
  assert.deepEqual(blocked.lastSetupOutcome, failure);
  await startRemoteRequests({ ...f.args, runDirectHandoff: directStub(), ensureOmp: async () => { ensured++; return f.omp.endpoint; } });
  const ready = readRemoteSwitches(f.args).roles.master;
  assert.equal(ensured, 2);
  assert.equal(ready.pending.status, 'setup_uncertain');
  assert.deepEqual(ready.lastSetupOutcome, failure);
});

test('matching OMP owner proves its adapter before reuse without starting another setup', async t => {
  const f = startupFixture(t);
  const { adapterConfig, ...owner } = f.omp.endpoint;
  f.saveEntry({ runtime: 'omp', owner, adapterConfig });
  const before = readRemoteSwitches(f.args);
  let ensured = 0, verified = 0;
  const result = await startRemoteRequests({ ...f.args, sourceHandle: undefined,
    ensureOmp: async request => {
      ensured++;
      assert.deepEqual(request, { home: f.args.home, project: f.args.project, role: 'master',
        ...f.omp.selection, environment: f.omp.bound.environment });
      return f.omp.endpoint;
    },
    verifyOmp: async proof => {
      verified++;
      assert.deepEqual(proof, { home: f.args.home, project: f.args.project, role: 'master', config: adapterConfig, endpoint: owner });
    } });
  assert.deepEqual(result, { reused: true });
  assert.equal(ensured, 1);
  assert.equal(verified, 1);
  assert.deepEqual(readRemoteSwitches(f.args), before);
  assert.equal(f.calls.filter(args => args[1] === 'create').length, 0);
  assert.deepEqual(f.calls.at(-1), ['terminal', 'switch', '--terminal', owner.terminal]);
});

test('unproven original return blocks OMP ensure even with a proven current owner', async t => {
  const f = startupFixture(t);
  const owner = { ...f.source, terminal: 'current', session: 'current-session', incarnation: 'current-inc' };
  f.saveEntry({ owner, runtime: 'codex' });
  let ensured = false;
  const cli = async args => args[1] === 'show' && args[3] === owner.terminal
    ? { terminal: { ...f.sourceTerminal, handle: owner.terminal, sessionId: owner.session, incarnationId: owner.incarnation } }
    : args[1] === 'show' ? { terminal: { ...f.sourceTerminal, connected: false } } : { terminals: [] };
  await assert.rejects(startRemoteRequests({ ...f.args, sourceHandle: undefined, cli,
    ensureOmp: async () => { ensured = true; return f.omp.endpoint; } }), /unavailable/);
  assert.equal(ensured, false);
  assert.equal(readRemoteSwitches(f.args).roles.master.pending, undefined);
});

test('saved OMP role selection wins; catalog selection is explicit, never first preset fallback', t => {
  const f = startupFixture(t);
  assert.deepEqual(ompSelection(f.args.home, 'master'), f.omp.selection);
  fs.writeFileSync(path.join(f.args.home, 'omp-models.json'), JSON.stringify({ presets: [{ model: 'pay/guess', thinking: 'low' }], roles: {} }));
  assert.deepEqual(ompSelection(f.args.home, 'master'), { model: 'pay/catalog-model', thinking: 'high' });
  fs.writeFileSync(path.join(f.args.home, 'team.json'), JSON.stringify([{ name: 'master', agent: 'codex', model: 'local', thinking: 'high' }]));
  assert.throws(() => ompSelection(f.args.home, 'master'), /no model fallback/);
});

test('adapter wrapper calls fixed Python CLI with private scoped request and no ambient remote host', async t => {
  const f = startupFixture(t);
  let requestPath;
  const request = { home: f.args.home, project: f.args.project, role: 'master', ...f.omp.selection, environment: 'paired-host' };
  const result = await ensureOmp(request, async (executable, args, options) => {
    assert.equal(executable, 'python3');
    assert.deepEqual(args.slice(0, 3), [path.join(request.home, 'remote-master', 'omp_adapter.py'), 'ensure', '--request']);
    requestPath = args[3];
    assert.equal(path.dirname(requestPath), path.join(projectFiles(request.home, request.project).directory, 'runtime', request.role, 'omp'));
    assert.equal(fs.statSync(requestPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(requestPath)).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(fs.readFileSync(requestPath, 'utf8')), request);
    assert.equal(options.env.ORCA_ENVIRONMENT, undefined);
    assert.equal(options.env.ORCA_PAIRING_CODE, undefined);
    return { stdout: JSON.stringify(f.omp.endpoint) };
  });
  assert.deepEqual(result, f.omp.endpoint);
  assert.equal(fs.existsSync(requestPath), false);
});

test('OMP source proof failure never invokes ensure', async t => {
  const f = startupFixture(t);
  f.sourceTerminal.sessionId = undefined;
  let ensured = false;
  await assert.rejects(startRemoteRequests({ ...f.args, ensureOmp: async () => { ensured = true; return f.omp.endpoint; } }), /session/);
  assert.equal(ensured, false);
  assert.deepEqual(readRemoteSwitches(f.args).roles, {});
});

test('even a prepared pending OMP intent blocks provisioning and duplicate startup', async t => {
  const f = startupFixture(t);
  const entry = f.saveEntry();
  const { adapterConfig, ...target } = f.omp.endpoint;
  const pending = { id: 'existing', taskId: entry.taskId, ledgerDirectory: entry.ledgerDirectory,
    runtime: 'omp', source: entry.owner, local: entry.local, target, adapterConfig,
    environment: null, baseRevision: 0, baseRecordId: null, status: 'prepared' };
  f.saveEntry({ pending });
  let ensured = false;
  await assert.rejects(startRemoteRequests({ ...f.args, ensureOmp: async () => { ensured = true; return f.omp.endpoint; } }), /unresolved/);
  assert.equal(ensured, false);
  assert.deepEqual(readRemoteSwitches(f.args).roles.master.pending, pending);
  assert.equal(f.calls.filter(args => args[1] === 'create').length, 0);
});

test('historical failure still blocks Codex requests without invoking OMP ensure', async t => {
  const f = startupFixture(t);
  f.saveEntry({ lastSetupOutcome: { status: 'preflight_failed', intent: { runtime: 'omp' }, reasons: ['retained failure'] } });
  await assert.rejects(startRemoteRequests({ ...f.args, requests: [{ runtime: 'codex', role: 'master' }],
    ensureOmp: async () => { throw new Error('must not ensure'); } }), { code: 'REMOTE_PREFLIGHT_FAILED' });
  assert.equal(f.calls.length, 0);
});

for (const mode of ['failure', 'malformed']) {
  test(`adapter ${mode} removes private request without exposing subprocess output`, async t => {
    const f = startupFixture(t);
    let requestPath;
    await assert.rejects(ensureOmp({ home: f.args.home, project: f.args.project, role: 'master', ...f.omp.selection }, async (_exe, args) => {
      requestPath = args[3];
      if (mode === 'failure') throw new Error('sensitive subprocess output');
      return { stdout: 'not JSON' };
    }), error => !error.message.includes('sensitive') && /original owner retained/.test(error.message));
    assert.equal(fs.existsSync(requestPath), false);
  });
}

test('typed readiness failures expose actionable reasons but never raw transport secrets', async t => {
  const f = startupFixture(t);
  for (const code of ['thinking_busy', 'unrecognized_code']) {
    await assert.rejects(ensureOmp({ home: f.args.home, project: f.args.project, role: 'master', ...f.omp.selection }, async () => {
      throw Object.assign(new Error('private-transport-token'), {
        stderr: `OMP adapter failed: RuntimeError: OMP_READINESS:${code}\nprivate-transport-token`,
      });
    }), error => !error.message.includes('private-transport-token') &&
      (code === 'thinking_busy' ? error.message.includes('busy') : error.message.includes('Reconcile')));
  }
});

for (const runtime of ['omp', null]) {
  test(`native owner reconnects before ${runtime ?? 'off'} without using the original local transcript as remote proof`, async t => {
    const f = startupFixture(t);
    const { adapterConfig, ...owner } = f.omp.endpoint;
    const initial = f.saveEntry({ runtime: 'omp', owner, adapterConfig });
    fs.mkdirSync(initial.ledgerDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(initial.ledgerDirectory, 'state.json'), JSON.stringify({ [initial.taskId]: {
      id: 'accepted-forward', task_id: initial.taskId, revision: 1, status: 'accepted',
      worktree: f.args.project, source: f.source, target: owner,
    } }), { mode: 0o600 });
    fs.writeFileSync(projectFiles(f.args.home, f.args.project).state, JSON.stringify({ agents: { master: {
      agent: f.source.runtime, handle: f.source.terminal, incarnationId: f.source.incarnation,
      session: { id: f.source.session, transcriptPath: path.join(f.args.home, 'unavailable-local-history.jsonl') },
    } } }));
    f.omp.endpoint.terminal = 'reconnected-native-ui';
    f.omp.endpoint.incarnation = 'reconnected-incarnation';
    Object.assign(f.omp.terminal, { handle: f.omp.endpoint.terminal, incarnationId: f.omp.endpoint.incarnation });
    f.omp.bound.terminals.guest = { handle: f.omp.endpoint.terminal, incarnation: f.omp.endpoint.incarnation };
    fs.writeFileSync(adapterConfig, JSON.stringify(f.omp.bound));
    const { adapterConfig: _config, ...target } = f.omp.endpoint;
    let ensured = 0, verified = 0, inspected = 0;
    const direct = [];
    const result = await startRemoteRequests({ ...f.args, sourceHandle: undefined, requests: [{ role: 'master', runtime }], runDirectHandoff: directStub(direct),
      ensureOmp: async request => {
        ensured++;
        assert.deepEqual({ model: request.model, thinking: request.thinking }, f.omp.selection);
        return f.omp.endpoint;
      },
      verifyOmp: async proof => {
        verified++;
        assert.deepEqual(proof, { home: f.args.home, project: f.args.project, role: 'master', config: adapterConfig, endpoint: target });
      },
      inspect: async () => { inspected++; throw new Error('local transcript is not remote session proof'); } });
    assert.equal(ensured, 1);
    assert.equal(verified, 1);
    assert.equal(inspected, 0);
    const entry = readRemoteSwitches(f.args).roles.master;
    assert.deepEqual(entry.owner, target);
    assert.deepEqual(entry.local, f.source);
    const record = JSON.parse(fs.readFileSync(path.join(initial.ledgerDirectory, 'state.json'), 'utf8'))[initial.taskId];
    assert.deepEqual(record.owner_rebindings, [{ previous: owner, current: target }]);
    assert.equal(entry.owner.session, owner.session);
    assert.equal(entry.runtime, 'omp');
    assert.equal(entry.adapterConfig, adapterConfig);
    if (runtime === 'omp') {
      assert.deepEqual(result, { reused: true });
      assert.equal(entry.pending, undefined);
      assert.equal(f.calls.filter(args => args[1] === 'create').length, 0);
      assert.deepEqual(f.calls.at(-1), ['terminal', 'switch', '--terminal', target.terminal]);
    } else {
      assert.deepEqual(entry.pending.source, target);
      assert.deepEqual(entry.pending.local, f.source);
      assert.equal(entry.pending.runtime, null);
      assert.equal(entry.pending.status, 'setup_uncertain');
      assert.equal(f.calls.filter(args => args[1] === 'create').length, 0);
      // 切回本机时从远端 OMP 读取新进展。
      assert.equal(direct[0].sourceAdapterConfig, adapterConfig);
      // 再次运行只继续等待原投递的回执，不重新接入、不新建意图。
      await startRemoteRequests({ ...f.args, sourceHandle: undefined, requests: [{ role: 'master', runtime }], runDirectHandoff: directStub(direct),
        ensureOmp: async () => { ensured++; return f.omp.endpoint; } });
      assert.equal(ensured, 1);
      assert.equal(direct.length, 2);
      assert.equal(direct[1].intent.id, entry.pending.id);
      assert.equal(direct[1].intent.status, 'setup_uncertain');
      assert.equal(f.calls.filter(args => args[1] === 'create').length, 0);
    }
  });
}

for (const runtime of ['omp', null]) {
  test(`failed native owner proof prevents ${runtime ?? 'off'} focus or setup`, async t => {
    const f = startupFixture(t);
    const { adapterConfig, ...owner } = f.omp.endpoint;
    f.saveEntry({ runtime: 'omp', owner, adapterConfig });
    const before = readRemoteSwitches(f.args), unavailable = new Error('native owner proof failed');
    let ensured = 0, verified = 0;
    await assert.rejects(startRemoteRequests({ ...f.args, sourceHandle: undefined, requests: [{ role: 'master', runtime }],
      ensureOmp: async () => { ensured++; return f.omp.endpoint; },
      verifyOmp: async proof => {
        assert.deepEqual(proof, { home: f.args.home, project: f.args.project, role: 'master', config: adapterConfig, endpoint: owner });
        verified++;
        throw unavailable;
      } }), error => error === unavailable);
    assert.equal(ensured, 1);
    assert.equal(verified, 1);
    assert.deepEqual(readRemoteSwitches(f.args), before);
    assert.ok(f.calls.every(args => ['show', 'list'].includes(args[1])));
  });
}
