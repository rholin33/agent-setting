import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTerminalHost } from '../lib/windows-health.mjs';

test('existing sessions select the older host over an empty upgraded host', () => {
  const newer = { identity: { launchNonce: 'new' }, sessions: [] };
  const older = { identity: { launchNonce: 'old' }, sessions: [{ terminalHandle: 'original' }] };
  assert.equal(selectTerminalHost([newer, older]), older);
  assert.equal(selectTerminalHost([newer]), newer);
});

test('multiple active hosts and missing inventories fail closed', () => {
  assert.throws(() => selectTerminalHost([
    { sessions: [{}] }, { sessions: [{}] },
  ]), /ambiguous/);
  assert.throws(() => selectTerminalHost([]), /unavailable/);
});

test('pane selection finds its exact host without hiding global ambiguity', () => {
  const terminal = { handle: 'archi', ptyId: 'pty-a', incarnationId: 'epoch-a' };
  const row = { terminalHandle: 'archi', sessionId: 'pty-a', incarnationId: 'epoch-a', isAlive: true };
  const owner = { sessions: [row] };
  const unrelated = { sessions: [{ ...row, terminalHandle: 'other' }] };
  assert.equal(selectTerminalHost([unrelated, owner], terminal), owner);
  assert.throws(() => selectTerminalHost([unrelated, owner]), /ambiguous/);
  for (const patch of [{ sessionId: 'old-pty' }, { incarnationId: 'old-epoch' }, { isAlive: false }]) {
    assert.throws(() => selectTerminalHost([{ sessions: [{ ...row, ...patch }] }], terminal), /unavailable/);
  }
  assert.throws(() => selectTerminalHost([owner, { sessions: [row] }], terminal), /ambiguous/);
  assert.throws(() => selectTerminalHost([{ sessions: [row, row] }], terminal), /ambiguous/);
});
