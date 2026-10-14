import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { projectFiles } from '../lib/team.mjs';
import { beginRemoteSwitch, claimRemoteSetup, commitRemoteSwitch, rejectRemoteSwitch, readRemoteSwitches, reattachOmpOwner } from '../lib/remote-switch.mjs';

function pythonJson(value) {
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}: ${pythonJson(value[key])}`).join(', ')}}`;
  return JSON.stringify(value);
}
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orca-remote-switch-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), project = path.join(root, 'workspace');
  fs.mkdirSync(home); fs.mkdirSync(project);
  const local = { runtime: 'pi', role: 'master', environment: 'local', terminal: 'local-master', incarnation: 'local-1', session: 'local-session' };
  const remote = { runtime: 'codex', role: 'master', environment: 'local', terminal: 'remote-client', incarnation: 'remote-1', session: 'remote-session' };
  const options = { home, project, role: 'master' };
  const request = { ...options, runtime: 'codex', source: local, local, environment: 'model-server' };
  const calls = [], terminals = new Map();
  const setTerminal = endpoint => terminals.set(endpoint.terminal, {
    handle: endpoint.terminal, incarnationId: endpoint.incarnation, connected: true, writable: true,
    worktreePath: project, executionHostId: endpoint.environment, agentIdentity: endpoint.runtime,
    providerSession: { id: endpoint.session },
  });
  setTerminal(local); setTerminal(remote);
  const cli = async args => {
    calls.push(args);
    if (args[1] === 'list') return { terminals: [...terminals.values()] };
    assert.deepEqual(args.slice(0, 3), ['terminal', 'show', '--terminal']);
    return { terminal: terminals.get(args[3]) };
  };
  const state = () => readRemoteSwitches(options);
  const settle = intent => ({ ...options, intentId: intent.id, cli });
  const record = (intent, target = remote, decision = 'accepted') => {
    const entry = {
      id: randomUUID(), task_id: intent.taskId, revision: intent.baseRevision + 1,
      previous: intent.baseRecordId, source: intent.source, target, worktree: project,
      summary: { goal: '继续当前任务', constraints: ['不改权限'], completed: ['已检查'], changed_files: [], decisions: [], verification: [], pending: ['等待用户'], inflight: [] },
      status: decision,
    };
    sign(entry);
    entry.receipt = { origin: 'assistant_turn', decision, id: entry.id, sha256: entry.sha256, target, reply: 'HANDOFF_ACCEPTED: 已接收，等待下一步指令。' };
    return entry;
  };
  const save = (intent, entry) => fs.writeFileSync(path.join(intent.ledgerDirectory, 'state.json'), JSON.stringify({ [intent.taskId]: entry }), { mode: 0o600 });
  return { ...options, options, request, local, remote, calls, terminals, setTerminal, cli, state, settle, record, save };
}
function nativeFixture(t) {
  const f = fixture(t);
  const remote = { ...f.remote, runtime: 'omp' };
  f.setTerminal(remote);
  const selection = { model: 'pay/saved-model', thinking: 'medium' };
  fs.writeFileSync(path.join(f.home, 'team.json'), JSON.stringify([{ name: f.role, agent: 'omp', ...selection }]));
  const id = createHash('sha256').update(f.project + '\0' + f.role).digest('hex').slice(0, 16);
  const adapterConfig = path.join(f.home, 'remote-master', 'runtime', `omp-${id}`, 'adapter.json');
  fs.mkdirSync(path.dirname(adapterConfig), { recursive: true, mode: 0o700 });
  fs.writeFileSync(adapterConfig, JSON.stringify({ project: f.project, role: f.role, ...selection,
    environment: f.request.environment, endpoint: { ...remote, adapterConfig },
    host_identity: { sessionId: remote.session },
    terminals: { guest: { handle: remote.terminal, incarnation: remote.incarnation } } }), { mode: 0o600 });
  const proofs = [];
  const verifyOmp = async proof => {
    assert.deepEqual(proof, { ...f.options, config: adapterConfig, endpoint: remote });
    proofs.push(proof);
  };
  return { ...f, remote, adapterConfig, proofs, verifyOmp,
    request: { ...f.request, runtime: 'omp', target: remote, adapterConfig },
    settle: intent => ({ ...f.settle(intent), verifyOmp }),
    record: (intent, target = remote, decision = 'accepted') => f.record(intent, target, decision) };
}
function sign(record) {
  const payload = Object.fromEntries(['task_id', 'revision', 'source', 'target', 'worktree', 'summary'].map(key => [key, record[key]]));
  record.sha256 = createHash('sha256').update(pythonJson(payload)).digest('hex');
  if (record.receipt) Object.assign(record.receipt, { id: record.id, sha256: record.sha256, target: record.target });
}
async function acceptedRemote(f) {
  const intent = await beginRemoteSwitch(f.request);
  await claimRemoteSetup(f.settle(intent));
  f.save(intent, f.record(intent));
  await commitRemoteSwitch(f.settle(intent));
  return intent;
}

test('absent registry is empty without creating directories; prepared intent is private and reusable', async t => {
  const f = fixture(t);
  assert.deepEqual(f.state(), { version: 1, roles: {} });
  assert.equal(fs.existsSync(projectFiles(f.home, f.project).directory), false);
  const intent = await beginRemoteSwitch(f.request);
  assert.equal(intent.status, 'prepared');
  assert.equal(intent.baseRevision, 0);
  assert.deepEqual(f.state().roles.master.owner, f.local);
  assert.equal(f.state().roles.master.runtime, null);
  assert.deepEqual(await beginRemoteSwitch(f.request), intent);
  assert.equal(intent.environment, 'model-server');
  assert.equal(intent.source.environment, 'local');
  const files = projectFiles(f.home, f.project);
  if (process.platform !== 'win32') {
    for (const directory of [files.directory, path.dirname(intent.ledgerDirectory), intent.ledgerDirectory]) assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(files.directory, 'remote-switches.json')).mode & 0o777, 0o600);
  }
  assert.equal(fs.existsSync(files.lock), false);
});

test('claim is at-most-once across registry reloads and unknown handoff never changes owner', async t => {
  const f = fixture(t), intent = await beginRemoteSwitch(f.request);
  assert.equal((await claimRemoteSetup(f.settle(intent))).status, 'setup_uncertain');
  assert.equal((await beginRemoteSwitch(f.request)).id, intent.id);
  await assert.rejects(claimRemoteSetup(f.settle(intent)), /already claimed/);
  await assert.rejects(beginRemoteSwitch({ ...f.request, runtime: 'omp', target: { ...f.remote, runtime: 'omp' },
    adapterConfig: path.join(f.home, 'adapter.json') }));
  await assert.rejects(beginRemoteSwitch({ ...f.request, environment: 'another-server' }), /unresolved/);
  await assert.rejects(commitRemoteSwitch(f.settle(intent)), /fresh handoff/);
  await assert.rejects(rejectRemoteSwitch({ ...f.settle(intent), force: true }), /fresh handoff/);
  const record = f.record(intent); record.status = 'delivery_uncertain'; f.save(intent, record);
  await assert.rejects(commitRemoteSwitch(f.settle(intent)), /fresh handoff/);
  await assert.rejects(rejectRemoteSwitch(f.settle(intent)), /fresh handoff/);
  assert.deepEqual(f.state().roles.master.owner, f.local);
  assert.equal(f.state().roles.master.pending.status, 'setup_uncertain');
  assert.equal(f.calls.length, 0);
});

test('accepted forward and return handoffs retain the exact original local agent', async t => {
  const f = fixture(t), first = await acceptedRemote(f);
  assert.deepEqual(f.state().roles.master.owner, f.remote);
  assert.deepEqual(f.state().roles.master.local, f.local);
  assert.equal(f.state().roles.master.runtime, 'codex');
  assert.equal(f.state().roles.master.pending, undefined);
  assert.ok(f.calls.every(args => !args.includes('--environment')));
  await assert.rejects(beginRemoteSwitch(f.request), /owner changed/);
  const back = await beginRemoteSwitch({ ...f.request, runtime: null, source: f.remote, environment: undefined });
  assert.equal(back.taskId, first.taskId);
  assert.equal(back.ledgerDirectory, first.ledgerDirectory);
  assert.equal(back.baseRevision, 1);
  assert.equal(back.environment, null);
  await claimRemoteSetup(f.settle(back));
  await assert.rejects(commitRemoteSwitch(f.settle(back)), /fresh handoff/);
  f.save(back, f.record(back, f.local));
  await commitRemoteSwitch(f.settle(back));
  assert.deepEqual(f.state().roles.master.owner, f.local);
  assert.equal(f.state().roles.master.runtime, null);
  await assert.rejects(commitRemoteSwitch(f.settle(back)), /intent does not match/);
});

test('rejected assistant decision preserves source and permits a new revision', async t => {
  const f = fixture(t), intent = await beginRemoteSwitch(f.request);
  await claimRemoteSetup(f.settle(intent));
  f.save(intent, f.record(intent, f.remote, 'rejected'));
  await assert.rejects(commitRemoteSwitch(f.settle(intent)), /fresh handoff/);
  await rejectRemoteSwitch(f.settle(intent));
  assert.deepEqual(f.state().roles.master.owner, f.local);
  assert.equal(f.state().roles.master.pending, undefined);
  const retry = await beginRemoteSwitch(f.request);
  assert.notEqual(retry.id, intent.id);
  assert.equal(retry.baseRevision, 1);
  assert.equal(retry.taskId, intent.taskId);
});

test('only unclaimed prepared intents can be cancelled without a rejected receipt', async t => {
  const f = fixture(t), intent = await beginRemoteSwitch(f.request);
  await rejectRemoteSwitch({ ...f.options, intentId: intent.id });
  assert.deepEqual(f.state().roles.master.owner, f.local);
  const next = await beginRemoteSwitch(f.request);
  f.save(next, f.record(next));
  await assert.rejects(rejectRemoteSwitch(f.settle(next)), /activity prevents/);
  await assert.rejects(commitRemoteSwitch(f.settle(next)), /not claimed/);
  assert.equal(f.state().roles.master.pending.id, next.id);
});

const invalidRecords = {
  'input echo': record => { record.receipt.origin = 'terminal_echo'; },
  'wrong decision': record => { record.receipt.decision = 'rejected'; },
  'wrong receipt ID': record => { record.receipt.id = randomUUID(); },
  'wrong receipt digest': record => { record.receipt.sha256 = '0'.repeat(64); },
  'wrong receipt target': record => { record.receipt.target = { ...record.target, session: 'other-session' }; },
  'empty acknowledgement': record => { record.receipt.reply = ''; },
  'altered context': record => { record.summary.goal = '伪造上下文'; },
  'old revision': record => { record.revision = 0; sign(record); },
  'skipped revision': record => { record.revision = 2; sign(record); },
  'another task': record => { record.task_id = randomUUID(); sign(record); },
  'another workspace': record => { record.worktree += '-other'; sign(record); },
  'another role': record => { record.target = { ...record.target, role: 'coder' }; sign(record); },
  'another source': record => { record.source = { ...record.source, session: 'stale-session' }; sign(record); },
  'wrong runtime': record => { record.target = { ...record.target, runtime: 'omp' }; sign(record); },
  'same source and target': record => { record.target = record.source; sign(record); },
  'same pane different session': record => { record.target = { ...record.source, runtime: 'codex', session: 'new' }; sign(record); },
  'inflight actions': record => { record.summary.inflight = ['still running']; sign(record); },
};
for (const [name, mutate] of Object.entries(invalidRecords)) test(`rejects ${name} without changing persisted owner`, async t => {
  const f = fixture(t), intent = await beginRemoteSwitch(f.request);
  await claimRemoteSetup(f.settle(intent));
  const before = f.state();
  const record = f.record(intent); mutate(record); f.save(intent, record);
  await assert.rejects(commitRemoteSwitch(f.settle(intent)));
  assert.deepEqual(f.state(), before);
});

for (const field of ['incarnationId', 'worktreePath', 'agentIdentity', 'providerSession', 'executionHostId', 'connected', 'handle']) {
  test(`refuses changed target ${field}`, async t => {
    const f = fixture(t), intent = await beginRemoteSwitch(f.request);
    await claimRemoteSetup(f.settle(intent)); f.save(intent, f.record(intent));
    f.terminals.get(f.remote.terminal)[field] = field === 'connected' ? false : field === 'providerSession' ? { id: 'restarted-session' } : 'changed';
    await assert.rejects(commitRemoteSwitch(f.settle(intent)), /terminal/);
    assert.deepEqual(f.state().roles.master.owner, f.local);
    assert.equal(f.state().roles.master.pending.id, intent.id);
  });
}

test('refuses restarted source and receipt changes during live terminal verification', async t => {
  const f = fixture(t), intent = await beginRemoteSwitch(f.request);
  await claimRemoteSetup(f.settle(intent)); f.save(intent, f.record(intent));
  f.terminals.get(f.local.terminal).incarnationId = 'restarted';
  await assert.rejects(commitRemoteSwitch(f.settle(intent)), /terminal/);
  f.setTerminal(f.local);
  const cli = async args => {
    const result = await f.cli(args);
    if (args[3] === f.remote.terminal) f.save(intent, f.record(intent));
    return result;
  };
  await assert.rejects(commitRemoteSwitch({ ...f.settle(intent), cli }), /ledger changed/);
  assert.deepEqual(f.state().roles.master.owner, f.local);
});

test('return target must be exact original local identity, not a fresh local session', async t => {
  const f = fixture(t); await acceptedRemote(f);
  const intent = await beginRemoteSwitch({ ...f.request, runtime: null, source: f.remote });
  await claimRemoteSetup(f.settle(intent));
  f.save(intent, f.record(intent, { ...f.local, session: 'replacement' }));
  await assert.rejects(commitRemoteSwitch(f.settle(intent)), /requested owner/);
  assert.deepEqual(f.state().roles.master.owner, f.remote);
  await assert.rejects(beginRemoteSwitch({ ...f.request, runtime: null, source: f.remote, local: { ...f.local, session: 'replacement' } }), /owner changed/);
});

test('remote TUI host is verified separately from model host', async t => {
  const f = fixture(t), target = { ...f.remote, environment: 'tui-host' };
  f.setTerminal(target);
  const intent = await beginRemoteSwitch(f.request);
  await claimRemoteSetup(f.settle(intent)); f.save(intent, f.record(intent, target));
  await commitRemoteSwitch(f.settle(intent));
  assert.deepEqual(f.calls[0], ['terminal', 'show', '--terminal', f.local.terminal]);
  assert.deepEqual(f.calls[1], ['terminal', 'show', '--terminal', target.terminal, '--environment', 'tui-host']);
  assert.equal(f.state().roles.master.owner.environment, 'tui-host');
  assert.equal(intent.environment, 'model-server');
});

test('workspace and role ledger scopes cannot be shared or overridden', async t => {
  const f = fixture(t), first = await beginRemoteSwitch(f.request);
  const project = path.join(path.dirname(f.project), 'other-workspace'); fs.mkdirSync(project);
  const other = await beginRemoteSwitch({ ...f.request, project });
  assert.notEqual(first.ledgerDirectory, other.ledgerDirectory);
  assert.notEqual(first.taskId, other.taskId);
  await claimRemoteSetup({ ...f.options, project, intentId: other.id });
  f.save(other, f.record(first));
  await assert.rejects(commitRemoteSwitch({ ...f.options, project, intentId: other.id, cli: f.cli }));
  const role = 'coder', local = { ...f.local, role };
  const coder = await beginRemoteSwitch({ ...f.request, role, source: local, local });
  assert.notEqual(coder.ledgerDirectory, first.ledgerDirectory);
  for (const invalid of ['../master', '/master', 'master/other', 'master\\other', '__proto__', '']) {
    await assert.rejects(beginRemoteSwitch({ ...f.request, role: invalid }));
  }
});

test('forged registry ledger path and symlink ledger directories are rejected', async t => {
  const f = fixture(t), intent = await beginRemoteSwitch(f.request);
  const file = path.join(projectFiles(f.home, f.project).directory, 'remote-switches.json');
  const registry = f.state(); registry.roles.master.ledgerDirectory = f.project;
  fs.writeFileSync(file, JSON.stringify(registry));
  assert.throws(() => f.state(), /scope mismatch/);
  registry.roles.master.ledgerDirectory = intent.ledgerDirectory;
  fs.writeFileSync(file, JSON.stringify(registry));
  fs.rmdirSync(intent.ledgerDirectory);
  fs.symlinkSync(f.project, intent.ledgerDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  await claimRemoteSetup(f.settle(intent));
  await assert.rejects(commitRemoteSwitch(f.settle(intent)), /Unsafe remote switch path/);
});

import { abortRemotePreflight, preflightFailureMessage } from '../lib/remote-switch.mjs';
import { startRemoteRequests } from '../lib/remote-start.mjs';
function abortFixture(f, intent) {
  const transcriptPath = path.join(f.home, 'original.jsonl');
  fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'session', id: f.local.session, cwd: f.project }) + '\n');
  const saved = { agent: f.local.runtime, handle: f.local.terminal, incarnationId: f.local.incarnation,
    session: { id: f.local.session, transcriptPath } };
  fs.writeFileSync(projectFiles(f.home, f.project).state, JSON.stringify({ agents: { master: saved } }));
  const report = { schema_version: 1, original_attempt_outcome: 'aborted_before_checkpoint_request_and_before_context_delivery',
    intents: [{ intent_id: intent.id, role: 'master', task_id: intent.taskId, supplied_source: f.local }],
    remote_commit_executed: false, remote_reject_executed: false, target_rejected: 'not_observed',
    technical_stop_reasons: ['Remote OMP transport and project tools not verified'],
    remote_omp_creation: { created_by_this_original_attempt: false, create_or_launch_operation_issued: false, destination_terminal: null, destination_native_session: null },
    delivery: { checkpoint_request_sent_to_either_source: false, checkpoint_request_ids: [], context_delivered_to_any_target: false,
      context_delivery_ids: [], handoff_prepare_called: false, handoff_claim_called: false, handoff_accept_called: false,
      assistant_acceptance_or_rejection_observed: false, receipt: null } };
  const reportFile = path.join(f.home, 'outcome.json');
  const write = () => fs.writeFileSync(reportFile, JSON.stringify(report)); write();
  return { report, write, options: { ...f.settle(intent), reportFile,
    inspect: async () => ({ kind: 'agent', sessionPaths: [transcriptPath], terminal: f.terminals.get(f.local.terminal) }) } };
}

test('preflight history retains its source and report while explicit OMP retries readiness only', async t => {
  const f = nativeFixture(t), intent = await beginRemoteSwitch(f.request);
  await claimRemoteSetup(f.settle(intent));
  const a = abortFixture(f, intent);
  const outcome = await abortRemotePreflight(a.options);
  assert.equal(outcome.status, 'preflight_failed');
  assert.equal(Buffer.from(outcome.reportBase64, 'base64').toString(), fs.readFileSync(a.options.reportFile, 'utf8'));
  const before = f.state(), entry = before.roles.master;
  assert.equal(entry.pending, undefined);
  assert.deepEqual(entry.owner, f.local);
  assert.equal(entry.runtime, null);
  assert.equal(entry.setupOutcomes.length, 1);
  assert.ok(preflightFailureMessage(before, ['master']));
  let ensured = 0;
  const unavailable = new Error('native readiness unavailable');
  const options = { ...f.options, sourceHandle: f.local.terminal, cli: f.cli,
    skill: new URL('../lib/remote-start.mjs', import.meta.url).pathname,
    ensureOmp: async () => { ensured++; throw unavailable; } };
  const requests = [{ role: f.role, runtime: 'omp' }];
  assert.deepEqual(resolvePreflightChoices(before, [f.role], requests), requests);
  await assert.rejects(startRemoteRequests({ ...options, requests }), error => error === unavailable);
  assert.equal(ensured, 1);
  assert.deepEqual(f.state(), before);
  assert.ok(f.calls.every(args => ['show', 'list'].includes(args[1])));
  const readCalls = f.calls.length;
  await assert.rejects(startRemoteRequests({ ...options, requests: [{ role: f.role, runtime: 'codex' }] }),
    { code: 'REMOTE_PREFLIGHT_FAILED' });
  assert.equal(f.calls.length, readCalls);
  assert.equal(ensured, 1);
  assert.deepEqual(f.state(), before);
});

for (const scenario of ['wrong-intent', 'wrong-source', 'delivery', 'checkpoint', 'prepare', 'claim', 'receipt', 'ledger', 'history', 'native', 'incarnation', 'base', 'owner-race']) {
  test(`preflight settlement refuses ${scenario} and preserves pending`, async t => {
    const f = nativeFixture(t), intent = await beginRemoteSwitch(f.request);
    await claimRemoteSetup(f.settle(intent));
    const a = abortFixture(f, intent);
    if (scenario === 'wrong-intent') a.report.intents[0].intent_id = 'other';
    if (scenario === 'wrong-source') a.report.intents[0].supplied_source = { ...f.local, session: 'other' };
    if (scenario === 'delivery') a.report.delivery.context_delivered_to_any_target = true;
    if (scenario === 'checkpoint') a.report.delivery.checkpoint_request_sent_to_either_source = true;
    if (scenario === 'prepare') a.report.delivery.handoff_prepare_called = true;
    if (scenario === 'claim') a.report.delivery.handoff_claim_called = true;
    if (scenario === 'receipt') a.report.delivery.receipt = {};
    if (scenario === 'ledger') f.save(intent, f.record(intent));
    if (scenario === 'history') fs.writeFileSync(path.join(intent.ledgerDirectory, 'previous.json'), '{}');
    if (scenario === 'native') a.options.inspect = async () => ({ kind: 'shell' });
    if (scenario === 'incarnation') f.terminals.get(f.local.terminal).incarnationId = 'other';
    const registryFile = path.join(projectFiles(f.home, f.project).directory, 'remote-switches.json');
    if (scenario === 'base') { const state = f.state(); state.roles.master.pending.baseRevision = 1; fs.writeFileSync(registryFile, JSON.stringify(state)); }
    if (scenario === 'owner-race') { const inspect = a.options.inspect; a.options.inspect = async () => {
      const live = await inspect(); const state = f.state(); state.roles.master.runtime = 'omp'; fs.writeFileSync(registryFile, JSON.stringify(state)); return live;
    }; }
    a.write();
    await assert.rejects(abortRemotePreflight(a.options));
    assert.equal(f.state().roles.master.pending.id, intent.id);
    assert.equal(f.state().roles.master.lastSetupOutcome, undefined);
  });
}

import { resolvePreflightChoices } from '../lib/remote-switch.mjs';
import { syncModels } from '../lib/model-sync.mjs';
import { EventEmitter } from 'node:events';
for (const [keys, expected] of [['\r', 'local'], ['rr\r', 'omp'], ['r\r', 'blocked'], ['\u001b', 'cancelled']]) {
  test(`failed remote preparation still opens menu: ${expected}`, async t => {
    const f = nativeFixture(t), intent = await beginRemoteSwitch(f.request);
    await claimRemoteSetup(f.settle(intent)); const a = abortFixture(f, intent); await abortRemotePreflight(a.options);
    fs.writeFileSync(path.join(f.home, 'team.json'), JSON.stringify([{ name: 'master', agent: 'codex', model: 'local' }]));
    fs.writeFileSync(path.join(f.home, 'config.toml'), 'model="local"\n');
    const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, pause() {}, setEncoding() {},
      resume() { queueMicrotask(() => stdin.emit('data', keys)); } });
    const requests = [], menuResult = {};
    const before = f.state();
    await syncModels({ home: f.home, codexHome: f.home, names: ['master'], stdin,
      stdout: { isTTY: true, write() {} }, confirmRemote: ['master'],
      remoteStates: { master: null }, remoteRequests: requests, menuResult });
    if (expected === 'cancelled') { assert.equal(menuResult.status, 'cancelled'); assert.deepEqual(requests, []); }
    else if (expected === 'local') {
      assert.equal(menuResult.status, 'confirmed'); assert.deepEqual(requests, [{ role: 'master', runtime: null }]);
      // The CLI feeds this empty list into its ordinary local lifecycle branch.
      assert.deepEqual(resolvePreflightChoices(f.state(), ['master'], requests), []);
    } else if (expected === 'omp') {
      assert.deepEqual(requests, [{ role: 'master', runtime: 'omp' }]);
      assert.deepEqual(resolvePreflightChoices(f.state(), ['master'], requests), requests);
    } else {
      assert.deepEqual(requests, [{ role: 'master', runtime: 'codex' }]);
      assert.throws(() => resolvePreflightChoices(f.state(), ['master'], requests), { code: 'REMOTE_PREFLIGHT_FAILED' });
    }
    assert.deepEqual(f.state(), before);
  });
}

for (const field of ['terminal', 'incarnation', 'session', 'environment']) {
  test(`native receipt for another prepared ${field} cannot move ownership`, async t => {
    const f = nativeFixture(t), intent = await beginRemoteSwitch(f.request);
    await claimRemoteSetup(f.settle(intent));
    const different = { ...f.remote, [field]: `different-${field}` };
    f.setTerminal(different);
    const record = f.record(intent, different);
    f.save(intent, record);
    const before = f.state();
    await assert.rejects(commitRemoteSwitch(f.settle(intent)));
    assert.deepEqual(f.state(), before);
    assert.equal(f.proofs.length, 0);
    assert.deepEqual(record.receipt.target, different);
  });
}

for (const direction of ['forward', 'return']) {
  test(`failed live native proof retains the ${direction} owner despite an accepted receipt`, async t => {
    const f = nativeFixture(t);
    if (direction === 'return') await acceptedRemote(f);
    const intent = await beginRemoteSwitch(direction === 'forward' ? f.request : {
      ...f.options, runtime: null, source: f.remote, local: f.local,
    });
    await claimRemoteSetup(f.settle(intent));
    f.save(intent, f.record(intent, direction === 'forward' ? f.remote : f.local));
    const before = f.state(), unavailable = new Error('live native proof unavailable');
    let verified = 0;
    await assert.rejects(commitRemoteSwitch({ ...f.settle(intent), verifyOmp: async proof => {
      assert.deepEqual(proof, { ...f.options, config: f.adapterConfig, endpoint: f.remote });
      verified++;
      throw unavailable;
    } }), error => error === unavailable);
    assert.equal(verified, 1);
    assert.deepEqual(f.state(), before);
  });
}

test('accepted native roundtrip binds live proof and returns to the exact original owner', async t => {
  const f = nativeFixture(t), first = await acceptedRemote(f);
  const remote = f.state().roles.master;
  assert.deepEqual(remote.owner, f.remote);
  assert.deepEqual(remote.local, f.local);
  assert.equal(remote.runtime, 'omp');
  assert.equal(remote.adapterConfig, f.adapterConfig);
  assert.equal(remote.pending, undefined);
  assert.equal(f.proofs.length, 1);
  const forward = JSON.parse(fs.readFileSync(path.join(first.ledgerDirectory, 'state.json'), 'utf8'))[first.taskId];
  const back = await beginRemoteSwitch({ ...f.options, runtime: null, source: f.remote, local: f.local });
  assert.equal(back.taskId, first.taskId);
  assert.equal(back.baseRecordId, forward.id);
  assert.equal(back.baseRevision, forward.revision);
  await claimRemoteSetup(f.settle(back));
  f.save(back, f.record(back, f.local));
  await commitRemoteSwitch(f.settle(back));
  const local = f.state().roles.master;
  assert.deepEqual(local.owner, f.local);
  assert.deepEqual(local.local, f.local);
  assert.equal(local.runtime, null);
  assert.equal(local.pending, undefined);
  assert.equal(f.proofs.length, 2);
  assert.deepEqual(local.setupOutcomes.map(outcome => outcome.status), ['accepted', 'accepted']);
});

for (const scenario of ['old-ui-present', 'old-ui-disconnected', 'inventory-unproven', 'changed-session', 'changed-config', 'pending', 'failed-proof']) {
  test(`native reconnect refuses ${scenario} without changing ownership or receipt ancestry`, async t => {
    const f = nativeFixture(t), first = await acceptedRemote(f);
    const endpoint = { ...f.remote, terminal: 'reconnected-ui', incarnation: 'reconnected-incarnation' };
    if (scenario === 'changed-session') endpoint.session = 'another-remote-conversation';
    f.setTerminal(endpoint);
    if (scenario === 'old-ui-disconnected') f.terminals.get(f.remote.terminal).connected = false;
    else if (scenario !== 'old-ui-present') f.terminals.delete(f.remote.terminal);
    if (scenario === 'pending') await beginRemoteSwitch({ ...f.options, runtime: null, source: f.remote, local: f.local });
    const before = f.state();
    const ledger = path.join(first.ledgerDirectory, 'state.json'), receipt = fs.readFileSync(ledger, 'utf8');
    const verifyOmp = async proof => {
      assert.deepEqual(proof, { ...f.options, config: f.adapterConfig, endpoint });
      if (scenario === 'failed-proof') throw new Error('remote session not proven');
    };
    await assert.rejects(reattachOmpOwner({ ...f.options, endpoint,
      config: scenario === 'changed-config' ? path.join(f.home, 'another-adapter.json') : f.adapterConfig,
      cli: scenario === 'inventory-unproven' ? async () => ({}) : f.cli, verifyOmp }));
    assert.deepEqual(f.state(), before);
    assert.equal(fs.readFileSync(ledger, 'utf8'), receipt);
  });
}

test('closed native UI reconnects to the same remote session and preserves original receipt ancestry until return', async t => {
  const f = nativeFixture(t), first = await acceptedRemote(f);
  const ledger = path.join(first.ledgerDirectory, 'state.json'), receipt = fs.readFileSync(ledger, 'utf8');
  const forward = JSON.parse(receipt)[first.taskId], original = f.state().roles.master;
  let owner = f.remote;
  for (const suffix of ['one', 'two']) {
    const previous = owner;
    owner = { ...f.remote, terminal: `reconnected-${suffix}`, incarnation: `incarnation-${suffix}` };
    f.terminals.delete(previous.terminal);
    f.setTerminal(owner);
    let verified = 0;
    await reattachOmpOwner({ ...f.options, endpoint: owner, config: f.adapterConfig, cli: f.cli,
      verifyOmp: async proof => {
        verified++;
        assert.deepEqual(proof, { ...f.options, config: f.adapterConfig, endpoint: owner });
      } });
    const rebound = f.state().roles.master;
    assert.equal(verified, 1);
    assert.deepEqual(rebound.owner, owner);
    assert.equal(rebound.owner.session, f.remote.session);
    assert.deepEqual(rebound.local, f.local);
    assert.equal(rebound.taskId, first.taskId);
    assert.equal(rebound.pending, undefined);
    assert.deepEqual(rebound.setupOutcomes, original.setupOutcomes);
    assert.deepEqual(rebound.reattachments.at(-1).previous, previous);
    assert.deepEqual(rebound.reattachments.at(-1).current, owner);
    const { owner_rebindings: bindings, ...unchangedReceipt } = JSON.parse(fs.readFileSync(ledger, 'utf8'))[first.taskId];
    assert.deepEqual(unchangedReceipt, forward);
    assert.deepEqual(bindings.at(-1), { previous, current: owner });
  }
  assert.equal(f.state().roles.master.reattachments.length, 2);
  const back = await beginRemoteSwitch({ ...f.options, runtime: null, source: owner, local: f.local });
  assert.equal(back.taskId, first.taskId);
  assert.equal(back.baseRevision, forward.revision);
  assert.equal(back.baseRecordId, forward.id);
  assert.deepEqual(back.source, owner);
  assert.deepEqual(JSON.parse(fs.readFileSync(ledger, 'utf8'))[first.taskId].owner_rebindings.at(-1).current, owner);
  await claimRemoteSetup(f.settle(back));
  const returned = f.record(back, f.local);
  f.save(back, returned);
  await commitRemoteSwitch({ ...f.settle(back), verifyOmp: async proof => {
    assert.deepEqual(proof, { ...f.options, config: f.adapterConfig, endpoint: owner });
  } });
  assert.equal(returned.previous, forward.id);
  assert.equal(returned.revision, forward.revision + 1);
  const final = f.state().roles.master;
  assert.deepEqual(final.owner, f.local);
  assert.equal(final.runtime, null);
  assert.equal(final.pending, undefined);
});
