import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { taskHistory, dispatchMarker } from '../lib/history.mjs';
import { initialize, saveJson } from '../lib/team.mjs';
import { normalizeProject } from '../lib/platform.mjs';

const prompt = (task, dispatch, worker = 'term_worker') => `You are working inside Orca, a multi-agent IDE. You are a dispatched worker.\nYour task ID is: ${task}\n=== CLI COMMANDS ===\norca orchestration send --from ${worker} --task-id ${task} --dispatch-id ${dispatch}\n=== TASK ===\nDo work`;
test('markers must be user dispatch preambles with a unique attempt, excluding task body', () => {
  assert.equal(dispatchMarker('Quoted example: ' + prompt('task_a', 'ctx_a')), null);
  assert.equal(dispatchMarker(prompt('task_a', 'ctx_a') + '\n--dispatch-id ctx_other').dispatchId, 'ctx_a');
});

test('history indexes retries and reused sessions, scopes projects, caches offline without changing role state', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'team-history-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = normalizeProject(home);
  saveJson(path.join(home, 'team.json'), [{ name: 'master', agent: 'pi', model: 'model' }]);
  saveJson(path.join(home, 'layout.json'), { tabs: [{ title: 'master', agents: ['master'] }] });
  const files = await initialize(home, project);
  saveJson(files.state, { workspace: project, agents: { master: { tabId: 't', leafId: 'l', agent: 'pi' } } });
  const before = fs.readFileSync(files.state, 'utf8');
  const root = path.join(home, 'sessions'); fs.mkdirSync(root);
  for (const provider of ['pi', 'codex']) {
    const header = provider === 'pi' ? { type: 'session', id: 's-pi', cwd: project } : { type: 'session_meta', payload: { id: 's-codex', cwd: project } };
    const rows = [header, ...['ctx_1', 'ctx_2'].map(id => provider === 'pi'
      ? { type: 'message', message: { role: 'user', content: [{ type: 'text', text: prompt('task_a', id) }] } }
      : { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt('task_a', id) }] } })];
    fs.writeFileSync(path.join(root, `${provider}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  }
  fs.writeFileSync(path.join(root, 'foreign.jsonl'), JSON.stringify({ type: 'session', id: 'foreign', cwd: project + '-other' }) + '\n' + JSON.stringify({ type: 'message', message: { role: 'user', content: prompt('task_a', 'ctx_1') } }));
  const calls = [];
  const cli = async args => {
    calls.push(args);
    if (args[1] === 'run-list') return { runs: [{ id: 'run_a' }], nextCursor: null };
    if (args[1] === 'worker-list') {
      const second = args.includes('--cursor');
      return { workers: [{ dispatchId: second ? 'ctx_2' : 'ctx_1', taskId: 'task_a', runId: 'run_a', agentTerminalHandle: 'term_worker', dispatchStatus: second ? 'completed' : 'failed', resource: { worktreeId: `repo::${project}` } }], page: { nextCursor: second ? null : 'next', hasMore: !second } };
    }
    if (args[1] === 'task-list') return { tasks: [{ id: 'task_a', task_title: 'Task', status: 'completed', created_by_pane_key: 't:l' }] };
    assert.fail('Only read-only metadata calls expected');
  };
  const options = { home, project, cli, roots: [root, root] };
  const history = await taskHistory(options);
  assert.equal(history.tasks.length, 2);
  assert.deepEqual(history.tasks.map(row => row.dispatchStatus), ['failed', 'completed']);
  assert.ok(history.tasks.every(row => row.sessions.length === 2 && row.roles.includes('master')));
  assert.equal(history.warnings.length, 0);
  const offline = await taskHistory({ ...options, cli: () => { throw new Error('offline'); } });
  assert.equal(offline.metadataComplete, false);
  assert.equal(offline.tasks.length, 2);
  assert.equal(offline.tasks[0].title, 'Task');
  assert.equal(offline.tasks[0].roleLinks[0].relation, 'creator');
  const cached = await taskHistory({ ...options, cached: true, cli: () => assert.fail('cached must not call Orca') });
  assert.equal(cached.tasks.length, 2);
  assert.equal(fs.readFileSync(files.state, 'utf8'), before);
  const filtered = await taskHistory({ ...options, cached: true, role: 'master' });
  assert.equal(filtered.tasks.length, 2);
  fs.renameSync(path.join(root, 'pi.jsonl'), path.join(root, 'moved.jsonl.bak'));
  const missing = await taskHistory(options);
  assert.equal(missing.tasks[0].sessions.find(session => session.provider === 'pi').available, false);
  assert.equal(missing.tasks[0].sessions.find(session => session.provider === 'codex').available, true);
});

test('history indexes Claude transcripts by their first cwd record and skips other projects', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'team-history-claude-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = normalizeProject(home);
  saveJson(path.join(home, 'team.json'), [{ name: 'reviewer', agent: 'claude', model: 'opus' }]);
  saveJson(path.join(home, 'layout.json'), { tabs: [{ title: 'reviewer', agents: ['reviewer'] }] });
  const files = await initialize(home, project);
  saveJson(files.state, { workspace: project, agents: { reviewer: { tabId: 't', leafId: 'l', agent: 'claude' } } });
  const root = path.join(home, 'claude-projects'); fs.mkdirSync(root);
  const transcript = (id, cwd) => [
    { type: 'last-prompt', sessionId: id },
    { type: 'user', sessionId: id, cwd, message: { role: 'user', content: prompt('task_c', 'ctx_c') } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'own.jsonl'), transcript('claude-own', project));
  fs.writeFileSync(path.join(root, 'foreign.jsonl'), transcript('claude-foreign', project + '-other'));
  const cli = async args => {
    if (args[1] === 'run-list') return { runs: [{ id: 'run_c' }], nextCursor: null };
    if (args[1] === 'worker-list') return { workers: [{ dispatchId: 'ctx_c', taskId: 'task_c', runId: 'run_c', agentTerminalHandle: 'term_worker', dispatchStatus: 'completed', resource: { worktreeId: `repo::${project}` } }], page: { nextCursor: null, hasMore: false } };
    if (args[1] === 'task-list') return { tasks: [{ id: 'task_c', task_title: 'Claude task', status: 'completed', created_by_pane_key: 't:l' }] };
    assert.fail('Only read-only metadata calls expected');
  };
  const history = await taskHistory({ home, project, cli, roots: [root] });
  assert.equal(history.warnings.length, 0);
  assert.equal(history.tasks.length, 1);
  assert.deepEqual(history.tasks[0].sessions.map(session => [session.id, session.provider]), [['claude-own', 'claude']]);
});
