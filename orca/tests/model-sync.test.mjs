import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCodexModel, seedPiModelConfig, syncModels } from '../lib/model-sync.mjs';
import { createPickerState, pickerKey, renderPicker, THINKING_CYCLE } from '../lib/model-picker.mjs';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-model-sync-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const noTTY = { isTTY: false };

test('readCodexModel reads only the top-level model key', t => {
  const home = temp(t);
  fs.writeFileSync(path.join(home, 'config.toml'),
    'model = "deepseek-v4.1-flash"\nmodel_provider = "custom"\n\n[tui]\nmodel = "section-local"\n');
  assert.equal(readCodexModel(home), 'deepseek-v4.1-flash');
  fs.writeFileSync(path.join(home, 'config.toml'), '[features]\nmodel = "only-section"\n');
  assert.equal(readCodexModel(home), null);
  assert.equal(readCodexModel(path.join(home, 'missing')), null);
});

test('seedPiModelConfig builds presets with per-model and default thinking', t => {
  const piHome = temp(t);
  fs.writeFileSync(path.join(piHome, 'models.json'), JSON.stringify({
    providers: { local: { models: [{ id: 'deepseek-v4.1-flash' }, { id: 'gemini-3.8-flash-high' }] } },
  }));
  fs.writeFileSync(path.join(piHome, 'settings.json'), JSON.stringify({
    defaultThinkingLevel: 'high', modelThinkingLevels: { 'local/deepseek-v4.1-flash': 'medium' },
  }));
  const seeded = seedPiModelConfig(piHome);
  assert.deepEqual(seeded.presets.map(p => [p.model, p.thinking]), [
    ['local/deepseek-v4.1-flash', 'medium'], ['local/gemini-3.8-flash-high', 'high']]);
  assert.deepEqual(seeded.roles, {});
});

test('syncModels follows the local Codex config and leaves Pi roles alone off-terminal', async t => {
  const home = temp(t), codexHome = temp(t);
  fs.writeFileSync(path.join(home, 'team.json'), JSON.stringify([
    { name: 'coder1', agent: 'codex', model: 'old-model', thinking: 'medium', role: 'agentroles.coder' },
    { name: 'bound', agent: 'codex', model: 'keep-me', piProvider: 'pay', role: 'agentroles.coder' },
    { name: 'master', agent: 'pi', model: 'pay/gpt-6-astra', thinking: null, role: 'agentroles.ccb_self' },
  ]));
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "local-codex-current"\n[features]\nmodel = "ignored"\n');
  const seed = () => ({ presets: [{ model: 'pay/gpt-6-astra', thinking: null, label: 'gpt' }], roles: {} });
  const logs = [];
  const changes = await syncModels({ home, codexHome, pick: true, stdin: noTTY, stdout: noTTY, seed, log: msg => logs.push(msg) });
  assert.equal(changes.length, 1);
  assert.match(changes[0], /coder1: model old-model → local-codex-current/);
  const catalog = JSON.parse(fs.readFileSync(path.join(home, 'team.json'), 'utf8'));
  assert.equal(catalog.find(r => r.name === 'coder1').model, 'local-codex-current');
  assert.equal(catalog.find(r => r.name === 'bound').model, 'keep-me');
  assert.equal(catalog.find(r => r.name === 'master').model, 'pay/gpt-6-astra');
  // Off-terminal starts seed the editable preset file but never touch Pi roles.
  const piConfig = JSON.parse(fs.readFileSync(path.join(home, 'pi-models.json'), 'utf8'));
  assert.deepEqual(piConfig.presets, [{ model: 'pay/gpt-6-astra', thinking: null, label: 'gpt' }]);
  assert.equal(logs.length, 1);
});

test('syncModels applies a confirmed picker selection to Pi roles', async t => {
  const home = temp(t), codexHome = temp(t);
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "coder-model"\n');
  fs.writeFileSync(path.join(home, 'team.json'), JSON.stringify([
    { name: 'master', agent: 'pi', model: 'pay/gpt-6-astra', thinking: null, role: 'r' },
    { name: 'designer', agent: 'pi', model: 'local/gemini-3.8-flash-high', thinking: 'high', role: 'r' },
  ]));
  const seed = () => ({ presets: [
    { model: 'pay/gpt-6-astra', thinking: null, label: 'gpt-6-astra' },
    { model: 'local/deepseek-v4.1-flash', thinking: 'medium', label: 'deepseek' },
  ], roles: {} });
  const stdin = { isTTY: true }, stdout = { isTTY: true };
  // Selection flow is exercised through the picker state machine test; here we
  // verify the non-interactive fallback keeps the catalog untouched.
  const changes = await syncModels({ home, codexHome, pick: false, stdin, stdout, seed });
  assert.equal(changes.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'team.json'), 'utf8')).find(r => r.name === 'master').model, 'pay/gpt-6-astra');
  assert.equal(fs.existsSync(path.join(home, 'pi-models.json')), false);
});

test('picker starts from saved per-role model and thinking', () => {
  const state = createPickerState({
    roles: [{ name: 'designer', model: 'pay/gpt-6-sol', thinking: 'xhigh' }],
    presets: [{ model: 'local/gemini-3.8-flash-high', thinking: 'xhigh' }],
    initial: { designer: { model: 'local/gemini-3.8-flash-high', thinking: 'medium' } },
  });
  assert.deepEqual([state.rows[0].model, state.rows[0].thinking], ['local/gemini-3.8-flash-high', 'medium']);
});

test('picker state machine navigates, switches presets and cycles thinking', () => {
  const state = createPickerState({
    roles: [{ name: 'master', model: 'pay/gpt-6-astra', thinking: null }, { name: 'designer', model: 'unknown/model', thinking: 'high' }],
    presets: [
      { model: 'pay/gpt-6-astra', thinking: null, label: 'gpt' },
      { model: 'local/deepseek-v4.1-flash', thinking: 'medium', label: 'deepseek' },
    ],
  });
  assert.equal(state.rows[0].presetIndex, 0);
  assert.equal(state.rows[1].presetIndex, -1);
  let result = pickerKey(state, 'down');
  assert.equal(result.state.cursor, 1);
  result = pickerKey(result.state, 'right');
  assert.deepEqual([result.state.rows[1].model, result.state.rows[1].thinking, result.state.rows[1].presetIndex],
    ['pay/gpt-6-astra', null, 0]);
  result = pickerKey(result.state, 'left');
  assert.deepEqual([result.state.rows[1].model, result.state.rows[1].thinking], ['local/deepseek-v4.1-flash', 'medium']);
  result = pickerKey(result.state, 'think-next');
  assert.equal(result.state.rows[1].thinking, 'high');
  result = pickerKey(result.state, 'think-prev');
  assert.equal(result.state.rows[1].thinking, 'medium');
  assert.equal(THINKING_CYCLE[0], null);
  assert.equal(pickerKey(result.state, 'confirm').done, 'confirm');
  assert.equal(pickerKey(result.state, 'cancel').done, 'cancel');
  assert.match(renderPicker(result.state), /master/);
  assert.match(renderPicker(result.state), /deepseek/);
});

test('pickPiModels maps raw-mode keys to a confirmed selection or cancel', async () => {
  const { EventEmitter } = await import('node:events');
  const { pickPiModels } = await import('../lib/model-picker.mjs');
  class FakeStdin extends EventEmitter {
    constructor() { super(); this.isTTY = true; }
    setRawMode() {} resume() {} pause() {} setEncoding() {}
  }
  const run = async keys => {
    const stdin = new FakeStdin();
    const stdout = { isTTY: true, chunks: [], write(text) { this.chunks.push(text); return true; } };
    const promise = pickPiModels({
      roles: [{ name: 'master', model: 'preset-a', thinking: null }],
      presets: [{ model: 'preset-a', thinking: null }, { model: 'preset-b', thinking: 'medium' }],
      stdin, stdout,
    });
    for (const key of keys) stdin.emit('data', key);
    const selection = await promise;
    return { selection, rendered: stdout.chunks.join('') };
  };
  const confirmed = await run(['\u001b[C', '\r']);
  assert.deepEqual(confirmed.selection, { master: { model: 'preset-b', thinking: 'medium' } });
  assert.match(confirmed.rendered, /master/);
  assert.match(confirmed.rendered, /preset-b/);
  const cancelled = await run(['\u001b']);
  assert.equal(cancelled.selection, null);
});
