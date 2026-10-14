import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { projectFiles, withLock } from './team.mjs';
import { normalizeProject } from './platform.mjs';
import { sameWorktree, validateTranscript } from './sessions.mjs';
import { inspectHealth, provesSession } from './health.mjs';
import { rpc } from './orca.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { verifyOmpBinding } from './omp-adapter.mjs';

const identityFields = ['runtime', 'role', 'environment', 'terminal', 'incarnation', 'session'];
const summaryFields = ['goal', 'constraints', 'completed', 'changed_files', 'decisions', 'verification', 'pending', 'inflight'];
const empty = () => ({ version: 1, roles: {} });
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;

function roleName(role) {
  if (typeof role !== 'string' || !/^[a-z][a-z0-9_]*$/.test(role)) throw new Error('Invalid remote role name');
  return role;
}
function identity(value, role) {
  roleName(role);
  if (!value || identityFields.some(key => typeof value[key] !== 'string' || !value[key].trim() || /[\r\n\0]/.test(value[key])) ||
      !['codex', 'omp', 'pi'].includes(value.runtime) || value.role !== role) throw new Error('Invalid remote endpoint identity');
  return Object.fromEntries(identityFields.map(key => [key, value[key]]));
}
function equalIdentity(left, right, role) {
  return isDeepStrictEqual(identity(left, role), identity(right, role));
}
function filesFor(home, project, role) {
  if (typeof home !== 'string' || !home || typeof project !== 'string' || !project) throw new Error('Home and project are required');
  const files = projectFiles(path.resolve(home), normalizeProject(project));
  return { ...files, registry: path.join(files.directory, 'remote-switches.json'),
    ledgers: path.join(files.directory, 'remote-handoffs'),
    ledgerDirectory: role === undefined ? undefined : path.join(files.directory, 'remote-handoffs', roleName(role)) };
}
function assertRegular(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) throw new Error(`Unsafe remote switch path: ${file}`);
}
function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertRegular(directory, true);
  fs.chmodSync(directory, 0o700);
}
function readJson(file) {
  assertRegular(file);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function savePrivate(file, value) {
  if (fs.existsSync(file)) assertRegular(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* The descriptor may already be closed. */ }
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
}
function readRegistry(files) {
  if (!fs.existsSync(files.directory)) return empty();
  assertRegular(files.directory, true);
  if (!fs.existsSync(files.registry)) return empty();
  const state = readJson(files.registry);
  if (state.version !== 1 || !state.roles || typeof state.roles !== 'object' || Array.isArray(state.roles)) throw new Error('Invalid remote switch registry');
  for (const [role, entry] of Object.entries(state.roles)) {
    roleName(role);
    if (!entry || ![null, 'codex', 'omp'].includes(entry.runtime) || typeof entry.taskId !== 'string' ||
        entry.ledgerDirectory !== path.join(files.ledgers, role)) throw new Error('Remote switch scope mismatch');
    identity(entry.owner, role); identity(entry.local, role);
    if (entry.pending && (entry.pending.taskId !== entry.taskId || entry.pending.ledgerDirectory !== entry.ledgerDirectory ||
        !equalIdentity(entry.pending.source, entry.owner, role) || !equalIdentity(entry.pending.local, entry.local, role))) throw new Error('Invalid pending remote switch');
  }
  return state;
}
function ledgerRecord(entry) {
  if (!fs.existsSync(entry.ledgerDirectory)) return null;
  assertRegular(path.dirname(entry.ledgerDirectory), true);
  assertRegular(entry.ledgerDirectory, true);
  const file = path.join(entry.ledgerDirectory, 'state.json');
  if (!fs.existsSync(file)) return null;
  return own(readJson(file), entry.taskId) || null;
}
function ledgerOwner(record, role) {
  if (!['accepted', 'rejected'].includes(record.status)) throw new Error('Unsettled handoff ledger');
  let owner = identity(record.status === 'accepted' ? record.target : record.source, role);
  if (record.owner_rebindings !== undefined && !Array.isArray(record.owner_rebindings)) throw new Error('Invalid native owner history');
  for (const binding of record.owner_rebindings || []) {
    const target = identity(binding.current, role);
    if (!equalIdentity(binding.previous, owner, role) || owner.runtime !== 'omp' ||
        ['runtime', 'role', 'environment', 'session'].some(key => owner[key] !== target[key])) throw new Error('Native owner history changed conversation');
    owner = target;
  }
  return owner;
}
async function locked(options, action) {
  const files = filesFor(options.home, options.project, options.role);
  privateDirectory(path.dirname(files.directory));
  privateDirectory(files.directory);
  return withLock(files.lock, async () => {
    fs.chmodSync(files.lock, 0o600);
    return action(files, readRegistry(files));
  });
}

/** Durable owner registry. A setup claim is at-most-once, not proof of delivery.
 * Only the role/worktree's next verified assistant receipt can move ownership.
 * Endpoint environment is the TUI host; intent.environment is the model host.
 */
export function readRemoteSwitches({ home, project }) {
  return readRegistry(filesFor(home, project));
}
export async function reattachOmpOwner({ home, project, role, endpoint, config, cli, verifyOmp = verifyOmpBinding }) {
  return locked({ home, project, role }, async (files, state) => {
    const entry = own(state.roles, role);
    const target = identity(endpoint, role);
    if (!entry || entry.runtime !== 'omp' || entry.pending || entry.adapterConfig !== config ||
        ['runtime', 'role', 'environment', 'session'].some(key => entry.owner[key] !== target[key])) {
      throw new Error('Native owner cannot be rebound to another task or conversation');
    }
    await verifyOmp({ home, project, role, config, endpoint: target });
    if (equalIdentity(entry.owner, target, role)) return entry;
    const inventory = await cli(['terminal', 'list', '--worktree', `path:${project}`]);
    if (!Array.isArray(inventory.terminals) || inventory.terminals.some(row => row.handle === entry.owner.terminal)) {
      throw new Error('Original native client is not proven closed');
    }
    return withLedgerLock(entry, () => {
      const record = ledgerRecord(entry);
      if (!record || ![entry.owner, target].some(value => equalIdentity(ledgerOwner(record, role), value, role))) throw new Error('Native owner ledger is not settled');
      if (!equalIdentity(ledgerOwner(record, role), target, role)) {
        record.owner_rebindings = [...(record.owner_rebindings || []), { previous: entry.owner, current: target }];
        const ledgerPath = path.join(entry.ledgerDirectory, 'state.json');
        const ledger = readJson(ledgerPath); ledger[entry.taskId] = record; savePrivate(ledgerPath, ledger);
      }
      entry.reattachments = [...(entry.reattachments || []), { previous: entry.owner, current: target, at: new Date().toISOString() }];
      entry.owner = target;
      savePrivate(files.registry, state);
      return entry;
    });
  });
}

export async function beginRemoteSwitch({ home, project, role, runtime, source, local, environment, target, adapterConfig }) {
  roleName(role);
  if (![null, 'codex', 'omp'].includes(runtime)) throw new Error('Invalid remote runtime');
  source = identity(source, role); local = identity(local, role);
  if (local.environment !== 'local') throw new Error('Original local endpoint must be local');
  if (environment !== undefined && environment !== null && (typeof environment !== 'string' || !environment.trim() || /[\r\n\0]/.test(environment))) throw new Error('Invalid model environment');
  environment ??= null;
  if (target !== undefined) target = identity(target, role);
  if (runtime === 'omp' && (!target || target.runtime !== 'omp' || typeof adapterConfig !== 'string')) {
    throw new Error('OMP readiness must provide a fixed native target before handoff');
  }
  return locked({ home, project, role }, (files, state) => {
    let entry = own(state.roles, role);
    if (entry && (!equalIdentity(entry.owner, source, role) || !equalIdentity(entry.local, local, role))) throw new Error('Source or original local owner changed');
    if (entry?.pending) {
      if (entry.pending.runtime !== runtime || entry.pending.environment !== environment) throw new Error('An unresolved remote switch already exists');
      if (entry.pending.target && !equalIdentity(entry.pending.target, target, role)) throw new Error('Prepared native target changed');
      return entry.pending;
    }
    if (!entry) {
      if (!equalIdentity(source, local, role)) throw new Error('Initial source must be the original local owner');
      entry = { runtime: null, owner: source, local, taskId: randomUUID(), ledgerDirectory: files.ledgerDirectory };
    }
    privateDirectory(files.ledgers); privateDirectory(files.ledgerDirectory);
    const previous = ledgerRecord(entry);
    if (previous && (!['accepted', 'rejected'].includes(previous.status) || !Number.isSafeInteger(previous.revision) || previous.revision < 1 ||
        previous.task_id !== entry.taskId || !sameWorktree(`local::${previous.worktree}`, project) ||
        !equalIdentity(ledgerOwner(previous, role), source, role))) throw new Error('Unsettled or mismatched handoff ledger');
    const intent = { id: randomUUID(), taskId: entry.taskId, source, local, runtime, environment,
      ledgerDirectory: files.ledgerDirectory, baseRevision: previous?.revision || 0, baseRecordId: previous?.id || null, status: 'prepared' };
    if (target) intent.target = target;
    if (adapterConfig) intent.adapterConfig = adapterConfig;
    state.roles[role] = { ...entry, pending: intent };
    savePrivate(files.registry, state);
    return intent;
  });
}
function pending(state, role, intentId) {
  const entry = own(state.roles, role);
  if (!entry?.pending || entry.pending.id !== intentId) throw new Error('Remote switch intent does not match');
  return entry;
}
export async function claimRemoteSetup({ home, project, role, intentId }) {
  return locked({ home, project, role }, (files, state) => {
    const entry = pending(state, role, intentId);
    if (entry.pending.status !== 'prepared') throw new Error('Remote setup already claimed; reconcile instead of resending');
    entry.pending.status = 'setup_uncertain';
    savePrivate(files.registry, state);
    return entry.pending;
  });
}
// Match handoff.py's json.dumps(ensure_ascii=False, sort_keys=True) byte format.
function ledgerJson(value) {
  if (Array.isArray(value)) return `[${value.map(ledgerJson).join(', ')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}: ${ledgerJson(value[key])}`).join(', ')}}`;
  return JSON.stringify(value);
}
function verifiedRecord(entry, role, project, decision) {
  const intent = entry.pending, record = ledgerRecord(entry);
  if (!record || record.status !== decision || record.task_id !== intent.taskId ||
      !Number.isSafeInteger(record.revision) || record.revision !== intent.baseRevision + 1 ||
      typeof record.id !== 'string' || !record.id || record.id === intent.baseRecordId ||
      (record.previous !== undefined && record.previous !== intent.baseRecordId) ||
      typeof record.worktree !== 'string' || !sameWorktree(`local::${record.worktree}`, project) ||
      !equalIdentity(record.source, intent.source, role)) throw new Error('No matching fresh handoff decision');
  const target = identity(record.target, role);
  if (equalIdentity(record.source, target, role) || record.source.terminal === target.terminal && record.source.environment === target.environment) throw new Error('Handoff endpoints must differ');
  if (intent.runtime === null ? !equalIdentity(target, intent.local, role) : target.runtime !== intent.runtime) throw new Error('Handoff target does not match requested owner');
  if (intent.target && !equalIdentity(target, intent.target, role)) throw new Error('Receipt target differs from the prepared native endpoint');
  const summary = record.summary;
  if (!summary || typeof summary.goal !== 'string' || !summary.goal.trim() ||
      summaryFields.slice(1).some(key => !Array.isArray(summary[key]) || summary[key].some(value => typeof value !== 'string')) || summary.inflight.length) throw new Error('Invalid handoff context summary');
  const payload = Object.fromEntries(['task_id', 'revision', 'source', 'target', 'worktree', 'summary'].map(key => [key, record[key]]));
  const hash = createHash('sha256').update(ledgerJson(payload)).digest('hex');
  const receipt = record.receipt;
  if (record.sha256 !== hash || !receipt || receipt.origin !== 'assistant_turn' || receipt.decision !== decision ||
      receipt.id !== record.id || receipt.sha256 !== hash || !equalIdentity(receipt.target, target, role) ||
      typeof receipt.reply !== 'string' || !receipt.reply.trim()) throw new Error('Invalid assistant handoff receipt');
  return record;
}
async function verifyTerminal(cli, endpoint, project) {
  const args = ['terminal', 'show', '--terminal', endpoint.terminal];
  if (endpoint.environment !== 'local') args.push('--environment', endpoint.environment);
  const terminal = (await cli(args))?.terminal;
  const worktree = typeof terminal?.worktreeId === 'string' ? terminal.worktreeId :
    typeof terminal?.worktreePath === 'string' ? `local::${terminal.worktreePath}` : null;
  if (!terminal || terminal.handle !== endpoint.terminal || terminal.incarnationId !== endpoint.incarnation ||
      terminal.connected !== true || terminal.orphaned === true ||
      !sameWorktree(worktree, project)) throw new Error('Handoff terminal identity/worktree changed');
  if (terminal.executionHostId !== undefined && terminal.executionHostId !== endpoint.environment) throw new Error('Handoff terminal environment changed');
  const program = terminal.agentIdentity || terminal.currentProgram;
  if (typeof program !== 'string' || path.basename(program).replace(/\.exe$/i, '').toLowerCase() !== endpoint.runtime) throw new Error('Handoff terminal program changed');
  const sessions = [terminal.providerSession?.id, terminal.session?.id, terminal.agentSession?.id, terminal.agentSessionId, terminal.sessionId];
  if (sessions.some(session => session !== undefined && session !== endpoint.session)) throw new Error('Handoff terminal session changed');
}
async function settle(options, decision) {
  return locked(options, async (files, state) => {
    const { role, project, intentId, cli } = options;
    const entry = pending(state, role, intentId);
    if (decision === 'rejected' && entry.pending.status === 'prepared') {
      const record = ledgerRecord(entry);
      if (record && (record.revision !== entry.pending.baseRevision || record.id !== entry.pending.baseRecordId)) throw new Error('Handoff activity prevents cancellation');
    } else {
      if (entry.pending.status !== 'setup_uncertain') throw new Error('Remote setup was not claimed');
      const record = verifiedRecord(entry, role, project, decision);
      if (typeof cli !== 'function') throw new Error('Terminal verification CLI is required');
      await verifyTerminal(cli, record.source, project);
      await verifyTerminal(cli, record.target, project);
      const checkNative = options.verifyOmp || verifyOmpBinding;
      if (entry.runtime === 'omp' && entry.adapterConfig) {
        await checkNative({ home: options.home, project, role, config: entry.adapterConfig, endpoint: record.source });
      }
      if (entry.pending.runtime === 'omp') {
        if (!entry.pending.adapterConfig) throw new Error('OMP adapter evidence is missing');
        await checkNative({ home: options.home, project, role, config: entry.pending.adapterConfig, endpoint: record.target });
      }
      if (!isDeepStrictEqual(record, ledgerRecord(entry))) throw new Error('Handoff ledger changed during verification');
      if (decision === 'accepted') { entry.owner = identity(record.target, role); entry.runtime = entry.pending.runtime; }
      if (decision === 'accepted' && entry.pending.adapterConfig) entry.adapterConfig = entry.pending.adapterConfig;
      const outcome = { id: entry.pending.id, status: decision, at: new Date().toISOString() };
      entry.lastSetupOutcome = outcome;
      entry.setupOutcomes = [...(entry.setupOutcomes || []), outcome];
    }
    delete entry.pending;
    savePrivate(files.registry, state);
    return entry;
  });
}
export async function commitRemoteSwitch(options) { return settle(options, 'accepted'); }
export async function rejectRemoteSwitch(options) { return settle(options, 'rejected'); }

// Share handoff.py's advisory lock for native owner updates and preflight settlement.
async function withLedgerLock(entry, action) {
  assertRegular(entry.ledgerDirectory, true);
  const lock = path.join(entry.ledgerDirectory, 'lock');
  if (fs.existsSync(lock)) assertRegular(lock);
  const child = spawn('python3', ['-c',
    "import fcntl,sys; f=open(sys.argv[1],'a'); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB); print('locked',flush=True); sys.stdin.read()", lock],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let ready = false;
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => { if (!ready) reject(new Error('Handoff ledger lock unavailable')); });
      child.stdout.once('data', data => {
        if (data.toString().trim() !== 'locked') return reject(new Error('Handoff ledger lock unverified'));
        ready = true; resolve();
      });
    });
    fs.chmodSync(lock, 0o600);
    return await action();
  } finally {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.stdin.end(); await exited; }
  }
}
async function withEmptyLedger(entry, action) {
  return withLedgerLock(entry, () => {
    const assertEmpty = () => {
      assertRegular(entry.ledgerDirectory, true);
      if (fs.readdirSync(entry.ledgerDirectory).some(name => name !== 'lock')) throw new Error('Handoff ledger activity prevents preflight settlement');
    };
    assertEmpty();
    return action(assertEmpty);
  });
}

export function preflightFailureMessage(state, names) {
  const failures = names.flatMap(name => {
    const failure = state.roles[name]?.lastSetupOutcome;
    return failure?.status === 'preflight_failed' ? [`${name}: remote ${failure.intent.runtime} preparation failed (aborted before delivery): ${failure.reasons.join('; ')}`] : [];
  });
  return failures.length ? failures.join('\n') + '\nHistorical pre-delivery failures; original owners retained. Confirm off for local restoration, or select omp to run the native readiness checks before a new handoff.' : null;
}

export function remotePreflightError(message) {
  return Object.assign(new Error(message), { code: 'REMOTE_PREFLIGHT_FAILED' });
}

/** Coordinator execution evidence, never a fabricated target rejection. */
export async function abortRemotePreflight(options) {
  const { home, project, role, intentId, reportFile, cli,
    inspect = (handle, provider) => inspectHealth(cli, rpc, handle, provider) } = options;
  assertRegular(reportFile);
  const reportBytes = fs.readFileSync(reportFile);
  const report = JSON.parse(reportBytes.toString('utf8'));
  const delivery = report.delivery, creation = report.remote_omp_creation;
  if (report.schema_version !== 1 || report.original_attempt_outcome !== 'aborted_before_checkpoint_request_and_before_context_delivery' ||
      !Array.isArray(report.intents) || !Array.isArray(report.technical_stop_reasons) || !report.technical_stop_reasons.length ||
      report.technical_stop_reasons.some(reason => typeof reason !== 'string' || !reason.trim()) ||
      report.remote_commit_executed !== false || report.remote_reject_executed !== false || report.target_rejected !== 'not_observed' ||
      !creation || creation.created_by_this_original_attempt !== false || creation.create_or_launch_operation_issued !== false ||
      creation.destination_terminal !== null || creation.destination_native_session !== null ||
      !delivery || ['checkpoint_request_sent_to_either_source', 'context_delivered_to_any_target', 'handoff_prepare_called',
        'handoff_claim_called', 'handoff_accept_called', 'assistant_acceptance_or_rejection_observed'].some(key => delivery[key] !== false) ||
      ['checkpoint_request_ids', 'context_delivery_ids'].some(key => !Array.isArray(delivery[key]) || delivery[key].length) || delivery.receipt !== null) {
    throw new Error('Report does not prove aborted-before-delivery');
  }
  const matches = report.intents.filter(item => item.intent_id === intentId && item.role === role);
  if (matches.length !== 1) throw new Error('Report exact intent/role mismatch');
  const supplied = matches[0];
  return locked(options, async (files, state) => {
    const entry = pending(state, role, intentId), intent = entry.pending;
    if (intent.status !== 'setup_uncertain' || intent.runtime !== 'omp' || entry.runtime !== null ||
        intent.baseRevision !== 0 || intent.baseRecordId !== null || supplied.task_id !== entry.taskId ||
        (supplied.supplied_source?.role !== undefined && supplied.supplied_source.role !== role) ||
        !equalIdentity({ ...supplied.supplied_source, role }, intent.source, role) ||
        !equalIdentity(entry.owner, intent.source, role) || !equalIdentity(entry.local, intent.source, role)) {
      throw new Error('Preflight intent/source/base revision or ownership changed');
    }
    return withEmptyLedger(entry, async assertEmpty => {
      await verifyTerminal(cli, intent.source, project);
      const saved = readJson(files.state).agents?.[role];
      if (!saved || saved.session?.id !== intent.source.session || saved.agent !== intent.source.runtime ||
          saved.handle !== intent.source.terminal || saved.incarnationId !== intent.source.incarnation) throw new Error('Saved source identity changed');
      validateTranscript(saved, project);
      const live = await inspect(intent.source.terminal, intent.source.runtime);
      if (!provesSession(live, saved) || live.terminal?.handle !== intent.source.terminal ||
          live.terminal.incarnationId !== intent.source.incarnation || !sameWorktree(`local::${live.terminal.worktreePath}`, project)) {
        throw new Error('Current native source session is not proven');
      }
      await verifyTerminal(cli, intent.source, project);
      assertEmpty();
      if (!isDeepStrictEqual(readRegistry(files), state)) throw new Error('Ownership registry changed during verification');
      const outcome = { status: 'preflight_failed', outcome: 'aborted_before_delivery', intent,
        settledAt: new Date().toISOString(), reasons: report.technical_stop_reasons,
        reportPath: path.resolve(reportFile), reportSha256: createHash('sha256').update(reportBytes).digest('hex'),
        reportBase64: reportBytes.toString('base64') };
      entry.setupOutcomes = [...(entry.setupOutcomes || []), outcome];
      entry.lastSetupOutcome = outcome;
      delete entry.pending;
      savePrivate(files.registry, state);
      return outcome;
    });
  });
}

// History does not own the role: explicit off restores locally; explicit OMP
// proceeds only to remote-start's mandatory native readiness verification.
export function resolvePreflightChoices(state, names, requests) {
  const localConfirmed = new Set();
  for (const name of names) {
    const entry = state.roles[name];
    if (entry?.lastSetupOutcome?.status !== 'preflight_failed') continue;
    const request = requests.find(item => item.role === name);
    if (request?.runtime === null && entry.runtime === null && !entry.pending && equalIdentity(entry.owner, entry.local, name)) {
      localConfirmed.add(name);
    } else if (request?.runtime === 'omp' && entry.runtime === null && !entry.pending && equalIdentity(entry.owner, entry.local, name)) {
      continue;
    } else throw remotePreflightError(preflightFailureMessage(state, [name]));
  }
  return requests.filter(request => !localConfirmed.has(request.role));
}
