import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseDocument } from './vendor/yaml.mjs';

const mapping = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const natural = new Intl.Collator('en', { numeric: true }).compare;

export function agentConfigDirectory(agent, { userHome = os.homedir(), env = process.env } = {}) {
  const override = agent === 'pi' ? env.ORCA_PI_AGENT_DIR : env.ORCA_OMP_AGENT_DIR;
  if (override) return path.resolve(override);
  if (agent === 'omp' && env.OMP_PROFILE) return path.join(userHome, env.PI_CONFIG_DIR || '.omp', 'profiles', env.OMP_PROFILE, 'agent');
  return env.PI_CODING_AGENT_DIR || path.join(userHome, agent === 'pi' ? '.pi' : env.PI_CONFIG_DIR || '.omp', 'agent');
}

function readConfig(file) {
  if (!fs.existsSync(file)) return { file, text: null, data: {} };
  const text = fs.readFileSync(file, 'utf8');
  let data, document;
  try {
    if (/\.json$/i.test(file)) data = JSON.parse(text.replace(/^\uFEFF/, ''));
    else {
      document = parseDocument(text, { merge: true });
      if (document.errors.length) throw new Error('YAML syntax');
      data = document.toJS({ maxAliasCount: 100 }) ?? {};
    }
  } catch { throw new Error(`Invalid configuration syntax: ${file}`); }
  if (!mapping(data)) throw new Error(`Invalid configuration mapping: ${file}`);
  return { file, text, data, document };
}

function nativeFile(directory, name, legacy) {
  return ['yml', 'yaml'].map(ext => path.join(directory, `${name}.${ext}`)).find(fs.existsSync)
    || (legacy && fs.existsSync(path.join(directory, legacy)) ? path.join(directory, legacy) : path.join(directory, `${name}.yml`));
}

function validateModels(data, file) {
  if (data.providers === undefined) return;
  if (!mapping(data.providers)) throw new Error(`Invalid providers mapping: ${file}`);
  for (const provider of Object.values(data.providers)) {
    if (!mapping(provider) || provider.models !== undefined && (!Array.isArray(provider.models)
      || provider.models.some(model => !mapping(model) || typeof model.id !== 'string' || !model.id.trim()))) {
      throw new Error(`Invalid provider/model entries: ${file}`);
    }
  }
}

export function readAgentModelCatalog({ agent, directory = agentConfigDirectory(agent) }) {
  const models = readConfig(agent === 'pi' ? path.join(directory, 'models.json') : nativeFile(directory, 'models', 'models.json'));
  const settings = readConfig(agent === 'pi' ? path.join(directory, 'settings.json') : nativeFile(directory, 'config', 'settings.json'));
  validateModels(models.data, models.file);
  if (settings.data.modelThinkingLevels !== undefined && !mapping(settings.data.modelThinkingLevels)) throw new Error(`Invalid modelThinkingLevels: ${settings.file}`);
  return { directory, models: models.data, settings: settings.data, sources: { models, settings } };
}

function merge(primary, secondary) {
  if (mapping(primary) && mapping(secondary)) {
    return Object.fromEntries([...new Set([...Object.keys(primary), ...Object.keys(secondary)])].map(key => [key,
      owns(primary, key) ? owns(secondary, key) ? merge(primary[key], secondary[key]) : primary[key] : secondary[key]]));
  }
  if (Array.isArray(primary) && Array.isArray(secondary)) {
    return [...primary, ...secondary.filter(value => !primary.some(item => isDeepStrictEqual(item, value)))];
  }
  return primary;
}

function modelCount(catalog) {
  return Object.values(catalog.providers || {}).reduce((sum, provider) => sum + new Set((provider.models || []).map(model => model.id)).size, 0);
}

function mergeCatalog(primary, secondary) {
  const result = merge(primary, secondary);
  result.providers = Object.fromEntries(Object.keys(result.providers || {}).sort(natural).map(name => {
    const first = primary.providers?.[name] || {}, second = secondary.providers?.[name] || {};
    const provider = merge(first, second);
    if (first.models || second.models) {
      const models = new Map();
      for (const model of [...(first.models || []), ...(second.models || [])]) models.set(model.id, models.has(model.id) ? merge(models.get(model.id), model) : model);
      provider.models = [...models.values()].sort((a, b) => natural(a.id, b.id));
    }
    return [name, provider];
  }));
  return result;
}

function prepareWrite(source, data, yamlTarget) {
  if (isDeepStrictEqual(source.data, data) && (!yamlTarget || !source.file.endsWith('.json'))) return null;
  const file = yamlTarget && source.file.endsWith('.json') ? path.join(path.dirname(source.file), yamlTarget) : source.file;
  let text;
  if (file.endsWith('.json')) text = JSON.stringify(data, null, 2) + '\n';
  else {
    const document = source.document || parseDocument('');
    // 只更新变化的顶层字段，保留原 YAML 的其他字段和注释。
    for (const [key, value] of Object.entries(data)) if (!isDeepStrictEqual(source.data[key], value) || !source.document) document.set(key, value);
    text = document.toString({ lineWidth: 0 });
  }
  return { file, text, original: fs.existsSync(file) ? fs.readFileSync(file) : null, source };
}

function commitWrites(writes) {
  const stamp = `${Date.now()}-${randomUUID()}`, backups = [], completed = [];
  try {
    for (const write of writes) {
      fs.mkdirSync(path.dirname(write.file), { recursive: true });
      if (write.source.text !== null) {
        const backup = `${write.source.file}.orca-sync-${stamp}.bak`;
        fs.copyFileSync(write.source.file, backup, fs.constants.COPYFILE_EXCL);
        backups.push({ file: write.source.file, backup });
      }
      write.temporary = `${write.file}.orca-sync-${stamp}.tmp`;
      fs.writeFileSync(write.temporary, write.text, { mode: 0o600, flag: 'wx' });
    }
    for (const write of writes) {
      const current = fs.existsSync(write.source.file) ? fs.readFileSync(write.source.file, 'utf8') : null;
      if (current !== write.source.text) throw new Error(`Configuration changed during sync: ${write.source.file}`);
    }
    for (const write of writes) { fs.renameSync(write.temporary, write.file); completed.push(write); }
  } catch (error) {
    for (const write of completed.reverse()) {
      if (write.original !== null) fs.writeFileSync(write.file, write.original);
      else fs.rmSync(write.file, { force: true });
    }
    throw error;
  } finally {
    for (const write of writes) if (write.temporary) fs.rmSync(write.temporary, { force: true });
  }
  return backups;
}

export async function syncLocalModelConfigs({ piHome = agentConfigDirectory('pi'), ompHome = agentConfigDirectory('omp'), log = () => {} } = {}) {
  if (path.resolve(piHome) === path.resolve(ompHome)) throw new Error('Pi and OMP share a config directory; set distinct ORCA_PI_AGENT_DIR and ORCA_OMP_AGENT_DIR before syncing');
  const pi = readAgentModelCatalog({ agent: 'pi', directory: piHome });
  const omp = readAgentModelCatalog({ agent: 'omp', directory: ompHome });
  const preferred = modelCount(omp.models) > modelCount(pi.models) ? 'omp' : 'pi';
  const [primary, secondary] = preferred === 'pi' ? [pi, omp] : [omp, pi];
  const models = mergeCatalog(primary.models, secondary.models);
  if (!Object.keys(models.providers).length) return { preferred, models: 0, changed: [], backups: [] };
  const thinking = merge(primary.settings.modelThinkingLevels || {}, secondary.settings.modelThinkingLevels || {});
  const writes = [prepareWrite(pi.sources.models, models), prepareWrite(omp.sources.models, models, 'models.yml')];
  if (Object.keys(thinking).length) {
    writes.push(prepareWrite(pi.sources.settings, { ...pi.settings, modelThinkingLevels: thinking }));
    // 旧版 settings.json 仍由 OMP 自己迁移，避免抢先生成 YAML 跳过其迁移逻辑。
    writes.push(prepareWrite(omp.sources.settings, { ...omp.settings, modelThinkingLevels: thinking }));
  }
  const changed = writes.filter(Boolean);
  const backups = commitWrites(changed);
  const result = { preferred, models: modelCount(models), providers: Object.keys(models.providers).length, changed: changed.map(write => write.file), backups };
  log(`Pi/OMP model sync: ${result.providers} providers, ${result.models} models; ${preferred} preferred; ${changed.length} files changed`);
  for (const { backup } of backups) log(`Model configuration backup: ${backup}`);
  return result;
}
