import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPickerState, pickerKey, renderPicker, pickPiModels } from '../lib/model-picker.mjs';

const roles = [{ name: 'master', agent: 'omp', model: 'pay/gpt-6', thinking: 'xhigh' }];
const presets = [
  { model: 'pay/gpt-10', thinking: 'high' },
  { agent: 'claude', model: 'sonnet', thinking: 'high' },
  { model: 'pay/gpt-6', thinking: 'xhigh' },
  { model: 'pay/gpt-6', thinking: 'xhigh' },
  { model: 'local/gemini-3', thinking: null },
  { agent: 'codex', model: 'local-default', thinking: 'medium' },
];

test('model cycling is sorted and deduplicated and never changes the agent', () => {
  let state = createPickerState({ roles, presets });
  const seen = [];
  for (let i = 0; i < 3; i++) {
    state = pickerKey(state, 'right').state;
    assert.equal(state.rows[0].agent, 'omp');
    seen.push(state.rows[0].model);
  }
  assert.deepEqual(seen, ['pay/gpt-10', 'local/gemini-3', 'pay/gpt-6']);
  assert.equal(state.presets.length, 5);
});

test('Tab focuses the agent column without changing selection; switching back restores model and thinking', () => {
  let state = createPickerState({ roles, presets });
  state = pickerKey(state, 'tab').state;
  assert.equal(state.column, 'agent');
  assert.equal(state.rows[0].agent, 'omp');
  state = pickerKey(state, 'right').state;
  assert.equal(state.rows[0].agent, 'pi');
  assert.equal(state.rows[0].model, 'pay/gpt-6');
  state = pickerKey(state, 'right').state;
  assert.equal(state.rows[0].agent, 'codex');
  assert.equal(state.rows[0].model, 'local-default');
  assert.equal(state.rows[0].thinking, 'medium');
  state = pickerKey(state, 'right').state;
  assert.equal(state.rows[0].agent, 'claude');
  state = pickerKey(state, 'right').state;
  assert.deepEqual([state.rows[0].agent, state.rows[0].model, state.rows[0].thinking], ['omp', 'pay/gpt-6', 'xhigh']);
  assert.match(renderPicker(state), /role\s+agent\s+model/);
  assert.match(renderPicker(state), /master\s+\[omp\]/);
});

test('Codex model arrows retain local config and agent choice excludes unsupported CLIs', () => {
  const state = createPickerState({ roles: [{ name: 'coder', agent: 'codex', model: 'mine', thinking: 'high' }], presets: [{ agent: 'claude', model: 'opus' }] });
  assert.equal(pickerKey(state, 'right').state.rows[0].agent, 'codex');
  assert.equal(pickerKey(state, 'right').state.rows[0].model, 'mine');
  const changed = pickerKey(pickerKey(state, 'tab').state, 'right').state;
  assert.equal(changed.rows[0].agent, 'claude');
  assert.equal(pickerKey(changed, 'right').state.rows[0].agent, 'codex');
});

test('raw Tab and Shift-Tab move between columns and cancel discards changes', async () => {
  const stdin = new EventEmitter();
  Object.assign(stdin, { isTTY: true, setRawMode() {}, resume() {}, pause() {}, setEncoding() {} });
  const stdout = { isTTY: true, write() {} };
  const run = keys => { const result = pickPiModels({ roles, presets, stdin, stdout }); stdin.emit('data', keys); return result; };
  const agentOnly = await run('\t\u001b[C\r');
  assert.deepEqual(agentOnly.master, { agent: 'pi', model: 'pay/gpt-6', thinking: 'xhigh' });
  const selected = await run('\t\u001b[C\u001b[Z\u001b[C\r');
  assert.deepEqual(selected.master, { agent: 'pi', model: 'pay/gpt-10', thinking: 'high' });
  assert.equal(await run('\ta\u001b[C\u001b'), null);
});
