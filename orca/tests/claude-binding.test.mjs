import test from 'node:test';
import assert from 'node:assert/strict';
import { validateClaudeTerminal } from '../lib/claude-binding.mjs';
const endpoint = { runtime: 'claude', role: 'archi', environment: 'paired-mac', terminal: 'term-a', incarnation: 'inc-a', session: 'session-a' };
const config = { version: 1, role: 'archi', project: 'D:/project', environment: 'paired-mac', runtimeId: 'runtime-a', remoteWorktree: '/neutral/archi', endpoint };
const reply = { runtimeId: 'runtime-a', terminal: { handle: 'term-a', incarnationId: 'inc-a', connected: true, agentIdentity: 'claude', executionHostId: 'local', worktreePath: '/neutral/archi', providerSession: { id: 'session-a' } } };
test('Claude scoped binding accepts the paired host native directory and exact native session', () => {
  validateClaudeTerminal(config, endpoint, 'D:/project', reply);
});
for (const key of ['runtimeId', 'remoteWorktree', 'project', 'role']) {
  test(`Claude scoped binding rejects changed ${key}`, () => {
    assert.throws(() => validateClaudeTerminal({ ...config, [key]: 'other' }, endpoint, 'D:/project', reply));
  });
}
test('Claude scoped binding requires observed native session', () => {
  assert.throws(() => validateClaudeTerminal(config, endpoint, 'D:/project', { ...reply, terminal: { ...reply.terminal, providerSession: undefined } }));
});
test('Claude neutral directory requires native process proof bound to the exact PTY', () => {
  const scoped = { ...config, registeredWorktree: '/registered' };
  const observed = { ...reply, terminal: { ...reply.terminal, worktreePath: '/registered', ptyId: 'pty-a', providerSession: undefined },
    native: { terminal: endpoint.terminal, incarnation: endpoint.incarnation, session: endpoint.session, ptyId: 'pty-a', cwd: config.remoteWorktree, models: ['claude-opus-5-5'] } };
  validateClaudeTerminal(scoped, endpoint, 'D:/project', observed);
  validateClaudeTerminal(scoped, endpoint, 'D:/project', { ...observed, terminal: { ...observed.terminal, agentIdentity: undefined } });
  assert.throws(() => validateClaudeTerminal(scoped, endpoint, 'D:/project', { ...observed, terminal: { ...observed.terminal, agentIdentity: 'omp' } }));
  for (const key of ['terminal', 'incarnation', 'session', 'ptyId', 'cwd']) {
    assert.throws(() => validateClaudeTerminal(scoped, endpoint, 'D:/project', { ...observed, native: { ...observed.native, [key]: 'other' } }));
  }
  assert.throws(() => validateClaudeTerminal(scoped, endpoint, 'D:/project', { ...observed, native: { ...observed.native, models: ['sonnet'] } }));
});
