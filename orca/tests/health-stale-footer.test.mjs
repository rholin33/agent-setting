import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverInPane } from '../lib/health.mjs';

const prompt = 'PS D:\\Code\\sewpg>';
const stale = ['› Ask Codex to do anything', prompt,
  '  GPT-6.1-Sol high · D:\\Code\\sewpg · Fast off · main · …',
  '  ? for shortcuts              ⚠ 1 warning · f2 to view'];

function recovery({ source = 'screen', initial = stale, after = [prompt], draft, accepted = true, changeAt = 0, replacement = 'agent' } = {}) {
  const sends = [];
  const saved = { agent: 'codex', session: { id: 'original' } };
  let checks = 0, redraw = false, resumed = false, bindings = 0;
  const run = () => recoverInPane({ name: 'coder1', saved, handle: 'original-pane', command: 'resume-exact',
    checkpoint: () => {}, sleep: async () => {}, verifyBinding: async () => { bindings++; },
    inspect: async () => {
      checks++;
      return { kind: changeAt === checks ? replacement : resumed ? 'agent' : 'shell',
        terminal: { incarnationId: changeAt === checks && replacement === 'shell' ? 'replacement' : 'original' } };
    },
    cli: async args => {
      if (args[1] === 'read') return { terminal: { source, draft, tail: redraw ? after : initial } };
      assert.equal(args[1], 'send');
      const text = args[args.indexOf('--text') + 1];
      sends.push([text, args.includes('--enter')]);
      if (text === '\x0c') redraw = true;
      if (text === 'resume-exact') resumed = true;
      return { send: { accepted } };
    } });
  return { run, sends, saved, bindings: () => bindings };
}

test('stale Codex footer below PowerShell triggers one verified redraw before exact resume', async () => {
  const fixture = recovery();
  await fixture.run();
  assert.deepEqual(fixture.sends, [['\x0c', false], ['resume-exact', true]]);
  assert.equal(fixture.saved.session.id, 'original');
  assert.equal(fixture.saved.pending, undefined);
  assert.equal(fixture.bindings(), 2);
});

for (const replacement of ['agent', 'unverifiable', 'shell']) {
  test(`stale footer does not redraw when process or incarnation changes: ${replacement}`, async () => {
    const fixture = recovery({ changeAt: 2, replacement });
    await assert.rejects(fixture.run(), /process changed before.*redraw/);
    assert.deepEqual(fixture.sends, []);
  });
}

test('unconfirmed redraw never sends a resume command', async () => {
  const fixture = recovery({ accepted: false });
  await assert.rejects(fixture.run(), /redraw.*not confirmed/);
  assert.deepEqual(fixture.sends, [['\x0c', false]]);
});

test('footer still present after bounded redraw never receives resume', async () => {
  const fixture = recovery({ after: stale });
  await assert.rejects(fixture.run(), /shell prompt is not empty/);
  assert.deepEqual(fixture.sends, [['\x0c', false]]);
});

test('changed process after redraw never receives resume', async () => {
  const fixture = recovery({ changeAt: 3 });
  await assert.rejects(fixture.run(), /process changed during.*redraw/);
  assert.deepEqual(fixture.sends, [['\x0c', false]]);
});

test('scrollback containing a historical prompt never authorizes redraw', async () => {
  const fixture = recovery({ source: 'scrollback' });
  await assert.rejects(fixture.run(), /shell prompt is not empty/);
  assert.deepEqual(fixture.sends, []);
});

test('redraw preserves a real input draft and refuses to resume', async () => {
  const fixture = recovery({ after: [`${prompt}Remove-Item important-file`] });
  await assert.rejects(fixture.run(), /shell prompt is not empty/);
  assert.deepEqual(fixture.sends, [['\x0c', false]]);
});

test('reported draft prevents stale footer redraw', async () => {
  const fixture = recovery({ draft: 'user input' });
  await assert.rejects(fixture.run(), /shell prompt is not empty/);
  assert.deepEqual(fixture.sends, []);
});

test('unknown output without a PowerShell prompt does not trigger redraw', async () => {
  const fixture = recovery({ initial: ['? for shortcuts', 'unexpected output'] });
  await assert.rejects(fixture.run(), /shell prompt is not empty/);
  assert.deepEqual(fixture.sends, []);
});
