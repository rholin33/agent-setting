import test from 'node:test';
import assert from 'node:assert/strict';
import roleTitle from '../lib/omp-role-title.mjs';
import { revealRoleTitles } from '../lib/role-titles.mjs';
import { launchArguments } from '../lib/sessions.mjs';
import path from 'node:path';

test('native role naming extension is attached explicitly to OMP launches', () => {
  const launch = launchArguments({ name: 'loader', agent: 'omp', model: 'model' }, 'prompt.md', null, '/project', '/team');
  assert.equal(launch.env.ORCA_TEAM_ROLE, 'loader');
  assert.equal(launch.args[launch.args.indexOf('--extension') + 1], path.join('/team', 'lib', 'omp-role-title.mjs'));
});

test('OMP role extension names the native session without a model turn', async () => {
  const events = {}, names = [];
  roleTitle({ on: (event, handler) => events[event] = handler, setSessionName: async name => names.push(name) }, { ORCA_TEAM_ROLE: 'loader' });
  await events.session_start();
  assert.deepEqual(names, ['loader']);
  assert.deepEqual(Object.keys(events), ['session_start']);
  const ignored = {};
  roleTitle({ on: (event, handler) => ignored[event] = handler }, { ORCA_TEAM_ROLE: 'invalid\nrole' });
  assert.deepEqual(ignored, {});
});

function fixture() {
  const state = { agents: { master: { agent: 'omp', tabId: 'tab', leafId: 'm' }, loader: { agent: 'omp', tabId: 'tab', leafId: 'l' } } };
  const config = { tabs: [{ title: 'master', agents: ['master', 'loader'] }] };
  const terminals = [
    { handle: 'master', tabId: 'tab', leafId: 'm', connected: true, worktreePath: '/project', title: 'OMP > ⚙️ MASTER: master (local retained)' },
    { handle: 'loader', tabId: 'tab', leafId: 'l', connected: true, worktreePath: '/project', title: 'OMP > loader' },
  ];
  const calls = [];
  const cli = async args => { calls.push(args); return { rename: { handle: 'master', tabId: 'tab', title: null } }; };
  return { project: '/project', state, config, inventory: { terminals }, cli, calls };
}

test('split roles use their distinct native names instead of one shared custom title', async () => {
  const f = fixture(); await revealRoleTitles(f);
  assert.deepEqual(f.calls, [['terminal', 'rename', '--terminal', 'master']]);
  assert.ok(!f.calls.some(args => ['send', 'create', 'close', 'split'].includes(args[1])));
});

test('working OMP title retains role identity when the native title appends the project', async () => {
  const f = fixture(); f.inventory.terminals[1].title = 'OMP - ⚙️ LOAD: loader - project';
  await revealRoleTitles(f);
  assert.equal(f.calls.length, 1);
});

test('generic OMP idle title preserves an explicit shared role label without failing startup', async () => {
  const f = fixture(), warnings = [];
  f.inventory.terminals[1].title = 'OMP ready';
  f.log = message => warnings.push(message);
  f.cli = async args => {
    f.calls.push(args);
    return { rename: { handle: 'master', tabId: 'tab', title: 'master · loader' } };
  };
  await revealRoleTitles(f);
  assert.deepEqual(f.calls, [['terminal', 'rename', '--terminal', 'master', '--title', 'master · loader']]);
  assert.match(warnings.join('\n'), /OMP ready.*master · loader/);
});

test('generic idle title does not hide a wrong sibling identity or rename receipt', async () => {
  const f = fixture();
  f.inventory.terminals[1].title = 'OMP ready';
  f.inventory.terminals[0].title = 'OMP > stranger';
  await assert.rejects(revealRoleTitles(f), /native role title/);
  assert.equal(f.calls.length, 0);
  f.inventory.terminals[0].title = 'OMP > master';
  f.log = () => {};
  await assert.rejects(revealRoleTitles(f), /receipt mismatch/);
});

for (const problem of ['wrong-role', 'missing', 'extra', 'foreign', 'disconnected', 'orphaned', 'different-tab', 'receipt']) {
  test(`shared title is not reported repaired with ${problem}`, async () => {
    const f = fixture(), row = f.inventory.terminals[1];
    if (problem === 'wrong-role') row.title = 'OMP > master';
    if (problem === 'missing') f.inventory.terminals.pop();
    if (problem === 'extra') f.inventory.terminals.push({ ...row, leafId: 'other' });
    if (problem === 'foreign') row.worktreePath = '/foreign';
    if (problem === 'disconnected') row.connected = false;
    if (problem === 'orphaned') row.orphaned = true;
    if (problem === 'different-tab') f.state.agents.loader.tabId = 'other';
    if (problem === 'receipt') f.cli = async () => ({ rename: { handle: 'foreign', tabId: 'tab', title: null } });
    await assert.rejects(revealRoleTitles(f), /role title|shared tab/);
    if (problem !== 'receipt') assert.equal(f.calls.length, 0);
  });
}

function customTitleFixture() {
  const f = fixture(), row = f.inventory.terminals[1];
  Object.assign(row, { title: 'OMP > RECOV: Verify frozen translation', incarnationId: 'inc', ptyId: 'pty', executionHostId: 'local' });
  f.state.agents.loader.session = { id: 'original-session', transcriptPath: '/project/loader.jsonl' };
  const live = { kind: 'agent', terminal: { ...row }, sessionPaths: ['/project/loader.jsonl'] };
  f.inspect = async () => live;
  f.log = () => {};
  f.cli = async args => { f.calls.push(args); return { rename: { handle: 'master', tabId: 'tab', title: 'master · loader' } }; };
  return { f, live };
}

test('a custom native session title keeps the shared label when its original conversation is proven', async () => {
  const { f } = customTitleFixture();
  await revealRoleTitles(f);
  assert.deepEqual(f.calls, [['terminal', 'rename', '--terminal', 'master', '--title', 'master · loader']]);
});

for (const problem of ['different-session', 'shell', 'replaced-pane', 'foreign-worktree', 'inspection-failed']) {
  test(`custom title fallback refuses ${problem}`, async () => {
    const { f, live } = customTitleFixture();
    if (problem === 'different-session') live.sessionPaths = ['/project/other.jsonl'];
    if (problem === 'shell') live.kind = 'shell';
    if (problem === 'replaced-pane') live.terminal.incarnationId = 'replacement';
    if (problem === 'foreign-worktree') live.terminal.worktreePath = '/foreign';
    if (problem === 'inspection-failed') f.inspect = async () => { throw new Error('probe failed'); };
    await assert.rejects(revealRoleTitles(f), /role title|probe failed/);
    assert.equal(f.calls.length, 0);
  });
}
