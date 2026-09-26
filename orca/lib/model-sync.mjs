import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, saveJson } from './team.mjs';
import { pickPiModels } from './model-picker.mjs';

// The top-level `model` key of the local Codex config; parsing stops at the
// first section so section-local keys are never mistaken for the default model.
export function readCodexModel(codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  const file = path.join(codexHome, 'config.toml');
  if (!fs.existsSync(file)) return null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const text = line.trim();
    if (text.startsWith('[')) break;
    const match = text.match(/^model\s*=\s*(?:"([^"]+)"|'([^']+)')/);
    if (match) return match[1] ?? match[2];
  }
  return null;
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

export function loadPiModelConfig(home, seed = seedPiModelConfig) {
  const file = path.join(home, 'pi-models.json');
  if (fs.existsSync(file)) {
    const config = readJson(file);
    if (!Array.isArray(config.presets) || !config.presets.length) throw new Error(`Invalid presets in ${file}`);
    if (config.roles === undefined) config.roles = {};
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
  const codexModel = readCodexModel(codexHome);
  if (codexModel) {
    for (const role of codexRoles) {
      if (role.model !== codexModel) {
        changes.push(`${role.name}: model ${role.model} → ${codexModel} (local Codex config)`);
        role.model = codexModel;
      }
    }
  } else if (codexRoles.length) {
    log('Warning: local Codex config has no model key; Codex role models unchanged');
  }
  const piRoles = catalog.filter(role => role.agent === 'pi' && inScope(role));
  let config = null;
  let selectionMade = false;
  if (piRoles.length && pick) {
    const interactive = Boolean(stdin.isTTY && stdout.isTTY);
    let loaded = null;
    try { loaded = loadPiModelConfig(home, seed); }
    catch (error) { if (interactive) throw error; log(`Warning: ${error.message}`); }
    config = loaded?.config ?? null;
    if (config && interactive) {
      const selection = await pickPiModels({ roles: piRoles, presets: config.presets, initial: config.roles, stdin, stdout });
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
  if (selectionMade) saveJson(path.join(home, 'pi-models.json'), config);
  for (const change of changes) log(`Model sync: ${change}`);
  return changes;
}
