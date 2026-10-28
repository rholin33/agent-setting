import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { provesClaudePresentation } from '../lib/claude-presentation-proof.mjs';

test('presentation proof requires the exact launcher, process, pane, heartbeat and remote endpoint', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-presentation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'binding.json');
  const launcher = fileURLToPath(new URL('../bin/claude-remote-terminal.mjs', import.meta.url));
  const config = { project: 'D:/project', role: 'master', runtimeId: 'remote-runtime', endpoint: { session: 'original' } };
  const terminal = { handle: 'terminal', incarnationId: 'incarnation', worktreePath: config.project, tabId: 'tab', leafId: 'leaf' };
  const status = { state: 'connected', pid: 11, localPane: 'tab:leaf', updatedAt: '2026-10-28T00:00:00Z',
    project: config.project, role: config.role, runtimeId: config.runtimeId, remote: config.endpoint };
  const receipt = { status: 'created', terminal };
  const row = { ProcessId: 11, Name: 'node.exe', CommandLine: `node "${launcher}" --config "${file}"` };
  const proof = { terminal, descendants: new Set([11]), rows: [row] };
  const write = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
  write('binding.json', config); write('local-terminal.json', receipt); write('local-terminal-status.json', status);
  const options = { now: Date.parse(status.updatedAt) + 1000 };
  assert.equal(provesClaudePresentation(proof, options), true);
  const connectionId = '00000000-0000-4000-8000-000000000001';
  write('local-terminal-status.json', { ...status, connectionId });
  const reconnect = { ...proof, rows: [{ ...row, CommandLine: `${row.CommandLine} --connection-id ${connectionId}` }] };
  assert.equal(provesClaudePresentation(reconnect, options), true);
  write('local-terminal-status.json', { ...status, connectionId: 'other' });
  assert.equal(provesClaudePresentation(reconnect, options), false);
  write('local-terminal-status.json', status);
  for (const changed of [{ pid: 12 }, { localPane: 'other:leaf' }, { remote: { session: 'other' } },
    { state: 'disconnected' }, { updatedAt: '2026-10-27T00:00:00Z' }, { role: 'archi' }]) {
    write('local-terminal-status.json', { ...status, ...changed });
    assert.equal(provesClaudePresentation(proof, options), false);
  }
  write('local-terminal-status.json', status);
  assert.equal(provesClaudePresentation({ ...proof, descendants: new Set() }, options), false);
  assert.equal(provesClaudePresentation({ ...proof, rows: [{ ...row, CommandLine: `node other.mjs --config "${file}"` }] }, options), false);
});
