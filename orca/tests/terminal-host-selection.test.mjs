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
