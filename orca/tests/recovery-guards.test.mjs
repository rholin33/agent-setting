import test from 'node:test';
import assert from 'node:assert/strict';
import { assertUniqueRoleTabs, assertConversationAbsent, reconcileRoleTabs } from '../lib/recovery-guards.mjs';

const project = '/tmp/guard-project';
const config = { tabs: [{ title: 'designer', agents: ['designer'] }] };
const tab = { id: 'old', customTitle: 'designer' };
const snapshot = tabs => ({ tabsByWorktree: { [`repo::${project}`]: tabs } });

test('stale saved tabs can be replaced only after published-pane and process absence proof', async () => {
  const snap = snapshot([tab]);
  const state = { agents: { designer: { tabId: 'old', leafId: 'leaf', session: { id: 'original' } } } };
  let proofs = 0;
  const options = { snapshot: snap, project, config, state, inventory: { terminals: [] },
    published: async () => ({ tabs: [] }), verifyAbsent: async ({ missing }) => {
      proofs++; assert.equal(missing[0].saved.session.id, 'original'); return true;
    } };
  const reconciled = await reconcileRoleTabs(options);
  assert.doesNotThrow(() => assertUniqueRoleTabs(reconciled, project, config, { terminals: [] }));
  assert.equal(proofs, 1);
  assert.equal(snap.tabsByWorktree[`repo::${project}`].length, 1);
  await assert.rejects(reconcileRoleTabs({ ...options, state: { agents: state.agents }, verifyAbsent: async () => false }), /absence/);
  await assert.rejects(reconcileRoleTabs({ ...options, published: async () => ({ tabs: [{ parentTabId: 'old' }] }) }), /original pane/);
  await assert.rejects(reconcileRoleTabs({ ...options, state: { agents: {} } }), /conversation/);
});

test('a proven stale tab alongside its running replacement does not block later starts', async () => {
  const state = { agents: { designer: { tabId: 'new', leafId: 'leaf', session: { id: 'original' } } } };
  const inventory = { terminals: [{ tabId: 'new', leafId: 'leaf' }] };
  const snap = snapshot([tab, { ...tab, id: 'new' }]);
  await assert.rejects(reconcileRoleTabs({ snapshot: snap, project, config, state, inventory,
    published: async () => ({ tabs: [{ parentTabId: 'new' }] }),
    verifyAbsent: async () => { throw new Error('must use the durable recovery proof'); } }), /conversation/);
  state.retiredTabs = { old: { project, sessions: { designer: 'original' } } };
  const recovered = await reconcileRoleTabs({ snapshot: snap, project, config, state, inventory,
    published: async () => ({ tabs: [{ parentTabId: 'new' }] }), verifyAbsent: async () => false });
  assert.doesNotThrow(() => assertUniqueRoleTabs(recovered, project, config, inventory));
});

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
