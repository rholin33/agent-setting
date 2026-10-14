import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectTerminalHost, daemonSessions } from '../lib/windows-health.mjs';

test('existing sessions select the older host over an empty upgraded host', () => {
  const newer = { identity: { launchNonce: 'new' }, sessions: [] };
  const older = { identity: { launchNonce: 'old' }, sessions: [{ terminalHandle: 'original' }] };
  assert.equal(selectTerminalHost([newer, older]), older);
  assert.equal(selectTerminalHost([newer]), newer);
});

test('multiple active hosts merge into one global inventory; missing inventories fail closed', () => {
  const merged = selectTerminalHost([
    { identity: { launchNonce: 'new' }, sessions: [{ terminalHandle: 'a' }] },
    { identity: { launchNonce: 'old' }, sessions: [{ terminalHandle: 'b' }] },
  ]);
  assert.deepEqual(merged, { identity: { launchNonce: 'new+old' }, sessions: [{ terminalHandle: 'a' }, { terminalHandle: 'b' }] });
  assert.throws(() => selectTerminalHost([
    { sessions: [{ terminalHandle: 'a' }] }, { sessions: [{ terminalHandle: 'a' }] },
  ]), /ambiguous/);
  assert.throws(() => selectTerminalHost([]), /unavailable/);
});

test('global inventory refuses a live host that cannot be read and ignores stale registrations', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-hosts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [version, pid] of [[39, 1001], [43, 1002]]) fs.writeFileSync(path.join(directory, `daemon-v${version}.pid`), JSON.stringify({ pid }));
  const live = { identity: { launchNonce: 'n43' }, sessions: [{ terminalHandle: 'a' }] };
  const read = async (_, version) => { if (version === 39) throw new Error('unreachable'); return live; };
  assert.equal(await daemonSessions(undefined, { directory, read, alive: pid => pid === 1002 }), live);
  await assert.rejects(daemonSessions(undefined, { directory, read, alive: () => true }), /inventory_incomplete/);
});

test('pane selection finds its exact host without hiding global ambiguity', () => {
  const terminal = { handle: 'archi', ptyId: 'pty-a', incarnationId: 'epoch-a' };
  const row = { terminalHandle: 'archi', sessionId: 'pty-a', incarnationId: 'epoch-a', isAlive: true };
  const owner = { sessions: [row] };
  const unrelated = { sessions: [{ ...row, terminalHandle: 'other' }] };
  assert.equal(selectTerminalHost([unrelated, owner], terminal), owner);
  assert.equal(selectTerminalHost([unrelated, owner]).sessions.length, 2);
  for (const patch of [{ sessionId: 'old-pty' }, { incarnationId: 'old-epoch' }, { isAlive: false }]) {
    assert.throws(() => selectTerminalHost([{ sessions: [{ ...row, ...patch }] }], terminal), /unavailable/);
  }
  assert.throws(() => selectTerminalHost([owner, { sessions: [row] }], terminal), /ambiguous/);
  assert.throws(() => selectTerminalHost([{ sessions: [row, row] }], terminal), /ambiguous/);
});
