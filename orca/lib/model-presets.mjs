export const AGENT_ORDER = ['omp', 'pi', 'codex', 'claude'];
const compare = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare;

function compareModels(a, b) {
  const [providerA, ...modelA] = a.model.split('/');
  const [providerB, ...modelB] = b.model.split('/');
  return compare(providerA, providerB) || compare(modelA.join('/'), modelB.join('/')) || a.model.localeCompare(b.model, 'en');
}

export function normalizePresets(presets) {
  const unique = new Map();
  for (const preset of presets) {
    const key = `${preset.agent || ''}\0${preset.model}`;
    if (!unique.has(key)) unique.set(key, preset);
  }
  return [...unique.values()].sort((a, b) => {
    const agent = AGENT_ORDER.indexOf(a.agent) - AGENT_ORDER.indexOf(b.agent);
    return agent || compareModels(a, b);
  });
}

export function presetsForAgent(presets, agent) {
  const eligible = presets.filter(preset => preset.agent ? preset.agent === agent : !agent || ['omp', 'pi'].includes(agent));
  const models = new Map();
  for (const preset of eligible) if (!models.has(preset.model) || preset.agent === agent) models.set(preset.model, preset);
  return [...models.values()].sort(compareModels);
}
