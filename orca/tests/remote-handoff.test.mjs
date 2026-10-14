import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDirectHandoff, decisionOf, mechanicalSummary, supportsDirectHandoff } from '../lib/remote-handoff.mjs';
import { beginRemoteSwitch, readRemoteSwitches } from '../lib/remote-switch.mjs';
import { projectFiles } from '../lib/team.mjs';

// 仓库结构下技能与团队包同仓；安装后的团队包则使用已安装的 Codex 技能。
const REPO_SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'codex', 'skills', 'orca-remote', 'SKILL.md');
const SKILL = fs.existsSync(REPO_SKILL) ? REPO_SKILL : path.join(os.homedir(), '.codex', 'skills', 'orca-remote', 'SKILL.md');

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'direct-handoff-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = path.join(home, 'project');
  fs.mkdirSync(project);
  const role = 'master';
  const local = { runtime: 'omp', role, environment: 'local', terminal: 'term_local', incarnation: 'inc-local', session: 'native-local' };
  const remote = { runtime: 'omp', role, environment: 'local', terminal: 'term_guest', incarnation: 'inc-guest', session: 'native-remote' };
  const adapterConfig = path.join(home, 'adapter.json');
  fs.writeFileSync(adapterConfig, JSON.stringify({ peer: '100.0.0.1', base: 9000, control_token: 'secret' }), { mode: 0o600 });
  const transcriptPath = path.join(home, 'local.jsonl');
  const localRows = [
    { type: 'session', version: 3, id: local.session, cwd: project },
    { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'Refactor the billing module' }] } },
    { type: 'message', id: 'b', parentId: 'a', message: { role: 'assistant', content: [{ type: 'text', text: 'Split invoice.ts into two files.' }] } },
  ];
  const appendLocal = row => fs.appendFileSync(transcriptPath, JSON.stringify(row) + '\n');
  localRows.forEach(appendLocal);
  const statePath = projectFiles(home, project).state;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ workspace: project, agents: { master: { agent: 'omp', session: { id: local.session, transcriptPath } } } }));
  // 远端 OMP 控制服务：只暴露助手消息，偏移量为字节位置。
  const remoteMessages = [];
  const control = { busy: false, requests: [] };
  const request = async (config, route, body) => {
    assert.equal(config, adapterConfig);
    control.requests.push(route);
    if (route === '/snapshot') return { host: { busy: control.busy } };
    const offset = body.offset;
    return { session: remote.session, offset, nextOffset: remoteMessages.length, messages: remoteMessages.slice(offset).map(text => ({ role: 'assistant', text })) };
  };
  const terminals = { [local.terminal]: local, [remote.terminal]: remote };
  const sent = [];
  const cli = async args => {
    const handle = args[args.indexOf('--terminal') + 1];
    if (args[1] === 'wait') return { wait: { satisfied: true } };
    if (args[1] === 'read') return { terminal: { source: 'screen', draft: '' } };
    if (args[1] === 'switch') return {};
    if (args[1] === 'show') {
      const endpoint = terminals[handle];
      return { terminal: { handle, incarnationId: endpoint.incarnation, connected: true, worktreePath: project, executionHostId: 'local', agentIdentity: 'omp' } };
    }
    if (args[1] === 'send') {
      const text = args[args.indexOf('--text') + 1];
      sent.push({ handle, text });
      const id = text.match(/"id": "([^"]+)"/)[1];
      control.onSend?.({ handle, text, id });
      return { send: { accepted: true } };
    }
    throw new Error(`Unexpected ${args.join(' ')}`);
  };
  const git = async () => ({ stdout: ' M src/invoice.ts\n?? src/invoice-lines.ts\n' });
  const base = { home, project, role, cli, skill: SKILL, request, git, log: () => {}, verifyOmp: async () => {}, sleep: async () => {} };
  return { home, project, role, local, remote, adapterConfig, base, sent, control, remoteMessages, appendLocal };
}

test('local OMP → remote OMP: mechanical checkpoint, one delivery, real receipt, commit and focus', async t => {
  const f = fixture(t);
  const intent = { ...await beginRemoteSwitch({ home: f.home, project: f.project, role: f.role, runtime: 'omp', source: f.local, local: f.local, target: f.remote, adapterConfig: f.adapterConfig }), role: f.role };
  f.control.onSend = ({ id }) => f.remoteMessages.push(`HANDOFF_ACCEPTED ${id}. Next: confirm the billing split with the user.`);
  const result = await runDirectHandoff({ ...f.base, intent });
  assert.equal(result.decision, 'accepted');
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].handle, f.remote.terminal);
  assert.match(f.sent[0].text, /Refactor the billing module/);
  assert.match(f.sent[0].text, /Split invoice\.ts into two files/);
  assert.match(f.sent[0].text, /src\/invoice\.ts/);
  const entry = readRemoteSwitches(f.base).roles.master;
  assert.deepEqual(entry.owner, f.remote);
  assert.equal(entry.runtime, 'omp');
  assert.equal(entry.pending, undefined);
  const ledger = JSON.parse(fs.readFileSync(path.join(intent.ledgerDirectory, 'state.json'), 'utf8'))[intent.taskId];
  assert.equal(ledger.status, 'accepted');
  assert.equal(ledger.receipt.origin, 'assistant_turn');
  assert.ok(fs.existsSync(path.join(intent.ledgerDirectory, `${ledger.id}.delivery.json`)));
});

test('remote OMP → off returns only the remote progress since the forward handoff', async t => {
  const f = fixture(t);
  const forward = { ...await beginRemoteSwitch({ home: f.home, project: f.project, role: f.role, runtime: 'omp', source: f.local, local: f.local, target: f.remote, adapterConfig: f.adapterConfig }), role: f.role };
  f.remoteMessages.push('Earlier remote chatter before the handoff.');
  f.control.onSend = ({ id }) => f.remoteMessages.push(`HANDOFF_ACCEPTED ${id}`);
  await runDirectHandoff({ ...f.base, intent: forward });
  f.remoteMessages.push('Remote: added unit tests for invoice lines.');
  const back = { ...await beginRemoteSwitch({ home: f.home, project: f.project, role: f.role, runtime: null, source: f.remote, local: f.local }), role: f.role };
  f.control.onSend = ({ id }) => f.appendLocal({ type: 'message', id: 'c', parentId: 'b', message: { role: 'assistant', content: [{ type: 'text', text: `HANDOFF_ACCEPTED ${id}` }] } });
  const result = await runDirectHandoff({ ...f.base, intent: back, sourceAdapterConfig: f.adapterConfig });
  assert.equal(result.decision, 'accepted');
  const returned = f.sent.at(-1);
  assert.equal(returned.handle, f.local.terminal);
  assert.match(returned.text, /added unit tests for invoice lines/);
  assert.doesNotMatch(returned.text, /Earlier remote chatter/);
  assert.match(returned.text, /Refactor the billing module/);
  const entry = readRemoteSwitches(f.base).roles.master;
  assert.deepEqual(entry.owner, f.local);
  assert.equal(entry.runtime, null);
});

test('a missing receipt keeps delivery pending; rerunning waits without resending', async t => {
  const f = fixture(t);
  const intent = { ...await beginRemoteSwitch({ home: f.home, project: f.project, role: f.role, runtime: 'omp', source: f.local, local: f.local, target: f.remote, adapterConfig: f.adapterConfig }), role: f.role };
  let clock = 0;
  await assert.rejects(runDirectHandoff({ ...f.base, intent, now: () => (clock += 60_000), timeoutMs: 120_000 }), /never resent/);
  const pending = readRemoteSwitches(f.base).roles.master.pending;
  assert.equal(pending.status, 'setup_uncertain');
  assert.equal(f.sent.length, 1);
  const recordId = f.sent[0].text.match(/"id": "([^"]+)"/)[1];
  f.remoteMessages.push(`I will reply HANDOFF_ACCEPTED or HANDOFF_REJECTED for ${recordId}`);
  f.remoteMessages.push(`HANDOFF_ACCEPTED ${recordId}`);
  const result = await runDirectHandoff({ ...f.base, intent: { ...pending, role: f.role } });
  assert.equal(result.decision, 'accepted');
  assert.equal(f.sent.length, 1);
});

test('busy source or non-empty target input stops before any ledger write', async t => {
  const f = fixture(t);
  const intent = { ...await beginRemoteSwitch({ home: f.home, project: f.project, role: f.role, runtime: 'omp', source: f.local, local: f.local, target: f.remote, adapterConfig: f.adapterConfig }), role: f.role };
  f.control.busy = true;
  await assert.rejects(runDirectHandoff({ ...f.base, intent }), /target agent is busy/);
  assert.equal(readRemoteSwitches(f.base).roles.master.pending.status, 'prepared');
  assert.equal(fs.existsSync(path.join(intent.ledgerDirectory, 'state.json')), false);
  assert.equal(f.sent.length, 0);
});

test('an explicit rejection settles with the source still owning the task', async t => {
  const f = fixture(t);
  const intent = { ...await beginRemoteSwitch({ home: f.home, project: f.project, role: f.role, runtime: 'omp', source: f.local, local: f.local, target: f.remote, adapterConfig: f.adapterConfig }), role: f.role };
  f.control.onSend = ({ id }) => f.remoteMessages.push(`HANDOFF_REJECTED ${id}: worktree mismatch`);
  const result = await runDirectHandoff({ ...f.base, intent });
  assert.equal(result.decision, 'rejected');
  const entry = readRemoteSwitches(f.base).roles.master;
  assert.deepEqual(entry.owner, f.local);
  assert.equal(entry.runtime, null);
});

test('receipt parsing, summary budget and supported routes', () => {
  assert.equal(decisionOf('HANDOFF_ACCEPTED x'), 'accepted');
  assert.equal(decisionOf('HANDOFF_REJECTED: no'), 'rejected');
  assert.equal(decisionOf('reply HANDOFF_ACCEPTED or HANDOFF_REJECTED'), null);
  assert.equal(decisionOf('accepted'), null);
  const items = Array.from({ length: 200 }, (_, index) => ({ kind: index % 2 ? 'assistant' : 'user', text: `message ${index} ${'x'.repeat(3000)}` }));
  const summary = mechanicalSummary({ items, changed: [], sourceLabel: 'omp master (local)' });
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) <= 20 * 1024);
  assert.match(summary.completed.at(-1), /^message 199 /);
  assert.match(summary.goal, /message 198 /);
  assert.throws(() => mechanicalSummary({ items: [], changed: [], sourceLabel: 's' }), /no request/);
  assert.equal(mechanicalSummary({ items: [], previousGoal: 'kept goal', changed: [], sourceLabel: 's' }).goal, 'kept goal');
  const registry = { roles: { master: { runtime: 'codex' } } };
  assert.equal(supportsDirectHandoff({ role: 'master', runtime: 'omp' }, { roles: {} }), true);
  assert.equal(supportsDirectHandoff({ role: 'master', runtime: null }, { roles: {} }), true);
  assert.equal(supportsDirectHandoff({ role: 'master', runtime: 'codex' }, { roles: {} }), false);
  assert.equal(supportsDirectHandoff({ role: 'master', runtime: null }, registry), false);
});
