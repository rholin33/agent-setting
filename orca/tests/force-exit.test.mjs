import test from 'node:test';
import assert from 'node:assert/strict';
import { exitAgent } from '../lib/force-exit.mjs';

function fixture(extra = {}) {
  let kind = 'agent';
  const calls = [];
  const terminal = { handle: 'h', incarnationId: 'original' };
  return { calls, options: { name: 'role', handle: 'h', saved: { agent: 'pi', session: { id: 'session' } },
    terminal, verify: async () => {}, checkpoint: () => calls.push('checkpoint'), sleep: async () => {}, log: () => {},
    inspect: async () => ({ kind, terminal }),
    cli: async args => {
      calls.push(args);
      if (args[1] === 'wait') return { wait: { satisfied: true } };
      if (args.includes('/quit')) kind = 'shell';
      return { send: { accepted: true } };
    },
    force: async () => { calls.push('force'); kind = 'shell'; }, ...extra } };
}

test('interrupts task then requests graceful exit, preserving restart intent', async () => {
  const { options, calls } = fixture();
  const result = await exitAgent(options);
  assert.equal(result.kind, 'shell');
  assert.ok(calls.find(row => Array.isArray(row) && row.includes('--interrupt')));
  assert.ok(calls.find(row => Array.isArray(row) && row.includes('/quit')));
  assert.ok(!calls.includes('force'));
  assert.equal(options.saved.restartIntent.sessionId, 'session');
});

test('busy agent is forcibly exited when graceful exit does not complete', async () => {
  const { options, calls } = fixture();
  options.cli = async args => { calls.push(args); return args[1] === 'wait' ? { wait: { satisfied: false } } : { send: { accepted: true } }; };
  assert.equal((await exitAgent(options)).kind, 'shell');
  assert.ok(calls.includes('force'));
});

test('changed pane never receives force termination', async () => {
  let killed = false;
  const { options } = fixture({
    inspect: async () => ({ kind: 'agent', terminal: { incarnationId: 'replacement' } }),
    force: async () => { killed = true; },
  });
  await assert.rejects(exitAgent(options), /pane changed/);
  assert.equal(killed, false);
});
