import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-model-union-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const piHome = path.join(home, 'pi'), ompHome = path.join(home, 'omp');
  fs.mkdirSync(piHome); fs.mkdirSync(ompHome);
  return { home, piHome, ompHome };
}
const write = (dir, file, data) => fs.writeFileSync(path.join(dir, file), typeof data === 'string' ? data : JSON.stringify(data));

test('model sync unions providers and models, uses richer effective catalog, preserves native settings and backups', async t => {
  const { syncLocalModelConfigs, readAgentModelCatalog } = await import('../lib/local-model-config.mjs');
  const setup = fixture(t);
  const pi = { providers: { pay: { baseUrl: 'pi-url', apiKey: 'pi-secret', models: [{ id: 'a', name: 'pi-a', input: ['text'] }, { id: 'b' }] }, extra: { models: [{ id: 'c' }] } } };
  write(setup.piHome, 'models.json', pi);
  write(setup.piHome, 'settings.json', { theme: 'dark', packages: ['pi-plugin'], modelThinkingLevels: { 'pay/a': 'high' } });
  write(setup.ompHome, 'models.yml', 'providers:\n  pay:\n    baseUrl: omp-url\n    apiKey: omp-secret\n    models:\n      - id: a\n        name: omp-a\n        input: [image]\n      - id: d\n');
  write(setup.ompHome, 'models.json', { providers: { obsolete: { models: [{ id: 'legacy' }] } } });
  write(setup.ompHome, 'config.yml', 'theme: {dark: titanium}\ncompaction: {enabled: false}\nmodelThinkingLevels:\n  pay/a: medium\n  pay/d: xhigh\n');
  const before = fs.readFileSync(path.join(setup.ompHome, 'models.yml'), 'utf8');
  const result = await syncLocalModelConfigs(setup);
  assert.equal(result.preferred, 'pi');
  assert.equal(result.models, 4);
  const left = readAgentModelCatalog({ agent: 'pi', directory: setup.piHome });
  const right = readAgentModelCatalog({ agent: 'omp', directory: setup.ompHome });
  assert.deepEqual(left.models, right.models);
  assert.deepEqual(left.models.providers.pay.models.map(m => m.id), ['a', 'b', 'd']);
  assert.equal(right.models.providers.pay.baseUrl, 'pi-url');
  assert.equal(right.models.providers.pay.apiKey, 'pi-secret');
  assert.deepEqual(right.models.providers.pay.models[0].input, ['text', 'image']);
  assert.deepEqual(right.settings.theme, { dark: 'titanium' });
  assert.equal(right.settings.compaction.enabled, false);
  assert.deepEqual(left.settings.packages, ['pi-plugin']);
  assert.deepEqual(left.settings.modelThinkingLevels, { 'pay/a': 'high', 'pay/d': 'xhigh' });
  assert.deepEqual(left.settings.modelThinkingLevels, right.settings.modelThinkingLevels);
  assert.ok(result.backups.some(item => fs.readFileSync(item.backup, 'utf8') === before));
  assert.equal(JSON.parse(fs.readFileSync(path.join(setup.ompHome, 'models.json'), 'utf8')).providers.obsolete.models[0].id, 'legacy');
  assert.deepEqual((await syncLocalModelConfigs(setup)).changed, []);
});

test('OMP larger catalog wins conflicts; Pi wins ties; legacy JSON is used only without YAML', async t => {
  const { syncLocalModelConfigs, readAgentModelCatalog } = await import('../lib/local-model-config.mjs');
  const setup = fixture(t);
  write(setup.piHome, 'models.json', { providers: { p: { name: 'pi', models: [{ id: 'a' }] } } });
  write(setup.ompHome, 'models.json', { providers: { p: { name: 'omp', models: [{ id: 'a' }, { id: 'b' }] } } });
  assert.equal((await syncLocalModelConfigs(setup)).preferred, 'omp');
  assert.equal(readAgentModelCatalog({ agent: 'pi', directory: setup.piHome }).models.providers.p.name, 'omp');
  assert.ok(fs.existsSync(path.join(setup.ompHome, 'models.yml')));
  assert.equal((await syncLocalModelConfigs(setup)).preferred, 'pi');
});

test('invalid native YAML or malformed model entries abort without changing either side', async t => {
  const { syncLocalModelConfigs } = await import('../lib/local-model-config.mjs');
  const setup = fixture(t);
  const original = '{"providers":{"p":{"models":[{"id":"a"}]}}}';
  write(setup.piHome, 'models.json', original);
  write(setup.ompHome, 'models.yml', 'providers: [broken');
  await assert.rejects(() => syncLocalModelConfigs(setup), /Invalid/);
  assert.equal(fs.readFileSync(path.join(setup.piHome, 'models.json'), 'utf8'), original);
  write(setup.ompHome, 'models.yml', 'providers:\n  p:\n    models: [bad]\n');
  await assert.rejects(() => syncLocalModelConfigs(setup), /Invalid/);
  assert.equal(fs.readFileSync(path.join(setup.piHome, 'models.json'), 'utf8'), original);
});

test('catalog read supports YAML aliases, preserves slash model ids and produces no writes', async t => {
  const { readAgentModelCatalog } = await import('../lib/local-model-config.mjs');
  const setup = fixture(t);
  write(setup.ompHome, 'models.yaml', 'defaults: &defaults\n  api: openai-completions\nproviders:\n  local:\n    <<: *defaults\n    models:\n      - id: cline-pass/deepseek-v4.1-flash\n');
  const catalog = readAgentModelCatalog({ agent: 'omp', directory: setup.ompHome });
  assert.equal(catalog.models.providers.local.api, 'openai-completions');
  assert.equal(catalog.models.providers.local.models[0].id, 'cline-pass/deepseek-v4.1-flash');
  assert.equal(fs.existsSync(path.join(setup.ompHome, 'models.yml')), false);
});
