import { AGENT_ORDER, normalizePresets, presetsForAgent } from './model-presets.mjs';

export const THINKING_CYCLE = [null, 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const SEQUENCES = {
  '\u001b[A': 'up', '\u001bOA': 'up',
  '\u001b[B': 'down', '\u001bOB': 'down',
  '\u001b[C': 'right', '\u001bOC': 'right',
  '\u001b[D': 'left', '\u001bOD': 'left',
  '\u001b[Z': 'backtab', '\t': 'tab',
};
const CHARACTERS = { a: 'focus-agent', m: 'focus-model', r: 'remote-next', ',': 'think-prev', '.': 'think-next', '\r': 'confirm', '\n': 'confirm', '\u0003': 'cancel', '\u001b': 'cancel' };

export function createPickerState({ roles, presets, initial = {}, initialRemote = {} }) {
  if (!Array.isArray(roles) || !roles.length) throw new Error('No Pi roles to configure');
  if (!Array.isArray(presets) || !presets.length) throw new Error('No Pi model presets configured');
  for (const preset of presets) if (!preset || typeof preset.model !== 'string' || !preset.model.trim()) throw new Error('Invalid Pi model preset');
  presets = normalizePresets(presets);
  const rows = roles.map(role => {
    // Codex 跟随本机配置，Claude 直接使用 team.json；其余角色使用 Pi/OMP 预设。
    const editable = true;
    const saved = initial[role.name];
    const chosen = !['codex', 'claude'].includes(role.agent) && (!saved?.agent || saved.agent === role.agent) && saved || { model: role.model, thinking: role.thinking ?? null };
    if (typeof chosen.model !== 'string' || !chosen.model.trim()) throw new Error(`Invalid model for role ${role.name}`);
    const remote = initialRemote[role.name] ?? null;
    const compatible = presetsForAgent(presets, role.agent);
    return { name: role.name, agent: role.agent, editable, remote, initialRemote: remote, model: chosen.model, thinking: chosen.thinking ?? null,
      choices: { [role.agent]: { model: chosen.model, thinking: chosen.thinking ?? null } },
      presetIndex: presets.findIndex(p => p.model === chosen.model && compatible.includes(p)) };
  });
  return { rows, presets, cursor: 0, column: 'model' };
}

function changeAgent(state, row, direction) {
  const agents = AGENT_ORDER.filter(agent => row.choices[agent] || presetsForAgent(state.presets, agent).length);
  const index = agents.indexOf(row.agent);
  const agent = agents[(index + direction + agents.length) % agents.length];
  if (!agent || agent === row.agent) return row;
  const presets = presetsForAgent(state.presets, agent);
  const retained = ['pi', 'omp'].includes(agent) && presets.find(p => p.model === row.model);
  const chosen = row.choices[agent] || (retained ? { model: row.model, thinking: row.thinking } : presets[0]);
  return { ...row, agent, model: chosen.model, thinking: chosen.thinking ?? null,
    choices: { ...row.choices, [row.agent]: { model: row.model, thinking: row.thinking } },
    presetIndex: state.presets.findIndex(p => p.model === chosen.model && presets.includes(p)) };
}

// Pure key handling: returns the next state plus done: 'confirm' | 'cancel'.
export function pickerKey(state, key) {
  if (key === 'confirm') return { state, done: 'confirm' };
  if (key === 'cancel') return { state, done: 'cancel' };
  const rows = state.rows;
  if (key === 'up' || key === 'down') {
    const cursor = (state.cursor + (key === 'down' ? 1 : rows.length - 1)) % rows.length;
    return { state: { ...state, cursor } };
  }
  if (key === 'remote-next') {
    const runtimes = [null, 'codex', 'omp', 'claude'];
    const next = { ...rows[state.cursor], remote: runtimes[(runtimes.indexOf(rows[state.cursor].remote) + 1) % runtimes.length] };
    return { state: { ...state, rows: rows.map((item, i) => i === state.cursor ? next : item) } };
  }
  if (!rows[state.cursor].editable) return { state };
  if (['tab', 'backtab', 'focus-agent', 'focus-model'].includes(key)) {
    const column = key === 'focus-agent' ? 'agent' : key === 'focus-model' ? 'model' : state.column === 'agent' ? 'model' : 'agent';
    return { state: { ...state, column } };
  }
  if (['left', 'right'].includes(key)) {
    const direction = key === 'left' ? -1 : 1;
    const row = rows[state.cursor];
    if (state.column === 'agent') {
      const next = changeAgent(state, row, direction);
      return { state: { ...state, rows: rows.map((item, i) => i === state.cursor ? next : item) } };
    }
    if (row.agent === 'codex') return { state };
    const presets = presetsForAgent(state.presets, row.agent);
    const count = presets.length;
    if (!count) return { state };
    const current = presets.findIndex(p => p.model === row.model);
    const base = current >= 0 ? current : (direction > 0 ? -1 : 0);
    const index = ((base + direction) % count + count) % count;
    const preset = presets[index];
    const next = { ...row, presetIndex: state.presets.indexOf(preset), model: preset.model, thinking: preset.thinking ?? null };
    return { state: { ...state, rows: rows.map((item, i) => (i === state.cursor ? next : item)) } };
  }
  if (key === 'think-next' || key === 'think-prev') {
    const row = rows[state.cursor];
    if (row.agent === 'codex') return { state };
    const cycle = row.agent === 'claude' ? [null, 'low', 'medium', 'high', 'max'] : THINKING_CYCLE;
    const current = cycle.indexOf(row.thinking ?? null);
    const base = current >= 0 ? current : 0;
    const thinking = cycle[(base + (key === 'think-next' ? 1 : cycle.length - 1)) % cycle.length];
    const next = { ...row, thinking };
    return { state: { ...state, rows: rows.map((item, i) => (i === state.cursor ? next : item)) } };
  }
  return { state };
}

export function renderPicker(state) {
  const lines = [
    '',
    '  orca-team roles: agent models from provider presets; Codex uses local config',
    '  Up/Down: role   Tab/Shift-Tab: column   Left/Right: change   a/m: agent/model',
    '  , / .: thinking   r: remote off/codex/omp/claude   Enter: confirm   Esc: cancel',
    '  remote off: hand context back to the original local agent; changes await confirmation, not an extra instance',
    '',
    `    ${'role'.padEnd(10)} ${'agent'.padEnd(10)} ${'model'.padEnd(44)} thinking           remote`,
  ];
  state.rows.forEach((row, index) => {
    const preset = row.presetIndex >= 0 ? state.presets[row.presetIndex] : null;
    const model = row.agent === 'codex' ? `${row.model} (local config)` : row.agent === 'claude' ? row.model : preset ? (preset.label || preset.model) : `${row.model} (custom)`;
    const cell = (text, column) => index === state.cursor && state.column === column ? `[${text}]` : text;
    lines.push(`  ${index === state.cursor ? '\u25b8' : ' '} ${row.name.padEnd(10)} ${cell(row.agent || 'pi/omp', 'agent').padEnd(10)} ${cell(model, 'model').padEnd(44)} thinking: ${(row.thinking ?? 'default').padEnd(7)}   remote: ${row.remote ?? 'off'}`);
  });
  lines.push('');
  return '\u001b[2J\u001b[H' + lines.join('\n');
}

// Returns model selections plus remote only for changed ownership (null returns
// to the original local agent). Cancelled menus return null without requests.
export async function pickPiModels({ roles, presets, initial = {}, initialRemote = {}, confirmRemote = [], stdin = process.stdin, stdout = process.stdout }) {
  if (!stdin.isTTY || !stdout.isTTY) return null;
  let state = createPickerState({ roles, presets, initial, initialRemote });
  const write = text => stdout.write(text);
  write('\u001b[?25l');
  return await new Promise(resolve => {
    const finish = result => {
      try { stdin.setRawMode(false); } catch { /* not a TTY anymore */ }
      stdin.pause();
      stdin.removeListener('data', onData);
      write('\u001b[?25h');
      resolve(result);
    };
    const onData = chunk => {
      const input = String(chunk);
      let index = 0;
      while (index < input.length) {
        const three = input.slice(index, index + 3);
        const two = input.slice(index, index + 2);
        let key, length;
        if (SEQUENCES[three]) { key = SEQUENCES[three]; length = 3; }
        else if (SEQUENCES[two]) { key = SEQUENCES[two]; length = 2; }
        else { key = SEQUENCES[input[index]] ?? CHARACTERS[input[index]] ?? null; length = 1; }
        index += length;
        if (!key) continue;
        const result = pickerKey(state, key);
        state = result.state;
        write(renderPicker(state));
        if (result.done === 'confirm') {
          // 每个角色都返回 CLI/模型选择；remote 只在归属变化或需要确认时返回。
          finish(Object.fromEntries(state.rows.map(row => [row.name, { ...(row.agent ? { agent: row.agent } : {}), model: row.model, thinking: row.thinking,
            ...((row.remote !== row.initialRemote || confirmRemote.includes(row.name)) ? { remote: row.remote } : {}) }])));
          return;
        }
        if (result.done === 'cancel') { finish(null); return; }
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    write(renderPicker(state));
  });
}
