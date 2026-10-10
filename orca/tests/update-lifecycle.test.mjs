import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { updateLifecycle } from '../lib/update-lifecycle.mjs';

function fixture(t, restart) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'update-lifecycle-'));
  t.after(() => fs.rmSync(home, { force: true, recursive: true }));
  for (const project of ['one', 'two']) {
    fs.mkdirSync(path.join(home, 'projects', project), { recursive: true });
    fs.writeFileSync(path.join(home, 'projects', project, 'state.json'), JSON.stringify({ workspace: project,
      agents: { master: { agent: 'pi', session: { id: project }, tabId: project, leafId: 'leaf' } } }));
  }
  return updateLifecycle({ home, snapshot: () => ({}), log: () => {}, restart,
    cli: async () => ({ terminals: ['one', 'two'].map(tabId => ({ tabId, leafId: 'leaf', connected: true })) }) });
}

test('shutdown and recovery preserve roles across projects', async t => {
  const calls = [];
  const lifecycle = fixture(t, async request => calls.push([request.project, request.role, request.stopOnly === true]));
  const stopped = await lifecycle.stop('pi');
  assert.deepEqual(calls, [['one', 'master', true], ['two', 'master', true]]);
  await lifecycle.resume(stopped);
  assert.deepEqual(calls.slice(2), [['one', 'master', false], ['two', 'master', false]]);
});

test('partial shutdown failure restores roles already stopped', async t => {
  const calls = [];
  const lifecycle = fixture(t, async request => {
    calls.push([request.project, request.stopOnly === true]);
    if (request.project === 'two' && request.stopOnly) throw new Error('agent busy');
  });
  await assert.rejects(lifecycle.stop('pi'), /agent busy/);
  assert.deepEqual(calls, [['one', true], ['two', true], ['one', false], ['two', false]]);
});

test('first startup without project state has no managed roles to stop', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'update-first-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const lifecycle = updateLifecycle({ home, cli: async () => ({ terminals: [] }),
    restart: async () => assert.fail('no managed roles'), log: () => {} });
  assert.deepEqual(await lifecycle.stop('pi'), []);
});
