import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { snapshot } from '../lib/orca.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-profile-snapshot-'));
  const directory = path.join(root, 'profiles', 'local-default');
  fs.mkdirSync(directory, { recursive: true });
  const prior = process.env.ORCA_TEAM_DATA_DIR;
  process.env.ORCA_TEAM_DATA_DIR = root;
  t.after(() => {
    if (prior === undefined) delete process.env.ORCA_TEAM_DATA_DIR;
    else process.env.ORCA_TEAM_DATA_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(directory, 'orca-data.json'), JSON.stringify({ workspaceSession: { stale: true } }));
  return directory;
}

function database(directory, { profile = 'local-default', hash, payload = JSON.stringify({ tabsByWorktree: { current: [] }, sleepingAgentSessionsByPaneKey: { live: { providerSession: { id: 'exact' } } } }) } = {}) {
  const db = new DatabaseSync(path.join(directory, 'profile-state.db'));
  db.exec('CREATE TABLE profile_state_meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE profile_state_documents (domain TEXT PRIMARY KEY, payload TEXT, domain_version INTEGER, revision INTEGER, content_hash TEXT)');
  db.prepare('INSERT INTO profile_state_meta VALUES (?, ?)').run('profile_id', profile);
  db.prepare('INSERT INTO profile_state_meta VALUES (?, ?)').run('revision', '9');
  db.prepare('INSERT INTO profile_state_documents VALUES (?, ?, ?, ?, ?)').run('workspaceSession', payload, 1, 9, hash ?? createHash('sha256').update(payload).digest('hex'));
  db.close();
}

test('snapshot uses the current SQLite workspace and native bindings instead of the legacy export', t => {
  const directory = fixture(t);
  database(directory);
  assert.deepEqual(snapshot(), { tabsByWorktree: { current: [] }, sleepingAgentSessionsByPaneKey: { live: { providerSession: { id: 'exact' } } } });
});

test('snapshot retains JSON support for profiles that have not migrated', t => {
  fixture(t);
  assert.deepEqual(snapshot(), { stale: true });
});

for (const scenario of ['wrong profile', 'bad hash', 'missing database']) {
  test(`snapshot refuses ${scenario} without falling back to obsolete JSON`, t => {
    const directory = fixture(t);
    if (scenario === 'missing database') fs.writeFileSync(path.join(directory, 'profile-state.db.authority'), 'sqlite\n');
    else database(directory, scenario === 'wrong profile' ? { profile: 'foreign' } : { hash: 'corrupt' });
    assert.throws(() => snapshot(), /profile|database|integrity/i);
  });
}
