export const THINKING_CYCLE = [null, 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

const SEQUENCES = {
  '\u001b[A': 'up', '\u001bOA': 'up',
  '\u001b[B': 'down', '\u001bOB': 'down',
  '\u001b[C': 'right', '\u001bOC': 'right',
  '\u001b[D': 'left', '\u001bOD': 'left',
  '\u001b[Z': 'backtab', '\t': 'tab',
};
const CHARACTERS = { ',': 'think-prev', '.': 'think-next', '\r': 'confirm', '\n': 'confirm', '\u0003': 'cancel', '\u001b': 'cancel' };

export function createPickerState({ roles, presets, initial = {} }) {
  if (!Array.isArray(roles) || !roles.length) throw new Error('No Pi roles to configure');
  if (!Array.isArray(presets) || !presets.length) throw new Error('No Pi model presets configured');
  for (const preset of presets) if (!preset || typeof preset.model !== 'string' || !preset.model.trim()) throw new Error('Invalid Pi model preset');
  const rows = roles.map(role => {
    const chosen = initial[role.name] || { model: role.model, thinking: role.thinking ?? null };
    if (typeof chosen.model !== 'string' || !chosen.model.trim()) throw new Error(`Invalid model for role ${role.name}`);
    return { name: role.name, model: chosen.model, thinking: chosen.thinking ?? null, presetIndex: presets.findIndex(p => p.model === chosen.model) };
  });
  return { rows, presets, cursor: 0 };
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
  if (['left', 'right', 'tab', 'backtab'].includes(key)) {
    const direction = key === 'left' || key === 'backtab' ? -1 : 1;
    const row = rows[state.cursor];
    const count = state.presets.length;
    const base = row.presetIndex >= 0 ? row.presetIndex : (direction > 0 ? -1 : 0);
    const index = ((base + direction) % count + count) % count;
    const preset = state.presets[index];
    const next = { ...row, presetIndex: index, model: preset.model, thinking: preset.thinking ?? null };
    return { state: { ...state, rows: rows.map((item, i) => (i === state.cursor ? next : item)) } };
  }
  if (key === 'think-next' || key === 'think-prev') {
    const row = rows[state.cursor];
    const current = THINKING_CYCLE.indexOf(row.thinking ?? null);
    const base = current >= 0 ? current : 0;
    const thinking = THINKING_CYCLE[(base + (key === 'think-next' ? 1 : THINKING_CYCLE.length - 1)) % THINKING_CYCLE.length];
    const next = { ...row, thinking };
    return { state: { ...state, rows: rows.map((item, i) => (i === state.cursor ? next : item)) } };
  }
  return { state };
}

export function renderPicker(state) {
  const lines = [
    '',
    '  Pi model selection for orca-team (presets from pi-models.json)',
    '  Up/Down: role   Left/Right or Tab: model   , / .: thinking   Enter: confirm   Esc: cancel',
    '',
  ];
  state.rows.forEach((row, index) => {
    const preset = row.presetIndex >= 0 ? state.presets[row.presetIndex] : null;
    const model = preset ? (preset.label || preset.model) : `${row.model} (custom)`;
    lines.push(`  ${index === state.cursor ? '\u25b8' : ' '} ${row.name.padEnd(10)} ${model.padEnd(42)} thinking: ${row.thinking ?? 'default'}`);
  });
  lines.push('');
  return '\u001b[2J\u001b[H' + lines.join('\n');
}

// Interactive raw-mode picker. Returns { role: { model, thinking } } or null when cancelled.
export async function pickPiModels({ roles, presets, initial = {}, stdin = process.stdin, stdout = process.stdout }) {
  if (!stdin.isTTY || !stdout.isTTY) return null;
  let state = createPickerState({ roles, presets, initial });
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
        else { key = CHARACTERS[input[index]] ?? null; length = 1; }
        index += length;
        if (!key) continue;
        const result = pickerKey(state, key);
        state = result.state;
        write(renderPicker(state));
        if (result.done === 'confirm') {
          finish(Object.fromEntries(state.rows.map(row => [row.name, { model: row.model, thinking: row.thinking }])));
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
