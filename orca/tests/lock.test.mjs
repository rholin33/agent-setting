import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withLock } from '../lib/team.mjs';
import { processStartTime } from '../lib/platform.mjs';

function lockFile(t, owner) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'start.node.lock');
  fs.writeFileSync(file, JSON.stringify(owner));
  return file;
}

test('a live pid that started after the lock was created is a reused pid and the lock is recovered', async t => {
  const started = Date.parse('2026-10-14T10:00:00Z');
  const file = lockFile(t, { pid: process.pid, createdAt: '2026-10-14T09:00:00.000Z' });
  assert.equal(await withLock(file, () => 'ran', { startTime: () => started }), 'ran');
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readdirSync(path.dirname(file)).filter(name => name.includes('.stale-')).length, 1);
});

test('a live owner that started before the lock keeps it, including when start time is unknown', async t => {
  const created = '2026-10-14T10:00:00.000Z';
  for (const startTime of [() => Date.parse('2026-10-14T09:00:00Z'), () => Date.parse(created) + 1000, () => null]) {
    const file = lockFile(t, { pid: process.pid, createdAt: created });
    await assert.rejects(async () => withLock(file, () => 'ran', { startTime }), /locked by live process/);
  }
});

test('process start time is read from the OS for live processes only', () => {
  const started = processStartTime(process.pid);
  assert.ok(started && started <= Date.now() && Date.now() - started < 10 * 60 * 1000);
  assert.equal(processStartTime(2 ** 22 + 12345), null);
});

test('mapLimit keeps input order, respects the concurrency limit and fails like a serial loop', async () => {
  const { mapLimit } = await import('../lib/platform.mjs');
  let running = 0, peak = 0;
  const result = await mapLimit([30, 10, 20, 0, 5], 2, async (delay, index) => {
    running++; peak = Math.max(peak, running);
    await new Promise(resolve => setTimeout(resolve, delay));
    running--;
    return index;
  });
  assert.deepEqual(result, [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
  await assert.rejects(mapLimit([1, 2], 2, async value => { if (value === 2) throw new Error('boom'); }), /boom/);
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});

test('Windows process start time comes from PowerShell Get-Process and failures read as unknown', () => {
  const calls = [];
  const run = (command, args) => { calls.push([command, args.at(-1)]); return '2026-10-14T09:30:00.0000000Z\r\n'; };
  assert.equal(processStartTime(4242, 'win32', run), Date.parse('2026-10-14T09:30:00Z'));
  assert.equal(calls[0][0], 'powershell.exe');
  assert.match(calls[0][1], /Get-Process -Id 4242 -ErrorAction Stop/);
  assert.equal(processStartTime(4242, 'win32', () => { throw new Error('Cannot find a process'); }), null);
});
