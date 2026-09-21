import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { dataDirectory, normalizeProject, projectKey, nodeCommand } from '../lib/platform.mjs';
import { validateTranscript, launchArguments, binding } from '../lib/sessions.mjs';
import { initialize, runTeam, readJson, saveJson, projectFiles, withLock } from '../lib/team.mjs';
import { deploy, installQuickCommands, registerShellProfile } from '../lib/install.mjs';

const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-team-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const home = path.join(temp, 'team'), project = path.join(temp, 'project');
  fs.mkdirSync(project); fs.mkdirSync(home);
  for (const file of ['team.json', 'layout.json']) fs.copyFileSync(path.join(source, file), path.join(home, file));
  return { temp, home, project: normalizeProject(project) };
}
test('all original 199 resources retain their byte hashes', () => {
  const inventory = readJson(path.join(source, 'FILE-INVENTORY.json'));
  assert.equal(inventory.count, 199);
  for (const entry of inventory.files) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(source, entry.path))).digest('hex'), entry.sha256, entry.path);
});
test('Windows/macOS/Linux storage, quoting, project keys', () => {
  assert.equal(dataDirectory('win32', { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }), 'C:\\Users\\x\\AppData\\Roaming\\orca');
  assert.equal(dataDirectory('darwin', {}, '/Users/x'), '/Users/x/Library/Application Support/orca');
  assert.equal(dataDirectory('linux', { XDG_CONFIG_HOME: '/config' }, '/home/x'), '/config/orca');
  assert.equal(projectKey('D:/Code/Test', 'win32'), projectKey('d:/code/test', 'win32'));
  assert.notEqual(projectKey('/code/Test', 'linux'), projectKey('/code/test', 'linux'));
  assert.notEqual(projectKey('/code/Test', 'darwin'), projectKey('/code/test', 'darwin'));
  assert.match(nodeCommand(['a b', "x'y", '$(secret)'], 'linux', '/usr/bin/node'), /'x'\\''y'/);
  const command = nodeCommand(['a b', "x'y", '$(secret)'], 'win32', 'C:\\node.exe');
  assert.equal(Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le'), "& 'C:\\node.exe' 'a b' 'x''y' '$(secret)'");
});
test('init retains per-project overrides and refuses concurrent locks', async t => {
  const { home, project } = fixture(t);
  fs.mkdirSync(path.join(project, '.orca'));
  saveJson(path.join(project, '.orca', 'team.json'), { tabs: [{ title: 'custom', agents: ['simple'] }] });
  const files = await initialize(home, project);
  assert.equal(readJson(files.config).tabs[0].title, 'custom');
  const priorState = fs.readFileSync(files.state, 'utf8');
  saveJson(path.join(project, '.orca', 'team.json'), { tabs: [{ title: 'synced', agents: ['simple'] }] });
  await initialize(home, project);
  assert.equal(readJson(files.config).tabs[0].title, 'synced');
  assert.equal(fs.readFileSync(files.state, 'utf8'), priorState);
  assert.ok(fs.readdirSync(files.directory).some(name => name.endsWith('.bak')));
  fs.writeFileSync(path.join(files.directory, 'start.lock'), '');
  await initialize(home, project);
  assert.equal(fs.existsSync(path.join(files.directory, 'start.lock')), true);
  await withLock(files.lock, async () => assert.throws(() => withLock(files.lock, () => {}), /locked/));
  assert.equal(fs.existsSync(files.lock), false);
});
test('fresh launch creates six tabs/nine roles and rerun has no mutations', async t => {
  const { home, project } = fixture(t);
  const terminals = [], tabs = []; let creations = 0;
  const cli = async args => {
    const [noun, verb] = args;
    const val = flag => args[args.indexOf(flag) + 1];
    if (verb === 'list') return { terminals, visualLayouts: [{ root: { type: 'group', tabs } }] };
    if (verb === 'switch') return {};
    if (verb === 'create' || verb === 'split') {
      creations++;
      const pendingState = readJson(projectFiles(home, project).state);
      const launching = Object.values(pendingState.agents).find(a => a.pending && !a.tabId);
      const transcriptPath = launching.launchIntent.transcriptPath || path.join(home, `codex-${creations}.jsonl`);
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, JSON.stringify(launching.agent === 'pi' ? { type: 'session', id: `s${creations}`, cwd: project } : { type: 'session_meta', payload: { id: `s${creations}`, cwd: project } }) + '\n');
      launching.session = { id: `s${creations}`, transcriptPath };
      const primary = verb === 'split' ? terminals.find(row => row.handle === val('--terminal')) : null;
      const row = { handle: `term_${creations}`, tabId: primary?.tabId || `tab_${creations}`, leafId: `leaf_${creations}`, worktreePath: project, connected: true, orphaned: false };
      terminals.push(row);
      Object.assign(launching, { tabId: row.tabId, leafId: row.leafId });
      bindings[`${row.tabId}:${row.leafId}`] = { agent: launching.agent, worktreeId: `repo::${project}`, providerSession: launching.session };
      const leaf = { type: 'pane-leaf', leafId: row.leafId };
      if (primary) {
        assert.equal(val('--direction'), 'vertical');
        const tab = tabs.find(item => item.tabId === primary.tabId);
        tab.panes = { type: 'pane-split', direction: 'vertical', first: tab.panes, second: leaf };
      } else tabs.push({ tabId: row.tabId, panes: leaf });
      return verb === 'create' ? { terminal: row } : { split: row };
    }
    if (verb === 'show') return { terminal: terminals.find(row => row.handle === val('--terminal')) };
    throw new Error(`Unexpected ${noun} ${verb}`);
  };
  const bindings = {};
  const pinned = [];
  const options = { home, project, action: 'start', cli, pin: async ({ config }) => pinned.push(config.tabs.map(tab => tab.title)), inspect: async () => ({ kind: 'agent' }), snapshot: () => ({ sleepingAgentSessionsByPaneKey: bindings }), sleep: async () => {}, log: () => {} };
  await runTeam({ ...options, group: 'master' });
  assert.equal(creations, 2); assert.equal(tabs.length, 1);
  assert.deepEqual(pinned, [['master']]);
  await runTeam({ ...options, group: 'master' }); assert.equal(creations, 2);
  await assert.rejects(runTeam({ ...options, group: 'missing' }), /Unknown group/);
  const stateFile = projectFiles(home, project).state;
  const withUnrelatedPending = readJson(stateFile);
  withUnrelatedPending.agents.archi = { pending: true };
  saveJson(stateFile, withUnrelatedPending);
  await runTeam({ ...options, group: 'master' }); assert.equal(creations, 2);
  delete withUnrelatedPending.agents.archi;
  saveJson(stateFile, withUnrelatedPending);
  await runTeam(options); assert.equal(creations, 9); assert.equal(tabs.length, 6);
  assert.deepEqual(pinned.at(-1), ['master', 'archi', 'coder', 'designer', 'reviewer', 'simple']);
  await runTeam(options); assert.equal(creations, 9);
  const stateBeforeStatus = fs.readFileSync(stateFile, 'utf8');
  const pinCount = pinned.length;
  await runTeam({ ...options, action: 'status', group: 'master' });
  assert.equal(fs.readFileSync(stateFile, 'utf8'), stateBeforeStatus);
  assert.equal(pinned.length, pinCount);
  const configFile = projectFiles(home, project).config;
  saveJson(configFile, { ...readJson(configFile), pinTabs: false });
  await runTeam(options);
  assert.equal(pinned.length, pinCount);
  saveJson(configFile, { ...readJson(configFile), pinTabs: true });
  const warnings = [];
  await runTeam({ ...options, log: line => warnings.push(line), pin: async () => { throw new Error('pin not applied'); } });
  assert.ok(warnings.some(line => /Warning:.*pin not applied/.test(line)));
  assert.equal(creations, 9);
  terminals.pop();
  await assert.rejects(runTeam(options), /No confirmed close record/);
  assert.equal(creations, 9);
});
test('exact resume checks ID, project, file and original Codex home', t => {
  const { temp, project } = fixture(t);
  const directory = path.join(temp, 'codex', 'sessions', '2026'); fs.mkdirSync(directory, { recursive: true });
  const transcriptPath = path.join(directory, 'session.jsonl');
  fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'session_meta', payload: { id: 'original', cwd: project } }) + '\n');
  const role = { agent: 'codex', model: 'model', thinking: 'medium', session: { id: 'original', transcriptPath } };
  validateTranscript(role, project);
  const launch = launchArguments(role, 'unused', role.session, project);
  assert.deepEqual(launch.args.slice(0, 2), ['resume', 'original']);
  assert.equal(launch.env.CODEX_HOME, path.join(temp, 'codex'));
  assert.throws(() => validateTranscript({ ...role, session: { ...role.session, id: 'wrong' } }, project), /mismatch/);
  assert.throws(() => validateTranscript(role, project + '-other'), /mismatch/);
  assert.throws(() => validateTranscript({ ...role, session: null }, project), /unavailable/);
});
test('installation retains runtime state and quick commands preserve unrelated entries', async t => {
  const { home, project } = fixture(t);
  const files = await initialize(home, project);
  const before = fs.readFileSync(files.state, 'utf8');
  deploy(source, home);
  assert.equal(fs.readFileSync(files.state, 'utf8'), before);
  assert.ok(fs.existsSync(path.join(home, 'bin', 'orca-team.ps1')));
  assert.ok(fs.existsSync(path.join(home, 'bin', 'orca-team')));
  assert.ok(fs.readFileSync(path.join(home, 'bin', 'orca-team'), 'utf8').includes('--home'));
  assert.ok(fs.readFileSync(path.join(home, 'bin', 'orca-team.ps1'), 'utf8').includes('--home'));
  const commands = [{ id: 'user-command', command: 'hello' }, ...['master', 'loader', 'archi', 'coder1', 'coder2', 'designer', 'reviewer', 'test', 'simple'].map(name => ({ id: `ccb-team-${name}`, command: 'old' }))];
  const rpc = async (method, params) => {
    if (method === 'settings.getTerminalQuickCommands') return { terminalQuickCommands: commands };
    if (params.mutation.type === 'delete') {
      const index = commands.findIndex(row => row.id === params.mutation.id);
      if (index !== -1) commands.splice(index, 1);
      return;
    }
    const index = commands.findIndex(row => row.id === params.mutation.command.id);
    if (index === -1) commands.push(params.mutation.command); else commands[index] = params.mutation.command;
  };
  await installQuickCommands(home, rpc); await installQuickCommands(home, rpc);
  assert.equal(commands.length, 7); assert.equal(commands[0].command, 'hello');
  assert.deepEqual(commands.slice(1).map(row => row.label).sort(), ['CCB / master + loader', 'CCB / archi', 'CCB / coder1 + coder2', 'CCB / designer', 'CCB / reviewer + test', 'CCB / simple'].sort());
  for (const row of commands.slice(1)) {
    const text = process.platform === 'win32' ? Buffer.from(row.command.split(' ').at(-1), 'base64').toString('utf16le') : row.command;
    assert.match(text, /'start'.*'--group'/);
    assert.doesNotMatch(text, /'launch'/);
  }
});
for (const tombstones of [true, false]) for (const missing of [['master'], ['loader'], ['master', 'loader']]) {
  test(`${tombstones ? 'confirmed closure' : 'verified absence'} restores ${missing.join(' and ')} without replacing sibling`, async t => {
    const { home, project, temp } = fixture(t);
    const files = await initialize(home, project);
    const config = { workspace: project, tabs: [{ title: 'master', agents: ['master', 'loader'], direction: 'vertical', ratio: 0.5 }] };
    saveJson(files.config, config);
    const state = { workspace: project, agents: {} }, snap = { terminalSurfaceTombstonesByPaneKey: {}, sleepingAgentSessionsByPaneKey: {} };
    const terminals = [], tabs = []; let count = 0;
    for (const name of ['master', 'loader']) {
      const transcriptPath = path.join(temp, `${name}.jsonl`);
      fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'session', id: name, cwd: project }) + '\n');
      state.agents[name] = { tabId: 'old-tab', leafId: name, agent: 'pi', model: 'model', session: { id: name, transcriptPath } };
      if (missing.includes(name)) {
        if (tombstones) snap.terminalSurfaceTombstonesByPaneKey[`old-tab:${name}`] = { worktreeId: `repo::${project}` };
      }
      else {
        terminals.push({ tabId: 'old-tab', leafId: name, handle: name, worktreePath: project, connected: true });
        tabs.push({ tabId: 'old-tab', panes: { type: 'pane-leaf', leafId: name } });
      }
    }
    saveJson(files.state, state);
    const cli = async args => {
      const val = flag => args[args.indexOf(flag) + 1], verb = args[1];
      if (verb === 'list') return { terminals, visualLayouts: [{ root: { type: 'group', tabs } }] };
      if (verb === 'switch') return {};
      if (verb === 'show') return { terminal: terminals.find(row => row.handle === val('--terminal')) };
      if (verb === 'create' || verb === 'split') {
        count++;
        const command = val('--command');
        const decoded = process.platform === 'win32' ? Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le') : command;
        assert.ok(decoded.includes('--resume'));
        const primary = terminals.find(row => row.handle === val('--terminal'));
        const row = { handle: `new-${count}`, tabId: primary?.tabId || 'new-tab', leafId: `new-${count}`, worktreePath: project, connected: true };
        terminals.push(row);
        const roleName = missing[count - 1];
        snap.sleepingAgentSessionsByPaneKey[`${row.tabId}:${row.leafId}`] = { agent: 'pi', worktreeId: `repo::${project}`, providerSession: state.agents[roleName].session };
        if (primary) {
          const tab = tabs.find(item => item.tabId === primary.tabId);
          tab.panes = { type: 'pane-split', direction: 'vertical', first: tab.panes, second: { type: 'pane-leaf', leafId: row.leafId } };
        } else tabs.push({ tabId: row.tabId, panes: { type: 'pane-leaf', leafId: row.leafId } });
        return verb === 'create' ? { terminal: row } : { split: row };
      }
      throw new Error(`Unexpected ${verb}`);
    };
    let checked = 0;
    const options = { home, project, action: 'start', cli, pin: async () => {}, inspect: async () => ({ kind: 'agent' }), snapshot: () => snap, sleep: async () => {}, log: () => {} };
    if (!tombstones) {
      await assert.rejects(runTeam({ ...options, verifyAbsent: async () => { throw new Error('process still running'); } }), /process still running/);
      assert.equal(count, 0);
    }
    const result = await runTeam({ ...options, verifyAbsent: async ({ missing: roles }) => {
      checked++;
      assert.deepEqual(roles.map(role => role.name), missing);
      return true;
    } });
    assert.equal(checked, tombstones ? 0 : 1);
    assert.equal(count, missing.length);
    for (const name of ['master', 'loader']) assert.equal(result.agents[name].session.id, name);
    for (const name of ['master', 'loader'].filter(name => !missing.includes(name))) assert.equal(result.agents[name].leafId, name);
  });
}
test('pending launch and changed provider identity stop without creating terminals', async t => {
  const { home, project } = fixture(t);
  const files = await initialize(home, project);
  saveJson(files.state, { workspace: project, agents: { master: { pending: true } } });
  const calls = [];
  await assert.rejects(runTeam({ home, project, action: 'start', cli: async args => { calls.push(args[1]); return { terminals: [] }; }, snapshot: () => ({}) }), /interrupted launch/);
  assert.deepEqual(calls, ['list']);
  assert.throws(() => binding({ sleepingAgentSessionsByPaneKey: { 'tab:leaf': { agent: 'pi', worktreeId: `repo::${project}`, providerSession: { id: 'changed' } } } }, { tabId: 'tab', leafId: 'leaf', agent: 'pi', session: { id: 'original' } }, project), /identity changed/);
});
test('explicit profile registration is idempotent and preserves unrelated content', t => {
  const { home, temp } = fixture(t);
  for (const platform of ['win32', 'darwin', 'linux']) {
    const profile = path.join(temp, `profile-${platform}`);
    fs.writeFileSync(profile, '# user settings\n');
    registerShellProfile(home, profile, platform);
    const first = fs.readFileSync(profile, 'utf8');
    registerShellProfile(home, profile, platform);
    assert.equal(fs.readFileSync(profile, 'utf8'), first);
    assert.ok(first.startsWith('# user settings\n'));
    assert.equal(first.split('# >>> orca-team >>>').length, 2);
  }
});

test('PowerShell profiles on macOS and Linux receive PowerShell syntax', t => {
  const { home, temp } = fixture(t);
  for (const platform of ['darwin', 'linux']) {
    const profile = path.join(temp, `${platform}.ps1`);
    registerShellProfile(home, profile, platform);
    const content = fs.readFileSync(profile, 'utf8');
    assert.match(content, /orca-team\.ps1/);
    assert.ok(!content.includes('export PATH'));
  }
});

test('unconfirmed new pane retains pending and retry never duplicates its launch', async t => {
  const { home, project } = fixture(t);
  const files = await initialize(home, project);
  saveJson(files.config, { workspace: project, tabs: [{ title: 'archi', agents: ['archi'] }] });
  let created = 0;
  const terminals = [], tabs = [];
  const cli = async args => {
    if (args[1] === 'list') return { terminals, visualLayouts: [{ root: { type: 'group', tabs } }] };
    if (args[1] === 'create') {
      created++;
      const saved = readJson(files.state).agents.archi;
      assert.equal(saved.pending, true);
      assert.ok(saved.launchIntent.transcriptPath);
      const terminal = { handle: 'h', tabId: 't', leafId: 'l', worktreePath: project, connected: true };
      terminals.push(terminal); tabs.push({ tabId: 't', panes: { leafId: 'l' } });
      return { terminal };
    }
    if (args[1] === 'show') return { terminal: terminals[0] };
    assert.fail('unexpected mutation');
  };
  const options = { home, project, action: 'start', cli, pin: async () => {}, inspect: async () => ({ kind: 'agent' }), snapshot: () => ({}), sleep: async () => {}, log: () => {} };
  await assert.rejects(runTeam(options), /launch unconfirmed/);
  const saved = readJson(files.state).agents.archi;
  assert.equal(saved.pending, true);
  await assert.rejects(runTeam(options), /interrupted launch/);
  assert.equal(created, 1);
  fs.mkdirSync(path.dirname(saved.launchIntent.transcriptPath), { recursive: true });
  fs.writeFileSync(saved.launchIntent.transcriptPath, JSON.stringify({ type: 'session', id: 'recovered', cwd: project }) + '\n');
  options.inspect = async () => ({ kind: 'agent', sessionPaths: [saved.launchIntent.transcriptPath] });
  await runTeam(options);
  const after = readJson(files.state).agents.archi;
  assert.equal(after.pending, undefined);
  assert.equal(after.session.id, 'recovered');
  assert.equal(created, 1);
});
