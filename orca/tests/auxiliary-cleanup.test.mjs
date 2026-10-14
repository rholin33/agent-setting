import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerAuxiliary, cleanupAuxiliary } from '../lib/auxiliary-cleanup.mjs';
import { projectFiles, saveJson } from '../lib/team.mjs';

function fixture(t, kind = 'remote-setup') {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aux-cleanup-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = home;
  const dir = path.dirname(projectFiles(home, project).state);
  fs.mkdirSync(dir, { recursive: true });
  const terminal = { handle: 'term_aux', incarnationId: 'epoch', connected: true, executionHostId: 'local', worktreePath: project, agentIdentity: 'codex' };
  const registry = { roles: { master: { setupOutcomes: [{ id: 'intent-a', status: 'accepted' }], owner: { terminal: 'term_owner' } } } };
  const repair = { status: 'completed', terminal: terminal.handle, incarnation: 'epoch', createdAt: 'created' };
  const save = () => { saveJson(path.join(dir, 'remote-switches.json'), registry); saveJson(path.join(dir, 'startup-repair.json'), repair); };
  save();
  const file = registerAuxiliary({ home, project, kind, terminal, intents: [{ role: 'master', id: 'intent-a' }], repairCreatedAt: 'created' }, false);
  let closed = false;
  const f = { file, home, dir, project, terminal, registry, repair, save, idle: true, draft: '› Ask Codex to do anything', serviceFree: true, calls: [] };
  f.cli = async args => {
    f.calls.push(args);
    if (args[1] === 'show') return { terminal };
    if (args[1] === 'wait') return { wait: { satisfied: f.idle } };
    if (args[1] === 'read') return { terminal: { source: 'screen', tail: [f.draft] } };
    if (args[1] === 'close') { closed = true; return {}; }
    if (args[1] === 'list') return { terminals: closed ? [] : [terminal] };
    throw new Error('Unexpected CLI operation');
  };
  f.run = () => cleanupAuxiliary(file, { cli: f.cli, services: async () => f.serviceFree });
  return f;
}

test('settled auxiliary closes only its pane and preserves receipt history', async t => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.dir, 'remote-switches.json'));
  assert.equal((await f.run()).status, 'closed');
  assert.deepEqual(f.calls.filter(a => a[1] === 'close'), [['terminal', 'close', '--terminal', 'term_aux']]);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, 'remote-switches.json')), before);
  await f.run();
  assert.equal(f.calls.filter(a => a[1] === 'close').length, 1);
});

for (const scenario of ['pending', 'wrong-outcome', 'partial-settlement', 'owner', 'service-binding', 'new-incarnation', 'other-project', 'busy', 'draft', 'service-child']) {
  test(`retains auxiliary when ${scenario}`, async t => {
    const f = fixture(t);
    if (scenario === 'pending') f.registry.roles.master.pending = { id: 'next-intent' };
    if (scenario === 'wrong-outcome') f.registry.roles.master.setupOutcomes[0].id = 'different-intent';
    if (scenario === 'partial-settlement') {
      const record = JSON.parse(fs.readFileSync(f.file)); record.intents.push({ role: 'archi', id: 'intent-b' }); saveJson(f.file, record);
    }
    if (scenario === 'owner') f.registry.roles.master.owner.terminal = 'term_aux';
    if (scenario === 'service-binding') {
      const runtime = path.join(f.home, 'remote-master/runtime/omp-test'); fs.mkdirSync(runtime, { recursive: true });
      saveJson(path.join(runtime, 'adapter.json'), { terminals: { relay: { handle: 'term_aux' } } });
    }
    if (scenario === 'new-incarnation') f.terminal.incarnationId = 'new';
    if (scenario === 'other-project') f.terminal.worktreePath = '/another';
    if (scenario === 'busy') f.idle = false;
    if (scenario === 'draft') f.draft = '› unfinished user request';
    if (scenario === 'service-child') f.serviceFree = false;
    f.save();
    assert.equal((await f.run()).status, 'retained');
    assert.equal(f.calls.some(a => a[1] === 'close'), false);
  });
}

test('rechecks settlement after idle and service inspection', async t => {
  const f = fixture(t);
  const result = await cleanupAuxiliary(f.file, { cli: f.cli, services: async () => {
    f.registry.roles.master.pending = { id: 'new-task' }; f.save(); return true;
  } });
  assert.equal(result.status, 'retained');
  assert.equal(f.calls.some(a => a[1] === 'close'), false);
});

test('repair must be completed for the exact created request', async t => {
  const f = fixture(t, 'startup-repair');
  f.repair.status = 'blocked'; f.save();
  assert.equal((await f.run()).status, 'retained');
  f.repair.status = 'completed'; f.repair.createdAt = 'new-request'; f.save();
  assert.equal((await f.run()).status, 'retained');
  f.repair.createdAt = 'created'; f.save();
  assert.equal((await f.run()).status, 'closed');
});
