import test from 'node:test';
import assert from 'node:assert/strict';
import { binding } from '../lib/sessions.mjs';

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
