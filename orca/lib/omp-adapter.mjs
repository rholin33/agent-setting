import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { projectFiles, readJson } from './team.mjs';
import { orca } from './orca.mjs';
import { ensureRemoteProject } from './remote-project.mjs';

const execute = promisify(execFile);
const fields = ['runtime', 'role', 'environment', 'terminal', 'incarnation', 'session'];
const text = value => typeof value === 'string' && value.trim() && !/[\r\n\0]/.test(value);

export function ompSelection(home, role) {
  const catalog = readJson(path.join(home, 'team.json'));
  const matches = catalog.filter(item => item.name === role);
  if (matches.length !== 1) throw new Error(`${role}: no unique saved team role`);
  const file = path.join(home, 'omp-models.json');
  const saved = fs.existsSync(file) ? readJson(file).roles?.[role] : undefined;
  const selected = saved ?? matches[0];
  if (!text(selected.model) || !/^[^/\s]+\/\S+$/.test(selected.model) ||
      !Object.hasOwn(selected, 'thinking') || !(selected.thinking === null || text(selected.thinking))) {
    throw new Error(`${role}: explicit saved OMP provider/model and thinking are required; no model fallback`);
  }
  return { model: selected.model, thinking: selected.thinking };
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe OMP runtime directory');
  fs.chmodSync(directory, 0o700);
}

// 远端 OMP host 终端放在远端主机为本项目建立的 orca-remote 项目下，不借用远端当前打开的项目。
export async function ensureOmp({ home, project, role, model, thinking, environment }, run = execute,
  remoteProject = () => ensureRemoteProject({ environment, project, cli: orca })) {
  const directory = path.join(projectFiles(home, project).directory, 'runtime', role, 'omp');
  if (!/^[a-z][a-z0-9_]*$/.test(role)) throw new Error('Invalid OMP role');
  privateDirectory(directory);
  const remote = await remoteProject();
  const file = path.join(directory, `request-${randomUUID()}.json`);
  const request = { home, project, role, model, thinking, environment: remote.environment, remote_worktree: remote.path };
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(request) + '\n'); }
  finally { fs.closeSync(fd); }
  try {
    const env = { ...process.env };
    delete env.ORCA_ENVIRONMENT;
    delete env.ORCA_PAIRING_CODE;
    let result;
    try {
      result = await run('python3', [path.join(home, 'remote-master', 'omp_adapter.py'), 'ensure', '--request', file], { env, maxBuffer: 1024 * 1024 });
    } catch (error) {
      const code = typeof error.stderr === 'string' ? error.stderr.match(/OMP_READINESS:([a-z_]+)/)?.[1] : undefined;
      const reasons = {
        binding_mismatch: 'Existing worktree/role binding differs; no session replacement performed.',
        model_mismatch: 'Selected model differs from the existing remote model; explicit model migration is required.',
        thinking_busy: 'Remote host is busy or awaiting input; thinking was not cycled.',
        thinking_draft: 'Remote host composer is not proven empty; thinking was not cycled.',
        thinking_identity: 'Remote host identity changed during thinking selection; reconcile before continuing.',
        thinking_replica: 'No unique native thinking-state replica is available; cannot verify the selected level.',
        thinking_uncertain: 'A thinking key may already have been delivered; inspect native state before retrying, do not resend blindly.',
        thinking_unsupported: 'The requested thinking level is invalid or unavailable in the native model cycle.',
      };
      const reason = Object.hasOwn(reasons, code) ? reasons[code] : 'Reconcile the private adapter state before retrying uncertain creation.';
      throw new Error(`${role}: OMP adapter readiness failed; original owner retained. ${reason}`);
    }
    try { return JSON.parse(result.stdout); }
    catch { throw new Error(`${role}: OMP adapter returned no valid ready endpoint; original owner retained`); }
  } finally { fs.unlinkSync(file); }
}

export async function verifyOmpBinding({ home, project, role, config, endpoint }, run = execute) {
  const id = createHash('sha256').update(project + '\0' + role).digest('hex').slice(0, 16);
  const expected = path.join(home, 'remote-master', 'runtime', `omp-${id}`, 'adapter.json');
  if (config !== expected) throw new Error('OMP adapter scope changed');
  const env = { ...process.env };
  delete env.ORCA_ENVIRONMENT;
  delete env.ORCA_PAIRING_CODE;
  const result = await run('python3', [path.join(home, 'remote-master', 'omp_adapter.py'), 'verify', '--config', config], { env, maxBuffer: 1024 * 1024 });
  const actual = JSON.parse(result.stdout);
  if (fields.some(key => actual[key] !== endpoint[key]) || actual.adapterConfig !== config) {
    throw new Error('OMP native session or local client changed');
  }
}

export async function validateOmpEndpoint(endpoint, request, cli) {
  const { home, project, role, model, thinking, environment } = request;
  const fail = () => { throw new Error(`${role}: OMP adapter binding or local target identity mismatch; original owner retained`); };
  if (!endpoint || fields.some(key => !text(endpoint[key])) || endpoint.runtime !== 'omp' || endpoint.role !== role || endpoint.environment !== 'local' || endpoint.session.startsWith('unknown:')) fail();
  const id = createHash('sha256').update(project + '\0' + role).digest('hex').slice(0, 16);
  const config = path.join(home, 'remote-master', 'runtime', `omp-${id}`, 'adapter.json');
  if (endpoint.adapterConfig !== config) fail();
  const stat = fs.lstatSync(config);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || fs.realpathSync(config) !== config) fail();
  const bound = readJson(config);
  if (bound.project !== project || bound.role !== role || bound.model !== model || bound.thinking !== (thinking || 'off') ||
      (environment !== undefined && bound.environment !== environment) ||
      bound.host_identity?.sessionId !== endpoint.session || bound.terminals?.guest?.handle !== endpoint.terminal ||
      bound.terminals?.guest?.incarnation !== endpoint.incarnation ||
      fields.some(key => bound.endpoint?.[key] !== endpoint[key]) || bound.endpoint?.adapterConfig !== config) fail();
  const terminal = (await cli(['terminal', 'show', '--terminal', endpoint.terminal]))?.terminal;
  if (!terminal || terminal.handle !== endpoint.terminal || terminal.connected !== true || terminal.orphaned || terminal.writable === false ||
      terminal.executionHostId !== 'local' || terminal.agentIdentity !== 'omp' || terminal.incarnationId !== endpoint.incarnation ||
      terminal.worktreePath !== project) fail();
  const sessions = [terminal.providerSession?.id, terminal.agentSession?.id, terminal.session?.id, terminal.agentSessionId, terminal.sessionId];
  if (sessions.some(session => session !== undefined && session !== endpoint.session)) fail();
  return { target: Object.fromEntries(fields.map(key => [key, endpoint[key]])), adapterConfig: config };
}
