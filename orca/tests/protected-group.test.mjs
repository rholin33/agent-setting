import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTeam, projectFiles, readJson, saveJson } from '../lib/team.mjs';
import { normalizeProject } from '../lib/platform.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'protected-group-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = normalizeProject(home), files = projectFiles(home, project);
  fs.mkdirSync(files.directory, { recursive: true });
  const catalog = ['master', 'loader'].map(name => ({ name, agent: 'omp', model: 'fixture/model' }));
  const config = { workspace: project, pinTabs: true, tabs: [{ title: 'master', agents: ['master', 'loader'], direction: 'vertical', ratio: 0.5 }] };
  saveJson(path.join(home, 'team.json'), catalog); saveJson(path.join(home, 'layout.json'), config); saveJson(files.config, config);
  const master = { agent: 'omp', tabId: 'tab', leafId: 'master', session: { id: 'original-return', transcriptPath: '/must-not-read' }, pending: true };
  const handoff = { from: 'codex', sessionId: 'old-loader', path: 'retained-handoff.md' };
  saveJson(files.state, { workspace: project, agents: { master, loader: { agent: 'omp', tabId: 'tab', leafId: 'loader', handoff } } });
  const terminals = ['master', 'loader'].map(name => ({ handle: name, tabId: 'tab', leafId: name, worktreePath: project, incarnationId: `${name}-inc`, connected: true, title: `OMP > ${name}` }));
  const tabs = [{ tabId: 'tab', panes: { type: 'pane-split', direction: 'vertical', first: { leafId: 'master' }, second: { leafId: 'loader' } } }];
  const calls = []; let launched = false;
  const cli = async args => {
    calls.push(args);
    if (args[1] === 'list') return { terminals, visualLayouts: [{ root: { type: 'group', tabs } }] };
    if (args[1] === 'read') return { terminal: { source: 'screen', tail: ['PS C:\\project>'] } };
    if (args[1] === 'send') {
      assert.equal(args[args.indexOf('--terminal') + 1], 'loader');
      const saved = readJson(files.state).agents.loader;
      assert.equal(saved.pending, true); assert.deepEqual(saved.handoff, handoff);
      fs.mkdirSync(path.dirname(saved.launchIntent.transcriptPath), { recursive: true });
      fs.writeFileSync(saved.launchIntent.transcriptPath, JSON.stringify({ type: 'session', id: 'new-loader', cwd: project }) + '\n');
      launched = true; return { send: { accepted: true } };
    }
    if (args[1] === 'switch') { assert.equal(args.at(-1), 'loader'); return {}; }
    if (args[1] === 'rename') return { rename: { handle: args[3], tabId: 'tab', title: null } };
    throw Error(`Unexpected mutation: ${args.join(' ')}`);
  };
  const inspect = async handle => {
    assert.equal(handle, 'loader', 'protected source must not be inspected or restarted');
    return { kind: launched ? 'agent' : 'shell', terminal: terminals[1],
      sessionPaths: launched ? [readJson(files.state).agents.loader.launchIntent.transcriptPath] : [] };
  };
  const options = { home, project, action: 'start', group: 'master', preserveRoles: ['master'], cli, inspect,
    snapshot: () => ({}), sleep: async () => {}, log: () => {},
    restoreLayout: async () => assert.fail('protected tab layout must not move'), pin: async () => assert.fail('protected tab must not be repinned') };
  return { options, files, master, handoff, calls, terminals };
}

test('local sibling completes its selected CLI handoff in the original pane while remote source stays untouched', async t => {
  const f = fixture(t);
  await runTeam(f.options);
  const state = readJson(f.files.state);
  assert.deepEqual(state.agents.master, f.master);
  assert.deepEqual(state.agents.loader.handoff, f.handoff);
  assert.equal(state.agents.loader.session.id, 'new-loader');
  assert.equal(state.agents.loader.pending, undefined);
  assert.deepEqual(f.calls.find(call => call[1] === 'rename'),
    ['terminal', 'rename', '--terminal', 'master']);
  assert.equal(f.calls.filter(call => call[1] === 'send').length, 1);
  await runTeam(f.options);
  assert.equal(f.calls.filter(call => call[1] === 'send').length, 1);
});

test('mixed group title requires an exact rename receipt before reporting startup success', async t => {
  const f = fixture(t), cli = f.options.cli;
  f.options.cli = async args => args[1] === 'rename' ? { rename: { handle: 'other', tabId: 'foreign', title: args[5] } } : cli(args);
  await assert.rejects(runTeam(f.options), /titles.*unconfirmed/);
  assert.deepEqual(readJson(f.files.state).agents.master, f.master);
  assert.equal(readJson(f.files.state).agents.loader.session.id, 'new-loader');
});

test('missing local sibling in a protected tab fails instead of creating another tab or skipping success', async t => {
  const f = fixture(t); f.terminals.pop();
  await assert.rejects(runTeam(f.options), /existing pane.*loader|loader.*existing pane/);
  assert.ok(!f.calls.some(call => ['send', 'create', 'split'].includes(call[1])));
  assert.deepEqual(readJson(f.files.state).agents.master, f.master);
});
