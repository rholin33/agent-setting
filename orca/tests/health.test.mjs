import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProcess, recoverInPane, confirmConversationOwnership, provesSession, inspectHealth } from '../lib/health.mjs';

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
    }, 'handle', 'pi', { platform, nativeInspect: async () => { native++; return { kind: 'agent', terminal: pane }; }, macInspect: async () => ({ kind: 'agent', terminal: pane }) });
    assert.equal(result.kind, 'agent');
    assert.equal(native, platform === 'win32' && executionHostId === 'local' ? 1 : 0);
    assert.equal(remote, 1 - native);
  }
});

test('ambiguous foreground groups fall back to Orca agent status without opening shell recovery', async () => {
  const pane = { incarnationId: 'i', handle: 'h', executionHostId: 'local' };
  const ambiguous = { verdict: 'unverifiable', reason: 'ambiguous_foreground_group', ptyIncarnationId: 'i', capturedAgeMs: 0 };
  const calls = [];
  const rpc = async (method, params) => {
    calls.push(method);
    return method === 'terminal.agentStatus' ? { agentStatus: { isRunningAgent: params.terminal === 'h' } } : { process: { foregroundProcessEvidence: ambiguous } };
  };
  const cli = async () => ({ terminal: pane });
  const running = await inspectHealth(cli, rpc, 'h', 'codex', { platform: 'darwin' });
  assert.equal(running.kind, 'agent');
  assert.equal(running.reason, 'ambiguous_foreground_group_agent_status');
  assert.deepEqual(calls, ['terminal.inspectProcess', 'terminal.agentStatus']);
  calls.length = 0;
  // A pane Orca does not recognize as an agent stays unverifiable; it must never become an injectable shell.
  const idle = await inspectHealth(cli, async (method, params) => {
    calls.push(method);
    return method === 'terminal.agentStatus' ? { agentStatus: { isRunningAgent: false } } : { process: { foregroundProcessEvidence: ambiguous } };
  }, 'other', 'codex', { platform: 'linux' });
  assert.equal(idle.kind, 'unverifiable');
  assert.equal(idle.reason, 'ambiguous_foreground_group');
  assert.deepEqual(calls, ['terminal.inspectProcess', 'terminal.agentStatus']);
  // An Orca build without the agent-status RPC keeps the original unverifiable verdict.
  const unsupported = await inspectHealth(cli, async method => {
    if (method === 'terminal.agentStatus') throw new Error('Unknown method');
    return { process: { foregroundProcessEvidence: ambiguous } };
  }, 'h', 'codex', { platform: 'linux' });
  assert.equal(unsupported.kind, 'unverifiable');
  assert.equal(unsupported.reason, 'ambiguous_foreground_group');
  // Other unverifiable reasons keep their own evidence and never call the agent-status fallback.
  calls.length = 0;
  const unreadable = await inspectHealth(cli, async (method, params) => {
    calls.push(method);
    return { process: { foregroundProcessEvidence: { ...ambiguous, reason: 'process_table_unreadable' } } };
  }, 'h', 'codex', { platform: 'linux' });
  assert.equal(unreadable.kind, 'unverifiable');
  assert.equal(unreadable.reason, 'process_table_unreadable');
  assert.deepEqual(calls, ['terminal.inspectProcess']);
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
test('recovery retains pending when a briefly resumed agent exits', async () => {
  const saved = { agent: 'pi', session: { id: 'original' } };
  await assert.rejects(recoverInPane({ name: 'loader', saved, handle: 'h', command: 'resume',
    inspect: async () => ({ kind: 'shell', terminal }), checkpoint: () => {},
    verifyBinding: async () => {}, sleep: async () => {},
    cli: async args => args[1] === 'read' ? { terminal: { tail: ['PS C:\\project>'] } } : { send: { accepted: true } }
  }), /did not remain running/);
  assert.equal(saved.pending, true);
});
test('recovery verifies sustained agent identity before clearing pending', async () => {
  const saved = { agent: 'pi', session: { id: 'original' }, restartIntent: {} };
  let inspections = 0, bindings = 0;
  await recoverInPane({ name: 'loader', saved, handle: 'h', command: 'resume',
    inspect: async () => ({ kind: ++inspections <= 2 ? 'shell' : 'agent', terminal }),
    checkpoint: () => {}, verifyBinding: async () => { bindings++; }, sleep: async () => {},
    cli: async args => args[1] === 'read' ? { terminal: { tail: ['PS C:\\project>'] } } : { send: { accepted: true } }
  });
  assert.equal(bindings, 2);
  assert.equal(saved.pending, undefined);
  assert.equal(saved.restartIntent, undefined);
});
test('Codex resume takes over a conversation still open in another client', async () => {
  const calls = [];
  let locked = true;
  const cli = async args => {
    calls.push(args);
    if (args[1] === 'read') return { terminal: { source: 'screen', tail: locked ? ['🔒 This conversation is open in another app', 'Close it there and press R to continue here.'] : ['› Ask Codex to do anything'] } };
    if (args[1] === 'send' && args.at(-1) === 'R') { locked = false; return { send: { accepted: true } }; }
    return { send: { accepted: true } };
  };
  await confirmConversationOwnership({ name: 'coder1', saved: { agent: 'codex' }, handle: 'h', cli, sleep: async () => {} });
  assert.equal(calls.filter(args => args[1] === 'send').length, 1);
  assert.deepEqual(calls.find(args => args[1] === 'send'), ['terminal', 'send', '--terminal', 'h', '--text', 'R']);
  await assert.rejects(confirmConversationOwnership({ name: 'coder1', saved: { agent: 'codex' }, handle: 'h', attempts: 2, sleep: async () => {},
    cli: async () => ({ terminal: { tail: ['This conversation is open in another app'] } }) }), /takeover was not confirmed/);
  await confirmConversationOwnership({ name: 'master', saved: { agent: 'pi' }, handle: 'h', cli: () => assert.fail('must not read Pi screens') });
});

test('shell recovery clears only mouse report residue and still verifies the prompt', async () => {
 const saved={agent:'pi',session:{id:'original'}};
 let reads=0,inspections=0;const sends=[];
 await recoverInPane({name:'master',saved,handle:'h',command:'resume',sleep:async()=>{},checkpoint:()=>{},verifyBinding:async()=>{},
  inspect:async()=>({kind:++inspections<=2?'shell':'agent',terminal}),
  cli:async args=>{
   if(args[1]==='read')return {terminal:{tail:[++reads===1?'35;17;43M35;8;42M':'user@host %']}};
   sends.push(args[args.indexOf('--text')+1]);return {send:{accepted:true}};
  }});
 assert.deepEqual(sends,['\u0003','resume']);
});
