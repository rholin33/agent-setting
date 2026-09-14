import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProcess, recoverInPane, provesSession, inspectHealth } from '../lib/health.mjs';

test('native resume proof requires exact original conversation and a live agent', () => {
  const saved = { agent: 'pi', session: { id: 'original', transcriptPath: 'C:/sessions/original.jsonl' } };
  assert.equal(provesSession({ kind: 'agent', sessionPaths: ['C:\\sessions\\original.jsonl'] }, saved, 'win32'), true);
  assert.equal(provesSession({ kind: 'agent', sessionPaths: ['C:/sessions/other.jsonl'] }, saved), false);
  assert.equal(provesSession({ kind: 'shell', sessionPaths: ['C:/sessions/original.jsonl'] }, saved), false);
  assert.equal(provesSession({ kind: 'agent', sessionIds: ['original'] }, { ...saved, agent: 'codex' }), true);
});

test('POSIX session paths retain case sensitivity', () => {
  for (const platform of ['darwin', 'linux']) {
    const saved = { agent: 'pi', session: { id: 'a', transcriptPath: '/sessions/A.jsonl' } };
    assert.equal(provesSession({ kind: 'agent', sessionPaths: ['/sessions/a.jsonl'] }, saved, platform), false);
    assert.equal(provesSession({ kind: 'agent', sessionPaths: ['/sessions/A.jsonl'] }, saved, platform), true);
  }
});

test('only local Windows calls native inspection; POSIX and remote hosts use Orca evidence', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) for (const executionHostId of ['local', 'remote']) {
    const pane = { incarnationId: 'i', executionHostId };
    let native = 0, remote = 0;
    const result = await inspectHealth(async () => ({ terminal: pane }), async () => {
      remote++;
      return { process: { foregroundProcessEvidence: { verdict: 'live', processName: 'pi', ptyIncarnationId: 'i', capturedAgeMs: 0 } } };
    }, 'handle', 'pi', { platform, nativeInspect: async () => { native++; return { kind: 'agent', terminal: pane }; } });
    assert.equal(result.kind, 'agent');
    assert.equal(native, platform === 'win32' && executionHostId === 'local' ? 1 : 0);
    assert.equal(remote, 1 - native);
  }
});

const terminal = { incarnationId: 'current' };
const shell = { foregroundProcess: 'pwsh.exe', childProcessEvidence: 'no-children',
  foregroundProcessEvidence: { verdict: 'live', ptyIncarnationId: 'current', capturedAgeMs: 0 } };
test('unreadable process table and boolean false never prove idle shell', () => {
  assert.equal(classifyProcess({ hasChildProcesses: false, foregroundProcess: 'pwsh.exe',
    foregroundProcessEvidence: { verdict: 'unverifiable', reason: 'process_table_unreadable' } }, terminal, 'pi'), 'unverifiable');
  assert.equal(classifyProcess(shell, terminal, 'pi'), 'shell');
  assert.equal(classifyProcess(shell, { incarnationId: 'replaced' }, 'pi'), 'unverifiable');
  assert.equal(classifyProcess({ ...shell, childProcessEvidence: undefined }, terminal, 'pi'), 'unverifiable');
});
test('resume uses the same pane exactly once and retains pending on unproven recovery', async () => {
  const calls = [], saved = { agent: 'pi', session: { id: 'original' } };
  const options = { name: 'master', saved, handle: 'original-handle', command: 'resume-exact',
    inspect: async () => ({ kind: 'shell', terminal }), checkpoint: () => {},
    verifyBinding: async () => { throw new Error('unconfirmed'); },
    cli: async args => { calls.push(args); return args[1] === 'read' ? { terminal: { tail: ['PS D:\\Code\\sewpg>'] } } : { send: { accepted: true } }; } };
  await assert.rejects(recoverInPane(options), /unconfirmed/);
  assert.equal(saved.pending, true);
  assert.equal(saved.session.id, 'original');
  assert.equal(calls.filter(args => args[1] === 'send').length, 1);
  assert.equal(calls.at(-1)[3], 'original-handle');
});
test('unverified shell sends nothing', async () => {
  await assert.rejects(recoverInPane({ name: 'test', saved: { agent: 'pi' },
    inspect: async () => ({ kind: 'unverifiable', reason: 'process_table_unreadable' }),
    cli: () => assert.fail('must not send') }), /cannot be verified/);
});
