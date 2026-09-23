import { verifyMacAbsence } from './macos-health.mjs';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeProject, projectKey, nodeCommand } from './platform.mjs';
import { binding, sameWorktree, validateTranscript } from './sessions.mjs';
import { inspectHealth, recoverInPane } from './health.mjs';
import { rpc } from './orca.mjs';
import { prepareLaunch, captureSession } from './launch-state.mjs';
import { pinGroupTabs } from './tabs.mjs';
import { verifyWindowsAbsence } from './windows-health.mjs';

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
  const titles = new Set();
  if (config.pinTabs !== undefined && typeof config.pinTabs !== 'boolean') throw new Error('pinTabs must be a boolean');
  if (!Array.isArray(config.tabs) || !config.tabs.length) throw new Error('Missing tabs');
  for (const tab of config.tabs) {
    if (typeof tab.title !== 'string' || !tab.title.trim()) throw new Error('Tab title is required');
    if (titles.has(tab.title)) throw new Error(`Duplicate group title: ${tab.title}`);
    titles.add(tab.title);
    if (!Array.isArray(tab.agents) || ![1, 2].includes(tab.agents.length)) throw new Error('Each tab requires one or two agents');
    if (tab.agents.length === 2 && (tab.direction !== 'vertical' || tab.ratio !== 0.5)) throw new Error('Only equal left/right splits are supported');
    for (const name of tab.agents) {
      if (!catalog.some(role => role.name === name) || names.has(name)) throw new Error(`Unknown or duplicate role: ${name}`);
      names.add(name);
    }
  }
  return [...names];
}
export async function focusDesktop(handle) {
  // macOS can defer renderer work while the app is hidden/backgrounded.
  if (process.platform === 'darwin') execFileSync('/usr/bin/open', ['-a', 'Orca']);
  return rpc('terminal.focus', { terminal: handle, navigation: 'host' });
}
export async function runTeam({ home, project, action, group, cli, snapshot, pin = pinGroupTabs, focus = focusDesktop, verifyAbsent = process.platform === 'darwin' ? verifyMacAbsence : verifyWindowsAbsence, inspect = (handle, provider) => inspectHealth(cli, rpc, handle, provider), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = console.log }) {
  project = normalizeProject(project);
  const files = projectFiles(home, project);
  if (action === 'start') await initialize(home, project);
  if (!fs.existsSync(files.config)) throw new Error('Project is not initialized');
  const execute = async () => {
    let config = readJson(files.config);
    const state = readJson(files.state), catalog = readJson(path.join(home, 'team.json'));
    if (config.workspace !== project || state.workspace !== project) throw new Error('Project state path mismatch');
    validateConfig(config, catalog);
    if (group !== undefined) {
      const tabs = config.tabs.filter(tab => tab.title === group);
      if (tabs.length !== 1) throw new Error(`Unknown group: ${group}`);
      config = { ...config, tabs };
    }
    const names = validateConfig(config, catalog);
    const list = () => cli(['terminal', 'list', '--worktree', `path:${project}`, '--include-visual-layouts']);
    let inventory;
    try { inventory = await list(); } catch (error) {
      if (error.code !== 'selector_not_found' || error.selector !== `path:${project}` || action !== 'start') throw error;
      await cli(['repo', 'add', '--path', project]); inventory = await list();
    }
    const resolved = {}, resume = {}, health = {}, issues = [], missing = [];
    const snap = await snapshot();
    for (const name of names) {
      const saved = state.agents[name];
      if (!saved) continue;
      if (saved.pending) {
        if (!saved.leafId && (saved.launchIntent?.transcriptPath || saved.creationIntent)) {
          const candidates = inventory.terminals.filter(row => {
            if (!row.connected || row.orphaned || !sameWorktree(`local::${row.worktreePath}`, project)) return false;
            const record = snap.sleepingAgentSessionsByPaneKey?.[`${row.tabId}:${row.leafId}`];
            if (record?.agent !== saved.agent) return false;
            const found = binding(snap, { ...saved, tabId: row.tabId, leafId: row.leafId }, project);
            return found && (saved.launchIntent?.transcriptPath ? found.transcriptPath === saved.launchIntent.transcriptPath : row.tabId === saved.creationIntent.tabId && !saved.creationIntent.leafIds.includes(row.leafId));
          });
          if (candidates.length === 1) Object.assign(saved, { tabId: candidates[0].tabId, leafId: candidates[0].leafId });
        }
        const candidates = inventory.terminals.filter(row => row.tabId === saved.tabId && row.leafId === saved.leafId && row.connected && !row.orphaned && sameWorktree(`local::${row.worktreePath}`, project));
        const live = candidates.length === 1 ? await inspect(candidates[0].handle, saved.agent) : null;
        if (!live || !captureSession(saved, live, project, binding(snap, saved, project))) throw new Error(`Role ${name} has an interrupted launch; inspect Orca before retrying`);
        validateTranscript(saved, project);
        if (action === 'start') { delete saved.pending; delete saved.restartIntent; saveJson(files.state, state); }
      }
      const foundBinding = binding(snap, saved, project);
      if (foundBinding) saved.session = foundBinding;
      const matches = inventory.terminals.filter(row => sameWorktree(`local::${row.worktreePath}`, project) && row.tabId === saved.tabId && row.leafId === saved.leafId);
      if (!matches.length) {
        if (action === 'status') { log(`${name}: missing`); continue; }
        const close = snap.terminalSurfaceTombstonesByPaneKey?.[`${saved.tabId}:${saved.leafId}`];
        validateTranscript(saved, project);
        if (!close || !sameWorktree(close.worktreeId, project)) missing.push({ name, saved });
        resume[name] = true;
      } else {
        if (matches.length !== 1 || !matches[0].connected || matches[0].orphaned) throw new Error(`Cannot verify running role ${name}`);
        resolved[name] = matches[0];
        health[name] = await inspect(matches[0].handle, saved.agent);
        if (health[name].kind === 'agent') captureSession(saved, health[name], project, foundBinding);
      }
    }
    if (missing.length) {
      try {
        if (await verifyAbsent({ project, missing, cli }) !== true) throw new Error('Absence was not verified');
      } catch (error) {
        throw new Error(`No confirmed close record for ${missing.map(role => role.name).join(', ')}; ${error.message}; no duplicate launched`);
      }
      log(`Verified original processes absent: ${missing.map(role => role.name).join(', ')}; resuming saved conversations`);
    }
    if (action === 'start') saveJson(files.state, state);
    for (const tab of config.tabs) for (const name of tab.agents) {
      if (resolved[name]) {
        const status = health[name];
        if (status.kind === 'agent') {
          if (state.agents[name].restartIntent) {
            issues.push(`${name}: previous exit unconfirmed; no duplicate input sent`);
            log(`${name}: restart incomplete; agent still running`); continue;
          }
          if (!state.agents[name].session) issues.push(`${name}: agent running but conversation binding unavailable`);
          log(`${name}: agent running${state.agents[name].session ? '; conversation bound' : '; conversation unbound'}`); continue;
        }
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
              if (captureSession(saved, live, project, found)) return;
              await sleep(500);
            }
            throw new Error(`${name}: original conversation recovery is unconfirmed; pending retained`);
          } });
        const restoredRole = catalog.find(item => item.name === name);
        if (restoredRole) saved.appliedModel = { agent: restoredRole.agent, model: restoredRole.model, thinking: restoredRole.thinking ?? null };
        log(`${name}: original conversation restored in existing pane`);
        delete saved.restartIntent; saveJson(files.state, state);
        continue;
      }
      if (action === 'status') { log(`${name}: not running`); continue; }
      const role = catalog.find(row => row.name === name);
      const saved = state.agents[name] ||= {};
      if (!resume[name]) prepareLaunch(saved, role, files.directory);
      saved.pending = true; saveJson(files.state, state);
      const command = nodeCommand([path.join(home, 'bin', 'orca-team.mjs'), 'launch', '--home', home, '--project', project, '--role', name, ...(resume[name] ? ['--resume'] : [])]);
      const sibling = tab.agents.find(other => other !== name && resolved[other]);
      let created, handle;
      if (!sibling) {
        created = await cli(['terminal', 'create', '--worktree', `path:${project}`, '--title', tab.title, '--command', command]); handle = created.terminal.handle;
      } else {
        const primary = resolved[sibling];
        await focus(primary.handle);
        await cli(['terminal', 'switch', '--terminal', primary.handle]);
        await sleep(1000);
        let mounted = false;
        for (let attempt = 0; attempt < 20; attempt++) {
          const check = await list();
          const visible = (check.visualLayouts || []).flatMap(item => visualTabs(item.root)).filter(item => item.tabId === primary.tabId);
          if (visible.length === 1 && visible[0].panes?.leafId === primary.leafId) { mounted = true; break; }
          await sleep(250);
        }
        if (!mounted) throw new Error('Primary pane is not visible; split was not started');
        const beforeSplit = await list();
        saved.creationIntent = { tabId: primary.tabId, leafIds: beforeSplit.terminals.filter(row => row.tabId === primary.tabId).map(row => row.leafId) };
        saveJson(files.state, state);
        try {
          created = await cli(['terminal', 'split', '--terminal', primary.handle, '--direction', 'vertical', '--command', command]); handle = created.split.handle;
        } catch (error) {
          // A timed-out mutation may already have succeeded. Never send it twice.
          if (!/Timed out waiting for split pane handle/.test(error.message)) throw error;
          for (let attempt = 0; attempt < 120; attempt++) {
            if (attempt % 10 === 0) await focus(primary.handle);
            const current = await list(), snap = await snapshot();
            const candidates = current.terminals.filter(row => {
              if (row.tabId !== primary.tabId || row.leafId === primary.leafId || !row.connected || row.orphaned) return false;
              const found = binding(snap, { ...saved, tabId: row.tabId, leafId: row.leafId }, project);
              return found && (saved.session ? found.id === saved.session.id : saved.launchIntent?.transcriptPath ? found.transcriptPath === saved.launchIntent.transcriptPath : !saved.creationIntent.leafIds.includes(row.leafId));
            });
            if (candidates.length === 1) { handle = candidates[0].handle; break; }
            await sleep(500);
          }
          if (!handle) throw error;
        }
      }
      const row = (await cli(['terminal', 'show', '--terminal', handle])).terminal;
      if (!sameWorktree(`local::${row.worktreePath}`, project)) throw new Error('Created terminal belongs to a different project');
      Object.assign(saved, { tabId: row.tabId, leafId: row.leafId });
      if (!resume[name]) Object.assign(saved, { model: role.model, agent: role.agent, thinking: role.thinking });
      saveJson(files.state, state); resolved[name] = row;
      let found;
      for (let attempt = 0; attempt < 60; attempt++) {
        found = binding(await snapshot(), saved, project);
        const live = await inspect(handle, saved.agent);
        if (captureSession(saved, live, project, found)) {
          found = saved.session;
          delete saved.pending;
          saved.appliedModel = { agent: role.agent, model: role.model, thinking: role.thinking ?? null };
          saveJson(files.state, state); break;
        }
        await sleep(500);
      }
      log(`${name}: ${resume[name] ? 'resume launched' : 'created'}${found ? '' : '; conversation unconfirmed, rerun before closing'}`);
      if (saved.pending) issues.push(`${name}: launch unconfirmed; pending retained, no automatic resend`);
    }
    if (action === 'start') {
      assertLayout(await list(), config, state); saveJson(files.state, state);
      if (issues.length) throw new Error(issues.join('\n'));
      if (group !== undefined) await cli(['terminal', 'switch', '--terminal', resolved[config.tabs[0].agents[0]].handle]);
      const pinTabs = config.pinTabs ?? readJson(path.join(home, 'layout.json')).pinTabs ?? false;
      if (pinTabs) {
        try { await pin({ project, config, state }); }
        catch (error) { log(`Warning: optional tab pinning failed: ${error.message}`); }
      }
      log('Verified configured desktop layout; new launches report conversation readiness separately');
    }
    return state;
  };
  return action === 'start' ? withLock(files.lock, execute) : execute();
}
