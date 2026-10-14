import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { binding, validateTranscript } from '../lib/sessions.mjs';

const project = '/tmp/binding-project';
const paneKey = 'tab:leaf';
const record = extra => ({ sleepingAgentSessionsByPaneKey: { [paneKey]: {
  paneKey, tabId: 'tab', worktreeId: `repo::${project}`, agent: 'codex', providerSession: { key: 'session_id', id: 'abc' }, ...extra
} } });

test('a Codex pane record without a transcript path keeps the saved transcript of the same conversation', () => {
  const saved = { agent: 'codex', tabId: 'tab', leafId: 'leaf', session: { id: 'abc', transcriptPath: '/sessions/abc.jsonl' } };
  assert.deepEqual(binding(record(), saved, project), { key: 'session_id', id: 'abc', transcriptPath: '/sessions/abc.jsonl' });
});

test('a pane record owned by another agent is ignored instead of failing the whole team', () => {
  const saved = { agent: 'pi', tabId: 'tab', leafId: 'leaf', session: { id: 'abc', transcriptPath: '/sessions/abc.jsonl' } };
  assert.equal(binding(record(), saved, project), null);
});

test('a live connection or a foreign worktree still rejects the binding', () => {
  const saved = { agent: 'codex', tabId: 'tab', leafId: 'leaf', session: { id: 'abc', transcriptPath: '/sessions/abc.jsonl' } };
  assert.throws(() => binding(record({ connectionId: 'live' }), saved, project), /does not match role\/project/);
  assert.throws(() => binding(record({ worktreeId: 'repo::/tmp/other' }), saved, project), /does not match role\/project/);
});

test('title-prefixed OMP recovery preserves conversation identity and project ownership', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-title-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const transcriptPath = path.join(directory, 'original.jsonl');
  const saved = { agent: 'omp', session: { id: 'original', transcriptPath } };
  const title = { type: 'title', v: 1, title: '微信照片验收 🌄', pad: ' '.repeat(4300) };
  const writeHeader = meta => fs.writeFileSync(transcriptPath, `${JSON.stringify(title)}\n${JSON.stringify({ type: 'session', version: 3, ...meta })}\n`);

  writeHeader({ id: 'original', cwd: project });
  assert.equal(validateTranscript(saved, project).id, 'original');
  writeHeader({ id: 'foreign', cwd: project });
  assert.throws(() => validateTranscript(saved, project), /identity\/project mismatch/);
  writeHeader({ id: 'original', cwd: '/tmp/foreign-project' });
  assert.throws(() => validateTranscript(saved, project), /identity\/project mismatch/);
});

test('title metadata alone cannot authorize a new or different conversation', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-title-only-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const transcriptPath = path.join(directory, 'original.jsonl');
  const saved = { agent: 'omp', session: { id: 'original', transcriptPath } };
  const title = { type: 'title', v: 1, title: '微信照片验收' };
  fs.writeFileSync(transcriptPath, JSON.stringify(title));
  assert.throws(() => validateTranscript(saved, project), /identity\/project mismatch/);
  fs.writeFileSync(transcriptPath, `${JSON.stringify({ ...title, v: 2 })}\n${JSON.stringify({ type: 'session', id: 'original', cwd: project })}\n`);
  assert.throws(() => validateTranscript(saved, project), /identity\/project mismatch/);
  fs.writeFileSync(transcriptPath, `${JSON.stringify(title)}\n${JSON.stringify({ type: 'session_meta', payload: { id: 'original', cwd: project } })}\n`);
  assert.throws(() => validateTranscript({ ...saved, agent: 'codex' }, project), /identity\/project mismatch/);
  fs.writeFileSync(transcriptPath, `${JSON.stringify(title)}\n`);
  assert.throws(() => validateTranscript(saved, project), /identity\/project mismatch|header unavailable/);
});
