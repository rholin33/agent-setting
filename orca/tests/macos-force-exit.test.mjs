import test from 'node:test';
import assert from 'node:assert/strict';
import { terminateMacAgent } from '../lib/force-exit.mjs';

const terminal = { handle: 'h', ptyId: 'pty', incarnationId: 'original', executionHostId: 'local' };
const root = { pid: 1, parent: 0, group: 1, foreground: 2, tty: 'ttys001', created: 'Thu Oct 8 14:00:00 2026', name: 'zsh' };
const provider = { ...root, pid: 2, parent: 1, group: 2, name: 'pi', created: 'Thu Oct 8 14:00:01 2026' };
const child = { ...provider, pid: 3, parent: 2, name: 'curl', created: 'Thu Oct 8 14:00:02 2026' };
const host = { identity: { launchNonce: 'host' }, sessions: [{ terminalHandle: 'h', sessionId: 'pty', incarnationId: 'original', pid: 1, isAlive: true }] };

test('macOS stops only verified provider descendants and preserves the pane shell and external agents', async () => {
  let rows = [root, provider, child, { ...provider, pid: 99, parent: 0, tty: 'ttys002' }];
  const killed = [];
  await terminateMacAgent({ terminal, saved: { agent: 'pi' }, inventory: async () => host,
    processes: async () => rows, kill: (pid, signal) => {
      killed.push([pid, signal]); rows = rows.filter(row => row.pid !== pid);
    } });
  assert.deepEqual(killed, [[3, 'SIGKILL'], [2, 'SIGKILL']]);
  assert.deepEqual(rows.map(row => row.pid), [1, 99]);
});

for (const change of ['pid', 'pane', 'remote']) test(`macOS refuses termination after ${change} changes`, async () => {
  let scans = 0, hosts = 0;
  await assert.rejects(terminateMacAgent({ terminal: change === 'remote' ? { ...terminal, executionHostId: 'remote' } : terminal,
    saved: { agent: 'pi' },
    inventory: async () => ++hosts > 1 && change === 'pane' ? { ...host, identity: { launchNonce: 'other' } } : host,
    processes: async () => [root, ++scans > 1 && change === 'pid' ? { ...provider, created: 'Thu Oct 8 14:00:03 2026' } : provider],
    kill: () => assert.fail('must not terminate') }), /identity changed|remote/);
});
