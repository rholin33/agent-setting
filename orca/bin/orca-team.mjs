#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { normalizeProject, quote } from '../lib/platform.mjs';
import { orca, snapshot, rpc } from '../lib/orca.mjs';
import { initialize, runTeam, readJson, projectFiles } from '../lib/team.mjs';
import { launchArguments } from '../lib/sessions.mjs';
import { restartRole } from '../lib/restart.mjs';
import { ensureOrca } from '../lib/orca-boot.mjs';
import { syncModels } from '../lib/model-sync.mjs';
import { reloadRunning } from '../lib/reload.mjs';
import { taskHistory } from '../lib/history.mjs';
import { deploy, installQuickCommands, registerShellProfile } from '../lib/install.mjs';

const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { home: { type: 'string' }, project: { type: 'string' }, role: { type: 'string' }, group: { type: 'string' }, cached: { type: 'boolean' }, resume: { type: 'boolean' }, 'quick-commands': { type: 'boolean' }, 'shell-profile': { type: 'string' }, 'no-pick': { type: 'boolean' }, help: { type: 'boolean' } } });
  const action = positionals[0] || 'start';
  const roleName = values.role || positionals[1];
  if (positionals.length > (['restart', 'history'].includes(action) ? 2 : 1)) throw new Error('Unexpected positional arguments');
  if (values.role && positionals[1] && values.role !== positionals[1]) throw new Error('Conflicting role arguments');
  if (values.group !== undefined && !['start', 'status'].includes(action)) throw new Error('--group is only supported for start/status');
  if (values.help) {
    console.log('orca-team [start|init|status|history [ROLE]|restart ROLE|install|export-config] [--project PATH] [--home PATH] [--no-pick]\nstart/status --group TITLE selects one configured group, e.g. master (master + loader).\nDefault: start Orca when it is not running, sync role models (Codex follows the local Codex config model; Pi opens a model/thinking picker in a terminal), then reload in parallel only the running roles whose applied model config changed (busy roles are skipped; unchanged roles are kept), and recover or create every group.\nRestart resumes one exact conversation in its existing pane. --no-pick skips the Pi picker (non-terminal starts never pick).\ninstall --quick-commands registers Orca grouped global shortcuts.');
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
      if (!roleName) throw new Error('Usage: orca-team restart ROLE');
      await restartRole({ home, project, role: roleName, cli: orca, snapshot });
    } else if (action === 'start') {
      if (await ensureOrca({ cli: orca })) console.log('Orca was started automatically');
      const files = projectFiles(home, project);
      let names;
      if (values.group !== undefined) {
        const candidates = [files.config, path.join(project, '.orca', 'team.json'), path.join(home, 'layout.json')];
        const file = candidates.find(candidate => fs.existsSync(candidate));
        if (!file) throw new Error(`Unknown group: ${values.group}`);
        const tab = readJson(file).tabs.find(item => item.title === values.group);
        if (!tab) throw new Error(`Unknown group: ${values.group}`);
        names = tab.agents;
      }
      await syncModels({ home, names, pick: !values['no-pick'] });
      await reloadRunning({ home, project, names, cli: orca, snapshot });
      await runTeam({ home, project, action, group: values.group, cli: orca, snapshot });
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
      const launch = launchArguments(launchRole, prompt, saved?.session, project);
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
      if (!saved?.session && current?.launchIntent && role.agent === 'pi') {
        const transcript = current.launchIntent.transcriptPath;
        if (fs.existsSync(transcript)) throw new Error('Launch intent already has a transcript; rerun start to reconcile it');
        fs.mkdirSync(path.dirname(transcript), { recursive: true });
        launch.args.push('--session', transcript,
          `Initialize the fixed ${role.name} role using the loaded instructions. Reply only "${role.name} ready". Do not call tools or start tasks.`);
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
