import test from 'node:test';
import assert from 'node:assert/strict';
import { assertUniqueRoleTabs, assertConversationAbsent } from '../lib/recovery-guards.mjs';

const project = '/tmp/guard-project';
const config = { tabs: [{ title: 'designer', agents: ['designer'] }] };
const tab = { id: 'old', customTitle: 'designer' };
const snapshot = tabs => ({ tabsByWorktree: { [`repo::${project}`]: tabs } });

test('retained durable tab prevents creating a replacement even without a live PTY', () => {
  assert.throws(() => assertUniqueRoleTabs(snapshot([tab]), project, config, { terminals: [] }), /original pane/);
  assert.doesNotThrow(() => assertUniqueRoleTabs(snapshot([tab]), project, config, { terminals: [{ tabId: 'old' }] }));
  assert.doesNotThrow(() => assertUniqueRoleTabs(snapshot([]), project, config, { terminals: [] }));
});

test('duplicate durable tabs block recovery before either pane receives input', () => {
  assert.throws(() => assertUniqueRoleTabs(snapshot([tab, { ...tab, id: 'new' }]), project, config,
    { terminals: [{ tabId: 'old' }, { tabId: 'new' }] }), /Duplicate durable tabs/);
});

test('the same durable tab listed twice by desktop and headless snapshots is not a duplicate', () => {
  assert.doesNotThrow(() => assertUniqueRoleTabs(snapshot([tab, { ...tab }]), project, config,
    { terminals: [{ tabId: 'old' }] }));
});

test('conversation moved to another live pane blocks resume despite changed process title', () => {
  const missing = [{ name: 'designer', saved: { session: { id: 'original', transcriptPath: '/sessions/original.jsonl' } } }];
  const terminals = [{ tabId: 'new', leafId: 'leaf' }];
  const snap = { sleepingAgentSessionsByPaneKey: { 'new:leaf': {
    agent: 'pi', worktreeId: `repo::${project}`, providerSession: { id: 'original' }
  } } };
  assert.throws(() => assertConversationAbsent(snap, project, missing, terminals), /another live pane/);
  snap.sleepingAgentSessionsByPaneKey['new:leaf'].providerSession = { id: 'other', transcriptPath: '/sessions/original.jsonl' };
  assert.throws(() => assertConversationAbsent(snap, project, missing, terminals), /another live pane/);
  snap.sleepingAgentSessionsByPaneKey['new:leaf'].providerSession = { id: 'other' };
  assert.doesNotThrow(() => assertConversationAbsent(snap, project, missing, terminals));
});
