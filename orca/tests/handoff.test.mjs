import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConversation, renderHandoff, prepareHandoff, switchProviders, pendingSwitches, startupSwitches, handoffPrompt } from '../lib/handoff.mjs';
import { launchArguments } from '../lib/sessions.mjs';
import { projectFiles, readJson, saveJson } from '../lib/team.mjs';
import { normalizeProject } from '../lib/platform.mjs';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-handoff-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return normalizeProject(fs.realpathSync(dir));
}
const writeJsonl = (file, rows) => fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
const ompMessage = (id, parentId, role, content) => ({ type: 'message', id, parentId, message: { role, content } });
const ompTranscript = (file, project, id = 'omp-1') => writeJsonl(file, [
  { type: 'title', v: 1, title: 'work' },
  { type: 'session', version: 3, id, cwd: project },
  ompMessage('a', null, 'user', [{ type: 'text', text: 'first task' }]),
  ompMessage('b', 'a', 'assistant', [{ type: 'text', text: 'abandoned answer' }]),
  ompMessage('c', 'a', 'assistant', [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'kept answer' },
    { type: 'toolCall', name: 'bash', arguments: { command: 'ls' } }]),
  ompMessage('d', 'c', 'toolResult', [{ type: 'text', text: 'tool output' }]),
  { type: 'compaction', id: 'e', parentId: 'd', summary: 'summary of earlier work' },
  ompMessage('f', 'e', 'user', [{ type: 'text', text: 'second task' }]),
]);

test('omp handoff follows the active branch and drops tool output and reasoning', async t => {
  const dir = temp(t), file = path.join(dir, 'omp.jsonl');
  ompTranscript(file, dir);
  assert.deepEqual(await readConversation(file, 'omp'), [
    { kind: 'user', text: 'first task' }, { kind: 'assistant', text: 'kept answer' },
    { kind: 'tool', text: 'bash {"command":"ls"}' }, { kind: 'summary', text: 'summary of earlier work' },
    { kind: 'user', text: 'second task' }]);
});

test('codex handoff skips injected context and keeps calls and compaction', async t => {
  const dir = temp(t), file = path.join(dir, 'codex.jsonl');
  const item = payload => ({ type: 'response_item', payload });
  writeJsonl(file, [
    { type: 'session_meta', payload: { id: 'codex-1', cwd: dir } },
    item({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'developer rules' }] }),
    item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /x' }] }),
    item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the bug' }] }),
    item({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'hidden' }] }),
    item({ type: 'function_call', name: 'exec_command', arguments: '{"cmd": "npm test"}' }),
    item({ type: 'function_call_output', output: 'lots of output' }),
    { type: 'compacted', payload: { message: 'codex summary' } },
    item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixed' }] }),
  ]);
  assert.deepEqual(await readConversation(file, 'codex'), [
    { kind: 'user', text: 'fix the bug' }, { kind: 'tool', text: 'exec_command {"cmd": "npm test"}' },
    { kind: 'summary', text: 'codex summary' }, { kind: 'assistant', text: 'fixed' }]);
});

test('claude handoff starts at the latest compaction and skips meta and sidechains', async t => {
  const dir = temp(t), file = path.join(dir, 'claude.jsonl');
  const base = { sessionId: 'claude-1', cwd: dir };
  writeJsonl(file, [
    { type: 'mode', mode: 'normal', sessionId: 'claude-1' },
    { ...base, type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'before compaction' } },
    { ...base, type: 'user', uuid: 'u2', parentUuid: null, isCompactSummary: true, message: { role: 'user', content: 'claude summary' } },
    { ...base, type: 'user', uuid: 'u3', parentUuid: 'u2', isMeta: true, message: { role: 'user', content: 'meta' } },
    { ...base, type: 'user', uuid: 'u4', parentUuid: 'u3', message: { role: 'user', content: [{ type: 'text', text: 'continue' }] } },
    { ...base, type: 'assistant', uuid: 's1', parentUuid: 'u4', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent' }] } },
    { ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u4', message: { role: 'assistant', content: [
      { type: 'text', text: 'on it' }, { type: 'tool_use', name: 'Read', input: { file_path: '/a' } }] } },
    { ...base, type: 'user', uuid: 'u5', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'tool_result', content: 'file body' }] } },
  ]);
  assert.deepEqual(await readConversation(file, 'claude'), [
    { kind: 'summary', text: 'claude summary' }, { kind: 'user', text: 'continue' },
    { kind: 'assistant', text: 'on it' }, { kind: 'tool', text: 'Read {"file_path":"/a"}' }]);
});

test('handoff keeps the newest blocks within budget and pins the dropped summary', async t => {
  const dir = temp(t), file = path.join(dir, 'omp.jsonl');
  const rows = [{ type: 'session', version: 3, id: 'omp-1', cwd: dir }, { type: 'compaction', id: 'c', parentId: null, summary: 'old summary' }];
  let parent = 'c';
  for (let index = 0; index < 40; index++) {
    rows.push(ompMessage(`m${index}`, parent, index % 2 ? 'assistant' : 'user', [{ type: 'text', text: `message ${index} ${'x'.repeat(3000)}` }]));
    parent = `m${index}`;
  }
  rows.push(ompMessage('tools', parent, 'assistant', Array.from({ length: 10 }, (_, index) => ({ type: 'toolCall', name: `tool${index}`, arguments: {} }))));
  writeJsonl(file, rows);
  const text = await renderHandoff({ name: 'master', from: 'omp', to: 'claude', session: { id: 'omp-1', transcriptPath: file }, createdAt: 'now' });
  assert.match(text, /## Latest compaction summary \(before the excerpt below\)\n\nold summary/);
  assert.match(text, /older blocks omitted/);
  assert.match(text, /message 39 /);
  assert.doesNotMatch(text, /message 0 /);
  assert.match(text, /…4 earlier tool calls omitted\n- tool4 \{\}/);
  assert.ok(text.length < 70_000);
});

test('prepareHandoff writes the document and clears the old provider binding', async t => {
  const dir = temp(t), file = path.join(dir, 'omp.jsonl');
  ompTranscript(file, dir);
  const saved = { agent: 'omp', tabId: 't', leafId: 'l', session: { id: 'omp-1', transcriptPath: file }, appliedModel: {}, restartIntent: {} };
  const handoff = await prepareHandoff({ name: 'master', saved, to: 'claude', directory: dir, project: dir, now: () => new Date('2026-10-14T00:00:00Z') });
  assert.equal(handoff.path, path.join(dir, 'handoff', 'master-omp-to-claude-2026-10-14T00-00-00-000Z.md'));
  assert.match(fs.readFileSync(handoff.path, 'utf8'), /# Orca role handoff: master \(omp → claude\)[\s\S]*kept answer/);
  assert.deepEqual(saved, { agent: 'claude', tabId: 't', leafId: 'l', handoff: { path: handoff.path, from: 'omp', sessionId: 'omp-1', transcriptPath: file, createdAt: '2026-10-14T00:00:00.000Z' } });
  await assert.rejects(prepareHandoff({ name: 'master', saved: { agent: 'omp', pending: true }, to: 'claude', directory: dir, project: dir }), /launch pending/);
  await assert.rejects(prepareHandoff({ name: 'master', saved: { agent: 'omp', session: { id: 'other', transcriptPath: file } }, to: 'claude', directory: dir, project: dir }), /mismatch/);
});

test('switchProviders stops only running roles regardless of fingerprint, then hands off atomically', async t => {
  const dir = temp(t), home = path.join(dir, 'home'), project = dir;
  const files = projectFiles(home, project);
  fs.mkdirSync(files.directory, { recursive: true });
  const transcript = path.join(dir, 'omp.jsonl');
  ompTranscript(transcript, project);
  const session = { id: 'omp-1', transcriptPath: transcript };
  // loader 的已应用指纹与当前目录一致（目录尚未保存新 CLI 时的真实情形），archi 没有窗格。
  const initial = { workspace: project, agents: {
    loader: { agent: 'omp', tabId: 't', leafId: 'l', appliedModel: { agent: 'omp', model: 'same', thinking: 'high' }, session },
    archi: { agent: 'omp', tabId: 'gone', leafId: 'gone', session } } };
  const reset = () => saveJson(files.state, initial);
  const cli = async () => ({ terminals: [{ tabId: 't', leafId: 'l', handle: 'h', connected: true, worktreePath: project }] });
  const switches = [{ name: 'loader', from: 'omp', to: 'codex' }, { name: 'archi', from: 'omp', to: 'claude' }];
  const run = (kinds, restart) => {
    let index = 0;
    return switchProviders({ switches, home, project, cli, log() {}, restart, inspect: async () => ({ kind: kinds[Math.min(index++, kinds.length - 1)] }) });
  };

  reset();
  await assert.rejects(run(['unverifiable'], async () => assert.fail('must not stop')), /loader: omp pane is unverifiable/);
  assert.deepEqual(readJson(files.state), initial);
  await assert.rejects(run(['agent'], async () => ({ reloaded: [], failed: [{ name: 'loader', reason: 'agent is busy' }] })), /loader: agent is busy/);
  assert.deepEqual(readJson(files.state), initial);
  await assert.rejects(run(['agent', 'agent'], async () => ({ reloaded: ['loader'], failed: [] })), /loader: omp pane is agent/);
  assert.deepEqual(readJson(files.state), initial);

  const stopped = [];
  await run(['agent', 'shell'], async options => {
    stopped.push(options);
    return { reloaded: options.roles, failed: [] };
  });
  assert.deepEqual(stopped.map(options => [options.roles, options.stopOnly, options.forceExit]), [[['loader'], true, true]]);
  const state = readJson(files.state);
  assert.equal(state.agents.loader.agent, 'codex');
  assert.equal(state.agents.archi.agent, 'claude');
  for (const name of ['loader', 'archi']) {
    assert.equal(state.agents[name].session, undefined);
    assert.equal(state.agents[name].handoff.sessionId, 'omp-1');
    assert.ok(fs.existsSync(state.agents[name].handoff.path));
  }
});

test('pendingSwitches compares the saved conversation CLI with the catalog for every start', () => {
  const state = { agents: {
    master: { agent: 'omp', session: { id: 'a' } }, loader: { agent: 'omp', launchIntent: { id: 'b' } },
    coder1: { agent: 'codex', session: { id: 'c' } }, fresh: { agent: 'omp' } } };
  const catalog = [{ name: 'master', agent: 'claude' }, { name: 'loader', agent: 'codex' }, { name: 'coder1', agent: 'codex' }, { name: 'fresh', agent: 'claude' }];
  assert.deepEqual(pendingSwitches(state, catalog, ['master', 'loader', 'coder1', 'fresh']),
    [{ name: 'master', from: 'omp', to: 'claude' }, { name: 'loader', from: 'omp', to: 'codex' }]);
  assert.deepEqual(pendingSwitches(state, catalog, ['coder1']), []);
});

test('ordinary startup preserves remote owners, pending sources and requested return sessions while switching independent local roles', () => {
  const names = ['master', 'archi', 'returning', 'outgoing', 'reviewer'];
  const state = { agents: Object.fromEntries(names.map(name => [name, { agent: 'omp', session: { id: name + '-original' } }])) };
  const before = structuredClone(state);
  const catalog = names.map(name => ({ name, agent: 'claude' }));
  const continuity = { roles: { master: { runtime: 'claude' }, archi: { pending: { id: 'unsettled' } }, returning: { runtime: 'claude' } } };
  const requests = [{ role: 'returning', runtime: null }, { role: 'outgoing', runtime: 'claude' }];
  assert.deepEqual(startupSwitches(state, catalog, names, continuity, requests), [{ name: 'reviewer', from: 'omp', to: 'claude' }]);
  assert.deepEqual(state, before);
  assert.equal(pendingSwitches(state, catalog, names).length, 5, 'explicit restart still detects every CLI mismatch');
});

test('settled local roles still use normal CLI migration after remote return', () => {
  const state = { agents: { master: { agent: 'omp', session: { id: 'original' } } } };
  assert.deepEqual(startupSwitches(state, [{ name: 'master', agent: 'claude' }], ['master'], { roles: { master: { runtime: null } } }, []),
    [{ name: 'master', from: 'omp', to: 'claude' }]);
});

test('codex fresh launch appends the handoff note to the role prompt', t => {
  const dir = temp(t), prompt = path.join(dir, 'role.md');
  fs.writeFileSync(prompt, 'role prompt');
  const note = handoffPrompt('coder1', { from: 'omp', path: '/h.md' });
  const { args } = launchArguments({ name: 'coder1', agent: 'codex', model: 'gpt' }, prompt, null, dir, dir, { initialNote: note });
  assert.equal(args.at(-1), `role prompt\n\n${note}`);
  assert.match(note, /Read the handoff document \/h\.md now/);
  assert.equal(launchArguments({ name: 'coder1', agent: 'codex', model: 'gpt' }, prompt, null, dir, dir).args.at(-1), 'role prompt');
});
