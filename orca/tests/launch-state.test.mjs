import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareLaunch, captureSession, appliedModelOf, sameAppliedConfig } from '../lib/launch-state.mjs';

test('OMP launch captures the session after a title prelude without changing history', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-launch-title-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const saved = { agent: 'omp', launchIntent: { transcriptPath: file } };
  const live = { kind: 'agent', sessionPaths: [file] };
  const title = JSON.stringify({ type: 'title', v: 1, title: 'master' }) + '\n';
  fs.writeFileSync(file, title);
  assert.equal(captureSession(saved, live, dir), false);
  const text = title + JSON.stringify({ type: 'session', id: 'original', cwd: dir }) + '\n';
  fs.writeFileSync(file, text);
  assert.throws(() => captureSession(saved, live, dir + '-other'), /mismatch/);
  assert.equal(captureSession(saved, live, dir), true);
  assert.equal(saved.session.id, 'original');
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('Pi launch waits for an empty or partially written header without discarding intent', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-header-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const saved = { agent: 'pi', launchIntent: { transcriptPath: file } };
  const live = { kind: 'agent', sessionPaths: [file] };
  for (const content of ['', '{"type":"session",']) {
    fs.writeFileSync(file, content);
    assert.equal(captureSession(saved, live, dir), false);
    assert.equal(saved.session, undefined);
  }
  fs.writeFileSync(file, JSON.stringify({ type: 'session', id: 'ready', cwd: dir }) + '\n');
  assert.equal(captureSession(saved, live, dir), true);
  assert.equal(saved.session.id, 'ready');
});

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

test('Claude permission mode is part of the applied fingerprint; legacy Claude state restarts once', () => {
  const claude = { name: 'master', agent: 'claude', model: 'opus', thinking: 'high' };
  const codex = { name: 'coder1', agent: 'codex', model: 'gpt', thinking: 'medium' };
  assert.equal(sameAppliedConfig({ appliedModel: appliedModelOf(claude) }, claude), true);
  assert.equal(sameAppliedConfig({ appliedModel: { agent: 'claude', model: 'opus', thinking: 'high' } }, claude), false);
  assert.equal(sameAppliedConfig({ appliedModel: { agent: 'claude', model: 'opus', thinking: 'high', permission: 'default' } }, claude), false);
  assert.equal(sameAppliedConfig({ appliedModel: { agent: 'codex', model: 'gpt', thinking: 'medium' } }, codex), true);
});
