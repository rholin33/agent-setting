import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPickerState, pickerKey, renderPicker } from '../lib/model-picker.mjs';
import { parseRemoteRequests, startRemoteRequests, remoteManagementPrompt, verifyRemoteEnvironment } from '../lib/remote-start.mjs';
import { beginRemoteSwitch, readRemoteSwitches } from '../lib/remote-switch.mjs';
import { supportsDirectHandoff } from '../lib/remote-handoff.mjs';

const role = { name: 'master', agent: 'omp', model: 'pay/example' };
test('startup validates merged remote requests before stopping roles for a CLI switch', () => {
  const source = fs.readFileSync(new URL('../bin/orca-team.mjs', import.meta.url), 'utf8');
  const merge = source.indexOf('for (const request of pickerRequests)');
  const verify = source.indexOf('await verifyRemoteEnvironment(');
  const stop = source.indexOf("await stage('CLI switch'");
  assert.ok(merge < verify && verify < stop);
});
test('Claude environment preflight distinguishes missing, ambiguous and explicit targets', async () => {
  const requests = [{ runtime: 'claude', role: 'master' }];
  await assert.rejects(verifyRemoteEnvironment({ requests, cli: async () => ({ environments: [] }) }), /no saved remote environment/i);
  const cli = async () => ({ environments: [{ id: 'a', name: 'host-a' }, { id: 'b', name: 'host-b' }] });
  await assert.rejects(verifyRemoteEnvironment({ requests, cli }), /select --environment/i);
  assert.equal(await verifyRemoteEnvironment({ requests, environment: 'host-b', cli }), 'b');
  assert.equal(await verifyRemoteEnvironment({ requests: [], cli: async () => { throw new Error('unexpected call'); } }), undefined);
});
test('r cycles through remote Claude without changing the local CLI/model', () => {
  let state = createPickerState({ roles: [role], presets: [{ model: role.model }] });
  for (const runtime of ['codex', 'omp', 'claude', null]) {
    state = pickerKey(state, 'remote-next').state;
    assert.equal(state.rows[0].remote, runtime);
    assert.equal(state.rows[0].agent, 'omp');
    assert.equal(state.rows[0].model, role.model);
  }
  assert.match(renderPicker(state), /off\/codex\/omp\/claude/);
  assert.deepEqual(parseRemoteRequests(['claude:master'], ['master']), [{ runtime: 'claude', role: 'master' }]);
});
test('Claude owner return uses coordinator instead of local transcript transport', () => {
  assert.equal(supportsDirectHandoff({ role: 'master', runtime: null }, { roles: { master: { runtime: 'claude' } } }), false);
  assert.equal(supportsDirectHandoff({ role: 'master', runtime: 'omp' }, { roles: { master: { runtime: 'claude' } } }), false);
});
test('Claude request without remote environment stops before durable intent or creation', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-claude-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  await assert.rejects(startRemoteRequests({ home, project: home, requests: [{ runtime: 'claude', role: 'master' }],
    skill: fileURLToPath(import.meta.url), cli: async args => { calls.push(args); return { environments: [] }; } }), /verified Orca environment/);
  assert.deepEqual(calls, [['environment', 'list']]);
  assert.deepEqual(readRemoteSwitches({ home, project: home }).roles, {});
});
test('Claude intent accepts proven Claude source and survives registry reload', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-claude-registry-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const source = { runtime: 'claude', role: 'master', environment: 'local', terminal: 'term_source', incarnation: 'inc1', session: 'session1' };
  const intent = await beginRemoteSwitch({ home, project: home, role: 'master', runtime: 'claude', source, local: source, environment: 'remote-host' });
  assert.equal(readRemoteSwitches({ home, project: home }).roles.master.pending.runtime, 'claude');
  const prompt = remoteManagementPrompt({ intents: [{ ...intent, role: 'master' }], home, project: home, skill: 'skill.md' });
  assert.match(prompt, /orca-remote -claude master/);
});
