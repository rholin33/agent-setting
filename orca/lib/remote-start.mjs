import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { quote } from './platform.mjs';
import { normalizeProject } from './platform.mjs';
import { projectFiles, readJson } from './team.mjs';
import { binding, validateTranscript } from './sessions.mjs';
import { inspectHealth, provesSession } from './health.mjs';
import { rpc } from './orca.mjs';
import { readRemoteSwitches, beginRemoteSwitch, claimRemoteSetup, rejectRemoteSwitch, preflightFailureMessage, remotePreflightError, reattachOmpOwner } from './remote-switch.mjs';
import { runDirectHandoff as runDirectHandoffDefault, supportsDirectHandoff } from './remote-handoff.mjs';
import { ensureOmp as ensureOmpAdapter, ompSelection, validateOmpEndpoint, verifyOmpBinding } from './omp-adapter.mjs';
import { registerAuxiliary } from './auxiliary-cleanup.mjs';
import { ensureClaudeLocalTerminal } from './claude-local-terminal.mjs';

export function parseRemoteRequests(values, names) {
  const requests = (values || []).map(value => {
    const match = /^(codex|omp|claude|off):([\w-]+)$/.exec(value);
    if (!match) throw new Error('Expected --remote codex:ROLE, omp:ROLE, claude:ROLE or off:ROLE');
    if (!names.includes(match[2])) throw new Error(`Unknown remote role in selected scope: ${match[2]}`);
    return { runtime: match[1] === 'off' ? null : match[1], role: match[2] };
  });
  if (new Set(requests.map(item => item.role)).size !== requests.length) throw new Error('Duplicate remote role');
  return requests;
}

export function remoteManagementPrompt({ intents, home, project, skill }) {
  return [
    `Load the orca-remote skill at ${JSON.stringify(skill)}, references/handoff.md and the operations manual.`,
    'This is a bidirectional context switch, not an additional independent task. You are remote-setup, the coordinator, never the business source.',
    `Team home: ${JSON.stringify(home)}; worktree: ${JSON.stringify(project)}.`,
    'Endpoint role is the canonical team role, not the terminal/instance display label (for example a remote-suffixed label). Verify its actual role package and permissions before using that canonical identity. Endpoint environment is the TUI host; intent.environment is the requested model host.',
    'The following durable intents bind the exact source, original local return endpoint, task ID and private ledger directory. Never substitute this setup conversation for their source.',
    JSON.stringify(intents, null, 2),
    ...intents.map(intent => intent.runtime === 'omp'
      ? `OMP ${intent.role} is already provisioned. Reuse only target ${JSON.stringify(intent.target)} with adapterConfig ${JSON.stringify(intent.adapterConfig)}. Never discover, guess, launch, or create another OMP destination.`
      : intent.runtime
        ? `$orca-remote -${intent.runtime} ${intent.role}${intent.environment ? ` --environment ${JSON.stringify(intent.environment)}` : ''} --worktree ${JSON.stringify(project)}`
        : `$orca-remote --to-agent ${intent.local.terminal} --worktree ${JSON.stringify(project)}`),
    ...intents.filter(intent => intent.runtime === 'omp').map(intent => `Before handoff delivery and again before recording an assistant receipt for ${intent.role}, run exactly: ${['python3', path.join(home, 'remote-master', 'omp_adapter.py'), 'verify', '--config', intent.adapterConfig].map(value => quote(value)).join(' ')} . Require the returned runtime, role, environment, terminal, incarnation, session and adapterConfig to match the supplied bound target exactly. On failure stop; do not substitute or recreate a destination.`),
    'For each intent obtain the latest checkpoint from its exact source, verify a safe pause and no outstanding writes, and retain its native history. If identity, native session, draft input, or idle state cannot be verified, stop and report the blocker. Do not interrupt a busy agent.',
    'Use the supplied taskId and ledgerDirectory with scripts/handoff.py. If that task already has a handoff, reconcile its latest revision before doing anything; claimed/uncertain delivery must never be resent. A completed handoff in this ledger is the sole authority for the current owner.',
    'For Codex or Claude, create or reuse the requested destination using the skill. For OMP, reuse only the supplied verified target and adapterConfig; no destination research or creation. For off, reuse the exact original local endpoint; do not create a replacement conversation. Preserve permissions and load the canonical role prompt. Build the context handoff from the agent-driven source summary, never from startup configuration. OMP must use its own verified connection, never fall back to Codex.',
    'Run prepare/claim, deliver once, and record only a verified assistant acceptance or rejection. Transport success or terminal echo is not acknowledgement. Do not focus the destination before acceptance.',
    ...intents.map(intent => `After verified acceptance run: ${[process.execPath, path.join(home, 'bin', 'orca-team.mjs'), 'remote-commit', '--home', home, '--project', project, '--role', intent.role, '--intent', intent.id].map(value => quote(value)).join(' ')} . For a verified rejection use remote-reject with the same arguments instead.`),
    'The commit command validates the ledger and live endpoints before changing the selected runtime and focusing the destination. On failure retain the source and report pending/unknown; never claim a successful switch or edit menu state manually.',
    'If preflight aborts before any checkpoint request, destination launch, prepare/claim or context delivery, preserve a version-1 execution report and use orca-team remote-abort-preflight with its exact intent ID and --report FILE; see docs/features/remote-startup.md. Never fabricate a target rejection. Unknown delivery cannot use this path.',
    'Do not restart local roles, change providers/models, copy repositories/credentials, start business tasks, or widen source-write permissions. Report source, destination, task/revision, acknowledgement and final switch state.',
  ].join('\n');
}

async function liveEndpoint({ cli, project, handle, role, saved, expected, snapshot, inspect }) {
  const args = ['terminal', 'show', '--terminal', handle];
  if (expected?.environment && expected.environment !== 'local') args.push('--environment', expected.environment);
  const { terminal } = await cli(args);
  if (!terminal?.connected || terminal.orphaned || terminal.writable === false || normalizeProject(terminal.worktreePath || '') !== project || !terminal.incarnationId) {
    throw new Error(`${role}: source/return terminal is unavailable or belongs to another worktree`);
  }
  const runtime = terminal.agentIdentity;
  if (!['codex', 'omp', 'pi', 'claude'].includes(runtime)) throw new Error(`${role}: terminal is not a supported agent`);
  const observed = terminal.providerSession?.id || terminal.agentSession?.id || terminal.session?.id || terminal.agentSessionId || terminal.sessionId;
  const reference = { ...saved, tabId: terminal.tabId, leafId: terminal.leafId, agent: runtime, session: expected ? { id: expected.session } : saved?.session };
  const savedSession = snapshot ? binding(await snapshot(), reference, project)?.id : null;
  let session = observed || savedSession;
  if (!session && saved?.session && saved.agent === runtime && terminal.executionHostId === 'local') {
    const live = await inspect(handle, runtime);
    validateTranscript(saved, project);
    if (!provesSession(live, saved) || live.terminal?.handle !== terminal.handle ||
        live.terminal.incarnationId !== terminal.incarnationId || live.terminal.ptyId !== terminal.ptyId) {
      throw new Error(`${role}: saved conversation is not proven by the live process; original owner retained`);
    }
    session = saved.session.id;
  }
  session ||= expected?.session;
  if (!session || session.startsWith('unknown:')) throw new Error(`${role}: native session identity is unavailable; refusing an implicit context switch`);
  const actual = { runtime, role: expected?.role || role, environment: expected?.environment || 'local', terminal: handle, incarnation: terminal.incarnationId, session };
  if (expected && Object.keys(actual).some(key => actual[key] !== expected[key])) throw new Error(`${role}: bound conversation changed; original owner retained`);
  return actual;
}

export async function verifyRemoteEnvironment({ requests, environment, cli }) {
  if (environment !== undefined && (!environment.trim() || /[\r\n\0]/.test(environment))) throw new Error('Invalid remote environment');
  if (requests.some(request => request.runtime === 'claude')) {
    const listed = await cli(['environment', 'list']);
    const candidates = listed.environments || listed.result?.environments || [];
    if (!candidates.length) throw new Error('Claude remote requires one verified Orca environment: no saved remote environment. Pair the remote Orca host with orca environment add --name NAME --pairing-code CODE before retrying.');
    const matches = environment === undefined ? candidates : candidates.filter(item => item.id === environment || item.name === environment);
    if (matches.length !== 1) throw new Error('Claude remote requires one verified Orca environment; select --environment explicitly or configure a remote environment first');
    environment = matches[0].id || matches[0].name;
    if (!environment || environment === 'local') throw new Error('Claude remote requires a remote environment, not local');
  }
  return environment;
}

async function startRemoteRequestsAtLocal({ requests, home = path.join(os.homedir(), '.orca', 'roles', 'ccb-team'), project, environment, sourceHandle, cli, snapshot, ensureOmp = ensureOmpAdapter, verifyOmp = verifyOmpBinding, inspect = (handle, provider) => inspectHealth(cli, rpc, handle, provider), skill = path.join(os.homedir(), '.codex', 'skills', 'orca-remote', 'SKILL.md'), runDirectHandoff = runDirectHandoffDefault, log = console.log }) {
  if (!requests.length) return null;
  if (!fs.existsSync(skill)) throw new Error(`Remote skill not found: ${skill}`);
  environment = await verifyRemoteEnvironment({ requests, environment, cli });
  if (sourceHandle && requests.length !== 1) throw new Error('--from-agent requires exactly one role');
  project = normalizeProject(fs.realpathSync(project));
  home = fs.realpathSync(home);
  const registry = readRemoteSwitches({ home, project });
  const failed = preflightFailureMessage(registry, requests.filter(request => request.runtime !== null && request.runtime !== 'omp').map(request => request.role));
  if (failed) throw remotePreflightError(failed);
  const stateFile = projectFiles(home, project).state;
  const team = fs.existsSync(stateFile) ? readJson(stateFile) : { agents: {} };
  const inventory = await cli(['terminal', 'list', '--worktree', `path:${project}`]);
  const plans = [], resumed = [];
  // 远端 OMP 原归属者的源端适配配置：切回或改投时从它读取远端新进展。
  const sourceAdapter = role => registry.roles[role]?.runtime === 'omp' ? registry.roles[role].adapterConfig : undefined;
  for (const request of requests) {
    let previous = registry.roles[request.role];
    if (previous?.runtime === 'claude' && !previous.pending && request.runtime === 'claude') {
      if (!previous.claudeConfig) throw new Error(`${request.role}: Claude owner has no verified scoped binding`);
      if (environment && environment !== previous.owner.environment) throw new Error(`${request.role}: Claude environment differs from current owner`);
      const presentation = await ensureClaudeLocalTerminal({ home, config: previous.claudeConfig, endpoint: previous.owner, project, cli });
      plans.push({ ...request, source: previous.owner, local: previous.local, presentation, reuse: true });
      continue;
    }
    if (previous?.pending) {
      // 已投递但未收到回执的确定性交接：只继续等待回执，绝不重发。
      const intent = { ...previous.pending, role: request.role };
      if (intent.status === 'setup_uncertain' && intent.runtime === request.runtime && supportsDirectHandoff(intent, registry)) {
        resumed.push({ role: request.role, ...await runDirectHandoff({ home, project, role: request.role, intent, sourceAdapterConfig: sourceAdapter(request.role), cli, skill, verifyOmp, log }) });
        continue;
      }
      throw new Error(`${request.role}: unresolved remote switch already exists; reconcile instead of provisioning or resending`);
    }
    const nativeOwner = previous?.runtime === 'omp';
    if (nativeOwner) {
      if (!previous.adapterConfig) throw new Error(`${request.role}: native owner has no verified adapter binding`);
      const bound = readJson(previous.adapterConfig);
      if (bound.project !== project || bound.role !== request.role) throw new Error('Native owner scope changed');
      if (request.runtime === 'omp') {
        const desired = ompSelection(home, request.role);
        if (desired.model !== bound.model || (desired.thinking || 'off') !== bound.thinking) {
          throw new Error(`${request.role}: the active remote model differs from the selected configuration; refusing an implicit model switch`);
        }
      }
      const spec = { home, project, role: request.role, model: bound.model, thinking: bound.thinking, environment: bound.environment };
      const endpoint = await ensureOmp(spec);
      await validateOmpEndpoint(endpoint, spec, cli);
      previous = await reattachOmpOwner({ home, project, role: request.role, endpoint, config: previous.adapterConfig, cli, verifyOmp });
      registry.roles[request.role] = previous;
    }
    const saved = team.agents?.[request.role];
    const candidates = (inventory.terminals || []).filter(row => saved && row.tabId === saved.tabId && row.leafId === saved.leafId && row.connected && !row.orphaned);
    const handle = previous?.owner?.terminal || sourceHandle || (candidates.length === 1 ? candidates[0].handle : null);
    if (!handle) throw new Error(`${request.role}: no unique bound business source; use --from-agent with its verified existing terminal`);
    if (previous && sourceHandle && sourceHandle !== handle) throw new Error(`${request.role}: --from-agent is not the current owner`);
    const source = await liveEndpoint({ cli, project, handle, role: request.role, saved: nativeOwner ? undefined : saved, expected: previous?.owner, snapshot: nativeOwner ? undefined : snapshot, inspect });
    const local = previous?.local || source;
    if ((request.runtime === null || request.runtime === 'omp') && local.terminal !== source.terminal) await liveEndpoint({ cli, project, handle: local.terminal, role: request.role, saved, expected: local, snapshot, inspect });
    plans.push({ ...request, source, local, reuse: !previous?.pending && (previous ? previous.runtime === request.runtime : request.runtime === null) });
  }
  // Prove every source/return before provisioning, and every OMP target before
  // beginning any durable handoff. Readiness never changes the source owner.
  for (const plan of plans) {
    if (plan.runtime !== 'omp') continue;
    if (plan.reuse) {
      continue;
    }
    const request = { home, project, role: plan.role, ...ompSelection(home, plan.role), environment };
    const endpoint = await ensureOmp(request);
    Object.assign(plan, await validateOmpEndpoint(endpoint, request, cli));
    if (plan.target.terminal === plan.source.terminal) throw new Error(`${plan.role}: OMP target must differ from the business source`);
  }
  const intents = [];
  for (const plan of plans) {
    if (plan.reuse) {
      const args = ['terminal', 'switch', '--terminal', plan.presentation?.handle || plan.source.terminal];
      if (!plan.presentation && plan.source.environment !== 'local') args.push('--environment', plan.source.environment);
      await cli(args);
    } else {
      const bound = plan.runtime === 'omp' ? { target: plan.target, adapterConfig: plan.adapterConfig } : {};
      intents.push({ ...await beginRemoteSwitch({ home, project, role: plan.role, runtime: plan.runtime, source: plan.source, local: plan.local, environment, ...bound }), role: plan.role, ...bound });
    }
  }
  if (!intents.length) return resumed.length ? { direct: resumed } : { reused: true };
  // OMP 与切回本机直接由确定性流程完成；只有远端 Codex 仍需要 AI 协调者。
  const direct = intents.filter(intent => supportsDirectHandoff(intent, registry));
  const results = [...resumed];
  for (const intent of direct) {
    try {
      results.push({ role: intent.role, ...await runDirectHandoff({ home, project, role: intent.role, intent, sourceAdapterConfig: sourceAdapter(intent.role), cli, skill, verifyOmp, log }) });
    } catch (error) {
      // 投递前失败：取消未领取的意图，源保持归属；领取后失败保留待确认状态，再次运行继续等待。
      if (readRemoteSwitches({ home, project }).roles[intent.role]?.pending?.status === 'prepared') {
        await rejectRemoteSwitch({ home, project, role: intent.role, intentId: intent.id, cli });
        error.message += '; original owner retained, nothing was sent';
      }
      throw error;
    }
  }
  const coordinated = intents.filter(intent => !direct.includes(intent));
  if (!coordinated.length) return { direct: results };
  for (const intent of coordinated) await claimRemoteSetup({ home, project, role: intent.role, intentId: intent.id });
  const prompt = remoteManagementPrompt({ intents: coordinated, home, project, skill });
  const args = ['codex', '--no-daemon', '--cd', project, prompt];
  const command = process.platform === 'win32'
    ? 'powershell.exe -NoLogo -NoProfile -EncodedCommand ' + Buffer.from('& ' + args.map(value => quote(value, 'win32')).join(' '), 'utf16le').toString('base64')
    : 'command ' + args.map(value => quote(value)).join(' ');
  // Coordinator creation is claimed once; an ambiguous create is never replayed.
  const created = await cli(['terminal', 'create', '--worktree', `path:${project}`, '--title', 'remote-setup', '--command', command]);
  const handle = created?.terminal?.handle;
  if (!handle) throw new Error('Setup creation returned no terminal identity; inspect existing terminals before retrying.');
  try { registerAuxiliary({ home, project, kind: 'remote-setup', terminal: created.terminal, intents: coordinated }); }
  catch { console.warn(`Coordinator ${handle}: automatic cleanup registration failed; retain for explicit reconciliation.`); }
  try { await cli(['terminal', 'switch', '--terminal', handle]); }
  catch (error) { throw new Error(`Coordinator ${handle} was created but could not be focused; do not recreate it. ${error.message}`); }
  return created;
}

export async function startRemoteRequests(options) {
  const environment = process.env.ORCA_ENVIRONMENT;
  const pairing = process.env.ORCA_PAIRING_CODE;
  delete process.env.ORCA_ENVIRONMENT;
  delete process.env.ORCA_PAIRING_CODE;
  try { return await startRemoteRequestsAtLocal(options); }
  catch (error) {
    error.code ||= 'REMOTE_HANDOFF_BLOCKED';
    throw error;
  }
  finally {
    if (environment !== undefined) process.env.ORCA_ENVIRONMENT = environment;
    if (pairing !== undefined) process.env.ORCA_PAIRING_CODE = pairing;
  }
}
