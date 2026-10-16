import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverProtectedStart } from '../lib/protected-start.mjs';

for (const remoteFailed of [false, true]) test(`remote failure=${remoteFailed} still checks local sibling without touching protected roles`, async () => {
  const calls = [];
  const options = { tabs: [{ title: 'master', agents: ['master', 'loader'] }, { title: 'archi', agents: ['archi'] }, { title: 'coder', agents: ['coder1'] }],
    names: ['master', 'loader', 'archi'], protectedNames: new Set(['master', 'archi']),
    remote: async () => { if (remoteFailed) throw Error('remote proof failed'); },
    reload: async names => { calls.push(['reload', names]); return { skipped: [] }; },
    run: async (group, preserveRoles) => calls.push(['run', group, preserveRoles]), log: () => {} };
  if (remoteFailed) await assert.rejects(recoverProtectedStart(options), /remote proof failed/);
  else await recoverProtectedStart(options);
  assert.deepEqual(calls, [['reload', ['loader']], ['run', 'master', ['master', 'archi']]]);
});

test('a failed local sibling is reported while independent groups can finish', async () => {
  const visited = [];
  await assert.rejects(recoverProtectedStart({
    tabs: [{ title: 'master', agents: ['master', 'loader'] }, { title: 'coder', agents: ['coder1'] }],
    names: ['master', 'loader', 'coder1'], protectedNames: new Set(['master']), remote: async () => {},
    reload: async () => ({ skipped: [] }),
    run: async group => { visited.push(group); if (group === 'master') throw Error('loader unconfirmed'); }, log: () => {},
  }), /loader unconfirmed/);
  assert.deepEqual(visited, ['master', 'coder']);
});
