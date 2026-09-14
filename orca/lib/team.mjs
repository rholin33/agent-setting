import fs from 'node:fs';
import path from 'node:path';
import { normalizeProject, projectKey, nodeCommand } from './platform.mjs';
import { binding, sameWorktree, validateTranscript } from './sessions.mjs';
import { inspectHealth, recoverInPane, provesSession } from './health.mjs';
import { rpc } from './orca.mjs';

export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export function saveJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temp, file);
}
export function projectFiles(home, project) {
  const directory = path.join(home, 'projects', projectKey(project));
  // Legacy PowerShell keeps a zero-byte start.lock after releasing its OS lock.
  return { directory, config: path.join(directory, 'config.json'), state: path.join(directory, 'state.json'), lock: path.join(directory, 'start.node.lock') };
}
export function withLock(file, action) {
  let fd;
  try { fd = fs.openSync(file, 'wx'); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Project is locked: ${file}. Check the owning process before removing a stale lock.`);
    throw error;
  }
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  return Promise.resolve().then(action).finally(() => { fs.closeSync(fd); fs.unlinkSync(file); });
}
export function initialize(home, project) {
  const files = projectFiles(home, project);
  fs.mkdirSync(files.directory, { recursive: true });
  return withLock(files.lock, () => {
    if (fs.existsSync(files.config)) {
      if (!fs.existsSync(files.state)) throw new Error('Project config exists without state; manual recovery required');
      const override = path.join(project, '.orca', 'team.json');
      if (fs.existsSync(override)) {
        const config = readJson(override);
        validateConfig(config, readJson(path.join(home, 'team.json')));
        config.workspace = project;
        const previous = readJson(files.config);
        if (JSON.stringify(previous) !== JSON.stringify(config)) {
          fs.copyFileSync(files.config, `${files.config}.${Date.now()}.bak`);
          saveJson(files.config, config);
        }
      }
      return files;
    }
    const override = path.join(project, '.orca', 'team.json');
    const config = readJson(fs.existsSync(override) ? override : path.join(home, 'layout.json'));
    validateConfig(config, readJson(path.join(home, 'team.json')));
    config.workspace = project;
    if (!fs.existsSync(files.state)) saveJson(files.state, { workspace: project, agents: {} });
    saveJson(files.config, config);
    return files;
  });
}
export function visualTabs(node) {
  if (!node) return [];
  return node.type === 'group' ? node.tabs || [] : [...visualTabs(node.first), ...visualTabs(node.second)];
}
export function assertLayout(inventory, config, state) {
  const tabs = (inventory.visualLayouts || []).flatMap(layout => visualTabs(layout.root));
  for (const tab of config.tabs) {
    const first = state.agents[tab.agents[0]];
    const matches = tabs.filter(item => item.tabId === first?.tabId);
    if (matches.length !== 1) throw new Error(`Tab ${tab.title} is not visible`);
    const pane = matches[0].panes;
    if (tab.agents.length === 1 && pane?.leafId !== first.leafId) throw new Error(`Unexpected pane in ${tab.title}`);
    if (tab.agents.length === 2) {
      const second = state.agents[tab.agents[1]];
      const leaves = [pane?.first?.leafId, pane?.second?.leafId];
      if (pane?.type !== 'pane-split' || pane.direction !== 'vertical' || second.tabId !== first.tabId || !leaves.includes(first.leafId) || !leaves.includes(second.leafId)) throw new Error(`Tab ${tab.title} is missing visible left/right panes. Use Orca View > Reload, then retry.`);
    }
  }
}
export function validateConfig(config, catalog) {
  if (!Array.isArray(catalog) || !catalog.length) throw new Error('Missing role catalog');
  const catalogNames = new Set();
  for (const role of catalog) {
    if (!/^[a-z][a-z0-9_]*$/.test(role.name) || catalogNames.has(role.name) ||
        !['pi', 'codex'].includes(role.agent) || typeof role.model !== 'string' || !role.model.trim()) throw new Error('Invalid role catalog');
    catalogNames.add(role.name);
  }
  const names = new Set();
  if (!Array.isArray(config.tabs) || !config.tabs.length) throw new Error('Missing tabs');
  for (const tab of config.tabs) {
    if (typeof tab.title !== 'string' || !tab.title.trim()) throw new Error('Tab title is required');
    if (!Array.isArray(tab.agents) || ![1, 2].includes(tab.agents.length)) throw new Error('Each tab requires one or two agents');
    if (tab.agents.length === 2 && (tab.direction !== 'vertical' || tab.ratio !== 0.5)) throw new Error('Only equal left/right splits are supported');
    for (const name of tab.agents) {
      if (!catalog.some(role => role.name === name) || names.has(name)) throw new Error(`Unknown or duplicate role: ${name}`);
      names.add(name);
    }
  }
  return [...names];
}
export async function runTeam({ home, project, action, cli, snapshot, inspect = (handle, provider) => inspectHealth(cli, rpc, handle, provider), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = console.log }) {
  project = normalizeProject(project);
  const files = projectFiles(home, project);
  if (action === 'start') await initialize(home, project);
  if (!fs.existsSync(files.config)) throw new Error('Project is not initialized');
  const execute = async () => {
    const config = readJson(files.config), state = readJson(files.state), catalog = readJson(path.join(home, 'team.json'));
    if (config.workspace !== project || state.workspace !== project) throw new Error('Project state path mismatch');
    const names = validateConfig(config, catalog);
    const list = () => cli(['terminal', 'list', '--worktree', `path:${project}`, '--include-visual-layouts']);
    let inventory;
    try { inventory = await list(); } catch (error) {
      if (error.code !== 'selector_not_found' || error.selector !== `path:${project}` || action !== 'start') throw error;
      await cli(['repo', 'add', '--path', project]); inventory = await list();
    }
    const resolved = {}, resume = {}, health = {}, issues = [];
    const snap = await snapshot();
    for (const name of names) {
      const saved = state.agents[name];
      if (!saved) continue;
      if (saved.pending) {
        const candidates = inventory.terminals.filter(row => row.tabId === saved.tabId && row.leafId === saved.leafId && row.connected && !row.orphaned && sameWorktree(`local::${row.worktreePath}`, project));
        if (candidates.length !== 1 || !provesSession(await inspect(candidates[0].handle, saved.agent), saved)) throw new Error(`Role ${name} has an interrupted launch; inspect Orca before retrying`);
        validateTranscript(saved, project);
        if (action === 'start') { delete saved.pending; saveJson(files.state, state); }
      }
      const foundBinding = binding(snap, saved, project);
      if (foundBinding) saved.session = foundBinding;
      const matches = inventory.terminals.filter(row => sameWorktree(`local::${row.worktreePath}`, project) && row.tabId === saved.tabId && row.leafId === saved.leafId);
      if (!matches.length) {
        if (action === 'status') { log(`${name}: missing`); continue; }
        const close = snap.terminalSurfaceTombstonesByPaneKey?.[`${saved.tabId}:${saved.leafId}`];
        if (!close || !sameWorktree(close.worktreeId, project)) throw new Error(`No confirmed close record for ${name}; no duplicate launched`);
        validateTranscript(saved, project); resume[name] = true;
      } else {
        if (matches.length !== 1 || !matches[0].connected || matches[0].orphaned) throw new Error(`Cannot verify running role ${name}`);
        resolved[name] = matches[0];
        health[name] = await inspect(matches[0].handle, saved.agent);
      }
    }
    if (action === 'start') saveJson(files.state, state);
    for (const tab of config.tabs) for (const name of tab.agents) {
      if (resolved[name]) {
        const status = health[name];
        if (status.kind === 'agent') { log(`${name}: agent running`); continue; }
        if (action === 'status') { log(`${name}: ${status.kind} (${status.reason || 'agent not running'})`); continue; }
        if (status.kind !== 'shell') { issues.push(`${name}: process unverifiable (${status.reason})`); continue; }
        const saved = state.agents[name];
        try { validateTranscript(saved, project); }
        catch (error) { issues.push(`${name}: ${error.message}`); continue; }
        const command = nodeCommand([path.join(home, 'bin', 'orca-team.mjs'), 'launch', '--home', home, '--project', project, '--role', name, '--resume']);
        await recoverInPane({ name, saved, handle: resolved[name].handle, command, cli, inspect,
          checkpoint: () => saveJson(files.state, state), verifyBinding: async () => {
            for (let attempt = 0; attempt < 30; attempt++) {
              const found = binding(await snapshot(), saved, project);
              const live = await inspect(resolved[name].handle, saved.agent);
              if ((found?.id === saved.session.id && live.kind === 'agent') || provesSession(live, saved)) return;
              await sleep(500);
            }
            throw new Error(`${name}: original conversation recovery is unconfirmed; pending retained`);
          } });
        log(`${name}: original conversation restored in existing pane`);
        continue;
      }
      if (action === 'status') { log(`${name}: not running`); continue; }
      const role = catalog.find(row => row.name === name);
      const saved = state.agents[name] ||= {};
      saved.pending = true; saveJson(files.state, state);
      const command = nodeCommand([path.join(home, 'bin', 'orca-team.mjs'), 'launch', '--home', home, '--project', project, '--role', name, ...(resume[name] ? ['--resume'] : [])]);
      const sibling = tab.agents.find(other => other !== name && resolved[other]);
      let created, handle;
      if (!sibling) {
        created = await cli(['terminal', 'create', '--worktree', `path:${project}`, '--title', tab.title, '--command', command]); handle = created.terminal.handle;
      } else {
        const primary = resolved[sibling];
        await cli(['terminal', 'switch', '--terminal', primary.handle]);
        let mounted = false;
        for (let attempt = 0; attempt < 20; attempt++) {
          const check = await list();
          const visible = (check.visualLayouts || []).flatMap(item => visualTabs(item.root)).filter(item => item.tabId === primary.tabId);
          if (visible.length === 1 && visible[0].panes?.leafId === primary.leafId) { mounted = true; break; }
          await sleep(250);
        }
        if (!mounted) throw new Error('Primary pane is not visible; split was not started');
        created = await cli(['terminal', 'split', '--terminal', primary.handle, '--direction', 'vertical', '--command', command]); handle = created.split.handle;
      }
      const row = (await cli(['terminal', 'show', '--terminal', handle])).terminal;
      if (!sameWorktree(`local::${row.worktreePath}`, project)) throw new Error('Created terminal belongs to a different project');
      Object.assign(saved, { tabId: row.tabId, leafId: row.leafId });
      if (!resume[name]) Object.assign(saved, { model: role.model, agent: role.agent, thinking: role.thinking });
      delete saved.pending; saveJson(files.state, state); resolved[name] = row;
      let found;
      for (let attempt = 0; attempt < 20; attempt++) {
        found = binding(await snapshot(), saved, project);
        if (found) {
          if (resume[name] && found.id !== saved.session.id) throw new Error(`Unexpected conversation after resuming ${name}`);
          saved.session = found; saveJson(files.state, state); break;
        }
        await sleep(500);
      }
      log(`${name}: ${resume[name] ? 'resume launched' : 'created'}${found ? '' : '; conversation unconfirmed, rerun before closing'}`);
    }
    if (action === 'start') {
      assertLayout(await list(), config, state); saveJson(files.state, state);
      if (issues.length) throw new Error(issues.join('\n'));
      log('Verified configured desktop layout; new launches report conversation readiness separately');
    }
    return state;
  };
  return action === 'start' ? withLock(files.lock, execute) : execute();
}
