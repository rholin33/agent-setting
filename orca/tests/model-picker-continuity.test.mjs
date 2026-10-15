import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createPickerState, pickerKey, pickPiModels, renderPicker } from '../lib/model-picker.mjs';
import { syncModels } from '../lib/model-sync.mjs';

const presets = [{ model: 'provider/current', thinking: null }, { model: 'provider/next', thinking: 'high' }];

function terminal() {
  class Input extends EventEmitter {
    constructor() { super(); this.isTTY = true; }
    setRawMode() {} resume() {} pause() {} setEncoding() {}
  }
  return {
    stdin: new Input(),
    stdout: { isTTY: true, chunks: [], write(text) { this.chunks.push(text); return true; } },
  };
}

function fixture(t, agent, mixed = false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-picker-continuity-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const roles = [{ name: 'worker', agent, model: 'provider/current', thinking: null }];
  if (mixed) roles.unshift({ name: 'master', agent: 'omp', model: 'provider/current', thinking: null });
  fs.writeFileSync(path.join(home, 'team.json'), JSON.stringify(roles));
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "provider/current"\n');
  const configFile = path.join(home, roles.some(role => role.agent === 'omp') ? 'omp-models.json' : 'pi-models.json');
  const config = { presets, roles: Object.fromEntries(roles.filter(role => role.agent !== 'codex').map(role => [role.name, { model: role.model, thinking: role.thinking }])) };
  if (Object.keys(config.roles).length) fs.writeFileSync(configFile, JSON.stringify(config));
  return { home, codexHome: home, seed: () => ({ presets, roles: {} }), configFile, config, roles };
}

test('picker initializes each row from remote ownership and retains its baseline while cycling', () => {
  const state = createPickerState({
    roles: ['remoteCodex', 'remoteOmp', 'remoteClaude', 'local', 'unset'].map(name => ({ name, model: 'provider/current' })),
    presets,
    initialRemote: { remoteCodex: 'codex', remoteOmp: 'omp', remoteClaude: 'claude', local: null },
  });
  assert.deepEqual(state.rows.map(row => [row.remote, row.initialRemote]), [
    ['codex', 'codex'], ['omp', 'omp'], ['claude', 'claude'], [null, null], [null, null],
  ]);
  let changed = state;
  for (let step = 0; step < 3; step++) changed = pickerKey(changed, 'remote-next').state;
  assert.equal(changed.rows[0].remote, null);
  assert.equal(changed.rows[0].initialRemote, 'codex');
  assert.equal(state.rows[0].remote, 'codex');
  assert.match(renderPicker(state), /remoteCodex[^\n]+remote: codex/);
  assert.match(renderPicker(state), /remoteOmp[^\n]+remote: omp/);
  assert.match(renderPicker(state), /remoteClaude[^\n]+remote: claude/);
  assert.match(renderPicker(state), /off: hand context back to the original local agent/);
  assert.match(renderPicker(state), /changes await confirmation, not an extra instance/);
});

test('confirmed picker results return every role CLI selection and omit unchanged remote fields', async () => {
  const roles = [
    { name: 'master', agent: 'omp', model: 'provider/current', thinking: null },
    { name: 'worker', agent: 'codex', model: 'provider/current', thinking: null },
  ];
  const current = agent => ({ agent, model: 'provider/current', thinking: null });
  for (const [keys, expected] of [
    ['\r', { master: current('omp'), worker: current('codex') }],
    ['\u001b[C\r', { master: { agent: 'omp', model: 'provider/next', thinking: 'high' }, worker: current('codex') }],
    ['rrrr\r', { master: current('omp'), worker: current('codex') }],
    ['\u001b[Brrr\r', { master: current('omp'), worker: { ...current('codex'), remote: null } }],
    ['r\u001b', null],
  ]) {
    const io = terminal();
    const result = pickPiModels({ roles, presets, initialRemote: { master: 'omp', worker: 'codex' }, ...io });
    io.stdin.emit('data', keys);
    assert.deepEqual(await result, expected);
  }
});

for (const agent of ['pi', 'omp', 'codex']) {
  for (const scenario of [
    { name: 'unchanged', runtime: 'codex', keys: '\r', requests: [] },
    { name: 'model only', runtime: 'omp', keys: '\u001b[C\r', requests: [], nextModel: true },
    { name: 'cycled back to initial ownership', runtime: 'codex', keys: 'rrrr\r', requests: [] },
    { name: 'return from Codex', runtime: 'codex', keys: 'rrr\r', requests: [{ runtime: null, role: 'worker' }] },
    { name: 'return from OMP', runtime: 'omp', keys: 'rr\r', requests: [{ runtime: null, role: 'worker' }] },
    { name: 'return from Claude', runtime: 'claude', keys: 'r\r', requests: [{ runtime: null, role: 'worker' }] },
    { name: 'select remote Claude', runtime: 'omp', keys: 'r\r', requests: [{ runtime: 'claude', role: 'worker' }] },
    { name: 'switch remote runtime', runtime: 'codex', keys: 'r\r', requests: [{ runtime: 'omp', role: 'worker' }] },
    { name: 'start remote', runtime: null, keys: 'r\r', requests: [{ runtime: 'codex', role: 'worker' }] },
    { name: 'cancel', runtime: 'omp', keys: '\u001b[Cr\u001b', requests: [], cancelled: true },
  ]) {
    test(`syncModels ${agent}: ${scenario.name}`, async t => {
      const setup = fixture(t, agent);
      const io = terminal();
      const remoteRequests = [];
      const remoteStates = { worker: scenario.runtime };
      const result = syncModels({ ...setup, ...io, remoteStates, remoteRequests, log() {} });
      assert.match(io.stdout.chunks.join(''), new RegExp(`worker[^\\n]+remote: ${scenario.runtime ?? 'off'}`));
      io.stdin.emit('data', scenario.keys);
      await result;
      assert.deepEqual(remoteRequests, scenario.requests);
      assert.deepEqual(remoteStates, { worker: scenario.runtime });
      // Codex 行可以选择 CLI：→ 切到下一个预设，即 Claude CLI。
      const expected = !scenario.nextModel ? { agent, model: 'provider/current', thinking: null }
        : agent === 'codex' ? { agent: 'claude', model: 'sonnet', thinking: 'high' } : { agent, model: 'provider/next', thinking: 'high' };
      const catalog = JSON.parse(fs.readFileSync(path.join(setup.home, 'team.json'), 'utf8'));
      assert.deepEqual(catalog, [{ ...setup.roles[0], ...expected }]);
      if (agent !== 'codex') {
        const saved = JSON.parse(fs.readFileSync(setup.configFile, 'utf8'));
        // 取消时不改写文件；确认后保存带 agent 的选择。
        assert.deepEqual(saved, scenario.cancelled ? setup.config : { presets, roles: { worker: expected } });
      } else {
        assert.equal(fs.existsSync(setup.configFile), false);
      }
    });
  }
}

test('syncModels mixed menu collects a Codex remote return without persisting remote state', async t => {
  const setup = fixture(t, 'codex', true);
  const io = terminal();
  const remoteRequests = [];
  const result = syncModels({ ...setup, ...io, remoteStates: { worker: 'omp', master: 'codex' }, remoteRequests, log() {} });
  io.stdin.emit('data', '\u001b[Brr\r');
  await result;
  assert.deepEqual(remoteRequests, [{ runtime: null, role: 'worker' }]);
  // 选择结果带上 agent，但不写入 remote 归属。
  assert.deepEqual(JSON.parse(fs.readFileSync(setup.configFile, 'utf8')), { presets, roles: { master: { agent: 'omp', model: 'provider/current', thinking: null } } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(setup.home, 'team.json'), 'utf8')), setup.roles);
});
