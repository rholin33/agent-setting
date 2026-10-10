#!/usr/bin/env node
import { supportsNoDaemon } from '../lib/codex-capabilities.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { normalizeProject, quote } from '../lib/platform.mjs';
import { orca, snapshot, rpc } from '../lib/orca.mjs';
import { initialize, runTeam, readJson, saveJson, projectFiles, withLock } from '../lib/team.mjs';
import { launchArguments } from '../lib/sessions.mjs';
import { restartTeam } from '../lib/restart.mjs';
import { inspectHealth } from '../lib/health.mjs';
import { ensureOrca } from '../lib/orca-boot.mjs';
import { syncModels } from '../lib/model-sync.mjs';
import { updateAgentsBeforeStart } from '../lib/agent-update.mjs';
import { updateLifecycle } from '../lib/update-lifecycle.mjs';
import { reloadRunning } from '../lib/reload.mjs';
import { taskHistory } from '../lib/history.mjs';
import { deploy, installQuickCommands, registerShellProfile } from '../lib/install.mjs';

const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const startedAt = Date.now();
async function stage(label, action) {
  const before = Date.now();
  try { return await action(); }
  finally { console.log(`${label}: ${((Date.now() - before) / 1000).toFixed(1)}s`); }
}
async function updatePrehook(home, names) {
  const catalog = readJson(path.join(home, 'team.json'));
  const agents = catalog.filter(role => !names || names.includes(role.name)).map(role => role.agent);
  try {
    return await withLock(path.join(home, 'agent-update.lock'), () => updateAgentsBeforeStart({ agents,
      lifecycle: updateLifecycle({ home, cli: orca, snapshot }) }));
  } catch (error) {
    if (/session recovery|partial shutdown recovery/.test(error.message)) throw error;
    console.log(`Warning: update prehook skipped: ${error.message}; continuing startup`);
  }
}
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { home: { type: 'string' }, project: { type: 'string' }, role: { type: 'string' }, group: { type: 'string' }, fresh: { type: 'string', multiple: true }, cached: { type: 'boolean' }, resume: { type: 'boolean' }, 'quick-commands': { type: 'boolean' }, 'shell-profile': { type: 'string' }, 'no-pick': { type: 'boolean' }, help: { type: 'boolean' } } });
  const action = positionals[0] || 'start';
  const roleName = values.role || positionals[1];
  if (action !== 'restart' && positionals.length > (action === 'history' ? 2 : 1)) throw new Error('Unexpected positional arguments');
  if (values.role && positionals[1] && action !== 'restart' && values.role !== positionals[1]) throw new Error('Conflicting role arguments');
  if (values.group !== undefined && !['start', 'status'].includes(action)) throw new Error('--group is only supported for start/status');
  if (values.fresh?.length && action !== 'start') throw new Error('--fresh is only supported for start');
  if (values.help) {
    console.log('orca-team [status|history [ROLE]|init|install|export-config] [--group TITLE] [--project PATH] [--home PATH] [--fresh ROLE] [--no-pick]\nDefault: bring the selected project to the configured state. Create missing roles, resume original conversations in idle panes, and reuse matching running roles and reload only changed agent/model/thinking configurations while keeping their conversations. Busy or unverifiable roles are reported as incomplete.\nstart is an alias for the default command; restart [ROLE|GROUP ...] restarts a subset on demand.\n--fresh ROLE (repeatable) drops one stopped role\'s saved pane/session binding and starts that role in a new pane; it refuses while the role is running.\n--no-pick skips the Pi model picker. install --quick-commands registers Orca grouped global shortcuts.');
  } else {
    const home = path.resolve(values.home || process.env.ORCA_TEAM_HOME || path.join(os.homedir(), '.orca', 'roles', 'ccb-team'));
    const project = normalizeProject(fs.realpathSync(values.project || process.cwd()));
    if (action === 'install') {
      const entries = deploy(source, home);
      if (values['shell-profile']) registerShellProfile(home, path.resolve(values['shell-profile']));
      if (values['quick-commands']) console.log(`Registered ${await installQuickCommands(home, rpc)} quick commands`);
      console.log(JSON.stringify(entries, null, 2));
      console.log('PowerShell: dot-source powershell entry from your profile. macOS/Linux: add shellDirectory to PATH. Existing shell profiles are not rewritten.');
    } else if (action === 'export-config') {
      const candidates = [projectFiles(home, project).config, path.join(project, '.orca', 'team.json'), path.join(home, 'layout.json')];
      const file = candidates.find(candidate => fs.existsSync(candidate));
      if (!file) throw new Error('No project or default layout configuration found');
      const config = readJson(file);
      delete config.workspace;
      console.log(JSON.stringify(config, null, 2));
    } else if (action === 'init') {
      console.log(`Initialized: ${(await initialize(home, project)).config}`);
    } else if (action === 'history') {
      console.log(JSON.stringify(await taskHistory({ home, project, role: roleName, cli: orca, cached: values.cached }), null, 2));
    } else if (action === 'restart') {
      await stage('Orca connection', () => ensureOrca({ cli: orca }));
      await stage('Agent update prehook', () => updatePrehook(home));
      await restartTeam({ home, project, targets: [...(values.role ? [values.role] : []), ...positionals.slice(1)], cli: orca, snapshot });
    } else if (action === 'start') {
      if (await stage('Orca connection', () => ensureOrca({ cli: orca }))) console.log('Orca was started automatically');
      const files = projectFiles(home, project);
      // Orca restores persisted PTYs when the workspace is revealed. Reveal via
      // the supported file-open CLI before checking for retained tabs without PTYs.
      const initial = await orca(['terminal', 'list', '--worktree', `path:${project}`]);
      if (!initial.terminals.length && fs.existsSync(files.state)) {
        const document = ['AGENTS.md', 'README.md'].find(name => fs.existsSync(path.join(project, name)));
        if (document) {
          await orca(['file', 'open', document, '--worktree', `path:${project}`]);
          for (let attempt = 0; attempt < 20; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 500));
            if ((await orca(['terminal', 'list', '--worktree', `path:${project}`])).terminals.length) break;
          }
        }
      }
      const candidates = [path.join(project, '.orca', 'team.json'), files.config, path.join(home, 'layout.json')];
      const file = candidates.find(candidate => fs.existsSync(candidate));
      if (!file) throw new Error('No project or default layout configuration found');
      const tabs = readJson(file).tabs;
      let names;
      if (values.group !== undefined) {
        const tab = tabs.find(item => item.title === values.group);
        if (!tab) throw new Error(`Unknown group: ${values.group}`);
        names = tab.agents;
      } else names = tabs.flatMap(tab => tab.agents);
      if (values.fresh?.length) {
        const wanted = [...new Set(values.fresh)];
        for (const name of wanted) if (!names.includes(name)) throw new Error(`${name}: role is not in the selected scope`);
        if (fs.existsSync(files.state)) {
          const state = readJson(files.state);
          const inventory = await orca(['terminal', 'list', '--worktree', `path:${project}`]);
          for (const name of wanted) {
            const saved = state.agents[name];
            if (saved && (inventory.terminals || []).some(row => row.tabId === saved.tabId && row.leafId === saved.leafId && row.connected && !row.orphaned)) {
              throw new Error(`${name}: role is running; use restart instead of --fresh`);
            }
            delete state.agents[name];
            console.log(`${name}: saved pane and conversation binding cleared; starting a fresh session`);
          }
          saveJson(files.state, state);
        }
      }
      await stage('Model selection', () => syncModels({ home, names, pick: !values['no-pick'] }));
      await stage('Agent update prehook', () => updatePrehook(home, names));
      // Reuse matching roles; only changed configurations need an exit/resume cycle.
      const { skipped, current } = await stage('Configuration reload', () => reloadRunning({ home, project, names, cli: orca, snapshot,
        inspect: (handle, provider) => inspectHealth(orca, rpc, handle, provider) }));
      if (current.length) console.log(`Configuration unchanged; reusing: ${current.join(', ')}`);
      await stage('Layout and conversation recovery', () => runTeam({ home, project, action, group: values.group, cli: orca, snapshot }));
      if (skipped.length) throw new Error(`Roles not restarted: ${skipped.map(item => `${item.name}: ${item.reason}`).join('; ')}`);
    } else if (action === 'status') {
      await runTeam({ home, project, action, group: values.group, cli: orca, snapshot });
    } else if (action === 'launch') {
      const role = readJson(path.join(home, 'team.json')).find(item => item.name === values.role);
      if (!role) throw new Error('Unknown role');
      fs.mkdirSync(path.join(home, 'generated'), { recursive: true });
      const prompt = path.join(home, 'generated', `${role.name}.md`);
      fs.writeFileSync(prompt, fs.readFileSync(path.join(home, 'roles', `${role.name}.md`), 'utf8').replaceAll('{{TEAM_ROOT}}', home.replaceAll('\\', '/')));
      const stateFile = projectFiles(home, project).state;
      const current = fs.existsSync(stateFile) ? readJson(stateFile).agents[role.name] : null;
      const saved = values.resume || current?.session ? current : null;
      if (values.resume && !saved?.session) throw new Error('Original session is unavailable');
      const launchRole = saved ? { ...saved, model: role.model, thinking: role.thinking, agent: role.agent } : role;
      const launch = launchArguments({ ...launchRole, role: role.role }, prompt, saved?.session, project, home, { codexNoDaemon: role.agent === 'codex' && supportsNoDaemon() });
      if (role.agent === 'codex' && role.piProvider) {
        const provider = readJson(path.join(os.homedir(), '.pi', 'agent', 'models.json')).providers?.[role.piProvider];
        if (!provider || provider.api !== 'openai-responses' || !provider.models?.some(model => model.id === role.model)) {
          throw new Error('Codex Pi provider binding is missing or incompatible');
        }
        if (typeof provider.apiKey !== 'string' || !provider.apiKey || provider.apiKey.startsWith('!') ||
            !provider.baseUrl?.startsWith('https://')) {
          throw new Error('Codex Pi provider binding requires an HTTPS endpoint and a literal API key');
        }
        launch.env.ORCA_TEAM_CODEX_PROVIDER_KEY = provider.apiKey;
        const overrides = {
          model_provider: 'orca_team_pi',
          'model_providers.orca_team_pi.name': `Pi ${role.piProvider}`,
          'model_providers.orca_team_pi.base_url': provider.baseUrl,
          'model_providers.orca_team_pi.wire_api': 'responses',
          'model_providers.orca_team_pi.env_key': 'ORCA_TEAM_CODEX_PROVIDER_KEY',
          'model_providers.orca_team_pi.requires_openai_auth': false,
        };
        for (const [key, value] of Object.entries(overrides)) launch.args.push('-c', `${key}=${JSON.stringify(value)}`);
      }
      if (!saved?.session && current?.launchIntent && ['pi', 'omp'].includes(role.agent)) {
        const transcript = current.launchIntent.transcriptPath;
        // 只有非空 transcript 才证明本次启动已经发生；空文件是下面预创建的占位。
        if (fs.existsSync(transcript) && fs.statSync(transcript).size > 0) throw new Error('Launch intent already has a transcript; rerun start to reconcile it');
        fs.mkdirSync(path.dirname(transcript), { recursive: true });
        // Pi 只在首个 assistant 消息后才落盘，缺失文件在启动阶段不会写 session header。
        // 预创建空文件让 Pi 立即写入 header，Orca 才能在 session_start 时记下
        // session_file/session_id，角色启动后无需等待首轮对话即可完成会话绑定。
        if (!fs.existsSync(transcript)) fs.writeFileSync(transcript, role.agent === 'omp' ? JSON.stringify({type:'session',version:3,id:current.launchIntent.id,timestamp:new Date().toISOString(),cwd:project})+'\n' : '');
        launch.args.push('--session', transcript,
          `Initialize the fixed ${role.name} role using the loaded instructions. Reply only "${role.name} ready". Do not call tools or start tasks.`);
      }
      if (role.agent === 'codex' && process.env.ORCA_CODEX_LAUNCH_PREFLIGHT) {
        const preparation = spawnSync(process.env.ORCA_CODEX_LAUNCH_PREFLIGHT,
          ['agent', 'hooks', 'prepare-codex'], { env: { ...process.env, ...launch.env }, windowsHide: true, encoding: 'utf8' });
        if (preparation.error || preparation.status !== 0) throw new Error('Orca Codex hook preparation failed');
      }
      let executable = launch.executable, args = launch.args;
      if (process.platform === 'win32') {
        const script = '& ' + [executable, ...args].map(value => quote(value, 'win32')).join(' ');
        executable = 'powershell.exe'; args = ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
      }
      const result = spawnSync(executable, args, { cwd: project, env: { ...process.env, ...launch.env }, stdio: 'inherit' });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    } else throw new Error(`Unknown action: ${action}`);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { if (!process.argv.includes('--help') && !process.argv.includes('export-config')) console.log(`Total: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`); }
