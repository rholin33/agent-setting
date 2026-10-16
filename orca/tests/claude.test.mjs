import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeSessionIds, claudeTranscriptPath } from '../lib/claude.mjs';
import { launchArguments, validateTranscript } from '../lib/sessions.mjs';
import { captureSession, prepareLaunch } from '../lib/launch-state.mjs';
import { validateConfig } from '../lib/team.mjs';
import { classifyWindows, inspectWindows } from '../lib/windows-health.mjs';
import { inspectMac, macTree, verifyMacAbsence } from '../lib/macos-health.mjs';
import { exitCommand } from '../lib/force-exit.mjs';
import { createPickerState, renderPicker } from '../lib/model-picker.mjs';

const ID = '0f269984-d2a2-4102-9315-cfa5853d1d8a';
const OTHER = '8192faee-234c-445d-b57d-82ea4c7541ff';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-claude-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(fs.realpathSync(root), 'project');
  fs.mkdirSync(project);
  const claudeHome = path.join(root, 'claude');
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; });
  const write = (id, records, directory = '-project') => {
    const file = path.join(claudeHome, 'projects', directory, `${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
    return file;
  };
  const conversation = (id, cwd = project) => [
    { type: 'last-prompt', sessionId: id },
    { type: 'permission-mode', permissionMode: 'default', sessionId: id },
    { type: 'user', sessionId: id, cwd, message: { role: 'user', content: 'hello' } },
  ];
  return { root, project, claudeHome, write, conversation };
}

test('role catalog accepts the claude agent', () => {
  const catalog = [{ name: 'reviewer', agent: 'claude', model: 'opus', thinking: 'high' }];
  assert.deepEqual(validateConfig({ tabs: [{ title: 'review', agents: ['reviewer'] }] }, catalog), ['reviewer']);
  assert.throws(() => validateConfig({ tabs: [{ title: 'x', agents: ['reviewer'] }] }, [{ ...catalog[0], agent: 'gemini' }]), /Invalid role catalog/);
});

test('claude session ids come only from session flags', () => {
  assert.deepEqual(claudeSessionIds(`claude --model opus --session-id ${ID} --name coder1 hello`), [ID]);
  assert.deepEqual(claudeSessionIds(`claude --resume ${ID} --append-system-prompt-file /x`), [ID]);
  assert.deepEqual(claudeSessionIds(`claude -r=${ID}`), [ID]);
  assert.deepEqual(claudeSessionIds(`claude --resume "${ID}" --session-id ${ID}`), [ID]);
  assert.deepEqual(claudeSessionIds(`claude --model opus ${OTHER} --add-dir /tmp/${ID}`), []);
});

test('claude transcript lookup is exact, unique and validates the id', t => {
  const { write, conversation } = fixture(t);
  assert.equal(claudeTranscriptPath(ID), null);
  const file = write(ID, conversation(ID));
  assert.equal(claudeTranscriptPath(ID), file);
  write(ID, conversation(ID), '-elsewhere');
  assert.throws(() => claudeTranscriptPath(ID), /ambiguous/);
  assert.throws(() => claudeTranscriptPath('../escape'), /Invalid Claude session id/);
});

test('claude transcript identity uses the first record carrying cwd', t => {
  const { project, root, write, conversation } = fixture(t);
  const transcriptPath = write(ID, conversation(ID));
  const session = { id: ID, transcriptPath };
  assert.equal(validateTranscript({ agent: 'claude', session }, project), session);
  assert.throws(() => validateTranscript({ agent: 'claude', session: { ...session, id: OTHER } }, project), /identity\/project mismatch/);
  assert.throws(() => validateTranscript({ agent: 'claude', session: { id: OTHER, transcriptPath: write(OTHER, conversation(OTHER, root)) } }, project), /identity\/project mismatch/);
  const pending = write('11111111-2222-4333-8444-555555555555', conversation(ID).slice(0, 2));
  assert.throws(() => validateTranscript({ agent: 'claude', session: { id: ID, transcriptPath: pending } }, project), /header unavailable/);
});

test('claude launch appends the role prompt, effort and resume id', t => {
  const { project, write, conversation } = fixture(t);
  const prompt = path.join(project, 'role.md');
  fs.writeFileSync(prompt, 'role');
  const role = { name: 'reviewer', agent: 'claude', model: 'opus', thinking: 'high', role: 'agentroles.code_reviewer' };
  const fresh = launchArguments(role, prompt, null, project, '/team');
  assert.equal(fresh.executable, 'claude');
  assert.deepEqual(fresh.args, ['--model', 'opus', '--permission-mode', 'default', '--append-system-prompt-file', prompt, '--effort', 'high']);
  const transcriptPath = write(ID, conversation(ID));
  const resumed = launchArguments({ ...role, thinking: null }, prompt, { id: ID, transcriptPath }, project, '/team');
  assert.deepEqual(resumed.args, ['--model', 'opus', '--permission-mode', 'default', '--resume', ID, '--append-system-prompt-file', prompt]);
  assert.throws(() => launchArguments(role, prompt, { id: OTHER, transcriptPath }, project, '/team'), /mismatch/);
});

test('claude launch binds the pre-assigned session id once its transcript is verified', t => {
  const { project, write, conversation } = fixture(t);
  const saved = {};
  prepareLaunch(saved, { name: 'reviewer', agent: 'claude', model: 'opus', thinking: 'high' }, project);
  assert.equal(saved.launchIntent.transcriptPath, undefined);
  const id = saved.launchIntent.id;
  const live = { kind: 'agent', sessionIds: [id], terminal: { handle: 'h', incarnationId: 'i' } };
  assert.equal(captureSession(saved, live, project, null), false, 'transcript not written yet');
  write(id, conversation(id).slice(0, 2));
  assert.equal(captureSession(saved, live, project, null), false, 'metadata without cwd is retried');
  assert.equal(captureSession(saved, { ...live, sessionIds: [] }, project, null), false, 'process must prove the session id');
  const transcriptPath = write(id, conversation(id));
  assert.equal(captureSession(saved, live, project, null), true);
  assert.deepEqual(saved.session, { key: 'session_id', id, transcriptPath });
  assert.equal(saved.bindingSource, 'process-arguments');
  assert.throws(() => captureSession(saved, { ...live, sessionIds: [OTHER] }, project, null), /differs/);
});

test('claude exits with /exit while other providers keep /quit', () => {
  assert.equal(exitCommand('claude'), '/exit');
  assert.equal(exitCommand('codex'), '/quit');
  assert.equal(exitCommand('omp'), '/quit');
});

test('claude rows retain native models and permit CLI selection', () => {
  const state = createPickerState({
    roles: [{ name: 'reviewer', agent: 'claude', model: 'opus', thinking: 'high' }, { name: 'master', agent: 'omp', model: 'pay/a' }],
    presets: [{ model: 'pay/a', thinking: null }],
    initial: { reviewer: { model: 'pay/a', thinking: null } },
  });
  assert.deepEqual([state.rows[0].editable, state.rows[0].model, state.rows[1].editable], [true, 'opus', true]);
  assert.match(renderPicker(state), /claude\/opus/);
});

const winRoot = { ProcessId: 10, ParentProcessId: 1, Name: 'pwsh.exe', Created: '100', SessionId: 1 };
const winClaude = { ProcessId: 11, ParentProcessId: 10, Name: 'claude.exe', Created: '110', SessionId: 1, CommandLine: `claude.exe --resume ${ID}` };

test('Windows classifies claude.exe and reads its session id', async () => {
  assert.equal(classifyWindows([winRoot, winClaude], { pid: 10 }, 'claude'), 'agent');
  assert.equal(classifyWindows([winRoot, winClaude], { pid: 10 }, 'codex'), 'unverifiable');
  const terminal = { handle: 't', ptyId: 'p', incarnationId: 'i', connected: true };
  const session = { terminalHandle: 't', sessionId: 'p', incarnationId: 'i', isAlive: true, pid: 10 };
  const live = await inspectWindows(terminal, 'claude', { inventory: async () => ({ identity: { launchNonce: 'n' }, sessions: [session] }), processes: async () => [winRoot, winClaude] });
  assert.deepEqual([live.kind, live.sessionIds], ['agent', [ID]]);
});

const macRoot = { pid: 1, parent: 0, group: 1, foreground: 2, tty: 'ttys001', created: 'Mon Sep 21 16:34:38 2026', name: 'login' };
const macClaude = { ...macRoot, pid: 2, parent: 1, group: 2, name: 'claude' };

test('macOS reads claude session ids from the verified provider process', async () => {
  assert.ok(macTree([macRoot, macClaude], 1, 'claude'));
  const terminal = { handle: 't', ptyId: 'p', incarnationId: 'i', connected: true };
  const inventory = async () => ({ identity: { launchNonce: 'n' }, sessions: [{ terminalHandle: 't', sessionId: 'p', incarnationId: 'i', isAlive: true, pid: 1 }] });
  const execute = async (command, args) => ({ stdout: args.includes('2') ? `claude --model opus --session-id ${ID} --name reviewer\n` : '' });
  const live = await inspectMac(terminal, 'claude', { inventory, processes: async () => [macRoot, macClaude], show: async () => terminal, execute });
  assert.deepEqual([live.kind, live.sessionIds, live.sessionPaths], ['agent', [ID], []]);
});

test('macOS absence proof accepts an unrelated live claude pane in the project', async t => {
  const { project, write, conversation } = fixture(t);
  const transcriptPath = write(ID, conversation(ID));
  const missing = [{ name: 'reviewer', saved: { agent: 'claude', session: { id: ID, transcriptPath } } }];
  const terminal = { handle: 'live', ptyId: `repo::${project}@@live`, incarnationId: 'live', tabId: 'tab', leafId: 'leaf', connected: true, executionHostId: 'local' };
  const options = {
    project, missing, conversationUsers: async () => {}, snapshot: () => ({}),
    inventory: async () => ({ identity: { launchNonce: 'stable' }, sessions: [{ sessionId: terminal.ptyId, terminalHandle: 'live', incarnationId: 'live', isAlive: true, pid: 1 }] }),
    cli: async () => ({ terminals: [terminal], totalCount: 1, truncated: false, hostScope: { hostIds: ['local'], omittedHostIds: [] } }),
    processes: async () => [macRoot, macClaude, { pid: process.pid }],
  };
  assert.equal(await verifyMacAbsence(options), true);
});
