import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareLaunch, captureSession } from '../lib/launch-state.mjs';

test('durable launch intent survives retries and binds only a persisted live conversation', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-intent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const saved = {}, role = { name: 'archi', agent: 'pi', model: 'model' };
  prepareLaunch(saved, role, dir);
  const original = structuredClone(saved.launchIntent);
  prepareLaunch(saved, role, dir);
  assert.deepEqual(saved.launchIntent, original);
  assert.equal(captureSession(saved, { kind: 'agent' }, dir), false);
  fs.mkdirSync(path.dirname(original.transcriptPath), { recursive: true });
  fs.writeFileSync(original.transcriptPath, JSON.stringify({ type: 'session', id: 'session', cwd: dir }) + '\n');
  assert.equal(captureSession(saved, { kind: 'shell' }, dir), false);
  assert.equal(captureSession(saved, { kind: 'agent', sessionPaths: [original.transcriptPath] }, dir), true);
  assert.equal(saved.session.id, 'session');
  assert.throws(() => captureSession(saved, { kind: 'agent', sessionPaths: [path.join(dir, 'other')] }, dir), /differs/);
  assert.throws(() => captureSession(saved, { kind: 'agent' }, dir, { id: 'other', transcriptPath: original.transcriptPath }), /changed/);
});
