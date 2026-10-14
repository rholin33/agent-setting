#!/usr/bin/env node
import { openRepair } from '../lib/startup-repair.mjs';
import { parseRemoteRequests, startRemoteRequests } from '../lib/remote-start.mjs';
import { readRemoteSwitches, commitRemoteSwitch, rejectRemoteSwitch, abortRemotePreflight, preflightFailureMessage, remotePreflightError, resolvePreflightChoices } from '../lib/remote-switch.mjs';
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
import { claudeTranscriptPath } from '../lib/claude.mjs';
import { restartTeam, resolveRestartRoles } from '../lib/restart.mjs';
import { inspectHealth } from '../lib/health.mjs';
import { ensureOrca } from '../lib/orca-boot.mjs';
import { syncModels } from '../lib/model-sync.mjs';
import { switchProviders, handoffPrompt } from '../lib/handoff.mjs';
import { updateAgentsBeforeStart, checkAgentUpdates, clearUpdateCheck } from '../lib/agent-update.mjs';
import { updateLifecycle } from '../lib/update-lifecycle.mjs';
import { reloadRunning } from '../lib/reload.mjs';
import { restoreGroupLayout } from '../lib/layout.mjs';
import { taskHistory } from '../lib/history.mjs';
import { deploy, installQuickCommands, registerShellProfile } from '../lib/install.mjs';

const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const startedAt = Date.now();
let requestedAction;
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
// start/restart 只做只读版本检查，不停止任何角色；检查失败只警告。
async function updateCheck(home, names) {
  const catalog = readJson(path.join(home, 'team.json'));
  try { await checkAgentUpdates({ home, agents: catalog.filter(role => !names || names.includes(role.name)).map(role => role.agent) }); }
  catch (error) { console.log(`Warning: agent update check skipped: ${error.message}`); }
}
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { remote: { type: 'string', multiple: true }, environment: { type: 'string' }, 'from-agent': { type: 'string' }, intent: { type: 'string' }, report: { type: 'string' }, home: { type: 'string' }, project: { type: 'string' }, role: { type: 'string' }, group: { type: 'string' }, fresh: { type: 'string', multiple: true }, cached: { type: 'boolean' }, resume: { type: 'boolean' }, 'quick-commands': { type: 'boolean' }, 'shell-profile': { type: 'string' }, 'no-pick': { type: 'boolean' }, 'no-repair': { type: 'boolean' }, help: { type: 'boolean' } } });
  const action = positionals[0] || 'start';
  requestedAction = action;
  const roleName = values.role || positionals[1];
  if (action !== 'restart' && positionals.length > (action === 'history' ? 2 : 1)) throw new Error('Unexpected positional arguments');
  if (values.role && positionals[1] && action !== 'restart' && values.role !== positionals[1]) throw new Error('Conflicting role arguments');
  if (values.group !== undefined && !['start', 'status', 'restart'].includes(action)) throw new Error('--group is only supported for start/status/restart');
  if (values.fresh?.length && action !== 'start') throw new Error('--fresh is only supported for start');
  if (values.remote?.length && !['start', 'remote'].includes(action)) throw new Error('--remote is only supported for start/remote');
  if (values.environment !== undefined && !['start', 'remote'].includes(action)) throw new Error('--environment is only supported for start/remote');
  if (values['from-agent'] !== undefined && !['start', 'remote'].includes(action)) throw new Error('--from-agent is only supported for start/remote');
  if (values.intent !== undefined && !['remote-commit', 'remote-reject', 'remote-abort-preflight'].includes(action)) throw new Error('--intent is only supported for remote-commit/remote-reject');
  if (values.report !== undefined && action !== 'remote-abort-preflight') throw new Error('--report is only supported for remote-abort-preflight');
  if (values.help) {
    console.log('orca-team [status|history [ROLE]|init|install|export-config|update] [--group TITLE] [--project PATH] [--home PATH] [--fresh ROLE] [--no-pick] [--remote codex:ROLE|omp:ROLE|off:ROLE] [--environment NAME] [--from-agent HANDLE]\nremote --remote codex:ROLE|omp:ROLE|off:ROLE requests a context handoff without restarting the local team. Picker r selects codex/omp/off; off hands back to the original local agent. Selections commit only after verified acknowledgement.\nremote-abort-preflight --role ROLE --intent ID --report FILE settles only proven pre-delivery OMP failures, preserving the execution report. remote-status shows confirmed owners, pending intents and preflight failures. remote-commit / remote-reject --role ROLE --intent ID settle only against the matching verified handoff ledger.\nPending or remotely owned groups are preserved; independent groups still recover. Incomplete start/restart automatically opens one Codex repair terminal.\nOtherwise start brings the selected project to its configured state. Running roles whose CLI, model, thinking and role prompt are unchanged are reused; changed roles restart with their original conversation. start/restart only check for agent updates (cached for 24h) and never stop roles for them; update stops roles using outdated CLIs, installs the updates and resumes their conversations. restart [ROLE|GROUP ...] or restart --group TITLE explicitly restarts roles; --fresh ROLE starts a stopped role with a new conversation and refuses continuity-bound roles.\nSelecting a different CLI in the picker stops the role, writes a handoff document from its previous conversation, and starts a new conversation that reads it first; remotely owned or pending roles refuse a CLI change.\n--no-pick skips the model picker. --no-repair disables recursive repair launch. install --quick-commands registers Orca grouped global shortcuts.');
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
    } else if (action === 'remote-status') {
      console.log(JSON.stringify(readRemoteSwitches({ home, project }), null, 2));
    } else if (action === 'remote-abort-preflight') {
      if (!roleName || !values.intent || !values.report) throw new Error('remote-abort-preflight requires --role, --intent and --report');
      const outcome = await abortRemotePreflight({ home, project, role: roleName, intentId: values.intent, reportFile: values.report, cli: orca });
      console.log(`${roleName}: ${outcome.status}; source retained; ${outcome.reasons.join('; ')}`);
    } else if (['remote-commit', 'remote-reject'].includes(action)) {
      if (!roleName || !values.intent) throw new Error(`${action} requires --role and --intent`);
      const settle = action === 'remote-commit' ? commitRemoteSwitch : rejectRemoteSwitch;
      await settle({ home, project, role: roleName, intentId: values.intent, cli: orca });
      const settled = readRemoteSwitches({ home, project }).roles[roleName];
      if (action === 'remote-commit') {
        const focusArgs = ['terminal', 'switch', '--terminal', settled.owner.terminal];
        if (settled.owner.environment !== 'local') focusArgs.push('--environment', settled.owner.environment);
        await orca(focusArgs);
      }
      console.log(`${roleName}: ${action === 'remote-commit' ? 'handoff accepted; owner updated and focused' : 'handoff rejected; source retained'}`);
    } else if (action === 'remote') {
      const configFile = [path.join(project, '.orca', 'team.json'), projectFiles(home, project).config, path.join(home, 'layout.json')].find(file => fs.existsSync(file));
      if (!configFile) throw new Error('No project or default layout configuration found');
      const names = readJson(configFile).tabs.flatMap(tab => tab.agents);
      const catalog = readJson(path.join(home, 'team.json'));
      const requests = parseRemoteRequests(values.remote, names.filter(name => catalog.some(role => role.name === name)));
      if (!requests.length) throw new Error('remote requires --remote codex:ROLE, omp:ROLE or off:ROLE');
      await ensureOrca({ cli: orca });
      const result = await startRemoteRequests({ requests, home, project, environment: values.environment, sourceHandle: values['from-agent'], cli: orca, snapshot });
      console.log(result?.reused ? 'Confirmed current owner reused and focused.' : `Handoff coordinator opened and focused: ${result.terminal.handle}. Follow progress there; source remains owner until verified remote-commit.`);
    } else if (action === 'update') {
      // 显式更新：停止使用待更新 CLI 的角色，更新后恢复原会话。
      await stage('Orca connection', () => ensureOrca({ cli: orca }));
      await stage('Agent update', () => updatePrehook(home));
      clearUpdateCheck(home);
    } else if (action === 'restart') {
      const files = projectFiles(home, project);
      if (!fs.existsSync(files.config) || !fs.existsSync(files.state)) throw new Error(`No initialized Orca team for ${project}; specify --project PATH. Restart will not create a new team.`);
      const targets = [...(values.role ? [values.role] : []), ...(values.group ? [values.group] : []), ...positionals.slice(1)];
      const restartNames = resolveRestartRoles(readJson(files.config), readJson(path.join(home, 'team.json')), targets);
      await stage('Orca connection', () => ensureOrca({ cli: orca }));
      await stage('Agent update check', () => updateCheck(home, restartNames));
      await restoreGroupLayout({ project, config: readJson(files.config), state: readJson(files.state) });
      await restartTeam({ home, project, forceExit: true, targets, cli: orca, snapshot });
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
      const continuity = readRemoteSwitches({ home, project });
      const preflightFailure = preflightFailureMessage(continuity, names);
      if (preflightFailure) console.log(preflightFailure);
      if (values.fresh?.length) {
        const wanted = [...new Set(values.fresh)];
        for (const name of wanted) if (!names.includes(name)) throw new Error(`${name}: role is not in the selected scope`);
        if (wanted.some(name => continuity.roles[name])) throw new Error('--fresh cannot discard a context-continuity binding; preserve the original conversation');
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
      let remoteRequests = parseRemoteRequests(values.remote, names);
      const interactivePicker = !values['no-pick'] && process.stdin.isTTY && process.stdout.isTTY;
      if (preflightFailure && !interactivePicker) remoteRequests = resolvePreflightChoices(continuity, names, remoteRequests);
      const pickerRequests = [];
      const menuResult = {};
      const confirmRemote = names.filter(name => continuity.roles[name]?.lastSetupOutcome?.status === 'preflight_failed');
      const remoteStates = Object.fromEntries(Object.entries(continuity.roles).map(([name, entry]) => [name, entry.runtime]));
      const sessionAgents = fs.existsSync(files.state) ? Object.fromEntries(Object.entries(readJson(files.state).agents).filter(([, saved]) => saved.session || saved.launchIntent).map(([name, saved]) => [name, saved.agent])) : {};
      // 远端接管或交接待确认的角色由 continuity 账本负责，不能同时切换本地 CLI。
      const prepareSwitches = switches => {
        const bound = switches.filter(({ name }) => continuity.roles[name]?.pending || continuity.roles[name]?.runtime).map(({ name }) => name);
        if (bound.length) throw new Error(`Cannot switch CLI for continuity-bound roles: ${bound.join(', ')}; settle remote handoffs first`);
        return switchProviders({ switches, home, project, cli: orca, snapshot,
          inspect: (handle, provider) => inspectHealth(orca, rpc, handle, provider) });
      };
      await stage('Model selection', () => syncModels({ home, names, pick: !values['no-pick'], sessionAgents, prepareSwitches, remoteStates, remoteRequests: pickerRequests, confirmRemote, menuResult }));
      if (menuResult.status === 'cancelled') throw Object.assign(new Error('Startup cancelled; no roles restarted or remote requests sent.'), { code: 'STARTUP_CANCELLED' });
      for (const request of pickerRequests) {
        if (!remoteRequests.some(item => item.role === request.role)) remoteRequests.push(request);
      }
      for (const name of names) {
        if (continuity.roles[name]?.runtime === 'omp' && !continuity.roles[name].pending && !remoteRequests.some(item => item.role === name)) {
          remoteRequests.push({ role: name, runtime: 'omp' });
        }
      }
      if (preflightFailure && interactivePicker) remoteRequests = resolvePreflightChoices(continuity, names, remoteRequests);
      const protectedRoles = names.filter(name => continuity.roles[name]?.pending || continuity.roles[name]?.runtime);
      if (remoteRequests.length || protectedRoles.length) {
        // Never reload a source or its original local return conversation before handoff.
        if (remoteRequests.length) {
          const result = await startRemoteRequests({ requests: remoteRequests, home, project, environment: values.environment, sourceHandle: values['from-agent'], cli: orca, snapshot });
          console.log(result?.reused ? 'Confirmed current owner reused and focused.' : `Handoff coordinator opened and focused: ${result.terminal.handle}. Follow progress there; source remains owner until verified remote-commit.`);
        } else console.log(`Continuity-bound roles preserved: ${protectedRoles.join(', ')}; inspect remote-status for pending handoffs.`);
        const protectedNames = new Set([...protectedRoles, ...remoteRequests.map(item => item.role)]);
        const independent = tabs.filter(tab => tab.agents.every(name => !protectedNames.has(name)) && tab.agents.some(name => names.includes(name)));
        const failures = [];
        for (const tab of independent) {
          try {
            const result = await reloadRunning({ home, project, names: tab.agents, cli: orca, snapshot,
              inspect: (handle, provider) => inspectHealth(orca, rpc, handle, provider) });
            await runTeam({ home, project, action, group: tab.title, cli: orca, snapshot });
            failures.push(...result.skipped.map(item => `${item.name}: ${item.reason}`));
          } catch (error) { failures.push(`${tab.title}: ${error.message}`); }
        }
        console.log(`Protected handoffs retained; recovered independent groups: ${independent.map(tab => tab.title).join(', ') || 'none'}.`);
        if (failures.length) throw new Error(`Independent group recovery incomplete: ${failures.join('; ')}`);
        const unresolved = protectedRoles.filter(name => continuity.roles[name]?.pending);
        if (unresolved.length) throw Object.assign(new Error(`Existing handoffs require reconciliation: ${unresolved.join(', ')}`), { code: 'REMOTE_HANDOFF_BLOCKED' });
      } else {
        await stage('Agent update check', () => updateCheck(home, names));
        const { skipped, current } = await stage('Configuration reload', () => reloadRunning({ home, project, names, cli: orca, snapshot,
          inspect: (handle, provider) => inspectHealth(orca, rpc, handle, provider) }));
        if (current.length) console.log(`Configuration unchanged; reusing: ${current.join(', ')}`);
        await stage('Layout and conversation recovery', () => runTeam({ home, project, action, group: values.group, cli: orca, snapshot }));
        if (skipped.length) throw new Error(`Roles not restarted: ${skipped.map(item => `${item.name}: ${item.reason}`).join('; ')}`);
      }
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
      // 切换 CLI 后的首次启动先读取旧会话交接文档；已绑定新会话后不再注入。
      const handoff = saved?.session ? null : current?.handoff ?? null;
      const initialMessage = handoff ? handoffPrompt(role.name, handoff)
        : `Initialize the fixed ${role.name} role using the loaded instructions. Reply only "${role.name} ready". Do not call tools or start tasks.`;
      const launch = launchArguments({ ...launchRole, role: role.role }, prompt, saved?.session, project, home,
        { codexNoDaemon: role.agent === 'codex' && supportsNoDaemon(), initialNote: handoff && initialMessage });
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
        launch.args.push('--session', transcript, initialMessage);
      }
      if (!saved?.session && role.agent === 'claude') {
        const id = current?.launchIntent?.id;
        if (!id) throw new Error('Claude launch intent is missing; rerun start to prepare it');
        // --session-id 只能创建一次；已有 transcript 说明上次启动已经发生，交给 start 对账而不是重复创建。
        if (claudeTranscriptPath(id)) throw new Error('Launch intent already has a transcript; rerun start to reconcile it');
        launch.args.push('--session-id', id, '--name', role.name, initialMessage);
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
} catch (error) {
  console.error(error.message); process.exitCode = 1;
  const args = process.argv.slice(2);
  const action = requestedAction;
  if (!['REMOTE_PREFLIGHT_FAILED', 'REMOTE_HANDOFF_BLOCKED', 'STARTUP_CANCELLED'].includes(error.code) && ['start', 'restart'].includes(action) && !args.includes('--no-repair') && !args.includes('--help')) {
    try {
      const value = flag => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
      const home = path.resolve(value('--home') || process.env.ORCA_TEAM_HOME || path.join(os.homedir(), '.orca', 'roles', 'ccb-team'));
      const project = normalizeProject(fs.realpathSync(value('--project') || process.cwd()));
      const result = await openRepair({ home, project, args, error: error.message, cli: orca });
      console.error(`Startup incomplete; Codex repair ${result.status}: ${result.terminal || result.file}. Original command remains failed.`);
    } catch (repairError) { console.error(`Codex repair unavailable: ${repairError.message}`); }
  }
}
finally { if (!process.argv.includes('--help') && !process.argv.includes('export-config')) console.log(`Total: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`); }
