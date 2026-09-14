import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWindows, inspectWindows } from '../lib/windows-health.mjs';

const root = { ProcessId: 10, ParentProcessId: 1, Name: 'pwsh.exe', Created: '100', SessionId: 1 };
const child = { ProcessId: 11, ParentProcessId: 10, Name: 'node.exe', Created: '110', SessionId: 1,
  CommandLine: 'node "C:/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"' };
const terminal = { handle: 't', ptyId: 'p', incarnationId: 'i', connected: true };
const session = { terminalHandle: 't', sessionId: 'p', incarnationId: 'i', isAlive: true, pid: 10 };
test('Windows distinguishes empty shell, Pi and unknown children', () => {
  assert.equal(classifyWindows([root], session, 'pi'), 'shell');
  assert.equal(classifyWindows([root, child], session, 'pi'), 'agent');
  assert.equal(classifyWindows([root, child], session, 'codex'), 'unverifiable');
  for (const change of [{ Created: '090' }, { SessionId: 2 }, { CommandLine: '' }]) {
    assert.equal(classifyWindows([root, { ...child, ...change }], session, 'pi'), 'unverifiable');
  }
});
test('Windows rejects root reuse, pane replacement and changing process trees', async () => {
  const inventory = async () => ({ identity: { launchNonce: 'daemon' }, sessions: [session] });
  const options = { inventory, processes: async () => [root] };
  assert.equal((await inspectWindows(terminal, 'pi', options)).kind, 'shell');
  let count = 0;
  await assert.rejects(inspectWindows(terminal, 'pi', { ...options,
    processes: async () => [{ ...root, Created: ++count === 1 ? '100' : '200' }] }), /root_identity_changed/);
  await assert.rejects(inspectWindows(terminal, 'pi', { ...options,
    show: async () => ({ ...terminal, incarnationId: 'new' }) }), /pane_identity_changed/);
  count = 0;
  assert.equal((await inspectWindows(terminal, 'pi', { ...options,
    processes: async () => ++count === 1 ? [root] : [root, child] })).kind, 'unverifiable');
  await assert.rejects(inspectWindows({ ...terminal, ptyId: 'other' }, 'pi', options), /identity_unavailable/);
});
