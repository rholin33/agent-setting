import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, saveJson } from './team.mjs';
import { pickPiModels } from './model-picker.mjs';

// The top-level `model` key of the local Codex config; parsing stops at the
// first section so section-local keys are never mistaken for the default model.
export function readCodexConfig(codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  const file = path.join(codexHome, 'config.toml');
  const config = { model: null, thinking: null };
  if (!fs.existsSync(file)) return config;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const text = line.trim();
    if (text.startsWith('[')) break;
    const match = text.match(/^(model|model_reasoning_effort)\s*=\s*(?:"([^"]+)"|'([^']+)')/);
    if (match) config[match[1] === 'model' ? 'model' : 'thinking'] = match[2] ?? match[3];
  }
  return config;
}

export function readCodexModel(codexHome) {
  return readCodexConfig(codexHome).model;
}

// First run seeds presets from the Pi provider catalog plus thinking defaults.
export function seedPiModelConfig(piHome = path.join(os.homedir(), '.pi', 'agent')) {
  const modelsFile = path.join(piHome, 'models.json');
  const settingsFile = path.join(piHome, 'settings.json');
  const providers = fs.existsSync(modelsFile) ? readJson(modelsFile).providers || {} : {};
  const settings = fs.existsSync(settingsFile) ? readJson(settingsFile) : {};
  const presets = [];
  for (const [provider, definition] of Object.entries(providers)) {
    for (const model of definition.models || []) {
      const id = `${provider}/${model.id}`;
      presets.push({ model: id, thinking: settings.modelThinkingLevels?.[id] ?? settings.defaultThinkingLevel ?? null, label: id });
    }
  }
  if (!presets.length) throw new Error('No Pi models found; configure ~/.pi/agent/models.json first');
  return { presets, roles: {} };
}

export function loadPiModelConfig(home, seed = seedPiModelConfig, filename = 'pi-models.json') {
  const file = path.join(home, filename);
  if (fs.existsSync(file)) {
    const config = readJson(file);
    if (!Array.isArray(config.presets) || !config.presets.length) throw new Error(`Invalid presets in ${file}`);
    if (config.roles === undefined) config.roles = {};
    // 保留用户预设和选择，并补入 Pi 新增的 provider/model。
    const known = new Set(config.presets.map(preset => preset.model));
    const additions = seed().presets.filter(preset => !known.has(preset.model));
    if (additions.length) {
      config.presets.push(...additions);
      saveJson(file, config);
    }
    return { config, file, created: false };
  }
  const config = seed();
  saveJson(file, config);
  return { config, file, created: true };
}

// Syncs the role catalog before a start: Codex roles follow the local Codex
// config model; Pi roles go through the interactive picker when attached to a
// terminal. The picker is skipped (and team.json stays untouched for Pi) when
// stdin is not a TTY, e.g. Orca quick commands.
export async function syncModels({ home, names, pick = true, log = console.log, stdin = process.stdin, stdout = process.stdout, codexHome, seed } = {}) {
  const catalogFile = path.join(home, 'team.json');
  const catalog = readJson(catalogFile);
  const inScope = role => !names || names.includes(role.name);
  const changes = [];
  const codexRoles = catalog.filter(role => role.agent === 'codex' && !role.piProvider && inScope(role));
  const { model: codexModel, thinking: codexThinking } = readCodexConfig(codexHome);
  if (codexModel) {
    for (const role of codexRoles) {
      if (role.model !== codexModel || (role.thinking ?? null) !== codexThinking) {
        changes.push(`${role.name}: model ${role.model} → ${codexModel}, thinking ${role.thinking ?? 'default'} → ${codexThinking ?? 'default'} (local Codex config)`);
        role.model = codexModel;
        role.thinking = codexThinking;
      }
    }
  } else if (codexRoles.length) {
    log('Warning: local Codex config has no model key; Codex role models unchanged');
  }
  const piRoles = catalog.filter(role => ['pi', 'omp'].includes(role.agent) && inScope(role));
  if (!seed && piRoles.some(role => role.agent === 'omp')) seed = () => ({ presets: piRoles.map(role => ({ model: role.model, thinking: role.thinking, label: role.model })), roles: {} });
  const modelConfigFile = piRoles.some(role => role.agent === 'omp') ? 'omp-models.json' : 'pi-models.json';
  let config = null;
  let selectionMade = false;
  if (piRoles.length && pick) {
    const interactive = Boolean(stdin.isTTY && stdout.isTTY);
    let loaded = null;
    try { loaded = loadPiModelConfig(home, seed, modelConfigFile); }
    catch (error) { if (interactive) throw error; log(`Warning: ${error.message}`); }
    config = loaded?.config ?? null;
    if (config && interactive) {
      const selection = await pickPiModels({ roles: catalog.filter(inScope), presets: config.presets, initial: config.roles, stdin, stdout });
      if (selection) {
        selectionMade = true;
        for (const role of piRoles) {
          const chosen = selection[role.name];
          if (chosen && (role.model !== chosen.model || (role.thinking ?? null) !== chosen.thinking)) {
            changes.push(`${role.name}: model ${role.model} → ${chosen.model}, thinking ${role.thinking ?? 'default'} → ${chosen.thinking ?? 'default'}`);
            role.model = chosen.model;
            role.thinking = chosen.thinking;
          }
        }
        config.roles = { ...config.roles, ...selection };
      } else {
        log('Pi model picker cancelled; Pi role models unchanged');
      }
    }
  }
  if (changes.length) saveJson(catalogFile, catalog);
  if (selectionMade) saveJson(path.join(home, modelConfigFile), config);
  for (const change of changes) log(`Model sync: ${change}`);
  return changes;
}
